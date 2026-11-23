create or replace function public.admin_claim_unknown_datahub_wallet_retry(
  p_order_id uuid,
  p_actor uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_bundle public.bundles%rowtype;
  v_reference text;
begin
  if not exists (select 1 from public.profiles where id = p_actor and role = 'admin') then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found
    or v_order.is_demo
    or v_order.payment_status <> 'successful'
    or v_order.delivery_status <> 'unknown'
    or v_order.delivery_provider <> 'datahub'
    or v_order.provider_transaction_id is not null
    or coalesce(v_order.payment_reference, '') not like 'WALLET-%'
  then
    raise exception 'Only paid, unknown, wallet-funded DataHub orders with no provider transaction ID can be retried';
  end if;

  if exists (
    select 1 from public.audit_log
    where entity = 'order' and entity_id = v_order.id::text
      and action = 'admin_unknown_datahub_wallet_retry_started'
  ) then
    raise exception 'This order already had its one manual retry. Reconcile its status with DataHub before another attempt';
  end if;

  if exists (
    select 1 from public.ledger
    where reference_type = 'order' and reference_id = v_order.id and kind = 'refund'
  ) then
    raise exception 'This order has been refunded and cannot be retried';
  end if;

  select * into v_bundle from public.bundles where id = v_order.bundle_id;
  if not found then raise exception 'The order plan no longer exists'; end if;

  v_reference := 'DS' || left(replace(gen_random_uuid()::text, '-', ''), 23);
  update public.orders
    set delivery_reference = v_reference, delivery_status = 'processing', status = 'processing',
        delivery_updated_at = now()
    where id = v_order.id;

  insert into public.audit_log(actor_id, action, entity, entity_id, details)
    values (p_actor, 'admin_unknown_datahub_wallet_retry_started', 'order', v_order.id::text,
      jsonb_build_object('previous_reference', v_order.delivery_reference,
        'delivery_reference', v_reference, 'recipient_phone', v_order.recipient_phone));

  return jsonb_build_object('order_id', v_order.id, 'reference', v_reference,
    'phone', v_order.recipient_phone, 'network', v_bundle.network,
    'size', v_bundle.size, 'category', coalesce(v_bundle.category, ''),
    'subcategory', coalesce(v_bundle.subcategory, ''),
    'delivery_network_type', v_bundle.delivery_network_type);
end;
$$;

revoke all on function public.admin_claim_unknown_datahub_wallet_retry(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_claim_unknown_datahub_wallet_retry(uuid, uuid) to service_role;
