alter table public.agent_accounts
  add column if not exists deleted_at timestamptz;

create or replace function public.admin_list_agent_profit_summaries()
returns table(agent_id uuid, earned numeric, reserved numeric, paid numeric, available numeric)
language sql stable security definer set search_path = '' as $$
  select a.user_id,
    coalesce(e.earned,0),
    coalesce(c.reserved,0),
    coalesce(c.paid,0),
    greatest(0,coalesce(e.earned,0)-coalesce(c.reserved,0)-coalesce(c.paid,0))
  from public.agent_accounts a
  left join (
    select log.details->>'agent_id' as agent_id,
      coalesce(sum(greatest(o.price-coalesce(nullif(log.details->>'base_price','')::numeric,b.price),0)),0) as earned
    from public.audit_log log
    join public.orders o on o.id::text=log.entity_id
    join public.bundles b on b.id=o.bundle_id
    where log.entity='order'
      and log.action in ('live_checkout_created','wallet_bundle_purchase_created')
      and log.details->>'agent_id' is not null
      and o.is_demo=false and o.payment_status='successful'
      and o.delivery_status='delivered' and o.status='successful'
      and not exists(select 1 from public.ledger l where l.reference_type='order' and l.reference_id=o.id and l.kind='refund')
    group by log.details->>'agent_id'
  ) e on e.agent_id=a.user_id::text
  left join (
    select r.agent_id,
      coalesce(sum(r.amount) filter(where r.status in ('pending','processing')),0) as reserved,
      coalesce(sum(r.amount) filter(where r.status='paid'),0) as paid
    from public.agent_cashout_requests r group by r.agent_id
  ) c on c.agent_id=a.user_id
  where public.is_admin()
  order by a.created_at desc;
$$;

create or replace function public.admin_remove_agent_account(p_user_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  if not exists(
    select 1 from public.agent_accounts a
    join public.profiles p on p.id=a.user_id
    where a.user_id=p_user_id and a.deleted_at is null and p.role='customer'
  ) then
    raise exception 'Active customer agent account not found';
  end if;
  update public.agent_accounts
    set is_active=false, deleted_at=coalesce(deleted_at,now()), updated_at=now()
    where user_id=p_user_id and deleted_at is null;
  if not found then raise exception 'Active agent account not found'; end if;
  return true;
end;
$$;

revoke all on function public.admin_list_agent_profit_summaries() from public, anon;
revoke all on function public.admin_remove_agent_account(uuid) from public, anon;
grant execute on function public.admin_list_agent_profit_summaries() to authenticated;
grant execute on function public.admin_remove_agent_account(uuid) to authenticated;
