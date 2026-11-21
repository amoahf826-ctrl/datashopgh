-- Admin-managed default customer prices for all Agent storefronts.
-- Per-agent and agent-owned storefront prices retain precedence over these defaults.

create table if not exists public.agent_afa_default_prices (
  plan_id uuid primary key references public.afa_plans(id) on delete cascade,
  customer_price numeric(10,2) not null check (customer_price >= 0),
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now()
);

alter table public.agent_afa_default_prices enable row level security;
revoke all on public.agent_afa_default_prices from public, anon, authenticated;

create or replace function public.admin_get_general_agent_afa_prices()
returns table(plan_id uuid, customer_price numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  return query
    select price.plan_id, price.customer_price::numeric
    from public.agent_afa_default_prices price
    order by price.plan_id;
end;
$$;

create or replace function public.admin_save_general_agent_afa_prices(p_prices jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  item jsonb;
  v_plan_id uuid;
  v_raw text;
  v_price numeric(10,2);
  v_main_price numeric(10,2);
  v_count integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_prices) <> 'array' or jsonb_array_length(p_prices) > 100 then
    raise exception 'Submit a valid list of general Agent AFA prices' using errcode = '22023';
  end if;

  for item in select value from jsonb_array_elements(p_prices) loop
    begin
      v_plan_id := (item->>'plan_id')::uuid;
    exception when others then
      raise exception 'An AFA plan ID is invalid' using errcode = '22023';
    end;
    select plan.price into v_main_price
      from public.afa_plans plan
      where plan.id = v_plan_id and plan.is_active;
    if not found then
      raise exception 'An AFA plan is inactive or no longer exists' using errcode = '22023';
    end if;

    v_raw := nullif(trim(item->>'price'), '');
    if v_raw is null then
      delete from public.agent_afa_default_prices where plan_id = v_plan_id;
    else
      begin
        v_price := v_raw::numeric(10,2);
      exception when others then
        raise exception 'Enter a valid general Agent price for each AFA plan' using errcode = '22023';
      end;
      if v_price < v_main_price or v_price > 100000 then
        raise exception 'General Agent AFA prices must be at least the main storefront price and no more than GHS 100000' using errcode = '22023';
      end if;
      insert into public.agent_afa_default_prices(plan_id, customer_price, updated_by, updated_at)
        values(v_plan_id, v_price, auth.uid(), now())
        on conflict(plan_id) do update
          set customer_price = excluded.customer_price,
              updated_by = excluded.updated_by,
              updated_at = now();
    end if;
    v_count := v_count + 1;
  end loop;

  insert into public.audit_log(actor_id, action, entity, entity_id, details)
    values(auth.uid(), 'admin_update_general_agent_afa_prices', 'agent_afa_default_prices', 'all',
      jsonb_build_object('updated_count', v_count));
  return v_count;
end;
$$;

revoke all on function public.admin_get_general_agent_afa_prices() from public, anon;
revoke all on function public.admin_save_general_agent_afa_prices(jsonb) from public, anon;
grant execute on function public.admin_get_general_agent_afa_prices() to authenticated;
grant execute on function public.admin_save_general_agent_afa_prices(jsonb) to authenticated;

-- Price resolution order: the Agent's own storefront price, admin-assigned
-- individual price, Super Agent override, then the general Agent default.
create or replace function public.get_public_agent_afa_prices(p_referral_code text)
returns table(plan_id uuid, customer_price numeric)
language sql stable security definer set search_path = '' as $$
  select plan.id,
    coalesce(store_price.customer_price, admin_price.customer_price,
      super_price.override_price, default_price.customer_price, plan.price)::numeric
  from public.agent_accounts account
  join public.afa_plans plan on plan.is_active
  left join public.agent_storefront_afa_plan_prices store_price
    on store_price.agent_id = account.user_id and store_price.plan_id = plan.id
  left join public.agent_afa_plan_prices admin_price
    on admin_price.agent_id = account.user_id and admin_price.plan_id = plan.id
  left join public.super_agent_afa_plan_prices super_price
    on super_price.super_agent_id = account.user_id and super_price.plan_id = plan.id
  left join public.agent_afa_default_prices default_price
    on default_price.plan_id = plan.id
  where account.is_active
    and upper(account.referral_code) = upper(trim(p_referral_code))
$$;

revoke all on function public.get_public_agent_afa_prices(text) from public;
grant execute on function public.get_public_agent_afa_prices(text) to anon, authenticated;

comment on table public.agent_afa_default_prices is
  'Admin-set default AFA customer prices for every Agent storefront; per-agent prices override these defaults.';
