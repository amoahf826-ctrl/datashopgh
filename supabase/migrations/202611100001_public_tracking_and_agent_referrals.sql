-- Public tracking is handled by a server function using the unique Paystack
-- reference plus recipient phone. Let agents read orders made through their
-- referral storefront while preserving normal order ownership.
alter table public.orders
  add column if not exists referred_by_agent_id uuid references public.agent_accounts(user_id) on delete set null;

create index if not exists orders_referred_agent_created_idx
  on public.orders(referred_by_agent_id,created_at desc)
  where referred_by_agent_id is not null;

update public.orders o set referred_by_agent_id=(a.details->>'agent_id')::uuid
from public.audit_log a
where a.entity='order' and a.entity_id=o.id::text
  and a.action in ('live_checkout_created','wallet_bundle_purchase_created')
  and a.details->>'agent_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and o.referred_by_agent_id is null;

drop policy if exists "Read own orders" on public.orders;
drop policy if exists "Read own and referred orders" on public.orders;
create policy "Read own and referred orders" on public.orders for select to authenticated
  using (
    user_id=(select auth.uid())
    or public.is_admin()
    or (referred_by_agent_id=(select auth.uid()) and exists(
      select 1 from public.agent_accounts a where a.user_id=(select auth.uid()) and a.is_active
    ))
  );

create or replace function public.create_live_checkout_order(
  p_user_id uuid,p_bundle_id text,p_recipient_phone text,p_idempotency_key uuid,
  p_payment_reference text,p_delivery_reference text,p_agent_referral_code text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_agent uuid; v_price numeric(10,2); v_base_price numeric(10,2); v_order public.orders%rowtype;
begin
  v_result:=public.create_live_checkout_order(p_user_id,p_bundle_id,p_recipient_phone,p_idempotency_key,p_payment_reference,p_delivery_reference);
  select * into v_order from public.orders where id=(v_result->>'id')::uuid for update;
  if v_order.checkout_url is not null then return v_result; end if;
  if coalesce(trim(p_agent_referral_code),'')='' then return v_result; end if;
  select a.user_id into v_agent from public.agent_accounts a
    where a.referral_code=upper(trim(p_agent_referral_code)) and a.is_active;
  if v_agent is null then raise exception 'Agent referral link is invalid'; end if;
  if v_order.payment_status<>'unpaid' then return v_result; end if;
  select b.price into v_base_price from public.bundles b where b.id=p_bundle_id;
  select p.customer_price into v_price from public.agent_customer_bundle_prices p
    where p.agent_id=v_agent and p.bundle_id=p_bundle_id;
  v_price:=coalesce(v_price,v_base_price);
  update public.orders set price=v_price,referred_by_agent_id=v_agent where id=v_order.id;
  update public.audit_log set details=coalesce(details,'{}'::jsonb)||jsonb_build_object(
    'agent_id',v_agent,'customer_price',v_price,'base_price',v_base_price,
    'agent_profit',greatest(v_price-v_base_price,0))
    where entity='order' and entity_id=v_order.id::text and action='live_checkout_created';
  return v_result||jsonb_build_object('price',v_price);
end $$;
revoke all on function public.create_live_checkout_order(uuid,text,text,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.create_live_checkout_order(uuid,text,text,uuid,text,text,text) to service_role;

-- Keep unpaid checkouts pending long enough for Paystack's signed webhook to
-- confirm payment. Do not mark a just-returned-from-checkout order failed.
create or replace function public.reject_my_unpaid_checkouts()
returns integer language plpgsql security definer set search_path='' as $$
declare v_rejected integer;
begin
  if auth.uid() is null then raise exception 'Sign in is required' using errcode='42501'; end if;
  with rejected as (
    update public.orders
    set payment_status='failed',delivery_status='failed',status='failed',delivery_updated_at=now()
    where user_id=auth.uid() and is_demo=false and payment_reference is not null
      and payment_status='unpaid' and status='pending'
      and created_at < now()-interval '30 minutes'
    returning id,payment_reference,price
  )
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
    select auth.uid(),'unpaid_checkout_rejected','order',id::text,
      jsonb_build_object('payment_reference',payment_reference,'amount',price)
    from rejected;
  get diagnostics v_rejected=row_count;
  return v_rejected;
end $$;
revoke all on function public.reject_my_unpaid_checkouts() from public,anon;
grant execute on function public.reject_my_unpaid_checkouts() to authenticated;
