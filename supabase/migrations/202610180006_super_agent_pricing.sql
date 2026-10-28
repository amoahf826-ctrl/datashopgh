create table public.agent_accounts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  agent_type text not null default 'super_agent' check (agent_type in ('agent','super_agent')),
  is_active boolean not null default true,
  assigned_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.super_agent_bundle_prices (
  id uuid primary key default gen_random_uuid(),
  super_agent_id uuid not null references public.agent_accounts(user_id) on delete cascade,
  bundle_id text not null references public.bundles(id) on delete cascade,
  override_price numeric(10,2) not null check (override_price >= 0),
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  unique(super_agent_id,bundle_id)
);

alter table public.agent_accounts enable row level security;
alter table public.super_agent_bundle_prices enable row level security;
grant select,insert,update,delete on public.agent_accounts,public.super_agent_bundle_prices to authenticated;
create policy "Admins manage agent accounts" on public.agent_accounts for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "Admins manage super agent bundle prices" on public.super_agent_bundle_prices for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create trigger audit_agent_account_changes after insert or update or delete on public.agent_accounts
  for each row execute procedure public.audit_row_change();
create trigger audit_super_agent_price_changes after insert or update or delete on public.super_agent_bundle_prices
  for each row execute procedure public.audit_row_change();

create or replace function public.admin_save_super_agent_prices(p_super_agent_id uuid,p_overrides jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare item jsonb; v_bundle text; v_price numeric; v_count integer := 0;
begin
  if not public.is_admin() then raise exception 'Administrator access required' using errcode='42501'; end if;
  if not exists(select 1 from public.agent_accounts where user_id=p_super_agent_id and agent_type='super_agent' and is_active) then
    raise exception 'Active super agent account not found';
  end if;
  if jsonb_typeof(p_overrides) <> 'array' or jsonb_array_length(p_overrides)>500 then raise exception 'Invalid override list'; end if;
  for item in select value from jsonb_array_elements(p_overrides) loop
    v_bundle := item->>'bundle_id';
    if coalesce(item->>'price','')='' then
      delete from public.super_agent_bundle_prices where super_agent_id=p_super_agent_id and bundle_id=v_bundle;
    else
      begin v_price := (item->>'price')::numeric;
      exception when others then raise exception 'Bundle price must be a number'; end;
      if v_price < 0 or v_price > 100000 then raise exception 'Bundle price is outside the allowed range'; end if;
      if not exists(select 1 from public.bundles where id=v_bundle) then raise exception 'Unknown bundle in override list'; end if;
      insert into public.super_agent_bundle_prices(super_agent_id,bundle_id,override_price,updated_by)
      values(p_super_agent_id,v_bundle,v_price,auth.uid())
      on conflict(super_agent_id,bundle_id) do update set override_price=excluded.override_price,updated_by=excluded.updated_by,updated_at=now();
    end if;
    v_count := v_count + 1;
  end loop;
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
    values(auth.uid(),'save_price_overrides','super_agent_bundle_prices',p_super_agent_id::text,jsonb_build_object('items',v_count));
  return v_count;
end;
$$;
revoke all on function public.admin_save_super_agent_prices(uuid,jsonb) from public,anon;
grant execute on function public.admin_save_super_agent_prices(uuid,jsonb) to authenticated;
