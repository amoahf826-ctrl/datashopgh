-- A signed-in agent or customer can submit MTN numbers and see only their own
-- latest eligibility results. Provider keys and writes stay server-side.
create table if not exists public.number_verification_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  phone_number text not null check(phone_number ~ '^0[0-9]{9}$'),
  verification_status text not null default 'unchecked'
    check(verification_status in ('unchecked','verified','unverified','queued','invalid')),
  hubnet_status text check(hubnet_status in ('verified','unverified','queued','invalid')),
  hubnet_error text,
  hubnet_checked_at timestamptz,
  datahub_status text check(datahub_status in ('submitted','invalid')),
  datahub_submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id,phone_number)
);

alter table public.number_verification_submissions enable row level security;
revoke all on public.number_verification_submissions from anon,authenticated;
drop policy if exists "Users read own number verification results" on public.number_verification_submissions;
create policy "Users read own number verification results" on public.number_verification_submissions
  for select to authenticated
  using(user_id=(select auth.uid()) or public.is_admin());
grant select on public.number_verification_submissions to authenticated;

create or replace function public.submit_numbers_for_verification(p_phone_numbers text[])
returns table(id uuid,phone_number text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text;
  v_row public.number_verification_submissions%rowtype;
  v_count integer:=0;
begin
  if auth.uid() is null then raise exception 'Sign in is required' using errcode='42501'; end if;
  if p_phone_numbers is null or cardinality(p_phone_numbers)<1 or cardinality(p_phone_numbers)>30 then
    raise exception 'Submit between 1 and 30 phone numbers';
  end if;
  foreach v_phone in array p_phone_numbers loop
    if v_phone !~ '^0[0-9]{9}$' then raise exception 'Enter valid 10-digit Ghana phone numbers'; end if;
    if exists(select 1 from public.number_verification_submissions where user_id=auth.uid() and phone_number=v_phone) then
      update public.number_verification_submissions
        set verification_status='unchecked',hubnet_status=null,hubnet_error=null,hubnet_checked_at=null,
            datahub_status=null,datahub_submitted_at=null,created_at=now(),updated_at=now()
        where user_id=auth.uid() and phone_number=v_phone
        returning * into v_row;
    else
      insert into public.number_verification_submissions(user_id,phone_number)
        values(auth.uid(),v_phone) returning * into v_row;
    end if;
    id:=v_row.id; phone_number:=v_row.phone_number; return next;
    v_count:=v_count+1;
  end loop;
end;
$$;
revoke all on function public.submit_numbers_for_verification(text[]) from public,anon;
grant execute on function public.submit_numbers_for_verification(text[]) to authenticated;
