-- Persistent agent number approvals and support requests used by the Super Agent portal.
create table if not exists public.agent_number_submissions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agent_accounts(user_id) on delete cascade,
  phone_number text not null check (phone_number ~ '^0[0-9]{9}$'),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null
);
create unique index if not exists agent_number_submissions_pending_unique
  on public.agent_number_submissions(agent_id,phone_number) where status='pending';
alter table public.agent_number_submissions enable row level security;
revoke all on public.agent_number_submissions from anon,authenticated;
create policy "Agents read own submitted numbers" on public.agent_number_submissions for select to authenticated
  using (agent_id=(select auth.uid()) or exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin'));
grant select on public.agent_number_submissions to authenticated;
create policy "Admins review agent number submissions" on public.agent_number_submissions for update to authenticated
  using (exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin'))
  with check (exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin'));
grant update on public.agent_number_submissions to authenticated;

create or replace function public.agent_submit_numbers(p_phone_numbers text[])
returns integer language plpgsql security definer set search_path='' as $$
declare v_phone text; v_count integer:=0;
begin
  if not exists(select 1 from public.agent_accounts a where a.user_id=auth.uid() and a.is_active) then
    raise exception 'Active agent account required' using errcode='42501';
  end if;
  if p_phone_numbers is null or cardinality(p_phone_numbers)=0 or cardinality(p_phone_numbers)>500 then
    raise exception 'Submit between 1 and 500 phone numbers';
  end if;
  foreach v_phone in array p_phone_numbers loop
    if v_phone !~ '^0[0-9]{9}$' then raise exception 'Invalid Ghana phone number'; end if;
    insert into public.agent_number_submissions(agent_id,phone_number)
      values(auth.uid(),v_phone) on conflict(agent_id,phone_number) where status='pending' do nothing;
    if found then v_count:=v_count+1; end if;
  end loop;
  return v_count;
end $$;
revoke all on function public.agent_submit_numbers(text[]) from public,anon;
grant execute on function public.agent_submit_numbers(text[]) to authenticated;

create table if not exists public.agent_support_tickets (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agent_accounts(user_id) on delete cascade,
  subject text not null default 'Agent support request',
  message text not null check (char_length(message) between 1 and 4000),
  status text not null default 'open' check (status in ('open','in_progress','resolved','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_support_tickets_agent_created_idx on public.agent_support_tickets(agent_id,created_at desc);
alter table public.agent_support_tickets enable row level security;
revoke all on public.agent_support_tickets from anon,authenticated;
create policy "Agents read own support tickets" on public.agent_support_tickets for select to authenticated
  using (agent_id=(select auth.uid()) or exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin'));
create policy "Agents create own support tickets" on public.agent_support_tickets for insert to authenticated
  with check (agent_id=(select auth.uid()) and exists(select 1 from public.agent_accounts a where a.user_id=(select auth.uid()) and a.is_active));
grant select,insert on public.agent_support_tickets to authenticated;
create policy "Admins update agent support tickets" on public.agent_support_tickets for update to authenticated
  using (exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin'))
  with check (exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin'));
grant update on public.agent_support_tickets to authenticated;
