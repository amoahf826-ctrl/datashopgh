create table if not exists public.public_updates (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'advert' check (kind in ('advert','notice')),
  show_on text not null default 'everywhere' check (show_on in ('storefront','agents','everywhere')),
  title text not null check (length(trim(title)) between 1 and 120),
  message text not null check (length(trim(message)) between 1 and 2000),
  image_url text,
  button_text text,
  button_link text,
  tone text not null default 'info' check (tone in ('info','warning','success')),
  is_active boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  priority integer not null default 0 check (priority between 0 and 1000),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check (button_link is null or button_link ~ '^(https://|http://|/|#)')
);
alter table public.public_updates enable row level security;
grant select on public.public_updates to anon, authenticated;
grant insert, update, delete on public.public_updates to authenticated;
create policy "Read active public updates" on public.public_updates for select to anon, authenticated using (
  is_active and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now())
  or public.is_admin()
);
create policy "Admins manage public updates" on public.public_updates for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create index if not exists public_updates_active_schedule on public.public_updates(is_active, priority desc, starts_at, ends_at);
create trigger audit_public_update_changes after insert or update or delete on public.public_updates
  for each row execute procedure public.audit_row_change();

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('public-update-images','public-update-images',true,3145728,array['image/jpeg','image/png','image/webp','image/gif'])
on conflict(id) do update set public=true,file_size_limit=3145728,allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif'];
create policy "Read public update images" on storage.objects for select to anon,authenticated
  using (bucket_id='public-update-images');
create policy "Admins upload public update images" on storage.objects for insert to authenticated
  with check (bucket_id='public-update-images' and public.is_admin());
create policy "Admins update public update images" on storage.objects for update to authenticated
  using (bucket_id='public-update-images' and public.is_admin()) with check (bucket_id='public-update-images' and public.is_admin());
create policy "Admins delete public update images" on storage.objects for delete to authenticated
  using (bucket_id='public-update-images' and public.is_admin());
