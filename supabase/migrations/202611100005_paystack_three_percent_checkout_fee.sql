-- Apply the admin-configured Paystack surcharge to direct bundle checkouts and
-- wallet top-ups. The fee is additive (GHS 50.00 + 3% = GHS 51.50).
alter table public.orders
  add column if not exists fee_amount numeric(10,2) not null default 0,
  add column if not exists charge_amount numeric(10,2);

update public.orders set charge_amount=price+fee_amount where charge_amount is null;

insert into public.platform_settings(key,value)
values ('paystack_fee_recovery','{"enabled":true,"rate_percent":3}'::jsonb)
on conflict(key) do update set value='{"enabled":true,"rate_percent":3}'::jsonb;

create or replace function public.prepare_paystack_order_charge(
  p_order_id uuid,p_fee_amount numeric,p_charge_amount numeric
) returns void language plpgsql security definer set search_path='' as $$
begin
  if p_fee_amount is null or p_fee_amount<0 or p_fee_amount<>round(p_fee_amount,2)
    or p_charge_amount is null or p_charge_amount<1 or p_charge_amount<>round(p_charge_amount,2) then
    raise exception 'Invalid Paystack fee quote';
  end if;
  update public.orders set fee_amount=p_fee_amount,charge_amount=p_charge_amount
    where id=p_order_id and payment_status='unpaid' and checkout_url is null
      and p_charge_amount=price+p_fee_amount
      and (charge_amount is null or (charge_amount=p_charge_amount and fee_amount=p_fee_amount));
  if not found then raise exception 'Order is not pending or its fee quote already changed'; end if;
end;
$$;
revoke all on function public.prepare_paystack_order_charge(uuid,numeric,numeric) from public,anon,authenticated;
grant execute on function public.prepare_paystack_order_charge(uuid,numeric,numeric) to service_role;

create or replace function public.save_live_checkout_url(
  p_order_id uuid,p_url text,p_fee_amount numeric,p_charge_amount numeric
) returns void language plpgsql security definer set search_path='' as $$
begin
  if p_url is null or p_url !~ '^https://checkout\.paystack\.com/' then raise exception 'Invalid checkout URL'; end if;
  update public.orders set checkout_url=p_url,fee_amount=p_fee_amount,charge_amount=p_charge_amount
    where id=p_order_id and payment_status='unpaid' and charge_amount=p_charge_amount and fee_amount=p_fee_amount;
  if not found then raise exception 'Pending checkout or fee quote not found'; end if;
end;
$$;
revoke all on function public.save_live_checkout_url(uuid,text,numeric,numeric) from public,anon,authenticated;
grant execute on function public.save_live_checkout_url(uuid,text,numeric,numeric) to service_role;

create or replace function public.claim_paid_order(p_reference text,p_amount integer,p_currency text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_order public.orders%rowtype; v_bundle public.bundles%rowtype;
begin
  select * into v_order from public.orders where payment_reference=p_reference for update;
  if not found then raise exception 'Order reference not found'; end if;
  if upper(coalesce(p_currency,''))<>'GHS'
    or p_amount<>round(coalesce(v_order.charge_amount,v_order.price)*100)::integer then
    raise exception 'Verified payment amount or currency does not match the order charge';
  end if;
  if v_order.payment_status='successful' then
    return jsonb_build_object('newly_paid',false,'delivery_status',v_order.delivery_status);
  end if;
  update public.orders set payment_status='successful',payment_verified_at=now(),
    delivery_status='queued',delivery_updated_at=now(),status='processing' where id=v_order.id;
  select * into v_bundle from public.bundles where id=v_order.bundle_id;
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
    values(null,'payment_verified','order',v_order.id::text,jsonb_build_object(
      'payment_reference',p_reference,'amount',v_order.price,'fee_amount',v_order.fee_amount,
      'charge_amount',coalesce(v_order.charge_amount,v_order.price),'currency','GHS'));
  return jsonb_build_object('newly_paid',true,'order_id',v_order.id,'phone',v_order.recipient_phone,
    'network',v_bundle.network,'size',v_bundle.size,'delivery_reference',v_order.delivery_reference);
end;
$$;
revoke all on function public.claim_paid_order(text,integer,text) from public,anon,authenticated;
grant execute on function public.claim_paid_order(text,integer,text) to service_role;

-- A failed referred order returns the entire customer charge, including the
-- Paystack surcharge, to the agent's in-app wallet.
create or replace function public.apply_agent_referral_wallet_allocation(p_order_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  v_order public.orders%rowtype;
  v_base_price numeric(12,2);
  v_credit numeric(12,2);
  v_key text;
  v_before numeric(12,2);
  v_after numeric(12,2);
begin
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.referred_by_agent_id is null or v_order.payment_status<>'successful'
    or v_order.delivery_status not in ('delivered','failed') then return false; end if;
  if v_order.delivery_status='failed' then
    v_credit:=coalesce(v_order.charge_amount,v_order.price);
  else
    select coalesce(nullif(a.details->>'base_price','')::numeric,b.price) into v_base_price
      from public.bundles b left join lateral (
        select details from public.audit_log where entity='order' and entity_id=v_order.id::text
          and action in ('live_checkout_created','wallet_bundle_purchase_created')
          and details->>'agent_id'=v_order.referred_by_agent_id::text order by created_at desc limit 1
      ) a on true where b.id=v_order.bundle_id;
    v_credit:=least(v_order.price,greatest(0,coalesce(v_base_price,0)));
  end if;
  v_key:='referral-main:'||v_order.id::text;
  if exists(select 1 from public.ledger where idempotency_key=v_key) then return true; end if;
  insert into public.wallets(user_id,balance) values(v_order.referred_by_agent_id,0) on conflict(user_id) do nothing;
  select balance into v_before from public.wallets where user_id=v_order.referred_by_agent_id for update;
  if not found then raise exception 'Agent wallet was not found for referral allocation'; end if;
  v_after:=v_before+v_credit;
  update public.wallets set balance=v_after,updated_at=now() where user_id=v_order.referred_by_agent_id;
  insert into public.ledger(user_id,kind,amount,reference_type,reference_id,idempotency_key,balance_before,balance_after,note)
    values(v_order.referred_by_agent_id,'referral_credit',v_credit,'order',v_order.id,v_key,v_before,v_after,
      case when v_order.delivery_status='failed' then 'Full Paystack customer charge credited after confirmed storefront delivery failure'
        else 'Provider-cost portion credited after successful referred storefront delivery' end);
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
    values(null,'agent_referral_wallet_allocated','order',v_order.id::text,jsonb_build_object(
      'agent_id',v_order.referred_by_agent_id,'credited_amount',v_credit,'delivery_status',v_order.delivery_status,
      'sale_price',v_order.price,'fee_amount',v_order.fee_amount,
      'base_price',case when v_order.delivery_status='failed' then null else v_base_price end,
      'profit_amount',case when v_order.delivery_status='failed' then 0 else greatest(v_order.price-coalesce(v_base_price,v_order.price),0) end,
      'wallet_balance_before',v_before,'wallet_balance_after',v_after));
  return true;
end $$;
revoke all on function public.apply_agent_referral_wallet_allocation(uuid) from public,anon,authenticated;
grant execute on function public.apply_agent_referral_wallet_allocation(uuid) to service_role;
