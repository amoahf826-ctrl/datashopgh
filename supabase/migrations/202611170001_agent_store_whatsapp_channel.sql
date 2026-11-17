alter table public.agent_accounts
  add column if not exists whatsapp_channel_url text not null default '';

-- PostgreSQL cannot change a function's OUT-column return type with CREATE OR REPLACE.
drop function if exists public.get_my_agent_store_profile();
drop function if exists public.get_public_agent_store_profile(text);
drop function if exists public.agent_save_store_profile(text,text,text);

create or replace function public.get_my_agent_store_profile()
returns table(store_name text, store_logo_url text, whatsapp_phone text, whatsapp_channel_url text)
language sql stable security definer set search_path='' as $$
  select coalesce(nullif(trim(a.store_name),''),nullif(trim(a.business_name),''),nullif(trim(a.username),''),'Agent Store'),
    coalesce(a.store_logo_url,''),
    coalesce(nullif(regexp_replace(coalesce(a.phone,''),'[^0-9]','','g'),''),nullif(regexp_replace(coalesce(p.phone,''),'[^0-9]','','g'),''),nullif(regexp_replace(coalesce(u.raw_user_meta_data->>'phone',''),'[^0-9]','','g'),''),''),
    coalesce(a.whatsapp_channel_url,'')
  from public.agent_accounts a left join public.profiles p on p.id=a.user_id left join auth.users u on u.id=a.user_id
  where a.user_id=(select auth.uid()) and a.is_active;
$$;

create or replace function public.get_public_agent_store_profile(p_referral_code text)
returns table(store_name text, store_logo_url text, whatsapp_phone text, whatsapp_channel_url text)
language sql stable security definer set search_path='' as $$
  select coalesce(nullif(trim(a.store_name),''),nullif(trim(a.business_name),''),nullif(trim(a.username),''),'Agent Store'),
    coalesce(a.store_logo_url,''),
    coalesce(nullif(regexp_replace(coalesce(a.phone,''),'[^0-9]','','g'),''),nullif(regexp_replace(coalesce(p.phone,''),'[^0-9]','','g'),''),nullif(regexp_replace(coalesce(u.raw_user_meta_data->>'phone',''),'[^0-9]','','g'),''),''),
    coalesce(a.whatsapp_channel_url,'')
  from public.agent_accounts a left join public.profiles p on p.id=a.user_id left join auth.users u on u.id=a.user_id
  where a.is_active and a.referral_code=upper(trim(p_referral_code)) limit 1;
$$;

create or replace function public.agent_save_store_profile(p_store_name text,p_store_logo_url text,p_whatsapp_phone text,p_whatsapp_channel_url text default '')
returns boolean language plpgsql security definer set search_path='' as $$
declare v_phone text; v_channel text:=trim(coalesce(p_whatsapp_channel_url,''));
begin
  if not exists(select 1 from public.agent_accounts where user_id=(select auth.uid()) and is_active) then raise exception 'Active agent account required' using errcode='42501'; end if;
  if char_length(trim(coalesce(p_store_name,''))) not between 2 and 80 then raise exception 'Store name must be between 2 and 80 characters'; end if;
  if char_length(coalesce(p_store_logo_url,''))>1000 or (coalesce(p_store_logo_url,'')<>'' and p_store_logo_url !~ '^https://') then raise exception 'Store logo must use a secure HTTPS URL'; end if;
  if char_length(v_channel)>500 or (v_channel<>'' and v_channel !~ '^https://(chat\.whatsapp\.com|whatsapp\.com)/') then raise exception 'Enter a valid WhatsApp channel invite URL'; end if;
  v_phone:=regexp_replace(coalesce(p_whatsapp_phone,''),'[^0-9]','','g');
  if v_phone like '233%' and length(v_phone)=12 then v_phone:='0'||substr(v_phone,4); end if;
  if v_phone<>'' and v_phone !~ '^0[0-9]{9}$' then raise exception 'Enter a valid 10-digit Ghana WhatsApp number'; end if;
  update public.agent_accounts set store_name=trim(p_store_name),store_logo_url=coalesce(p_store_logo_url,''),phone=v_phone,whatsapp_channel_url=v_channel where user_id=(select auth.uid()) and is_active;
  return true;
end $$;
revoke all on function public.agent_save_store_profile(text,text,text,text) from public,anon;
grant execute on function public.agent_save_store_profile(text,text,text,text) to authenticated;
