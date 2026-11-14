-- Permanently purge an agent's personal account records before the Auth user
-- is deleted through the Supabase Admin API. Run through a service-role Edge
-- Function that has already authenticated an administrator.
create or replace function public.admin_purge_agent_account(p_user_id uuid, p_admin_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text;
begin
  if p_user_id is null or p_admin_id is null or p_user_id = p_admin_id then
    raise exception 'Invalid account removal request' using errcode='22023';
  end if;
  if not exists(select 1 from public.profiles where id=p_admin_id and role='admin') then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  if not exists(select 1 from public.profiles where id=p_user_id and role='customer') then
    raise exception 'Customer account not found';
  end if;

  select coalesce(nullif(p.phone,''),nullif(a.phone,''),'') into v_phone
    from public.profiles p left join public.agent_accounts a on a.user_id=p.id where p.id=p_user_id;

  -- Erase the account's own purchases, deposits, wallet ledger, checker
  -- purchases, complaints, reports, and cashout requests.
  delete from public.order_complaints where user_id=p_user_id;
  delete from public.orders where user_id=p_user_id;
  update public.orders set referred_by_agent_id=null where referred_by_agent_id=p_user_id;
  delete from public.result_checker_orders where user_id=p_user_id;
  update public.result_checker_orders set referred_by_agent_id=null where referred_by_agent_id=p_user_id;
  delete from public.deposits where user_id=p_user_id;
  delete from public.ledger where user_id=p_user_id;
  delete from public.afa_requests where user_id=p_user_id;
  delete from public.storefront_customer_reports where agent_id=p_user_id;
  update public.storefront_customer_reports set forwarded_by=null where forwarded_by=p_user_id;
  delete from public.bulk_sms_campaigns where created_by=p_user_id;

  -- Remove required ownership references held by the account being deleted.
  update public.agent_accounts set assigned_by=p_admin_id where assigned_by=p_user_id and user_id<>p_user_id;
  update public.super_agent_bundle_prices set updated_by=p_admin_id where updated_by=p_user_id and super_agent_id<>p_user_id;
  update public.super_agent_afa_plan_prices set updated_by=p_admin_id where updated_by=p_user_id and super_agent_id<>p_user_id;
  update public.super_agent_result_checker_prices set updated_by=p_admin_id where updated_by=p_user_id and super_agent_id<>p_user_id;

  -- Clear nullable creator/reviewer references in shared records so deleting
  -- the Auth identity cannot leave any foreign-key link to it.
  update public.afa_requests set handled_by=null where handled_by=p_user_id;
  update public.agent_cashout_requests set processed_by=null where processed_by=p_user_id;
  update public.platform_settings set updated_by=null where updated_by=p_user_id;
  update public.public_updates set created_by=null where created_by=p_user_id;
  update public.public_help_items set created_by=null where created_by=p_user_id;
  update public.sms_provider_settings set updated_by=null where updated_by=p_user_id;
  update public.main_storefront_bundle_prices set updated_by=null where updated_by=p_user_id;
  update public.airtime_price_settings set updated_by=null where updated_by=p_user_id;
  update public.storefront_customer_reports set forwarded_by=null where forwarded_by=p_user_id;

  if v_phone <> '' then
    delete from public.sms_phone_signup_challenges where phone=case
      when left(regexp_replace(v_phone,'[^0-9]','','g'),3)='233'
        then '0'||substring(regexp_replace(v_phone,'[^0-9]','','g') from 4)
      else regexp_replace(v_phone,'[^0-9]','','g') end;
    delete from public.public_order_tracking_limits where rate_key='phone:'||encode(sha256(convert_to(
      case when left(regexp_replace(v_phone,'[^0-9]','','g'),3)='233'
        then '0'||substring(regexp_replace(v_phone,'[^0-9]','','g') from 4)
      else regexp_replace(v_phone,'[^0-9]','','g') end,'UTF8')),'hex');
  end if;

  -- Agent-owned rows cascade from agent_accounts. Remove the remaining Auth
  -- actor rows, including the deletion audit event emitted by table triggers.
  delete from public.agent_accounts where user_id=p_user_id;
  delete from public.audit_log
    where actor_id=p_user_id
       or entity_id=p_user_id::text
       or details->>'agent_id'=p_user_id::text;

  return jsonb_build_object('success',true,'user_id',p_user_id);
end;
$$;

revoke all on function public.admin_purge_agent_account(uuid,uuid) from public, anon, authenticated;
grant execute on function public.admin_purge_agent_account(uuid,uuid) to service_role;
