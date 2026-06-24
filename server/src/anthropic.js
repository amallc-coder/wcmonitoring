"use strict";
/* Claude (Anthropic) client — wound photo analysis (vision) + note drafting.
   The system prompt mirrors the wound-care skill in .claude/skills/wound-care/.
   All output is clinical DECISION SUPPORT for a licensed clinician to review —
   never auto-orders. Context arrives de-identified; images are PHI, so a
   BAA-covered Anthropic access path is required for real patient photos. */

const API_URL = process.env.ANTHROPIC_API_URL || "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

function key() { return process.env.ANTHROPIC_API_KEY || ""; }
function model() { return process.env.ANTHROPIC_MODEL || "claude-opus-4-8"; }
function configured() { return !!key(); }

const SKILL = [
"You are a wound-care clinical decision-support assistant for licensed clinicians in skilled-nursing settings.",
"Ground every recommendation in standard guidelines and name them: NPIAP 2019 (pressure injury staging/prevention), IWGDF/IDSA 2023 (diabetic foot, infection, offloading, osteomyelitis), WOCN (venous/arterial, ABI before compression), TIME (wound-bed prep), ISTAP (skin tears).",
"You receive de-identified structured context and (optionally) a wound photograph.",
"When a photo is provided, describe only what is visibly supported: wound bed tissue composition (granulation/slough/eschar/epithelial, approx %), exudate, periwound skin, edges, peri-wound erythema/maceration, and visible signs suggestive of infection. State uncertainty; do not invent measurements or identifiers.",
"Then give concrete, prioritized suggestions across these areas where relevant: imaging (e.g., X-ray/MRI for osteomyelitis, vascular studies), medications (topical antimicrobials, systemic antibiotics — classes/considerations, not exact prescriptions), advanced therapy (cellular/tissue-based products / skin grafts, NPWT), laboratory & wound-care PCR / cultures, debridement, dressings & offloading/compression, nutrition, and referrals (vascular, ID, podiatry, surgery, dietitian).",
"Always flag red-flags (spreading infection/sepsis, critical limb ischemia, exposed bone) for urgent escalation.",
"Be explicit that this is decision support requiring clinician confirmation; recommend, do not diagnose or order. Note photo assessment limitations.",
"Respond with STRICT JSON ONLY (no prose, no markdown fences) matching: {\"assessment\":string,\"tissue\":string,\"infectionSigns\":string,\"imaging\":[string],\"medications\":[string],\"advancedTherapy\":[string],\"labs\":[string],\"debridement\":[string],\"dressings\":[string],\"referrals\":[string],\"redFlags\":[string],\"confidence\":string,\"disclaimer\":string}. Use [] for empty arrays."
].join("\n");

function extractJson(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/,"").trim();
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  return { assessment: t, disclaimer: "AI-generated — clinician to verify." };
}

async function callClaude(messages, maxTokens) {
  const r = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key(), "anthropic-version": VERSION },
    body: JSON.stringify({ model: model(), max_tokens: maxTokens || 1200, system: SKILL, messages: messages })
  });
  if (!r.ok) { const e = new Error("anthropic " + r.status); e.status = r.status; throw e; }
  const d = await r.json();
  return (d && d.content && d.content[0] && d.content[0].text) || "";
}

async function analyzeWound({ context, suggestions, image, mime }) {
  const content = [{
    type: "text",
    text: "De-identified wound/patient context:\n" + JSON.stringify(context || {}) +
          "\n\nDeterministic guideline prompts already surfaced by the app:\n" +
          ((suggestions || []).map(s => "- " + s).join("\n") || "(none)") +
          "\n\nAnalyze the wound" + (image ? " photograph" : "") + " and return the JSON described in your instructions."
  }];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: mime || "image/jpeg", data: image } });
  const text = await callClaude([{ role: "user", content }], 1400);
  return extractJson(text);
}

async function draftNote({ context, suggestions }) {
  const text = await callClaude([{
    role: "user",
    content: [{ type: "text", text:
      "Write ONE concise progress note (brief assessment + plan) from this de-identified context. " +
      "Use only provided facts; cite guidelines in parentheses; end with 'AI-drafted — clinician to verify.'\n\n" +
      "Context:\n" + JSON.stringify(context || {}) + "\n\nGuideline suggestions:\n" +
      ((suggestions || []).map(s => "- " + s).join("\n") || "(none)") }]
  }], 500);
  return text.trim();
}

module.exports = { configured, analyzeWound, draftNote };
