-- Highlights synced between devices. The app stores each highlight as JSON in `data`;
-- `updated_at` (ms, set by the writer) decides conflicts, `synced_at` (server clock) drives incremental pulls.
create table public.highlights (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  data jsonb not null,
  updated_at bigint not null,
  deleted boolean not null default false,
  synced_at timestamptz not null default clock_timestamp(),
  primary key (user_id, id)
);
create index highlights_user_synced on public.highlights (user_id, synced_at);

alter table public.highlights enable row level security;
create policy "Users manage their own highlights" on public.highlights
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Last write wins: ignore updates older than what's stored, and stamp every write with the server clock.
create function public.highlights_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;
  end if;
  new.synced_at := clock_timestamp();
  return new;
end $$;

create trigger highlights_touch before insert or update on public.highlights
  for each row execute function public.highlights_touch();

-- X OAuth tokens. RLS on with no policies: only the edge functions (service role) can read them.
create table public.x_connections (
  user_id uuid primary key references auth.users on delete cascade,
  x_user_id text not null,
  x_username text,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  last_sync_at timestamptz,
  last_sync_added int,
  last_error text,
  created_at timestamptz not null default now()
);
alter table public.x_connections enable row level security;

create table public.x_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users on delete cascade,
  verifier text not null,
  created_at timestamptz not null default now()
);
alter table public.x_oauth_states enable row level security;

-- What the app is allowed to see about its X connection (no tokens).
create function public.x_status()
returns table (x_username text, last_sync_at timestamptz, last_sync_added int, last_error text)
language sql stable security definer set search_path = '' as $$
  select x_username, last_sync_at, last_sync_added, last_error
  from public.x_connections where user_id = (select auth.uid());
$$;
revoke execute on function public.x_status() from public, anon;
grant execute on function public.x_status() to authenticated;

create function public.x_disconnect() returns void
language sql security definer set search_path = '' as $$
  delete from public.x_connections where user_id = (select auth.uid());
$$;
revoke execute on function public.x_disconnect() from public, anon;
grant execute on function public.x_disconnect() to authenticated;
