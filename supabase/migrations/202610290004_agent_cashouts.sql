alter table public.agent_accounts
  add column if not exists cashout_momo_network text,
  add column if not exists cashout_momo_phone text;

alter table public.agent_accounts drop constraint if exists agent_accounts_cashout_momo_network_check;
alter table public.agent_accounts add constraint agent_accounts_cashout_momo_network_check
  check (cashout_momo_network is null or cashout_momo_network in ('MTN','Telecel','AT'));
alter table public.agent_accounts drop constraint if exists agent_accounts_cashout_momo_phone_check;
alter table public.agent_accounts add constraint agent_accounts_cashout_momo_phone_check
  check (cashout_momo_phone is null or cashout_momo_phone ~ '^0[0-9]{9}$');

create table if not exists public.agent_cashout_requests (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agent_accounts(user_id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 1),
  momo_network text not null check (momo_network in ('MTN','Telecel','AT')),
  momo_phone text not null check (momo_phone ~ '^0[0-9]{9}$'),
  status text not null default 'pending' check (status in ('pending','processing','paid','rejected')),
  payout_reference text,
  admin_note text,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_by uuid references auth.users(id),
  processed_at timestamptz
);

create index if not exists agent_cashout_requests_agent_date
  on public.agent_cashout_requests(agent_id, requested_at desc);
create index if not exists agent_cashout_requests_status_date
  on public.agent_cashout_requests(status, requested_at desc);

alter table public.agent_cashout_requests enable row level security;
grant select on public.agent_cashout_requests to authenticated;
drop policy if exists "Agents and admins read cashout requests" on public.agent_cashout_requests;
create policy "Agents and admins read cashout requests" on public.agent_cashout_requests
  for select to authenticated using (agent_id=(select auth.uid()) or public.is_admin());

create or replace function public.get_my_agent_earnings()
returns table(order_id uuid, bundle_size text, network text, sale_price numeric, base_price numeric, profit numeric, created_at timestamptz)
language sql stable security definer set search_path='' as $$
  select o.id,b.size,b.network,o.price,
    coalesce(nullif(a.details->>'base_price','')::numeric,b.price),
    greatest(o.price-coalesce(nullif(a.details->>'base_price','')::numeric,b.price),0),o.created_at
  from public.audit_log a
  join public.orders o on o.id::text=a.entity_id
  join public.bundles b on b.id=o.bundle_id
  where a.entity='order' and a.action in ('live_checkout_created','wallet_bundle_purchase_created')
    and a.details->>'agent_id'=(select auth.uid())::text
    and o.is_demo=false and o.payment_status='successful'
    and o.delivery_status='delivered' and o.status='successful'
    and not exists(select 1 from public.ledger l where l.reference_type='order' and l.reference_id=o.id and l.kind='refund')
  order by o.created_at desc;
$$;

create or replace function public.get_my_agent_cashout_summary()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_agent public.agent_accounts%rowtype; v_earned numeric(12,2); v_reserved numeric(12,2); v_paid numeric(12,2);
begin
  select * into v_agent from public.agent_accounts where user_id=(select auth.uid()) and is_active;
  if not found then raise exception 'Active agent account required' using errcode='42501'; end if;
  select coalesce(sum(greatest(o.price-coalesce(nullif(a.details->>'base_price','')::numeric,b.price),0)),0)
    into v_earned
    from public.audit_log a join public.orders o on o.id::text=a.entity_id join public.bundles b on b.id=o.bundle_id
    where a.entity='order' and a.action in ('live_checkout_created','wallet_bundle_purchase_created')
      and a.details->>'agent_id'=(select auth.uid())::text and o.is_demo=false
      and o.payment_status='successful' and o.delivery_status='delivered' and o.status='successful'
      and not exists(select 1 from public.ledger l where l.reference_type='order' and l.reference_id=o.id and l.kind='refund');
  select coalesce(sum(amount) filter(where status in ('pending','processing')),0),
         coalesce(sum(amount) filter(where status='paid'),0)
    into v_reserved,v_paid from public.agent_cashout_requests where agent_id=(select auth.uid());
  return jsonb_build_object('earned',v_earned,'reserved',v_reserved,'paid',v_paid,
    'available',greatest(0,v_earned-v_reserved-v_paid),
    'momo_network',v_agent.cashout_momo_network,'momo_phone',v_agent.cashout_momo_phone);
end $$;

create or replace function public.agent_save_cashout_profile(p_network text,p_phone text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_phone text; v_network text:=upper(trim(coalesce(p_network,'')));
begin
  if v_network not in ('MTN','TELECEL','AT') then raise exception 'Choose MTN MoMo, Telecel Cash, or AT Money'; end if;
  v_phone:=regexp_replace(coalesce(p_phone,''),'[^0-9]','','g');
  if length(v_phone)=12 and left(v_phone,3)='233' then v_phone:='0'||substr(v_phone,4);
  elsif length(v_phone)=9 and left(v_phone,1)<>'0' then v_phone:='0'||v_phone; end if;
  if v_phone !~ '^0[0-9]{9}$' then raise exception 'Enter a valid Ghana MoMo number'; end if;
  update public.agent_accounts set cashout_momo_network=case v_network when 'TELECEL' then 'Telecel' when 'AT' then 'AT' else 'MTN' end,
    cashout_momo_phone=v_phone where user_id=(select auth.uid()) and is_active;
  if not found then raise exception 'Active agent account required' using errcode='42501'; end if;
  return public.get_my_agent_cashout_summary();
end $$;

create or replace function public.agent_request_cashout(p_amount numeric)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_agent public.agent_accounts%rowtype; v_available numeric(12,2); v_earned numeric(12,2); v_reserved numeric(12,2); v_paid numeric(12,2); v_request uuid;
begin
  select * into v_agent from public.agent_accounts where user_id=(select auth.uid()) and is_active for update;
  if not found then raise exception 'Active agent account required' using errcode='42501'; end if;
  if v_agent.cashout_momo_network is null or v_agent.cashout_momo_phone is null then raise exception 'Save your MoMo payout details first'; end if;
  if p_amount is null or p_amount<1 or p_amount<>round(p_amount,2) then raise exception 'Cashout minimum is GHS 1.00'; end if;
  select coalesce(sum(greatest(o.price-coalesce(nullif(a.details->>'base_price','')::numeric,b.price),0)),0)
    into v_earned
    from public.audit_log a join public.orders o on o.id::text=a.entity_id join public.bundles b on b.id=o.bundle_id
    where a.entity='order' and a.action in ('live_checkout_created','wallet_bundle_purchase_created')
      and a.details->>'agent_id'=(select auth.uid())::text and o.is_demo=false
      and o.payment_status='successful' and o.delivery_status='delivered' and o.status='successful'
      and not exists(select 1 from public.ledger l where l.reference_type='order' and l.reference_id=o.id and l.kind='refund');
  select coalesce(sum(amount) filter(where status in ('pending','processing')),0),
         coalesce(sum(amount) filter(where status='paid'),0)
    into v_reserved,v_paid from public.agent_cashout_requests where agent_id=(select auth.uid());
  v_available:=greatest(0,v_earned-v_reserved-v_paid);
  if p_amount>v_available then raise exception 'Cashout exceeds your available profit of GHS %',to_char(v_available,'FM999999990.00'); end if;
  insert into public.agent_cashout_requests(agent_id,amount,momo_network,momo_phone)
    values(v_agent.user_id,p_amount,v_agent.cashout_momo_network,v_agent.cashout_momo_phone) returning id into v_request;
  return v_request;
end $$;

create or replace function public.admin_update_agent_cashout(p_request_id uuid,p_status text,p_reference text default null,p_note text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_request public.agent_cashout_requests%rowtype; v_next text:=lower(trim(coalesce(p_status,'')));
begin
  if not public.is_admin() then raise exception 'Administrator access required' using errcode='42501'; end if;
  if v_next not in ('processing','paid','rejected') then raise exception 'Invalid cashout status'; end if;
  select * into v_request from public.agent_cashout_requests where id=p_request_id for update;
  if not found then raise exception 'Cashout request not found'; end if;
  if v_request.status not in ('pending','processing') then raise exception 'This cashout request has already been resolved'; end if;
  if v_next='paid' and coalesce(trim(p_reference),'')='' then raise exception 'Enter the MoMo transfer reference before marking this request paid'; end if;
  update public.agent_cashout_requests set status=v_next,
    payout_reference=case when v_next='paid' then trim(p_reference) else payout_reference end,
    admin_note=nullif(trim(coalesce(p_note,'')),''),updated_at=now(),
    processed_by=case when v_next in ('paid','rejected') then (select auth.uid()) else processed_by end,
    processed_at=case when v_next in ('paid','rejected') then now() else processed_at end
    where id=p_request_id;
  return true;
end $$;

-- Capture the catalogue cost when the order is attributed so later catalogue edits
-- cannot change the agent's recorded profit.
create or replace function public.create_live_checkout_order(
  p_user_id uuid,p_bundle_id text,p_recipient_phone text,p_idempotency_key uuid,
  p_payment_reference text,p_delivery_reference text,p_agent_referral_code text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_agent uuid; v_price numeric(10,2); v_base_price numeric(10,2); v_order public.orders%rowtype;
begin
  v_result:=public.create_live_checkout_order(p_user_id,p_bundle_id,p_recipient_phone,p_idempotency_key,p_payment_reference,p_delivery_reference);
  select * into v_order from public.orders where id=(v_result->>'id')::uuid for update;
  if v_order.checkout_url is not null or v_order.payment_status<>'unpaid' or coalesce(trim(p_agent_referral_code),'')='' then return v_result; end if;
  select b.price into v_base_price from public.bundles b where b.id=p_bundle_id;
  select a.user_id into v_agent from public.agent_accounts a where a.referral_code=upper(trim(p_agent_referral_code)) and a.is_active;
  if v_agent is null then raise exception 'Agent referral link is invalid'; end if;
  select p.customer_price into v_price from public.agent_customer_bundle_prices p where p.agent_id=v_agent and p.bundle_id=p_bundle_id;
  v_price:=coalesce(v_price,v_base_price);
  update public.orders set price=v_price where id=v_order.id;
  update public.audit_log set details=coalesce(details,'{}'::jsonb)||jsonb_build_object(
    'agent_id',v_agent,'customer_price',v_price,'base_price',v_base_price,
    'agent_profit',greatest(v_price-v_base_price,0))
    where entity='order' and entity_id=v_order.id::text and action='live_checkout_created';
  return v_result||jsonb_build_object('price',v_price);
end $$;

-- Wallet purchases made through an agent storefront use the agent's customer
-- price and persist the same attribution used by the earnings ledger.
create or replace function public.create_wallet_bundle_order(
  p_user_id uuid,p_bundle_id text,p_recipient_phone text,p_idempotency_key uuid,
  p_payment_reference text,p_delivery_reference text,p_agent_referral_code text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_result jsonb; v_order public.orders%rowtype; v_agent uuid;
  v_price numeric(10,2); v_base_price numeric(10,2); v_balance numeric(12,2);
  v_delta numeric(10,2);
begin
  v_result:=public.create_wallet_bundle_order(p_user_id,p_bundle_id,p_recipient_phone,p_idempotency_key,p_payment_reference,p_delivery_reference);
  if coalesce((v_result->>'created')::boolean,false) is not true
    or coalesce(trim(p_agent_referral_code),'')='' then return v_result; end if;
  select * into v_order from public.orders where id=(v_result->>'order_id')::uuid for update;
  select b.price into v_base_price from public.bundles b where b.id=p_bundle_id;
  select a.user_id into v_agent from public.agent_accounts a
    where a.referral_code=upper(trim(p_agent_referral_code)) and a.is_active;
  if v_agent is null then raise exception 'Agent referral link is invalid'; end if;
  select p.customer_price into v_price from public.agent_customer_bundle_prices p
    where p.agent_id=v_agent and p.bundle_id=p_bundle_id;
  v_price:=coalesce(v_price,v_base_price);
  v_delta:=v_order.price-v_price;
  if v_delta<>0 then
    update public.wallets set balance=balance+v_delta,updated_at=now()
      where user_id=p_user_id returning balance into v_balance;
    if v_balance<0 then raise exception 'Insufficient wallet balance for this agent price'; end if;
  else
    select balance into v_balance from public.wallets where user_id=p_user_id;
  end if;
  update public.orders set price=v_price where id=v_order.id;
  update public.ledger set amount=-v_price
    where reference_id=v_order.id and reference_type='order' and kind='purchase';
  update public.audit_log set details=coalesce(details,'{}'::jsonb)||jsonb_build_object(
    'agent_id',v_agent,'customer_price',v_price,'base_price',v_base_price,
    'agent_profit',greatest(v_price-v_base_price,0))
    where entity='order' and entity_id=v_order.id::text and action='wallet_bundle_purchase_created';
  return v_result||jsonb_build_object('price',v_price,'wallet_balance',v_balance);
end $$;

create or replace function public.audit_agent_cashout_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then
    insert into public.audit_log(actor_id,action,entity,entity_id,details)
    values((select auth.uid()),'delete','agent_cashout_request',old.id::text,
      jsonb_build_object('agent_id',old.agent_id,'amount',old.amount,'status',old.status,'payout_reference',old.payout_reference));
    return old;
  end if;
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
  values((select auth.uid()),lower(tg_op),'agent_cashout_request',new.id::text,
    jsonb_build_object('agent_id',new.agent_id,'amount',new.amount,'status',new.status,'payout_reference',new.payout_reference));
  return new;
end $$;
drop trigger if exists audit_agent_cashout_changes on public.agent_cashout_requests;
create trigger audit_agent_cashout_changes after insert or update or delete on public.agent_cashout_requests
  for each row execute function public.audit_agent_cashout_change();

revoke all on function public.get_my_agent_earnings() from public,anon;
revoke all on function public.get_my_agent_cashout_summary() from public,anon;
revoke all on function public.agent_save_cashout_profile(text,text) from public,anon;
revoke all on function public.agent_request_cashout(numeric) from public,anon;
revoke all on function public.admin_update_agent_cashout(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.create_live_checkout_order(uuid,text,text,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.create_wallet_bundle_order(uuid,text,text,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.get_my_agent_earnings() to authenticated;
grant execute on function public.get_my_agent_cashout_summary() to authenticated;
grant execute on function public.agent_save_cashout_profile(text,text) to authenticated;
grant execute on function public.agent_request_cashout(numeric) to authenticated;
grant execute on function public.admin_update_agent_cashout(uuid,text,text,text) to authenticated;
grant execute on function public.create_live_checkout_order(uuid,text,text,uuid,text,text,text) to service_role;
grant execute on function public.create_wallet_bundle_order(uuid,text,text,uuid,text,text,text) to service_role;
