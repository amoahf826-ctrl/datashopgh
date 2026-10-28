-- Enable customer wallet deposits through a verified, idempotent Paystack flow.
alter table public.deposits
  add column if not exists idempotency_key uuid,
  add column if not exists checkout_url text;

create unique index if not exists deposits_user_idempotency_key_unique
  on public.deposits(user_id,idempotency_key) where idempotency_key is not null;

alter table public.platform_settings drop constraint if exists platform_settings_key_check;
alter table public.platform_settings add constraint platform_settings_key_check
  check (key in ('storefront_maintenance','agent_dashboard_maintenance','storefront_live_sales','wallet_deposits_enabled'));

insert into public.platform_settings(key,value)
values ('wallet_deposits_enabled','{"enabled":true}'::jsonb)
on conflict(key) do update set value=excluded.value;

drop policy if exists "Public read storefront state" on public.platform_settings;
create policy "Public read storefront state" on public.platform_settings for select
  using (key in ('storefront_maintenance','storefront_live_sales','wallet_deposits_enabled'));

create or replace function public.create_paystack_wallet_deposit(
  p_user_id uuid,p_amount numeric,p_idempotency_key uuid,p_reference text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_deposit public.deposits%rowtype;
begin
  if p_user_id is null or p_idempotency_key is null then raise exception 'Account and request key are required'; end if;
  if p_amount is null or p_amount<1 or p_amount>10000 or p_amount<>round(p_amount,2) then
    raise exception 'Deposit amount must be between GHS 1.00 and GHS 10,000.00';
  end if;
  select * into v_deposit from public.deposits
    where user_id=p_user_id and idempotency_key=p_idempotency_key for update;
  if found then
    return jsonb_build_object('id',v_deposit.id,'amount',v_deposit.amount,
      'reference',v_deposit.provider_reference,'checkout_url',v_deposit.checkout_url,'status',v_deposit.status);
  end if;
  if p_reference !~ '^DSGW-[A-Fa-f0-9]{32}$' then raise exception 'Invalid payment reference'; end if;
  insert into public.deposits(user_id,amount,provider,provider_reference,status,idempotency_key)
    values(p_user_id,p_amount,'paystack',p_reference,'pending',p_idempotency_key)
    returning * into v_deposit;
  return jsonb_build_object('id',v_deposit.id,'amount',v_deposit.amount,
    'reference',v_deposit.provider_reference,'checkout_url',v_deposit.checkout_url,'status',v_deposit.status);
end;
$$;
revoke all on function public.create_paystack_wallet_deposit(uuid,numeric,uuid,text) from public,anon,authenticated;
grant execute on function public.create_paystack_wallet_deposit(uuid,numeric,uuid,text) to service_role;

create or replace function public.save_wallet_deposit_checkout_url(p_deposit_id uuid,p_url text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_url is null or p_url !~ '^https://checkout\.paystack\.com/' then raise exception 'Invalid checkout URL'; end if;
  update public.deposits set checkout_url=p_url
    where id=p_deposit_id and status='pending' and (checkout_url is null or checkout_url=p_url);
  if not found then raise exception 'Pending wallet deposit not found'; end if;
end;
$$;
revoke all on function public.save_wallet_deposit_checkout_url(uuid,text) from public,anon,authenticated;
grant execute on function public.save_wallet_deposit_checkout_url(uuid,text) to service_role;

create or replace function public.claim_paystack_wallet_deposit(p_reference text,p_amount integer,p_currency text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_deposit public.deposits%rowtype; v_balance numeric(12,2);
begin
  select * into v_deposit from public.deposits where provider='paystack' and provider_reference=p_reference for update;
  if not found then raise exception 'Wallet deposit reference not found'; end if;
  if upper(coalesce(p_currency,''))<>'GHS' or p_amount<>round(v_deposit.amount*100)::integer then
    raise exception 'Verified payment amount or currency does not match the wallet deposit';
  end if;
  if v_deposit.status='successful' then
    select balance into v_balance from public.wallets where user_id=v_deposit.user_id;
    return jsonb_build_object('credited',false,'balance',v_balance,'deposit_id',v_deposit.id);
  end if;
  if v_deposit.status<>'pending' then raise exception 'Wallet deposit is not pending'; end if;
  update public.deposits set status='successful',verified_at=now() where id=v_deposit.id;
  update public.wallets set balance=balance+v_deposit.amount,updated_at=now()
    where user_id=v_deposit.user_id returning balance into v_balance;
  if not found then raise exception 'Customer wallet was not found'; end if;
  insert into public.ledger(user_id,kind,amount,reference_type,reference_id,idempotency_key)
    values(v_deposit.user_id,'deposit',v_deposit.amount,'deposit',v_deposit.id,'paystack-wallet:'||v_deposit.id::text)
    on conflict(idempotency_key) do nothing;
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
    values(null,'paystack_wallet_deposit_verified','deposit',v_deposit.id::text,
      jsonb_build_object('reference',p_reference,'amount',v_deposit.amount,'currency','GHS'));
  return jsonb_build_object('credited',true,'balance',v_balance,'deposit_id',v_deposit.id);
end;
$$;
revoke all on function public.claim_paystack_wallet_deposit(text,integer,text) from public,anon,authenticated;
grant execute on function public.claim_paystack_wallet_deposit(text,integer,text) to service_role;
