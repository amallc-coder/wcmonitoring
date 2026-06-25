-- Clinilytics Wound Care — core schema with org-scoped Row-Level Security.
-- PHI lives server-side in Supabase; every row is gated to members of the same org.
-- RLS helper functions live in a PRIVATE schema (not exposed by PostgREST), so they
-- are never callable as public RPC. Apply with `supabase db push` or the SQL Editor.

create extension if not exists pgcrypto;
create schema if not exists private;

create table if not exists public.orgs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

-- Links a Supabase auth user to an org + role.
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  org_id     uuid references public.orgs(id) on delete set null,
  role       text not null default 'Wound Provider' check (role in ('Admin','Wound Provider','Viewer')),
  full_name  text,
  created_at timestamptz not null default now()
);

-- Caller helpers (SECURITY DEFINER avoids RLS recursion; kept out of the public API).
create or replace function private.current_org_id()
  returns uuid language sql stable security definer set search_path = public as $$
  select org_id from public.profiles where id = auth.uid()
$$;
create or replace function private.current_user_role()
  returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;
create or replace function private.set_org_id()
  returns trigger language plpgsql security definer set search_path = public as $$
  begin
    if new.org_id is null then new.org_id := private.current_org_id(); end if;
    new.updated_at := now();
    return new;
  end $$;

grant usage on schema private to authenticated;
grant execute on function private.current_org_id()   to authenticated;
grant execute on function private.current_user_role() to authenticated;

create table if not exists public.facilities (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  name       text not null,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists facilities_org_idx on public.facilities(org_id);

create table if not exists public.patients (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  facility_id uuid references public.facilities(id) on delete set null,
  name        text not null,
  dob         text,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists patients_org_idx on public.patients(org_id);

create table if not exists public.wounds (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  patient_id uuid references public.patients(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wounds_org_idx on public.wounds(org_id);
create index if not exists wounds_patient_idx on public.wounds(patient_id);

create trigger facilities_set_org before insert on public.facilities for each row execute function private.set_org_id();
create trigger patients_set_org   before insert on public.patients   for each row execute function private.set_org_id();
create trigger wounds_set_org     before insert on public.wounds     for each row execute function private.set_org_id();

-- ── Row-Level Security ──
alter table public.orgs       enable row level security;
alter table public.profiles   enable row level security;
alter table public.facilities enable row level security;
alter table public.patients   enable row level security;
alter table public.wounds     enable row level security;

create policy orgs_member_read on public.orgs
  for select using (id = private.current_org_id());

create policy profiles_self_or_org_read on public.profiles
  for select using (id = auth.uid() or org_id = private.current_org_id());
create policy profiles_admin_write on public.profiles
  for all using (private.current_user_role() = 'Admin' and org_id = private.current_org_id())
  with check (private.current_user_role() = 'Admin' and org_id = private.current_org_id());

create policy facilities_org_read on public.facilities
  for select using (org_id = private.current_org_id());
create policy facilities_staff_write on public.facilities
  for all using (org_id = private.current_org_id() and private.current_user_role() in ('Admin','Wound Provider'))
  with check (org_id = private.current_org_id() and private.current_user_role() in ('Admin','Wound Provider'));

create policy patients_org_read on public.patients
  for select using (org_id = private.current_org_id());
create policy patients_staff_write on public.patients
  for all using (org_id = private.current_org_id() and private.current_user_role() in ('Admin','Wound Provider'))
  with check (org_id = private.current_org_id() and private.current_user_role() in ('Admin','Wound Provider'));

create policy wounds_org_read on public.wounds
  for select using (org_id = private.current_org_id());
create policy wounds_staff_write on public.wounds
  for all using (org_id = private.current_org_id() and private.current_user_role() in ('Admin','Wound Provider'))
  with check (org_id = private.current_org_id() and private.current_user_role() in ('Admin','Wound Provider'));
