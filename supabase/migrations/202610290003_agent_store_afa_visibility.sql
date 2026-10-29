alter table public.agent_accounts
  add column if not exists show_afa_on_store boolean not null default true;

create or replace function public.get_my_agent_store_afa_visibility()
returns boolean language sql stable security definer set search_path='' as $$
  select account.show_afa_on_store
  from public.agent_accounts account
  where account.user_id=(select auth.uid()) and account.is_active
  limit 1;
$$;

create or replace function public.get_public_agent_store_afa_visibility(p_referral_code text)
returns boolean language sql stable security definer set search_path='' as $$
  select account.show_afa_on_store
  from public.agent_accounts account
  where account.is_active and upper(account.referral_code)=upper(trim(p_referral_code))
  limit 1;
$$;

create or replace function public.agent_save_store_afa_visibility(p_show boolean)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  update public.agent_accounts
    set show_afa_on_store=coalesce(p_show,true)
    where user_id=(select auth.uid()) and is_active;
  if not found then raise exception 'Active agent account required' using errcode='42501'; end if;
  return true;
end $$;

revoke all on function public.get_my_agent_store_afa_visibility() from public,anon;
revoke all on function public.get_public_agent_store_afa_visibility(text) from public;
revoke all on function public.agent_save_store_afa_visibility(boolean) from public,anon;
grant execute on function public.get_my_agent_store_afa_visibility() to authenticated;
grant execute on function public.get_public_agent_store_afa_visibility(text) to anon,authenticated;
grant execute on function public.agent_save_store_afa_visibility(boolean) to authenticated;
