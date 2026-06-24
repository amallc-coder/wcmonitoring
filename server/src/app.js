"use strict";
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const db = require("./db");
const { encrypt, decrypt } = require("./crypto");
const { hashPassword, verifyPassword, signToken, authRequired, requireRole } = require("./auth");

const PER_ROW_KINDS = ["facility", "patient", "wound"];
const MAX_ROWS_PER_KIND = 50000;
const MAX_RECORD_BYTES = 12 * 1024 * 1024; // per-record JSON cap (photos are base64)

// Wrap async handlers so a rejected promise returns 500 instead of hanging.
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(() => {
    if (!res.headersSent) res.status(500).json({ error: "server error" });
  });

function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 10) return "Password must be at least 10 characters";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must include letters and numbers";
  return null;
}

function buildApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());

  const origins = (process.env.CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  app.use(cors({
    // Fail closed: only explicitly allow-listed browser origins. Non-browser
    // clients (no Origin header, e.g. curl/health checks) are still allowed.
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (origins.indexOf(origin) >= 0) return cb(null, true);
      return cb(new Error("CORS: origin not allowed"));
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"]
  }));
  app.use(express.json({ limit: process.env.BODY_LIMIT || "30mb" }));

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
  // Modest global limit on authenticated traffic to blunt abuse.
  const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false });
  app.use("/api/", apiLimiter);

  async function audit(req, action, detail) {
    try {
      await db.query(
        "INSERT INTO audit_log (org_id, user_id, username, action, detail, ip) VALUES ($1,$2,$3,$4,$5,$6)",
        [req.user ? req.user.org : null, req.user ? req.user.sub : null, req.user ? req.user.username : null,
         action, detail || null, (req.headers["x-forwarded-for"] || req.ip || "").toString().split(",")[0].trim()]
      );
    } catch (e) { /* audit must never break the request */ }
  }

  // Re-check the account on every authenticated request, so disabling a user (or
  // a token issued before disable) is honored immediately rather than at expiry.
  const ensureActive = wrap(async (req, res, next) => {
    const r = await db.query("SELECT active FROM users WHERE id=$1 AND org_id=$2", [req.user.sub, req.user.org]);
    if (!r.rows[0] || r.rows[0].active !== true) return res.status(401).json({ error: "Account disabled" });
    next();
  });
  const authed = [authRequired, ensureActive];

  // ── health (no auth) ──
  app.get("/api/health", wrap(async (req, res) => {
    try { await db.query("SELECT 1"); res.json({ ok: true, db: "up", time: new Date().toISOString() }); }
    catch (e) { res.status(503).json({ ok: false, db: "down" }); }
  }));

  // ── auth ──
  app.post("/api/auth/login", authLimiter, wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username & password required" });
    const r = await db.query("SELECT * FROM users WHERE lower(username)=lower($1) AND active=true LIMIT 1", [username]);
    const u = r.rows[0];
    if (!u || !(await verifyPassword(password, u.pass_hash))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    await db.query("UPDATE users SET last_login=now() WHERE id=$1", [u.id]);
    req.user = { org: u.org_id, sub: u.id, username: u.username };
    await audit(req, "login", null);
    res.json({ token: signToken(u), user: { username: u.username, name: u.name, role: u.role } });
  }));

  app.get("/api/auth/me", authed, (req, res) => {
    res.json({ username: req.user.username, name: req.user.name, role: req.user.role });
  });

  // ── users (admin) ──
  app.get("/api/users", authed, requireRole("Admin"), wrap(async (req, res) => {
    const r = await db.query("SELECT username,name,role,active,last_login,created_at FROM users WHERE org_id=$1 ORDER BY username", [req.user.org]);
    res.json(r.rows);
  }));
  app.post("/api/users", authed, requireRole("Admin"), wrap(async (req, res) => {
    const { username, name, role, password } = req.body || {};
    if (!username) return res.status(400).json({ error: "username required" });
    const pwErr = passwordProblem(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const ok = ["Admin", "Wound Provider", "Viewer"].indexOf(role) >= 0 ? role : "Wound Provider";
    try {
      await db.query("INSERT INTO users (org_id,username,name,role,pass_hash) VALUES ($1,$2,$3,$4,$5)",
        [req.user.org, String(username).toLowerCase(), name || username, ok, await hashPassword(password)]);
      await audit(req, "user.create", username);
      res.json({ ok: true });
    } catch (e) { res.status(409).json({ error: "Username already exists" }); }
  }));
  app.delete("/api/users/:username", authed, requireRole("Admin"), wrap(async (req, res) => {
    if (req.params.username.toLowerCase() === (req.user.username || "").toLowerCase())
      return res.status(400).json({ error: "Cannot remove yourself" });
    await db.query("UPDATE users SET active=false WHERE org_id=$1 AND lower(username)=lower($2)", [req.user.org, req.params.username]);
    await audit(req, "user.disable", req.params.username);
    res.json({ ok: true });
  }));

  // ── snapshot: full org state (encrypted at rest) ──
  app.get("/api/snapshot", authed, wrap(async (req, res) => {
    const out = { facilities: [], patients: [], wounds: [], sentlog: [] };
    const r = await db.query("SELECT kind,id,data_enc FROM records WHERE org_id=$1", [req.user.org]);
    for (const row of r.rows) {
      let data;
      try { data = decrypt(row.data_enc); } catch (e) { continue; } // skip a single corrupt row, don't fail the whole fetch
      if (row.kind === "facility") out.facilities.push(data);
      else if (row.kind === "patient") out.patients.push(data);
      else if (row.kind === "wound") out.wounds.push(data);
      else if (row.kind === "meta" && row.id === "sentlog") out.sentlog = Array.isArray(data) ? data : [];
    }
    res.json(out);
  }));

  app.put("/api/snapshot", authed, requireRole("Admin", "Wound Provider"), wrap(async (req, res) => {
    const body = req.body || {};
    const sets = {
      facility: Array.isArray(body.facilities) ? body.facilities : [],
      patient: Array.isArray(body.patients) ? body.patients : [],
      wound: Array.isArray(body.wounds) ? body.wounds : []
    };
    // ── validation ──
    for (const kind of PER_ROW_KINDS) {
      if (sets[kind].length > MAX_ROWS_PER_KIND) return res.status(413).json({ error: kind + " set too large" });
      for (const rec of sets[kind]) {
        if (!rec || typeof rec !== "object" || rec.id == null) return res.status(400).json({ error: "each " + kind + " needs an id" });
        if (JSON.stringify(rec).length > MAX_RECORD_BYTES) return res.status(413).json({ error: "a " + kind + " record is too large" });
      }
    }
    const allowEmpty = req.query.allowEmpty === "1";
    const by = req.user.name || req.user.username || "";
    try {
      const counts = await db.withTx(async (client) => {
        const c = {};
        for (const kind of PER_ROW_KINDS) {
          const rows = sets[kind];
          const ids = rows.map(r => String(r.id));
          for (const rec of rows) {
            await client.query(
              "INSERT INTO records (org_id,kind,id,data_enc,updated_at,updated_by) VALUES ($1,$2,$3,$4,now(),$5) " +
              "ON CONFLICT (org_id,kind,id) DO UPDATE SET data_enc=EXCLUDED.data_enc, updated_at=now(), updated_by=EXCLUDED.updated_by",
              [req.user.org, kind, String(rec.id), encrypt(rec), by]
            );
          }
          if (ids.length) {
            await client.query("DELETE FROM records WHERE org_id=$1 AND kind=$2 AND NOT (id = ANY($3))", [req.user.org, kind, ids]);
          } else if (allowEmpty) {
            await client.query("DELETE FROM records WHERE org_id=$1 AND kind=$2", [req.user.org, kind]);
          }
          // else: incoming empty without ?allowEmpty=1 → keep existing rows (anti-wipe safeguard)
          c[kind] = rows.length;
        }
        if (Array.isArray(body.sentlog)) {
          await client.query(
            "INSERT INTO records (org_id,kind,id,data_enc,updated_at,updated_by) VALUES ($1,'meta','sentlog',$2,now(),$3) " +
            "ON CONFLICT (org_id,kind,id) DO UPDATE SET data_enc=EXCLUDED.data_enc, updated_at=now(), updated_by=EXCLUDED.updated_by",
            [req.user.org, encrypt(body.sentlog), by]
          );
        }
        return c;
      });
      await audit(req, "snapshot.save", "f=" + counts.facility + " p=" + counts.patient + " w=" + counts.wound);
      res.json({ ok: true, saved: { facilities: counts.facility, patients: counts.patient, wounds: counts.wound } });
    } catch (e) {
      res.status(500).json({ error: "save failed" });
    }
  }));

  // ── AI draft note (optional; clinical decision support) ──
  // Inert unless an LLM provider is configured. Use a BAA-covered, OpenAI-compatible
  // endpoint (e.g. Azure OpenAI). Context arrives de-identified from the client.
  const AI_URL = process.env.AI_API_URL, AI_KEY = process.env.AI_API_KEY, AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";
  app.post("/api/ai/draft-note", authed, requireRole("Admin", "Wound Provider"), wrap(async (req, res) => {
    if (!AI_URL || !AI_KEY) return res.status(501).json({ error: "AI not configured" });
    const ctx = (req.body && req.body.context) || {};
    const sugs = Array.isArray(req.body && req.body.suggestions) ? req.body.suggestions.slice(0, 30) : [];
    const sys = "You are a wound-care documentation assistant for licensed clinicians. Write ONE concise, professional progress note (brief assessment + plan) for the wound described. Use ONLY the structured facts provided — never invent measurements, identifiers, dates, or history. Base recommendations on the provided guideline suggestions and cite the standard in parentheses. Do not include any patient identifiers. End with exactly: 'AI-drafted — clinician to verify.'";
    const user = "De-identified wound/patient context:\n" + JSON.stringify(ctx) + "\n\nGuideline suggestions:\n" + (sugs.length ? sugs.map(s => "- " + s).join("\n") : "(none)");
    try {
      const r = await fetch(AI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + AI_KEY, "api-key": AI_KEY },
        body: JSON.stringify({ model: AI_MODEL, temperature: 0.2, max_tokens: 450, messages: [{ role: "system", content: sys }, { role: "user", content: user }] })
      });
      if (!r.ok) return res.status(502).json({ error: "AI provider error" });
      const d = await r.json();
      const text = (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || "").trim();
      await audit(req, "ai.draft", "chars=" + text.length);
      res.json({ text: text });
    } catch (e) { res.status(502).json({ error: "AI request failed" }); }
  }));

  // ── audit log (admin) ──
  app.get("/api/audit", authed, requireRole("Admin"), wrap(async (req, res) => {
    const r = await db.query("SELECT username,action,detail,ip,at FROM audit_log WHERE org_id=$1 ORDER BY at DESC LIMIT 500", [req.user.org]);
    res.json(r.rows);
  }));

  app.use((err, req, res, next) => {
    if (err && /CORS/.test(err.message)) return res.status(403).json({ error: "CORS blocked" });
    if (!res.headersSent) res.status(500).json({ error: "server error" });
  });

  return app;
}

module.exports = { buildApp };
