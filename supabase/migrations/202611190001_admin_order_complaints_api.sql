-- Admin-only API for listing customer order complaints and updating their status.
-- These security-definer RPCs provide the admin panel with joined complaint,
-- customer, order, and bundle details without exposing those records to buyers.

create or replace function public.admin_list_order_complaints()
returns table (
  id uuid,
  order_id uuid,
  user_id uuid,
  message text,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  customer_email text,
  order_details jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  return query
  select
    c.id,
    c.order_id,
    c.user_id,
    c.message,
    c.status,
    c.created_at,
    c.updated_at,
    p.email,
    case when o.id is null then null else
      to_jsonb(o) || jsonb_build_object(
        'bundles', case when b.id is null then null else jsonb_build_object('size', b.size, 'network', b.network) end
      )
    end
  from public.order_complaints c
  left join public.profiles p on p.id = c.user_id
  left join public.orders o on o.id = c.order_id
  left join public.bundles b on b.id = o.bundle_id
  order by c.created_at desc
  limit 500;
end;
$$;

create or replace function public.admin_update_order_complaint(p_complaint_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;
  if p_status not in ('open', 'in_progress', 'resolved', 'closed') then
    raise exception 'Invalid complaint status';
  end if;

  update public.order_complaints
  set status = p_status, updated_at = now()
  where id = p_complaint_id;

  if not found then
    raise exception 'Order complaint not found';
  end if;
end;
$$;

revoke all on function public.admin_list_order_complaints() from public, anon;
revoke all on function public.admin_update_order_complaint(uuid, text) from public, anon;
grant execute on function public.admin_list_order_complaints() to authenticated;
grant execute on function public.admin_update_order_complaint(uuid, text) to authenticated;
