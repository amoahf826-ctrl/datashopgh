-- Let any signed-in account use its own wallet balance to buy live data bundles.
-- The wallet debit, order, and purchase ledger entry commit atomically.

create or replace function public.create_wallet_bundle_order(
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
  v_balance numeric(12,2);
begin
  if p_user_id is null or p_idempotency_key is null then
    raise exception 'Account and request key are required';
  end if;
  if p_recipient_phone !~ '^0[0-9]{9}$' then
    raise exception 'Enter a valid 10 digit Ghanaian phone number';
  end if;
  if p_payment_reference !~ '^WALLET-[A-Fa-f0-9]{32}$' or p_delivery_reference !~ '^DS[A-Fa-f0-9]{23}$' then
    raise exception 'Invalid wallet order reference';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0));
  select * into v_order from public.orders
    where user_id=p_user_id and idempotency_key=p_idempotency_key for update;
  if found then
    if coalesce(v_order.payment_reference,'') not like 'WALLET-%' then
      raise exception 'This request key has already been used for another payment method';
    end if;
    select balance into v_balance from public.wallets where user_id=p_user_id;
    return jsonb_build_object('created',false,'order_id',v_order.id,'price',v_order.price,
      'order_status',v_order.status,'delivery_status',v_order.delivery_status,'wallet_balance',coalesce(v_balance,0));
  end if;

  select * into v_bundle from public.bundles
    where id=p_bundle_id and is_active and not is_demo
      and exists(select 1 from public.networks n where n.id=network and n.is_active);
  if not found then raise exception 'This live bundle is not available'; end if;
  v_price := v_bundle.price;

  select price.override_price into v_override
  from public.super_agent_bundle_prices as price
  join public.agent_accounts as account on account.user_id=price.super_agent_id
  where account.user_id=p_user_id and account.agent_type='super_agent'
    and account.is_active and price.bundle_id=p_bundle_id;
  if found then v_price := v_override; end if;

  insert into public.wallets(user_id,balance) values(p_user_id,0)
    on conflict(user_id) do nothing;
  select balance into v_balance from public.wallets where user_id=p_user_id for update;
  if v_balance is null then raise exception 'Wallet account was not found'; end if;
  if v_balance < v_price then raise exception 'Insufficient wallet balance. Add funds and try again'; end if;

  update public.wallets set balance=balance-v_price,updated_at=now()
    where user_id=p_user_id returning balance into v_balance;
  insert into public.orders(user_id,bundle_id,recipient_phone,price,status,is_demo,idempotency_key,
    payment_reference,delivery_reference,payment_status,delivery_status,payment_verified_at,delivery_updated_at)
  values(p_user_id,p_bundle_id,p_recipient_phone,v_price,'processing',false,p_idempotency_key,
    p_payment_reference,p_delivery_reference,'successful','queued',now(),now())
  returning * into v_order;
  insert into public.ledger(user_id,kind,amount,reference_type,reference_id,idempotency_key)
  values(p_user_id,'purchase',-v_price,'order',v_order.id,'wallet-order:'||v_order.id::text);
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
  values(p_user_id,'wallet_bundle_purchase_created','order',v_order.id::text,
    jsonb_build_object('bundle_id',p_bundle_id,'price',v_price,'recipient_phone',p_recipient_phone,
      'super_agent_override',v_override is not null));

  return jsonb_build_object('created',true,'order_id',v_order.id,'price',v_order.price,
    'order_status',v_order.status,'delivery_status',v_order.delivery_status,'wallet_balance',v_balance,
    'network',v_bundle.network,'size',v_bundle.size,'delivery_reference',v_order.delivery_reference);
end;
$$;
revoke all on function public.create_wallet_bundle_order(uuid,text,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.create_wallet_bundle_order(uuid,text,text,uuid,text,text) to service_role;

-- A wallet debit is refunded only after the provider reports a definite failure.
-- This also makes repeated provider callbacks safe.
create or replace function public.refund_failed_wallet_bundle_order(p_delivery_reference text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_balance numeric(12,2);
  v_refund_key text;
begin
  select * into v_order from public.orders
    where delivery_reference=p_delivery_reference for update;
  if not found then raise exception 'Order not found'; end if;
  if coalesce(v_order.payment_reference,'') not like 'WALLET-%' then
    return jsonb_build_object('refunded',false,'reason','not_wallet_order');
  end if;
  if v_order.delivery_status <> 'failed' then
    raise exception 'Wallet order must have a confirmed delivery failure before refund';
  end if;

  v_refund_key := 'wallet-order-refund:'||v_order.id::text;
  if exists(select 1 from public.ledger where idempotency_key=v_refund_key) then
    select balance into v_balance from public.wallets where user_id=v_order.user_id;
    return jsonb_build_object('refunded',false,'wallet_balance',v_balance,'order_id',v_order.id);
  end if;

  update public.wallets set balance=balance+v_order.price,updated_at=now()
    where user_id=v_order.user_id returning balance into v_balance;
  if not found then raise exception 'Wallet account was not found for refund'; end if;
  update public.orders set payment_status='failed',status='failed',delivery_updated_at=now()
    where id=v_order.id;
  insert into public.ledger(user_id,kind,amount,reference_type,reference_id,idempotency_key)
    values(v_order.user_id,'refund',v_order.price,'order',v_order.id,v_refund_key);
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
    values(null,'wallet_bundle_purchase_refunded','order',v_order.id::text,
      jsonb_build_object('amount',v_order.price,'delivery_reference',p_delivery_reference));
  return jsonb_build_object('refunded',true,'wallet_balance',v_balance,'order_id',v_order.id);
end;
$$;
revoke all on function public.refund_failed_wallet_bundle_order(text) from public,anon,authenticated;
grant execute on function public.refund_failed_wallet_bundle_order(text) to service_role;

-- Wallet orders are represented in the ledger; don't count their order price twice.
create or replace function public.admin_dashboard_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not public.is_admin() then raise exception 'Administrator access required' using errcode='42501'; end if;
  select jsonb_build_object(
    'customers',(select count(*) from public.profiles p where p.role='customer'),
    'orders',(select count(*) from public.orders),
    'successful',(select count(*) from public.orders o where o.is_demo=false and o.status='successful'),
    'pending',(select count(*) from public.orders o where o.is_demo=false and o.status in ('pending','processing')),
    'failed',(select count(*) from public.orders o where o.is_demo=false and o.status='failed'),
    'demo',(select count(*) from public.orders o where o.is_demo=true),
    'wallets',(select coalesce(sum(w.balance),0) from public.wallets w),
    'deposits',(select coalesce(sum(l.amount),0) from public.ledger l where l.kind='deposit' and l.amount>0),
    'purchases',(select coalesce(sum(abs(l.amount)),0) from public.ledger l where l.kind='purchase')-
      (select coalesce(sum(l.amount),0) from public.ledger l where l.kind='refund' and l.reference_type='order')+
      (select coalesce(sum(o.price),0) from public.orders o where o.is_demo=false and o.payment_status='successful'
        and (o.payment_reference is null or o.payment_reference not like 'WALLET-%')),
    'daily',(
      select coalesce(jsonb_agg(jsonb_build_object('day',to_char(days.day,'Mon DD'),'amount',coalesce(daily.amount,0)) order by days.day),'[]'::jsonb)
      from generate_series(current_date-6,current_date,interval '1 day') as days(day)
      left join (select l.created_at::date as day,sum(l.amount) as amount from public.ledger l
        where l.kind='deposit' and l.amount>0 and l.created_at>=current_date-6 group by l.created_at::date) daily
      on daily.day=days.day::date
    ),
    'recent_orders',(
      select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'recipient_phone',o.recipient_phone,'bundle_id',o.bundle_id,
        'size',b.size,'network',b.network,'price',o.price,'status',o.status,'is_demo',o.is_demo,'created_at',o.created_at)
        order by o.created_at desc),'[]'::jsonb)
      from (select * from public.orders order by created_at desc limit 8) o join public.bundles b on b.id=o.bundle_id
    ),
    'recent_customers',(
      select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'email',p.email,'created_at',p.created_at) order by p.created_at desc),'[]'::jsonb)
      from (select * from public.profiles where role='customer' order by created_at desc limit 5) p
    )
  ) into result;
  return result;
end;
$$;
revoke all on function public.admin_dashboard_summary() from public,anon;
grant execute on function public.admin_dashboard_summary() to authenticated;
