-- Add Super Agent-specific AFA storefront prices and result-checker wallet costs.
-- These overrides are isolated from regular agent pricing tables.

create table if not exists public.super_agent_afa_plan_prices (
  super_agent_id uuid not null references public.agent_accounts(user_id) on delete cascade,
  plan_id uuid not null references public.afa_plans(id) on delete cascade,
  override_price numeric(10,2) not null check (override_price >= 0),
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (super_agent_id, plan_id)
);

create table if not exists public.super_agent_result_checker_prices (
  super_agent_id uuid not null references public.agent_accounts(user_id) on delete cascade,
  voucher_type text not null check (voucher_type in ('BECE','WASSCE')),
  override_price numeric(10,2) not null check (override_price > 0),
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (super_agent_id, voucher_type)
);

alter table public.super_agent_afa_plan_prices enable row level security;
alter table public.super_agent_result_checker_prices enable row level security;
revoke all on public.super_agent_afa_plan_prices, public.super_agent_result_checker_prices from public, anon, authenticated;
grant select on public.super_agent_afa_plan_prices, public.super_agent_result_checker_prices to authenticated;

create policy "Admins manage Super Agent AFA prices" on public.super_agent_afa_plan_prices
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "Admins manage Super Agent result checker prices" on public.super_agent_result_checker_prices
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.admin_save_super_agent_service_prices(
  p_super_agent_id uuid,
  p_afa_prices jsonb,
  p_checker_prices jsonb
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_plan_id uuid;
  v_type text;
  v_price numeric(10,2);
  v_raw text;
  v_count integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.agent_accounts
    where user_id = p_super_agent_id and agent_type = 'super_agent' and is_active
  ) then
    raise exception 'Active Super Agent account not found';
  end if;
  if jsonb_typeof(p_afa_prices) <> 'array' or jsonb_array_length(p_afa_prices) > 100
    or jsonb_typeof(p_checker_prices) <> 'array' or jsonb_array_length(p_checker_prices) > 2 then
    raise exception 'Invalid Super Agent service price list';
  end if;

  for v_item in select value from jsonb_array_elements(p_afa_prices) loop
    begin v_plan_id := (v_item->>'plan_id')::uuid;
    exception when others then raise exception 'An AFA plan ID is invalid'; end;
    v_raw := nullif(trim(v_item->>'price'), '');
    if v_raw is null then
      delete from public.super_agent_afa_plan_prices
        where super_agent_id = p_super_agent_id and plan_id = v_plan_id;
    else
      begin v_price := v_raw::numeric(10,2);
      exception when others then raise exception 'AFA price must be a valid number'; end;
      if v_price < 0 or v_price > 100000 then raise exception 'AFA price is outside the allowed range'; end if;
      if not exists(select 1 from public.afa_plans where id = v_plan_id and is_active) then
        raise exception 'An AFA plan is inactive or no longer exists';
      end if;
      insert into public.super_agent_afa_plan_prices(super_agent_id,plan_id,override_price,updated_by)
      values(p_super_agent_id,v_plan_id,v_price,auth.uid())
      on conflict(super_agent_id,plan_id) do update
        set override_price=excluded.override_price,updated_by=excluded.updated_by,updated_at=now();
    end if;
    v_count := v_count + 1;
  end loop;

  for v_item in select value from jsonb_array_elements(p_checker_prices) loop
    v_type := upper(trim(coalesce(v_item->>'voucher_type','')));
    if v_type not in ('BECE','WASSCE') then raise exception 'Choose BECE or WASSCE'; end if;
    v_raw := nullif(trim(v_item->>'price'), '');
    if v_raw is null then
    
      delete from public.super_agent_result_checker_prices
        where super_agent_id = p_super_agent_id and voucher_type = v_type;
    else
      begin v_price := v_raw::numeric(10,2);
      exception when others then raise exception 'Checker price must be a valid number'; end;
      if v_price <= 0 or v_price > 10000 then raise exception 'Checker price is outside the allowed range'; end if;
      insert into public.super_agent_result_checker_prices(super_agent_id,voucher_type,override_price,updated_by)
      values(p_super_agent_id,v_type,v_price,auth.uid())
      on conflict(super_agent_id,voucher_type) do update
        set override_price=excluded.override_price,updated_by=excluded.updated_by,updated_at=now();
    end if;
    v_count := v_count + 1;
  end loop;

  insert into public.audit_log(actor_id,action,entity,entity_id,details)
  values(auth.uid(),'save_super_agent_service_prices','agent_accounts',p_super_agent_id::text,
    jsonb_build_object('afa_items',jsonb_array_length(p_afa_prices),'checker_items',jsonb_array_length(p_checker_prices)));
  return v_count;
end;
$$;
revoke all on function public.admin_save_super_agent_service_prices(uuid,jsonb,jsonb) from public, anon;
grant execute on function public.admin_save_super_agent_service_prices(uuid,jsonb,jsonb) to authenticated;

create or replace function public.get_my_super_agent_afa_prices()
returns table(plan_id uuid, override_price numeric(10,2))
language sql stable security definer set search_path = '' as $$
  select price.plan_id, price.override_price
  from public.super_agent_afa_plan_prices price
  join public.agent_accounts account on account.user_id=price.super_agent_id
  where account.user_id=(select auth.uid())
    and account.agent_type='super_agent' and account.is_active
$$;
revoke all on function public.get_my_super_agent_afa_prices() from public, anon;
grant execute on function public.get_my_super_agent_afa_prices() to authenticated;

-- A Super Agent's admin-set AFA price takes precedence on that agent's public store;
-- regular agents continue using their own saved customer price or the main price.
create or replace function public.get_public_agent_afa_prices(p_referral_code text)
returns table(plan_id uuid, customer_price numeric)
language sql stable security definer set search_path = '' as $$
  select plan.id, coalesce(super_price.override_price, agent_price.customer_price)::numeric
  from public.agent_accounts account
  join public.afa_plans plan on plan.is_active
  left join public.agent_afa_plan_prices agent_price
    on agent_price.agent_id=account.user_id and agent_price.plan_id=plan.id
  left join public.super_agent_afa_plan_prices super_price
    on super_price.super_agent_id=account.user_id and super_price.plan_id=plan.id
  where account.is_active and upper(account.referral_code)=upper(trim(p_referral_code))
    and (super_price.override_price is not null or agent_price.customer_price is not null)
$$;
revoke all on function public.get_public_agent_afa_prices(text) from public;
grant execute on function public.get_public_agent_afa_prices(text) to anon, authenticated;

-- Super Agent checker overrides set the wallet cost for this agent only.
create or replace function public.create_result_checker_wallet_order(
  p_user_id uuid,p_voucher_type text,p_phone text,p_quantity integer,p_reference text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_order public.result_checker_orders%rowtype;
  v_wallet_price numeric(12,2);
  v_super_price numeric(12,2);
  v_balance numeric(12,2);
  v_enabled boolean;
  v_total numeric(12,2);
begin
  if p_user_id is null or upper(p_voucher_type) not in ('BECE','WASSCE') or p_phone !~ '^0[0-9]{9}$'
    or p_quantity not between 1 and 100 or p_reference !~ '^RCW-[A-Fa-f0-9]{32}$' then
    raise exception 'Enter a valid voucher type, recipient, and quantity';
  end if;
  if not exists(select 1 from public.agent_accounts a where a.user_id=p_user_id and a.is_active) then
    raise exception 'An active agent account is required to use wallet checkout';
  end if;
  select coalesce((s.value->>'enabled')::boolean,false),
         coalesce((s.value->'agent_prices'->>upper(p_voucher_type))::numeric,0)
    into v_enabled,v_wallet_price
    from public.platform_settings s where s.key='result_checker_pricing';
  if not coalesce(v_enabled,false) or coalesce(v_wallet_price,0)<=0 then
    raise exception 'This result checker is currently unavailable';
  end if;
  select special.override_price into v_super_price
  from public.super_agent_result_checker_prices special
  join public.agent_accounts account on account.user_id=special.super_agent_id
  where special.super_agent_id=p_user_id and special.voucher_type=upper(p_voucher_type)
    and account.agent_type='super_agent' and account.is_active;
  if found then v_wallet_price:=v_super_price; end if;
  v_total:=round(v_wallet_price*p_quantity,2);
  insert into public.wallets(user_id,balance) values(p_user_id,0) on conflict(user_id) do nothing;
  select balance into v_balance from public.wallets where user_id=p_user_id for update;
  if coalesce(v_balance,0)<v_total then raise exception 'Insufficient wallet balance'; end if;
  update public.wallets set balance=balance-v_total,updated_at=now() where user_id=p_user_id returning balance into v_balance;
  insert into public.result_checker_orders(user_id,voucher_type,recipient_phone,quantity,unit_price,total_amount,charge_amount,payment_method,payment_reference,payment_status,status)
    values(p_user_id,upper(p_voucher_type),p_phone,p_quantity,v_wallet_price,v_total,v_total,'wallet',p_reference,'successful','processing') returning * into v_order;
  insert into public.ledger(user_id,kind,amount,reference_type,reference_id,idempotency_key)
    values(p_user_id,'purchase',-v_total,'result_checker_order',v_order.id,'result-checker-wallet:'||v_order.id::text);
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
    values(p_user_id,'result_checker_wallet_purchase_created','result_checker_order',v_order.id::text,
      jsonb_build_object('type',v_order.voucher_type,'quantity',p_quantity,'amount',v_total,'super_agent_override',v_super_price is not null));
  return jsonb_build_object('order_id',v_order.id,'wallet_balance',v_balance,'total_amount',v_total);
end;
$$;
revoke all on function public.create_result_checker_wallet_order(uuid,text,text,integer,text) from public, anon, authenticated;
grant execute on function public.create_result_checker_wallet_order(uuid,text,text,integer,text) to service_role;
