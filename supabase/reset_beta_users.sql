-- ОДНОРАЗОВЫЙ сброс участников перед закрытой бетой.
-- Контент сайта (люди, партнёры, мероприятия и опубликованные истории) сохраняется.
begin;
delete from public.notification_queue;
delete from public.broadcasts;
delete from public.event_teams;
delete from public.event_registrations;
delete from public.currency_transfers;
delete from public.currency_transactions;
delete from public.score_transactions;
delete from public.profile_achievements;
delete from public.reward_code_redemptions;
delete from public.friendships;
delete from public.profile_views;
delete from public.nfc_tags;
delete from public.temporary_media;
delete from public.notification_preferences;
delete from public.auth_exchange_codes;
delete from public.account_identities;
delete from public.profile_roles;
update public.participant_stories set submitter_profile_id=null where submitter_profile_id is not null;
update public.reward_codes set created_by=null where created_by is not null;
update public.info_sections set updated_by=null where updated_by is not null;
update public.vault_entries set created_by=null,updated_by=null where created_by is not null or updated_by is not null;
update public.audit_logs set actor_profile_id=null where actor_profile_id is not null;
delete from public.profiles;
delete from auth.users;
commit;
