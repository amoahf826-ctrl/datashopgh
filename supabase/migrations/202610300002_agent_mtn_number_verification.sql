alter table public.agent_number_submissions
  add column if not exists hubnet_status text
    check (hubnet_status is null or hubnet_status in ('verified','unverified','queued','invalid')),
  add column if not exists hubnet_request_id text,
  add column if not exists hubnet_checked_at timestamptz;

create index if not exists agent_number_submissions_hubnet_queue_idx
  on public.agent_number_submissions(agent_id, hubnet_status, hubnet_checked_at desc)
  where hubnet_status='queued';
