-- Keep paid, nonterminal provider orders synchronized even when no dashboard is open.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid)
from cron.job
where jobname in ('provider-status-sync-datahub', 'provider-status-sync-hubnet');

select cron.schedule(
  'provider-status-sync-datahub',
  '*/2 * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'provider_sync_project_url') || '/functions/v1/datahub-order-status-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'provider_sync_anon_key'),
        'x-provider-status-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'provider_status_sync_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $job$
);

select cron.schedule(
  'provider-status-sync-hubnet',
  '*/2 * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'provider_sync_project_url') || '/functions/v1/hubnet-order-status-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'provider_sync_anon_key'),
        'x-provider-status-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'provider_status_sync_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $job$
);
