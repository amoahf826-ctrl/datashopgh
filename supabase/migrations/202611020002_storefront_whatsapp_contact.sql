-- Admin-managed storefront WhatsApp contact details.
alter table public.platform_settings drop constraint if exists platform_settings_key_check;

insert into public.platform_settings(key,value)
values (
  'storefront_contact',
  '{"phone":"+233249514164","channel":"https://chat.whatsapp.com/EBJ2We2FTzR3cMK3EZ1FyK"}'::jsonb
)
on conflict (key) do nothing;

drop policy if exists "Public read storefront state" on public.platform_settings;
create policy "Public read storefront state" on public.platform_settings for select
  using (key in ('storefront_maintenance','storefront_live_sales','wallet_deposits_enabled','active_bundle_provider','storefront_contact'));
