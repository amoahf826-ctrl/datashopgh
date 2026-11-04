-- When an account returns to its dashboard, reject any live Paystack checkout
-- that was created but never confirmed as paid. Paid checkouts remain eligible
-- for delivery and are protected by the payment_status predicate.
create or replace function public.reject_my_unpaid_checkouts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rejected integer;
begin
  if auth.uid() is null then
    raise exception 'Sign in is required' using errcode='42501';
  end if;

  with rejected as (
    update public.orders
    set payment_status='failed',
        delivery_status='failed',
        status='failed',
        delivery_updated_at=now()
    where user_id=auth.uid()
      and is_demo=false
      and payment_reference is not null
      and payment_status='unpaid'
      and status='pending'
    returning id, payment_reference, price
  )
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
  select auth.uid(),'unpaid_checkout_rejected','order',id::text,
         jsonb_build_object('payment_reference',payment_reference,'amount',price)
  from rejected;

  get diagnostics v_rejected = row_count;
  return v_rejected;
end;
$$;

revoke all on function public.reject_my_unpaid_checkouts() from public, anon;
grant execute on function public.reject_my_unpaid_checkouts() to authenticated;
