-- Atomically limit public agent-store number checks by IP and agent referral code.
create or replace function public.consume_public_number_verification_rate_limit(
  p_rate_key text, p_limit integer default 10
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if p_rate_key is null or p_rate_key !~ '^number-verification:[0-9a-f]{64}$'
    or p_limit is null or p_limit < 1 or p_limit > 30 then
    raise exception 'Invalid number verification rate-limit request';
  end if;
  delete from public.public_checkout_rate_limits where window_started_at < now() - interval '1 day';
  insert into public.public_checkout_rate_limits as existing(rate_key,window_started_at,request_count)
  values(p_rate_key,now(),1)
  on conflict(rate_key) do update set
    window_started_at=case when existing.window_started_at <= now() - interval '10 minutes' then now() else existing.window_started_at end,
    request_count=case when existing.window_started_at <= now() - interval '10 minutes' then 1 else existing.request_count + 1 end
  returning request_count into v_count;
  return v_count <= p_limit;
end;
$$;
revoke all on function public.consume_public_number_verification_rate_limit(text,integer) from public,anon,authenticated;
grant execute on function public.consume_public_number_verification_rate_limit(text,integer) to service_role;
