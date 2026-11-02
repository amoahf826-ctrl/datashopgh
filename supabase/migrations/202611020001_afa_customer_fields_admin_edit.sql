alter table public.afa_requests
  add column if not exists date_of_birth date,
  add column if not exists job text;

alter table public.afa_requests drop constraint if exists afa_requests_job_check;
alter table public.afa_requests add constraint afa_requests_job_check
  check (job is null or length(trim(job)) between 2 and 120);

-- New AFA submissions must include the requested details. Existing records remain valid.
drop policy if exists "Customers submit pending AFA requests" on public.afa_requests;
create policy "Customers submit pending AFA requests" on public.afa_requests for insert to authenticated
  with check (
    user_id=(select auth.uid()) and status='pending' and handled_by is null and handled_at is null
    and length(trim(coalesce(customer_name,''))) between 2 and 100
    and phone ~ '^0[0-9]{9}$'
    and length(trim(coalesce(id_card_number,''))) between 5 and 50
    and length(trim(coalesce(registration_location,''))) between 2 and 150
    and date_of_birth is not null and date_of_birth <= current_date
    and length(trim(coalesce(job,''))) between 2 and 120
    and exists(select 1 from public.afa_plans p where p.id=plan_id and p.is_active)
  );

-- Only administrators may edit request details/status; request owners may only read their own submissions.
drop policy if exists "Admins update AFA requests" on public.afa_requests;
create policy "Admins update AFA requests" on public.afa_requests for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
