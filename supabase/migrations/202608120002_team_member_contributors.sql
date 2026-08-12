-- Removed organizers/responsible people remain available for the historical
-- contributors cloud, so this is a real content section rather than a client-only fallback.
alter table public.team_members
  drop constraint if exists team_members_section_check;

alter table public.team_members
  add constraint team_members_section_check
  check (section in ('organizers', 'responsible', 'contributors'));
