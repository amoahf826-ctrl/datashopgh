alter table public.agent_number_submissions
  add column if not exists datahub_status text
    check (datahub_status is null or datahub_status in ('submitted','invalid')),
  add column if not exists datahub_submitted_at timestamptz;

alter table public.orders
  add column if not exists delivery_provider text
    check (delivery_provider is null or delivery_provider in ('datahub','hubnet'));

create index if not exists agent_number_submissions_datahub_status_idx
  on public.agent_number_submissions(agent_id, datahub_status, datahub_submitted_at desc);

alter table public.platform_settings drop constraint if exists platform_settings_key_check;

insert into public.platform_settings(key,value)
values ('active_bundle_provider','{"provider":"datahub"}'::jsonb)
on conflict (key) do nothing;

drop policy if exists "Public read storefront state" on public.platform_settings;
create policy "Public read storefront state" on public.platform_settings for select
  using (key in ('storefront_maintenance','storefront_live_sales','active_bundle_provider'));
