-- BECE and WASSCE voucher purchases. Voucher PINs are visible only to the buyer
-- and administrators; all provider calls and payment state changes use service role.
alter table public.platform_settings drop constraint if exists platform_settings_key_check;
alter table public.platform_settings add constraint platform_settings_key_check
  check (key in ('storefront_maintenance','agent_dashboard_maintenance','storefront_live_sales',
    'wallet_deposits_enabled','active_bundle_provider','storefront_contact','paystack_fee_recovery',
    'agent_cashout_policy','result_checker_pricing'));

insert into public.platform_settings(key,value)
values ('result_checker_pricing','{"enabled":true,"prices":{"BECE":20,"WASSCE":20},"agent_prices":{"BECE":17,"WASSCE":17}}'::jsonb)
on conflict(key) do nothing;

create table if not exists public.result_checker_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  referred_by_agent_id uuid references auth.users(id) on delete set null,
  voucher_type text not null check(voucher_type in ('BECE','WASSCE')),
  recipient_phone text not null check(recipient_phone ~ '^0[0-9]{9}$'),
  quantity integer not null check(quantity between 1 and 100),
  unit_price numeric(12,2) not null check(unit_price >= 0),
  total_amount numeric(12,2) not null check(total_amount > 0),
  fee_amount numeric(12,2) not null default 0 check(fee_amount >= 0),
  charge_amount numeric(12,2) not null check(charge_amount > 0),
  payment_method text not null check(payment_method in ('paystack','wallet')),
  payment_reference text unique,
  payment_status text not null default 'unpaid' check(payment_status in ('unpaid','successful','failed')),
  status text not null default 'pending_payment' check(status in ('pending_payment','processing','completed','failed','needs_review')),
  refund_status text not null default 'none' check(refund_status in ('none','pending','processing','completed','failed')),
  vouchers jsonb not null default '[]'::jsonb,
  provider_transactions jsonb not null default '[]'::jsonb,
  provider_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists result_checker_orders_user_recent_idx on public.result_checker_orders(user_id,created_at desc);
create index if not exists result_checker_orders_agent_recent_idx on public.result_checker_orders(referred_by_agent_id,created_at desc);
create index if not exists result_checker_orders_status_recent_idx on public.result_checker_orders(status,created_at desc);
alter table public.result_checker_orders enable row level security;
revoke all on public.result_checker_orders from public,anon;
grant select on public.result_checker_orders to authenticated;
drop policy if exists "Buyers and admins read result checker orders" on public.result_checker_orders;
create policy "Buyers and admins read result checker orders" on public.result_checker_orders for select to authenticated
  using (user_id=auth.uid() or public.is_admin());

create or replace function public.create_result_checker_wallet_order(p_user_id uuid,p_voucher_type text,p_phone text,p_quantity integer,p_reference text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_order public.result_checker_orders%rowtype;
  v_wallet_price numeric(12,2);
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
  select coalesce((s.value->>'enabled')::boolean,false),coalesce((s.value->'agent_prices'->>upper(p_voucher_type))::numeric,0)
    into v_enabled,v_wallet_price from public.platform_settings s where s.key='result_checker_pricing';
  if not coalesce(v_enabled,false) or coalesce(v_wallet_price,0)<=0 then raise exception 'This result checker is currently unavailable'; end if;
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
    values(p_user_id,'result_checker_wallet_purchase_created','result_checker_order',v_order.id::text,jsonb_build_object('type',v_order.voucher_type,'quantity',p_quantity,'amount',v_total));
  return jsonb_build_object('order_id',v_order.id,'wallet_balance',v_balance,'total_amount',v_total);
end $$;
revoke all on function public.create_result_checker_wallet_order(uuid,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.create_result_checker_wallet_order(uuid,text,text,integer,text) to service_role;

create or replace function public.finish_result_checker_order(p_order_id uuid,p_status text,p_vouchers jsonb,p_transactions jsonb,p_message text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_order public.result_checker_orders%rowtype; v_balance numeric(12,2); v_status text:=p_status;
begin
  if p_status not in ('completed','failed','needs_review') then raise exception 'Invalid result checker state'; end if;
  select * into v_order from public.result_checker_orders where id=p_order_id for update;
  if not found then raise exception 'Result checker order was not found'; end if;
  if v_order.status='completed' then return jsonb_build_object('completed',true,'duplicate',true); end if;
  if v_order.status in ('failed','needs_review') then return jsonb_build_object('completed',false,'duplicate',true,'status',v_order.status); end if;
  if v_status='failed' and v_order.payment_method='wallet' then
    update public.wallets set balance=balance+v_order.total_amount,updated_at=now() where user_id=v_order.user_id returning balance into v_balance;
    if not found then raise exception 'Could not return the wallet debit'; end if;
    insert into public.ledger(user_id,kind,amount,reference_type,reference_id,idempotency_key)
      values(v_order.user_id,'refund',v_order.total_amount,'result_checker_order',v_order.id,'result-checker-refund:'||v_order.id::text) on conflict(idempotency_key) do nothing;
    insert into public.audit_log(actor_id,action,entity,entity_id,details)
      values(null,'result_checker_wallet_purchase_refunded','result_checker_order',v_order.id::text,jsonb_build_object('amount',v_order.total_amount,'message',left(coalesce(p_message,''),300)));
  end if;
  update public.result_checker_orders set status=v_status,
    vouchers=case when v_status='completed' then coalesce(p_vouchers,'[]'::jsonb) else vouchers end,
    provider_transactions=coalesce(p_transactions,'[]'::jsonb),provider_message=left(coalesce(p_message,''),500),updated_at=now()
    where id=p_order_id;
  return jsonb_build_object('completed',v_status='completed','status',v_status,'wallet_balance',v_balance,'order_id',p_order_id);
end $$;
revoke all on function public.finish_result_checker_order(uuid,text,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.finish_result_checker_order(uuid,text,jsonb,jsonb,text) to service_role;
