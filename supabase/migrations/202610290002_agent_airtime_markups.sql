create table if not exists public.agent_customer_airtime_markups (
  agent_id uuid not null references public.agent_accounts(user_id) on delete cascade,
  network text not null check(network in ('MTN','AT','Telecel')),
  markup_percent numeric(6,2) not null check(markup_percent between 0 and 100),
  updated_at timestamptz not null default now(),
  primary key(agent_id,network)
);
alter table public.agent_customer_airtime_markups enable row level security;
revoke all on public.agent_customer_airtime_markups from anon,authenticated;

create or replace function public.agent_save_customer_airtime_markups(p_markups jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare item jsonb; v_network text; v_markup numeric; v_count integer:=0;
begin
  if not exists(select 1 from public.agent_accounts where user_id=(select auth.uid()) and is_active) then
    raise exception 'Active agent account required' using errcode='42501';
  end if;
  if jsonb_typeof(p_markups)<>'array' or jsonb_array_length(p_markups)>3 then raise exception 'Invalid airtime markup list'; end if;
  for item in select value from jsonb_array_elements(p_markups) loop
    v_network:=item->>'network';
    if v_network not in ('MTN','AT','Telecel') then raise exception 'Unknown airtime network'; end if;
    if coalesce(item->>'markup_percent','')='' then
      delete from public.agent_customer_airtime_markups where agent_id=(select auth.uid()) and network=v_network;
    else
      begin v_markup:=(item->>'markup_percent')::numeric; exception when others then raise exception 'Markup must be a number'; end;
      if v_markup<0 or v_markup>100 then raise exception 'Markup must be between 0 and 100 percent'; end if;
      insert into public.agent_customer_airtime_markups(agent_id,network,markup_percent)
        values((select auth.uid()),v_network,v_markup)
        on conflict(agent_id,network) do update set markup_percent=excluded.markup_percent,updated_at=now();
    end if;
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;

create or replace function public.get_agent_customer_airtime_markups(p_referral_code text)
returns table(network text,markup_percent numeric) language sql stable security definer set search_path='' as $$
  select markup.network,markup.markup_percent
  from public.agent_customer_airtime_markups markup
  join public.agent_accounts account on account.user_id=markup.agent_id
  where account.is_active and upper(account.referral_code)=upper(trim(p_referral_code));
$$;

create or replace function public.get_my_agent_customer_airtime_markups()
returns table(network text,markup_percent numeric) language sql stable security definer set search_path='' as $$
  select markup.network,markup.markup_percent
  from public.agent_customer_airtime_markups markup
  join public.agent_accounts account on account.user_id=markup.agent_id
  where account.is_active and markup.agent_id=(select auth.uid());
$$;

revoke all on function public.agent_save_customer_airtime_markups(jsonb) from public,anon;
revoke all on function public.get_agent_customer_airtime_markups(text) from public;
revoke all on function public.get_my_agent_customer_airtime_markups() from public,anon;
grant execute on function public.agent_save_customer_airtime_markups(jsonb) to authenticated;
grant execute on function public.get_agent_customer_airtime_markups(text) to anon,authenticated;
grant execute on function public.get_my_agent_customer_airtime_markups() to authenticated;
