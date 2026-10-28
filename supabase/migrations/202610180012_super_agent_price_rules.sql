-- Price override rule: an active Super Agent may use their own saved prices.
-- Other customers and public visitors continue to use standard catalogue prices.

create or replace function public.get_my_super_agent_bundle_prices()
returns table(bundle_id text, override_price numeric(10,2))
language sql stable security definer set search_path = '' as $$
  select price.bundle_id, price.override_price
  from public.super_agent_bundle_prices as price
  join public.agent_accounts as account on account.user_id = price.super_agent_id
  where account.user_id = auth.uid()
    and account.agent_type = 'super_agent'
    and account.is_active
$$;
revoke all on function public.get_my_super_agent_bundle_prices() from public, anon;
grant execute on function public.get_my_super_agent_bundle_prices() to authenticated;

-- Live checkout uses a database-authoritative price; the browser cannot supply it.
create or replace function public.create_live_checkout_order(
  p_user_id uuid,
  p_bundle_id text,
  p_recipient_phone text,
  p_idempotency_key uuid,
  p_payment_reference text,
  p_delivery_reference text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_bundle public.bundles%rowtype;
  v_price numeric(10,2);
  v_override numeric(10,2);
begin
  if p_user_id is null or p_idempotency_key is null then raise exception 'Account and request key are required'; end if;
  if p_recipient_phone !~ '^0[0-9]{9}$' then raise exception 'Enter a valid Ghana phone number'; end if;

  select * into v_order from public.orders
    where user_id=p_user_id and idempotency_key=p_idempotency_key for update;
  if found then
    return jsonb_build_object('id',v_order.id,'price',v_order.price,'status',v_order.status,
      'payment_reference',v_order.payment_reference,'checkout_url',v_order.checkout_url);
  end if;

  select * into v_bundle from public.bundles
    where id=p_bundle_id and is_active and not is_demo
      and exists(select 1 from public.networks n where n.id=network and n.is_active);
  if not found then raise exception 'This live bundle is not available'; end if;
  v_price := v_bundle.price;

  select price.override_price into v_override
  from public.super_agent_bundle_prices as price
  join public.agent_accounts as account on account.user_id=price.super_agent_id
  where account.user_id=p_user_id and account.agent_type='super_agent' and account.is_active
    and price.bundle_id=p_bundle_id;
  if found then v_price := v_override; end if;

  insert into public.orders(user_id,bundle_id,recipient_phone,price,status,is_demo,idempotency_key,
    payment_reference,delivery_reference,payment_status,delivery_status)
  values(p_user_id,p_bundle_id,p_recipient_phone,v_price,'pending',false,p_idempotency_key,
    p_payment_reference,p_delivery_reference,'unpaid','not_started')
  returning * into v_order;
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
    values(p_user_id,'live_checkout_created','order',v_order.id::text,
      jsonb_build_object('bundle_id',p_bundle_id,'price',v_price,'super_agent_override',v_override is not null));
  return jsonb_build_object('id',v_order.id,'price',v_order.price,'status',v_order.status,
    'payment_reference',v_order.payment_reference,'checkout_url',v_order.checkout_url);
end;
$$;
revoke all on function public.create_live_checkout_order(uuid,text,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.create_live_checkout_order(uuid,text,text,uuid,text,text) to service_role;

-- Demo orders follow the same account eligibility rule, while public customers
-- continue to be charged/stored at the standard demo catalogue price.
create or replace function public.create_demo_order(p_bundle_id text, p_recipient_phone text, p_idempotency_key uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_order uuid := gen_random_uuid();
  v_price numeric(10,2);
  v_override numeric(10,2);
  v_inserted integer;
begin
  if v_user is null then raise exception 'Please sign in to place an order'; end if;
  if p_idempotency_key is null then raise exception 'Order key is required'; end if;
  if p_recipient_phone !~ '^0[0-9]{9}$' then raise exception 'Enter a valid 10 digit Ghanaian phone number'; end if;
  select b.price into v_price from public.bundles b join public.networks n on n.id=b.network
    where b.id=p_bundle_id and b.is_active and b.is_demo and n.is_active;
  if v_price is null then raise exception 'This demonstration bundle is unavailable'; end if;

  select price.override_price into v_override
  from public.super_agent_bundle_prices as price
  join public.agent_accounts as account on account.user_id=price.super_agent_id
  where account.user_id=v_user and account.agent_type='super_agent' and account.is_active
    and price.bundle_id=p_bundle_id;
  if found then v_price := v_override; end if;

  insert into public.orders(id,user_id,bundle_id,recipient_phone,price,status,is_demo,idempotency_key)
    values(v_order,v_user,p_bundle_id,p_recipient_phone,v_price,'pending',true,p_idempotency_key)
    on conflict(user_id,idempotency_key) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted=0 then
    select id into v_order from public.orders where user_id=v_user and idempotency_key=p_idempotency_key;
  else
    insert into public.audit_log(actor_id,action,entity,entity_id,details)
      values(v_user,'demo_order_created','order',v_order::text,
        jsonb_build_object('bundle_id',p_bundle_id,'demo',true,'price',v_price,'super_agent_override',v_override is not null));
  end if;
  return v_order;
end;
$$;
revoke all on function public.create_demo_order(text,text,uuid) from public, anon;
grant execute on function public.create_demo_order(text,text,uuid) to authenticated;
