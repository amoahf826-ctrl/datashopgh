alter table public.orders
  add column if not exists last_provider_status_checked_at timestamptz;

create index if not exists orders_pending_provider_status_poll_idx
  on public.orders (delivery_provider, last_provider_status_checked_at asc nulls first, created_at asc)
  where is_demo = false
    and payment_status = 'successful'
    and delivery_status in ('queued', 'processing', 'unknown');
