create or replace function public.admin_get_agent_customer_prices(p_agent_id uuid)
returns table(bundle_id text, customer_price numeric)
language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.profiles where id=auth.uid() and role='admin') then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  if not exists(select 1 from public.agent_accounts where user_id=p_agent_id and is_active) then
    raise exception 'Choose an active agent account' using errcode='22023';
  end if;
  return query
    select price.bundle_id,price.customer_price
    from public.agent_customer_bundle_prices price
    where price.agent_id=p_agent_id;
end $$;

create or replace function public.admin_save_agent_customer_prices(p_agent_id uuid,p_prices jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare item jsonb; v_bundle text; v_price numeric; v_count integer:=0;
begin
  if not exists(select 1 from public.profiles where id=auth.uid() and role='admin') then
    raise exception 'Administrator access required' using errcode='42501';
  end if;
  if not exists(select 1 from public.agent_accounts where user_id=p_agent_id and is_active) then
    raise exception 'Choose an active agent account' using errcode='22023';
  end if;
  if jsonb_typeof(p_prices)<>'array' or jsonb_array_length(p_prices)>500 then
    raise exception 'Invalid price list';
  end if;
  for item in select value from jsonb_array_elements(p_prices) loop
    v_bundle:=item->>'bundle_id';
    if coalesce(item->>'price','')='' then
      delete from public.agent_customer_bundle_prices where agent_id=p_agent_id and bundle_id=v_bundle;
    else
      begin v_price:=(item->>'price')::numeric; exception when others then raise exception 'Price must be a number'; end;
      if v_price<0 or v_price>100000 then raise exception 'Price is outside the allowed range'; end if;
      if not exists(select 1 from public.bundles where id=v_bundle) then raise exception 'Unknown bundle'; end if;
      insert into public.agent_customer_bundle_prices(agent_id,bundle_id,customer_price)
        values(p_agent_id,v_bundle,v_price)
        on conflict(agent_id,bundle_id) do update set customer_price=excluded.customer_price,updated_at=now();
    end if;
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;

revoke all on function public.admin_get_agent_customer_prices(uuid) from public,anon;
revoke all on function public.admin_save_agent_customer_prices(uuid,jsonb) from public,anon;
grant execute on function public.admin_get_agent_customer_prices(uuid) to authenticated;
grant execute on function public.admin_save_agent_customer_prices(uuid,jsonb) to authenticated;
