-- Switch the Bulk SMS provider from the previous draft integration to SMSNotifyGH.
-- This migration is self-contained so it also works when the prior SMS draft
-- migration (202611050005_arkesel_bulk_sms.sql) has not been applied.
alter table public.bulk_sms_campaigns
  drop constraint if exists bulk_sms_campaigns_status_check;
alter table public.bulk_sms_campaigns
  add constraint bulk_sms_campaigns_status_check
  check (status in ('preview_only','sending','sent','partial','failed'));
alter table public.bulk_sms_campaigns
  add column if not exists sent_count integer not null default 0 check (sent_count >= 0),
  add column if not exists failed_count integer not null default 0 check (failed_count >= 0),
  add column if not exists provider text not null default 'smsnotifygh',
  add column if not exists sent_at timestamptz;

create table if not exists public.sms_provider_settings (
  id boolean primary key default true check (id),
  provider text not null default 'smsnotifygh',
  sender_id text not null default '' check (length(sender_id) <= 11),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
-- Remove the previous provider restriction before inserting/updating the row.
alter table public.sms_provider_settings
  drop constraint if exists sms_provider_settings_provider_check;
update public.sms_provider_settings set provider='smsnotifygh' where id=true;
alter table public.sms_provider_settings enable row level security;
revoke all on public.sms_provider_settings from anon, authenticated;
grant select, insert, update on public.sms_provider_settings to authenticated;
drop policy if exists "Admins manage SMS provider settings" on public.sms_provider_settings;
create policy "Admins manage SMS provider settings" on public.sms_provider_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
insert into public.sms_provider_settings(id, provider, sender_id)
values (true, 'smsnotifygh', '') on conflict (id) do nothing;

create or replace function public.touch_sms_provider_settings()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  return new;
end;
$$;
drop trigger if exists touch_sms_provider_settings_updated_at on public.sms_provider_settings;
create trigger touch_sms_provider_settings_updated_at before insert or update
  on public.sms_provider_settings for each row execute procedure public.touch_sms_provider_settings();

alter table public.sms_provider_settings
  alter column provider set default 'smsnotifygh';
alter table public.sms_provider_settings
  add constraint sms_provider_settings_provider_check check (provider='smsnotifygh');
alter table public.bulk_sms_campaigns
  alter column provider set default 'smsnotifygh';
