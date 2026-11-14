-- Let administrators review and set customer-facing AFA prices per active agent.
create or replace function public.admin_get_agent_afa_prices(p_agent_id uuid)
returns table(plan_id uuid, customer_price numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if not exists(select 1 from public.agent_accounts where user_id=p_agent_id and is_active) then
    raise exception 'Choose an active agent account';
  end if;
  return query
    select price.plan_id,price.customer_price
    from public.agent_afa_plan_prices price
    where price.agent_id=p_agent_id
    order by price.plan_id;
end;
$$;

create or replace function public.admin_save_agent_afa_prices(p_agent_id uuid,p_prices jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  item jsonb;
  v_plan_id uuid;
  v_raw_price text;
  v_price numeric(10,2);
  v_main_price numeric(10,2);
  v_count integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if not exists(select 1 from public.agent_accounts where user_id=p_agent_id and is_active) then
    raise exception 'Choose an active agent account';
  end if;
  if jsonb_typeof(p_prices) <> 'array' or jsonb_array_length(p_prices) > 100 then
    raise exception 'Submit a valid list of agent AFA prices';
  end if;
  for item in select value from jsonb_array_elements(p_prices) loop
    begin
      v_plan_id := (item->>'plan_id')::uuid;
    exception when others then
      raise exception 'An AFA plan ID is invalid';
    end;
    select plan.price into v_main_price from public.afa_plans plan
      where plan.id=v_plan_id and plan.is_active;
    if not found then raise exception 'An AFA plan is inactive or no longer exists'; end if;

    v_raw_price := nullif(trim(item->>'price'),'');
    if v_raw_price is null then
      delete from public.agent_afa_plan_prices where agent_id=p_agent_id and plan_id=v_plan_id;
    else
      begin
        v_price := v_raw_price::numeric(10,2);
      exception when others then
        raise exception 'Enter a valid price for every AFA plan';
      end;
      if v_price < v_main_price or v_price > 100000 then
        raise exception 'Agent AFA prices must be at least the main storefront price and no more than GHS 100000';
      end if;
      insert into public.agent_afa_plan_prices(agent_id,plan_id,customer_price,updated_at)
      values(p_agent_id,v_plan_id,v_price,now())
      on conflict(agent_id,plan_id) do update
        set customer_price=excluded.customer_price,updated_at=now();
    end if;
    v_count := v_count + 1;
  end loop;
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
  values(auth.uid(),'admin_update_agent_afa_prices','agent_afa_plan_prices',p_agent_id::text,
    jsonb_build_object('updated_count',v_count));
  return v_count;
end;
$$;

revoke all on function public.admin_get_agent_afa_prices(uuid) from public,anon;
revoke all on function public.admin_save_agent_afa_prices(uuid,jsonb) from public,anon;
grant execute on function public.admin_get_agent_afa_prices(uuid) to authenticated;
grant execute on function public.admin_save_agent_afa_prices(uuid,jsonb) to authenticated;
