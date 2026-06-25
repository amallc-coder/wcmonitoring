"use strict";
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const db = require("./db");
const anthropic = require("./anthropic");
const mailer = require("./mailer");
const reports = require("./reports");
const scheduler = require("./scheduler");
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

  // Org-wide Claude key (admin-set, encrypted at rest). Returned to the server's AI calls only — never to the browser.
  async function orgAIKey(orgId) {
    try {
      const r = await db.query("SELECT key_enc,model FROM ai_settings WHERE org_id=$1", [orgId]);
      if (!r.rows[0] || !r.rows[0].key_enc) return null;
      return { apiKey: decrypt(r.rows[0].key_enc), aiModel: r.rows[0].model || undefined };
    } catch (e) { return null; }
  }
  async function aiReady(orgId) { return anthropic.configured() || !!(await orgAIKey(orgId)); }

  // Admin: view (masked) / set / clear the shared Claude key.
  app.get("/api/ai/key", authed, requireRole("Admin"), wrap(async (req, res) => {
    const r = await db.query("SELECT key_enc,model FROM ai_settings WHERE org_id=$1", [req.user.org]);
    const hasOrg = !!(r.rows[0] && r.rows[0].key_enc);
    res.json({ hasKey: hasOrg, model: (r.rows[0] && r.rows[0].model) || "claude-opus-4-8", envConfigured: anthropic.configured(), source: hasOrg ? "org" : (anthropic.configured() ? "env" : "none") });
  }));
  app.put("/api/ai/key", authed, requireRole("Admin"), wrap(async (req, res) => {
    const key = String((req.body && req.body.apiKey) || "").trim();
    const mdl = String((req.body && req.body.model) || "").trim() || "claude-opus-4-8";
    if (!key || !/^sk-ant-/.test(key)) return res.status(400).json({ error: "A valid Anthropic API key (sk-ant-…) is required" });
    await db.query(
      "INSERT INTO ai_settings (org_id,key_enc,model,updated_at,updated_by) VALUES ($1,$2,$3,now(),$4) " +
      "ON CONFLICT (org_id) DO UPDATE SET key_enc=EXCLUDED.key_enc, model=EXCLUDED.model, updated_at=now(), updated_by=EXCLUDED.updated_by",
      [req.user.org, encrypt(key), mdl, req.user.username]
    );
    await audit(req, "ai.key.set", null);
    res.json({ ok: true });
  }));
  app.delete("/api/ai/key", authed, requireRole("Admin"), wrap(async (req, res) => {
    await db.query("DELETE FROM ai_settings WHERE org_id=$1", [req.user.org]);
    await audit(req, "ai.key.clear", null);
    res.json({ ok: true });
  }));
  app.post("/api/ai/draft-note", authed, requireRole("Admin", "Wound Provider"), wrap(async (req, res) => {
    const ctx = (req.body && req.body.context) || {};
    const sugs = Array.isArray(req.body && req.body.suggestions) ? req.body.suggestions.slice(0, 30) : [];
    // Prefer Claude when configured (env or org key); else fall back to an OpenAI-compatible endpoint.
    const ok = await orgAIKey(req.user.org);
    if (anthropic.configured() || ok) {
      try {
        const text = await anthropic.draftNote({ context: ctx, suggestions: sugs, apiKey: ok && ok.apiKey, aiModel: ok && ok.aiModel });
        await audit(req, "ai.draft", "claude chars=" + text.length);
        return res.json({ text: text });
      } catch (e) { return res.status(502).json({ error: "AI request failed" }); }
    }
    if (!AI_URL || !AI_KEY) return res.status(501).json({ error: "AI not configured" });
    const sys = "You are a wound-care documentation assistant for licensed clinicians. Write ONE concise progress note (assessment + plan). Use ONLY provided facts; never invent measurements/identifiers/history; cite guidelines in parentheses; no identifiers. End with: 'AI-drafted — clinician to verify.'";
    const user = "De-identified context:\n" + JSON.stringify(ctx) + "\n\nGuideline suggestions:\n" + (sugs.length ? sugs.map(s => "- " + s).join("\n") : "(none)");
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

  // ── AI wound-photo analysis (Claude vision) ──
  app.post("/api/ai/analyze-wound", authed, requireRole("Admin", "Wound Provider"), wrap(async (req, res) => {
    const ok = await orgAIKey(req.user.org);
    if (!anthropic.configured() && !ok) return res.status(501).json({ error: "Claude not configured" });
    const body = req.body || {};
    const image = typeof body.image === "string" ? body.image : "";
    const prevImage = typeof body.prevImage === "string" ? body.prevImage : "";
    if ((image && image.length > 9 * 1024 * 1024) || (prevImage && prevImage.length > 9 * 1024 * 1024))
      return res.status(413).json({ error: "image too large" });
    try {
      const analysis = await anthropic.analyzeWound({
        context: body.context || {},
        suggestions: Array.isArray(body.suggestions) ? body.suggestions.slice(0, 30) : [],
        image: image || null,
        mime: body.mime || "image/jpeg",
        prevImage: prevImage || null,
        prevMime: body.prevMime || "image/jpeg",
        apiKey: ok && ok.apiKey, aiModel: ok && ok.aiModel
      });
      await audit(req, "ai.analyze", "img=" + (image ? "y" : "n") + (prevImage ? " compare" : ""));
      res.json({ analysis: analysis });
    } catch (e) { res.status(502).json({ error: "AI analysis failed" }); }
  }));

  // ── AI billing self-audit (Claude) ──
  app.post("/api/ai/audit-note", authed, requireRole("Admin", "Wound Provider"), wrap(async (req, res) => {
    const ok = await orgAIKey(req.user.org);
    if (!anthropic.configured() && !ok) return res.status(501).json({ error: "Claude not configured" });
    const body = req.body || {};
    try {
      const a = await anthropic.auditNote({
        note: typeof body.note === "string" ? body.note.slice(0, 12000) : "",
        codes: Array.isArray(body.codes) ? body.codes.slice(0, 60) : [],
        context: body.context || {},
        apiKey: ok && ok.apiKey, aiModel: ok && ok.aiModel
      });
      await audit(req, "ai.audit-note", null);
      res.json({ audit: a });
    } catch (e) { res.status(502).json({ error: "AI audit failed" }); }
  }));

  // ── Email & automation (admin) ──
  function cleanEmails(v) {
    const arr = Array.isArray(v) ? v : String(v || "").split(/[,;\s]+/);
    return arr.map(s => String(s).trim()).filter(s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)).slice(0, 50);
  }

  app.get("/api/email/settings", authed, requireRole("Admin"), wrap(async (req, res) => {
    const c = await mailer.getSettings(req.user.org);
    if (!c) return res.json({ configured: false });
    res.json({ configured: true, host: c.host || "", port: c.port || 587, secure: !!c.secure, user: c.user || "", from: c.from || "", fromName: c.fromName || "", hasPass: !!c.pass });
  }));

  app.put("/api/email/settings", authed, requireRole("Admin"), wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.host || !b.from) return res.status(400).json({ error: "host and from address are required" });
    const existing = await mailer.getSettings(req.user.org) || {};
    const cfg = {
      host: String(b.host).trim(),
      port: parseInt(b.port, 10) || 587,
      secure: b.secure === true || b.secure === "true",
      user: String(b.user || "").trim(),
      // keep the saved password when the field is left blank (so it isn't wiped on edit)
      pass: (b.pass != null && b.pass !== "") ? String(b.pass) : (existing.pass || ""),
      from: String(b.from).trim(),
      fromName: String(b.fromName || "").trim()
    };
    await mailer.saveSettings(req.user.org, cfg, req.user.username);
    await audit(req, "email.settings.save", cfg.host);
    res.json({ ok: true });
  }));

  app.post("/api/email/test", authed, requireRole("Admin"), wrap(async (req, res) => {
    const to = cleanEmails((req.body && req.body.to) || req.user.username);
    if (!to.length) return res.status(400).json({ error: "a valid recipient is required" });
    const cfg = await mailer.getSettings(req.user.org);
    if (!mailer.configured(cfg)) return res.status(400).json({ error: "Save SMTP settings first" });
    try { await mailer.sendTest(cfg, to); await audit(req, "email.test", to.join(",")); res.json({ ok: true }); }
    catch (e) { res.status(502).json({ error: "Send failed: " + ((e && e.message) || "SMTP error") }); }
  }));

  app.get("/api/email/reports", authed, requireRole("Admin"), (req, res) => res.json({ types: reports.REPORT_TYPES }));

  app.get("/api/email/rules", authed, requireRole("Admin"), wrap(async (req, res) => {
    const r = await db.query("SELECT id,name,enabled,config_enc,last_run,next_run FROM email_rules WHERE org_id=$1 ORDER BY id", [req.user.org]);
    const out = r.rows.map(row => {
      let cfg = {}; try { cfg = decrypt(row.config_enc) || {}; } catch (e) {}
      return { id: row.id, name: row.name, enabled: row.enabled, last_run: row.last_run, next_run: row.next_run, config: cfg };
    });
    res.json(out);
  }));

  function ruleConfigFromBody(b) {
    return {
      mode: b.mode === "trigger" ? "trigger" : "schedule",
      report: String(b.report || "weekly-wound"),
      recipients: cleanEmails(b.recipients),
      cc: cleanEmails(b.cc),
      format: ["html+csv", "html", "csv"].indexOf(b.format) >= 0 ? b.format : "html+csv",
      skipIfEmpty: b.skipIfEmpty !== false,
      filters: { facility: String((b.filters && b.filters.facility) || "").trim(), provider: String((b.filters && b.filters.provider) || "").trim() },
      schedule: { freq: String((b.schedule && b.schedule.freq) || "weekly"), dow: (b.schedule && b.schedule.dow), dom: (b.schedule && b.schedule.dom), hour: (b.schedule && b.schedule.hour), minute: (b.schedule && b.schedule.minute) },
      trigger: { report: String((b.trigger && b.trigger.report) || b.report || "stale-wounds"), cooldownHours: (b.trigger && b.trigger.cooldownHours) || 24 }
    };
  }

  app.post("/api/email/rules", authed, requireRole("Admin"), wrap(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || "").trim();
    if (!name) return res.status(400).json({ error: "rule name required" });
    const cfg = ruleConfigFromBody(b);
    if (!cfg.recipients.length) return res.status(400).json({ error: "at least one valid recipient is required" });
    const enabled = b.enabled !== false;
    const next = scheduler.computeNextRun(cfg, new Date());
    if (b.id) {
      const r = await db.query("UPDATE email_rules SET name=$1,enabled=$2,config_enc=$3,next_run=$4 WHERE id=$5 AND org_id=$6 RETURNING id",
        [name, enabled, encrypt(cfg), next, b.id, req.user.org]);
      if (!r.rows[0]) return res.status(404).json({ error: "rule not found" });
      await audit(req, "email.rule.update", name);
      return res.json({ ok: true, id: r.rows[0].id });
    }
    const r = await db.query("INSERT INTO email_rules (org_id,name,enabled,config_enc,next_run,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [req.user.org, name, enabled, encrypt(cfg), next, req.user.username]);
    await audit(req, "email.rule.create", name);
    res.json({ ok: true, id: r.rows[0].id });
  }));

  app.delete("/api/email/rules/:id", authed, requireRole("Admin"), wrap(async (req, res) => {
    await db.query("DELETE FROM email_rules WHERE id=$1 AND org_id=$2", [req.params.id, req.user.org]);
    await audit(req, "email.rule.delete", req.params.id);
    res.json({ ok: true });
  }));

  app.post("/api/email/rules/:id/run", authed, requireRole("Admin"), wrap(async (req, res) => {
    const status = await scheduler.runRuleNow(req.params.id, req.user.org);
    await audit(req, "email.rule.run", req.params.id + ":" + status);
    if (status === "not-found") return res.status(404).json({ error: "rule not found" });
    res.json({ ok: status === "sent", status: status });
  }));

  app.get("/api/email/log", authed, requireRole("Admin"), wrap(async (req, res) => {
    const r = await db.query("SELECT rule_id,to_addrs,subject,status,detail,at FROM email_log WHERE org_id=$1 ORDER BY at DESC LIMIT 200", [req.user.org]);
    res.json(r.rows);
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
