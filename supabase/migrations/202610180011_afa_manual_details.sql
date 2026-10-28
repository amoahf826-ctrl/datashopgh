-- Collect only the additional fields needed for the administrator's manual AFA submission.
alter table public.afa_requests
  add column if not exists id_card_number text,
  add column if not exists registration_location text;

alter table public.afa_requests drop constraint if exists afa_requests_id_card_number_check;
alter table public.afa_requests add constraint afa_requests_id_card_number_check
  check (id_card_number is null or length(trim(id_card_number)) between 5 and 50);
alter table public.afa_requests drop constraint if exists afa_requests_registration_location_check;
alter table public.afa_requests add constraint afa_requests_registration_location_check
  check (registration_location is null or length(trim(registration_location)) between 2 and 150);

drop policy if exists "Customers submit pending AFA requests" on public.afa_requests;
create policy "Customers submit pending AFA requests" on public.afa_requests for insert to authenticated
  with check (
    user_id=(select auth.uid()) and status='pending' and handled_by is null and handled_at is null
    and length(trim(coalesce(id_card_number,''))) between 5 and 50
    and length(trim(coalesce(registration_location,''))) between 2 and 150
    and exists(select 1 from public.afa_plans p where p.id=plan_id and p.is_active)
  );
