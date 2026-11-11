-- Allow the authenticated agent to prepare only their own cashout for Paystack.
-- Admins can still initiate/reconcile requests from the cashout console.
alter table public.agent_cashout_requests
  add column if not exists admin_fee_amount numeric(12,2) not null default 0,
  add column if not exists payout_amount numeric(12,2) not null default 0;

-- Existing requests predate the withdrawal fee; preserve their original gross payout.
update public.agent_cashout_requests set payout_amount=amount where payout_amount=0 and amount>0;

alter table public.platform_settings drop constraint if exists platform_settings_key_check;
alter table public.platform_settings add constraint platform_settings_key_check
  check (key in ('storefront_maintenance','agent_dashboard_maintenance','storefront_live_sales','wallet_deposits_enabled','active_bundle_provider','storefront_contact','paystack_fee_recovery','agent_cashout_policy'));
insert into public.platform_settings(key,value)
values ('agent_cashout_policy','{"minimum_gross":10.31,"deduction_percent":3}'::jsonb)
on conflict(key) do nothing;

create or replace function public.get_agent_cashout_policy()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_policy jsonb;
  v_minimum numeric(12,2);
  v_rate numeric(5,2);
  v_minimum_payable numeric(12,2);
begin
  if (select auth.uid()) is null then raise exception 'Sign in required' using errcode='42501'; end if;
  select value into v_policy from public.platform_settings where key='agent_cashout_policy';
  v_minimum:=coalesce(nullif(v_policy->>'minimum_gross','')::numeric,10.31);
  v_rate:=coalesce(nullif(v_policy->>'deduction_percent','')::numeric,3);
  if v_minimum<0.01 or v_rate<0 or v_rate>50 then raise exception 'Agent cashout policy is invalid'; end if;
  v_minimum_payable:=greatest(v_minimum,ceil((10/(1-v_rate/100))*100)/100);
  return jsonb_build_object('minimum_gross',v_minimum,'deduction_percent',v_rate,'minimum_payable_gross',v_minimum_payable);
end;
$$;

create or replace function public.agent_request_cashout(p_amount numeric)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_agent public.agent_accounts%rowtype;
  v_available numeric(12,2);
  v_earned numeric(12,2);
  v_reserved numeric(12,2);
  v_paid numeric(12,2);
  v_fee numeric(12,2);
  v_payout numeric(12,2);
  v_policy jsonb;
  v_minimum numeric(12,2);
  v_rate numeric(5,2);
  v_minimum_payable numeric(12,2);
  v_request uuid;
begin
  select * into v_agent from public.agent_accounts
    where user_id=(select auth.uid()) and is_active for update;
  if not found then raise exception 'Active agent account required' using errcode='42501'; end if;
  if v_agent.cashout_momo_network is null or v_agent.cashout_momo_phone is null then
    raise exception 'Save your MoMo payout details first';
  end if;
  select value into v_policy from public.platform_settings where key='agent_cashout_policy';
  v_minimum:=coalesce(nullif(v_policy->>'minimum_gross','')::numeric,10.31);
  v_rate:=coalesce(nullif(v_policy->>'deduction_percent','')::numeric,3);
  if v_minimum<0.01 or v_rate<0 or v_rate>50 then raise exception 'Agent cashout policy is invalid'; end if;
  v_minimum_payable:=greatest(v_minimum,ceil((10/(1-v_rate/100))*100)/100);
  if p_amount is null or p_amount<v_minimum_payable or p_amount<>round(p_amount,2) then
    raise exception 'Minimum withdrawal is GHS % under the current cashout settings',to_char(v_minimum_payable,'FM999999990.00');
  end if;
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
  if p_amount>v_available then
    raise exception 'Cashout exceeds available profit of GHS %',to_char(v_available,'FM999999990.00');
  end if;
  v_fee:=round(p_amount*(v_rate/100),2);
  v_payout:=p_amount-v_fee;
  insert into public.agent_cashout_requests(agent_id,amount,admin_fee_amount,payout_amount,momo_network,momo_phone)
    values(v_agent.user_id,p_amount,v_fee,v_payout,v_agent.cashout_momo_network,v_agent.cashout_momo_phone)
    returning id into v_request;
  return v_request;
end;
$$;

revoke all on function public.get_agent_cashout_policy() from public,anon;
grant execute on function public.get_agent_cashout_policy() to authenticated;

create or replace function public.admin_prepare_agent_cashout_transfer(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_request public.agent_cashout_requests%rowtype;
  v_name text;
begin
  select * into v_request
    from public.agent_cashout_requests
    where id=p_request_id
    for update;
  if not found then raise exception 'Cashout request not found'; end if;
  if not public.is_admin() and v_request.agent_id is distinct from (select auth.uid()) then
    raise exception 'You can only pay out your own agent profit' using errcode='42501';
  end if;
  if v_request.status not in ('pending','processing') then
    raise exception 'This cashout request is already resolved';
  end if;
  if v_request.paystack_transfer_status in ('initiating','queued','otp','success') then
    raise exception 'A Paystack transfer is already active for this request';
  end if;

  select coalesce(nullif(trim(p.full_name),''),nullif(trim(p.email),''),'CheapDataBundle Agent')
    into v_name from public.profiles p where p.id=v_request.agent_id;
  update public.agent_cashout_requests set
    status='processing',
    paystack_transfer_reference=coalesce(paystack_transfer_reference,'agent-cashout-'||replace(p_request_id::text,'-','')),
    paystack_transfer_status='initiating',paystack_error=null,updated_at=now()
    where id=p_request_id returning * into v_request;
  return jsonb_build_object(
    'id',v_request.id,'agent_id',v_request.agent_id,'name',coalesce(v_name,'CheapDataBundle Agent'),
    'amount',v_request.amount,'admin_fee_amount',v_request.admin_fee_amount,'payout_amount',v_request.payout_amount,
    'momo_network',v_request.momo_network,'momo_phone',v_request.momo_phone,
    'reference',v_request.paystack_transfer_reference,'recipient_code',v_request.paystack_recipient_code,
    'transfer_code',v_request.paystack_transfer_code);
end;
$$;

revoke all on function public.admin_prepare_agent_cashout_transfer(uuid) from public,anon;
grant execute on function public.admin_prepare_agent_cashout_transfer(uuid) to authenticated;
revoke all on function public.agent_request_cashout(numeric) from public,anon;
grant execute on function public.agent_request_cashout(numeric) to authenticated;
