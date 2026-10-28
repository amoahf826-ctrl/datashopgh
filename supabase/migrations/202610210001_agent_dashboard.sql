-- Agent self-service, customer resale prices, and one-time API credentials.
alter table public.agent_accounts add column if not exists api_access_enabled boolean not null default true;
update public.agent_accounts set api_access_enabled=true where is_active;
update public.agent_accounts set referral_code=upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)) where is_active and coalesce(trim(referral_code),'')='';
create unique index if not exists agent_accounts_referral_code_unique on public.agent_accounts(referral_code) where referral_code<>'';

drop policy if exists "Agents read own account" on public.agent_accounts;
create policy "Agents read own account" on public.agent_accounts for select to authenticated
  using (user_id=(select auth.uid()));

create table if not exists public.agent_customer_bundle_prices (
  agent_id uuid not null references public.agent_accounts(user_id) on delete cascade,
  bundle_id text not null references public.bundles(id) on delete cascade,
  customer_price numeric(10,2) not null check(customer_price>=0),
  updated_at timestamptz not null default now(),
  primary key(agent_id,bundle_id)
);
alter table public.agent_customer_bundle_prices enable row level security;
revoke all on public.agent_customer_bundle_prices from anon,authenticated;

create table if not exists public.agent_api_keys (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agent_accounts(user_id) on delete cascade,
  key_hash text not null unique,
  key_prefix text not null,
  label text not null default 'Default API key',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
alter table public.agent_api_keys enable row level security;
revoke all on public.agent_api_keys from anon,authenticated;

create or replace function public.agent_save_customer_prices(p_prices jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare item jsonb; v_bundle text; v_price numeric; v_count integer:=0;
begin
  if not exists(select 1 from public.agent_accounts where user_id=auth.uid() and is_active) then
    raise exception 'Active agent account required' using errcode='42501';
  end if;
  if jsonb_typeof(p_prices)<>'array' or jsonb_array_length(p_prices)>500 then raise exception 'Invalid price list'; end if;
  for item in select value from jsonb_array_elements(p_prices) loop
    v_bundle:=item->>'bundle_id';
    if coalesce(item->>'price','')='' then
      delete from public.agent_customer_bundle_prices where agent_id=auth.uid() and bundle_id=v_bundle;
    else
      begin v_price:=(item->>'price')::numeric; exception when others then raise exception 'Price must be a number'; end;
      if v_price<0 or v_price>100000 then raise exception 'Price is outside the allowed range'; end if;
      if not exists(select 1 from public.bundles where id=v_bundle) then raise exception 'Unknown bundle'; end if;
      insert into public.agent_customer_bundle_prices(agent_id,bundle_id,customer_price) values(auth.uid(),v_bundle,v_price)
        on conflict(agent_id,bundle_id) do update set customer_price=excluded.customer_price,updated_at=now();
    end if;
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;

create or replace function public.get_agent_customer_prices(p_referral_code text)
returns table(bundle_id text,customer_price numeric) language sql stable security definer set search_path='' as $$
  select price.bundle_id,price.customer_price
  from public.agent_customer_bundle_prices price
  join public.agent_accounts account on account.user_id=price.agent_id
  where account.is_active and account.referral_code=p_referral_code;
$$;

create or replace function public.agent_create_api_key(p_label text default 'Default API key')
returns table(api_key text,key_prefix text) language plpgsql security definer set search_path='' as $$
declare v_key text; v_prefix text;
begin
  if not exists(select 1 from public.agent_accounts where user_id=auth.uid() and is_active and api_access_enabled) then
    raise exception 'Active agent API access required' using errcode='42501';
  end if;
  v_key:='dsg_agent_'||replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  v_prefix:=left(v_key,19);
  insert into public.agent_api_keys(agent_id,key_hash,key_prefix,label)
    values(auth.uid(),encode(sha256(convert_to(v_key,'UTF8')),'hex'),v_prefix,left(coalesce(nullif(trim(p_label),''),'Default API key'),80));
  return query select v_key,v_prefix;
end $$;

create or replace function public.agent_list_api_keys()
returns table(id uuid,key_prefix text,label text,created_at timestamptz)
language sql stable security definer set search_path='' as $$
  select key.id,key.key_prefix,key.label,key.created_at from public.agent_api_keys key
  join public.agent_accounts account on account.user_id=key.agent_id
  where key.agent_id=auth.uid() and key.revoked_at is null and account.is_active and account.api_access_enabled
  order by key.created_at desc;
$$;

create or replace function public.agent_revoke_api_key(p_key_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  update public.agent_api_keys set revoked_at=now() where id=p_key_id and agent_id=auth.uid() and revoked_at is null;
  return found;
end $$;

revoke all on function public.agent_save_customer_prices(jsonb) from public,anon;
revoke all on function public.get_agent_customer_prices(text) from public;
revoke all on function public.agent_create_api_key(text) from public,anon;
revoke all on function public.agent_list_api_keys() from public,anon;
revoke all on function public.agent_revoke_api_key(uuid) from public,anon;
grant execute on function public.agent_save_customer_prices(jsonb) to authenticated;
grant execute on function public.get_agent_customer_prices(text) to anon,authenticated;
grant execute on function public.agent_create_api_key(text) to authenticated;
grant execute on function public.agent_list_api_keys() to authenticated;
grant execute on function public.agent_revoke_api_key(uuid) to authenticated;

-- Referral checkout adapters reuse the existing transactional order routines and
-- apply the agent price only while the order remains unpaid/unprocessed.
create or replace function public.create_live_checkout_order(
  p_user_id uuid,p_bundle_id text,p_recipient_phone text,p_idempotency_key uuid,
  p_payment_reference text,p_delivery_reference text,p_agent_referral_code text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_agent uuid; v_price numeric(10,2); v_bundle_price numeric(10,2); v_order public.orders%rowtype;
begin
  v_result:=public.create_live_checkout_order(p_user_id,p_bundle_id,p_recipient_phone,p_idempotency_key,p_payment_reference,p_delivery_reference);
  select * into v_order from public.orders where id=(v_result->>'id')::uuid for update;
  if v_order.checkout_url is not null or v_order.payment_status<>'unpaid' or coalesce(trim(p_agent_referral_code),'')='' then return v_result; end if;
  select b.price into v_bundle_price from public.bundles b where b.id=p_bundle_id;
  select a.user_id into v_agent from public.agent_accounts a where a.referral_code=p_agent_referral_code and a.is_active;
  if v_agent is null then raise exception 'Agent referral link is invalid'; end if;
  select p.customer_price into v_price from public.agent_customer_bundle_prices p where p.agent_id=v_agent and p.bundle_id=p_bundle_id;
  v_price:=coalesce(v_price,v_bundle_price);
  update public.orders set price=v_price where id=v_order.id;
  update public.audit_log set details=coalesce(details,'{}'::jsonb)||jsonb_build_object('agent_id',v_agent,'customer_price',v_price)
    where entity='order' and entity_id=v_order.id::text and action='live_checkout_created';
  return v_result||jsonb_build_object('price',v_price);
end $$;

create or replace function public.create_wallet_bundle_order(
  p_user_id uuid,p_bundle_id text,p_recipient_phone text,p_idempotency_key uuid,
  p_payment_reference text,p_delivery_reference text,p_agent_referral_code text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_order public.orders%rowtype; v_agent uuid; v_price numeric(10,2); v_balance numeric(12,2); v_delta numeric(10,2);
begin
  v_result:=public.create_wallet_bundle_order(p_user_id,p_bundle_id,p_recipient_phone,p_idempotency_key,p_payment_reference,p_delivery_reference);
  if coalesce((v_result->>'created')::boolean,false) is not true or coalesce(trim(p_agent_referral_code),'')='' then return v_result; end if;
  select * into v_order from public.orders where id=(v_result->>'order_id')::uuid for update;
  select a.user_id into v_agent from public.agent_accounts a where a.referral_code=p_agent_referral_code and a.is_active;
  if v_agent is null then raise exception 'Agent referral link is invalid'; end if;
  select p.customer_price into v_price from public.agent_customer_bundle_prices p where p.agent_id=v_agent and p.bundle_id=p_bundle_id;
  if v_price is null then return v_result; end if;
  v_delta:=v_order.price-v_price;
  update public.wallets set balance=balance+v_delta,updated_at=now() where user_id=p_user_id returning balance into v_balance;
  if v_balance<0 then raise exception 'Insufficient wallet balance for this agent price'; end if;
  update public.orders set price=v_price where id=v_order.id;
  update public.ledger set amount=-v_price where reference_id=v_order.id and reference_type='order' and kind='purchase';
  return v_result||jsonb_build_object('price',v_price,'wallet_balance',v_balance);
end $$;

revoke all on function public.create_live_checkout_order(uuid,text,text,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.create_live_checkout_order(uuid,text,text,uuid,text,text,text) to service_role;
revoke all on function public.create_wallet_bundle_order(uuid,text,text,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.create_wallet_bundle_order(uuid,text,text,uuid,text,text,text) to service_role;

create or replace function public.enable_agent_api_access()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.is_active then new.api_access_enabled:=true; end if;
  if new.is_active and coalesce(trim(new.referral_code),'')='' then new.referral_code:=upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)); end if;
  return new;
end $$;
drop trigger if exists enable_agent_api_access_on_active on public.agent_accounts;
create trigger enable_agent_api_access_on_active before insert or update of is_active,api_access_enabled on public.agent_accounts
for each row execute function public.enable_agent_api_access();
