"use strict";
/* AES-256-GCM encryption of PHI at rest.
   Every record's JSON payload is encrypted before it touches the database, so a
   database dump, replica, or stolen backup never exposes plaintext PHI without
   the DATA_ENCRYPTION_KEY (held only in the app's environment / a KMS). */
const crypto = require("crypto");

function loadKey() {
  const raw = process.env.DATA_ENCRYPTION_KEY || "";
  if (!raw) throw new Error("DATA_ENCRYPTION_KEY is required");
  let key;
  if (/^[A-Fa-f0-9]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("DATA_ENCRYPTION_KEY must decode to exactly 32 bytes (got " + key.length + ")");
  }
  return key;
}
const KEY = loadKey();

// Returns base64( iv[12] | authTag[16] | ciphertext )
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const pt = Buffer.from(JSON.stringify(obj == null ? null : obj), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

function decrypt(b64) {
  if (b64 == null) return null;
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

module.exports = { encrypt, decrypt };
