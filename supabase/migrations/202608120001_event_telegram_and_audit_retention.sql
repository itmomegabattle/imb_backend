-- Keep the event editor contract aligned with project_events.
alter table public.project_events
  add column if not exists telegram_label text,
  add column if not exists telegram_link text;

-- The admin journal is intentionally a short operational feed, not an archive.
create or replace function public.trim_audit_logs(p_keep integer default 10)
returns void language sql security definer set search_path = public as $$
  delete from public.audit_logs where id in (
    select id
    from public.audit_logs
    order by created_at desc, id desc
    offset greatest(p_keep, 10)
  );
$$;

select public.trim_audit_logs(10);

-- Admin profile deletion is a real database deletion. Content authored by the
-- removed account survives under the acting admin; personal activity does not.
create or replace function public.delete_profile_hard(
  p_profile_id uuid,
  p_replacement_profile_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_profile_id = p_replacement_profile_id then
    raise exception 'CANNOT_DELETE_OWN_PROFILE';
  end if;

  if not exists (select 1 from public.profiles where id = p_replacement_profile_id) then
    raise exception 'REPLACEMENT_PROFILE_NOT_FOUND';
  end if;

  update public.broadcasts
  set created_by = p_replacement_profile_id
  where created_by = p_profile_id;

  delete from public.currency_transfers
  where sender_profile_id = p_profile_id
     or receiver_profile_id = p_profile_id;

  delete from public.event_teams
  where captain_profile_id = p_profile_id;

  delete from public.profiles where id = p_profile_id;
end;
$$;

revoke all on function public.delete_profile_hard(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_profile_hard(uuid, uuid) to service_role;
