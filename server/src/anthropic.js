"use strict";
/* Claude (Anthropic) client — wound photo analysis (vision), interval comparison,
   and note drafting. Two providers:
     • Anthropic native   — ANTHROPIC_API_KEY  (api.anthropic.com / gateway)
     • AWS Bedrock        — BEDROCK_MODEL_ID    (needs @aws-sdk/client-bedrock-runtime)
   The system prompt mirrors .claude/skills/wound-care/SKILL.md. All output is
   clinical DECISION SUPPORT a licensed clinician reviews — never orders. Context
   is de-identified; images are PHI, so use a BAA-covered path for real photos. */

const API_URL = process.env.ANTHROPIC_API_URL || "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";
const BEDROCK_MODEL = process.env.BEDROCK_MODEL_ID || "";

function antKey() { return process.env.ANTHROPIC_API_KEY || ""; }
function model() { return process.env.ANTHROPIC_MODEL || "claude-opus-4-8"; }
function provider() { if (BEDROCK_MODEL) return "bedrock"; if (antKey()) return "anthropic"; return ""; }
function configured() { return provider() !== ""; }

const SKILL = [
"You are a wound-care clinical decision-support assistant for licensed clinicians in skilled-nursing settings.",
"Ground every recommendation in standard guidelines and name them: NPIAP 2019, IWGDF/IDSA 2023, WOCN, TIME, ISTAP.",
"You receive de-identified structured context and may receive one or two wound photographs.",
"With one photo: describe only what is visibly supported — wound-bed tissue (granulation/slough/eschar/epithelial, approx %), exudate, periwound skin, edges, signs suggestive of infection. State uncertainty; never invent measurements or identifiers.",
"With two photos (PREVIOUS then CURRENT): also compare them — interval change in size, tissue quality, granulation, exudate — and state the healing trajectory.",
"Give concrete, prioritized suggestions where relevant: imaging (X-ray/MRI for osteomyelitis, vascular studies), medications (topical antimicrobials, systemic antibiotic classes/considerations — not exact prescriptions), advanced therapy (cellular/tissue-based products / skin grafts, NPWT), labs & wound-care PCR / cultures, debridement, dressings & offloading/compression, nutrition, and referrals.",
"Flag red flags for urgent escalation (spreading infection/sepsis, critical limb ischemia, exposed bone).",
"This is decision support requiring clinician confirmation; recommend, do not diagnose or order. Note photo-assessment limitations.",
"Respond with STRICT JSON ONLY (no prose, no markdown fences) matching: {\"assessment\":string,\"tissue\":string,\"infectionSigns\":string,\"comparison\":string,\"trajectory\":string,\"imaging\":[string],\"medications\":[string],\"advancedTherapy\":[string],\"labs\":[string],\"debridement\":[string],\"dressings\":[string],\"referrals\":[string],\"redFlags\":[string],\"confidence\":string,\"disclaimer\":string}. Use [] for empty arrays and \"\" for comparison/trajectory when only one photo is given."
].join("\n");

function extractJson(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  return { assessment: t, disclaimer: "AI-generated — clinician to verify." };
}

async function callAnthropic(messages, maxTokens, keyOverride, modelOverride) {
  const r = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": keyOverride || antKey(), "anthropic-version": VERSION },
    body: JSON.stringify({ model: modelOverride || model(), max_tokens: maxTokens, system: SKILL, messages: messages })
  });
  if (!r.ok) { const e = new Error("anthropic " + r.status); e.status = r.status; throw e; }
  const d = await r.json();
  return (d && d.content && d.content[0] && d.content[0].text) || "";
}

async function callBedrock(messages, maxTokens) {
  let B;
  try { B = require("@aws-sdk/client-bedrock-runtime"); }
  catch (e) { throw new Error("Bedrock configured but @aws-sdk/client-bedrock-runtime not installed — run: npm i @aws-sdk/client-bedrock-runtime"); }
  const client = new B.BedrockRuntimeClient({ region: process.env.AWS_REGION });
  const body = { anthropic_version: "bedrock-2023-05-31", max_tokens: maxTokens, system: SKILL, messages: messages };
  const out = await client.send(new B.InvokeModelCommand({
    modelId: BEDROCK_MODEL, contentType: "application/json", accept: "application/json", body: JSON.stringify(body)
  }));
  const d = JSON.parse(Buffer.from(out.body).toString("utf8"));
  return (d && d.content && d.content[0] && d.content[0].text) || "";
}

function callModel(messages, maxTokens, opts) {
  opts = opts || {};
  // An org-provided Anthropic key (set by an admin, stored encrypted) overrides env and forces the native path.
  if (opts.apiKey) return callAnthropic(messages, maxTokens || 1200, opts.apiKey, opts.model);
  return provider() === "bedrock" ? callBedrock(messages, maxTokens || 1200) : callAnthropic(messages, maxTokens || 1200);
}

function imgBlock(image, mime) { return { type: "image", source: { type: "base64", media_type: mime || "image/jpeg", data: image } }; }

async function analyzeWound({ context, suggestions, image, mime, prevImage, prevMime, apiKey, aiModel }) {
  const content = [{
    type: "text",
    text: "De-identified wound/patient context:\n" + JSON.stringify(context || {}) +
          "\n\nDeterministic guideline prompts already surfaced by the app:\n" +
          ((suggestions || []).map(s => "- " + s).join("\n") || "(none)") +
          (prevImage ? "\n\nTwo photos follow — the FIRST is the PREVIOUS visit, the SECOND is the CURRENT visit. Compare them and fill 'comparison' and 'trajectory'."
                     : "\n\nAnalyze the wound" + (image ? " photograph" : "") + ".") +
          " Return the JSON described in your instructions."
  }];
  if (prevImage) { content.push({ type: "text", text: "PREVIOUS visit photo:" }); content.push(imgBlock(prevImage, prevMime)); content.push({ type: "text", text: "CURRENT visit photo:" }); }
  if (image) content.push(imgBlock(image, mime));
  const text = await callModel([{ role: "user", content: content }], 1600, { apiKey: apiKey, model: aiModel });
  return extractJson(text);
}

async function draftNote({ context, suggestions, apiKey, aiModel }) {
  const text = await callModel([{
    role: "user",
    content: [{ type: "text", text:
      "Write ONE concise progress note (brief assessment + plan) from this de-identified context. " +
      "Use only provided facts; cite guidelines in parentheses. Do NOT add any AI/disclaimer footer.\n\n" +
      "Context:\n" + JSON.stringify(context || {}) + "\n\nGuideline suggestions:\n" +
      ((suggestions || []).map(s => "- " + s).join("\n") || "(none)") }]
  }], 500, { apiKey: apiKey, model: aiModel });
  return (text || "").trim();
}

async function auditNote({ note, codes, context, apiKey, aiModel }) {
  const text = await callModel([{ role: "user", content: [{ type: "text", text:
    "You are auditing a wound-care visit note and its proposed charges for COMPLIANT, fully-captured reimbursement (avoid under-coding AND over-coding). Identify: " +
    "(1) documentation GAPS / missing verbiage required to SUPPORT the billed codes (e.g., tissue depth & total sq cm for debridement, failed-conservative-care for NPWT/CTP, medical necessity, progress or rationale); " +
    "(2) UNDER-CODING — services that were done but not captured, add-on units missed, or a justified higher level; " +
    "(3) the recommended ICD-10 / CPT / MODIFIER combination (incl. 25, 59/XU, KX, LT/RT) for this work; " +
    "(4) COMPLIANCE flags (LCD application caps, modifier necessity, laterality/depth specificity, bundling rules). " +
    "Recommend only what the documented work supports — NEVER invent clinical facts; if support is missing, state exactly what must be documented to bill it. Cite the rule briefly. " +
    "Return STRICT JSON only: {\"gaps\":[string],\"verbiage\":[string],\"underCoding\":[string],\"recommendedCodes\":[string],\"complianceFlags\":[string],\"summary\":string}.\n\n" +
    "NOTE:\n" + (note || "") + "\n\nPROPOSED CHARGES:\n" + ((codes || []).join("\n") || "(none)") +
    "\n\nDE-IDENTIFIED CONTEXT:\n" + JSON.stringify(context || {}) }] }], 1300, { apiKey: apiKey, model: aiModel });
  return extractJson(text);
}

module.exports = { configured, provider, analyzeWound, draftNote, auditNote };
