# Security posture

This documents the technical safeguards implemented and the residual items that
remain an operator/organizational responsibility. It is **not** a compliance
certification.

## Implemented

### Backend (`server/`)
- **Parameterized SQL** everywhere (no string-built queries) → no SQL injection.
- **PHI encrypted at rest** — AES-256-GCM (random IV per record) before any write,
  so DB dumps, the replica, and backups contain ciphertext only.
- **bcrypt** (cost 12) password hashing; **JWT** sessions (default 8h TTL).
- **Per-request account check** (`ensureActive`) → disabling a user (or a token
  issued before disable) is honored immediately, not at token expiry.
- **CORS fails closed** — only the explicit `CORS_ORIGIN` allow-list is accepted
  for browser origins.
- **Async error wrapper** on every route → a DB error or bad record returns 500
  instead of hanging the request; a single corrupt record is skipped, not fatal.
- **Password policy** (≥10 chars, letters+numbers) on user creation.
- **Rate limiting** — strict on `/auth`, plus a global authenticated cap.
- **Snapshot safeguards** — payload validation, per-record + per-collection size
  caps, and an **anti-wipe guard** (an empty collection won't delete existing
  rows unless `?allowEmpty=1`).
- **Append-only audit log** (logins, user changes, saves; no PHI in text).
- **Helmet** security headers; least-privilege DB role; `scram-sha-256` replica auth.

### Frontend (`index.html`)
- **Stored-XSS hardening** — all data is HTML-neutralized at every render entry
  point before reaching any `innerHTML` sink.
- **Content-Security-Policy** — blocks external script loading, locks
  `object-src`/`base-uri`; pinned CDN/font origins.
- **Auth token kept in `sessionStorage` only** (not persisted to disk).
- **Service worker never caches `/api/` responses** (no PHI in Cache Storage).
- **Upload limits** — image-only, 4 MB cap on wound photos.

### Supply chain / CI
- Committed **`package-lock.json`** + `npm ci` for reproducible builds.
- **Dependabot** (npm + actions) and a **`npm audit`** workflow (fails on high/critical).

## Residual — operator / organizational responsibility
- **HIPAA compliance is organizational.** Sign a **BAA** with your host; this code
  is a building block, not a certification.
- **TLS/HTTPS** must be terminated in front of the API (Caddy/Nginx/LB) + HSTS.
- **Key management** — keep `DATA_ENCRYPTION_KEY`/`JWT_SECRET` in a secrets
  manager/KMS, not a plaintext `.env`; plan key rotation.
- **Encrypted disks** for DB + backup volumes; ship backups offsite (S3/GCS).
- **Rotate the seed admin password** immediately; consider MFA for Admins.
- **The static (local-only) app has no real auth** — treat it as public until
  connected to the backend.
- Whole-snapshot sync is **last-writer-wins**; true per-field concurrent merge is
  a future enhancement.
- Weekly reports sent via `mailto:` traverse the user's email — prefer a secure
  portal/server-sent delivery for PHI.

## Reporting
Open a private security advisory on the repository for any vulnerability.
