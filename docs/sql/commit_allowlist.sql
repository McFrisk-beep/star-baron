-- commit_allowlist.sql — Tier 1: make app_commit fail CLOSED.
-- Supersedes the app_commit_lite in commit_lite.sql (now a stub) — apply THIS
-- file last; it carries the only current definition of the wrapper.
--
-- THE PROBLEM
-- app_commit's merge begins with `merged := p_state` — the client's blob — and
-- then overwrites ~28 server-owned keys from the stored row. So the rule is
-- "trusted unless it's on the list", and the list is one a human has to
-- remember to extend. Every new save slice a feature adds is trusted by
-- default until somebody notices. That is the wrong way round for a default to
-- fail, and it is a bug of omission waiting to happen rather than a bug you can
-- see in a diff.
--
-- THE FIX
-- app._client_owned(p_state) reduces the upload to an explicit allowlist before
-- app_commit ever sees it. A key the client invents — or one a future feature
-- adds and nobody classifies — simply never arrives. Same protections as
-- before for the keys already on the server-forced list; what changes is that
-- the DEFAULT is now "dropped" instead of "accepted".
--
-- WHY A FILTER AND NOT A REWRITE
-- app_commit reads exactly five keys off the client (credits, ships,
-- industries, expeditions, extractors — verified against the live definition
-- with a regexp over pg_get_functiondef); everything else it either overwrites
-- from the server row or passes through untouched. So filtering the input is
-- sufficient, and it leaves the 200-line merge/protection body alone: no risk
-- of a transcription error in a function that owns everybody's save, and no
-- copy that can drift when a later migration replaces app_commit again.
--
-- Prereq: docs/sql/phase1_players.sql (app_commit).
-- Apply: paste into the Supabase SQL editor and run once. Idempotent.
--
-- Client: js/cloud.js sends exactly this list (Cloud.WIRE_KEYS) and
-- tools/check_cloud_egress.js asserts the two never drift apart.

-- The allowlist. Two groups, and the distinction matters when editing it:
--
--   1. MERGE INPUTS — app_commit genuinely reads these off the client to do its
--      job: the credits ratchet (client wins only when LOWER), ship fitment,
--      and the industry/expedition/extractor merges. Removing one from this
--      list silently breaks a merge, so don't.
--
--   2. CLIENT-OWNED — no server-side representation today. The server stores
--      them as a courtesy so the save survives a device change.
--
-- Anything absent from both groups is server-owned: app_commit overwrites it
-- from the stored row regardless, so there is no reason to ship it up the wire
-- and every reason not to. lastSeenAt is also deliberately absent — the client
-- restamps it constantly (which made every payload unique and killed the
-- client's redundant-push suppression) and app._write_state stamps the server
-- clock over it on every commit anyway.
create or replace function app._client_owned(p_state jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
  from jsonb_each(coalesce(p_state, '{}'::jsonb)) as e(k, v)
  where k in (
    -- 1. merge inputs (app_commit reads these off p_state — verified)
    'credits', 'ships', 'industries', 'expeditions', 'extractors',
    -- 2. client-owned
    'hold', 'stationInv', 'shipments', '_haulingMigrated',
    'reports', 'orders', 'pendingHaulSettles', 'seq',
    -- craftedOnce passes the filter but app_commit_lite below SUBSTITUTES the
    -- stored value whenever a row exists, so the upload can never clear a burn
    -- mark. It stays on the wire so (a) a guest's locally-earned marks reach
    -- the bootstrap on their very first commit, and (b) a project running
    -- older SQL — where the row keeps whatever the client sends — does not
    -- have its burn list wiped by a client that stopped sending it.
    'craftedOnce',
    -- activeBoosts and knownRecipes stay client-owned — blackboxes and
    -- blueprints are minted client-side by the bazaar and the server has no
    -- record of them (js/economy.js _softSnap, js/bazaar.js:82), so forcing
    -- either from the server row would erase a paid-for box or a real unlock.
    -- They can only become server-owned once soft items reach the ledger.
    'activeBoosts', 'knownRecipes',
    'shipVariants', 'achievements', 'stats',
    'story', 'settings', 'rivals', 'rivalsMeta',
    'voySeenT', 'voyChecks',
    'v', 'appliedResetEpoch', 'cloudUserId',
    -- Lazily created, so absent from defaultState() and easy to miss:
    -- surveyRetry holds survey debriefs whose RPC dropped mid-flight.
    'surveyRetry',
    -- stations carries player-local money-adjacent state (unclaimed payouts,
    -- treasury ledger) with no verified server-side home yet. Stays on the wire
    -- until each field is confirmed recoverable from the station tables.
    'stations'
  );
$$;

-- The wrapper the client calls: filters the INPUT (allowlist above), enforces
-- the server-owned slices, and trims the OUTPUT echo.
--
-- SERVER-OWNED SLICES (Tier 1B)
-- craftedOnce gates one-of-a-kind recipes: app_craft_start refuses a recipe
-- already in the list, and app_craft_claim appends to it. While the client
-- supplied the list, deleting an entry re-opened a unique for a second craft.
-- Substituting the stored value here makes removal impossible once a row
-- exists — the list only ever grows, and only via a claim. (First-ever commit
-- has no row: the client's list passes through so a guest's locally-earned
-- marks survive sign-up. Seeding marks there only handicaps the seeder.)
--
-- The row is locked BEFORE the substitution and held for the transaction, so a
-- concurrent app_craft_claim cannot land between the read and app_commit's own
-- lock and have its burn mark overwritten by a stale list. app_commit's
-- app._lock_state re-acquires the same lock in the same transaction — a no-op.
--
-- SECURITY DEFINER because `for update` on public.players needs write
-- privilege the authenticated role deliberately does not have. The body
-- touches exactly one row, addressed by auth.uid(), and auth.uid() still
-- resolves here: it reads the request's JWT claims, which are a session
-- setting that SECURITY DEFINER does not disturb — the same reason app_commit
-- itself can be DEFINER.
create or replace function public.app_commit_lite(p_state jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  srv jsonb;
  inp jsonb;
  r   jsonb;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'error', 'not signed in');
  end if;

  select state into srv from public.players where user_id = uid for update;

  inp := app._client_owned(p_state);
  -- No row yet (first commit of a brand-new account): the client's list passes
  -- through to the bootstrap. Otherwise the stored list is the only authority.
  if srv is not null then
    inp := jsonb_set(inp, '{craftedOnce}', coalesce(srv -> 'craftedOnce', '[]'::jsonb));
  end if;

  r := public.app_commit(inp);

  if jsonb_typeof(r -> 'state') = 'object' then
    return jsonb_set(r, '{state}',
      (r -> 'state')
        - 'market'      -- prices/hist are pure functions of (seed, effects, now)
        - 'galaxy'      -- per-system flavour log; client-only, never sent up
        - 'stations'    -- shared, read via app_station_directory
        - 'story'       -- client-owned narrative progress
        - 'senate'      -- shared, read via world_senate / world_senate_result
        - 'stock'       -- shared, read via app_sector_stock
        - 'newswire');  -- shared, read via world_news
  end if;
  return r;             -- {ok:false, error:…} passes straight through
end;
$$;

revoke all on function app._client_owned(jsonb) from public, anon;
revoke all on function public.app_commit_lite(jsonb) from public, anon;
grant execute on function public.app_commit_lite(jsonb) to authenticated;
