-- One-time SMS challenges for account registration by a confirmed phone number.
create table if not exists public.sms_phone_signup_challenges (
  challenge_id uuid primary key,
  phone text not null check (phone ~ '^0[0-9]{9}$'),
  code_hash text not null,
  ip_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  attempts integer not null default 0 check (attempts between 0 and 5),
  verified_at timestamptz,
  consumed_at timestamptz
);
create index if not exists sms_phone_signup_phone_created_idx
  on public.sms_phone_signup_challenges(phone, created_at desc);
create index if not exists sms_phone_signup_ip_created_idx
  on public.sms_phone_signup_challenges(ip_hash, created_at desc);
alter table public.sms_phone_signup_challenges enable row level security;
revoke all on public.sms_phone_signup_challenges from public, anon, authenticated;

create or replace function public.issue_sms_phone_signup_challenge(
  p_challenge_id uuid, p_phone text, p_code_hash text, p_ip_hash text
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_phone_count integer; v_ip_count integer;
begin
  delete from public.sms_phone_signup_challenges where created_at < now()-interval '1 day';
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sms-signup-phone:' || p_phone, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sms-signup-ip:' || p_ip_hash, 0));
  select count(*) into v_phone_count from public.sms_phone_signup_challenges
    where phone=p_phone and created_at > now()-interval '1 hour';
  select count(*) into v_ip_count from public.sms_phone_signup_challenges
    where ip_hash=p_ip_hash and created_at > now()-interval '1 hour';
  if v_phone_count >= 3 or v_ip_count >= 10 then return false; end if;
  update public.sms_phone_signup_challenges set consumed_at=now()
    where phone=p_phone and consumed_at is null;
  insert into public.sms_phone_signup_challenges(challenge_id,phone,code_hash,ip_hash)
    values(p_challenge_id,p_phone,p_code_hash,p_ip_hash);
  return true;
end;
$$;
revoke all on function public.issue_sms_phone_signup_challenge(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.issue_sms_phone_signup_challenge(uuid,text,text,text) to service_role;

create or replace function public.verify_sms_phone_signup_challenge(p_challenge_id uuid,p_code_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_row public.sms_phone_signup_challenges%rowtype;
begin
  select * into v_row from public.sms_phone_signup_challenges where challenge_id=p_challenge_id for update;
  if not found or v_row.consumed_at is not null or v_row.expires_at <= now()
     or v_row.verified_at is not null or v_row.attempts >= 5 then return false; end if;
  if v_row.code_hash <> p_code_hash then
    update public.sms_phone_signup_challenges set attempts=attempts+1,
      consumed_at=case when attempts+1 >= 5 then now() else consumed_at end
      where challenge_id=p_challenge_id;
    return false;
  end if;
  update public.sms_phone_signup_challenges set verified_at=now() where challenge_id=p_challenge_id;
  return true;
end;
$$;
revoke all on function public.verify_sms_phone_signup_challenge(uuid,text) from public, anon, authenticated;
grant execute on function public.verify_sms_phone_signup_challenge(uuid,text) to service_role;

create or replace function public.consume_sms_phone_signup_challenge(p_challenge_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_phone text;
begin
  update public.sms_phone_signup_challenges set consumed_at=now()
    where challenge_id=p_challenge_id and verified_at is not null
      and verified_at > now()-interval '10 minutes' and expires_at > now()
      and consumed_at is null
    returning phone into v_phone;
  return v_phone;
end;
$$;
revoke all on function public.consume_sms_phone_signup_challenge(uuid) from public, anon, authenticated;
grant execute on function public.consume_sms_phone_signup_challenge(uuid) to service_role;
