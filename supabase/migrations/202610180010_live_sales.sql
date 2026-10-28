-- Live Paystack checkout and Hubnet fulfillment remain disabled until an admin enables them.
alter table public.orders
  add column if not exists payment_reference text unique,
  add column if not exists payment_status text not null default 'unpaid',
  add column if not exists delivery_status text not null default 'not_started',
  add column if not exists delivery_reference text unique,
  add column if not exists provider_transaction_id text,
  add column if not exists payment_verified_at timestamptz,
  add column if not exists delivery_updated_at timestamptz,
  add column if not exists checkout_url text;

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('pending','processing','successful','failed'));
alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('unpaid','successful','failed'));
alter table public.orders drop constraint if exists orders_delivery_status_check;
alter table public.orders add constraint orders_delivery_status_check
  check (delivery_status in ('not_started','queued','processing','delivered','failed','unknown'));

alter table public.platform_settings drop constraint if exists platform_settings_key_check;
alter table public.platform_settings add constraint platform_settings_key_check
  check (key in ('storefront_maintenance','agent_dashboard_maintenance','storefront_live_sales'));
insert into public.platform_settings(key,value)
values ('storefront_live_sales','{"enabled":false}'::jsonb)
on conflict(key) do nothing;
drop policy if exists "Public read maintenance state" on public.platform_settings;
create policy "Public read storefront state" on public.platform_settings for select
  using (key in ('storefront_maintenance','storefront_live_sales'));

-- Creating a paid order is service-role only. Prices and eligibility come from the database.
create or replace function public.create_live_checkout_order(
  p_user_id uuid,
  p_bundle_id text,
  p_recipient_phone text,
  p_idempotency_key uuid,
  p_payment_reference text,
  p_delivery_reference text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_order public.orders%rowtype; v_bundle public.bundles%rowtype;
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

  insert into public.orders(user_id,bundle_id,recipient_phone,price,status,is_demo,idempotency_key,
    payment_reference,delivery_reference,payment_status,delivery_status)
  values(p_user_id,p_bundle_id,p_recipient_phone,v_bundle.price,'pending',false,p_idempotency_key,
    p_payment_reference,p_delivery_reference,'unpaid','not_started')
  returning * into v_order;
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
    values(p_user_id,'live_checkout_created','order',v_order.id::text,
      jsonb_build_object('bundle_id',p_bundle_id,'price',v_bundle.price));
  return jsonb_build_object('id',v_order.id,'price',v_order.price,'status',v_order.status,
    'payment_reference',v_order.payment_reference,'checkout_url',v_order.checkout_url);
end;
$$;
revoke all on function public.create_live_checkout_order(uuid,text,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.create_live_checkout_order(uuid,text,text,uuid,text,text) to service_role;

create or replace function public.save_live_checkout_url(p_order_id uuid,p_url text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_url is null or p_url !~ '^https://checkout\.paystack\.com/' then raise exception 'Invalid checkout URL'; end if;
  update public.orders set checkout_url=p_url where id=p_order_id and payment_status='unpaid';
  if not found then raise exception 'Pending checkout not found'; end if;
end;
$$;
revoke all on function public.save_live_checkout_url(uuid,text) from public,anon,authenticated;
grant execute on function public.save_live_checkout_url(uuid,text) to service_role;

-- Called only after Paystack's signed event and server-side verification both agree.
create or replace function public.claim_paid_order(p_reference text,p_amount integer,p_currency text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order public.orders%rowtype; v_bundle public.bundles%rowtype;
begin
  select * into v_order from public.orders where payment_reference=p_reference for update;
  if not found then raise exception 'Order reference not found'; end if;
  if upper(coalesce(p_currency,'')) <> 'GHS' or p_amount <> round(v_order.price*100)::integer then
    raise exception 'Verified payment amount or currency does not match the order';
  end if;
  if v_order.payment_status='successful' then
    return jsonb_build_object('newly_paid',false,'delivery_status',v_order.delivery_status);
  end if;
  update public.orders set payment_status='successful',payment_verified_at=now(),
    delivery_status='queued',delivery_updated_at=now(),status='processing'
    where id=v_order.id;
  select * into v_bundle from public.bundles where id=v_order.bundle_id;
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
    values(null,'payment_verified','order',v_order.id::text,jsonb_build_object(
      'payment_reference',p_reference,'amount',v_order.price,'currency','GHS'));
  return jsonb_build_object('newly_paid',true,'order_id',v_order.id,'phone',v_order.recipient_phone,
    'network',v_bundle.network,'size',v_bundle.size,'delivery_reference',v_order.delivery_reference);
end;
$$;
revoke all on function public.claim_paid_order(text,integer,text) from public,anon,authenticated;
grant execute on function public.claim_paid_order(text,integer,text) to service_role;

create or replace function public.update_live_order_delivery(
  p_reference text,p_delivery_status text,p_provider_transaction_id text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare v_order public.orders%rowtype; v_status text;
begin
  if p_delivery_status not in ('processing','delivered','failed','unknown') then raise exception 'Invalid delivery status'; end if;
  select * into v_order from public.orders where delivery_reference=p_reference for update;
  if not found or v_order.payment_status<>'successful' then raise exception 'Paid order not found'; end if;
  v_status := case when p_delivery_status='delivered' then 'successful'
                   when p_delivery_status='failed' then 'failed' else 'processing' end;
  update public.orders set delivery_status=p_delivery_status,status=v_status,
    provider_transaction_id=coalesce(p_provider_transaction_id,provider_transaction_id),delivery_updated_at=now()
    where id=v_order.id;
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
    values(null,'provider_delivery_'||p_delivery_status,'order',v_order.id::text,
      jsonb_build_object('delivery_reference',p_reference,'provider_transaction_id',p_provider_transaction_id));
end;
$$;
revoke all on function public.update_live_order_delivery(text,text,text) from public,anon,authenticated;
grant execute on function public.update_live_order_delivery(text,text,text) to service_role;

-- Include the direct Paystack bundle checkout path in the existing admin aggregate.
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
    'purchases',(select coalesce(sum(abs(l.amount)),0) from public.ledger l where l.kind='purchase')+
      (select coalesce(sum(o.price),0) from public.orders o where o.is_demo=false and o.payment_status='successful'),
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

-- Demo checkout may only create orders against demo catalogue rows.
create or replace function public.create_demo_order(p_bundle_id text, p_recipient_phone text, p_idempotency_key uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_order uuid := gen_random_uuid(); v_price numeric(10,2); v_inserted integer;
begin
  if v_user is null then raise exception 'Please sign in to place an order'; end if;
  if p_idempotency_key is null then raise exception 'Order key is required'; end if;
  if p_recipient_phone !~ '^0[0-9]{9}$' then raise exception 'Enter a valid 10 digit Ghanaian phone number'; end if;
  select b.price into v_price from public.bundles b join public.networks n on n.id=b.network
    where b.id=p_bundle_id and b.is_active and b.is_demo and n.is_active;
  if v_price is null then raise exception 'This demonstration bundle is unavailable'; end if;
  insert into public.orders(id,user_id,bundle_id,recipient_phone,price,status,is_demo,idempotency_key)
    values(v_order,v_user,p_bundle_id,p_recipient_phone,v_price,'pending',true,p_idempotency_key)
    on conflict(user_id,idempotency_key) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted=0 then
    select id into v_order from public.orders where user_id=v_user and idempotency_key=p_idempotency_key;
  else
    insert into public.audit_log(actor_id,action,entity,entity_id,details)
      values(v_user,'demo_order_created','order',v_order::text,jsonb_build_object('bundle_id',p_bundle_id,'demo',true));
  end if;
  return v_order;
end;
$$;
revoke all on function public.create_demo_order(text,text,uuid) from public;
grant execute on function public.create_demo_order(text,text,uuid) to authenticated;
