-- =====================================================================
-- PCC Schedule Hub — database schema, access rules and audit trail
--
-- Run once in Supabase: Dashboard → SQL Editor → paste → Run.
-- (Or `supabase db push` if you use the Supabase CLI.)
--
-- Model
--   profiles            one row per staff member who has signed in, with a role
--   schedule_documents  the live schedule (one JSON document, versioned)
--   schedule_history    every saved version, who saved it and why (restorable)
--   audit_log           admin actions such as role changes and restores
--
-- Rules
--   * Only @polynesia.com addresses can create an account (enforced here,
--     not in the browser). Edit ALLOWED_DOMAINS in is_allowed_email() to change.
--   * New accounts are Viewers. Admins promote Editors and other Admins.
--   * Nobody can read anything without signing in (staff-only).
--   * Writes go only through save_document(), which checks the role and
--     rejects a save based on an out-of-date version (no silent overwrites).
-- =====================================================================

-- ---------- roles ----------
do $$ begin
  create type public.app_role as enum ('viewer', 'editor', 'admin');
exception when duplicate_object then null; end $$;

-- ---------- allowed email domains ----------
create or replace function public.is_allowed_email(p_email text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    substring(lower(trim(p_email)) from '^[^@[:space:]]+@([a-z0-9.-]+)$')
      = any (array['polynesia.com']),   -- ALLOWED_DOMAINS
    false
  );
$$;

-- ---------- tables ----------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null unique,
  full_name     text check (full_name is null or char_length(full_name) <= 120),
  role          public.app_role not null default 'viewer',
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);

create table if not exists public.schedule_documents (
  path        text primary key check (path ~ '^[a-z0-9_-]+(/[a-z0-9_-]+)*$'),
  data        jsonb not null check (jsonb_typeof(data) = 'object'),
  version     integer not null default 1 check (version > 0),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id) on delete set null
);

create table if not exists public.schedule_history (
  id          bigint generated always as identity primary key,
  path        text not null,
  version     integer not null,
  data        jsonb not null,
  summary     text not null default '',
  changed_at  timestamptz not null default now(),
  changed_by  uuid references public.profiles (id) on delete set null
);
create index if not exists schedule_history_path_time on public.schedule_history (path, changed_at desc);

create table if not exists public.audit_log (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  actor   uuid references public.profiles (id) on delete set null,
  action  text not null,
  detail  jsonb not null default '{}'::jsonb
);

-- ---------- helpers ----------
create or replace function public.my_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.profiles p where p.id = (select auth.uid());
$$;

-- ---------- account creation (runs on Supabase's auth.users) ----------
create or replace function public.enforce_staff_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is null or not public.is_allowed_email(new.email) then
    raise exception 'Only @polynesia.com email addresses can sign in.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.handle_new_staff_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, lower(new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.sync_staff_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set email = lower(new.email) where id = new.id;
  return new;
end;
$$;

drop trigger if exists enforce_staff_email on auth.users;
create trigger enforce_staff_email
  before insert or update of email on auth.users
  for each row execute function public.enforce_staff_email();

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_staff_user();

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function public.sync_staff_email();

-- ---------- API: who am I ----------
create or replace function public.get_me()
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare me public.profiles;
begin
  update public.profiles set last_seen_at = now()
   where id = (select auth.uid())
  returning * into me;
  return me;
end;
$$;

create or replace function public.update_my_name(p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  update public.profiles
     set full_name = nullif(left(trim(p_name), 120), '')
   where id = (select auth.uid());
end;
$$;

-- ---------- API: save the schedule ----------
-- p_expected_version is the version the editor's screen was showing.
-- If someone saved in between, this raises version_conflict (SQLSTATE 40001)
-- and nothing is written, so no one's change is silently overwritten.
create or replace function public.save_document(
  p_path text,
  p_data jsonb,
  p_expected_version integer,
  p_summary text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.app_role := public.my_role();
  v_new  integer;
begin
  if v_role is null or v_role not in ('editor', 'admin') then
    raise exception 'You have view-only access to this schedule.' using errcode = '42501';
  end if;
  if p_path is distinct from 'schedule/main' then
    raise exception 'Unknown document: %', p_path using errcode = '22023';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'The schedule must be a JSON object.' using errcode = '22023';
  end if;
  if octet_length(p_data::text) > 2000000 then
    raise exception 'The schedule is too large to save.' using errcode = '54000';
  end if;

  update public.schedule_documents
     set data = p_data,
         version = version + 1,
         updated_at = now(),
         updated_by = (select auth.uid())
   where path = p_path
     and version = p_expected_version
  returning version into v_new;

  if v_new is null then
    if exists (select 1 from public.schedule_documents where path = p_path) then
      raise exception 'version_conflict' using errcode = '40001';
    end if;
    insert into public.schedule_documents (path, data, version, updated_by)
    values (p_path, p_data, 1, (select auth.uid()))
    returning version into v_new;
  end if;

  insert into public.schedule_history (path, version, data, summary, changed_by)
  values (p_path, v_new, p_data, left(coalesce(p_summary, ''), 300), (select auth.uid()));

  return v_new;
end;
$$;

-- ---------- API: admin actions ----------
create or replace function public.set_user_role(p_user uuid, p_role public.app_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_old public.app_role;
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'Only admins can change access.' using errcode = '42501';
  end if;
  select role into v_old from public.profiles where id = p_user for update;
  if v_old is null then
    raise exception 'No such user.' using errcode = '22023';
  end if;
  if v_old = 'admin' and p_role <> 'admin'
     and (select count(*) from public.profiles where role = 'admin') <= 1 then
    raise exception 'There must always be at least one admin.' using errcode = '22023';
  end if;
  update public.profiles set role = p_role where id = p_user;
  insert into public.audit_log (actor, action, detail)
  values ((select auth.uid()), 'set_role',
          jsonb_build_object('user', p_user, 'from', v_old, 'to', p_role));
end;
$$;

create or replace function public.restore_version(p_history_id bigint)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  h public.schedule_history;
  v_current integer;
  v_new integer;
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'Only admins can restore an earlier version.' using errcode = '42501';
  end if;
  select * into h from public.schedule_history where id = p_history_id;
  if h.id is null then
    raise exception 'No such version.' using errcode = '22023';
  end if;
  select version into v_current from public.schedule_documents where path = h.path for update;
  v_new := public.save_document(h.path, h.data, coalesce(v_current, 0),
                                format('Restored version %s (from %s)', h.version,
                                       to_char(h.changed_at at time zone 'Pacific/Honolulu', 'Mon DD, YYYY HH12:MI AM')));
  insert into public.audit_log (actor, action, detail)
  values ((select auth.uid()), 'restore_version',
          jsonb_build_object('history_id', h.id, 'version', h.version, 'new_version', v_new));
  return v_new;
end;
$$;

-- ---------- row-level security ----------
alter table public.profiles           enable row level security;
alter table public.schedule_documents enable row level security;
alter table public.schedule_history   enable row level security;
alter table public.audit_log          enable row level security;

drop policy if exists "staff can read profiles" on public.profiles;
create policy "staff can read profiles" on public.profiles
  for select to authenticated using (public.my_role() is not null);

drop policy if exists "staff can read schedule" on public.schedule_documents;
create policy "staff can read schedule" on public.schedule_documents
  for select to authenticated using (public.my_role() is not null);

drop policy if exists "staff can read history" on public.schedule_history;
create policy "staff can read history" on public.schedule_history
  for select to authenticated using (public.my_role() is not null);

drop policy if exists "admins can read audit log" on public.audit_log;
create policy "admins can read audit log" on public.audit_log
  for select to authenticated using (public.my_role() = 'admin');

-- Belt and braces: no direct writes from the browser at all, no anonymous reads.
revoke all on public.profiles, public.schedule_documents, public.schedule_history, public.audit_log from anon;
revoke insert, update, delete, truncate on public.profiles, public.schedule_documents,
  public.schedule_history, public.audit_log from authenticated;
grant select on public.profiles, public.schedule_documents, public.schedule_history, public.audit_log to authenticated;

-- Functions: only signed-in users may call the API; trigger functions are internal.
revoke execute on function
  public.my_role(), public.get_me(), public.update_my_name(text),
  public.save_document(text, jsonb, integer, text),
  public.set_user_role(uuid, public.app_role), public.restore_version(bigint),
  public.enforce_staff_email(), public.handle_new_staff_user(), public.sync_staff_email()
  from public, anon;
revoke execute on function
  public.enforce_staff_email(), public.handle_new_staff_user(), public.sync_staff_email()
  from authenticated;
grant execute on function
  public.my_role(), public.get_me(), public.update_my_name(text),
  public.save_document(text, jsonb, integer, text),
  public.set_user_role(uuid, public.app_role), public.restore_version(bigint)
  to authenticated;

-- ---------- live updates ----------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.schedule_documents;
    exception when duplicate_object then null; end;
  end if;
end $$;
