-- commit_lite.sql — app_commit_lite(): the same commit, without the fat echo.
--
-- app_commit returns `{ok, state}` where `state` is the WHOLE merged save. On
-- a live player that is ~215KB, and Economy.applyCommitState reads NONE of the
-- world slices in it (market / galaxy / stations / story / senate / stock /
-- newswire): they are regenerated client-side from the seed, or read from the
-- shared world tables. So every autosave paid ~213KB of egress to send back
-- something the client immediately discarded — measured as the single most
-- expensive statement on this project (9,454 calls, 476s, 50ms avg).
--
-- This is a WRAPPER, not a fork: it calls app_commit and subtracts those keys
-- from the result. The commit's merge/protection logic is untouched and cannot
-- drift out of sync with it, which is why this is a wrapper rather than a
-- copy-paste of the 200-line body.
--
-- Prereq: docs/sql/phase1_players.sql (app_commit). Every later file that
--         redefines app_commit (phase2_missions_bazaar, phase3_pull_prestige,
--         workshop_craft, charter_rpcs, crime_coefficient, …) is picked up
--         automatically — no need to re-run this after those.
-- Apply: paste into the Supabase SQL editor and run once. Idempotent.
--
-- Client: js/cloud.js Cloud.commit() calls this and falls back to app_commit
-- when it's missing, so applying this file is optional — a project without it
-- just keeps paying for the full-size response.

-- SECURITY INVOKER (the default) on purpose: app_commit is itself SECURITY
-- DEFINER and resolves auth.uid() from the request's JWT claims, which are a
-- session setting and so still visible inside this call. Marking the wrapper
-- DEFINER would add a privilege boundary that buys nothing.
create or replace function public.app_commit_lite(p_state jsonb)
returns jsonb
language sql
set search_path = public
as $$
  select case
    when jsonb_typeof(r -> 'state') = 'object'
      then jsonb_set(r, '{state}',
        (r -> 'state')
          - 'market'      -- prices/hist are pure functions of (seed, effects, now)
          - 'galaxy'      -- per-system flavour log; client-only, never sent up
          - 'stations'    -- shared, read via app_station_directory
          - 'story'       -- client-owned narrative progress
          - 'senate'      -- shared, read via world_senate / world_senate_result
          - 'stock'       -- shared, read via app_sector_stock
          - 'newswire')   -- shared, read via world_news
    else r                -- {ok:false, error:…} passes straight through
  end
  from public.app_commit(p_state) as r;
$$;

revoke all on function public.app_commit_lite(jsonb) from public, anon;
grant execute on function public.app_commit_lite(jsonb) to authenticated;
