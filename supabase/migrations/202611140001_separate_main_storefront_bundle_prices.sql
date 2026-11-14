-- Keep main-store customer prices independent from catalogue prices used by agents.
create table if not exists public.main_storefront_bundle_prices (
  bundle_id text primary key references public.bundles(id) on delete cascade,
  customer_price numeric(10,2) not null check (customer_price >= 0),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

alter table public.main_storefront_bundle_prices enable row level security;
revoke all on public.main_storefront_bundle_prices from public, anon, authenticated;

-- Preserve the prices currently displayed on the main storefront before separating them.
insert into public.main_storefront_bundle_prices(bundle_id, customer_price)
select id, price from public.bundles
on conflict(bundle_id) do nothing;

create or replace function public.get_main_storefront_bundle_prices()
returns table(bundle_id text, customer_price numeric)
language sql stable security definer set search_path = '' as $$
  select price.bundle_id, price.customer_price
  from public.main_storefront_bundle_prices price
  join public.bundles bundle on bundle.id = price.bundle_id
  where bundle.is_active and not bundle.is_demo
  order by price.bundle_id
$$;
revoke all on function public.get_main_storefront_bundle_prices() from public;
grant execute on function public.get_main_storefront_bundle_prices() to anon, authenticated;

create or replace function public.admin_save_main_storefront_bundle_prices(p_prices jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  item jsonb;
  v_bundle_id text;
  v_price numeric(10,2);
  v_count integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_prices) <> 'array' or jsonb_array_length(p_prices) > 500 then
    raise exception 'Invalid main storefront price list';
  end if;
  for item in select value from jsonb_array_elements(p_prices) loop
    v_bundle_id := item->>'bundle_id';
    begin
      v_price := (item->>'price')::numeric(10,2);
    exception when others then
      raise exception 'Every main storefront price must be a valid amount';
    end;
    if v_bundle_id is null or v_price < 0 or v_price > 100000 then
      raise exception 'Main storefront price is outside the allowed range';
    end if;
    insert into public.main_storefront_bundle_prices(bundle_id,customer_price,updated_by,updated_at)
    values(v_bundle_id,v_price,auth.uid(),now())
    on conflict(bundle_id) do update set customer_price=excluded.customer_price,
      updated_by=excluded.updated_by,updated_at=excluded.updated_at;
    v_count := v_count + 1;
  end loop;
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
  values(auth.uid(),'update_main_storefront_bundle_prices','main_storefront_bundle_prices','catalogue',
    jsonb_build_object('updated_count',v_count));
  return v_count;
end;
$$;
revoke all on function public.admin_save_main_storefront_bundle_prices(jsonb) from public, anon;
grant execute on function public.admin_save_main_storefront_bundle_prices(jsonb) to authenticated;

-- Use the isolated main-store price only for regular storefront checkouts.
-- Agent referral prices continue to use their own override or catalogue price.
create or replace function public.create_live_checkout_order(
  p_user_id uuid,p_bundle_id text,p_recipient_phone text,p_idempotency_key uuid,
  p_payment_reference text,p_delivery_reference text,p_agent_referral_code text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
  v_agent uuid;
  v_price numeric(10,2);
  v_base_price numeric(10,2);
  v_order public.orders%rowtype;
begin
  v_result := public.create_live_checkout_order(p_user_id,p_bundle_id,p_recipient_phone,
    p_idempotency_key,p_payment_reference,p_delivery_reference);
  select * into v_order from public.orders where id=(v_result->>'id')::uuid for update;
  if v_order.checkout_url is not null or v_order.payment_status <> 'unpaid' then return v_result; end if;
  select bundle.price into v_base_price from public.bundles bundle where bundle.id=p_bundle_id;

  if coalesce(trim(p_agent_referral_code),'') = '' then
    select customer_price into v_price from public.main_storefront_bundle_prices where bundle_id=p_bundle_id;
    v_price := coalesce(v_price,v_base_price);
    update public.orders set price=v_price where id=v_order.id;
    update public.audit_log set details=coalesce(details,'{}'::jsonb)||jsonb_build_object(
      'price',v_price,'base_price',v_base_price,'main_storefront_price',v_price)
      where entity='order' and entity_id=v_order.id::text and action='live_checkout_created';
    return v_result||jsonb_build_object('price',v_price);
  end if;

  select account.user_id into v_agent from public.agent_accounts account
    where upper(account.referral_code)=upper(trim(p_agent_referral_code)) and account.is_active;
  if v_agent is null then raise exception 'Agent referral link is invalid'; end if;
  select customer_price into v_price from public.agent_customer_bundle_prices
    where agent_id=v_agent and bundle_id=p_bundle_id;
  v_price := coalesce(v_price,v_base_price);
  update public.orders set price=v_price,referred_by_agent_id=v_agent where id=v_order.id;
  update public.audit_log set details=coalesce(details,'{}'::jsonb)||jsonb_build_object(
    'agent_id',v_agent,'customer_price',v_price,'base_price',v_base_price,
    'agent_profit',greatest(v_price-v_base_price,0))
    where entity='order' and entity_id=v_order.id::text and action='live_checkout_created';
  return v_result||jsonb_build_object('price',v_price);
end;
$$;
revoke all on function public.create_live_checkout_order(uuid,text,text,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.create_live_checkout_order(uuid,text,text,uuid,text,text,text) to service_role;

-- Guest storefront checkout applies the same main-store price while keeping
-- referral checkouts tied to the selected agent's own customer price.
create or replace function public.create_guest_live_checkout_order(
  p_email text,p_bundle_id text,p_recipient_phone text,p_idempotency_key uuid,
  p_payment_reference text,p_delivery_reference text,p_agent_referral_code text,p_client_ip text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_bundle public.bundles%rowtype;
  v_agent uuid;
  v_price numeric(10,2);
  v_ip_key text;
  v_count integer;
begin
  if p_email is null or length(trim(p_email))>254 or trim(p_email)!~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
    or p_recipient_phone is null or p_recipient_phone!~'^0[0-9]{9}$'
    or p_idempotency_key is null or p_bundle_id is null
    or p_payment_reference !~ '^DSGH-[A-Fa-f0-9]{32}$'
    or p_delivery_reference !~ '^DS[A-Fa-f0-9]{23}$'
    or coalesce(length(trim(p_client_ip)),0)<3 or length(trim(p_client_ip))>64 then
    raise exception 'Enter a valid email and Ghana phone number';
  end if;
  select * into v_order from public.orders where user_id is null and idempotency_key=p_idempotency_key for update;
  if found then
    if v_order.customer_email<>lower(trim(p_email)) or v_order.recipient_phone<>p_recipient_phone or v_order.bundle_id<>p_bundle_id then
      raise exception 'Checkout request key was already used for different order details';
    end if;
    return jsonb_build_object('id',v_order.id,'price',v_order.price,'status',v_order.status,
      'payment_reference',v_order.payment_reference,'checkout_url',v_order.checkout_url);
  end if;
  v_ip_key := 'ip:'||encode(sha256(convert_to(trim(p_client_ip),'UTF8')),'hex');
  delete from public.public_checkout_rate_limits where window_started_at<now()-interval '1 day';
  insert into public.public_checkout_rate_limits as existing(rate_key,window_started_at,request_count)
    values(v_ip_key,now(),1)
    on conflict(rate_key) do update set
      window_started_at=case when existing.window_started_at<=now()-interval '10 minutes' then now() else existing.window_started_at end,
      request_count=case when existing.window_started_at<=now()-interval '10 minutes' then 1 else existing.request_count+1 end
    returning request_count into v_count;
  if v_count>5 then return jsonb_build_object('rate_limited',true); end if;

  select * into v_bundle from public.bundles bundle
    where bundle.id=p_bundle_id and bundle.is_active and not bundle.is_demo
      and exists(select 1 from public.networks network where network.id=bundle.network and network.is_active);
  if not found then raise exception 'This live bundle is not available'; end if;
  v_price := v_bundle.price;
  if coalesce(trim(p_agent_referral_code),'') <> '' then
    select account.user_id into v_agent from public.agent_accounts account
      where account.referral_code=upper(trim(p_agent_referral_code)) and account.is_active;
    if v_agent is null then raise exception 'Agent referral link is invalid'; end if;
    select customer_price into v_price from public.agent_customer_bundle_prices
      where agent_id=v_agent and bundle_id=p_bundle_id;
    v_price := coalesce(v_price,v_bundle.price);
  else
    select customer_price into v_price from public.main_storefront_bundle_prices where bundle_id=p_bundle_id;
    v_price := coalesce(v_price,v_bundle.price);
  end if;
  insert into public.orders(user_id,bundle_id,recipient_phone,price,status,is_demo,idempotency_key,
    payment_reference,delivery_reference,payment_status,delivery_status,referred_by_agent_id,customer_email)
  values(null,p_bundle_id,p_recipient_phone,v_price,'pending',false,p_idempotency_key,
    p_payment_reference,p_delivery_reference,'unpaid','not_started',v_agent,lower(trim(p_email)))
  returning * into v_order;
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
  values(null,'live_checkout_created','order',v_order.id::text,jsonb_build_object(
    'bundle_id',p_bundle_id,'price',v_price,'guest_checkout',true,'agent_id',v_agent,
    'base_price',v_bundle.price,'main_storefront_price',case when v_agent is null then v_price else null end,
    'agent_profit',case when v_agent is null then 0 else greatest(v_price-v_bundle.price,0) end));
  return jsonb_build_object('id',v_order.id,'price',v_order.price,'status',v_order.status,
    'payment_reference',v_order.payment_reference,'checkout_url',v_order.checkout_url);
end;
$$;
revoke all on function public.create_guest_live_checkout_order(text,text,text,uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.create_guest_live_checkout_order(text,text,text,uuid,text,text,text,text) to service_role;
