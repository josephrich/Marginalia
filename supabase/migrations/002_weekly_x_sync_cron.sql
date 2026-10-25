create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Random secret generated in-database; never leaves Postgres except in the cron's own request.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'sync_x_cron_secret');

-- Lets the sync-x edge function (service role only) verify the cron's header.
create function public.check_cron_secret(candidate text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'sync_x_cron_secret' and decrypted_secret = candidate);
$$;
revoke execute on function public.check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.check_cron_secret(text) to service_role;

-- Weekly on Mondays 09:17 UTC (~7–8pm Sydney).
select cron.schedule('sync-x-weekly', '17 9 * * 1', $$
  select net.http_post(
    url := 'https://ztzxhzmbxgaxrmphenrp.supabase.co/functions/v1/sync-x',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_x_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
