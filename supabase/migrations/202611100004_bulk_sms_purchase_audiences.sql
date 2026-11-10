-- Add date-based audience choices for recent paid buyers in Ghana time (UTC).
alter table public.bulk_sms_campaigns
  drop constraint if exists bulk_sms_campaigns_audience_check;

alter table public.bulk_sms_campaigns
  add constraint bulk_sms_campaigns_audience_check check (
    audience in (
      'all_agents',
      'overdraft_agents',
      'negative_balance_agents',
      'all_customers',
      'today_customers',
      'yesterday_customers',
      'custom_numbers'
    )
  );
