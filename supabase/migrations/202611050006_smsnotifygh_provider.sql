-- Switch the Bulk SMS provider from the previous draft integration to SMSNotifyGH.
alter table public.sms_provider_settings
  alter column provider set default 'smsnotifygh';
alter table public.sms_provider_settings
  drop constraint if exists sms_provider_settings_provider_check;
alter table public.sms_provider_settings
  add constraint sms_provider_settings_provider_check check (provider='smsnotifygh');
update public.sms_provider_settings set provider='smsnotifygh' where id=true;
alter table public.bulk_sms_campaigns
  alter column provider set default 'smsnotifygh';
