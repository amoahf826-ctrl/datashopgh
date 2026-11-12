-- Independent customer storefront prices for each agent's BECE/WASSCE sales.
alter table public.result_checker_orders
  add column if not exists agent_cost numeric(12,2) not null default 0 check(agent_cost >= 0),
  add column if not exists agent_profit_amount numeric(12,2) not null default 0 check(agent_profit_amount >= 0);

create table if not exists public.agent_result_checker_prices (
  agent_id uuid not null references auth.users(id) on delete cascade,
  voucher_type text not null check(voucher_type in ('BECE','WASSCE')),
  customer_price numeric(12,2) not null check(customer_price > 0),
  updated_at timestamptz not null default now(),
  primary key(agent_id,voucher_type)
);
alter table public.agent_result_checker_prices enable row level security;
revoke all on public.agent_result_checker_prices from public,anon,authenticated;

comment on table public.agent_result_checker_prices is
  'Per-agent customer storefront prices for result checker vouchers. Read/write through the authenticated result-checker-api Edge Function.';
