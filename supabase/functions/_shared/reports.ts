// Report builders for scheduled / triggered emails (Deno port of the Node version).
// Operate on the app objects stored in each row's `data` jsonb.
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
  "weekly-wound": (s, f) => {
    const ws = filt(s.wounds, f)
    const rows = ws.map(w => { const le = lastMeas(w) || {}; const ds = daysSince(lastAssessed(w)); const r = reductionPct(w)
      return [w.name || "", w.fac || "", w.tp || "", w.stage || "", w.loc || "", areaOf(le) != null ? areaOf(le) + " cm²" : "—",
        r != null ? (r >= 0 ? "−" : "+") + Math.abs(r) + "%" : "—", w.heal || "—", w.inf ? "YES" : "no", lastAssessed(w) || "—", ds != null ? ds + "d" : "—", w.pv || ""] })
    return { subject: `Weekly Wound Summary — ${ws.length} active wound${ws.length === 1 ? "" : "s"}`, intro: "Active wound roster with latest area, interval change, healing and overdue days.",
      head: ["Resident", "Facility", "Type", "Stage", "Location", "Area", "Δ vs baseline", "Healing", "Infection", "Last assessed", "Overdue", "Provider"], rows, empty: rows.length === 0 }
  },
  "stale-wounds": (s, f) => {
    const ws = filt(s.wounds, f).filter(w => { const d = daysSince(lastAssessed(w)); return d == null || d >= STALE_DAYS })
    const rows = ws.map(w => { const d = daysSince(lastAssessed(w)); return [w.name || "", w.fac || "", w.tp || "", w.loc || "", lastAssessed(w) || "never", d != null ? d + "d" : "—", w.pv || ""] })
    return { subject: `Overdue Wound Assessments — ${rows.length} need attention`, intro: `Wounds not reassessed in ≥${STALE_DAYS} days.`,
      head: ["Resident", "Facility", "Type", "Location", "Last assessed", "Overdue", "Provider"], rows, empty: rows.length === 0 }
  },
  "infections": (s, f) => {
    const ws = filt(s.wounds, f).filter(w => w.inf)
    const rows = ws.map(w => { const le = lastMeas(w) || {}; return [w.name || "", w.fac || "", w.tp || "", w.loc || "", le.infSev || "—", le.culture || "—", le.abx || "—", w.pv || ""] })
    return { subject: `Active Wound Infections — ${rows.length} flagged`, intro: "Wounds with infection currently flagged.",
      head: ["Resident", "Facility", "Type", "Location", "Severity", "Culture", "Antibiotics", "Provider"], rows, empty: rows.length === 0 }
  },
  "high-risk": (s, f) => {
    const ws = filt(s.wounds, f).filter(w => (w.braden != null && w.braden <= 12) || ["Stage 4", "Unstageable"].includes(w.stage) || (w.abi != null && w.abi < 0.8))
    const rows = ws.map(w => [w.name || "", w.fac || "", w.tp || "", w.stage || "", w.loc || "", w.braden ?? "—", w.abi ?? "—", w.goal || "", w.pv || ""])
    return { subject: `High-Risk Wounds — ${rows.length} flagged`, intro: "Flagged by Braden ≤12, Stage 4/Unstageable, or ABI <0.8.",
      head: ["Resident", "Facility", "Type", "Stage", "Location", "Braden", "ABI", "Goal", "Provider"], rows, empty: rows.length === 0 }
  },
  "portfolio": (s, f) => {
    const ws = filt(s.wounds, f); const by: Record<string, any> = {}
    ws.forEach(w => { const k = w.fac || "—"; const o = by[k] || (by[k] = { active: 0, inf: 0, stale: 0, healing: 0 })
      o.active++; if (w.inf) o.inf++; const d = daysSince(lastAssessed(w)); if (d == null || d >= STALE_DAYS) o.stale++
      if (["Progressing", "Improving", "Healed"].includes(w.heal)) o.healing++ })
    const rows = Object.keys(by).sort().map(k => { const o = by[k]; return [k, o.active, o.inf, o.stale, o.healing, o.active ? Math.round(o.healing / o.active * 100) + "%" : "—"] })
    return { subject: `Wound Care Portfolio Summary — ${ws.length} active`, intro: "Per-facility roll-up.",
      head: ["Facility", "Active", "Infected", "Overdue", "Healing", "Healing %"], rows, empty: rows.length === 0 }
  },
}

export const REPORT_TYPES = ["weekly-wound", "portfolio", "stale-wounds", "infections", "high-risk"]
const csvFrom = (head: string[], rows: any[][]) => [head, ...rows].map(r => r.map(v => '"' + String(v ?? "").replace(/"/g, '""') + '"').join(",")).join("\r\n")
function htmlFrom(rep: Built) {
  const th = rep.head.map(h => `<th style="text-align:left;padding:6px 9px;border-bottom:2px solid #ccd2d1;font:600 12px system-ui;color:#26282d">${esc(h)}</th>`).join("")
  const tr = rep.rows.map((r, i) => `<tr style="background:${i % 2 ? "#f7f9f9" : "#fff"}">` + r.map(c => `<td style="padding:5px 9px;border-bottom:1px solid #e6eaea;font:13px system-ui;color:#42474d">${esc(c)}</td>`).join("") + "</tr>").join("")
  return `<div style="font-family:system-ui,Arial,sans-serif;max-width:900px;margin:0 auto;color:#26282d">`
    + `<div style="padding:14px 0;border-bottom:3px solid #c2603f"><span style="font:700 18px system-ui">clinilytics</span> <span style="color:#6b7280">· Wound Care</span></div>`
    + `<h2 style="font:600 18px system-ui;margin:16px 0 4px">${esc(rep.subject)}</h2>`
    + `<div style="color:#6b7280;font-size:13px;margin-bottom:12px">${esc(rep.intro)}</div>`
    + (rep.empty ? `<div style="padding:18px;background:#f1f5f4;border-radius:8px;color:#356b64">Nothing to report. ✓</div>`
                 : `<table style="border-collapse:collapse;width:100%"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`)
    + `<div style="margin-top:16px;color:#9aa0a6;font-size:11px">Automated report from Clinilytics — Wound Care. CSV attached. May contain PHI — handle per policy.</div></div>`
}

export function buildReport(type: string, state: State, filters: any) {
  const rep = (BUILDERS[type] || BUILDERS["weekly-wound"])(state, filters || {})
  return { subject: rep.subject, html: htmlFrom(rep), csv: csvFrom(rep.head, rep.rows), filename: `${type}_${new Date().toISOString().slice(0, 10)}.csv`, count: rep.rows.length, empty: rep.empty }
}
export function triggerCount(type: string, state: State, filters: any) {
  return (BUILDERS[type] || BUILDERS["stale-wounds"])(state, filters || {}).rows.length
}
