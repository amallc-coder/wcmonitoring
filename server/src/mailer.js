"use strict";
/* SMTP settings (per org, encrypted at rest) + sending via nodemailer.
   Settings are configured from the app's Admin → Email & Automation panel and
   stored encrypted because they include the SMTP password. */

const db = require("./db");
const { encrypt, decrypt } = require("./crypto");

let nodemailer = null;
function lib() {
  if (nodemailer) return nodemailer;
  try { nodemailer = require("nodemailer"); }
  catch (e) { throw new Error("nodemailer not installed — run: npm i nodemailer"); }
  return nodemailer;
}

async function getSettings(orgId) {
  const r = await db.query("SELECT config_enc FROM email_settings WHERE org_id=$1", [orgId]);
  if (!r.rows[0]) return null;
  try { return decrypt(r.rows[0].config_enc); } catch (e) { return null; }
}

async function saveSettings(orgId, cfg, by) {
  await db.query(
    "INSERT INTO email_settings (org_id,config_enc,updated_at,updated_by) VALUES ($1,$2,now(),$3) " +
    "ON CONFLICT (org_id) DO UPDATE SET config_enc=EXCLUDED.config_enc, updated_at=now(), updated_by=EXCLUDED.updated_by",
    [orgId, encrypt(cfg), by || null]
  );
}

function configured(cfg) { return !!(cfg && cfg.host && cfg.from); }

function transport(cfg) {
  const port = parseInt(cfg.port, 10) || 587;
  return lib().createTransport({
    host: cfg.host,
    port: port,
    secure: cfg.secure === true || port === 465,
    auth: (cfg.user || cfg.pass) ? { user: cfg.user, pass: cfg.pass } : undefined
  });
}

async function sendMail(cfg, msg) {
  if (!configured(cfg)) throw new Error("SMTP not configured");
  const t = transport(cfg);
  const from = cfg.fromName ? '"' + cfg.fromName.replace(/"/g, "") + '" <' + cfg.from + ">" : cfg.from;
  return t.sendMail({
    from: from,
    to: Array.isArray(msg.to) ? msg.to.join(", ") : msg.to,
    cc: msg.cc && msg.cc.length ? (Array.isArray(msg.cc) ? msg.cc.join(", ") : msg.cc) : undefined,
    subject: msg.subject,
    text: msg.text || undefined,
    html: msg.html || undefined,
    attachments: msg.attachments || undefined
  });
}

async function sendTest(cfg, to) {
  return sendMail(cfg, {
    to: to,
    subject: "Clinilytics — Wound Care: test email ✓",
    text: "This is a test from Clinilytics — Wound Care. If you received it, your SMTP settings work.",
    html: '<div style="font-family:system-ui,Arial,sans-serif"><h2 style="color:#c2603f">clinilytics · Wound Care</h2><p>✓ Your SMTP settings work. Automated reports and triggered alerts will be delivered from here.</p></div>'
  });
}

module.exports = { getSettings, saveSettings, sendMail, sendTest, configured };
