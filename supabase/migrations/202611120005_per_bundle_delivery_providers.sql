-- Each bundle can route through either integrated provider with an explicit
-- provider-side plan type. Null values preserve the platform default routing.
alter table public.bundles
  add column if not exists delivery_provider text
    check (delivery_provider is null or delivery_provider in ('datahub','hubnet')),
  add column if not exists delivery_network_type text;

alter table public.platform_settings drop constraint if exists platform_settings_key_check;
alter table public.platform_settings add constraint platform_settings_key_check
  check (key in ('storefront_maintenance','agent_dashboard_maintenance','storefront_live_sales',
    'wallet_deposits_enabled','active_bundle_provider','storefront_contact','paystack_fee_recovery',
    'agent_cashout_policy','result_checker_pricing'));

insert into public.platform_settings as ps(key,value)
values ('active_bundle_provider','{"provider":"datahub","enabled":{"datahub":true,"hubnet":true}}'::jsonb)
on conflict (key) do update set value=ps.value ||
  jsonb_build_object('enabled',coalesce(ps.value->'enabled','{"datahub":true,"hubnet":true}'::jsonb));
