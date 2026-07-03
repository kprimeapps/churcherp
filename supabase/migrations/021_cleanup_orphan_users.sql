-- ChurchOS v2 — Migration 021: Clean up orphaned signups
-- A user who runs "Create Account" but abandons before creating an org leaves
-- an auth user with a profile whose org_id is null. These accumulate. Delete
-- them once they're clearly abandoned (older than 48h).

create extension if not exists pg_cron;

-- Deletes auth users that never joined/created an org and are >48h old.
-- Runs as the function owner (postgres) so it can touch auth.users.
create or replace function cleanup_orphan_users()
returns integer language plpgsql security definer
set search_path = public, auth as $$
declare
  n integer;
begin
  with orphans as (
    select u.id
    from auth.users u
    left join public.profiles p on p.id = u.id
    where u.created_at < now() - interval '48 hours'
      and (p.id is null or p.org_id is null)
  )
  delete from auth.users where id in (select id from orphans);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Schedule daily at 03:00 UTC. Unschedule any prior copy first (idempotent).
do $$
begin
  perform cron.unschedule('cleanup-orphan-users');
exception when others then null;
end $$;

select cron.schedule('cleanup-orphan-users', '0 3 * * *',
                     $$select cleanup_orphan_users()$$);
