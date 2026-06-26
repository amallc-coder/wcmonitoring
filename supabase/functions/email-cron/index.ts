// Email automation runner — invoked every minute by pg_cron (via pg_net) with the
// service role key. Evaluates due rules, builds reports, sends via SMTP, logs.
// Self-contained (no shared imports) so it can be pasted into the dashboard editor.
// Secrets required:  SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASS SMTP_FROM SMTP_FROM_NAME
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
import { createClient } from "npm:@supabase/supabase-js@2"
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts"

const env = (k: string) => Deno.env.get(k) || ""
const RECHECK_MIN = 15, DEFAULT_COOLDOWN_H = 24
const clamp = (v: any, lo: number, hi: number, d: number) => { v = parseInt(v, 10); return isNaN(v) ? d : Math.max(lo, Math.min(hi, v)) }

/* ── report builders (operate on the app objects stored in each row's data jsonb) ── */
type Row = Record<string, any>
type State = { facilities: Row[]; patients: Row[]; wounds: Row[] }
const STALE_DAYS = 7
const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const areaOf = (h: Row) => (h && h.L && h.W) ? +(h.L * h.W).toFixed(1) : null
const measured = (w: Row) => (w.chart || []).filter((h: Row) => h.L && h.W)
const lastMeas = (w: Row) => { const m = measured(w); return m.length ? m[m.length - 1] : null }
const firstMeas = (w: Row) => { const m = measured(w); return m.length ? m[0] : null }
function reductionPct(w: Row) { const f = firstMeas(w), l = lastMeas(w); if (!f || !l || f === l) return null; const fa = f.L * f.W; if (fa <= 0) return null; return Math.round((fa - l.L * l.W) / fa * 100) }
const lastAssessed = (w: Row) => { const c = w.chart || []; return c.length ? (c[c.length - 1].dt || w.ls || "") : (w.ls || "") }
function daysSince(s: string) { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : Math.floor((Date.now() - d.getTime()) / 86400000) }
function filt(ws: Row[], f: any) { f = f || {}; return ws.filter(w => (!f.facility || w.fac === f.facility) && (!f.provider || (w.pv || "") === f.provider)) }

type Built = { subject: string; intro: string; head: string[]; rows: any[][]; empty: boolean }
const BUILDERS: Record<string, (s: State, f: any) => Built> = {
  "weekly-wound": (s, f) => { const ws = filt(s.wounds, f); const rows = ws.map(w => { const le = lastMeas(w) || {}; const ds = daysSince(lastAssessed(w)); const r = reductionPct(w); return [w.name || "", w.fac || "", w.tp || "", w.stage || "", w.loc || "", areaOf(le) != null ? areaOf(le) + " cm²" : "—", r != null ? (r >= 0 ? "−" : "+") + Math.abs(r) + "%" : "—", w.heal || "—", w.inf ? "YES" : "no", lastAssessed(w) || "—", ds != null ? ds + "d" : "—", w.pv || ""] }); return { subject: `Weekly Wound Summary — ${ws.length} active wound${ws.length === 1 ? "" : "s"}`, intro: "Active wound roster with latest area, interval change, healing and overdue days.", head: ["Resident", "Facility", "Type", "Stage", "Location", "Area", "Δ vs baseline", "Healing", "Infection", "Last assessed", "Overdue", "Provider"], rows, empty: rows.length === 0 } },
  "stale-wounds": (s, f) => { const ws = filt(s.wounds, f).filter(w => { const d = daysSince(lastAssessed(w)); return d == null || d >= STALE_DAYS }); const rows = ws.map(w => { const d = daysSince(lastAssessed(w)); return [w.name || "", w.fac || "", w.tp || "", w.loc || "", lastAssessed(w) || "never", d != null ? d + "d" : "—", w.pv || ""] }); return { subject: `Overdue Wound Assessments — ${rows.length} need attention`, intro: `Wounds not reassessed in ≥${STALE_DAYS} days.`, head: ["Resident", "Facility", "Type", "Location", "Last assessed", "Overdue", "Provider"], rows, empty: rows.length === 0 } },
  "infections": (s, f) => { const ws = filt(s.wounds, f).filter(w => w.inf); const rows = ws.map(w => { const le = lastMeas(w) || {}; return [w.name || "", w.fac || "", w.tp || "", w.loc || "", le.infSev || "—", le.culture || "—", le.abx || "—", w.pv || ""] }); return { subject: `Active Wound Infections — ${rows.length} flagged`, intro: "Wounds with infection currently flagged.", head: ["Resident", "Facility", "Type", "Location", "Severity", "Culture", "Antibiotics", "Provider"], rows, empty: rows.length === 0 } },
  "high-risk": (s, f) => { const ws = filt(s.wounds, f).filter(w => (w.braden != null && w.braden <= 12) || ["Stage 4", "Unstageable"].includes(w.stage) || (w.abi != null && w.abi < 0.8)); const rows = ws.map(w => [w.name || "", w.fac || "", w.tp || "", w.stage || "", w.loc || "", w.braden ?? "—", w.abi ?? "—", w.goal || "", w.pv || ""]); return { subject: `High-Risk Wounds — ${rows.length} flagged`, intro: "Flagged by Braden ≤12, Stage 4/Unstageable, or ABI <0.8.", head: ["Resident", "Facility", "Type", "Stage", "Location", "Braden", "ABI", "Goal", "Provider"], rows, empty: rows.length === 0 } },
  "portfolio": (s, f) => { const ws = filt(s.wounds, f); const by: Record<string, any> = {}; ws.forEach(w => { const k = w.fac || "—"; const o = by[k] || (by[k] = { active: 0, inf: 0, stale: 0, healing: 0 }); o.active++; if (w.inf) o.inf++; const d = daysSince(lastAssessed(w)); if (d == null || d >= STALE_DAYS) o.stale++; if (["Progressing", "Improving", "Healed"].includes(w.heal)) o.healing++ }); const rows = Object.keys(by).sort().map(k => { const o = by[k]; return [k, o.active, o.inf, o.stale, o.healing, o.active ? Math.round(o.healing / o.active * 100) + "%" : "—"] }); return { subject: `Wound Care Portfolio Summary — ${ws.length} active`, intro: "Per-facility roll-up.", head: ["Facility", "Active", "Infected", "Overdue", "Healing", "Healing %"], rows, empty: rows.length === 0 } },
}
const csvFrom = (head: string[], rows: any[][]) => [head, ...rows].map(r => r.map(v => '"' + String(v ?? "").replace(/"/g, '""') + '"').join(",")).join("\r\n")
function htmlFrom(rep: Built) {
  const th = rep.head.map(h => `<th style="text-align:left;padding:6px 9px;border-bottom:2px solid #ccd2d1;font:600 12px system-ui;color:#26282d">${esc(h)}</th>`).join("")
  const tr = rep.rows.map((r, i) => `<tr style="background:${i % 2 ? "#f7f9f9" : "#fff"}">` + r.map(c => `<td style="padding:5px 9px;border-bottom:1px solid #e6eaea;font:13px system-ui;color:#42474d">${esc(c)}</td>`).join("") + "</tr>").join("")
  return `<div style="font-family:system-ui,Arial,sans-serif;max-width:900px;margin:0 auto;color:#26282d"><div style="padding:14px 0;border-bottom:3px solid #c2603f"><span style="font:700 18px system-ui">clinilytics</span> <span style="color:#6b7280">· Wound Care</span></div><h2 style="font:600 18px system-ui;margin:16px 0 4px">${esc(rep.subject)}</h2><div style="color:#6b7280;font-size:13px;margin-bottom:12px">${esc(rep.intro)}</div>` + (rep.empty ? `<div style="padding:18px;background:#f1f5f4;border-radius:8px;color:#356b64">Nothing to report. ✓</div>` : `<table style="border-collapse:collapse;width:100%"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`) + `<div style="margin-top:16px;color:#9aa0a6;font-size:11px">Automated report from Clinilytics — Wound Care. CSV attached. May contain PHI — handle per policy.</div></div>`
}
function buildReport(type: string, state: State, filters: any) { const rep = (BUILDERS[type] || BUILDERS["weekly-wound"])(state, filters || {}); return { subject: rep.subject, html: htmlFrom(rep), csv: csvFrom(rep.head, rep.rows), filename: `${type}_${new Date().toISOString().slice(0, 10)}.csv`, count: rep.rows.length, empty: rep.empty } }
function triggerCount(type: string, state: State, filters: any) { return (BUILDERS[type] || BUILDERS["stale-wounds"])(state, filters || {}).rows.length }

/* ── scheduler ── */
function nextScheduleRun(s: any, from: Date): Date {
  s = s || {}; const d = new Date(from.getTime()); const hour = clamp(s.hour, 0, 23, 8), min = clamp(s.minute, 0, 59, 0)
  if (s.freq === "hourly") { d.setMinutes(min, 0, 0); if (d <= from) d.setHours(d.getHours() + 1); return d }
  if (s.freq === "weekly") { const dow = clamp(s.dow, 0, 6, 1); d.setHours(hour, min, 0, 0); let a = (dow - d.getDay() + 7) % 7; if (a === 0 && d <= from) a = 7; d.setDate(d.getDate() + a); return d }
  if (s.freq === "monthly") { const dom = clamp(s.dom, 1, 28, 1); d.setHours(hour, min, 0, 0); d.setDate(dom); if (d <= from) { d.setMonth(d.getMonth() + 1); d.setDate(dom) } return d }
  d.setHours(hour, min, 0, 0); if (d <= from) d.setDate(d.getDate() + 1); return d
}
async function loadOrgState(sb: any, orgId: string) {
  const out: any = { facilities: [], patients: [], wounds: [] }
  for (const t of ["facilities", "patients", "wounds"]) { const { data } = await sb.from(t).select("data").eq("org_id", orgId); out[t] = (data || []).map((r: any) => r.data || {}) }
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
async function deliver(sb: any, rule: any, cfg: any, state: any) {
  const rep = buildReport(cfg.report || "weekly-wound", state, cfg.filters || {})
  if (rep.empty && cfg.skipIfEmpty) { await logSend(sb, rule.org_id, rule.id, cfg.recipients, rep.subject, "skipped", "no matching items"); return }
  const fmt = cfg.format || "html+csv"
  const attachments = fmt === "html" ? [] : [{ filename: rep.filename, content: rep.csv, contentType: "text/csv", encoding: "text" }]
  try { await sendMail({ to: cfg.recipients, cc: cfg.cc, subject: rep.subject, html: fmt === "csv" ? "<p>See attached CSV.</p>" : rep.html, attachments }); await logSend(sb, rule.org_id, rule.id, cfg.recipients, rep.subject, "sent", rep.count + " rows") }
  catch (e: any) { await logSend(sb, rule.org_id, rule.id, cfg.recipients, rep.subject, "error", (e && e.message) || "send failed"); throw e }
}
async function runRule(sb: any, rule: any) {
  const cfg = rule.config || {}; const now = new Date()
  if (!env("SMTP_HOST") || !env("SMTP_FROM")) { await logSend(sb, rule.org_id, rule.id, cfg.recipients, "(SMTP not configured)", "error", "set SMTP_* secrets"); return }
  if (!cfg.recipients || !cfg.recipients.length) { await logSend(sb, rule.org_id, rule.id, [], "(no recipients)", "error", "no recipients"); return }
  const state = await loadOrgState(sb, rule.org_id)
  if (cfg.mode === "trigger") {
    const rep = (cfg.trigger && cfg.trigger.report) || cfg.report || "stale-wounds"
    if (triggerCount(rep, state, cfg.filters || {}) <= 0) { await sb.from("email_rules").update({ next_run: new Date(now.getTime() + RECHECK_MIN * 60000).toISOString() }).eq("id", rule.id); return }
    await deliver(sb, rule, { ...cfg, report: rep }, state)
    const cd = clamp(cfg.trigger && cfg.trigger.cooldownHours, 1, 720, DEFAULT_COOLDOWN_H)
    await sb.from("email_rules").update({ last_run: now.toISOString(), next_run: new Date(now.getTime() + cd * 3600000).toISOString() }).eq("id", rule.id); return
  }
  await deliver(sb, rule, cfg, state)
  await sb.from("email_rules").update({ last_run: now.toISOString(), next_run: nextScheduleRun(cfg.schedule || {}, new Date(now.getTime() + 60000)).toISOString() }).eq("id", rule.id)
}
Deno.serve(async (req) => {
  const auth = req.headers.get("authorization") || ""
  if (!auth.includes(env("SUPABASE_SERVICE_ROLE_KEY"))) return new Response("forbidden", { status: 403 })
  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"))
  const { data: due } = await sb.from("email_rules").select("*").eq("enabled", true).or(`next_run.is.null,next_run.lte.${new Date().toISOString()}`).limit(200)
  let ran = 0
  for (const rule of (due || [])) { try { await runRule(sb, rule); ran++ } catch (_) {} }
  return new Response(JSON.stringify({ ok: true, ran }), { headers: { "content-type": "application/json" } })
})
