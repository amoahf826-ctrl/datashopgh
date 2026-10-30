alter table public.public_updates
  add column if not exists video_url text;

create table if not exists public.public_help_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('article','video')),
  title text not null check (length(trim(title)) between 1 and 120),
  message text not null check (length(trim(message)) between 1 and 4000),
  video_url text,
  priority integer not null default 0 check (priority between 0 and 1000),
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'article' and video_url is null) or (kind = 'video' and video_url is not null))
);

alter table public.public_help_items enable row level security;
grant select on public.public_help_items to anon, authenticated;
grant insert, update, delete on public.public_help_items to authenticated;
create policy "Read active help items" on public.public_help_items for select to anon, authenticated
  using (is_active or public.is_admin());
create policy "Admins manage help items" on public.public_help_items for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create index if not exists public_help_items_active_order on public.public_help_items(is_active, priority desc, created_at desc);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('public-help-videos','public-help-videos',true,52428800,array['video/mp4','video/webm','video/quicktime'])
on conflict(id) do update set public=true,file_size_limit=52428800,allowed_mime_types=array['video/mp4','video/webm','video/quicktime'];
create policy "Read public help videos" on storage.objects for select to anon,authenticated
  using (bucket_id='public-help-videos');
create policy "Admins upload help videos" on storage.objects for insert to authenticated
  with check (bucket_id='public-help-videos' and public.is_admin());
create policy "Admins update help videos" on storage.objects for update to authenticated
  using (bucket_id='public-help-videos' and public.is_admin()) with check (bucket_id='public-help-videos' and public.is_admin());
create policy "Admins delete help videos" on storage.objects for delete to authenticated
  using (bucket_id='public-help-videos' and public.is_admin());

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('public-update-videos','public-update-videos',true,52428800,array['video/mp4','video/webm','video/quicktime'])
on conflict(id) do update set public=true,file_size_limit=52428800,allowed_mime_types=array['video/mp4','video/webm','video/quicktime'];
create policy "Read public update videos" on storage.objects for select to anon,authenticated
  using (bucket_id='public-update-videos');
create policy "Admins upload public update videos" on storage.objects for insert to authenticated
  with check (bucket_id='public-update-videos' and public.is_admin());
create policy "Admins update public update videos" on storage.objects for update to authenticated
  using (bucket_id='public-update-videos' and public.is_admin()) with check (bucket_id='public-update-videos' and public.is_admin());
create policy "Admins delete public update videos" on storage.objects for delete to authenticated
  using (bucket_id='public-update-videos' and public.is_admin());

create trigger audit_public_help_item_changes after insert or update or delete on public.public_help_items
  for each row execute procedure public.audit_row_change();
