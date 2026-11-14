-- Store every account phone on its profile and enforce one account per phone.
update public.profiles p
set phone = a.phone
from public.agent_accounts a
where a.user_id = p.id
  and nullif(btrim(a.phone), '') is not null;

-- Keep legacy duplicate profiles intact, but serialize claims so a number
-- already attached to any account cannot be claimed by a new account.
create or replace function public.enforce_one_profile_per_phone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_digits text;
  v_normalized text;
  v_existing uuid;
begin
  v_digits := regexp_replace(coalesce(new.phone, ''), '[^0-9]', '', 'g');
  if v_digits = '' then return new; end if;
  v_normalized := case when left(v_digits, 3) = '233' then '0' || substring(v_digits from 4) else v_digits end;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('profile-phone:' || v_normalized, 0));
  select p.id into v_existing
  from public.profiles p
  where p.id is distinct from new.id
    and case
      when left(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g'), 3) = '233'
        then '0' || substring(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') from 4)
      else regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g')
    end = v_normalized
  limit 1;

  if v_existing is not null then
    raise exception using errcode = '23505', message = 'This phone number is already linked to another account.';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_enforce_one_phone on public.profiles;
create trigger profiles_enforce_one_phone
before insert or update of phone on public.profiles
for each row execute function public.enforce_one_profile_per_phone();

create or replace function public.is_profile_phone_in_use(p_phone text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where case
      when left(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g'), 3) = '233'
        then '0' || substring(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') from 4)
      else regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g')
    end = case
      when left(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), 3) = '233'
        then '0' || substring(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') from 4)
      else regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')
    end
  );
$$;
revoke all on function public.is_profile_phone_in_use(text) from public, anon, authenticated;
grant execute on function public.is_profile_phone_in_use(text) to service_role;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := nullif(trim(new.raw_user_meta_data->>'full_name'), '');
  v_phone text := coalesce(nullif(trim(new.raw_user_meta_data->>'phone'), ''), '');
  v_username text := lower(coalesce(nullif(trim(new.raw_user_meta_data->>'username'), ''), split_part(coalesce(new.email, ''), '@', 1), 'agent'));
begin
  insert into public.profiles(id, email, full_name, phone)
  values(new.id, new.email, coalesce(v_name, ''), v_phone);
  insert into public.wallets(user_id) values(new.id);

  if lower(coalesce(new.raw_user_meta_data->>'account_type', '')) = 'agent' then
    insert into public.agent_accounts(
      user_id, agent_type, is_active, assigned_by, username, business_name, phone
    ) values (
      new.id, 'agent', true, new.id, v_username, coalesce(v_name, 'Agent'), v_phone
    ) on conflict (user_id) do nothing;
  end if;

  return new;
end;
$$;

create or replace function public.consume_agent_signup_rate_limit(p_rate_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_rate_key is null or p_rate_key !~ '^agent-signup:[0-9a-f]{64}$' then
    raise exception 'Invalid agent signup rate-limit request';
  end if;
  delete from public.public_checkout_rate_limits
    where window_started_at < now() - interval '1 day';
  insert into public.public_checkout_rate_limits as existing(rate_key, window_started_at, request_count)
  values(p_rate_key, now(), 1)
  on conflict(rate_key) do update set
    window_started_at = case
      when existing.window_started_at <= now() - interval '1 hour' then now()
      else existing.window_started_at
    end,
    request_count = case
      when existing.window_started_at <= now() - interval '1 hour' then 1
      else existing.request_count + 1
    end
  returning request_count into v_count;
  return v_count <= 5;
end;
$$;
revoke all on function public.consume_agent_signup_rate_limit(text) from public, anon, authenticated;
grant execute on function public.consume_agent_signup_rate_limit(text) to service_role;
