-- Faculty leaderboard rows share the content pipeline with team members.
alter table public.team_members
  drop constraint if exists team_members_section_check;

alter table public.team_members
  add constraint team_members_section_check
  check (section in ('organizers', 'responsible', 'contributors', 'faculty-ratings'));
