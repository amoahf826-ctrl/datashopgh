-- Money-changing admin operation: one transaction, role-gated, ledgered, audited, and idempotent.
-- Remove browser-side write access. Authorized changes below run transactionally inside the RPC.
drop policy if exists "Admin manage wallets" on public.wallets;
drop policy if exists "Admin manage ledger" on public.ledger;

create or replace function public.admin_adjust_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_reason text,
  p_request_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_before numeric(12,2);
  v_after numeric(12,2);
  v_ledger_id uuid := gen_random_uuid();
  v_key text := 'admin-adjustment:' || p_request_id::text;
  v_existing public.ledger%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  if p_user_id is null or p_request_id is null then raise exception 'Account and request ID are required'; end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 10000 then raise exception 'Adjustment must be non-zero and no more than GHS 10,000'; end if;
  if p_reason is null or length(trim(p_reason)) < 3 or length(trim(p_reason)) > 500 then raise exception 'Provide a reason between 3 and 500 characters'; end if;

  select * into v_existing from public.ledger where idempotency_key=v_key;
  if found then
    if v_existing.user_id <> p_user_id or v_existing.amount <> p_amount then raise exception 'Request ID was already used for a different adjustment'; end if;
    select balance into v_after from public.wallets where user_id=p_user_id;
    return jsonb_build_object('ledger_id',v_existing.id,'balance',v_after,'duplicate',true);
  end if;

  select balance into v_before from public.wallets where user_id=p_user_id for update;
  if not found then raise exception 'Customer wallet was not found'; end if;
  v_after := v_before + p_amount;
  if v_after < 0 then raise exception 'Adjustment would make the wallet balance negative'; end if;

  update public.wallets set balance=v_after,updated_at=now() where user_id=p_user_id;
  insert into public.ledger(id,user_id,kind,amount,reference_type,reference_id,idempotency_key)
    values(v_ledger_id,p_user_id,'adjustment',p_amount,'admin_adjustment',v_ledger_id,v_key);
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
    values(auth.uid(),'wallet_adjustment','wallets',p_user_id::text,jsonb_build_object(
      'ledger_id',v_ledger_id,'amount',p_amount,'reason',trim(p_reason),
      'balance_before',v_before,'balance_after',v_after,'request_id',p_request_id
    ));
  return jsonb_build_object('ledger_id',v_ledger_id,'balance',v_after,'duplicate',false);
end;
$$;
revoke all on function public.admin_adjust_wallet(uuid,numeric,text,uuid) from public,anon;
grant execute on function public.admin_adjust_wallet(uuid,numeric,text,uuid) to authenticated;
