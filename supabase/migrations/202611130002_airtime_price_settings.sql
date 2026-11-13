-- Admin-managed airtime markup defaults for the main store and agent stores.
create table if not exists public.airtime_price_settings (
  network text primary key check (network in ('MTN','AT','Telecel')),
  main_markup_percent numeric(6,2) not null default 0 check (main_markup_percent between 0 and 100),
  agent_markup_percent numeric(6,2) not null default 0 check (agent_markup_percent between 0 and 100),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

insert into public.airtime_price_settings(network)
values ('MTN'),('AT'),('Telecel')
on conflict (network) do nothing;

alter table public.airtime_price_settings enable row level security;
revoke all on public.airtime_price_settings from public, anon, authenticated;
grant select on public.airtime_price_settings to authenticated;
create policy "Admins read airtime price settings" on public.airtime_price_settings
  for select to authenticated using (public.is_admin());

create or replace function public.get_airtime_pricing()
returns table(network text, main_markup_percent numeric, agent_markup_percent numeric)
language sql stable security definer set search_path = '' as $$
  select setting.network, setting.main_markup_percent, setting.agent_markup_percent
  from public.airtime_price_settings setting
  order by case setting.network when 'MTN' then 1 when 'AT' then 2 else 3 end
$$;
revoke all on function public.get_airtime_pricing() from public;
grant execute on function public.get_airtime_pricing() to anon, authenticated;

create or replace function public.admin_save_airtime_prices(p_prices jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_network text;
  v_main numeric(6,2);
  v_agent numeric(6,2);
  v_count integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_prices) <> 'array' or jsonb_array_length(p_prices) <> 3 then
    raise exception 'Submit a price for MTN, Tigo, and Telecel airtime';
  end if;
  for v_item in select value from jsonb_array_elements(p_prices) loop
    v_network := upper(trim(coalesce(v_item->>'network','')));
    if v_network not in ('MTN','AT','TELECEL') then raise exception 'Unknown airtime network'; end if;
    if v_network='TELECEL' then v_network:='Telecel'; end if;
    begin
      v_main := (v_item->>'main_markup_percent')::numeric(6,2);
      v_agent := (v_item->>'agent_markup_percent')::numeric(6,2);
    exception when others then raise exception 'Airtime markup values must be valid percentages'; end;
    if v_main < 0 or v_main > 100 or v_agent < 0 or v_agent > 100 then
      raise exception 'Airtime markups must be between 0%% and 100%%';
    end if;
    update public.airtime_price_settings
      set main_markup_percent=v_main, agent_markup_percent=v_agent,
          updated_by=auth.uid(), updated_at=now()
      where network=v_network;
    if not found then raise exception 'Airtime network settings are missing'; end if;
    v_count := v_count + 1;
  end loop;
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
    values(auth.uid(),'update_airtime_prices','airtime_price_settings','defaults',jsonb_build_object('networks',v_count));
  return v_count;
end;
$$;
revoke all on function public.admin_save_airtime_prices(jsonb) from public, anon;
grant execute on function public.admin_save_airtime_prices(jsonb) to authenticated;

-- Public agent stores inherit the admin-set agent default unless that agent has
-- saved a network-specific markup of their own.
create or replace function public.get_agent_customer_airtime_markups(p_referral_code text)
returns table(network text,markup_percent numeric)
language sql stable security definer set search_path = '' as $$
  select setting.network, coalesce(agent_price.markup_percent, setting.agent_markup_percent)::numeric
  from public.agent_accounts account
  cross join public.airtime_price_settings setting
  left join public.agent_customer_airtime_markups agent_price
    on agent_price.agent_id=account.user_id and agent_price.network=setting.network
  where account.is_active and upper(account.referral_code)=upper(trim(p_referral_code))
  order by case setting.network when 'MTN' then 1 when 'AT' then 2 else 3 end
$$;
revoke all on function public.get_agent_customer_airtime_markups(text) from public;
grant execute on function public.get_agent_customer_airtime_markups(text) to anon, authenticated;
