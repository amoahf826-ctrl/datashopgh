-- Agent-specific customer-facing AFA prices. Admin afa_plans.price remains
-- the main storefront price and the minimum agent price.
create table if not exists public.agent_afa_plan_prices (
  agent_id uuid not null references public.agent_accounts(user_id) on delete cascade,
  plan_id uuid not null references public.afa_plans(id) on delete cascade,
  customer_price numeric(10,2) not null check (customer_price > 0),
  updated_at timestamptz not null default now(),
  primary key (agent_id, plan_id)
);

alter table public.agent_afa_plan_prices enable row level security;
revoke all on public.agent_afa_plan_prices from public, anon, authenticated;

create or replace function public.get_my_agent_afa_prices()
returns table(plan_id uuid, customer_price numeric)
language sql stable security definer set search_path = '' as $$
  select price.plan_id, price.customer_price
  from public.agent_afa_plan_prices price
  join public.agent_accounts account on account.user_id = price.agent_id and account.is_active
  where account.user_id = (select auth.uid());
$$;

create or replace function public.get_public_agent_afa_prices(p_referral_code text)
returns table(plan_id uuid, customer_price numeric)
language sql stable security definer set search_path = '' as $$
  select price.plan_id, price.customer_price
  from public.agent_afa_plan_prices price
  join public.agent_accounts account on account.user_id = price.agent_id and account.is_active
  where upper(account.referral_code) = upper(trim(p_referral_code));
$$;

create or replace function public.agent_save_afa_prices(p_prices jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_item jsonb;
  v_plan_id uuid;
  v_price numeric(10,2);
  v_base_price numeric(10,2);
  v_raw_price text;
begin
  if v_user is null or not exists (
    select 1 from public.agent_accounts a where a.user_id = v_user and a.is_active
  ) then
    raise exception 'An active agent account is required.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_prices) <> 'array' or jsonb_array_length(p_prices) > 100 then
    raise exception 'Submit a valid list of AFA prices.' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_prices)
  loop
    begin
      v_plan_id := (v_item->>'plan_id')::uuid;
    exception when others then
      raise exception 'An AFA plan ID is invalid.' using errcode = '22023';
    end;
    select p.price into v_base_price from public.afa_plans p
      where p.id = v_plan_id and p.is_active;
    if not found then
      raise exception 'An AFA plan is inactive or no longer exists.' using errcode = '22023';
    end if;

    v_raw_price := nullif(trim(v_item->>'price'), '');
    if v_raw_price is null then
      delete from public.agent_afa_plan_prices where agent_id = v_user and plan_id = v_plan_id;
    else
      begin
        v_price := v_raw_price::numeric(10,2);
      exception when others then
        raise exception 'Enter a valid price for every AFA plan.' using errcode = '22023';
      end;
      if v_price < v_base_price then
        raise exception 'Agent AFA prices must be at least the admin main-store price of % GHS.', v_base_price using errcode = '22023';
      end if;
      insert into public.agent_afa_plan_prices(agent_id, plan_id, customer_price, updated_at)
        values(v_user, v_plan_id, v_price, now())
      on conflict (agent_id, plan_id) do update
        set customer_price = excluded.customer_price, updated_at = now();
    end if;
  end loop;
end;
$$;

revoke all on function public.get_my_agent_afa_prices() from public, anon;
revoke all on function public.get_public_agent_afa_prices(text) from public;
revoke all on function public.agent_save_afa_prices(jsonb) from public, anon;
grant execute on function public.get_my_agent_afa_prices() to authenticated;
grant execute on function public.get_public_agent_afa_prices(text) to anon, authenticated;
grant execute on function public.agent_save_afa_prices(jsonb) to authenticated;

comment on table public.agent_afa_plan_prices is
  'Per-agent AFA customer storefront prices. Blank agent prices use the admin-set main storefront price.';
