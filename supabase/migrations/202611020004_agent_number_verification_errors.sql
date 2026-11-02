alter table public.agent_number_submissions
  add column if not exists hubnet_error text;
