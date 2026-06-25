-- Clinilytics — Wound Care · schema
-- PHI payloads are stored encrypted (see crypto.js); the DB never holds plaintext.

CREATE TABLE IF NOT EXISTS orgs (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  username    TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'Wound Provider', -- Admin | Wound Provider | Viewer
  pass_hash   TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT true,
  last_login  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, username)
);

-- Generic encrypted record store. kind: facility | patient | wound | meta
CREATE TABLE IF NOT EXISTS records (
  org_id      BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  id          TEXT NOT NULL,
  data_enc    TEXT NOT NULL,             -- AES-256-GCM ciphertext (base64)
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT,
  PRIMARY KEY (org_id, kind, id)
);
CREATE INDEX IF NOT EXISTS records_org_kind_idx ON records (org_id, kind);

-- ── Email & automation ──
-- SMTP config per org (encrypted; holds the SMTP password). One row per org.
CREATE TABLE IF NOT EXISTS email_settings (
  org_id      BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  config_enc  TEXT NOT NULL,             -- AES-256-GCM { host, port, secure, user, pass, from, fromName }
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

-- Automation rules: scheduled reports + condition-triggered digests.
CREATE TABLE IF NOT EXISTS email_rules (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  config_enc  TEXT NOT NULL,             -- AES-256-GCM { mode, report, recipients[], cc[], format, filters{}, schedule{}, trigger{} }
  last_run    TIMESTAMPTZ,
  next_run    TIMESTAMPTZ,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_rules_org_idx ON email_rules (org_id, enabled);

-- Delivery log (no PHI; subjects/recipients only).
CREATE TABLE IF NOT EXISTS email_log (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT,
  rule_id     BIGINT,
  to_addrs    TEXT,
  subject     TEXT,
  status      TEXT,                       -- sent | error | skipped
  detail      TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_log_org_at_idx ON email_log (org_id, at DESC);

-- Org-wide AI (Claude) key, set by an admin in-app and stored encrypted. When
-- present, all signed-in users get AI through the server (key never reaches browsers).
CREATE TABLE IF NOT EXISTS ai_settings (
  org_id      BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  key_enc     TEXT,                       -- AES-256-GCM Anthropic API key
  model       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

-- Append-only audit trail (no PHI in the action text).
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT,
  user_id     BIGINT,
  username    TEXT,
  action      TEXT NOT NULL,
  detail      TEXT,
  ip          TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_org_at_idx ON audit_log (org_id, at DESC);
