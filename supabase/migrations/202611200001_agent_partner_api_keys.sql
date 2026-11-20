-- Per-agent credentials for using CheapDataBundle as a data supplier.
create table if not exists public.agent_partner_api_keys (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agent_accounts(user_id) on delete cascade,
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  key_prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists agent_partner_api_keys_agent_active_idx
  on public.agent_partner_api_keys(agent_id, created_at desc) where revoked_at is null;
alter table public.agent_partner_api_keys enable row level security;
revoke all on public.agent_partner_api_keys from public, anon, authenticated;
grant all on public.agent_partner_api_keys to service_role;
