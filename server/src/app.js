"use strict";
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const db = require("./db");
const { encrypt, decrypt } = require("./crypto");
const { hashPassword, verifyPassword, signToken, authRequired, requireRole } = require("./auth");

const PER_ROW_KINDS = ["facility", "patient", "wound"];

function buildApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());

  const origins = (process.env.CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  app.use(cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);            // curl / same-origin / mobile webview
      if (origins.length === 0 || origins.indexOf(origin) >= 0) return cb(null, true);
      return cb(new Error("CORS: origin not allowed"));
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"]
  }));
  app.use(express.json({ limit: process.env.BODY_LIMIT || "30mb" }));

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

  async function audit(req, action, detail) {
    try {
      await db.query(
        "INSERT INTO audit_log (org_id, user_id, username, action, detail, ip) VALUES ($1,$2,$3,$4,$5,$6)",
        [req.user ? req.user.org : null, req.user ? req.user.sub : null, req.user ? req.user.username : null,
         action, detail || null, (req.headers["x-forwarded-for"] || req.ip || "").toString().split(",")[0].trim()]
      );
    } catch (e) { /* audit must never break the request */ }
  }

  // ── health (no auth) ──
  app.get("/api/health", async (req, res) => {
    try { await db.query("SELECT 1"); res.json({ ok: true, db: "up", time: new Date().toISOString() }); }
    catch (e) { res.status(503).json({ ok: false, db: "down" }); }
  });

  // ── auth ──
  app.post("/api/auth/login", authLimiter, async (req, res) => {
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
  });

  app.get("/api/auth/me", authRequired, (req, res) => {
    res.json({ username: req.user.username, name: req.user.name, role: req.user.role });
  });

  // ── users (admin) ──
  app.get("/api/users", authRequired, requireRole("Admin"), async (req, res) => {
    const r = await db.query("SELECT username,name,role,active,last_login,created_at FROM users WHERE org_id=$1 ORDER BY username", [req.user.org]);
    res.json(r.rows);
  });
  app.post("/api/users", authRequired, requireRole("Admin"), async (req, res) => {
    const { username, name, role, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username & password required" });
    const ok = ["Admin", "Wound Provider", "Viewer"].indexOf(role) >= 0 ? role : "Wound Provider";
    try {
      await db.query("INSERT INTO users (org_id,username,name,role,pass_hash) VALUES ($1,$2,$3,$4,$5)",
        [req.user.org, username.toLowerCase(), name || username, ok, await hashPassword(password)]);
      await audit(req, "user.create", username);
      res.json({ ok: true });
    } catch (e) { res.status(409).json({ error: "Username already exists" }); }
  });
  app.delete("/api/users/:username", authRequired, requireRole("Admin"), async (req, res) => {
    if (req.params.username.toLowerCase() === (req.user.username || "").toLowerCase())
      return res.status(400).json({ error: "Cannot remove yourself" });
    await db.query("UPDATE users SET active=false WHERE org_id=$1 AND lower(username)=lower($2)", [req.user.org, req.params.username]);
    await audit(req, "user.disable", req.params.username);
    res.json({ ok: true });
  });

  // ── snapshot: full org state (encrypted at rest) ──
  app.get("/api/snapshot", authRequired, async (req, res) => {
    const out = { facilities: [], patients: [], wounds: [], sentlog: [] };
    const r = await db.query("SELECT kind,id,data_enc FROM records WHERE org_id=$1", [req.user.org]);
    for (const row of r.rows) {
      const data = decrypt(row.data_enc);
      if (row.kind === "facility") out.facilities.push(data);
      else if (row.kind === "patient") out.patients.push(data);
      else if (row.kind === "wound") out.wounds.push(data);
      else if (row.kind === "meta" && row.id === "sentlog") out.sentlog = Array.isArray(data) ? data : [];
    }
    res.json(out);
  });

  app.put("/api/snapshot", authRequired, requireRole("Admin", "Wound Provider"), async (req, res) => {
    const body = req.body || {};
    const sets = {
      facility: Array.isArray(body.facilities) ? body.facilities : [],
      patient: Array.isArray(body.patients) ? body.patients : [],
      wound: Array.isArray(body.wounds) ? body.wounds : []
    };
    const by = req.user.name || req.user.username || "";
    try {
      await db.withTx(async (client) => {
        for (const kind of PER_ROW_KINDS) {
          const rows = sets[kind];
          const ids = rows.map(r => String(r && r.id)).filter(Boolean);
          // upsert
          for (const rec of rows) {
            if (!rec || rec.id == null) continue;
            await client.query(
              "INSERT INTO records (org_id,kind,id,data_enc,updated_at,updated_by) VALUES ($1,$2,$3,$4,now(),$5) " +
              "ON CONFLICT (org_id,kind,id) DO UPDATE SET data_enc=EXCLUDED.data_enc, updated_at=now(), updated_by=EXCLUDED.updated_by",
              [req.user.org, kind, String(rec.id), encrypt(rec), by]
            );
          }
          // delete rows no longer present
          if (ids.length) {
            await client.query(
              "DELETE FROM records WHERE org_id=$1 AND kind=$2 AND NOT (id = ANY($3))",
              [req.user.org, kind, ids]
            );
          } else {
            await client.query("DELETE FROM records WHERE org_id=$1 AND kind=$2", [req.user.org, kind]);
          }
        }
        // sentlog as a single meta record
        const sl = Array.isArray(body.sentlog) ? body.sentlog : [];
        await client.query(
          "INSERT INTO records (org_id,kind,id,data_enc,updated_at,updated_by) VALUES ($1,'meta','sentlog',$2,now(),$3) " +
          "ON CONFLICT (org_id,kind,id) DO UPDATE SET data_enc=EXCLUDED.data_enc, updated_at=now(), updated_by=EXCLUDED.updated_by",
          [req.user.org, encrypt(sl), by]
        );
      });
      await audit(req, "snapshot.save",
        "f=" + sets.facility.length + " p=" + sets.patient.length + " w=" + sets.wound.length);
      res.json({ ok: true, saved: { facilities: sets.facility.length, patients: sets.patient.length, wounds: sets.wound.length } });
    } catch (e) {
      res.status(500).json({ error: "save failed" });
    }
  });

  // ── audit log (admin) ──
  app.get("/api/audit", authRequired, requireRole("Admin"), async (req, res) => {
    const r = await db.query("SELECT username,action,detail,ip,at FROM audit_log WHERE org_id=$1 ORDER BY at DESC LIMIT 500", [req.user.org]);
    res.json(r.rows);
  });

  app.use((err, req, res, next) => {
    if (err && /CORS/.test(err.message)) return res.status(403).json({ error: "CORS blocked" });
    res.status(500).json({ error: "server error" });
  });

  return app;
}

module.exports = { buildApp };
