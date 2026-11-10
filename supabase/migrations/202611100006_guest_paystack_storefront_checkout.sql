-- Allow signed-out storefront buyers to place Paystack orders without creating
-- an auth account. Guest order tracking continues to use phone number.
alter table public.orders alter column user_id drop not null;
alter table public.orders add column if not exists customer_email text;
create unique index if not exists orders_guest_idempotency_key_idx
  on public.orders(idempotency_key) where user_id is null;

create table if not exists public.public_checkout_rate_limits (
  rate_key text primary key,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0 check (request_count >= 0)
);
alter table public.public_checkout_rate_limits enable row level security;
revoke all on public.public_checkout_rate_limits from public,anon,authenticated;

create or replace function public.create_guest_live_checkout_order(
  p_email text,p_bundle_id text,p_recipient_phone text,p_idempotency_key uuid,
  p_payment_reference text,p_delivery_reference text,p_agent_referral_code text,p_client_ip text
) returns jsonb language plpgsql security definer set search_path='' as $$
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

  v_ip_key:='ip:'||encode(sha256(convert_to(trim(p_client_ip),'UTF8')),'hex');
  delete from public.public_checkout_rate_limits where window_started_at<now()-interval '1 day';
  insert into public.public_checkout_rate_limits as existing(rate_key,window_started_at,request_count)
    values(v_ip_key,now(),1)
    on conflict(rate_key) do update set
      window_started_at=case when existing.window_started_at<=now()-interval '10 minutes' then now() else existing.window_started_at end,
      request_count=case when existing.window_started_at<=now()-interval '10 minutes' then 1 else existing.request_count+1 end
    returning request_count into v_count;
  if v_count>5 then return jsonb_build_object('rate_limited',true); end if;

  select * into v_bundle from public.bundles
    where id=p_bundle_id and is_active and not is_demo
      and exists(select 1 from public.networks n where n.id=network and n.is_active);
  if not found then raise exception 'This live bundle is not available'; end if;
  v_price:=v_bundle.price;
  if coalesce(trim(p_agent_referral_code),'')<>'' then
    select a.user_id into v_agent from public.agent_accounts a
      where a.referral_code=upper(trim(p_agent_referral_code)) and a.is_active;
    if v_agent is null then raise exception 'Agent referral link is invalid'; end if;
    select p.customer_price into v_price from public.agent_customer_bundle_prices p
      where p.agent_id=v_agent and p.bundle_id=p_bundle_id;
    v_price:=coalesce(v_price,v_bundle.price);
  end if;

  insert into public.orders(user_id,bundle_id,recipient_phone,price,status,is_demo,idempotency_key,
    payment_reference,delivery_reference,payment_status,delivery_status,referred_by_agent_id,customer_email)
  values(null,p_bundle_id,p_recipient_phone,v_price,'pending',false,p_idempotency_key,
    p_payment_reference,p_delivery_reference,'unpaid','not_started',v_agent,lower(trim(p_email)))
  returning * into v_order;
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
    values(null,'live_checkout_created','order',v_order.id::text,jsonb_build_object(
      'bundle_id',p_bundle_id,'price',v_price,'guest_checkout',true,'agent_id',v_agent,
      'base_price',v_bundle.price,'agent_profit',greatest(v_price-v_bundle.price,0)));
  return jsonb_build_object('id',v_order.id,'price',v_order.price,'status',v_order.status,
    'payment_reference',v_order.payment_reference,'checkout_url',v_order.checkout_url);
end;
$$;
revoke all on function public.create_guest_live_checkout_order(text,text,text,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.create_guest_live_checkout_order(text,text,text,uuid,text,text,text,text) to service_role;
