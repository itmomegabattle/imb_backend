-- Adds participant story proposals: regular users submit, admins approve/reject.

alter table public.participant_stories
  drop constraint if exists participant_stories_status_check;

alter table public.participant_stories
  add constraint participant_stories_status_check
  check (status in ('draft', 'pending', 'published', 'archived', 'rejected'));

alter table public.participant_stories
  add column if not exists submitter_profile_id uuid references public.profiles(id) on delete set null,
  add column if not exists submitter_contact text,
  add column if not exists moderation_comment text;

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

drop policy if exists "users upload story submission images" on storage.objects;
create policy "users upload story submission images"
on storage.objects for insert
to authenticated
with check (bucket_id = 'content-images' and name like 'story-submissions/%');
