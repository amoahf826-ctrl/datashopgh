-- Number verification routing is independent from bundle delivery routing.
alter table public.platform_settings drop constraint if exists platform_settings_key_check;
alter table public.platform_settings add constraint platform_settings_key_check
  check (key in (
    'storefront_maintenance','agent_dashboard_maintenance','storefront_live_sales',
    'wallet_deposits_enabled','active_bundle_provider','number_verification_provider',
    'storefront_contact','paystack_fee_recovery','agent_cashout_policy',
    'result_checker_pricing'
  ));

insert into public.platform_settings(key,value)
values ('number_verification_provider','{"provider":"datahub"}'::jsonb)
on conflict (key) do nothing;

drop policy if exists "Public read storefront state" on public.platform_settings;
create policy "Public read storefront state" on public.platform_settings for select
  using (key in (
    'storefront_maintenance','storefront_live_sales','wallet_deposits_enabled',
    'active_bundle_provider','number_verification_provider','storefront_contact',
    'paystack_fee_recovery'
  ));
