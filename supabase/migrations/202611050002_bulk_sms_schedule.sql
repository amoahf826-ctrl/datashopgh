-- Store an admin-selected planned send time on existing SMS preview records.
alter table public.bulk_sms_campaigns
  add column if not exists scheduled_for timestamptz;

create index if not exists bulk_sms_campaigns_scheduled_for_idx
  on public.bulk_sms_campaigns (scheduled_for)
  where scheduled_for is not null;
