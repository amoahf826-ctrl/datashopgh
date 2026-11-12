-- Include completed result checker sales from agent storefronts in agent profit
-- history, available balances, automatic cashouts, and admin profit summaries.

create or replace function public.get_my_agent_earnings()
returns table(order_id uuid, bundle_size text, network text, sale_price numeric, base_price numeric, profit numeric, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
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
  union all
  select r.id, r.voucher_type||' Results Checker × '||r.quantity::text, 'DataHub',
    r.total_amount, r.total_amount-r.agent_profit_amount, r.agent_profit_amount, r.created_at
  from public.result_checker_orders r
  where r.referred_by_agent_id=(select auth.uid()) and r.payment_status='successful'
    and r.status='completed' and r.agent_profit_amount>0
  order by 7 desc;
$$;

create or replace function public.get_my_agent_cashout_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_agent public.agent_accounts%rowtype;
  v_earned numeric(12,2);
  v_reserved numeric(12,2);
  v_paid numeric(12,2);
begin
  select * into v_agent from public.agent_accounts where user_id=(select auth.uid()) and is_active;
  if not found then raise exception 'Active agent account required' using errcode='42501'; end if;
  select
    coalesce((select sum(greatest(o.price-coalesce(nullif(a.details->>'base_price','')::numeric,b.price),0))
      from public.audit_log a join public.orders o on o.id::text=a.entity_id join public.bundles b on b.id=o.bundle_id
      where a.entity='order' and a.action in ('live_checkout_created','wallet_bundle_purchase_created')
        and a.details->>'agent_id'=(select auth.uid())::text and o.is_demo=false
        and o.payment_status='successful' and o.delivery_status='delivered' and o.status='successful'
        and not exists(select 1 from public.ledger l where l.reference_type='order' and l.reference_id=o.id and l.kind='refund')),0)
    + coalesce((select sum(r.agent_profit_amount) from public.result_checker_orders r
      where r.referred_by_agent_id=(select auth.uid()) and r.payment_status='successful' and r.status='completed'),0)
    into v_earned;
  select coalesce(sum(amount) filter(where status in ('pending','processing')),0),
         coalesce(sum(amount) filter(where status='paid'),0)
    into v_reserved,v_paid from public.agent_cashout_requests where agent_id=(select auth.uid());
  return jsonb_build_object('earned',v_earned,'reserved',v_reserved,'paid',v_paid,
    'available',greatest(0,v_earned-v_reserved-v_paid),
    'momo_network',v_agent.cashout_momo_network,'momo_phone',v_agent.cashout_momo_phone);
end;
$$;

create or replace function public.agent_request_cashout(p_amount numeric)
returns uuid language plpgsql security definer set search_path = '' as $$
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
  select
    coalesce((select sum(greatest(o.price-coalesce(nullif(a.details->>'base_price','')::numeric,b.price),0))
      from public.audit_log a join public.orders o on o.id::text=a.entity_id join public.bundles b on b.id=o.bundle_id
      where a.entity='order' and a.action in ('live_checkout_created','wallet_bundle_purchase_created')
        and a.details->>'agent_id'=(select auth.uid())::text and o.is_demo=false
        and o.payment_status='successful' and o.delivery_status='delivered' and o.status='successful'
        and not exists(select 1 from public.ledger l where l.reference_type='order' and l.reference_id=o.id and l.kind='refund')),0)
    + coalesce((select sum(r.agent_profit_amount) from public.result_checker_orders r
      where r.referred_by_agent_id=(select auth.uid()) and r.payment_status='successful' and r.status='completed'),0)
    into v_earned;
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

create or replace function public.admin_list_agent_profit_summaries()
returns table(agent_id uuid, earned numeric, reserved numeric, paid numeric, available numeric)
language sql stable security definer set search_path = '' as $$
  with earned_by_agent as (
    select log.details->>'agent_id' as agent_id,
      sum(greatest(o.price-coalesce(nullif(log.details->>'base_price','')::numeric,b.price),0)) as earned
    from public.audit_log log join public.orders o on o.id::text=log.entity_id join public.bundles b on b.id=o.bundle_id
    where log.entity='order' and log.action in ('live_checkout_created','wallet_bundle_purchase_created')
      and log.details->>'agent_id' is not null and o.is_demo=false and o.payment_status='successful'
      and o.delivery_status='delivered' and o.status='successful'
      and not exists(select 1 from public.ledger l where l.reference_type='order' and l.reference_id=o.id and l.kind='refund')
    group by log.details->>'agent_id'
    union all
    select r.referred_by_agent_id::text, sum(r.agent_profit_amount)
    from public.result_checker_orders r
    where r.referred_by_agent_id is not null and r.payment_status='successful' and r.status='completed'
    group by r.referred_by_agent_id
  ),
  totals as (select agent_id,sum(earned) as earned from earned_by_agent group by agent_id),
  cashouts as (
    select r.agent_id,
      coalesce(sum(r.amount) filter(where r.status in ('pending','processing')),0) as reserved,
      coalesce(sum(r.amount) filter(where r.status='paid'),0) as paid
    from public.agent_cashout_requests r group by r.agent_id
  )
  select a.user_id,coalesce(e.earned,0),coalesce(c.reserved,0),coalesce(c.paid,0),
    greatest(0,coalesce(e.earned,0)-coalesce(c.reserved,0)-coalesce(c.paid,0))
  from public.agent_accounts a left join totals e on e.agent_id=a.user_id::text
  left join cashouts c on c.agent_id=a.user_id
  where public.is_admin() order by a.created_at desc;
$$;

revoke all on function public.get_my_agent_earnings() from public,anon;
revoke all on function public.get_my_agent_cashout_summary() from public,anon;
revoke all on function public.agent_request_cashout(numeric) from public,anon;
revoke all on function public.admin_list_agent_profit_summaries() from public,anon;
grant execute on function public.get_my_agent_earnings() to authenticated;
grant execute on function public.get_my_agent_cashout_summary() to authenticated;
grant execute on function public.agent_request_cashout(numeric) to authenticated;
grant execute on function public.admin_list_agent_profit_summaries() to authenticated;
