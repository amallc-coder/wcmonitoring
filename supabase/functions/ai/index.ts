// Clinilytics Wound Care — AI Edge Function (auth: "user").
// One shared Claude key for the whole org, held server-side as a Supabase secret
// (ANTHROPIC_API_KEY) — never sent to browsers. Only signed-in users can call it.
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   (and optional ANTHROPIC_MODEL)
//
// Routes (base /functions/v1/ai):
//   POST /ai/analyze   { context, suggestions, image?, mime?, prevImage?, prevMime? } -> { analysis }
//   POST /ai/draft     { context, suggestions }                                       -> { text }
//   POST /ai/audit     { note, codes, context }                                       -> { audit }
import { withSupabase } from "npm:@supabase/server"

const API_URL = "https://api.anthropic.com/v1/messages"
const VERSION = "2023-06-01"
const MODEL = () => Deno.env.get("ANTHROPIC_MODEL") || "claude-opus-4-8"
const KEY = () => Deno.env.get("ANTHROPIC_API_KEY") || ""

const SKILL = [
  "You are a wound-care clinical decision-support assistant for licensed clinicians in skilled-nursing settings.",
  "Ground every recommendation in standard guidelines and name them: NPIAP 2019, IWGDF/IDSA 2023, WOCN, TIME, ISTAP.",
  "You receive de-identified structured context and may receive one or two wound photographs.",
  "With one photo: describe only what is visibly supported — tissue (granulation/slough/eschar/epithelial %), exudate, periwound, edges, infection signs. State uncertainty; never invent measurements or identifiers.",
  "With two photos (PREVIOUS then CURRENT): compare them — interval change in size, tissue, granulation, exudate — and state the trajectory.",
  "Give concrete, prioritized suggestions: imaging, medications (classes, not prescriptions), advanced therapy (CTP/grafts, NPWT), labs & wound PCR/cultures, debridement, dressings & offloading/compression, nutrition, referrals.",
  "Flag red flags for urgent escalation. This is decision support requiring clinician confirmation; recommend, do not diagnose or order.",
  "When asked for an analysis, respond with STRICT JSON ONLY: {\"assessment\":string,\"tissue\":string,\"infectionSigns\":string,\"comparison\":string,\"trajectory\":string,\"imaging\":[string],\"medications\":[string],\"advancedTherapy\":[string],\"labs\":[string],\"debridement\":[string],\"dressings\":[string],\"referrals\":[string],\"redFlags\":[string],\"confidence\":string,\"disclaimer\":string}. Use [] / \"\" when not applicable.",
].join("\n")

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } })
function extractJson(t: string): any {
  if (!t) return null
  let s = t.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "").trim()
  try { return JSON.parse(s) } catch (_) {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}")
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)) } catch (_) {} }
  return { assessment: s }
}
async function callClaude(messages: any[], maxTokens: number): Promise<string> {
  const r = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY(), "anthropic-version": VERSION },
    body: JSON.stringify({ model: MODEL(), max_tokens: maxTokens, system: SKILL, messages }),
  })
  if (!r.ok) throw new Error("anthropic " + r.status)
  const d = await r.json()
  return (d?.content?.[0]?.text) || ""
}
const img = (data: string, mime?: string) => ({ type: "image", source: { type: "base64", media_type: mime || "image/jpeg", data } })

export default {
  fetch: withSupabase({ auth: "user" }, async (req: Request) => {
    if (!KEY()) return json({ error: "AI not configured (set the ANTHROPIC_API_KEY secret)" }, 501)
    const op = new URL(req.url).pathname.split("/").filter(Boolean).pop()
    const body = await req.json().catch(() => ({})) as any
    try {
      if (op === "analyze") {
        const content: any[] = [{ type: "text", text:
          "De-identified context:\n" + JSON.stringify(body.context || {}) +
          "\n\nApp guideline prompts:\n" + ((body.suggestions || []).map((s: string) => "- " + s).join("\n") || "(none)") +
          (body.prevImage ? "\n\nTwo photos follow — FIRST is PREVIOUS, SECOND is CURRENT; compare and fill 'comparison'/'trajectory'."
                          : "\n\nAnalyze the wound" + (body.image ? " photograph" : "") + ".") + " Return the JSON in your instructions." }]
        if (body.prevImage) { content.push({ type: "text", text: "PREVIOUS:" }, img(body.prevImage, body.prevMime), { type: "text", text: "CURRENT:" }) }
        if (body.image) content.push(img(body.image, body.mime))
        return json({ analysis: extractJson(await callClaude([{ role: "user", content }], 1600)) })
      }
      if (op === "draft") {
        const text = await callClaude([{ role: "user", content: [{ type: "text", text:
          "Write ONE concise progress note (assessment + plan) from this de-identified context. Use only provided facts; cite guidelines in parentheses. Do NOT add any AI/disclaimer footer.\n\nContext:\n" +
          JSON.stringify(body.context || {}) + "\n\nGuideline suggestions:\n" + ((body.suggestions || []).map((s: string) => "- " + s).join("\n") || "(none)") }] }], 500)
        return json({ text: (text || "").trim() })
      }
      if (op === "audit") {
        const text = await callClaude([{ role: "user", content: [{ type: "text", text:
          "Audit this wound-care visit note + proposed charges for COMPLIANT, fully-captured reimbursement (no under- or over-coding). Identify: (1) documentation gaps/verbiage to support the codes; (2) under-coding / missed add-on units / justified higher level; (3) recommended ICD-10/CPT/modifier combo (25, 59/XU, KX, LT/RT); (4) compliance flags (LCD caps, modifier necessity, laterality/depth, bundling). Recommend only what the documented work supports; never invent facts. Return STRICT JSON: {\"gaps\":[string],\"verbiage\":[string],\"underCoding\":[string],\"recommendedCodes\":[string],\"complianceFlags\":[string],\"summary\":string}.\n\nNOTE:\n" +
          (body.note || "") + "\n\nPROPOSED CHARGES:\n" + ((body.codes || []).join("\n") || "(none)") + "\n\nCONTEXT:\n" + JSON.stringify(body.context || {}) }] }], 1300)
        return json({ audit: extractJson(text) })
      }
      return json({ error: "Unknown AI route" }, 404)
    } catch (e: any) {
      return json({ error: (e && e.message) || "AI request failed" }, 502)
    }
  }),
}
