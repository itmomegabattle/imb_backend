-- Closed-beta schema: Telegram-only identity, seasonal economy, teams and bot-first administration.
create extension if not exists "pgcrypto";

-- Supabase Auth is not part of the product. Supabase is used only as PostgreSQL and Storage.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_auth_user();
drop policy if exists "users insert own profile" on public.profiles;
drop policy if exists "users update own profile" on public.profiles;
drop policy if exists "users manage own tags" on public.nfc_tags;
drop policy if exists "users create friendships" on public.friendships;
drop policy if exists "users update own friendships" on public.friendships;
drop policy if exists "authenticated users log profile views" on public.profile_views;
drop policy if exists "users submit stories" on public.participant_stories;
drop policy if exists "users read own story submissions" on public.participant_stories;
drop policy if exists "authenticated users create unclaimed nfc tags" on public.nfc_tags;
drop policy if exists "users claim free nfc tags" on public.nfc_tags;
drop policy if exists "users create own friendships" on public.friendships;
drop policy if exists "users can log profile views" on public.profile_views;
drop policy if exists "profile views are readable by admins or participants" on public.profile_views;
drop policy if exists "users can read own submitted participant stories" on public.participant_stories;
drop policy if exists "users can submit participant stories" on public.participant_stories;
drop trigger if exists profiles_protect_admin_fields on public.profiles;
drop function if exists public.protect_profile_admin_fields();
drop function if exists public.current_profile_is_admin() cascade;

-- Direct authenticated writes from the old SPA are disabled. The backend service role owns mutations.
drop policy if exists "authenticated users upload avatars" on storage.objects;
drop policy if exists "authenticated users update avatars" on storage.objects;
drop policy if exists "users upload story submission images" on storage.objects;
drop policy if exists "admins upload event images" on storage.objects;
drop policy if exists "admins update event images" on storage.objects;
drop policy if exists "admins delete event images" on storage.objects;
drop policy if exists "admins upload team images" on storage.objects;
drop policy if exists "admins update team images" on storage.objects;
drop policy if exists "admins delete team images" on storage.objects;
drop policy if exists "admins upload content images" on storage.objects;
drop policy if exists "admins update content images" on storage.objects;
drop policy if exists "admins delete content images" on storage.objects;

alter table public.profiles drop constraint if exists profiles_auth_user_id_key;
alter table public.profiles drop constraint if exists profiles_auth_user_id_fkey;
alter table public.profiles drop column if exists auth_user_id;
alter table public.profiles alter column isu_number drop not null;
alter table public.profiles drop constraint if exists profiles_isu_number_key;
create unique index if not exists profiles_isu_number_unique_idx on public.profiles(isu_number) where isu_number is not null;

alter table public.profiles
  add column if not exists onboarding_completed boolean not null default false,
  add column if not exists deleted_at timestamptz,
  add column if not exists birth_date date,
  add column if not exists phone text;
alter table public.profiles drop constraint if exists profiles_faculty_check;
alter table public.profiles add constraint profiles_faculty_check
  check (faculty is null or faculty in ('КТУ','ТИНТ','НОЖ','ФТМФ','ФТМИ'));
with ranked as (
  select id,nickname,row_number() over(partition by lower(nickname) order by created_at,id) duplicate_number
  from public.profiles where deleted_at is null
)
update public.profiles p set nickname=left(p.nickname,67)||'_'||substr(p.id::text,1,8)
from ranked r where p.id=r.id and r.duplicate_number>1;
create unique index if not exists profiles_nickname_active_unique_idx on public.profiles(lower(nickname)) where deleted_at is null;

delete from public.account_identities where provider = 'supabase';
alter table public.account_identities drop constraint if exists account_identities_provider_check;
alter table public.account_identities add constraint account_identities_provider_check
  check (provider in ('telegram','itmo_id'));

-- One active season. Economy rows always belong to a season.
insert into public.seasons(slug,title,description,starts_at,ends_at,is_active)
values ('beta-2026','Beta 2026','Закрытая бета экосистемы ITMO Megabattle',now(),now() + interval '1 year',not exists(select 1 from public.seasons where is_active))
on conflict(slug) do update set title=excluded.title, description=excluded.description;
create unique index if not exists seasons_single_active_idx on public.seasons((is_active)) where is_active;
update public.score_transactions set season_id=(select id from public.seasons where is_active limit 1) where season_id is null;
alter table public.score_transactions alter column season_id set not null;
alter table public.currency_transactions add column if not exists season_id uuid references public.seasons(id) on delete restrict;
update public.currency_transactions set season_id=(select id from public.seasons where is_active limit 1) where season_id is null;
alter table public.currency_transactions alter column season_id set not null;
alter table public.currency_transactions drop constraint if exists currency_transactions_amount_check;
alter table public.currency_transactions add constraint currency_transactions_amount_check check (amount <> 0 and amount = trunc(amount));
alter table public.currency_transactions drop constraint if exists currency_transactions_source_check;
alter table public.currency_transactions add constraint currency_transactions_source_check
  check (source in ('manual','code','system','import','transfer'));
create index if not exists score_transactions_season_profile_idx on public.score_transactions(season_id,profile_id,created_at desc);
create index if not exists currency_transactions_season_profile_idx on public.currency_transactions(season_id,profile_id,currency_id,created_at desc);
create index if not exists profiles_faculty_active_idx on public.profiles(faculty) where onboarding_completed and not is_banned and deleted_at is null;

create or replace function public.start_new_season(p_slug text,p_title text,p_starts_at timestamptz,p_ends_at timestamptz)
returns public.seasons language plpgsql security definer set search_path=public as $$
declare v_season public.seasons%rowtype;
begin
  if p_ends_at <= p_starts_at then raise exception 'SEASON_DATES_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtext('itmomegabattle:active-season'));
  update public.seasons set is_active=false where is_active;
  insert into public.seasons(slug,title,starts_at,ends_at,is_active)
    values(p_slug,p_title,p_starts_at,p_ends_at,true)
    on conflict(slug) do update set title=excluded.title,starts_at=excluded.starts_at,ends_at=excluded.ends_at,is_active=true
    returning * into v_season;
  return v_season;
end $$;

create table if not exists public.currency_transfers (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete restrict,
  currency_id uuid not null references public.currencies(id) on delete restrict,
  sender_profile_id uuid not null references public.profiles(id) on delete restrict,
  receiver_profile_id uuid not null references public.profiles(id) on delete restrict,
  amount bigint not null check(amount >= 10),
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  check(sender_profile_id <> receiver_profile_id)
);
create index if not exists currency_transfers_sender_idx on public.currency_transfers(sender_profile_id,created_at desc);
create index if not exists currency_transfers_receiver_idx on public.currency_transfers(receiver_profile_id,created_at desc);

create or replace function public.transfer_currency(
  p_sender_profile_id uuid,
  p_receiver_profile_id uuid,
  p_amount bigint,
  p_idempotency_key text,
  p_currency_code text default 'credits'
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_season uuid; v_currency uuid; v_balance numeric; v_transfer uuid; v_receiver_name text;
begin
  if p_amount < 10 then raise exception 'MIN_TRANSFER_10'; end if;
  if p_sender_profile_id = p_receiver_profile_id then raise exception 'SELF_TRANSFER'; end if;
  select id into v_season from public.seasons where is_active for update;
  if v_season is null then raise exception 'NO_ACTIVE_SEASON'; end if;
  select id into v_currency from public.currencies where code=p_currency_code and is_active;
  if v_currency is null then raise exception 'CURRENCY_NOT_FOUND'; end if;
  if exists(select 1 from public.profiles where id in (p_sender_profile_id,p_receiver_profile_id) and (is_banned or deleted_at is not null)) then raise exception 'PROFILE_BLOCKED'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_sender_profile_id::text || ':' || v_season::text || ':' || v_currency::text,0));
  select id into v_transfer from public.currency_transfers where idempotency_key=p_idempotency_key;
  if v_transfer is not null then return jsonb_build_object('ok',true,'transferId',v_transfer,'duplicate',true); end if;
  select coalesce(sum(amount),0) into v_balance from public.currency_transactions
    where profile_id=p_sender_profile_id and season_id=v_season and currency_id=v_currency;
  if v_balance < p_amount then raise exception 'INSUFFICIENT_BALANCE'; end if;
  insert into public.currency_transfers(season_id,currency_id,sender_profile_id,receiver_profile_id,amount,idempotency_key)
  values(v_season,v_currency,p_sender_profile_id,p_receiver_profile_id,p_amount,p_idempotency_key) returning id into v_transfer;
  insert into public.currency_transactions(profile_id,season_id,currency_id,amount,reason,source,idempotency_key)
  values
    (p_sender_profile_id,v_season,v_currency,-p_amount,'Перевод участнику','transfer','transfer:'||v_transfer||':out'),
    (p_receiver_profile_id,v_season,v_currency,p_amount,'Перевод от участника','transfer','transfer:'||v_transfer||':in');
  select nickname into v_receiver_name from public.profiles where id=p_receiver_profile_id;
  return jsonb_build_object('ok',true,'transferId',v_transfer,'amount',p_amount,'receiver',v_receiver_name,'duplicate',false);
end $$;

-- Event registration modes and team registration.
alter table public.project_events
  add column if not exists registration_mode text not null default 'external_itmo_events',
  add column if not exists min_team_size integer,
  add column if not exists max_team_size integer;
alter table public.project_events drop constraint if exists project_events_registration_mode_check;
alter table public.project_events add constraint project_events_registration_mode_check
  check(registration_mode in ('external_itmo_events','internal_individual','internal_team'));
alter table public.project_events drop constraint if exists project_events_team_size_check;
alter table public.project_events add constraint project_events_team_size_check
  check((registration_mode <> 'internal_team') or (min_team_size >= 1 and max_team_size >= min_team_size));

create table if not exists public.event_teams (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.project_events(id) on delete cascade,
  captain_profile_id uuid not null references public.profiles(id) on delete restrict,
  name text not null check(length(name) between 2 and 80),
  status text not null default 'forming' check(status in ('forming','registered','cancelled')),
  join_code_hash text not null unique,
  join_code_hint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(event_id,captain_profile_id)
);
create table if not exists public.event_team_members (
  team_id uuid not null references public.event_teams(id) on delete cascade,
  event_id uuid not null references public.project_events(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key(team_id,profile_id)
);
alter table public.event_team_members add column if not exists event_id uuid references public.project_events(id) on delete cascade;
update public.event_team_members m set event_id=t.event_id from public.event_teams t where t.id=m.team_id and m.event_id is null;
alter table public.event_team_members alter column event_id set not null;
create unique index if not exists event_team_member_per_event_idx on public.event_team_members(event_id,profile_id);
create index if not exists event_team_members_profile_idx on public.event_team_members(profile_id,joined_at desc);
create index if not exists event_teams_event_idx on public.event_teams(event_id,status);

create or replace function public.create_event_team(
  p_event_id uuid,
  p_captain_profile_id uuid,
  p_name text,
  p_code_hash text,
  p_code_hint text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_event public.project_events%rowtype; v_team public.event_teams%rowtype;
begin
  select * into v_event from public.project_events where id=p_event_id for update;
  if v_event.id is null then raise exception 'EVENT_NOT_FOUND'; end if;
  if v_event.registration_mode <> 'internal_team' or v_event.registration_status <> 'open'
    or (v_event.registration_opens_at is not null and v_event.registration_opens_at > now())
    or (v_event.registration_closes_at is not null and v_event.registration_closes_at < now())
  then raise exception 'REGISTRATION_CLOSED'; end if;
  if exists(select 1 from public.event_team_members where event_id=p_event_id and profile_id=p_captain_profile_id)
  then raise exception 'ALREADY_IN_TEAM'; end if;
  insert into public.event_teams(event_id,captain_profile_id,name,join_code_hash,join_code_hint)
    values(p_event_id,p_captain_profile_id,p_name,p_code_hash,p_code_hint) returning * into v_team;
  insert into public.event_team_members(team_id,event_id,profile_id)
    values(v_team.id,p_event_id,p_captain_profile_id);
  return jsonb_build_object('team',to_jsonb(v_team),'joinCode',p_code_hint);
end $$;

create or replace function public.join_event_team(p_profile_id uuid,p_code_hash text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_team public.event_teams%rowtype; v_event public.project_events%rowtype; v_count integer;
begin
  select * into v_team from public.event_teams where join_code_hash=p_code_hash and status='forming' for update;
  if v_team.id is null then raise exception 'TEAM_CODE_INVALID'; end if;
  select * into v_event from public.project_events where id=v_team.event_id;
  if v_event.registration_status <> 'open' or (v_event.registration_closes_at is not null and v_event.registration_closes_at < now()) then raise exception 'REGISTRATION_CLOSED'; end if;
  delete from public.event_team_members m using public.event_teams t
    where m.team_id=t.id and m.profile_id=p_profile_id and t.event_id=v_team.event_id and t.status='cancelled';
  if exists(select 1 from public.event_team_members m join public.event_teams t on t.id=m.team_id where m.profile_id=p_profile_id and t.event_id=v_team.event_id and t.status<>'cancelled') then raise exception 'ALREADY_IN_TEAM'; end if;
  select count(*) into v_count from public.event_team_members where team_id=v_team.id;
  if v_count >= v_event.max_team_size then raise exception 'TEAM_FULL'; end if;
  insert into public.event_team_members(team_id,event_id,profile_id) values(v_team.id,v_team.event_id,p_profile_id);
  return jsonb_build_object('ok',true,'teamId',v_team.id,'teamName',v_team.name);
end $$;

create or replace function public.complete_event_team(p_team_id uuid,p_captain_profile_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_team public.event_teams%rowtype; v_event public.project_events%rowtype; v_count integer;
begin
  select * into v_team from public.event_teams where id=p_team_id for update;
  if v_team.id is null then raise exception 'TEAM_NOT_FOUND'; end if;
  if v_team.captain_profile_id <> p_captain_profile_id then raise exception 'CAPTAIN_ONLY'; end if;
  if v_team.status <> 'forming' then raise exception 'TEAM_NOT_FORMING'; end if;
  select * into v_event from public.project_events where id=v_team.event_id for update;
  if v_event.registration_status <> 'open'
    or (v_event.registration_opens_at is not null and v_event.registration_opens_at > now())
    or (v_event.registration_closes_at is not null and v_event.registration_closes_at < now())
  then raise exception 'REGISTRATION_CLOSED'; end if;
  select count(*) into v_count from public.event_team_members where team_id=p_team_id;
  if v_count < v_event.min_team_size or v_count > v_event.max_team_size then raise exception 'TEAM_SIZE_INVALID'; end if;
  insert into public.event_registrations(event_id,profile_id,status,source,updated_at)
    select v_team.event_id,m.profile_id,'registered','participant_bot',now()
    from public.event_team_members m where m.team_id=p_team_id
    on conflict(event_id,profile_id) do update set status='registered',source='participant_bot',updated_at=now();
  update public.event_teams set status='registered',updated_at=now() where id=p_team_id;
  return jsonb_build_object('ok',true,'teamId',p_team_id,'members',v_count,'status','registered');
end $$;

create or replace function public.cancel_event_team(p_team_id uuid,p_captain_profile_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_team public.event_teams%rowtype;
begin
  select * into v_team from public.event_teams where id=p_team_id for update;
  if v_team.id is null then raise exception 'TEAM_NOT_FOUND'; end if;
  if v_team.captain_profile_id <> p_captain_profile_id then raise exception 'CAPTAIN_ONLY'; end if;
  update public.event_registrations r set status='cancelled',updated_at=now()
    where r.event_id=v_team.event_id and exists(select 1 from public.event_team_members m where m.team_id=p_team_id and m.profile_id=r.profile_id);
  delete from public.event_team_members where team_id=p_team_id;
  update public.event_teams set status='cancelled',updated_at=now() where id=p_team_id;
  return jsonb_build_object('ok',true,'teamId',p_team_id,'status','cancelled');
end $$;

-- Bot-editable information and durable broadcast queue.
create table if not exists public.info_sections (
  key text primary key check(key ~ '^[a-z0-9_-]{2,40}$'),
  title text not null,
  body text not null,
  sort_order integer not null default 100,
  is_published boolean not null default true,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.info_sections(key,title,body,sort_order) values
 ('about','Что такое Megabattle','Информация скоро появится.',10),
 ('rules','Правила','Информация скоро появится.',20),
 ('events','Мероприятия','Информация скоро появится.',30),
 ('contacts','Контакты','Информация скоро появится.',40)
on conflict(key) do nothing;

create table if not exists public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id) on delete restrict,
  text text not null check(length(text) between 1 and 4000),
  media_file_id text,
  status text not null default 'draft' check(status in ('draft','queued','sending','sent','cancelled','failed')),
  total_count integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
alter table public.broadcasts add column if not exists idempotency_key text;
create unique index if not exists broadcasts_idempotency_key_idx on public.broadcasts(idempotency_key) where idempotency_key is not null;
alter table public.notification_queue add column if not exists broadcast_id uuid references public.broadcasts(id) on delete cascade;
create index if not exists notification_queue_broadcast_idx on public.notification_queue(broadcast_id,status);

create table if not exists public.achievement_grants (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  achievement_id uuid not null references public.achievements(id) on delete cascade,
  amount integer not null check(amount > 0),
  granted_by uuid references public.profiles(id) on delete set null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create or replace function public.grant_achievement(
  p_profile_id uuid,
  p_achievement_code text,
  p_amount integer,
  p_granted_by uuid,
  p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_achievement public.achievements%rowtype; v_grant uuid; v_total integer;
begin
  if p_amount < 1 then raise exception 'ACHIEVEMENT_AMOUNT_INVALID'; end if;
  select * into v_achievement from public.achievements where code=p_achievement_code for update;
  if v_achievement.id is null then raise exception 'ACHIEVEMENT_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_profile_id::text||':'||v_achievement.id::text,0));
  select id into v_grant from public.achievement_grants where idempotency_key=p_idempotency_key;
  if v_grant is not null then
    select pa.amount into v_total from public.achievement_grants ag
      join public.profile_achievements pa on pa.profile_id=ag.profile_id and pa.achievement_id=ag.achievement_id
      where ag.id=v_grant;
    return jsonb_build_object('ok',true,'grantId',v_grant,'amount',v_total,'duplicate',true);
  end if;
  insert into public.achievement_grants(profile_id,achievement_id,amount,granted_by,idempotency_key)
    values(p_profile_id,v_achievement.id,p_amount,p_granted_by,p_idempotency_key) returning id into v_grant;
  insert into public.profile_achievements(profile_id,achievement_id,amount,granted_by,granted_at)
    values(p_profile_id,v_achievement.id,p_amount,p_granted_by,now())
    on conflict(profile_id,achievement_id) do update
      set amount=public.profile_achievements.amount+excluded.amount,granted_by=excluded.granted_by,granted_at=now()
    returning amount into v_total;
  return jsonb_build_object('ok',true,'grantId',v_grant,'achievement',v_achievement.name,'amount',v_total,'duplicate',false);
end $$;

create or replace function public.claim_pending_notifications(p_limit integer default 100)
returns setof public.notification_queue language sql security definer set search_path=public as $$
  update public.notification_queue q set status='processing',attempts=q.attempts+1
  from (
    select id from public.notification_queue
    where status='pending' and scheduled_at<=now()
    order by scheduled_at for update skip locked limit greatest(1,least(p_limit,250))
  ) claimed where q.id=claimed.id returning q.*;
$$;

create or replace function public.claim_pending_integration_jobs(p_limit integer default 10)
returns setof public.integration_jobs language sql security definer set search_path=public as $$
  update public.integration_jobs j set status='processing',attempts=j.attempts+1,updated_at=now()
  from (
    select id from public.integration_jobs
    where status='pending' and run_after<=now()
    order by created_at for update skip locked limit greatest(1,least(p_limit,50))
  ) claimed where j.id=claimed.id returning j.*;
$$;

-- Current-season balances and leaderboards.
create or replace view public.current_currency_balances as
select p.id profile_id,p.nickname,p.faculty,c.code,c.name currency_name,coalesce(sum(ct.amount),0)::bigint balance
from public.profiles p
cross join public.currencies c
cross join public.seasons s
left join public.currency_transactions ct on ct.profile_id=p.id and ct.currency_id=c.id and ct.season_id=s.id
where s.is_active and c.is_active and not p.is_banned and p.deleted_at is null
group by p.id,p.nickname,p.faculty,c.code,c.name;

create or replace view public.current_faculty_balances as
select faculty,coalesce(sum(balance),0)::bigint balance
from public.current_currency_balances where faculty is not null group by faculty;

create or replace function public.participant_leaderboard(p_limit integer default 20)
returns table(place bigint,profile_id uuid,nickname text,full_name text,avatar_url text,xp bigint)
language sql security definer set search_path=public as $$
  select row_number() over(order by coalesce(sum(st.amount),0) desc,p.nickname),p.id,p.nickname,p.full_name,p.avatar_url,coalesce(sum(st.amount),0)::bigint
  from public.profiles p
  join public.profile_roles r on r.profile_id=p.id and r.role='participant'
  join public.seasons s on s.is_active
  left join public.score_transactions st on st.profile_id=p.id and st.season_id=s.id
  where not p.is_banned and p.deleted_at is null and p.onboarding_completed
  group by p.id order by coalesce(sum(st.amount),0) desc,p.nickname limit greatest(1,least(p_limit,2000));
$$;

-- Bot dashboard is seasonal and contains everything needed by the Mini App.
create or replace function public.participant_dashboard(p_telegram_user_id bigint)
returns jsonb language sql security definer set search_path=public as $$
  with target as (
    select p.* from public.account_identities i join public.profiles p on p.id=i.profile_id
    where i.provider='telegram' and i.provider_subject=p_telegram_user_id::text
  ), active_season as (select id,title from public.seasons where is_active limit 1),
  xp as (
    select coalesce(sum(st.amount),0)::integer value from target t cross join active_season s
    left join public.score_transactions st on st.profile_id=t.id and st.season_id=s.id
  ), current_level as (
    select l.* from public.game_levels l,xp where l.min_xp<=xp.value order by l.min_xp desc limit 1
  ), next_level as (
    select l.* from public.game_levels l,xp where l.min_xp>xp.value order by l.min_xp limit 1
  )
  select jsonb_build_object(
    'ok',true,
    'user',jsonb_build_object('id',t.id,'tgId',p_telegram_user_id,'name',t.nickname,'username',t.telegram_username,
      'avatarUrl',t.avatar_url,'faculty',t.faculty,'onboardingCompleted',t.onboarding_completed,
      'isManager',exists(select 1 from public.profile_roles r where r.profile_id=t.id and r.role in ('admin','site_admin'))),
    'season',(select to_jsonb(s) from active_season s),
    'stats',jsonb_build_object(
      'friends',(select count(*) from public.friendships f where f.status='active' and t.id in(f.requester_profile_id,f.receiver_profile_id)),
      'registrations',(select count(*) from public.event_registrations er where er.profile_id=t.id and er.status<>'cancelled'),
      'checkins',(select count(*) from public.event_registrations er where er.profile_id=t.id and er.status='attended')),
    'level',jsonb_build_object('xp',xp.value,'level',cl.level,'title',cl.title,'currentMinXp',cl.min_xp,
      'nextLevel',nl.level,'nextTitle',nl.title,'nextMinXp',nl.min_xp,'xpToNext',coalesce(nl.min_xp-xp.value,0),
      'percent',case when nl.level is null then 100 else round(100.0*(xp.value-cl.min_xp)/greatest(nl.min_xp-cl.min_xp,1)) end),
    'currencies',coalesce((select jsonb_agg(jsonb_build_object('code',b.code,'name',b.currency_name,'amount',b.balance))
      from public.current_currency_balances b where b.profile_id=t.id),'[]'::jsonb),
    'facultyBalance',coalesce((select balance from public.current_faculty_balances f where f.faculty=t.faculty),0),
    'achievements',coalesce((select jsonb_agg(jsonb_build_object('code',a.code,'name',a.name,'description',a.description,'iconUrl',a.icon_url,'amount',pa.amount))
      from public.profile_achievements pa join public.achievements a on a.id=pa.achievement_id where pa.profile_id=t.id),'[]'::jsonb),
    'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'title',e.name,'description',e.description,'startsAt',e.starts_at,
      'registrationStatus',e.registration_status,'registrationMode',e.registration_mode,'registrationLink',e.registration_link,
      'minTeamSize',e.min_team_size,'maxTeamSize',e.max_team_size,
      'registered',exists(select 1 from public.event_registrations er where er.event_id=e.id and er.profile_id=t.id and er.status<>'cancelled'))
      order by e.starts_at nulls last,e.sort_order) from public.project_events e where e.status='published' and e.group_key='megabattle'),'[]'::jsonb),
    'scoreHistory',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from
      (select id,amount,reason,source,created_at from public.score_transactions where profile_id=t.id and season_id=(select id from active_season) order by created_at desc limit 8)x),'[]'::jsonb),
    'currencyHistory',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from
      (select ct.id,ct.amount,ct.reason,ct.source,ct.created_at,c.name currency_name from public.currency_transactions ct join public.currencies c on c.id=ct.currency_id
       where ct.profile_id=t.id and ct.season_id=(select id from active_season) order by ct.created_at desc limit 8)x),'[]'::jsonb)
  )
  from target t cross join xp cross join current_level cl left join next_level nl on true;
$$;

-- Legacy callers may still use this RPC during a rolling deploy. It no longer touches auth.users.
create or replace function public.upsert_telegram_identity(
  p_telegram_user_id bigint,p_username text,p_first_name text,p_last_name text,p_photo_url text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_profile_id uuid; v_full_name text; v_roles jsonb;
begin
  v_full_name:=trim(concat_ws(' ',p_first_name,p_last_name));
  select profile_id into v_profile_id from public.account_identities where provider='telegram' and provider_subject=p_telegram_user_id::text;
  if v_profile_id is null then
    insert into public.profiles(nickname,full_name,avatar_url,telegram_username)
      values(coalesce(nullif(p_username,''),nullif(v_full_name,''),'user_'||right(p_telegram_user_id::text,6)),nullif(v_full_name,''),p_photo_url,p_username)
      returning id into v_profile_id;
    insert into public.account_identities(profile_id,provider,provider_subject,username,metadata,verified_at)
      values(v_profile_id,'telegram',p_telegram_user_id::text,p_username,jsonb_build_object('first_name',p_first_name,'last_name',p_last_name,'photo_url',p_photo_url),now());
    insert into public.profile_roles(profile_id,role) values(v_profile_id,'participant') on conflict do nothing;
  else
    update public.profiles set telegram_username=coalesce(p_username,telegram_username),avatar_url=coalesce(p_photo_url,avatar_url),updated_at=now() where id=v_profile_id;
    update public.account_identities set username=p_username,metadata=jsonb_build_object('first_name',p_first_name,'last_name',p_last_name,'photo_url',p_photo_url),verified_at=now(),updated_at=now()
      where provider='telegram' and provider_subject=p_telegram_user_id::text;
  end if;
  select coalesce(jsonb_agg(role),'[]'::jsonb) into v_roles from public.profile_roles where profile_id=v_profile_id;
  return jsonb_build_object('profileId',v_profile_id,'telegramId',p_telegram_user_id,'roles',v_roles);
end $$;

create or replace function public.redeem_reward_code(p_profile_id uuid,p_code_hash text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_code public.reward_codes%rowtype; v_used integer; v_personal integer; v_currency uuid; v_season uuid;
begin
  select * into v_code from public.reward_codes where code_hash=p_code_hash for update;
  if v_code.id is null or not v_code.is_active then raise exception 'CODE_NOT_FOUND'; end if;
  if v_code.starts_at is not null and v_code.starts_at>now() then raise exception 'CODE_NOT_STARTED'; end if;
  if v_code.expires_at is not null and v_code.expires_at<now() then raise exception 'CODE_EXPIRED'; end if;
  select id into v_season from public.seasons where is_active;
  if v_season is null then raise exception 'NO_ACTIVE_SEASON'; end if;
  select count(*),count(*) filter(where profile_id=p_profile_id) into v_used,v_personal from public.reward_code_redemptions where reward_code_id=v_code.id;
  if v_code.max_redemptions is not null and v_used>=v_code.max_redemptions then raise exception 'CODE_LIMIT'; end if;
  if v_personal>=v_code.per_profile_limit then raise exception 'CODE_ALREADY_USED'; end if;
  insert into public.reward_code_redemptions(reward_code_id,profile_id) values(v_code.id,p_profile_id);
  if v_code.xp_amount<>0 then insert into public.score_transactions(profile_id,season_id,amount,reason,source,idempotency_key)
    values(p_profile_id,v_season,v_code.xp_amount,v_code.label,'code','reward:'||v_code.id||':'||p_profile_id||':xp:'||(v_personal+1)); end if;
  if v_code.currency_code is not null and coalesce(v_code.currency_amount,0)<>0 then
    select id into v_currency from public.currencies where code=v_code.currency_code and is_active;
    insert into public.currency_transactions(profile_id,season_id,currency_id,amount,reason,source,idempotency_key)
      values(p_profile_id,v_season,v_currency,trunc(v_code.currency_amount),v_code.label,'code','reward:'||v_code.id||':'||p_profile_id||':currency:'||(v_personal+1));
  end if;
  return jsonb_build_object('ok',true,'label',v_code.label,'xp',v_code.xp_amount,'currencyCode',v_code.currency_code,'currencyAmount',trunc(v_code.currency_amount));
end $$;

alter table public.currency_transfers enable row level security;
alter table public.event_teams enable row level security;
alter table public.event_team_members enable row level security;
alter table public.info_sections enable row level security;
alter table public.broadcasts enable row level security;
-- No direct client policies: all mutations go through the backend service role.

insert into public.backend_schema_versions(version) values('202607160003_beta_core') on conflict do nothing;
