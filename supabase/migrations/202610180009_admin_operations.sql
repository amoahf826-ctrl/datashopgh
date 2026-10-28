-- Add operational admin data for agents, SMS previews, API provider metadata, and maintenance settings.
alter table public.profiles add column if not exists full_name text not null default '';
alter table public.profiles add column if not exists phone text not null default '';

alter table public.agent_accounts add column if not exists username text not null default '';
alter table public.agent_accounts add column if not exists business_name text not null default '';
alter table public.agent_accounts add column if not exists phone text not null default '';
alter table public.agent_accounts add column if not exists referral_code text not null default '';
alter table public.agent_accounts add column if not exists api_access_enabled boolean not null default false;
alter table public.agent_accounts add column if not exists overdraft_enabled boolean not null default false;

create table public.bulk_sms_campaigns (
  id uuid primary key default gen_random_uuid(),
  audience text not null check (audience in ('all_agents','overdraft_agents','negative_balance_agents','all_customers','custom_numbers')),
  message text not null check (length(trim(message)) between 1 and 1600),
  recipient_count integer not null default 0 check (recipient_count >= 0),
  status text not null default 'preview_only' check (status='preview_only'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.provider_configs (
  id uuid primary key default gen_random_uuid(),
  provider_name text not null check (length(trim(provider_name)) between 2 and 100),
  network text not null check (network in ('MTN','Telecel','AT','All')),
  base_url text not null default '' check (length(base_url) <= 500),
  is_active boolean not null default false,
  test_mode boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider_name,network)
);

create table public.platform_settings (
  key text primary key check (key in ('storefront_maintenance','agent_dashboard_maintenance')),
  value jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
insert into public.platform_settings(key,value) values
  ('storefront_maintenance','{"enabled":false,"message":"The storefront is temporarily under maintenance. Please check back soon."}'::jsonb),
  ('agent_dashboard_maintenance','{"enabled":false,"message":"The agent dashboard is temporarily under maintenance. Please check back soon."}'::jsonb)
on conflict(key) do nothing;

alter table public.bulk_sms_campaigns enable row level security;
alter table public.provider_configs enable row level security;
alter table public.platform_settings enable row level security;
grant select,insert on public.bulk_sms_campaigns to authenticated;
grant select,insert,update,delete on public.provider_configs to authenticated;
grant select,update on public.platform_settings to authenticated;
grant select on public.platform_settings to anon;

create policy "Admins manage SMS preview logs" on public.bulk_sms_campaigns for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "Admins manage provider metadata" on public.provider_configs for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "Public read maintenance state" on public.platform_settings for select
  using (key='storefront_maintenance');
create policy "Admins manage platform settings" on public.platform_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create or replace function public.touch_admin_operations_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at=now();
  if tg_table_name='platform_settings' then new.updated_by=auth.uid(); end if;
  return new;
end;
$$;
create trigger touch_provider_configs_updated_at before update on public.provider_configs
  for each row execute procedure public.touch_admin_operations_updated_at();
create trigger touch_platform_settings_updated_at before update on public.platform_settings
  for each row execute procedure public.touch_admin_operations_updated_at();

create trigger audit_provider_config_changes after insert or update on public.provider_configs
  for each row execute procedure public.audit_row_change();
