"use strict";
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fs = require("fs");

const SECRET = process.env.JWT_SECRET ||
  (process.env.JWT_SECRET_FILE ? fs.readFileSync(process.env.JWT_SECRET_FILE, "utf8").trim() : "");
const TTL_HOURS = parseInt(process.env.JWT_TTL_HOURS || "8", 10);

if (!SECRET) {
  console.error("FATAL: JWT_SECRET is required");
  process.exit(1);
}

function hashPassword(pw) { return bcrypt.hash(pw, 12); }
function verifyPassword(pw, hash) { return bcrypt.compare(pw, hash); }

function signToken(user) {
  return jwt.sign(
    { sub: user.id, org: user.org_id, role: user.role, username: user.username, name: user.name },
    SECRET,
    { expiresIn: TTL_HOURS + "h" }
  );
}

function authRequired(req, res, next) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = jwt.verify(m[1], SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireRole() {
  const roles = Array.prototype.slice.call(arguments);
  return function (req, res, next) {
    if (!req.user || roles.indexOf(req.user.role) < 0) {
      return res.status(403).json({ error: "Insufficient role" });
    }
    next();
  };
}

module.exports = { hashPassword, verifyPassword, signToken, authRequired, requireRole };
