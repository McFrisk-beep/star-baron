-- Security hardening — closes two gaps found in the server-authoritative review.
-- Idempotent: safe to paste into the Supabase SQL Editor and re-run. Requires the
-- Phase 1 (docs/sql/phase1_players.sql) and Senate (docs/SENATE_SETUP.md) SQL to
-- already be installed.
--
--   HIGH   — legacy `saves` migration let a brand-new account inject a forged
--            balance: the client could write any JSON to its own `saves` row
--            (client RLS) and `app_bootstrap` copied it verbatim into the
--            authoritative `players.state`. Fix: lock `saves` against ALL client
--            writes (so no forged row can be created) + clamp the migrated
--            credit balance as defense in depth for pre-existing rows.
--   MEDIUM — `world_senate_influence` accepted unbounded / unvalidated influence
--            straight from the client (any signed-in user could POST
--            strength:1e9 or thousands of rows and swing the SHARED senate vote).
--            Fix: route inserts through a SECURITY DEFINER RPC that validates and
--            clamps them + drop the direct client insert policy.

-- ===========================================================================
-- HIGH — lock the legacy `saves` table (read-own only; no client writes)
-- ===========================================================================
-- `players` (server-authoritative) supersedes `saves`. Only app_bootstrap (a
-- SECURITY DEFINER fn) still READS `saves`, one time, to migrate a legacy row.
-- Clients keep read-own for the old fallback path but can no longer create,
-- modify, or delete a `saves` row — so the injection vector is gone for every
-- account that has not already been migrated.
drop policy if exists "insert own save" on public.saves;
drop policy if exists "update own save" on public.saves;
drop policy if exists "delete own save" on public.saves;
-- (kept) "read own save" — SELECT using (auth.uid() = user_id)

-- ---------------------------------------------------------------------------
-- HIGH (defense in depth) — clamp migrated credits in app_bootstrap
-- ---------------------------------------------------------------------------
-- A legacy save is pre-authoritative data (the old client trusted it fully), so
-- never let its credit magnitude through unbounded. 100M is far above any
-- plausible early-game balance yet neutralises absurd forged values. New
-- accounts (no `saves` row) are unaffected — they boot from _default_state().
create or replace function public.app_bootstrap()
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  uid uuid := auth.uid();
  st jsonb;
  legacy jsonb;
  now_ms bigint := app._now_ms();
  migrated boolean := false;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select state into st from public.players where user_id = uid for update;
  if st is null then
    -- one-time migrate from the local-first `saves` table if present
    begin
      select data into legacy from public.saves where user_id = uid;
    exception when undefined_table then
      legacy := null;
    end;
    if legacy is null or legacy = '{}'::jsonb then
      st := app._default_state();
    else
      st := legacy;
      migrated := true;
    end if;
    -- ensure required economy keys exist
    st := coalesce(st, app._default_state());
    if st->'credits' is null then st := jsonb_set(st, '{credits}', '1500'); end if;
    if st->'positions' is null then st := jsonb_set(st, '{positions}', '{}'::jsonb); end if;
    if st->'avgCost' is null then st := jsonb_set(st, '{avgCost}', '{}'::jsonb); end if;
    if st->'currentSystem' is null then st := jsonb_set(st, '{currentSystem}', '"navos"'); end if;
    if st->'unlockedSystems' is null then
      st := jsonb_set(st, '{unlockedSystems}', '["navos","korrin","velm"]'::jsonb);
    end if;
    if st->'reputation' is null then
      st := jsonb_set(st, '{reputation}', app._default_state()->'reputation');
    end if;
    if st->'prestige' is null then
      st := jsonb_set(st, '{prestige}', '{"tier":0,"multiplier":1.0}'::jsonb);
    end if;
    if st->'stats' is null then
      st := jsonb_set(st, '{stats}', app._default_state()->'stats');
    end if;
    -- Security: a migrated legacy save is untrusted client data — clamp its
    -- credit balance so a forged `saves` row can't mint a fortune on first boot.
    if migrated and coalesce((st->>'credits')::float8, 0) > 100000000 then
      st := jsonb_set(st, '{credits}', '100000000');
    end if;
    st := jsonb_set(st, '{lastSeenAt}', to_jsonb(now_ms));
    insert into public.players(user_id, state, updated_at) values (uid, st, now());
  end if;

  st := app._arrive_if_due(st, now_ms);
  update public.players set state = st, updated_at = now() where user_id = uid;
  return st;
end;
$$;

grant execute on function public.app_bootstrap() to authenticated;

-- ===========================================================================
-- MEDIUM — authoritative, bounded senate influence
-- ===========================================================================
-- Every client submission now goes through this RPC, which:
--   • requires a signed-in user (user_id is server-stamped, never client-set),
--   • whitelists kind ∈ {lobby_fac, bribe, coerce} and clamps dir ∈ {-1,0,1},
--   • bounds target to a short id,
--   • CLAMPS strength to legit gameplay bounds (max legit single push is
--     lobbyFacStrength·maxPower ≈ 0.8·2.08 ≈ 1.66; ceiling 3.0 leaves headroom
--     for tuning while blocking strength:1e9),
--   • RATE-LIMITS to a generous number of rows per (user, bill) so one account
--     can't spam thousands of pushes (a real player makes well under this),
--   • refuses to influence a bill whose shared vote has already closed.
-- Result: a signed-in account can contribute at most one legitimate player's
-- worth of influence to a shared vote — it can no longer swing it single-handed.
create or replace function public.app_senate_influence(
  p_bill_id text, p_kind text, p_target text, p_dir int, p_strength double precision
)
returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := auth.uid();
  kind text := coalesce(p_kind, '');
  target text := nullif(btrim(coalesce(p_target, '')), '');
  dir int := case when p_dir > 0 then 1 when p_dir < 0 then -1 else 0 end;
  strength double precision := greatest(0, least(coalesce(p_strength, 0), 3.0));
  bill_num bigint;
  votes_at timestamptz;
  row_cap constant int := 24;
  existing int;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if kind not in ('lobby_fac', 'bribe', 'coerce') then
    return jsonb_build_object('ok', false, 'error', 'invalid kind');
  end if;
  if target is null or length(target) > 64 then
    return jsonb_build_object('ok', false, 'error', 'invalid target');
  end if;
  if p_bill_id is null or length(p_bill_id) > 64 then
    return jsonb_build_object('ok', false, 'error', 'invalid bill');
  end if;

  -- Reject influence on a shared bill whose vote window has already closed.
  -- Shared bill ids look like 'wb<n>' where <n> is the world_senate row id.
  begin
    bill_num := nullif(regexp_replace(p_bill_id, '\D', '', 'g'), '')::bigint;
  exception when others then
    bill_num := null;
  end;
  if bill_num is not null then
    select ws.votes_at into votes_at from public.world_senate ws where ws.id = bill_num;
    if votes_at is not null and now() >= votes_at then
      return jsonb_build_object('ok', false, 'error', 'voting closed');
    end if;
  end if;

  -- Rate limit: bound how many pushes one account can stack on one bill.
  select count(*) into existing
    from public.world_senate_influence
   where user_id = uid and bill_id = p_bill_id;
  if existing >= row_cap then
    return jsonb_build_object('ok', false, 'error', 'influence limit reached for this bill');
  end if;

  insert into public.world_senate_influence(bill_id, user_id, kind, target, dir, strength)
    values (p_bill_id, uid, kind, target, dir, strength);

  return jsonb_build_object('ok', true);
end;
$$;

-- The RPC (running as owner) is now the ONLY write path; drop the direct policy.
drop policy if exists "insert own influence" on public.world_senate_influence;

-- Influence strictly requires a signed-in user — keep anon off (the fn also
-- raises 'not authenticated' internally, so this is defense in depth).
revoke execute on function public.app_senate_influence(text, text, text, int, double precision) from public;
revoke execute on function public.app_senate_influence(text, text, text, int, double precision) from anon;
grant execute on function public.app_senate_influence(text, text, text, int, double precision) to authenticated;
