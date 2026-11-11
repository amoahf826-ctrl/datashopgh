alter table public.agent_cashout_requests
  add column if not exists paystack_recipient_code text,
  add column if not exists paystack_transfer_code text,
  add column if not exists paystack_transfer_reference text,
  add column if not exists paystack_transfer_status text,
  add column if not exists paystack_error text;

create unique index if not exists agent_cashout_paystack_reference_unique
  on public.agent_cashout_requests(paystack_transfer_reference)
  where paystack_transfer_reference is not null;

create or replace function public.admin_prepare_agent_cashout_transfer(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_request public.agent_cashout_requests%rowtype; v_name text;
begin
  if not public.is_admin() then raise exception 'Administrator access required' using errcode='42501'; end if;
  select * into v_request from public.agent_cashout_requests where id=p_request_id for update;
  if not found then raise exception 'Cashout request not found'; end if;
  if v_request.status not in ('pending','processing') then raise exception 'This cashout request is already resolved'; end if;
  if v_request.paystack_transfer_status in ('queued','otp','success') then
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
    'amount',v_request.amount,'momo_network',v_request.momo_network,'momo_phone',v_request.momo_phone,
    'reference',v_request.paystack_transfer_reference,'recipient_code',v_request.paystack_recipient_code,
    'transfer_code',v_request.paystack_transfer_code);
end;
$$;

-- Admins can review, move to processing, or reject. Only a verified Paystack
-- transfer response/webhook is allowed to mark a request paid.
create or replace function public.admin_update_agent_cashout(p_request_id uuid,p_status text,p_reference text default null,p_note text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_request public.agent_cashout_requests%rowtype; v_next text:=lower(trim(coalesce(p_status,'')));
begin
  if not public.is_admin() then raise exception 'Administrator access required' using errcode='42501'; end if;
  if v_next not in ('processing','rejected') then raise exception 'Cashouts must be paid through Paystack'; end if;
  select * into v_request from public.agent_cashout_requests where id=p_request_id for update;
  if not found then raise exception 'Cashout request not found'; end if;
  if v_request.status not in ('pending','processing') then raise exception 'This cashout request has already been resolved'; end if;
  if v_next='processing' and v_request.status='processing' then raise exception 'This cashout is already being processed'; end if;
  if v_next='rejected' and coalesce(trim(p_note),'')='' then raise exception 'Enter a reason for rejecting this cashout'; end if;
  if v_next='rejected' and v_request.paystack_transfer_status in ('initiating','otp','queued') then
    raise exception 'A Paystack payout is already active; wait for its final status before rejecting';
  end if;
  update public.agent_cashout_requests set status=v_next,
    admin_note=case when v_next='rejected' then trim(p_note) else admin_note end,
    updated_at=now(),processed_by=case when v_next='rejected' then (select auth.uid()) else processed_by end,
    processed_at=case when v_next='rejected' then now() else processed_at end
    where id=p_request_id;
  return true;
end $$;

revoke all on function public.admin_prepare_agent_cashout_transfer(uuid) from public,anon,authenticated;
grant execute on function public.admin_prepare_agent_cashout_transfer(uuid) to authenticated;
revoke all on function public.admin_update_agent_cashout(uuid,text,text,text) from public,anon;
grant execute on function public.admin_update_agent_cashout(uuid,text,text,text) to authenticated;
