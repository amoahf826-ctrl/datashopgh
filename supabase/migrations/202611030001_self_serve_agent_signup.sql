-- Create a limited, active agent account only when a new user explicitly signs
-- up through the storefront's Register as Agent flow. Customer signup remains
-- unchanged, and self-registration cannot grant the super_agent type.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), 'Agent');
  v_phone text := coalesce(nullif(trim(new.raw_user_meta_data->>'phone'), ''), '');
  v_username text := lower(coalesce(nullif(trim(new.raw_user_meta_data->>'username'), ''), split_part(coalesce(new.email, ''), '@', 1), 'agent'));
begin
  insert into public.profiles(id, email) values(new.id, new.email);
  insert into public.wallets(user_id) values(new.id);

  if lower(coalesce(new.raw_user_meta_data->>'account_type', '')) = 'agent' then
    insert into public.agent_accounts(
      user_id, agent_type, is_active, assigned_by, username, business_name, phone
    ) values (
      new.id, 'agent', true, new.id, v_username, v_name, v_phone
    ) on conflict (user_id) do nothing;
  end if;

  return new;
end;
$$;
