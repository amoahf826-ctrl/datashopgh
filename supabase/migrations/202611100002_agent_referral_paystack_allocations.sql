-- Allocate verified Paystack storefront proceeds for agent referral orders.
-- Delivered orders credit the provider-cost portion to the agent's main wallet;
-- the margin remains in the existing delivery-gated agent profit/cashout ledger.
-- A confirmed failed delivery credits the complete paid amount to the main wallet.
alter table public.ledger drop constraint if exists ledger_kind_check;
alter table public.ledger add constraint ledger_kind_check
  check (kind in ('deposit','purchase','refund','adjustment','referral_credit'));

create or replace function public.apply_agent_referral_wallet_allocation(p_order_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  v_order public.orders%rowtype;
  v_base_price numeric(12,2);
  v_credit numeric(12,2);
  v_key text;
  v_existing public.ledger%rowtype;
  v_before numeric(12,2);
  v_after numeric(12,2);
begin
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.referred_by_agent_id is null or v_order.payment_status<>'successful'
    or v_order.delivery_status not in ('delivered','failed') then
    return false;
  end if;

  if v_order.delivery_status='failed' then
    v_credit:=v_order.price;
  else
    select coalesce(nullif(a.details->>'base_price','')::numeric,b.price)
      into v_base_price
      from public.bundles b
      left join lateral (
        select details from public.audit_log
        where entity='order' and entity_id=v_order.id::text
          and action in ('live_checkout_created','wallet_bundle_purchase_created')
          and details->>'agent_id'=v_order.referred_by_agent_id::text
        order by created_at desc limit 1
      ) a on true
      where b.id=v_order.bundle_id;
    v_credit:=least(v_order.price,greatest(0,coalesce(v_base_price,0)));
  end if;

  v_key:='referral-main:'||v_order.id::text;
  if exists(select 1 from public.ledger where idempotency_key=v_key) then
    return true;
  end if;

  insert into public.wallets(user_id,balance) values(v_order.referred_by_agent_id,0)
    on conflict(user_id) do nothing;
  select balance into v_before from public.wallets
    where user_id=v_order.referred_by_agent_id for update;
  if not found then raise exception 'Agent wallet was not found for referral allocation'; end if;
  v_after:=v_before+v_credit;
  update public.wallets set balance=v_after,updated_at=now()
    where user_id=v_order.referred_by_agent_id;
  insert into public.ledger(user_id,kind,amount,reference_type,reference_id,idempotency_key,balance_before,balance_after,note)
    values(v_order.referred_by_agent_id,'referral_credit',v_credit,'order',v_order.id,v_key,v_before,v_after,
      case when v_order.delivery_status='failed' then 'Full paid amount credited after confirmed storefront delivery failure'
        else 'Provider-cost portion credited after successful referred storefront delivery' end);
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
    values(null,'agent_referral_wallet_allocated','order',v_order.id::text,jsonb_build_object(
      'agent_id',v_order.referred_by_agent_id,'credited_amount',v_credit,
      'delivery_status',v_order.delivery_status,'sale_price',v_order.price,
      'base_price',case when v_order.delivery_status='failed' then null else v_base_price end,
      'profit_amount',case when v_order.delivery_status='failed' then 0 else greatest(v_order.price-coalesce(v_base_price,v_order.price),0) end,
      'wallet_balance_before',v_before,'wallet_balance_after',v_after));
  return true;
end $$;
revoke all on function public.apply_agent_referral_wallet_allocation(uuid) from public,anon,authenticated;
grant execute on function public.apply_agent_referral_wallet_allocation(uuid) to service_role;

create or replace function public.trigger_agent_referral_wallet_allocation()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform public.apply_agent_referral_wallet_allocation(new.id);
  return new;
end $$;
drop trigger if exists allocate_agent_referral_order_wallet on public.orders;
create trigger allocate_agent_referral_order_wallet
  after update of payment_status,delivery_status,referred_by_agent_id on public.orders
  for each row execute function public.trigger_agent_referral_wallet_allocation();

-- Backfill existing referred orders whose payment and delivery outcomes are final.
do $$
declare v_order_id uuid;
begin
  for v_order_id in
    select id from public.orders
    where referred_by_agent_id is not null and payment_status='successful'
      and delivery_status in ('delivered','failed')
      and coalesce(payment_reference,'') not like 'WALLET-%'
  loop
    perform public.apply_agent_referral_wallet_allocation(v_order_id);
  end loop;
end $$;
