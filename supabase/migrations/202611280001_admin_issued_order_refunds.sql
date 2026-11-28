create table if not exists public.order_refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete restrict,
  method text not null check (method in ('wallet', 'paystack')),
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  amount numeric(12,2) not null check (amount > 0),
  provider_reference text,
  issued_by uuid not null references auth.users(id),
  provider_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.order_refunds enable row level security;
revoke all on public.order_refunds from public, anon, authenticated;
grant all on public.order_refunds to service_role;

comment on table public.order_refunds is 'Auditable refunds explicitly initiated by an administrator for a paid order.';
