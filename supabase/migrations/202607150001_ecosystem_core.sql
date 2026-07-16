-- Central Megabattle ecosystem schema. Safe after the website schema.
create extension if not exists "pgcrypto";

-- Existing website databases can already be Telegram-only and therefore have no
-- legacy Supabase Auth column. Keep this migration compatible with both states.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'auth_user_id'
  ) then
    execute 'alter table public.profiles alter column auth_user_id drop not null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'isu_number'
  ) then
    execute 'alter table public.profiles alter column isu_number drop not null';
  end if;
end $$;

create table if not exists public.account_identities (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('telegram', 'itmo_id', 'supabase')),
  provider_subject text not null,
  username text,
  metadata jsonb not null default '{}'::jsonb,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_subject)
);

create table if not exists public.profile_roles (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('participant', 'admin', 'site_admin')),
  granted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (profile_id, role)
);

create table if not exists public.seasons (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists seasons_one_active_idx on public.seasons (is_active) where is_active;

create table if not exists public.game_levels (
  level integer primary key check (level > 0),
  title text not null,
  min_xp integer not null check (min_xp >= 0),
  sort_order integer not null
);
insert into public.game_levels (level, title, min_xp, sort_order) values
  (1, 'Новичок IMB', 0, 10), (2, 'Участник движухи', 5, 20),
  (3, 'Завсегдатай', 15, 30), (4, 'Амбассадор', 30, 40),
  (5, 'Легенда сезона', 60, 50), (6, 'Мерч-хантер', 100, 60),
  (7, 'Финальный босс', 160, 70)
on conflict (level) do update set title = excluded.title, min_xp = excluded.min_xp, sort_order = excluded.sort_order;

create table if not exists public.score_transactions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  season_id uuid references public.seasons(id) on delete set null,
  amount integer not null check (amount <> 0),
  reason text not null,
  source text not null default 'manual' check (source in ('manual', 'attendance', 'code', 'system', 'import')),
  created_by uuid references public.profiles(id) on delete set null,
  idempotency_key text unique,
  created_at timestamptz not null default now()
);
create index if not exists score_transactions_profile_idx on public.score_transactions (profile_id, created_at desc);

create table if not exists public.currencies (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  icon_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.currencies (code, name, description)
values ('credits', 'Кредиты', 'Внутренняя валюта сезона')
on conflict (code) do update set name = excluded.name, description = excluded.description;

create table if not exists public.currency_transactions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  currency_id uuid not null references public.currencies(id) on delete restrict,
  amount numeric(14, 2) not null check (amount <> 0),
  reason text not null,
  source text not null default 'manual' check (source in ('manual', 'code', 'system', 'import')),
  created_by uuid references public.profiles(id) on delete set null,
  idempotency_key text unique,
  created_at timestamptz not null default now()
);
create index if not exists currency_transactions_profile_idx on public.currency_transactions (profile_id, created_at desc);

create table if not exists public.achievements (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  icon_url text,
  max_amount integer,
  is_hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.profile_achievements (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  achievement_id uuid not null references public.achievements(id) on delete cascade,
  amount integer not null default 1 check (amount > 0),
  granted_by uuid references public.profiles(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (profile_id, achievement_id)
);

alter table public.project_events
  add column if not exists season_id uuid references public.seasons(id) on delete set null,
  add column if not exists starts_at timestamptz,
  add column if not exists ends_at timestamptz,
  add column if not exists registration_opens_at timestamptz,
  add column if not exists registration_closes_at timestamptz,
  add column if not exists capacity integer check (capacity is null or capacity > 0);

create table if not exists public.event_registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.project_events(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'registered' check (status in ('registered', 'waitlist', 'cancelled', 'attended', 'no_show')),
  source text not null default 'site' check (source in ('site', 'participant_bot', 'admin', 'itmo_events', 'import')),
  itmo_events_registration_id text,
  registered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, profile_id)
);

create or replace function public.upsert_telegram_identity(
  p_telegram_user_id bigint, p_username text, p_first_name text, p_last_name text, p_photo_url text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_profile_id uuid; v_full_name text;
begin
  v_full_name := trim(concat_ws(' ', p_first_name, nullif(p_last_name, '')));
  select profile_id into v_profile_id from public.account_identities
  where provider = 'telegram' and provider_subject = p_telegram_user_id::text;
  if v_profile_id is null then
    insert into public.profiles (isu_number, nickname, full_name, avatar_url, telegram_username)
    values (null, coalesce(nullif(p_username, ''), p_first_name || '_' || right(p_telegram_user_id::text, 4)), v_full_name, p_photo_url, p_username)
    returning id into v_profile_id;
    insert into public.account_identities (profile_id, provider, provider_subject, username, metadata, verified_at)
    values (v_profile_id, 'telegram', p_telegram_user_id::text, p_username,
      jsonb_build_object('first_name', p_first_name, 'last_name', p_last_name, 'photo_url', p_photo_url), now());
    insert into public.profile_roles (profile_id, role) values (v_profile_id, 'participant') on conflict do nothing;
  else
    update public.profiles set full_name = v_full_name, telegram_username = p_username,
      avatar_url = coalesce(p_photo_url, avatar_url), updated_at = now() where id = v_profile_id;
    update public.account_identities set username = p_username,
      metadata = jsonb_build_object('first_name', p_first_name, 'last_name', p_last_name, 'photo_url', p_photo_url),
      verified_at = now(), updated_at = now()
    where provider = 'telegram' and provider_subject = p_telegram_user_id::text;
  end if;
  return jsonb_build_object('profileId', v_profile_id, 'telegramId', p_telegram_user_id,
    'roles', coalesce((select jsonb_agg(role) from public.profile_roles where profile_id = v_profile_id), '[]'::jsonb));
end; $$;

create or replace function public.participant_dashboard(p_telegram_user_id bigint)
returns jsonb language sql security definer set search_path = public as $$
  with target as (
    select p.id, p.nickname, p.full_name, p.avatar_url, p.telegram_username
    from public.account_identities i join public.profiles p on p.id = i.profile_id
    where i.provider = 'telegram' and i.provider_subject = p_telegram_user_id::text
  ), xp as (
    select coalesce(sum(s.amount), 0)::integer value from public.score_transactions s join target t on t.id = s.profile_id
  ), current_level as (
    select l.* from public.game_levels l, xp where l.min_xp <= xp.value order by l.min_xp desc limit 1
  ), next_level as (
    select l.* from public.game_levels l, xp where l.min_xp > xp.value order by l.min_xp asc limit 1
  )
  select jsonb_build_object(
    'ok', true,
    'user', jsonb_build_object('id', t.id, 'tgId', p_telegram_user_id,
      'name', coalesce(nullif(t.full_name, ''), t.nickname), 'username', t.telegram_username,
      'avatarUrl', t.avatar_url,
      'isManager', exists (select 1 from public.profile_roles r where r.profile_id = t.id and r.role in ('admin', 'site_admin'))),
    'stats', jsonb_build_object(
      'streak', (select count(*) from public.event_registrations er where er.profile_id = t.id and er.status = 'attended'),
      'registrations', (select count(*) from public.event_registrations er where er.profile_id = t.id and er.status <> 'cancelled'),
      'checkins', (select count(*) from public.event_registrations er where er.profile_id = t.id and er.status = 'attended')
    ),
    'level', jsonb_build_object('xp', xp.value, 'level', current_level.level, 'title', current_level.title,
      'currentMinXp', current_level.min_xp, 'nextLevel', next_level.level, 'nextTitle', next_level.title,
      'nextMinXp', next_level.min_xp, 'xpToNext', coalesce(next_level.min_xp - xp.value, 0),
      'percent', case when next_level.level is null then 100 else round(100.0 * (xp.value - current_level.min_xp) / greatest(next_level.min_xp - current_level.min_xp, 1)) end),
    'currencies', coalesce((select jsonb_agg(jsonb_build_object('currency_id', c.id, 'currency_name', c.name,
      'currency_description', c.description, 'currency_icon_url', c.icon_url,
      'amount', coalesce((select sum(ct.amount) from public.currency_transactions ct where ct.profile_id = t.id and ct.currency_id = c.id), 0)::text) order by c.name)
      from public.currencies c where c.is_active), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'title', e.name, 'description', e.description,
      'startsAt', e.starts_at, 'registrationStatus', e.registration_status,
      'registered', exists (select 1 from public.event_registrations er where er.event_id = e.id and er.profile_id = t.id and er.status <> 'cancelled'),
      'attended', exists (select 1 from public.event_registrations er where er.event_id = e.id and er.profile_id = t.id and er.status = 'attended'))
      order by e.starts_at nulls last, e.sort_order) from public.project_events e where e.status = 'published' and e.group_key = 'megabattle'), '[]'::jsonb),
    'scoreHistory', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from
      (select id, amount, reason, source, created_at from public.score_transactions where profile_id = t.id order by created_at desc limit 8) x), '[]'::jsonb),
    'currencyHistory', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from
      (select ct.id, ct.amount, ct.reason, ct.source, ct.created_at, c.name as currency_name from public.currency_transactions ct
       join public.currencies c on c.id = ct.currency_id where ct.profile_id = t.id order by ct.created_at desc limit 8) x), '[]'::jsonb)
  ) from target t, xp, current_level left join next_level on true;
$$;

create or replace function public.participant_leaderboard(p_limit integer default 20)
returns table (place bigint, profile_id uuid, nickname text, full_name text, avatar_url text, xp bigint)
language sql security definer set search_path = public as $$
  select row_number() over (order by coalesce(sum(s.amount), 0) desc, p.nickname asc), p.id, p.nickname,
    p.full_name, p.avatar_url, coalesce(sum(s.amount), 0)::bigint
  from public.profiles p join public.profile_roles r on r.profile_id = p.id and r.role = 'participant'
  left join public.score_transactions s on s.profile_id = p.id
  where coalesce(p.is_banned, false) = false group by p.id
  order by coalesce(sum(s.amount), 0) desc, p.nickname asc limit greatest(1, least(p_limit, 100));
$$;

alter table public.account_identities enable row level security;
alter table public.profile_roles enable row level security;
alter table public.score_transactions enable row level security;
alter table public.currencies enable row level security;
alter table public.currency_transactions enable row level security;
alter table public.achievements enable row level security;
alter table public.profile_achievements enable row level security;
alter table public.event_registrations enable row level security;
-- Mutations go through the backend service role; public clients receive no direct policies here.
