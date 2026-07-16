begin;

do $$
declare
  v_sender uuid;
  v_receiver uuid;
  v_third uuid;
  v_season uuid;
  v_currency uuid;
  v_event uuid;
  v_team uuid;
  v_achievement uuid;
  v_result jsonb;
  v_balance bigint;
begin
  insert into public.profiles(nickname,faculty,onboarding_completed) values
    ('test_sender','КТУ',true),('test_receiver','ТИНТ',true),('test_third','НОЖ',true);
  select id into v_sender from public.profiles where nickname='test_sender';
  select id into v_receiver from public.profiles where nickname='test_receiver';
  select id into v_third from public.profiles where nickname='test_third';
  select id into v_season from public.seasons where is_active;
  select id into v_currency from public.currencies where code='credits';

  insert into public.currency_transactions(profile_id,season_id,currency_id,amount,reason,source,idempotency_key)
    values(v_sender,v_season,v_currency,100,'test seed','system','test:seed');
  v_result := public.transfer_currency(v_sender,v_receiver,10,'test:transfer','credits');
  if not (v_result->>'ok')::boolean then raise exception 'transfer did not succeed'; end if;
  select balance into v_balance from public.current_currency_balances where profile_id=v_sender and code='credits';
  if v_balance <> 90 then raise exception 'sender balance is %, expected 90',v_balance; end if;
  select balance into v_balance from public.current_currency_balances where profile_id=v_receiver and code='credits';
  if v_balance <> 10 then raise exception 'receiver balance is %, expected 10',v_balance; end if;
  v_result := public.transfer_currency(v_sender,v_receiver,10,'test:transfer','credits');
  if not (v_result->>'duplicate')::boolean then raise exception 'idempotent retry was not detected'; end if;
  select balance into v_balance from public.current_currency_balances where profile_id=v_sender and code='credits';
  if v_balance <> 90 then raise exception 'idempotent retry changed sender balance'; end if;
  begin
    perform public.transfer_currency(v_sender,v_receiver,9,'test:too-small','credits');
    raise exception 'minimum transfer constraint was not enforced';
  exception when others then
    if sqlerrm='minimum transfer constraint was not enforced' then raise; end if;
  end;

  insert into public.achievements(code,name,description)
    values('test-permanent','Test permanent achievement','Idempotency test')
    returning id into v_achievement;
  v_result := public.grant_achievement(v_sender,'test-permanent',1,v_sender,'test:achievement');
  if (v_result->>'duplicate')::boolean then raise exception 'first achievement grant marked duplicate'; end if;
  v_result := public.grant_achievement(v_sender,'test-permanent',1,v_sender,'test:achievement');
  if not (v_result->>'duplicate')::boolean then raise exception 'achievement retry was not idempotent'; end if;
  if (select amount from public.profile_achievements where profile_id=v_sender and achievement_id=v_achievement) <> 1
    then raise exception 'achievement was granted more than once'; end if;

  insert into public.project_events(slug,group_key,status,name,registration_status,registration_mode,min_team_size,max_team_size,registration_closes_at)
    values('test-team-event','megabattle','published','Test team event','open','internal_team',2,3,now()+interval '1 day')
    returning id into v_event;
  v_result := public.create_event_team(v_event,v_sender,'Test team','hash-one','CODE1');
  v_team := (v_result->'team'->>'id')::uuid;
  perform public.join_event_team(v_receiver,'hash-one');
  v_result := public.complete_event_team(v_team,v_sender);
  if (v_result->>'members')::integer <> 2 then raise exception 'team registration member count mismatch'; end if;
  if (select count(*) from public.event_registrations where event_id=v_event and status='registered') <> 2
    then raise exception 'team registrations were not created atomically'; end if;

  begin
    perform public.create_event_team(v_event,v_receiver,'Second team','hash-two','CODE2');
    raise exception 'duplicate team membership was not rejected';
  exception when others then
    if sqlerrm='duplicate team membership was not rejected' then raise; end if;
  end;
  perform public.cancel_event_team(v_team,v_sender);
  if exists(select 1 from public.event_team_members where team_id=v_team) then raise exception 'cancelled team still has members'; end if;
  if exists(select 1 from public.event_registrations where event_id=v_event and status<>'cancelled') then raise exception 'cancelled team still has active registrations'; end if;
  perform public.create_event_team(v_event,v_receiver,'Second team','hash-two','CODE2');
  perform public.start_new_season('test-next-season','Test next season',now(),now()+interval '30 days');
  if (select count(*) from public.seasons where is_active) <> 1 then raise exception 'more than one active season'; end if;
  select balance into v_balance from public.current_currency_balances where profile_id=v_sender and code='credits';
  if v_balance <> 0 then raise exception 'new season did not reset current balance'; end if;
  if v_third is null then raise exception 'third test profile missing'; end if;
end $$;

rollback;
