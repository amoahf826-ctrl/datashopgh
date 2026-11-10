-- Permit signed-out order tracking by phone while limiting enumeration.
create table if not exists public.public_order_tracking_limits (
  rate_key text primary key,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0 check (request_count >= 0)
);
alter table public.public_order_tracking_limits enable row level security;
revoke all on public.public_order_tracking_limits from public,anon,authenticated;

create or replace function public.public_track_orders_by_phone(p_phone text,p_client_ip text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_ip_key text;
  v_phone_key text;
  v_key text;
  v_count integer;
  v_orders jsonb;
begin
  if coalesce(p_phone,'') !~ '^0[0-9]{9}$' or coalesce(length(trim(p_client_ip)),0)<3
    or length(trim(p_client_ip))>64 then
    raise exception 'Valid phone and client network address are required';
  end if;
  v_ip_key:='ip:'||encode(sha256(convert_to(trim(p_client_ip),'UTF8')),'hex');
  v_phone_key:='phone:'||encode(sha256(convert_to(p_phone,'UTF8')),'hex');
  delete from public.public_order_tracking_limits where window_started_at<now()-interval '1 day';
  foreach v_key in array array[v_ip_key,v_phone_key] loop
    insert into public.public_order_tracking_limits as existing(rate_key,window_started_at,request_count)
      values(v_key,now(),1)
      on conflict(rate_key) do update set
        window_started_at=case when existing.window_started_at<=now()-interval '10 minutes' then now() else existing.window_started_at end,
        request_count=case when existing.window_started_at<=now()-interval '10 minutes' then 1 else existing.request_count+1 end
      returning request_count into v_count;
    if (v_key=v_ip_key and v_count>20) or (v_key=v_phone_key and v_count>5) then
      return jsonb_build_object('rate_limited',true);
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',recent.id,'status',recent.status,'payment_status',recent.payment_status,
    'delivery_status',recent.delivery_status,'price',recent.price,'created_at',recent.created_at,
    'bundles',case when recent.bundle_id is null then null else jsonb_build_object('size',recent.size,'network',recent.network) end
  ) order by recent.created_at desc),'[]'::jsonb)
  into v_orders
  from (
    select o.id,o.status,o.payment_status,o.delivery_status,o.price,o.created_at,
      b.id as bundle_id,b.size,b.network
    from public.orders o
    left join public.bundles b on b.id=o.bundle_id
    where o.recipient_phone=p_phone and o.is_demo=false
      and (o.payment_reference is null or o.payment_reference not like 'WALLET-%')
      and o.created_at>=now()-interval '90 days'
    order by o.created_at desc limit 10
  ) recent;
  return jsonb_build_object('orders',v_orders);
end $$;
revoke all on function public.public_track_orders_by_phone(text,text) from public,anon,authenticated;
grant execute on function public.public_track_orders_by_phone(text,text) to service_role;
