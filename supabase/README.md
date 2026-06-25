# Clinilytics Wound Care — Supabase backend

Server-side Supabase setup using the official **`@supabase/server`** SDK
(`withSupabase`) on **Edge Functions**, with **PHI stored server-side** in
Postgres behind **org-scoped Row-Level Security**.

## What's here
- `migrations/0001_wound_care_core_schema_rls.sql` — `orgs`, `profiles`,
  `facilities`, `patients`, `wounds`; RLS so a row is only visible/editable by
  members of the same org (Viewers read-only; Admins/Wound Providers write).
- `functions/api/` — `withSupabase({ auth: "user" })` CRUD over
  `facilities|patients|wounds` using the RLS-scoped `ctx.supabase`.
- `functions/health/` — `withSupabase({ auth: "none" })` public check.
- `config.toml` — `verify_jwt` per function.

## Environment variables (from the dashboard **Connect** dialog)
On Edge Functions these are injected automatically. For local/Node use, set:
- `SUPABASE_URL` — `https://prvzcbyeuqlstqrlbbum.supabase.co`
- `SUPABASE_PUBLISHABLE_KEY` — safe for clients
- `SUPABASE_SECRET_KEY` — **server-only; never commit**
- `SUPABASE_JWKS_URL` — `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` (verifies user JWTs)

## Deploy
```bash
# one-time
supabase link --project-ref prvzcbyeuqlstqrlbbum

# database schema + RLS
supabase db push

# edge functions
supabase functions deploy api
supabase functions deploy ai
supabase functions deploy health
supabase functions deploy email-cron
```
(Or apply migrations through the Supabase MCP `apply_migration` tool.)

## Secrets (Edge Function env)
```bash
# Shared Claude key — AI for every signed-in user, server-side (never in browsers)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   ANTHROPIC_MODEL=claude-opus-4-8

# SMTP for scheduled/triggered email
supabase secrets set SMTP_HOST=smtp.provider.com SMTP_PORT=587 SMTP_SECURE=false \
  SMTP_USER=apikey SMTP_PASS=*** SMTP_FROM=woundcare@yourfacility.com SMTP_FROM_NAME="Clinilytics Wound Care"
```

## Email automation scheduler (pg_cron)
After deploying `email-cron`, create the Vault secrets and schedule it (one-time, in the SQL Editor):
```sql
select vault.create_secret('https://prvzcbyeuqlstqrlbbum.supabase.co','project_url');
select vault.create_secret('<service_role_key>','service_role_key');
select cron.schedule('email-cron','* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='project_url') || '/functions/v1/email-cron',
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='service_role_key')),
    body := '{}'::jsonb);
$$);
```
Rules live in `email_rules` (admin-managed, RLS); deliveries are logged to `email_log`.

## First org + admin
RLS keys off `profiles`. After a user signs up via Supabase Auth, link them:
```sql
insert into public.orgs (name) values ('Clinilytics') returning id; -- note the id
insert into public.profiles (id, org_id, role, full_name)
values ('<auth-user-uuid>', '<org-id>', 'Admin', 'Administrator');
```
New rows then auto-stamp `org_id` from the caller's profile (insert triggers).

## Call it
```bash
# user-scoped (needs a Supabase auth access token)
curl -H "Authorization: Bearer $USER_JWT" \
  https://prvzcbyeuqlstqrlbbum.supabase.co/functions/v1/api/wounds

# public health
curl https://prvzcbyeuqlstqrlbbum.supabase.co/functions/v1/health
```

## PHI / HIPAA
PHI lives in Supabase Postgres (server-side), protected by RLS + TLS + Supabase's
at-rest encryption. **Sign a Supabase BAA (paid plan) before storing real patient
data.** RLS is the access boundary — keep the **secret key** server-only; never
ship it to the browser (clients use the publishable key + the user's JWT).
