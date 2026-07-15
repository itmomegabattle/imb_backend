-- Megabattle profile/NFC MVP schema.
-- Run this in Supabase SQL editor after creating the project.
-- Auth UI uses Supabase email/password with synthetic emails:
-- <isu_number>@isu.megabattle.ru

create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  isu_number text not null unique,
  nickname text not null,
  full_name text,
  faculty text,
  bio text,
  avatar_url text,
  telegram_username text,
  instagram_username text,
  social_links jsonb not null default '[]'::jsonb,
  megaballs integer not null default 0,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nfc_tags (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  profile_id uuid references public.profiles(id) on delete set null,
  label text,
  tag_type text check (tag_type in ('keychain', 'card', 'removable', 'sticker', 'other')) default 'other',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  claimed_at timestamptz
);

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_profile_id uuid not null references public.profiles(id) on delete cascade,
  receiver_profile_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'hidden', 'blocked')),
  created_at timestamptz not null default now(),
  unique (requester_profile_id, receiver_profile_id),
  check (requester_profile_id <> receiver_profile_id)
);

create table if not exists public.profile_views (
  id uuid primary key default gen_random_uuid(),
  viewer_profile_id uuid references public.profiles(id) on delete set null,
  viewed_profile_id uuid not null references public.profiles(id) on delete cascade,
  nfc_tag_id uuid references public.nfc_tags(id) on delete set null,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    auth_user_id,
    isu_number,
    nickname,
    full_name,
    faculty
  )
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'isu_number', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'nickname', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'faculty'
  )
  on conflict (auth_user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.nfc_tags enable row level security;
alter table public.friendships enable row level security;
alter table public.profile_views enable row level security;

drop policy if exists "profiles are public readable" on public.profiles;
create policy "profiles are public readable"
on public.profiles for select
using (true);

drop policy if exists "users insert own profile" on public.profiles;
create policy "users insert own profile"
on public.profiles for insert
with check (auth.uid() = auth_user_id);

drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile"
on public.profiles for update
using (auth.uid() = auth_user_id)
with check (auth.uid() = auth_user_id);

drop policy if exists "nfc tags are public readable" on public.nfc_tags;
create policy "nfc tags are public readable"
on public.nfc_tags for select
using (true);

drop policy if exists "authenticated users create unclaimed nfc tags" on public.nfc_tags;
create policy "authenticated users create unclaimed nfc tags"
on public.nfc_tags for insert
to authenticated
with check (profile_id is null);

drop policy if exists "users claim free nfc tags" on public.nfc_tags;
create policy "users claim free nfc tags"
on public.nfc_tags for update
to authenticated
using (
  profile_id is null
  or exists (
    select 1 from public.profiles
    where profiles.id = nfc_tags.profile_id
      and profiles.auth_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = nfc_tags.profile_id
      and profiles.auth_user_id = auth.uid()
  )
);

drop policy if exists "friendships are public readable" on public.friendships;
create policy "friendships are public readable"
on public.friendships for select
using (status = 'active');

drop policy if exists "users create own friendships" on public.friendships;
create policy "users create own friendships"
on public.friendships for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = friendships.requester_profile_id
      and profiles.auth_user_id = auth.uid()
  )
);

drop policy if exists "users can log profile views" on public.profile_views;
create policy "users can log profile views"
on public.profile_views for insert
with check (
  viewer_profile_id is null
  or exists (
    select 1 from public.profiles
    where profiles.id = profile_views.viewer_profile_id
      and profiles.auth_user_id = auth.uid()
  )
);

drop policy if exists "profile views are readable by admins or participants" on public.profile_views;
create policy "profile views are readable by admins or participants"
on public.profile_views for select
using (
  exists (
    select 1 from public.profiles
    where profiles.auth_user_id = auth.uid()
      and (profiles.is_admin or profiles.id = profile_views.viewer_profile_id or profiles.id = profile_views.viewed_profile_id)
  )
);

insert into storage.buckets (id, name, public)
values ('profile-avatars', 'profile-avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatars are public readable" on storage.objects;
create policy "avatars are public readable"
on storage.objects for select
using (bucket_id = 'profile-avatars');

drop policy if exists "authenticated users upload avatars" on storage.objects;
create policy "authenticated users upload avatars"
on storage.objects for insert
to authenticated
with check (bucket_id = 'profile-avatars');

drop policy if exists "authenticated users update avatars" on storage.objects;
create policy "authenticated users update avatars"
on storage.objects for update
to authenticated
using (bucket_id = 'profile-avatars')
with check (bucket_id = 'profile-avatars');

-- Admin panel MVP.
-- First bootstrap admin: ISU 466870.

alter table public.profiles
  add column if not exists is_banned boolean not null default false,
  add column if not exists ban_reason text,
  add column if not exists is_best_actor boolean not null default false,
  add column if not exists role_badge text;

update public.profiles
set is_admin = true
where isu_number = '466870';

create or replace function public.current_profile_is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where auth_user_id = auth.uid()
      and (is_admin = true or isu_number = '466870')
      and is_banned = false
  );
$$;

create or replace function public.protect_profile_admin_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.current_profile_is_admin()
    and (
      old.is_admin is distinct from new.is_admin
      or old.is_banned is distinct from new.is_banned
      or old.ban_reason is distinct from new.ban_reason
      or old.is_best_actor is distinct from new.is_best_actor
      or old.role_badge is distinct from new.role_badge
    )
  then
    raise exception 'Only admins can change moderation fields';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_protect_admin_fields on public.profiles;
create trigger profiles_protect_admin_fields
before update on public.profiles
for each row execute function public.protect_profile_admin_fields();

drop policy if exists "admins can manage profiles" on public.profiles;
create policy "admins can manage profiles"
on public.profiles for all
to authenticated
using (public.current_profile_is_admin())
with check (public.current_profile_is_admin());

create table if not exists public.project_events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  group_key text not null check (group_key in ('megabattle', 'partners')),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  name text not null,
  type text,
  description text,
  event_date_label text,
  event_time_label text,
  location text,
  image_url text,
  details jsonb not null default '[]'::jsonb,
  registration_status text not null default 'soon' check (registration_status in ('open', 'soon', 'closed')),
  registration_label text,
  registration_link text,
  itmo_events_id text,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists project_events_set_updated_at on public.project_events;
create trigger project_events_set_updated_at
before update on public.project_events
for each row execute function public.set_updated_at();

insert into public.project_events
  (slug, group_key, status, name, type, description, event_date_label, event_time_label, location, image_url, details, registration_status, registration_label, registration_link, sort_order)
values
  ('quiz', 'megabattle', 'published', 'Квиз', 'интеллектуальная битва', 'Командная игра для факультетов: быстрые вопросы, музыкальные и визуальные раунды, мемы, логика и немного хаоса. Хорошая точка входа для тех, кто хочет почувствовать сезон без сцены и репетиций.', 'дата уточняется', 'вечер', 'Университет ИТМО', '/images/events/event1.jpg', '["команды от факультетов", "баллы в общий зачёт", "формат для новичков"]'::jsonb, 'soon', 'Регистрация скоро', '', 10),
  ('quest', 'megabattle', 'published', 'Квест', 'маршрут · задания · город', 'Большой маршрут с заданиями, шифрами и точками взаимодействия. Команды двигаются по локациям, собирают подсказки, выполняют челленджи и забирают очки за скорость, смекалку и командность.', 'дата уточняется', 'день', 'кампус и городские точки', '/images/events/event2.jpg', '["несколько локаций", "факультетские команды", "фото- и видео-задания"]'::jsonb, 'soon', 'Регистрация скоро', '', 20),
  ('gala', 'megabattle', 'published', 'Гала-концерт', 'главная сцена сезона', 'Финальная большая сцена Megabattle: номера факультетов, награды, лучшие участники, общий рейтинг и тот самый момент, когда весь сезон превращается в одну большую историю.', 'дата уточняется', 'вечер', 'площадка будет объявлена позже', '/images/events/event1.jpg', '["главное событие", "номера факультетов", "награждение"]'::jsonb, 'closed', 'Регистрация пока закрыта', '', 30),
  ('game', 'megabattle', 'published', 'Game', 'игровой формат', 'Соревновательный игровой вечер: настолки, консоли, быстрые турниры и командные механики. Формат для тех, кто хочет принести факультету очки без микрофона, но с азартом.', 'дата уточняется', 'вечер', 'Университет ИТМО', '/images/events/event2.jpg', '["турнирные сетки", "командные очки", "несколько игровых зон"]'::jsonb, 'soon', 'Регистрация скоро', '', 40),
  ('special-event', 'megabattle', 'published', 'Special Event', 'секретный формат', 'Отдельный специвент сезона, который лучше не спойлерить заранее. Здесь можно будет быстро заменить описание на финальный анонс из админки или базы.', 'дата уточняется', 'следите за анонсами', 'будет объявлено в каналах проекта', '/images/about-image.png', '["секретный формат", "ограниченное число мест", "анонс в соцсетях"]'::jsonb, 'closed', 'Анонс скоро', '', 50),
  ('chto', 'partners', 'published', 'Творческое объединение «Что»', 'театр · перформанс · творческая лаборатория', 'Партнёрское творческое объединение для тех, кто хочет пробовать театр, перформанс, актёрские практики и сценические эксперименты вне основной сетки Megabattle.', 'по расписанию объединения', 'анонсы в Telegram', 'площадки ИТМО и партнёров', '/images/events/event1.jpg', '["театр", "сценическая практика", "@chtotheatre"]'::jsonb, 'open', 'Перейти в Telegram', 'https://t.me/chtotheatre', 60),
  ('fashion-show', 'partners', 'published', 'Fashion Show', 'мода · стиль · показ', 'Партнёрский fashion-формат про стиль, показы, визуальные образы и командную работу вокруг моды. Отличная точка для тех, кто хочет в костюм, продакшен, подиум или backstage.', 'по расписанию команды', 'анонсы в Telegram', 'площадки ИТМО', '/images/events/event2.jpg', '["показы", "стиль", "@itmo_fashion"]'::jsonb, 'open', 'Перейти в Telegram', 'https://t.me/itmo_fashion', 70),
  ('lab-sport', 'partners', 'published', 'ЛАБ', 'футбол · баскетбол · волейбол', 'Спортивное направление для тех, кто хочет играть за свою команду и собирать вокруг факультета отдельный соревновательный вайб: футбол, баскетбол, волейбол и командные активности.', 'по спортивному календарю', 'тренировки и игры', 'спортивные площадки ИТМО', '/images/about-image.png', '["футбол", "баскетбол", "волейбол"]'::jsonb, 'closed', 'Контакты появятся позже', '', 80),
  ('punchline', 'partners', 'published', 'Панчлайн', 'стендап · юмор · открытый микрофон', 'Партнёрский юмористический формат: стендап, открытые микрофоны, авторские тексты и сцена для тех, кто хочет проверять шутки на живой аудитории.', 'по расписанию клуба', 'анонсы в Telegram', 'площадки ИТМО', '/images/events/event1.jpg', '["стендап", "открытый микрофон", "@itmopunchline"]'::jsonb, 'open', 'Перейти в Telegram', 'https://t.me/itmopunchline', 90)
on conflict (slug) do update set
  group_key = excluded.group_key,
  name = excluded.name,
  type = excluded.type,
  description = excluded.description,
  event_date_label = excluded.event_date_label,
  event_time_label = excluded.event_time_label,
  location = excluded.location,
  image_url = excluded.image_url,
  details = excluded.details,
  registration_status = excluded.registration_status,
  registration_label = excluded.registration_label,
  registration_link = excluded.registration_link,
  sort_order = excluded.sort_order;

create table if not exists public.project_passwords (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  login text,
  password_value text,
  url text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists project_passwords_set_updated_at on public.project_passwords;
create trigger project_passwords_set_updated_at
before update on public.project_passwords
for each row execute function public.set_updated_at();

create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  source_key text,
  section text not null check (section in ('organizers', 'responsible')),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  name text not null,
  activity text,
  role text,
  description text,
  links jsonb not null default '[]'::jsonb,
  small_image_url text,
  big_image_url text,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.team_members
drop constraint if exists team_members_source_key_key;

create unique index if not exists team_members_section_source_key_key
on public.team_members (section, source_key);

drop trigger if exists team_members_set_updated_at on public.team_members;
create trigger team_members_set_updated_at
before update on public.team_members
for each row execute function public.set_updated_at();

create table if not exists public.partners (
  id uuid primary key default gen_random_uuid(),
  source_key text unique,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  name text not null,
  description text,
  logo_url text,
  link text,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists partners_set_updated_at on public.partners;
create trigger partners_set_updated_at
before update on public.partners
for each row execute function public.set_updated_at();

create table if not exists public.participant_stories (
  id uuid primary key default gen_random_uuid(),
  source_key text unique,
  status text not null default 'draft' check (status in ('draft', 'pending', 'published', 'archived', 'rejected')),
  name text not null,
  faculty text,
  description text,
  story_date_label text,
  image_url text,
  sort_order integer not null default 100,
  submitter_profile_id uuid references public.profiles(id) on delete set null,
  submitter_contact text,
  moderation_comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.participant_stories
  drop constraint if exists participant_stories_status_check;

alter table public.participant_stories
  add constraint participant_stories_status_check
  check (status in ('draft', 'pending', 'published', 'archived', 'rejected'));

alter table public.participant_stories
  add column if not exists submitter_profile_id uuid references public.profiles(id) on delete set null,
  add column if not exists submitter_contact text,
  add column if not exists moderation_comment text;

drop trigger if exists participant_stories_set_updated_at on public.participant_stories;
create trigger participant_stories_set_updated_at
before update on public.participant_stories
for each row execute function public.set_updated_at();

create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.project_events enable row level security;
alter table public.project_passwords enable row level security;
alter table public.team_members enable row level security;
alter table public.partners enable row level security;
alter table public.participant_stories enable row level security;
alter table public.admin_audit_logs enable row level security;

drop policy if exists "published events are public readable" on public.project_events;
create policy "published events are public readable"
on public.project_events for select
using (status = 'published');

drop policy if exists "admins can manage events" on public.project_events;
create policy "admins can manage events"
on public.project_events for all
to authenticated
using (public.current_profile_is_admin())
with check (public.current_profile_is_admin());

drop policy if exists "admins can manage passwords" on public.project_passwords;
create policy "admins can manage passwords"
on public.project_passwords for all
to authenticated
using (public.current_profile_is_admin())
with check (public.current_profile_is_admin());

drop policy if exists "published team members are public readable" on public.team_members;
create policy "published team members are public readable"
on public.team_members for select
using (status = 'published');

drop policy if exists "admins can manage team members" on public.team_members;
create policy "admins can manage team members"
on public.team_members for all
to authenticated
using (public.current_profile_is_admin())
with check (public.current_profile_is_admin());

drop policy if exists "published partners are public readable" on public.partners;
create policy "published partners are public readable"
on public.partners for select
using (status = 'published');

drop policy if exists "admins can manage partners" on public.partners;
create policy "admins can manage partners"
on public.partners for all
to authenticated
using (public.current_profile_is_admin())
with check (public.current_profile_is_admin());

drop policy if exists "published participant stories are public readable" on public.participant_stories;
create policy "published participant stories are public readable"
on public.participant_stories for select
using (status = 'published');

drop policy if exists "users can read own submitted participant stories" on public.participant_stories;
create policy "users can read own submitted participant stories"
on public.participant_stories for select
to authenticated
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = participant_stories.submitter_profile_id
      and profiles.auth_user_id = auth.uid()
  )
);

drop policy if exists "users can submit participant stories" on public.participant_stories;
create policy "users can submit participant stories"
on public.participant_stories for insert
to authenticated
with check (
  status = 'pending'
  and exists (
    select 1
    from public.profiles
    where profiles.id = participant_stories.submitter_profile_id
      and profiles.auth_user_id = auth.uid()
  )
);

drop policy if exists "admins can manage participant stories" on public.participant_stories;
create policy "admins can manage participant stories"
on public.participant_stories for all
to authenticated
using (public.current_profile_is_admin())
with check (public.current_profile_is_admin());

drop policy if exists "admins can read audit logs" on public.admin_audit_logs;
create policy "admins can read audit logs"
on public.admin_audit_logs for select
to authenticated
using (public.current_profile_is_admin());

drop policy if exists "admins can create audit logs" on public.admin_audit_logs;
create policy "admins can create audit logs"
on public.admin_audit_logs for insert
to authenticated
with check (public.current_profile_is_admin());

drop policy if exists "admins can manage nfc tags" on public.nfc_tags;
create policy "admins can manage nfc tags"
on public.nfc_tags for all
to authenticated
using (public.current_profile_is_admin())
with check (public.current_profile_is_admin());

drop policy if exists "admins can manage friendships" on public.friendships;
create policy "admins can manage friendships"
on public.friendships for all
to authenticated
using (public.current_profile_is_admin())
with check (public.current_profile_is_admin());

insert into storage.buckets (id, name, public)
values ('event-images', 'event-images', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('team-images', 'team-images', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('content-images', 'content-images', true)
on conflict (id) do nothing;

drop policy if exists "event images are public readable" on storage.objects;
create policy "event images are public readable"
on storage.objects for select
using (bucket_id = 'event-images');

drop policy if exists "admins upload event images" on storage.objects;
create policy "admins upload event images"
on storage.objects for insert
to authenticated
with check (bucket_id = 'event-images' and public.current_profile_is_admin());

drop policy if exists "admins update event images" on storage.objects;
create policy "admins update event images"
on storage.objects for update
to authenticated
using (bucket_id = 'event-images' and public.current_profile_is_admin())
with check (bucket_id = 'event-images' and public.current_profile_is_admin());

drop policy if exists "admins delete event images" on storage.objects;
create policy "admins delete event images"
on storage.objects for delete
to authenticated
using (bucket_id = 'event-images' and public.current_profile_is_admin());

drop policy if exists "team images are public readable" on storage.objects;
create policy "team images are public readable"
on storage.objects for select
using (bucket_id = 'team-images');

drop policy if exists "admins upload team images" on storage.objects;
create policy "admins upload team images"
on storage.objects for insert
to authenticated
with check (bucket_id = 'team-images' and public.current_profile_is_admin());

drop policy if exists "admins update team images" on storage.objects;
create policy "admins update team images"
on storage.objects for update
to authenticated
using (bucket_id = 'team-images' and public.current_profile_is_admin())
with check (bucket_id = 'team-images' and public.current_profile_is_admin());

drop policy if exists "admins delete team images" on storage.objects;
create policy "admins delete team images"
on storage.objects for delete
to authenticated
using (bucket_id = 'team-images' and public.current_profile_is_admin());

drop policy if exists "content images are public readable" on storage.objects;
create policy "content images are public readable"
on storage.objects for select
using (bucket_id = 'content-images');

drop policy if exists "admins upload content images" on storage.objects;
create policy "admins upload content images"
on storage.objects for insert
to authenticated
with check (bucket_id = 'content-images' and public.current_profile_is_admin());

drop policy if exists "users upload story submission images" on storage.objects;
create policy "users upload story submission images"
on storage.objects for insert
to authenticated
with check (bucket_id = 'content-images' and name like 'story-submissions/%');

drop policy if exists "admins update content images" on storage.objects;
create policy "admins update content images"
on storage.objects for update
to authenticated
using (bucket_id = 'content-images' and public.current_profile_is_admin())
with check (bucket_id = 'content-images' and public.current_profile_is_admin());

drop policy if exists "admins delete content images" on storage.objects;
create policy "admins delete content images"
on storage.objects for delete
to authenticated
using (bucket_id = 'content-images' and public.current_profile_is_admin());
