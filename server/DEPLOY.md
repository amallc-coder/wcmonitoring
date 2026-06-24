# Deploying the Clinilytics — Wound Care backend

Two supported paths. **Path A** (a single VPS with Docker) runs the full
redundancy stack I built — primary + hot-standby replica + scheduled backups —
and is the literal "self-host everything" option. **Path B** (Render) is the
lowest-ops option and leans on a managed Postgres for redundancy/backups.

Either way, the static app connects via **Settings → Cloud sync → Connect to
server** using your API's `https://` URL and an admin login. Always serve the
API over **HTTPS**.

---

## Path A — Single VPS (DigitalOcean / Hetzner / EC2), full stack

Best when you want the replica + backup sidecar in one place. ~$6–12/mo droplet.

### 1. Create the server
- DigitalOcean: create a Droplet (Ubuntu 24.04, 2 GB RAM is plenty). Note its IP.
- Point a DNS A-record (e.g. `api.yourdomain.com`) at the IP.

### 2. Install Docker
```bash
ssh root@YOUR_IP
curl -fsSL https://get.docker.com | sh
```

### 3. Get the code + configure
```bash
git clone https://github.com/amallc-coder/wcmonitoring.git
cd wcmonitoring/server
cp .env.example .env
# generate the two secrets:
node -e "console.log('DATA_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('base64'))" 2>/dev/null || \
  docker run --rm node:20-alpine node -e "console.log('DATA_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('base64'))"
docker run --rm node:20-alpine node -e "console.log('JWT_SECRET='+require('crypto').randomBytes(48).toString('base64'))"
nano .env   # set DB_PASSWORD, REPL_PASSWORD, the two secrets, CORS_ORIGIN, ADMIN_PASS
```
Set `CORS_ORIGIN=https://amallc-coder.github.io` (your Pages site).

### 4. Bring up the stack
```bash
docker compose up -d --build
docker compose ps                 # db, db-replica, backup, api all "Up"
curl localhost:8080/api/health    # {"ok":true,"db":"up",...}
docker compose logs db-replica | grep -i "standby"   # replica caught up
ls backups/                       # first dump appears within BACKUP_INTERVAL
```

### 5. Put HTTPS in front (bundled Caddy — automatic certificates + HSTS)
The stack ships a hardened TLS proxy (`server/proxy/Caddyfile`) as an opt-in
profile. Set `DOMAIN` + `ACME_EMAIL` in `.env`, point the domain's DNS at the
server, open ports 80/443, then:
```bash
docker compose --profile proxy up -d
```
Caddy obtains/renews Let's Encrypt certs automatically and adds HSTS + security
headers; the API itself is bound to localhost (not public). The API is now at
`https://api.yourdomain.com` — connect from the app's Settings.
(Prefer Nginx? Use `server/proxy/nginx.conf` with certbot instead.)

### 5a. (Recommended) Keep keys out of plaintext env
Instead of `DATA_ENCRYPTION_KEY`/`JWT_SECRET` in `.env`, mount them as secret
files (`DATA_ENCRYPTION_KEY_FILE`, `JWT_SECRET_FILE`) or use **AWS KMS**: set
`KMS_DATA_KEY_CIPHERTEXT` + `KMS_KEY_ID` and `npm i @aws-sdk/client-kms` — the
server decrypts the data key via KMS at boot. See `.env.example`.

### 6. Verify failover & restore (do this once)
- **Replica:** `docker compose stop db` then read from `db-replica` — data is intact.
- **Restore a backup:**
  ```bash
  gunzip -c backups/woundcare_*.sql.gz | docker compose exec -T db psql -U wcapp -d woundcare
  ```
- **Offsite:** sync `backups/` to object storage, e.g. nightly:
  `aws s3 sync ./backups s3://your-bucket/woundcare-backups/`

---

## Path B — Render (managed Postgres, least ops)

Render runs single services, so use **Render's managed Postgres** (it provides
daily backups + high availability on paid plans) and deploy just the API.

1. **Create Postgres:** Render → New → Postgres. Copy its **Internal Database URL**.
2. **Create the API:** New → Web Service → connect this GitHub repo →
   - Root directory: `server`
   - Runtime: **Docker** (uses `server/Dockerfile`)
   - Environment variables:
     - `DATABASE_URL` = the Render internal URL
     - `PGSSLMODE` = `require`
     - `DATA_ENCRYPTION_KEY`, `JWT_SECRET` = generated secrets
     - `CORS_ORIGIN` = `https://amallc-coder.github.io`
     - `ADMIN_USER`, `ADMIN_PASS`, `ADMIN_NAME`, `ORG_NAME`
3. Deploy. Render gives you `https://your-api.onrender.com` (TLS already on).
4. `GET /api/health` should return `{"ok":true}`. Connect from the app's Settings.

> On Render the replica/backup sidecars from `docker-compose.yml` aren't used —
> redundancy is the managed Postgres' backups/HA. Enable PITR / a standby on the
> Render database plan for stronger durability.

Railway and Fly.io follow the same shape (Docker web service + managed Postgres).

---

## Using the prebuilt image (optional)

The GitHub Action publishes an image to
`ghcr.io/amallc-coder/wcmonitoring-api:latest` on every push to `main` that
touches `server/`. To run it instead of building locally, replace the `api`
service's `build: .` with `image: ghcr.io/amallc-coder/wcmonitoring-api:latest`.

## HIPAA reminder
For real PHI: sign a **BAA** with your host, keep keys in a secrets manager (not
a plaintext `.env`), use encrypted volumes, restrict the firewall to the proxy,
rotate the seed admin password immediately, and test restores regularly.
