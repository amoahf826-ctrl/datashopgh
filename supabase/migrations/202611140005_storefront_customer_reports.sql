-- Public storefront reports are routed to the linked agent, or Admin for the main store.
create table if not exists public.storefront_customer_reports (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agent_accounts(user_id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  reporter_name text not null check (char_length(trim(reporter_name)) between 2 and 100),
  reporter_phone text not null check (reporter_phone ~ '^0[0-9]{9}$'),
  subject text not null check (char_length(trim(subject)) between 3 and 120),
  message text not null check (char_length(trim(message)) between 10 and 2000),
  status text not null default 'open' check (status in ('open','in_progress','resolved','closed')),
  forwarded_at timestamptz,
  forwarded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists storefront_reports_agent_created_idx
  on public.storefront_customer_reports(agent_id,created_at desc);
create index if not exists storefront_reports_created_idx
  on public.storefront_customer_reports(created_at desc);
alter table public.storefront_customer_reports enable row level security;
revoke all on public.storefront_customer_reports from public,anon,authenticated;
create policy "Agents read their storefront customer reports" on public.storefront_customer_reports
  for select to authenticated using (agent_id=(select auth.uid()));
create policy "Agents update their storefront customer report status" on public.storefront_customer_reports
  for update to authenticated using (agent_id=(select auth.uid()))
  with check (agent_id=(select auth.uid()));
create policy "Admins manage storefront customer reports" on public.storefront_customer_reports
  for all to authenticated using (exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin'))
  with check (exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin'));
grant select on public.storefront_customer_reports to authenticated;
grant update(status) on public.storefront_customer_reports to authenticated;

create or replace function public.consume_storefront_report_rate_limit(p_rate_key text)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if p_rate_key is null or p_rate_key !~ '^storefront-report:[0-9a-f]{64}$' then
    raise exception 'Invalid storefront report rate limit key';
  end if;
  delete from public.public_checkout_rate_limits where window_started_at<now()-interval '1 day';
  insert into public.public_checkout_rate_limits as existing(rate_key,window_started_at,request_count)
    values(p_rate_key,now(),1)
    on conflict(rate_key) do update set
      window_started_at=case when existing.window_started_at<=now()-interval '30 minutes' then now() else existing.window_started_at end,
      request_count=case when existing.window_started_at<=now()-interval '30 minutes' then 1 else existing.request_count+1 end
    returning request_count into v_count;
  return v_count<=5;
end;
$$;
revoke all on function public.consume_storefront_report_rate_limit(text) from public,anon,authenticated;
grant execute on function public.consume_storefront_report_rate_limit(text) to service_role;

create or replace function public.agent_forward_storefront_report(p_report_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_agent uuid:=auth.uid();
begin
  if not exists(select 1 from public.agent_accounts a where a.user_id=v_agent and a.is_active) then
    raise exception 'Active agent account required' using errcode='42501';
  end if;
  update public.storefront_customer_reports set forwarded_at=coalesce(forwarded_at,now()),
    forwarded_by=v_agent,updated_at=now()
    where id=p_report_id and agent_id=v_agent;
  return found;
end;
$$;
revoke all on function public.agent_forward_storefront_report(uuid) from public,anon;
grant execute on function public.agent_forward_storefront_report(uuid) to authenticated;
