"use strict";
/* Automation scheduler. Ticks once a minute and, per org, runs due email rules:
     • mode "schedule" — daily/weekly/monthly/hourly at a chosen time → send report.
     • mode "trigger"  — re-checks a condition (overdue/infection/high-risk); when
       it holds, sends a digest, then cools down before it can fire again.
   Times are evaluated in the SERVER's local timezone (set TZ in the environment).
   Each rule's config is decrypted on demand; settings come from mailer.js. */

const db = require("./db");
const { decrypt } = require("./crypto");
const mailer = require("./mailer");
const reports = require("./reports");

const TICK_MS = 60 * 1000;
const RECHECK_MIN = 15;            // trigger re-check cadence when condition not met
const DEFAULT_COOLDOWN_H = 24;     // trigger: min hours between sends while condition holds

function clamp(v, lo, hi, dflt) { v = parseInt(v, 10); if (isNaN(v)) return dflt; return Math.max(lo, Math.min(hi, v)); }

function nextScheduleRun(s, from) {
  s = s || {};
  const d = new Date(from.getTime());
  const hour = clamp(s.hour, 0, 23, 8), min = clamp(s.minute, 0, 59, 0);
  if (s.freq === "hourly") { d.setMinutes(min, 0, 0); if (d <= from) d.setHours(d.getHours() + 1); return d; }
  if (s.freq === "weekly") {
    const dow = clamp(s.dow, 0, 6, 1); d.setHours(hour, min, 0, 0);
    let add = (dow - d.getDay() + 7) % 7; if (add === 0 && d <= from) add = 7; d.setDate(d.getDate() + add); return d;
  }
  if (s.freq === "monthly") {
    const dom = clamp(s.dom, 1, 28, 1); d.setHours(hour, min, 0, 0); d.setDate(dom);
    if (d <= from) { d.setMonth(d.getMonth() + 1); d.setDate(dom); } return d;
  }
  // daily (default)
  d.setHours(hour, min, 0, 0); if (d <= from) d.setDate(d.getDate() + 1); return d;
}

// Exposed so the create/update endpoint can stamp the first next_run.
function computeNextRun(cfg, from) {
  from = from || new Date();
  if (cfg.mode === "trigger") return from;            // eligible to evaluate immediately
  return nextScheduleRun(cfg.schedule || {}, from);
}

async function logSend(orgId, ruleId, to, subject, status, detail) {
  try {
    await db.query("INSERT INTO email_log (org_id,rule_id,to_addrs,subject,status,detail) VALUES ($1,$2,$3,$4,$5,$6)",
      [orgId, ruleId, (to || []).join(", "), subject, status, detail || null]);
  } catch (e) { /* never break the tick */ }
}

async function deliverReport(org, rule, cfg, smtp, state) {
  const rep = reports.buildReport(cfg.report || "weekly-wound", state, cfg.filters || {});
  const fmt = cfg.format || "html+csv";
  if (rep.empty && cfg.skipIfEmpty) { await logSend(org, rule.id, cfg.recipients, rep.subject, "skipped", "no matching items"); return; }
  const attachments = (fmt === "html" ) ? [] : [{ filename: rep.filename, content: rep.csv, contentType: "text/csv" }];
  const msg = {
    to: cfg.recipients || [],
    cc: cfg.cc || [],
    subject: rep.subject,
    html: fmt === "csv" ? "<p>See attached CSV.</p>" : rep.html,
    attachments: attachments
  };
  try {
    await mailer.sendMail(smtp, msg);
    await logSend(org, rule.id, cfg.recipients, rep.subject, "sent", rep.count + " rows");
  } catch (e) {
    await logSend(org, rule.id, cfg.recipients, rep.subject, "error", (e && e.message) || "send failed");
    throw e;
  }
}

// Run a single rule now (used by the tick and the "Run now" endpoint). Returns a status string.
async function runRule(rule, opts) {
  opts = opts || {};
  let cfg; try { cfg = decrypt(rule.config_enc); } catch (e) { return "bad-config"; }
  const smtp = await mailer.getSettings(rule.org_id);
  if (!mailer.configured(smtp)) { await logSend(rule.org_id, rule.id, cfg.recipients, "(SMTP not configured)", "error", "configure SMTP first"); return "no-smtp"; }
  if (!cfg.recipients || !cfg.recipients.length) { await logSend(rule.org_id, rule.id, [], "(no recipients)", "error", "no recipients"); return "no-recipients"; }
  const state = opts.state || await reports.loadOrgState(rule.org_id);
  const now = new Date();

  if (cfg.mode === "trigger" && !opts.force) {
    const count = reports.triggerCount(cfg.trigger && cfg.trigger.report || cfg.report || "stale-wounds", state, cfg.filters || {});
    if (count <= 0) {
      // condition not met → re-check soon, no send
      await db.query("UPDATE email_rules SET next_run=$1 WHERE id=$2", [new Date(now.getTime() + RECHECK_MIN * 60000), rule.id]);
      return "no-condition";
    }
    // condition met → send the matching report, then cool down
    const sendCfg = Object.assign({}, cfg, { report: (cfg.trigger && cfg.trigger.report) || cfg.report || "stale-wounds" });
    await deliverReport(rule.org_id, rule, sendCfg, smtp, state);
    const cooldownH = clamp(cfg.trigger && cfg.trigger.cooldownHours, 1, 720, DEFAULT_COOLDOWN_H);
    await db.query("UPDATE email_rules SET last_run=now(), next_run=$1 WHERE id=$2", [new Date(now.getTime() + cooldownH * 3600000), rule.id]);
    return "sent";
  }

  // schedule (or forced run)
  await deliverReport(rule.org_id, rule, cfg, smtp, state);
  const next = cfg.mode === "trigger"
    ? new Date(now.getTime() + clamp(cfg.trigger && cfg.trigger.cooldownHours, 1, 720, DEFAULT_COOLDOWN_H) * 3600000)
    : nextScheduleRun(cfg.schedule || {}, new Date(now.getTime() + 60000));
  await db.query("UPDATE email_rules SET last_run=now(), next_run=$1 WHERE id=$2", [next, rule.id]);
  return "sent";
}

async function runRuleNow(ruleId, orgId) {
  const r = await db.query("SELECT * FROM email_rules WHERE id=$1 AND org_id=$2", [ruleId, orgId]);
  if (!r.rows[0]) return "not-found";
  return runRule(r.rows[0], { force: true });
}

let _busy = false;
async function tick() {
  if (_busy) return; _busy = true;
  try {
    const due = await db.query("SELECT * FROM email_rules WHERE enabled=true AND (next_run IS NULL OR next_run<=now()) ORDER BY org_id LIMIT 200");
    const stateCache = {};
    for (const rule of due.rows) {
      try {
        if (!stateCache[rule.org_id]) stateCache[rule.org_id] = await reports.loadOrgState(rule.org_id);
        await runRule(rule, { state: stateCache[rule.org_id] });
      } catch (e) { /* logged inside; continue with next rule */ }
    }
  } catch (e) { /* swallow — try again next tick */ }
  finally { _busy = false; }
}

let _timer = null;
function start() {
  if (_timer) return;
  _timer = setInterval(() => { tick(); }, TICK_MS);
  if (_timer.unref) _timer.unref();
  setTimeout(() => { tick(); }, 5000); // first pass shortly after boot
  console.log("Email automation scheduler started (tick " + (TICK_MS / 1000) + "s).");
}

module.exports = { start, runRuleNow, computeNextRun };
