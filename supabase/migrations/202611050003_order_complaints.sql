-- Customer reports for orders that the provider marked as delivered.
create table if not exists public.order_complaints (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  message text not null check (char_length(trim(message)) between 10 and 2000),
  status text not null default 'open' check (status in ('open','in_progress','resolved','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id,user_id)
);

create index if not exists order_complaints_created_idx on public.order_complaints(created_at desc);
alter table public.order_complaints enable row level security;
revoke all on public.order_complaints from anon,authenticated;

create policy "Buyers read their order complaints" on public.order_complaints for select to authenticated
  using (user_id=(select auth.uid()) or exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin'));
create policy "Buyers complain about their delivered orders" on public.order_complaints for insert to authenticated
  with check (
    user_id=(select auth.uid())
    and exists(
      select 1 from public.orders o
      where o.id=order_id and o.user_id=(select auth.uid())
        and o.is_demo=false and o.status='successful' and o.delivery_status='delivered'
    )
  );
create policy "Admins update order complaint status" on public.order_complaints for update to authenticated
  using (exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin'))
  with check (exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin'));
grant select,insert on public.order_complaints to authenticated;
grant update on public.order_complaints to authenticated;
