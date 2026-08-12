-- The events page exposes a separate group for off-site events.
alter table public.project_events
  drop constraint if exists project_events_group_key_check;

alter table public.project_events
  add constraint project_events_group_key_check
  check (group_key in ('megabattle', 'outings', 'partners'));
