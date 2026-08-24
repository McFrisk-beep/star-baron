-- retention.sql — one daily sweep that keeps the database from growing forever.
--
-- The world ticks already trim their own tables (world_feed 3h, world_news 6h,
-- world_senate 14d). Everything else appended without a ceiling. As measured on
-- 2026-08-24, 69 days after the project was created:
--
--   cron.job_run_details   16 MB / 104,638 rows — 46% of a 35 MB database, and
--                          the single largest table in it. pg_cron logs every
--                          run of all four jobs (~1,537 rows/day) and never
--                          prunes; Supabase does not purge it for you. That is
--                          ~85 MB/year of pure operational exhaust, accruing
--                          whether or not a single player is online.
--   world_senate_result    retention was written in docs/SENATE_SETUP.md and
--   world_senate_influence left commented out ("optional housekeeping").
--   station_*              the ledgers grow one row per haul / payout / tax /
--                          listing / auction, forever. Empty-ish today only
--                          because stations are barely used.
--   players + saves        ~43 KB and ~34 KB of live JSONB per account. Not a
--                          retention problem while an account is live — it is
--                          the actual ceiling (~1,400 accounts against the
--                          500 MB free tier), so abandoned accounts are reaped.
--
-- WHAT THIS WILL NOT DELETE — the ledgers double as custody records, and
-- dropping the wrong row destroys a player's goods or credits:
--
--   station_payouts / station_bay_tax with claimed_at IS NULL are credits the
--     player is still owed. Only claimed rows are pruned.
--   station_listings with status 'open' or 'cancelled' still hold the seller's
--     ITEM server-side — app_station_settle() hands it back on their next visit
--     (docs/sql/hall_item_custody.sql:416). Only 'sold' / 'reclaimed' /
--     'refunded' are pruned.
--   station_hauls with status 'open' or 'active' are in flight. Only the
--     terminal four are pruned.
--
-- Apply: paste into the Supabase SQL editor and run once. Idempotent.
-- Prereq: none beyond the tables themselves — a rule whose table is missing is
--         skipped, so this is safe on a project that hasn't run the station SQL.
-- Checked by tools/check_retention.js.
--
-- Tuning: the windows are the interval literals in the rule list below. Edit
-- them and re-run this file, exactly like world_tick's `lines` array.

-- ===========================================================================
-- 1 — helpers for the abandoned-account reap
-- ===========================================================================

-- Newest sign of life across BOTH save rows. `players` is authoritative and
-- `saves` is the legacy Phase-1 fallback (js/cloud.js loadRemote) — reaping one
-- without the other would let a stale legacy save resurrect as the live game,
-- so both are gated on the same combined timestamp.
create or replace function app._last_seen(p_user uuid)
returns timestamptz
language sql stable
set search_path = public, app
as $fn$
  select greatest(
    coalesce((select max(updated_at) from public.players  where user_id = p_user), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from public.saves    where user_id = p_user), '-infinity'::timestamptz),
    coalesce((select max(created_at) from public.profiles where user_id = p_user), '-infinity'::timestamptz));
$fn$;

-- An account is reapable only if it is BOTH cold and settled: nothing in flight,
-- nothing owed, nothing owned. Each blocker below is a way a reap would destroy
-- something the player would rightly expect to find waiting for them.
--
-- Fails CLOSED: any doubt returns false and the account is kept. The station
-- tables only exist once docs/sql/station_*.sql has been run, so each blocker is
-- skipped when its table is absent — a table that does not exist cannot be
-- holding anything. They are probed dynamically for that reason: a plain
-- reference would make this function fail to parse on a stations-less project
-- and take the whole sweep (including the cron-log prune) down with it.
--
-- ponytail: 6 probes per cold account per day. Fine at this scale; if the reap
-- ever walks thousands of accounts, hoist the blockers into one anti-join pass.
create or replace function app._abandoned(p_user uuid, p_keep interval)
returns boolean
language plpgsql stable
set search_path = public, app
as $fn$
declare
  b   record;
  hit boolean;
begin
  if app._last_seen(p_user) >= now() - p_keep then
    return false;                                   -- still warm
  end if;
  if exists (select 1 from public.profiles p
              where p.user_id = p_user and p.role = 'admin') then
    return false;                                   -- never reap an operator
  end if;

  for b in
    select * from (values
      -- a station outlives its owner's absence; reaping would orphan it
      ('public.stations',         $p$owner_id = $1$p$),
      -- credits still owed
      ('public.station_payouts',  $p$user_id = $1 and claimed_at is null$p$),
      ('public.station_bay_tax',  $p$(owner_id = $1 or lessee_id = $1) and claimed_at is null$p$),
      -- goods still in custody, awaiting app_station_settle()
      ('public.station_listings', $p$seller_id = $1 and status in ('open','cancelled')$p$),
      -- work in flight
      ('public.station_hauls',    $p$(owner_id = $1 or taken_by = $1) and status in ('open','active')$p$),
      ('public.station_auctions', $p$high_bidder = $1 and status = 'open'$p$)
    ) as t(tbl, pred)
  loop
    if to_regclass(b.tbl) is null then continue; end if;
    execute format('select exists (select 1 from %s where %s)', b.tbl, b.pred)
      into hit using p_user;
    if hit then return false; end if;
  end loop;

  return true;
end;
$fn$;

-- ===========================================================================
-- 2 — the sweep
-- ===========================================================================

-- p_dry_run => count what WOULD go, delete nothing. Always dry-run first after
-- editing a window; the account reap is not recoverable.
create or replace function public.retention_tick(p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $fn$
declare
  r      record;
  n      bigint;
  total  bigint := 0;
  report jsonb  := '{}'::jsonb;
begin
  for r in
    -- ord keeps the sweep deterministic: ledgers settle before accounts are
    -- reaped, and orphan cleanup runs after the rows it orphans are gone.
    -- The predicates are literals compiled into this function, never input —
    -- that is what makes the format() below safe.
    select * from (values
      -- pg_cron's own run log. The big one.
      (1,  'cron.job_run_details',          $p$start_time < now() - interval '14 days'$p$),

      -- shared world history, player-visible but long past acting on
      (2,  'public.world_senate_result',    $p$created_at < now() - interval '21 days'$p$),
      (3,  'public.world_senate_influence', $p$created_at < now() - interval '14 days'$p$),

      -- station ledgers: settled rows only (see the custody note in the header)
      (4,  'public.station_hauls',          $p$status in ('filled','cancelled','expired','failed')
                                              and coalesce(taken_at, created_at) < now() - interval '30 days'$p$),
      (5,  'public.station_listings',       $p$status in ('sold','reclaimed','refunded')
                                              and coalesce(settled_at, listed_at) < now() - interval '30 days'$p$),
      (6,  'public.station_auctions',       $p$status in ('closed','cancelled','forfeit')
                                              and closes_at < now() - interval '30 days'$p$),
      (7,  'public.station_payouts',        $p$claimed_at is not null
                                              and claimed_at < now() - interval '30 days'$p$),
      (8,  'public.station_bay_tax',        $p$claimed_at is not null
                                              and claimed_at < now() - interval '30 days'$p$),

      -- presence is a live signal; a stale row is just noise
      (9,  'public.flagship_presence',      $p$updated_at < now() - interval '2 days'$p$),

      -- abandoned accounts. profiles/auth.users are deliberately KEPT so a
      -- returning player still owns their username — they come back to a fresh
      -- save, not a taken handle.
      (10, 'public.players',                $p$app._abandoned(user_id, interval '180 days')$p$),
      (11, 'public.saves',                  $p$app._abandoned(user_id, interval '180 days')$p$),

      -- leaderboard rows whose save no longer exists (incl. those just reaped)
      (12, 'public.baron_board',            $p$not exists (select 1 from public.players p
                                                            where p.user_id = baron_board.user_id)$p$)
    ) as t(ord, tbl, pred)
    order by ord
  loop
    -- A project that never ran the station SQL simply has no such table.
    if to_regclass(r.tbl) is null then continue; end if;

    if p_dry_run then
      execute format('select count(*) from %s where %s', r.tbl, r.pred) into n;
    else
      execute format('with d as (delete from %s where %s returning 1) select count(*) from d',
                     r.tbl, r.pred) into n;
    end if;

    total  := total + n;
    report := report || jsonb_build_object(r.tbl, n);
  end loop;

  return jsonb_build_object('dry_run', p_dry_run, 'at', now(), 'total', total, 'rows', report);
end;
$fn$;

-- This function deletes save data. Postgres grants EXECUTE to PUBLIC by
-- default, which would hand every anon visitor a call on it.
revoke execute on function public.retention_tick(boolean) from public;
revoke execute on function public.retention_tick(boolean) from anon, authenticated;

-- ===========================================================================
-- 3 — schedule it
-- ===========================================================================

-- 03:17 UTC: off the hour, so it never contends with stock-tick (:00) or
-- senate-tick (00:00). Daily is plenty — nothing here is urgent.
select cron.unschedule('retention-tick')
 where exists (select 1 from cron.job where jobname = 'retention-tick');
select cron.schedule('retention-tick', '17 3 * * *', $c$ select public.retention_tick(); $c$);

-- ===========================================================================
-- 4 — one-off: de-bloat sector_stock  (RUN THIS BLOCK BY HAND, ONCE)
-- ===========================================================================
--
-- Not a retention problem — a bloat one, and worth fixing while you are here.
-- stock-tick rewrites all 246 rows hourly: 122,553 updates so far, of which only
-- 748 (0.6%) were HOT. At the default fillfactor of 100 a full page has nowhere
-- to put the new row version, so each update lands on a fresh page and drags an
-- index write with it. The result: 14 KB of live data sitting in 2,744 KB.
--
-- fillfactor 70 leaves each page room to hold the next few versions in place,
-- which is what makes an update HOT. VACUUM FULL then rewrites the table once to
-- hand back the space already lost. It takes an ACCESS EXCLUSIVE lock — on a
-- table this small that is milliseconds, but it is why this is not in the cron.
--
--   alter table public.sector_stock set (fillfactor = 70);
--   vacuum full public.sector_stock;
--   vacuum full cron.job_run_details;   -- after the first retention_tick()
--
-- ===========================================================================
-- 5 — verify
-- ===========================================================================
--
--   select public.retention_tick(true);   -- dry run: what would go, per table
--   select public.retention_tick();       -- for real
--
--   select jobname, schedule, active from cron.job;
--   select jobname, status, start_time from cron.job_run_details
--    where jobname = 'retention-tick' order by start_time desc limit 5;
--
--   -- size, before and after
--   select c.relname, pg_size_pretty(pg_total_relation_size(c.oid))
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname in ('public','cron') and c.relkind = 'r'
--    order by pg_total_relation_size(c.oid) desc limit 10;
