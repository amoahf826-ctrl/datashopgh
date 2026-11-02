-- Retire the current package catalogue without deleting plans referenced by order history.
update public.bundles
set is_active = false
where is_active;

-- Match the four package groups used by the admin plan creator and storefront.
insert into public.bundle_categories(network, name, description, is_active)
values
  ('AT', 'AirtelTigo-Bigtime', 'AirtelTigo BigTime data bundles', true),
  ('AT', 'AirtelTigo-iShare', 'AirtelTigo iShare data bundles', true),
  ('MTN', 'MTN', 'MTN data bundles', true),
  ('Telecel', 'TELECEL', 'Telecel data bundles', true)
on conflict (network, name) do update
set description = excluded.description,
    is_active = true;

-- Ensure the two Paystack features have explicit, admin-manageable settings.
insert into public.platform_settings(key, value)
values
  ('storefront_live_sales', '{"enabled": false}'::jsonb),
  ('wallet_deposits_enabled', '{"enabled": true}'::jsonb)
on conflict (key) do nothing;
