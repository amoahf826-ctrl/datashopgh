create or replace function public.admin_claim_provider_retry(p_order_id uuid,p_provider text,p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order public.orders%rowtype; v_bundle public.bundles%rowtype; v_retry_reference text;
begin
  if p_provider not in ('datahub','hubnet') then raise exception 'Invalid provider'; end if;
  if not exists(select 1 from public.profiles where id=p_actor and role='admin') then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.is_demo or v_order.payment_status<>'successful' or v_order.delivery_status<>'failed' then
    raise exception 'Only paid orders with a confirmed failed delivery can be retried';
  end if;
  if v_order.delivery_provider is null or v_order.delivery_provider=p_provider then
    raise exception 'Choose the other configured delivery provider';
  end if;
  if exists(select 1 from public.ledger where reference_type='order' and reference_id=v_order.id and kind='refund') then
    raise exception 'This order has been refunded and cannot be resubmitted';
  end if;
  select * into v_bundle from public.bundles where id=v_order.bundle_id;
  if not found then raise exception 'Order plan no longer exists'; end if;
  v_retry_reference := 'DS' || left(replace(gen_random_uuid()::text,'-',''),23);
  update public.orders set delivery_provider=p_provider,delivery_reference=v_retry_reference,delivery_status='processing',status='processing',delivery_updated_at=now()
    where id=v_order.id;
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
    values(p_actor,'admin_provider_retry_started','order',v_order.id::text,
      jsonb_build_object('previous_provider',v_order.delivery_provider,'provider',p_provider,'previous_reference',v_order.delivery_reference,'delivery_reference',v_retry_reference));
  return jsonb_build_object('order_id',v_order.id,'reference',v_retry_reference,'phone',v_order.recipient_phone,
    'network',v_bundle.network,'size',v_bundle.size,'category',coalesce(v_bundle.category,''),'subcategory',coalesce(v_bundle.subcategory,''));
end;
$$;
revoke all on function public.admin_claim_provider_retry(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.admin_claim_provider_retry(uuid,text,uuid) to service_role;
