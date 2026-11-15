-- Keep agent-owned customer storefront prices independent from admin-assigned
-- per-agent prices. A storefront uses the agent's own price first, then the
-- admin-assigned per-agent price, then the catalogue price.
create table if not exists public.agent_storefront_bundle_prices (
  agent_id uuid not null references public.agent_accounts(user_id) on delete cascade,
  bundle_id text not null references public.bundles(id) on delete cascade,
  customer_price numeric(10,2) not null check (customer_price >= 0),
  updated_at timestamptz not null default now(),
  primary key (agent_id, bundle_id)
);
alter table public.agent_storefront_bundle_prices enable row level security;
revoke all on public.agent_storefront_bundle_prices from public, anon, authenticated;

create table if not exists public.agent_storefront_afa_plan_prices (
  agent_id uuid not null references public.agent_accounts(user_id) on delete cascade,
  plan_id uuid not null references public.afa_plans(id) on delete cascade,
  customer_price numeric(10,2) not null check (customer_price > 0),
  updated_at timestamptz not null default now(),
  primary key (agent_id, plan_id)
);
alter table public.agent_storefront_afa_plan_prices enable row level security;
revoke all on public.agent_storefront_afa_plan_prices from public, anon, authenticated;

create or replace function public.get_my_agent_storefront_bundle_prices()
returns table(bundle_id text, customer_price numeric)
language sql stable security definer set search_path = '' as $$
  select price.bundle_id, price.customer_price
  from public.agent_storefront_bundle_prices price
  join public.agent_accounts account on account.user_id = price.agent_id
  where account.user_id = (select auth.uid()) and account.is_active
$$;

create or replace function public.agent_save_customer_prices(p_prices jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare item jsonb; v_bundle text; v_price numeric; v_count integer := 0;
begin
  if not exists(select 1 from public.agent_accounts where user_id = auth.uid() and is_active) then
    raise exception 'Active agent account required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_prices) <> 'array' or jsonb_array_length(p_prices) > 500 then
    raise exception 'Invalid price list';
  end if;
  for item in select value from jsonb_array_elements(p_prices) loop
    v_bundle := item->>'bundle_id';
    if not exists(select 1 from public.bundles where id = v_bundle) then
      raise exception 'Unknown bundle';
    end if;
    if coalesce(item->>'price', '') = '' then
      delete from public.agent_storefront_bundle_prices where agent_id = auth.uid() and bundle_id = v_bundle;
    else
      begin v_price := (item->>'price')::numeric;
      exception when others then raise exception 'Price must be a number'; end;
      if v_price < 0 or v_price > 100000 then raise exception 'Price is outside the allowed range'; end if;
      insert into public.agent_storefront_bundle_prices(agent_id, bundle_id, customer_price)
      values(auth.uid(), v_bundle, v_price)
      on conflict(agent_id, bundle_id) do update
        set customer_price = excluded.customer_price, updated_at = now();
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.get_agent_customer_prices(p_referral_code text)
returns table(bundle_id text, customer_price numeric)
language sql stable security definer set search_path = '' as $$
  select bundle.id, coalesce(store_price.customer_price, admin_price.customer_price)::numeric
  from public.agent_accounts account
  join public.bundles bundle on bundle.is_active and not bundle.is_demo
  left join public.agent_storefront_bundle_prices store_price
    on store_price.agent_id = account.user_id and store_price.bundle_id = bundle.id
  left join public.agent_customer_bundle_prices admin_price
    on admin_price.agent_id = account.user_id and admin_price.bundle_id = bundle.id
  where account.is_active
    and upper(account.referral_code) = upper(trim(p_referral_code))
    and (store_price.customer_price is not null or admin_price.customer_price is not null)
$$;

create or replace function public.get_my_agent_afa_prices()
returns table(plan_id uuid, customer_price numeric)
language sql stable security definer set search_path = '' as $$
  select price.plan_id, price.customer_price
  from public.agent_storefront_afa_plan_prices price
  join public.agent_accounts account on account.user_id = price.agent_id and account.is_active
  where account.user_id = (select auth.uid())
$$;

create or replace function public.agent_save_afa_prices(p_prices jsonb)
returns void language plpgsql security definer set search_path = '' as $$
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
  for v_item in select value from jsonb_array_elements(p_prices) loop
    begin v_plan_id := (v_item->>'plan_id')::uuid;
    exception when others then raise exception 'An AFA plan ID is invalid.' using errcode = '22023'; end;
    select plan.price into v_base_price from public.afa_plans plan
      where plan.id = v_plan_id and plan.is_active;
    if not found then raise exception 'An AFA plan is inactive or no longer exists.' using errcode = '22023'; end if;
    v_raw_price := nullif(trim(v_item->>'price'), '');
    if v_raw_price is null then
      delete from public.agent_storefront_afa_plan_prices where agent_id = v_user and plan_id = v_plan_id;
    else
      begin v_price := v_raw_price::numeric(10,2);
      exception when others then raise exception 'Enter a valid price for every AFA plan.' using errcode = '22023'; end;
      if v_price < v_base_price or v_price > 100000 then
        raise exception 'Agent AFA prices must be at least the admin main-store price of % GHS.', v_base_price using errcode = '22023';
      end if;
      insert into public.agent_storefront_afa_plan_prices(agent_id, plan_id, customer_price, updated_at)
      values(v_user, v_plan_id, v_price, now())
      on conflict(agent_id, plan_id) do update
        set customer_price = excluded.customer_price, updated_at = now();
    end if;
  end loop;
end;
$$;

create or replace function public.get_public_agent_afa_prices(p_referral_code text)
returns table(plan_id uuid, customer_price numeric)
language sql stable security definer set search_path = '' as $$
  select plan.id, coalesce(store_price.customer_price, admin_price.customer_price, super_price.override_price)::numeric
  from public.agent_accounts account
  join public.afa_plans plan on plan.is_active
  left join public.agent_storefront_afa_plan_prices store_price
    on store_price.agent_id = account.user_id and store_price.plan_id = plan.id
  left join public.agent_afa_plan_prices admin_price
    on admin_price.agent_id = account.user_id and admin_price.plan_id = plan.id
  left join public.super_agent_afa_plan_prices super_price
    on super_price.super_agent_id = account.user_id and super_price.plan_id = plan.id
  where account.is_active
    and upper(account.referral_code) = upper(trim(p_referral_code))
    and (store_price.customer_price is not null or admin_price.customer_price is not null
      or super_price.override_price is not null)
$$;

-- Use agent-owned storefront prices for both Paystack and wallet purchases via
-- an agent link. The admin's saved prices remain intact as a fallback layer.
create or replace function public.create_live_checkout_order(
  p_user_id uuid, p_bundle_id text, p_recipient_phone text, p_idempotency_key uuid,
  p_payment_reference text, p_delivery_reference text, p_agent_referral_code text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
  v_agent uuid;
  v_price numeric(10,2);
  v_base_price numeric(10,2);
  v_order public.orders%rowtype;
begin
  v_result := public.create_live_checkout_order(p_user_id, p_bundle_id, p_recipient_phone,
    p_idempotency_key, p_payment_reference, p_delivery_reference);
  select * into v_order from public.orders where id = (v_result->>'id')::uuid for update;
  if v_order.checkout_url is not null or v_order.payment_status <> 'unpaid' then return v_result; end if;
  select bundle.price into v_base_price from public.bundles bundle where bundle.id = p_bundle_id;
  if coalesce(trim(p_agent_referral_code), '') = '' then
    select customer_price into v_price from public.main_storefront_bundle_prices where bundle_id = p_bundle_id;
    v_price := coalesce(v_price, v_base_price);
    update public.orders set price = v_price where id = v_order.id;
    update public.audit_log set details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
      'price', v_price, 'base_price', v_base_price, 'main_storefront_price', v_price)
      where entity = 'order' and entity_id = v_order.id::text and action = 'live_checkout_created';
    return v_result || jsonb_build_object('price', v_price);
  end if;
  select account.user_id into v_agent from public.agent_accounts account
    where upper(account.referral_code) = upper(trim(p_agent_referral_code)) and account.is_active;
  if v_agent is null then raise exception 'Agent referral link is invalid'; end if;
  select coalesce(store_price.customer_price, admin_price.customer_price) into v_price
  from (select 1) seed
  left join public.agent_storefront_bundle_prices store_price
    on store_price.agent_id = v_agent and store_price.bundle_id = p_bundle_id
  left join public.agent_customer_bundle_prices admin_price
    on admin_price.agent_id = v_agent and admin_price.bundle_id = p_bundle_id;
  v_price := coalesce(v_price, v_base_price);
  update public.orders set price = v_price, referred_by_agent_id = v_agent where id = v_order.id;
  update public.audit_log set details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
    'agent_id', v_agent, 'customer_price', v_price, 'base_price', v_base_price,
    'agent_profit', greatest(v_price - v_base_price, 0))
    where entity = 'order' and entity_id = v_order.id::text and action = 'live_checkout_created';
  return v_result || jsonb_build_object('price', v_price);
end;
$$;

create or replace function public.create_guest_live_checkout_order(
  p_email text, p_bundle_id text, p_recipient_phone text, p_idempotency_key uuid,
  p_payment_reference text, p_delivery_reference text, p_agent_referral_code text, p_client_ip text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_bundle public.bundles%rowtype;
  v_agent uuid;
  v_price numeric(10,2);
  v_ip_key text;
  v_count integer;
begin
  if p_email is null or length(trim(p_email)) > 254 or trim(p_email) !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
    or p_recipient_phone is null or p_recipient_phone !~ '^0[0-9]{9}$'
    or p_idempotency_key is null or p_bundle_id is null
    or p_payment_reference !~ '^DSGH-[A-Fa-f0-9]{32}$'
    or p_delivery_reference !~ '^DS[A-Fa-f0-9]{23}$'
    or coalesce(length(trim(p_client_ip)), 0) < 3 or length(trim(p_client_ip)) > 64 then
    raise exception 'Enter a valid email and Ghana phone number';
  end if;
  select * into v_order from public.orders
    where user_id is null and idempotency_key = p_idempotency_key for update;
  if found then
    if v_order.customer_email <> lower(trim(p_email)) or v_order.recipient_phone <> p_recipient_phone
      or v_order.bundle_id <> p_bundle_id then
      raise exception 'Checkout request key was already used for different order details';
    end if;
    return jsonb_build_object('id', v_order.id, 'price', v_order.price, 'status', v_order.status,
      'payment_reference', v_order.payment_reference, 'checkout_url', v_order.checkout_url);
  end if;
  v_ip_key := 'ip:' || encode(sha256(convert_to(trim(p_client_ip), 'UTF8')), 'hex');
  delete from public.public_checkout_rate_limits where window_started_at < now() - interval '1 day';
  insert into public.public_checkout_rate_limits as existing(rate_key, window_started_at, request_count)
    values(v_ip_key, now(), 1)
    on conflict(rate_key) do update set
      window_started_at = case when existing.window_started_at <= now() - interval '10 minutes' then now() else existing.window_started_at end,
      request_count = case when existing.window_started_at <= now() - interval '10 minutes' then 1 else existing.request_count + 1 end
    returning request_count into v_count;
  if v_count > 5 then return jsonb_build_object('rate_limited', true); end if;
  select * into v_bundle from public.bundles bundle
    where bundle.id = p_bundle_id and bundle.is_active and not bundle.is_demo
      and exists(select 1 from public.networks network where network.id = bundle.network and network.is_active);
  if not found then raise exception 'This live bundle is not available'; end if;
  v_price := v_bundle.price;
  if coalesce(trim(p_agent_referral_code), '') <> '' then
    select account.user_id into v_agent from public.agent_accounts account
      where upper(account.referral_code) = upper(trim(p_agent_referral_code)) and account.is_active;
    if v_agent is null then raise exception 'Agent referral link is invalid'; end if;
    select coalesce(store_price.customer_price, admin_price.customer_price) into v_price
    from (select 1) seed
    left join public.agent_storefront_bundle_prices store_price
      on store_price.agent_id = v_agent and store_price.bundle_id = p_bundle_id
    left join public.agent_customer_bundle_prices admin_price
      on admin_price.agent_id = v_agent and admin_price.bundle_id = p_bundle_id;
    v_price := coalesce(v_price, v_bundle.price);
  else
    select customer_price into v_price from public.main_storefront_bundle_prices where bundle_id = p_bundle_id;
    v_price := coalesce(v_price, v_bundle.price);
  end if;
  insert into public.orders(user_id, bundle_id, recipient_phone, price, status, is_demo, idempotency_key,
    payment_reference, delivery_reference, payment_status, delivery_status, referred_by_agent_id, customer_email)
  values(null, p_bundle_id, p_recipient_phone, v_price, 'pending', false, p_idempotency_key,
    p_payment_reference, p_delivery_reference, 'unpaid', 'not_started', v_agent, lower(trim(p_email)))
  returning * into v_order;
  insert into public.audit_log(actor_id, action, entity, entity_id, details)
  values(null, 'live_checkout_created', 'order', v_order.id::text, jsonb_build_object(
    'bundle_id', p_bundle_id, 'price', v_price, 'guest_checkout', true, 'agent_id', v_agent,
    'base_price', v_bundle.price,
    'main_storefront_price', case when v_agent is null then v_price else null end,
    'agent_profit', case when v_agent is null then 0 else greatest(v_price - v_bundle.price, 0) end));
  return jsonb_build_object('id', v_order.id, 'price', v_order.price, 'status', v_order.status,
    'payment_reference', v_order.payment_reference, 'checkout_url', v_order.checkout_url);
end;
$$;

create or replace function public.create_wallet_bundle_order(
  p_user_id uuid, p_bundle_id text, p_recipient_phone text, p_idempotency_key uuid,
  p_payment_reference text, p_delivery_reference text, p_agent_referral_code text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
  v_order public.orders%rowtype;
  v_agent uuid;
  v_price numeric(10,2);
  v_base_price numeric(10,2);
  v_balance numeric(12,2);
  v_delta numeric(10,2);
begin
  v_result := public.create_wallet_bundle_order(p_user_id, p_bundle_id, p_recipient_phone,
    p_idempotency_key, p_payment_reference, p_delivery_reference);
  if coalesce((v_result->>'created')::boolean, false) is not true
    or coalesce(trim(p_agent_referral_code), '') = '' then return v_result; end if;
  select * into v_order from public.orders where id = (v_result->>'order_id')::uuid for update;
  select bundle.price into v_base_price from public.bundles bundle where bundle.id = p_bundle_id;
  select account.user_id into v_agent from public.agent_accounts account
    where upper(account.referral_code) = upper(trim(p_agent_referral_code)) and account.is_active;
  if v_agent is null then raise exception 'Agent referral link is invalid'; end if;
  select coalesce(store_price.customer_price, admin_price.customer_price) into v_price
  from (select 1) seed
  left join public.agent_storefront_bundle_prices store_price
    on store_price.agent_id = v_agent and store_price.bundle_id = p_bundle_id
  left join public.agent_customer_bundle_prices admin_price
    on admin_price.agent_id = v_agent and admin_price.bundle_id = p_bundle_id;
  v_price := coalesce(v_price, v_base_price);
  v_delta := v_order.price - v_price;
  if v_delta <> 0 then
    update public.wallets set balance = balance + v_delta, updated_at = now()
      where user_id = p_user_id returning balance into v_balance;
    if v_balance < 0 then raise exception 'Insufficient wallet balance for this agent price'; end if;
  else
    select balance into v_balance from public.wallets where user_id = p_user_id;
  end if;
  update public.orders set price = v_price, referred_by_agent_id = v_agent where id = v_order.id;
  update public.ledger set amount = -v_price
    where reference_id = v_order.id and reference_type = 'order' and kind = 'purchase';
  update public.audit_log set details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
    'agent_id', v_agent, 'customer_price', v_price, 'base_price', v_base_price,
    'agent_profit', greatest(v_price - v_base_price, 0))
    where entity = 'order' and entity_id = v_order.id::text and action = 'wallet_bundle_purchase_created';
  return v_result || jsonb_build_object('price', v_price, 'wallet_balance', v_balance);
end;
$$;

revoke all on function public.get_my_agent_storefront_bundle_prices() from public, anon;
revoke all on function public.agent_save_customer_prices(jsonb) from public, anon;
revoke all on function public.get_agent_customer_prices(text) from public;
revoke all on function public.get_my_agent_afa_prices() from public, anon;
revoke all on function public.agent_save_afa_prices(jsonb) from public, anon;
revoke all on function public.get_public_agent_afa_prices(text) from public;
revoke all on function public.create_live_checkout_order(uuid,text,text,uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.create_guest_live_checkout_order(text,text,text,uuid,text,text,text,text) from public, anon, authenticated;
revoke all on function public.create_wallet_bundle_order(uuid,text,text,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.get_my_agent_storefront_bundle_prices() to authenticated;
grant execute on function public.agent_save_customer_prices(jsonb) to authenticated;
grant execute on function public.get_agent_customer_prices(text) to anon, authenticated;
grant execute on function public.get_my_agent_afa_prices() to authenticated;
grant execute on function public.agent_save_afa_prices(jsonb) to authenticated;
grant execute on function public.get_public_agent_afa_prices(text) to anon, authenticated;
grant execute on function public.create_live_checkout_order(uuid,text,text,uuid,text,text,text) to service_role;
grant execute on function public.create_guest_live_checkout_order(text,text,text,uuid,text,text,text,text) to service_role;
grant execute on function public.create_wallet_bundle_order(uuid,text,text,uuid,text,text,text) to service_role;
