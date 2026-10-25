-- Weekly X bookmark sync (Mondays 09:17 UTC). Run once after deploying the functions,
-- replacing <PROJECT_REF> and <CRON_SECRET> (the same value as the CRON_SECRET function secret).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('<CRON_SECRET>', 'sync_x_cron_secret');

select cron.schedule('sync-x-weekly', '17 9 * * 1', $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-x',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_x_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
