-- Admin-managed MTN AFA plans and authenticated customer requests.
create table public.afa_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 100),
  details text not null default '' check (length(details) <= 1000),
  price numeric(10,2) not null check (price >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.afa_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  plan_id uuid not null references public.afa_plans(id) on delete restrict,
  customer_name text not null check (length(trim(customer_name)) between 2 and 100),
  phone text not null check (phone ~ '^0[0-9]{9}$'),
  note text not null default '' check (length(note) <= 500),
  status text not null default 'pending' check (status in ('pending','processing','completed','rejected')),
  handled_by uuid references auth.users(id),
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index afa_requests_created_at_idx on public.afa_requests(created_at desc);
create index afa_requests_user_id_idx on public.afa_requests(user_id,created_at desc);

alter table public.afa_plans enable row level security;
alter table public.afa_requests enable row level security;
grant select on public.afa_plans to anon,authenticated;
grant insert,update on public.afa_plans to authenticated;
grant insert,select,update on public.afa_requests to authenticated;

create policy "Read available AFA plans" on public.afa_plans for select
  using (is_active or public.is_admin());
create policy "Admins manage AFA plans" on public.afa_plans for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "Customers read their AFA requests" on public.afa_requests for select to authenticated
  using (user_id=(select auth.uid()) or public.is_admin());
create policy "Customers submit pending AFA requests" on public.afa_requests for insert to authenticated
  with check (
    user_id=(select auth.uid()) and status='pending' and handled_by is null and handled_at is null
    and exists(select 1 from public.afa_plans p where p.id=plan_id and p.is_active)
  );
create policy "Admins update AFA requests" on public.afa_requests for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create or replace function public.touch_afa_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at=now();
  if tg_table_name='afa_requests' then
    if new.status is distinct from old.status then
      if not public.is_admin() then raise exception 'Only an administrator can update AFA request status' using errcode='42501'; end if;
      new.handled_by=auth.uid();
      new.handled_at=now();
    end if;
  end if;
  return new;
end;
$$;
create trigger touch_afa_plans_updated_at before update on public.afa_plans
  for each row execute procedure public.touch_afa_updated_at();
create trigger touch_afa_requests_updated_at before update on public.afa_requests
  for each row execute procedure public.touch_afa_updated_at();

-- Record administrative catalog edits and request status changes without copying customer contact details.
create trigger audit_afa_plan_changes after insert or update on public.afa_plans
  for each row execute procedure public.audit_row_change();
create or replace function public.audit_afa_request_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    insert into public.audit_log(actor_id,action,entity,entity_id,details)
      values(auth.uid(),'status_update','afa_requests',new.id::text,jsonb_build_object('status',new.status));
  end if;
  return new;
end;
$$;
create trigger audit_afa_request_status_changes after update on public.afa_requests
  for each row execute procedure public.audit_afa_request_status();
