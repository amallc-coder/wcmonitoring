# Clinilytics — Wound Care · Backend API

Self-hosted, HIPAA-aligned API + Postgres database for the Clinilytics — Wound
Care app. The static frontend (the repo's `index.html`, e.g. on GitHub Pages)
connects to this server via **Settings → Cloud sync → Connect to server**.

> The server **cannot** run on GitHub Pages. Deploy it on infrastructure you
> control (a VPS, Render, Railway, Fly.io, AWS/Azure/GCP). For real PHI you must
> host it somewhere that will sign a **Business Associate Agreement (BAA)**.

## What it provides
- **JWT auth** with bcrypt password hashing and roles (Admin / Wound Provider / Viewer).
- **PHI encrypted at rest** — every record's payload is AES-256-GCM encrypted
  *before* it reaches Postgres, so dumps, replicas, and backups never contain
  plaintext PHI without `DATA_ENCRYPTION_KEY`.
- **Append-only audit log** (logins, user changes, saves) with no PHI in the text.
- **Security middleware** — Helmet headers, locked-down CORS, login rate-limiting.
- **Snapshot sync API** the frontend uses (`GET`/`PUT /api/snapshot`).

## Redundancy (three layers)
1. **Hot-standby replica** — `db-replica` streams from the primary in real time
   (failover / read scaling).
2. **Automated logical backups** — the `backup` service runs `pg_dump` on a
   schedule with retention into `./backups`. Ship that directory offsite
   (S3/GCS) for geographic redundancy.
3. **Client mirror** — the browser keeps a full `localStorage` copy and works
   offline, re-syncing when the server returns.

## Quick start (Docker, all-in-one)
```bash
cd server
cp .env.example .env
# generate secrets:
node -e "console.log('DATA_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('JWT_SECRET='+require('crypto').randomBytes(48).toString('base64'))"
# edit .env: set DB_PASSWORD, REPL_PASSWORD, the two secrets above,
# CORS_ORIGIN (your Pages URL), and ADMIN_PASS.
docker compose up -d --build
curl localhost:8080/api/health     # {"ok":true,"db":"up",...}
```
Then in the app: **Settings → Cloud sync → Connect to server**, enter the API
URL and your admin credentials. Put a TLS-terminating reverse proxy
(Caddy/Nginx/host LB) in front so the browser reaches it over **https://**.

## Standalone (managed Postgres, no compose)
```bash
cd server && npm install
export DATABASE_URL=postgres://user:pass@host:5432/woundcare PGSSLMODE=require
export DATA_ENCRYPTION_KEY=... JWT_SECRET=... ADMIN_PASS=... CORS_ORIGIN=https://amallc-coder.github.io
npm start
```

## API
| Method | Path | Role | Purpose |
|---|---|---|---|
| GET  | `/api/health` | — | liveness + DB check |
| POST | `/api/auth/login` | — | `{username,password}` → `{token,user}` |
| GET  | `/api/auth/me` | any | current user |
| GET  | `/api/users` | Admin | list users |
| POST | `/api/users` | Admin | create user |
| DELETE | `/api/users/:username` | Admin | disable user |
| GET  | `/api/snapshot` | any | full org state (decrypted) |
| PUT  | `/api/snapshot` | Admin/Provider | replace org state (encrypted, transactional, audited) |
| POST | `/api/ai/draft-note` | Admin/Provider | draft a note from de-identified context (501 until an AI provider is configured) |
| GET  | `/api/audit` | Admin | recent audit entries |

### Optional AI draft-note (clinical decision support)
Off by default. To enable, set `AI_API_URL` + `AI_API_KEY` (+ `AI_MODEL`) to a
**BAA-covered, OpenAI-compatible** chat endpoint (e.g. Azure OpenAI). The app's
in-browser **guideline knowledge base** (deterministic, cited) works without
this; the AI only drafts the narrative note from **de-identified** context and
must be clinician-reviewed. Treat all suggestions as *decision support for a
licensed clinician*, never auto-orders (keeps it within the 21st-Century-Cures
CDS exemption rather than a regulated device).

## Restore from a backup
```bash
gunzip -c backups/woundcare_YYYYMMDDTHHMMSSZ.sql.gz | \
  docker compose exec -T db psql -U wcapp -d woundcare
```

## HIPAA notes (read before using real PHI)
Technical safeguards are implemented here (encryption at rest + in transit,
access control, audit logging, least-privilege DB role). **Compliance is
organizational, not just code.** You must also: sign a **BAA** with your host;
put the stack behind **HTTPS/TLS**; store volumes on **encrypted disks**; manage
keys in a **secrets manager/KMS** (not a plaintext `.env` in production); restrict
network/firewall access; rotate the seed admin password immediately; and keep
offsite, tested backups. This repo gives you the building blocks, not a
compliance certification.
