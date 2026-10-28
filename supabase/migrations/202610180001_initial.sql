-- DataShopGH initial schema. Run with the Supabase SQL editor or CLI.
create extension if not exists pgcrypto;

create table public.networks (
  id text primary key check (id in ('MTN','Telecel','AT')),
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.bundles (
  id text primary key,
  network text not null references public.networks(id),
  size text not null,
  price numeric(10,2) not null check (price >= 0),
  validity text not null default '30 days',
  is_active boolean not null default true,
  is_demo boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'customer' check (role in ('customer','admin')),
  created_at timestamptz not null default now()
);
create table public.wallets (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  balance numeric(12,2) not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  bundle_id text not null references public.bundles(id),
  recipient_phone text not null check (recipient_phone ~ '^0[0-9]{9}$'),
  price numeric(10,2) not null check (price >= 0),
  status text not null default 'pending' check (status in ('pending','successful','failed')),
  is_demo boolean not null default true,
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  unique(user_id,idempotency_key)
);
create table public.deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  amount numeric(12,2) not null check (amount > 0),
  provider text not null default 'unconfigured',
  provider_reference text unique,
  status text not null default 'pending' check (status in ('pending','successful','failed')),
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  kind text not null check (kind in ('deposit','purchase','refund','adjustment')),
  amount numeric(12,2) not null,
  reference_type text not null,
  reference_id uuid not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);
create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id = (select auth.uid()) and role = 'admin');
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id,email) values(new.id,new.email);
  insert into public.wallets(user_id) values(new.id);
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Customers cannot change their own role, and the browser cannot write financial tables.
create or replace function public.protect_profile_role()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.role is distinct from old.role and not public.is_admin() then
    raise exception 'Only an administrator can change roles';
  end if;
  return new;
end;
$$;
create trigger protect_profile_role before update on public.profiles
for each row execute procedure public.protect_profile_role();

alter table public.networks enable row level security;
alter table public.bundles enable row level security;
alter table public.profiles enable row level security;
alter table public.wallets enable row level security;
alter table public.orders enable row level security;
alter table public.deposits enable row level security;
alter table public.ledger enable row level security;
alter table public.audit_log enable row level security;

grant select on public.networks, public.bundles to anon, authenticated;
grant select, insert, update, delete on public.profiles, public.wallets, public.orders, public.deposits, public.ledger, public.audit_log to authenticated;

create policy "Anyone can read active networks" on public.networks for select using (is_active or public.is_admin());
create policy "Anyone can read active bundles" on public.bundles for select using ((is_active and exists(select 1 from public.networks n where n.id=network and n.is_active)) or public.is_admin());
create policy "Read own profile" on public.profiles for select using (id=(select auth.uid()) or public.is_admin());
create policy "Update own profile fields" on public.profiles for update using (id=(select auth.uid()) or public.is_admin()) with check (id=(select auth.uid()) or public.is_admin());
create policy "Read own wallet" on public.wallets for select using (user_id=(select auth.uid()) or public.is_admin());
create policy "Read own orders" on public.orders for select using (user_id=(select auth.uid()) or public.is_admin());
create policy "Read own deposits" on public.deposits for select using (user_id=(select auth.uid()) or public.is_admin());
create policy "Read own ledger" on public.ledger for select using (user_id=(select auth.uid()) or public.is_admin());
create policy "Admin read audit log" on public.audit_log for select using (public.is_admin());
create policy "Admin manage networks" on public.networks for all using (public.is_admin()) with check (public.is_admin());
create policy "Admin manage bundles" on public.bundles for all using (public.is_admin()) with check (public.is_admin());
create policy "Admin manage profiles" on public.profiles for all using (public.is_admin()) with check (public.is_admin());
create policy "Admin manage wallets" on public.wallets for all using (public.is_admin()) with check (public.is_admin());
create policy "Admin manage orders" on public.orders for all using (public.is_admin()) with check (public.is_admin());
create policy "Admin manage deposits" on public.deposits for all using (public.is_admin()) with check (public.is_admin());
create policy "Admin manage ledger" on public.ledger for all using (public.is_admin()) with check (public.is_admin());

-- Keep catalogue, role, and payment-ledger changes visible to administrators.
create or replace function public.audit_row_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_row jsonb; v_id text; v_user uuid := auth.uid();
begin
  if tg_op='DELETE' then v_row:=to_jsonb(old); v_id:=coalesce(v_row->>'id',v_row->>'user_id');
  else v_row:=to_jsonb(new); v_id:=coalesce(v_row->>'id',v_row->>'user_id'); end if;
  insert into public.audit_log(actor_id,action,entity,entity_id,details)
    values(v_user,lower(tg_op),tg_table_name,v_id,jsonb_build_object('row',v_row));
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
create trigger audit_network_changes after insert or update or delete on public.networks for each row execute procedure public.audit_row_change();
create trigger audit_bundle_changes after insert or update or delete on public.bundles for each row execute procedure public.audit_row_change();
create trigger audit_deposit_changes after insert or update or delete on public.deposits for each row execute procedure public.audit_row_change();
create trigger audit_ledger_changes after insert or update or delete on public.ledger for each row execute procedure public.audit_row_change();

-- The RPC gets the authoritative bundle price from Postgres. It creates a demo order only;
-- it does not debit a wallet or deliver data. Client-supplied price/status are not accepted.
create or replace function public.create_demo_order(p_bundle_id text, p_recipient_phone text, p_idempotency_key uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_order uuid := gen_random_uuid(); v_price numeric(10,2); v_inserted integer;
begin
  if v_user is null then raise exception 'Please sign in to place an order'; end if;
  if p_idempotency_key is null then raise exception 'Order key is required'; end if;
  if p_recipient_phone !~ '^0[0-9]{9}$' then raise exception 'Enter a valid 10 digit Ghanaian phone number'; end if;
  select b.price into v_price from public.bundles b join public.networks n on n.id=b.network
    where b.id=p_bundle_id and b.is_active and n.is_active;
  if v_price is null then raise exception 'This bundle is unavailable'; end if;
  insert into public.orders(id,user_id,bundle_id,recipient_phone,price,status,is_demo,idempotency_key)
    values(v_order,v_user,p_bundle_id,p_recipient_phone,v_price,'pending',true,p_idempotency_key)
    on conflict(user_id,idempotency_key) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted=0 then
    select id into v_order from public.orders where user_id=v_user and idempotency_key=p_idempotency_key;
  else
    insert into public.audit_log(actor_id,action,entity,entity_id,details)
      values(v_user,'demo_order_created','order',v_order::text,jsonb_build_object('bundle_id',p_bundle_id,'demo',true));
  end if;
  return v_order;
end;
$$;
revoke all on function public.create_demo_order(text,text,uuid) from public;
grant execute on function public.create_demo_order(text,text,uuid) to authenticated;

insert into public.networks(id,name) values ('MTN','MTN Ghana'),('Telecel','Telecel Ghana'),('AT','AT Ghana') on conflict do nothing;
insert into public.bundles(id,network,size,price,validity,is_demo) values
  ('mtn1','MTN','1 GB',5,'30 days',true),('mtn5','MTN','5 GB',22,'30 days',true),('mtn10','MTN','10 GB',40,'30 days',true),('mtn20','MTN','20 GB',75,'30 days',true),
  ('tel2','Telecel','2 GB',10,'30 days',true),('tel5','Telecel','5 GB',24,'30 days',true),('tel10','Telecel','10 GB',44,'30 days',true),
  ('at3','AT','3 GB',12,'30 days',true),('at6','AT','6 GB',23,'30 days',true),('at10','AT','10 GB',36,'30 days',true)
on conflict(id) do nothing;

-- Admin bootstrap: after registering the first account, use this transaction once
-- in the trusted Supabase SQL editor, replacing the email with that exact account.
-- The role-protection trigger must be disabled temporarily because SQL Editor runs
-- outside an authenticated user session. Re-enable it before commit.
-- begin;
-- alter table public.profiles disable trigger protect_profile_role;
-- update public.profiles set role='admin' where email='you@example.com';
-- alter table public.profiles enable trigger protect_profile_role;
-- commit;
