"use strict";
/* Server-side report builders for scheduled / triggered emails.
   Reads the org's encrypted snapshot, decrypts it, and renders an HTML email
   body + a CSV attachment table. No PHI leaves here except to the recipients
   the admin configured (their responsibility / BAA). */

const db = require("./db");
const { decrypt } = require("./crypto");

async function loadOrgState(orgId) {
  const out = { facilities: [], patients: [], wounds: [] };
  const r = await db.query("SELECT kind,id,data_enc FROM records WHERE org_id=$1", [orgId]);
  for (const row of r.rows) {
    let d; try { d = decrypt(row.data_enc); } catch (e) { continue; }
    if (row.kind === "facility") out.facilities.push(d);
    else if (row.kind === "patient") out.patients.push(d);
    else if (row.kind === "wound") out.wounds.push(d);
  }
  return out;
}

function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function parseDate(s) { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; }
function daysSince(s) { const d = parseDate(s); if (!d) return null; return Math.floor((Date.now() - d.getTime()) / 86400000); }
function areaOf(h) { return (h && h.L && h.W) ? +(h.L * h.W).toFixed(1) : null; }
function measuredEntries(w) { return (w.chart || []).filter(h => h.L && h.W); }
function lastMeasured(w) { const m = measuredEntries(w); return m.length ? m[m.length - 1] : null; }
function firstMeasured(w) { const m = measuredEntries(w); return m.length ? m[0] : null; }
function reductionPct(w) {
  const f = firstMeasured(w), l = lastMeasured(w);
  if (!f || !l || f === l) return null;
  const fa = f.L * f.W; if (fa <= 0) return null;
  return Math.round((fa - l.L * l.W) / fa * 100);
}
function lastAssessed(w) {
  const c = w.chart || []; if (!c.length) return w.ls || "";
  return c[c.length - 1].dt || w.ls || "";
}

function applyFilters(wounds, filters) {
  filters = filters || {};
  return wounds.filter(w => {
    if (filters.facility && w.fac !== filters.facility) return false;
    if (filters.provider && (w.pv || "") !== filters.provider) return false;
    return true;
  });
}

const STALE_DAYS = 7;

// Each builder returns { subject, intro, head:[...], rows:[[...]], empty:bool }
const BUILDERS = {
  "weekly-wound": function (state, filters) {
    const ws = applyFilters(state.wounds, filters);
    const rows = ws.map(w => {
      const le = lastMeasured(w) || {};
      const ds = daysSince(lastAssessed(w));
      const red = reductionPct(w);
      return [w.name || "", w.fac || "", w.tp || "", w.stage || "", w.loc || "",
        areaOf(le) != null ? areaOf(le) + " cm²" : "—",
        red != null ? (red >= 0 ? "−" : "+") + Math.abs(red) + "%" : "—",
        w.heal || "—", w.inf ? "YES" : "no", lastAssessed(w) || "—",
        ds != null ? ds + "d" : "—", w.pv || ""];
    });
    return {
      subject: "Weekly Wound Summary — " + ws.length + " active wound" + (ws.length === 1 ? "" : "s"),
      intro: "Active wound roster" + (filters && filters.facility ? " for " + filters.facility : "") + ", with latest area, interval change, healing status and overdue days.",
      head: ["Resident", "Facility", "Type", "Stage", "Location", "Area", "Δ vs baseline", "Healing", "Infection", "Last assessed", "Overdue", "Provider"],
      rows: rows, empty: rows.length === 0
    };
  },
  "stale-wounds": function (state, filters) {
    const ws = applyFilters(state.wounds, filters).filter(w => { const d = daysSince(lastAssessed(w)); return d == null || d >= STALE_DAYS; });
    const rows = ws.map(w => { const d = daysSince(lastAssessed(w)); return [w.name || "", w.fac || "", w.tp || "", w.loc || "", lastAssessed(w) || "never", d != null ? d + "d" : "—", w.pv || ""]; });
    return {
      subject: "Overdue Wound Assessments — " + rows.length + " need attention",
      intro: "Wounds not reassessed in ≥" + STALE_DAYS + " days. Please round and chart updated measurements.",
      head: ["Resident", "Facility", "Type", "Location", "Last assessed", "Overdue", "Provider"],
      rows: rows, empty: rows.length === 0
    };
  },
  "infections": function (state, filters) {
    const ws = applyFilters(state.wounds, filters).filter(w => w.inf);
    const rows = ws.map(w => { const le = lastMeasured(w) || {}; return [w.name || "", w.fac || "", w.tp || "", w.loc || "", le.infSev || "—", le.culture || "—", le.abx || "—", w.pv || ""]; });
    return {
      subject: "Active Wound Infections — " + rows.length + " flagged",
      intro: "Wounds with infection currently flagged. Review antimicrobial plan, culture/PCR and escalation.",
      head: ["Resident", "Facility", "Type", "Location", "Severity", "Culture", "Antibiotics", "Provider"],
      rows: rows, empty: rows.length === 0
    };
  },
  "high-risk": function (state, filters) {
    const ws = applyFilters(state.wounds, filters).filter(w => (w.braden != null && w.braden <= 12) || ["Stage 4", "Unstageable"].indexOf(w.stage) >= 0 || (w.abi != null && w.abi < 0.8));
    const rows = ws.map(w => [w.name || "", w.fac || "", w.tp || "", w.stage || "", w.loc || "", w.braden != null ? w.braden : "—", w.abi != null ? w.abi : "—", w.goal || "", w.pv || ""]);
    return {
      subject: "High-Risk Wounds — " + rows.length + " flagged",
      intro: "Wounds flagged high-risk by Braden ≤12, Stage 4/Unstageable, or ABI <0.8.",
      head: ["Resident", "Facility", "Type", "Stage", "Location", "Braden", "ABI", "Goal", "Provider"],
      rows: rows, empty: rows.length === 0
    };
  },
  "portfolio": function (state, filters) {
    const ws = applyFilters(state.wounds, filters);
    const byFac = {};
    ws.forEach(w => {
      const f = w.fac || "—"; const o = byFac[f] || (byFac[f] = { active: 0, inf: 0, stale: 0, healing: 0 });
      o.active++; if (w.inf) o.inf++;
      const d = daysSince(lastAssessed(w)); if (d == null || d >= STALE_DAYS) o.stale++;
      if (["Progressing", "Improving", "Healed"].indexOf(w.heal) >= 0) o.healing++;
    });
    const rows = Object.keys(byFac).sort().map(f => { const o = byFac[f]; return [f, o.active, o.inf, o.stale, o.healing, o.active ? Math.round(o.healing / o.active * 100) + "%" : "—"]; });
    return {
      subject: "Wound Care Portfolio Summary — " + ws.length + " active",
      intro: "Per-facility roll-up: active wounds, infections, overdue assessments and healing rate.",
      head: ["Facility", "Active", "Infected", "Overdue", "Healing", "Healing %"],
      rows: rows, empty: rows.length === 0
    };
  }
};

const REPORT_TYPES = [
  { key: "weekly-wound", label: "Weekly wound summary" },
  { key: "portfolio", label: "Portfolio summary (per facility)" },
  { key: "stale-wounds", label: "Overdue assessments" },
  { key: "infections", label: "Active infections" },
  { key: "high-risk", label: "High-risk wounds" }
];

function csvFrom(head, rows) {
  const q = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  return [head].concat(rows).map(r => r.map(q).join(",")).join("\r\n");
}

function htmlFrom(rep) {
  const th = rep.head.map(h => '<th style="text-align:left;padding:6px 9px;border-bottom:2px solid #ccd2d1;font:600 12px system-ui;color:#26282d">' + esc(h) + '</th>').join("");
  const tr = rep.rows.map((r, i) => '<tr style="background:' + (i % 2 ? "#f7f9f9" : "#fff") + '">' + r.map(c =>
    '<td style="padding:5px 9px;border-bottom:1px solid #e6eaea;font:13px system-ui;color:#42474d">' + esc(c) + '</td>').join("") + '</tr>').join("");
  return [
    '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:900px;margin:0 auto;color:#26282d">',
    '<div style="padding:14px 0;border-bottom:3px solid #c2603f"><span style="font:700 18px system-ui">clinilytics</span> <span style="color:#6b7280">· Wound Care</span></div>',
    '<h2 style="font:600 18px system-ui;margin:16px 0 4px">' + esc(rep.subject) + '</h2>',
    '<div style="color:#6b7280;font-size:13px;margin-bottom:12px">' + esc(rep.intro) + '</div>',
    rep.empty
      ? '<div style="padding:18px;background:#f1f5f4;border-radius:8px;color:#356b64">Nothing to report — no matching wounds. ✓</div>'
      : '<table style="border-collapse:collapse;width:100%"><thead><tr>' + th + '</tr></thead><tbody>' + tr + '</tbody></table>',
    '<div style="margin-top:16px;color:#9aa0a6;font-size:11px;line-height:1.5">Automated report from Clinilytics — Wound Care. A CSV copy is attached. This message may contain PHI — handle per your organization\'s policy.</div>',
    '</div>'
  ].join("");
}

function buildReport(type, state, filters) {
  const b = BUILDERS[type] || BUILDERS["weekly-wound"];
  const rep = b(state, filters || {});
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    subject: rep.subject,
    html: htmlFrom(rep),
    csv: csvFrom(rep.head, rep.rows),
    filename: type + "_" + stamp + ".csv",
    count: rep.rows.length,
    empty: rep.empty
  };
}

// Trigger conditions return the count of matching items (0 = condition not met).
function triggerCount(type, state, filters) {
  const rep = (BUILDERS[type] || BUILDERS["stale-wounds"])(state, filters || {});
  return rep.rows.length;
}

module.exports = { loadOrgState, buildReport, triggerCount, REPORT_TYPES };
