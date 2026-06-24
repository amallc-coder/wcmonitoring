"use strict";
/* AES-256-GCM encryption of PHI at rest.
   The data key is loaded once at boot via init(), from (in priority order):
     1. DATA_ENCRYPTION_KEY_FILE   — a mounted secret file (Docker/K8s/secret mgr)
     2. KMS_DATA_KEY_CIPHERTEXT    — an AWS-KMS-encrypted data key, decrypted at
                                     boot (needs @aws-sdk/client-kms + KMS_KEY_ID)
     3. DATA_ENCRYPTION_KEY        — raw 32-byte key in env (dev / simple deploys)
   Using (1) or (2) keeps the plaintext key out of the environment. */
const crypto = require("crypto");
const fs = require("fs");

let KEY = null;

function decodeKey(raw) {
  let key;
  if (/^[A-Fa-f0-9]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("Data key must decode to exactly 32 bytes (got " + key.length + ")");
  return key;
}

async function init() {
  if (KEY) return;
  if (process.env.DATA_ENCRYPTION_KEY_FILE) {
    KEY = decodeKey(fs.readFileSync(process.env.DATA_ENCRYPTION_KEY_FILE, "utf8").trim());
    return;
  }
  if (process.env.KMS_DATA_KEY_CIPHERTEXT) {
    let KMS;
    try { KMS = require("@aws-sdk/client-kms"); }
    catch (e) { throw new Error("KMS configured but @aws-sdk/client-kms is not installed — run: npm i @aws-sdk/client-kms"); }
    const client = new KMS.KMSClient({ region: process.env.AWS_REGION });
    const out = await client.send(new KMS.DecryptCommand({
      CiphertextBlob: Buffer.from(process.env.KMS_DATA_KEY_CIPHERTEXT, "base64"),
      KeyId: process.env.KMS_KEY_ID || undefined
    }));
    KEY = Buffer.from(out.Plaintext);
    if (KEY.length !== 32) throw new Error("KMS-decrypted data key must be 32 bytes");
    return;
  }
  if (process.env.DATA_ENCRYPTION_KEY) {
    KEY = decodeKey(process.env.DATA_ENCRYPTION_KEY);
    return;
  }
  throw new Error("No data-encryption key source configured (set DATA_ENCRYPTION_KEY[_FILE] or KMS_DATA_KEY_CIPHERTEXT)");
}

function ensure() { if (!KEY) throw new Error("crypto.init() must run before encrypt/decrypt"); }

// base64( iv[12] | authTag[16] | ciphertext )
function encrypt(obj) {
  ensure();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const pt = Buffer.from(JSON.stringify(obj == null ? null : obj), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

function decrypt(b64) {
  ensure();
  if (b64 == null) return null;
  const buf = Buffer.from(b64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  const pt = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

module.exports = { init, encrypt, decrypt };
