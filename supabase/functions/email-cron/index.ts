// Email automation runner — invoked every minute by pg_cron (via pg_net) with the
// service role key. Evaluates due rules, builds reports, sends via SMTP, logs.
// Secrets required:  SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASS SMTP_FROM SMTP_FROM_NAME
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
import { createClient } from "npm:@supabase/supabase-js@2"
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts"
import { buildReport, triggerCount } from "../_shared/reports.ts"

const env = (k: string) => Deno.env.get(k) || ""
const RECHECK_MIN = 15, DEFAULT_COOLDOWN_H = 24
const clamp = (v: any, lo: number, hi: number, d: number) => { v = parseInt(v, 10); return isNaN(v) ? d : Math.max(lo, Math.min(hi, v)) }

function nextScheduleRun(s: any, from: Date): Date {
  s = s || {}; const d = new Date(from.getTime()); const hour = clamp(s.hour, 0, 23, 8), min = clamp(s.minute, 0, 59, 0)
  if (s.freq === "hourly") { d.setMinutes(min, 0, 0); if (d <= from) d.setHours(d.getHours() + 1); return d }
  if (s.freq === "weekly") { const dow = clamp(s.dow, 0, 6, 1); d.setHours(hour, min, 0, 0); let a = (dow - d.getDay() + 7) % 7; if (a === 0 && d <= from) a = 7; d.setDate(d.getDate() + a); return d }
  if (s.freq === "monthly") { const dom = clamp(s.dom, 1, 28, 1); d.setHours(hour, min, 0, 0); d.setDate(dom); if (d <= from) { d.setMonth(d.getMonth() + 1); d.setDate(dom) } return d }
  d.setHours(hour, min, 0, 0); if (d <= from) d.setDate(d.getDate() + 1); return d
}

async function loadOrgState(sb: any, orgId: string) {
  const out: any = { facilities: [], patients: [], wounds: [] }
  for (const t of ["facilities", "patients", "wounds"]) {
    const { data } = await sb.from(t).select("data").eq("org_id", orgId)
    out[t] = (data || []).map((r: any) => r.data || {})
  }
  return out
}

async function sendMail(msg: { to: string[]; cc?: string[]; subject: string; html: string; attachments?: any[] }) {
  const port = parseInt(env("SMTP_PORT"), 10) || 587
  const client = new SMTPClient({ connection: { hostname: env("SMTP_HOST"), port, tls: env("SMTP_SECURE") === "true" || port === 465, auth: env("SMTP_USER") ? { username: env("SMTP_USER"), password: env("SMTP_PASS") } : undefined } })
  const from = env("SMTP_FROM_NAME") ? `${env("SMTP_FROM_NAME")} <${env("SMTP_FROM")}>` : env("SMTP_FROM")
  await client.send({ from, to: msg.to, cc: msg.cc && msg.cc.length ? msg.cc : undefined, subject: msg.subject, html: msg.html, content: "See HTML report.", attachments: msg.attachments })
  await client.close()
}

async function logSend(sb: any, orgId: string, ruleId: string, to: string[], subject: string, status: string, detail?: string) {
  try { await sb.from("email_log").insert({ org_id: orgId, rule_id: ruleId, to_addrs: (to || []).join(", "), subject, status, detail: detail || null }) } catch (_) {}
}

async function runRule(sb: any, rule: any) {
  const cfg = rule.config || {}; const now = new Date()
  if (!env("SMTP_HOST") || !env("SMTP_FROM")) { await logSend(sb, rule.org_id, rule.id, cfg.recipients, "(SMTP not configured)", "error", "set SMTP_* secrets"); return }
  if (!cfg.recipients || !cfg.recipients.length) { await logSend(sb, rule.org_id, rule.id, [], "(no recipients)", "error", "no recipients"); return }
  const state = await loadOrgState(sb, rule.org_id)

  if (cfg.mode === "trigger") {
    const rep = (cfg.trigger && cfg.trigger.report) || cfg.report || "stale-wounds"
    if (triggerCount(rep, state, cfg.filters || {}) <= 0) { await sb.from("email_rules").update({ next_run: new Date(now.getTime() + RECHECK_MIN * 60000) }).eq("id", rule.id); return }
    await deliver(sb, rule, { ...cfg, report: rep }, state)
    const cd = clamp(cfg.trigger && cfg.trigger.cooldownHours, 1, 720, DEFAULT_COOLDOWN_H)
    await sb.from("email_rules").update({ last_run: now.toISOString(), next_run: new Date(now.getTime() + cd * 3600000).toISOString() }).eq("id", rule.id)
    return
  }
  await deliver(sb, rule, cfg, state)
  await sb.from("email_rules").update({ last_run: now.toISOString(), next_run: nextScheduleRun(cfg.schedule || {}, new Date(now.getTime() + 60000)).toISOString() }).eq("id", rule.id)
}

async function deliver(sb: any, rule: any, cfg: any, state: any) {
  const rep = buildReport(cfg.report || "weekly-wound", state, cfg.filters || {})
  if (rep.empty && cfg.skipIfEmpty) { await logSend(sb, rule.org_id, rule.id, cfg.recipients, rep.subject, "skipped", "no matching items"); return }
  const fmt = cfg.format || "html+csv"
  const attachments = fmt === "html" ? [] : [{ filename: rep.filename, content: rep.csv, contentType: "text/csv", encoding: "text" }]
  try {
    await sendMail({ to: cfg.recipients, cc: cfg.cc, subject: rep.subject, html: fmt === "csv" ? "<p>See attached CSV.</p>" : rep.html, attachments })
    await logSend(sb, rule.org_id, rule.id, cfg.recipients, rep.subject, "sent", rep.count + " rows")
  } catch (e: any) { await logSend(sb, rule.org_id, rule.id, cfg.recipients, rep.subject, "error", (e && e.message) || "send failed"); throw e }
}

Deno.serve(async (req) => {
  // Only the service role (sent by pg_cron) may run this.
  const auth = req.headers.get("authorization") || ""
  if (!auth.includes(env("SUPABASE_SERVICE_ROLE_KEY"))) return new Response("forbidden", { status: 403 })
  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"))
  const { data: due } = await sb.from("email_rules").select("*").eq("enabled", true).or(`next_run.is.null,next_run.lte.${new Date().toISOString()}`).limit(200)
  let ran = 0
  for (const rule of (due || [])) { try { await runRule(sb, rule); ran++ } catch (_) {} }
  return new Response(JSON.stringify({ ok: true, ran }), { headers: { "content-type": "application/json" } })
})
