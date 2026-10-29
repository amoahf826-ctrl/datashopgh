alter table public.agent_accounts
  add column if not exists store_name text not null default '',
  add column if not exists store_logo_url text not null default '';

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('agent-store-logos','agent-store-logos',true,2097152,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=true,file_size_limit=2097152,allowed_mime_types=array['image/jpeg','image/png','image/webp'];

drop policy if exists "Read agent store logos" on storage.objects;
create policy "Read agent store logos" on storage.objects for select to anon,authenticated
  using(bucket_id='agent-store-logos');
drop policy if exists "Agents upload own store logo" on storage.objects;
create policy "Agents upload own store logo" on storage.objects for insert to authenticated
  with check(bucket_id='agent-store-logos' and (storage.foldername(name))[1]=(select auth.uid())::text);
drop policy if exists "Agents update own store logo" on storage.objects;
create policy "Agents update own store logo" on storage.objects for update to authenticated
  using(bucket_id='agent-store-logos' and (storage.foldername(name))[1]=(select auth.uid())::text)
  with check(bucket_id='agent-store-logos' and (storage.foldername(name))[1]=(select auth.uid())::text);
drop policy if exists "Agents delete own store logo" on storage.objects;
create policy "Agents delete own store logo" on storage.objects for delete to authenticated
  using(bucket_id='agent-store-logos' and (storage.foldername(name))[1]=(select auth.uid())::text);

create or replace function public.get_my_agent_store_profile()
returns table(store_name text,store_logo_url text,whatsapp_phone text)
language sql stable security definer set search_path='' as $$
  select coalesce(nullif(trim(account.store_name),''),nullif(trim(account.business_name),''),nullif(trim(account.username),''),'Agent Store'),
         coalesce(account.store_logo_url,''),
         coalesce(nullif(regexp_replace(coalesce(account.phone,''),'[^0-9]','','g'),''),nullif(regexp_replace(coalesce(profile.phone,''),'[^0-9]','','g'),''),nullif(regexp_replace(coalesce(auth_user.raw_user_meta_data->>'phone',''),'[^0-9]','','g'),''),'')
  from public.agent_accounts account
  left join public.profiles profile on profile.id=account.user_id
  left join auth.users auth_user on auth_user.id=account.user_id
  where account.user_id=(select auth.uid()) and account.is_active;
$$;

create or replace function public.get_public_agent_store_profile(p_referral_code text)
returns table(store_name text,store_logo_url text,whatsapp_phone text)
language sql stable security definer set search_path='' as $$
  select coalesce(nullif(trim(account.store_name),''),nullif(trim(account.business_name),''),nullif(trim(account.username),''),'Agent Store'),
         coalesce(account.store_logo_url,''),
         coalesce(nullif(regexp_replace(coalesce(account.phone,''),'[^0-9]','','g'),''),nullif(regexp_replace(coalesce(profile.phone,''),'[^0-9]','','g'),''),nullif(regexp_replace(coalesce(auth_user.raw_user_meta_data->>'phone',''),'[^0-9]','','g'),''),'')
  from public.agent_accounts account
  left join public.profiles profile on profile.id=account.user_id
  left join auth.users auth_user on auth_user.id=account.user_id
  where account.is_active and account.referral_code=upper(trim(p_referral_code))
  limit 1;
$$;

create or replace function public.agent_save_store_profile(p_store_name text,p_store_logo_url text,p_whatsapp_phone text)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_phone text;
begin
  if not exists(select 1 from public.agent_accounts where user_id=(select auth.uid()) and is_active) then
    raise exception 'Active agent account required' using errcode='42501';
  end if;
  if char_length(trim(coalesce(p_store_name,''))) not between 2 and 80 then
    raise exception 'Store name must be between 2 and 80 characters';
  end if;
  if char_length(coalesce(p_store_logo_url,''))>1000 or (coalesce(p_store_logo_url,'')<>'' and p_store_logo_url !~ '^https://') then
    raise exception 'Store logo must use a secure HTTPS URL';
  end if;
  v_phone:=regexp_replace(coalesce(p_whatsapp_phone,''),'[^0-9]','','g');
  if v_phone like '233%' and length(v_phone)=12 then v_phone:='0'||substr(v_phone,4); end if;
  if v_phone<>'' and v_phone !~ '^0[0-9]{9}$' then raise exception 'Enter a valid 10-digit Ghana WhatsApp number'; end if;
  update public.agent_accounts
    set store_name=trim(p_store_name),store_logo_url=coalesce(p_store_logo_url,''),phone=v_phone
    where user_id=(select auth.uid()) and is_active;
  return true;
end $$;

revoke all on function public.get_my_agent_store_profile() from public,anon;
revoke all on function public.get_public_agent_store_profile(text) from public;
revoke all on function public.agent_save_store_profile(text,text,text) from public,anon;
grant execute on function public.get_my_agent_store_profile() to authenticated;
grant execute on function public.get_public_agent_store_profile(text) to anon,authenticated;
grant execute on function public.agent_save_store_profile(text,text,text) to authenticated;
