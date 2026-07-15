-- Full backend schema for website, participant bot and organizer bot.
-- Run after 202607150001_ecosystem_core.sql.
create extension if not exists "pgcrypto";

alter table public.profiles
  add column if not exists birth_date date,
  add column if not exists phone text,
  add column if not exists onboarding_completed boolean not null default false,
  add column if not exists deleted_at timestamptz;

alter table public.project_events
  add column if not exists requires_itmo_id boolean not null default false,
  add column if not exists checkin_opens_at timestamptz,
  add column if not exists checkin_closes_at timestamptz;

alter table public.nfc_tags
  add column if not exists public_slug text,
  add column if not exists last_scanned_at timestamptz,
  add column if not exists scan_count bigint not null default 0,
  add column if not exists updated_at timestamptz not null default now();
create unique index if not exists nfc_tags_public_slug_idx on public.nfc_tags(public_slug) where public_slug is not null;

alter table public.friendships
  add column if not exists source text not null default 'profile' check (source in ('profile','nfc','admin','import')),
  add column if not exists nfc_tag_id uuid references public.nfc_tags(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();
delete from public.friendships a using public.friendships b
where a.id > b.id
  and least(a.requester_profile_id, a.receiver_profile_id) = least(b.requester_profile_id, b.receiver_profile_id)
  and greatest(a.requester_profile_id, a.receiver_profile_id) = greatest(b.requester_profile_id, b.receiver_profile_id);
create unique index if not exists friendships_undirected_unique_idx on public.friendships
  (least(requester_profile_id, receiver_profile_id), greatest(requester_profile_id, receiver_profile_id));

create table if not exists public.auth_exchange_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('telegram','itmo_id','supabase')),
  provider_subject text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.organizer_memberships (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  rank text not null default 'mega_org' check (rank in ('head_org','mega_org','mega_responsible')),
  block_key text,
  position_title text,
  is_active boolean not null default true,
  granted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organizer_availability (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'free' check (status in ('free','busy','preferred')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  unique(profile_id, starts_at, ends_at)
);
create index if not exists organizer_availability_range_idx on public.organizer_availability(starts_at, ends_at);

create table if not exists public.organizer_meetings (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  block_key text,
  topic text,
  key_questions jsonb not null default '[]'::jsonb,
  location text,
  conference_url text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('draft','scheduled','completed','cancelled')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create table if not exists public.organizer_meeting_attendees (
  meeting_id uuid not null references public.organizer_meetings(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  response text not null default 'pending' check (response in ('pending','accepted','declined','maybe','attended','missed')),
  responded_at timestamptz,
  primary key(meeting_id, profile_id)
);

alter table public.organizer_tasks
  add column if not exists parent_task_id uuid references public.organizer_tasks(id) on delete cascade,
  add column if not exists source text not null default 'megabattle' check (source in ('megabattle','yougile')),
  add column if not exists revision integer not null default 1,
  add column if not exists sync_status text not null default 'pending' check (sync_status in ('pending','synced','conflict','error')),
  add column if not exists last_synced_at timestamptz;

create table if not exists public.organizer_task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.organizer_tasks(id) on delete cascade,
  author_profile_id uuid references public.profiles(id) on delete set null,
  body text not null,
  yougile_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.organizer_task_reminders (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.organizer_tasks(id) on delete cascade,
  offset_minutes integer not null check (offset_minutes > 0),
  created_by uuid references public.profiles(id) on delete set null,
  unique(task_id, offset_minutes)
);

create table if not exists public.notification_preferences (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  telegram_enabled boolean not null default true,
  events_enabled boolean not null default true,
  meetings_enabled boolean not null default true,
  tasks_enabled boolean not null default true,
  birthdays_enabled boolean not null default true,
  quiet_hours_start time,
  quiet_hours_end time,
  timezone text not null default 'Europe/Moscow',
  updated_at timestamptz not null default now()
);
create table if not exists public.notification_queue (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id) on delete cascade,
  bot text not null check (bot in ('participant','organizer')),
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  scheduled_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','cancelled')),
  attempts integer not null default 0,
  idempotency_key text unique,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notification_queue_pending_idx on public.notification_queue(status, scheduled_at);

create table if not exists public.reward_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  label text not null,
  xp_amount integer not null default 0,
  currency_code text,
  currency_amount numeric(14,2),
  max_redemptions integer,
  per_profile_limit integer not null default 1,
  starts_at timestamptz,
  expires_at timestamptz,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists public.reward_code_redemptions (
  id uuid primary key default gen_random_uuid(),
  reward_code_id uuid not null references public.reward_codes(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  redeemed_at timestamptz not null default now()
);
create index if not exists reward_code_redemptions_lookup_idx on public.reward_code_redemptions(reward_code_id, profile_id);

create table if not exists public.event_checkin_codes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.project_events(id) on delete cascade,
  code_hash text not null unique,
  starts_at timestamptz not null,
  expires_at timestamptz not null,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (expires_at > starts_at)
);

create table if not exists public.temporary_media (
  id uuid primary key default gen_random_uuid(),
  owner_profile_id uuid references public.profiles(id) on delete cascade,
  bucket text not null default 'temporary-media',
  object_path text not null unique,
  mime_type text,
  size_bytes bigint,
  purpose text not null default 'loket',
  expires_at timestamptz not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists temporary_media_expiry_idx on public.temporary_media(expires_at) where deleted_at is null;

create table if not exists public.vault_entries (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  encrypted_payload text not null,
  nonce text not null,
  auth_tag text not null,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop policy if exists "admins can manage passwords" on public.project_passwords;

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_profile_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  ip_hash text,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created_idx on public.audit_logs(created_at desc);

create table if not exists public.integration_jobs (
  id uuid primary key default gen_random_uuid(),
  integration text not null check (integration in ('yougile','itmo_events','telegram')),
  operation text not null,
  entity_type text,
  entity_id text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','processing','done','failed','cancelled')),
  attempts integer not null default 0,
  run_after timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists integration_jobs_pending_idx on public.integration_jobs(status, run_after);

create table if not exists public.integration_user_mappings (
  id uuid primary key default gen_random_uuid(),
  integration text not null,
  external_user_id text not null,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(integration, external_user_id),
  unique(integration, profile_id)
);

insert into storage.buckets (id, name, public) values
  ('content-media','content-media',true),
  ('temporary-media','temporary-media',false)
on conflict (id) do nothing;

-- All privileged writes happen through the service-role backend.
alter table public.auth_exchange_codes enable row level security;
alter table public.organizer_memberships enable row level security;
alter table public.organizer_availability enable row level security;
alter table public.organizer_meetings enable row level security;
alter table public.organizer_meeting_attendees enable row level security;
alter table public.organizer_task_comments enable row level security;
alter table public.organizer_task_reminders enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_queue enable row level security;
alter table public.reward_codes enable row level security;
alter table public.reward_code_redemptions enable row level security;
alter table public.event_checkin_codes enable row level security;
alter table public.temporary_media enable row level security;
alter table public.vault_entries enable row level security;
alter table public.audit_logs enable row level security;
alter table public.integration_jobs enable row level security;
alter table public.integration_user_mappings enable row level security;

-- Keep the operational log bounded. Called after every audit insert by the backend.
create or replace function public.trim_audit_logs(p_keep integer default 50)
returns void language sql security definer set search_path = public as $$
  delete from public.audit_logs where id in (
    select id from public.audit_logs order by created_at desc offset greatest(p_keep, 10)
  );
$$;

-- Atomic code redemption prevents duplicate rewards under concurrent scans.
create or replace function public.redeem_reward_code(p_profile_id uuid, p_code_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_code public.reward_codes%rowtype; v_used integer; v_personal integer; v_currency uuid;
begin
  select * into v_code from public.reward_codes where code_hash = p_code_hash for update;
  if v_code.id is null or not v_code.is_active then raise exception 'CODE_NOT_FOUND'; end if;
  if v_code.starts_at is not null and v_code.starts_at > now() then raise exception 'CODE_NOT_STARTED'; end if;
  if v_code.expires_at is not null and v_code.expires_at < now() then raise exception 'CODE_EXPIRED'; end if;
  select count(*) into v_used from public.reward_code_redemptions where reward_code_id = v_code.id;
  select count(*) into v_personal from public.reward_code_redemptions where reward_code_id = v_code.id and profile_id = p_profile_id;
  if v_code.max_redemptions is not null and v_used >= v_code.max_redemptions then raise exception 'CODE_LIMIT'; end if;
  if v_personal >= v_code.per_profile_limit then raise exception 'CODE_ALREADY_USED'; end if;
  insert into public.reward_code_redemptions(reward_code_id, profile_id) values(v_code.id, p_profile_id);
  if v_code.xp_amount <> 0 then
    insert into public.score_transactions(profile_id, amount, reason, source, idempotency_key)
    values(p_profile_id, v_code.xp_amount, v_code.label, 'code', 'reward:' || v_code.id || ':' || p_profile_id || ':' || (v_personal + 1));
  end if;
  if v_code.currency_code is not null and coalesce(v_code.currency_amount,0) <> 0 then
    select id into v_currency from public.currencies where code = v_code.currency_code;
    insert into public.currency_transactions(profile_id,currency_id,amount,reason,source,idempotency_key)
    values(p_profile_id,v_currency,v_code.currency_amount,v_code.label,'code','reward:' || v_code.id || ':' || p_profile_id || ':' || (v_personal + 1));
  end if;
  return jsonb_build_object('ok',true,'label',v_code.label,'xp',v_code.xp_amount,'currencyCode',v_code.currency_code,'currencyAmount',v_code.currency_amount);
end; $$;

create or replace function public.increment_nfc_scan(p_tag_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.nfc_tags set scan_count = scan_count + 1, last_scanned_at = now(), updated_at = now() where id = p_tag_id;
$$;

create or replace function public.register_for_event(p_profile_id uuid, p_event_id uuid, p_source text default 'site')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_event public.project_events%rowtype; v_count integer; v_status text; v_registration uuid;
begin
  select * into v_event from public.project_events where id = p_event_id for update;
  if v_event.id is null or v_event.status <> 'published' or v_event.registration_status <> 'open' then raise exception 'REGISTRATION_CLOSED'; end if;
  if v_event.registration_opens_at is not null and v_event.registration_opens_at > now() then raise exception 'REGISTRATION_NOT_STARTED'; end if;
  if v_event.registration_closes_at is not null and v_event.registration_closes_at < now() then raise exception 'REGISTRATION_CLOSED'; end if;
  if v_event.requires_itmo_id and not exists(select 1 from public.account_identities where profile_id = p_profile_id and provider = 'itmo_id') then raise exception 'ITMO_ID_REQUIRED'; end if;
  select count(*) into v_count from public.event_registrations where event_id = p_event_id and status in ('registered','attended');
  v_status := case when v_event.capacity is not null and v_count >= v_event.capacity then 'waitlist' else 'registered' end;
  insert into public.event_registrations(event_id,profile_id,status,source,updated_at)
  values(p_event_id,p_profile_id,v_status,p_source,now())
  on conflict(event_id,profile_id) do update set status=excluded.status,source=excluded.source,updated_at=now()
  returning id into v_registration;
  return jsonb_build_object('id',v_registration,'eventId',p_event_id,'profileId',p_profile_id,'status',v_status,'itmoEventsId',v_event.itmo_events_id,'eventName',v_event.name,'startsAt',v_event.starts_at);
end; $$;

create table if not exists public.backend_schema_versions (
  version text primary key,
  applied_at timestamptz not null default now()
);
insert into public.backend_schema_versions(version) values ('202607150002_full_platform') on conflict do nothing;
alter table public.backend_schema_versions enable row level security;
