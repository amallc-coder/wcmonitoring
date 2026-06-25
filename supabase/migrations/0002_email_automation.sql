-- Email automation on Supabase: rules + delivery log (org-scoped, admin-managed).
-- SMTP credentials and the report timezone are NOT stored here — they live as Edge
-- Function secrets (SMTP_HOST/PORT/SECURE/USER/PASS/FROM/FROM_NAME). The email-cron
-- Edge Function reads these tables with the service role and sends mail.

create table if not exists public.email_rules (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  name       text not null,
  enabled    boolean not null default true,
  config     jsonb not null default '{}'::jsonb,  -- { mode, report, recipients[], cc[], format, filters{}, schedule{}, trigger{}, skipIfEmpty }
  last_run   timestamptz,
  next_run   timestamptz,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists email_rules_org_idx on public.email_rules(org_id, enabled);
create index if not exists email_rules_due_idx on public.email_rules(next_run) where enabled;

create table if not exists public.email_log (
  id        uuid primary key default gen_random_uuid(),
  org_id    uuid references public.orgs(id) on delete cascade,
  rule_id   uuid,
  to_addrs  text,
  subject   text,
  status    text,            -- sent | error | skipped
  detail    text,
  at        timestamptz not null default now()
);
create index if not exists email_log_org_at_idx on public.email_log(org_id, at desc);

alter table public.email_rules enable row level security;
alter table public.email_log   enable row level security;

-- Admins manage their org's rules; staff can read them.
create policy email_rules_read on public.email_rules
  for select using (org_id = private.current_org_id());
create policy email_rules_admin_write on public.email_rules
  for all using (org_id = private.current_org_id() and private.current_user_role() = 'Admin')
  with check (org_id = private.current_org_id() and private.current_user_role() = 'Admin');

create policy email_log_admin_read on public.email_log
  for select using (org_id = private.current_org_id() and private.current_user_role() = 'Admin');
-- (writes happen only via the service role inside the email-cron function, which bypasses RLS)

-- Scheduling: pg_cron pings the email-cron Edge Function every minute; the function
-- decides which rules are due. Requires the pg_cron + pg_net extensions and two
-- Vault secrets (project URL + service role key) created via the dashboard:
--   select vault.create_secret('https://<ref>.supabase.co','project_url');
--   select vault.create_secret('<service_role_key>','service_role_key');
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- (Run once after deploying the function and creating the Vault secrets above)
-- select cron.schedule('email-cron','* * * * *', $$
--   select net.http_post(
--     url := (select decrypted_secret from vault.decrypted_secrets where name='project_url') || '/functions/v1/email-cron',
--     headers := jsonb_build_object(
--       'Content-Type','application/json',
--       'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='service_role_key')
--     ),
--     body := '{}'::jsonb
--   );
-- $$);
