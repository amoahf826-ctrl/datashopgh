-- Authoritative, admin-only dashboard aggregates. Demo orders are counted separately.
create or replace function public.admin_dashboard_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'customers', (select count(*) from public.profiles p where p.role = 'customer'),
    'orders', (select count(*) from public.orders o),
    'successful', (select count(*) from public.orders o where o.is_demo = false and o.status = 'successful'),
    'pending', (select count(*) from public.orders o where o.is_demo = false and o.status = 'pending'),
    'failed', (select count(*) from public.orders o where o.is_demo = false and o.status = 'failed'),
    'demo', (select count(*) from public.orders o where o.is_demo = true),
    'wallets', (select coalesce(sum(w.balance), 0) from public.wallets w),
    'deposits', (select coalesce(sum(l.amount), 0) from public.ledger l where l.kind = 'deposit' and l.amount > 0),
    'purchases', (select coalesce(sum(abs(l.amount)), 0) from public.ledger l where l.kind = 'purchase'),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object('day', to_char(days.day, 'Mon DD'), 'amount', coalesce(daily.amount, 0)) order by days.day), '[]'::jsonb)
      from generate_series(current_date - 6, current_date, interval '1 day') as days(day)
      left join (
        select l.created_at::date as day, sum(l.amount) as amount
        from public.ledger l where l.kind = 'deposit' and l.amount > 0 and l.created_at >= current_date - 6
        group by l.created_at::date
      ) daily on daily.day = days.day::date
    ),
    'recent_orders', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', o.id, 'recipient_phone', o.recipient_phone, 'bundle_id', o.bundle_id,
        'size', b.size, 'network', b.network, 'price', o.price, 'status', o.status,
        'is_demo', o.is_demo, 'created_at', o.created_at
      ) order by o.created_at desc), '[]'::jsonb)
      from (select * from public.orders order by created_at desc limit 8) o
      join public.bundles b on b.id = o.bundle_id
    ),
    'recent_customers', (
      select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email, 'created_at', p.created_at) order by p.created_at desc), '[]'::jsonb)
      from (select * from public.profiles where role = 'customer' order by created_at desc limit 5) p
    )
  ) into result;
  return result;
end;
$$;

revoke all on function public.admin_dashboard_summary() from public, anon;
grant execute on function public.admin_dashboard_summary() to authenticated;
