-- crime_coefficient.sql — senate influence gets a price, a cap and a record
-- (High H10), and the crime coefficient it feeds.
--
-- THE HOLE: app_senate_influence (docs/sql/security_hardening.sql) validated
-- shape and clamped strength, but enforced none of the gameplay rules the
-- client honours. Any account could POST 24 rows per bill — including 24
-- `coerce` rows, which force a senator's vote outright — for FREE, at any Baron
-- Tier. ~72 forced weighted votes carries or kills any bill, and edicts hit
-- every player's economy. The client's costs and per-tier target caps were an
-- honour system.
--
-- THE FIX, three layers:
--   1. PRICE — the RPC debits credits server-side. It charges the cheapest
--      legitimate price for the action (base cost × the best relationship
--      discount × the lightest seat), because senator seat weight comes from
--      the procedural galaxy the server doesn't model. The honest client debits
--      the remainder locally (a decrease, which app_commit accepts), so a real
--      player still pays the full relationship/weight-scaled price and a
--      tampered one can no longer influence for nothing.
--   2. CAP — tier gates (lobby 1 / bribe 2 / coerce 3) and the client's
--      "1 + tier senators per bill" rule are enforced here, one row per target,
--      and the pushed strength is COMPUTED server-side (including the repeat-
--      lobby decay) instead of trusted from the request.
--   3. RECORD — bribery and coercion raise the caller's crime coefficient.
--      From 100 a coerced senator may refuse (and report you); from 200 the
--      chamber is closed to you entirely. The coefficient cools by 1 a day.
--
-- The coefficient itself is a server-owned slice: app_commit forces `crime` and
-- `crimeSeenAt` from the server row, so a save edit can't clear a record.
--
-- Apply AFTER merc_expiry.sql — this file re-declares app_commit (extending
-- that layer) and app.result_slice. Safe to re-run.
-- Mirrors js/data.js CRIMECFG + SENATECFG and js/crime.js — keep in lockstep.

-- ===========================================================================
-- crime coefficient helpers
-- ===========================================================================
create or replace function app._crime_start() returns numeric
language sql immutable as $$ select 50::numeric $$;
create or replace function app._crime_max() returns numeric
language sql immutable as $$ select 1000::numeric $$;
create or replace function app._crime_lockout() returns numeric
language sql immutable as $$ select 200::numeric $$;
create or replace function app._crime_watch() returns numeric
language sql immutable as $$ select 100::numeric $$;

create or replace function app._crime_value(p_state jsonb)
returns numeric
language sql immutable as $$
  select least(app._crime_max(), greatest(0,
    coalesce((p_state->>'crime')::numeric, app._crime_start())));
$$;

-- Cool the record by 1 per whole real day since crimeSeenAt, advancing the
-- stamp by exactly the days consumed — so this is idempotent however often
-- app_commit calls it. Mirrors js/crime.js decay().
create or replace function app._crime_decay(p_state jsonb, p_now_ms bigint)
returns jsonb
language plpgsql immutable as $$
declare
  day constant bigint := 86400000;
  crime numeric := app._crime_value(p_state);
  seen bigint := coalesce((p_state->>'crimeSeenAt')::bigint, p_now_ms);
  days bigint;
begin
  if seen > p_now_ms then seen := p_now_ms; end if;   -- clock skew
  days := (p_now_ms - seen) / day;
  if days > 0 then
    crime := greatest(0, crime - days);               -- decayPerDay = 1
    seen := seen + days * day;
  end if;
  return jsonb_set(jsonb_set(p_state, '{crime}', to_jsonb(crime)),
                   '{crimeSeenAt}', to_jsonb(seen));
end;
$$;

create or replace function app._crime_add(p_state jsonb, p_add numeric)
returns jsonb
language sql immutable as $$
  select jsonb_set(p_state, '{crime}', to_jsonb(
    least(app._crime_max(), greatest(0, app._crime_value(p_state) + coalesce(p_add, 0)))));
$$;

-- ===========================================================================
-- senate influence: server-side price, strength and caps
-- ===========================================================================
-- Cheapest legitimate price (SENATECFG base × 0.4 relationship floor × seat
-- weight 1). The client pays the rest of its own quote locally.
create or replace function app._influence_floor_cost(p_kind text)
returns bigint
language sql immutable as $$
  select case p_kind
    when 'lobby_fac' then 40000::bigint    -- 100000 × 0.4
    when 'bribe'     then 20000::bigint    --  50000 × 0.4 × weight 1
    when 'coerce'    then  8000::bigint    --  20000 × 0.4 × weight 1
    else 0::bigint end;
$$;

-- Exact push strength for this action — never the client's number.
-- lobby: lobbyFacStrength(0.8) × power(1 + tier×0.18) × lobbyDecay(0.55)^prior
-- bribe: bribeStrength(1.4) × 1 (client does not scale bribes by tier)
-- coerce: 0 — the row's `dir` carries the forced vote, not its strength.
create or replace function app._influence_strength(p_kind text, p_tier int, p_prior int)
returns double precision
language sql immutable as $$
  select case p_kind
    when 'lobby_fac' then 0.8 * (1 + greatest(0, coalesce(p_tier, 0)) * 0.18)
                          * power(0.55, greatest(0, coalesce(p_prior, 0)))
    when 'bribe' then 1.4
    else 0 end::double precision;
$$;

create or replace function app._influence_min_tier(p_kind text)
returns int
language sql immutable as $$
  select case p_kind when 'lobby_fac' then 1 when 'bribe' then 2 when 'coerce' then 3 else 99 end;
$$;

-- ===========================================================================
-- app_senate_influence — the only write path into world_senate_influence.
-- Signature unchanged so older clients keep working; p_strength is now IGNORED
-- (the server computes it) and kept only for call compatibility.
-- ===========================================================================
create or replace function public.app_senate_influence(
  p_bill_id text, p_kind text, p_target text, p_dir int, p_strength double precision
)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  uid uuid := auth.uid();
  now_ms bigint := app._now_ms();
  act text := coalesce(p_kind, '');
  tgt text := nullif(btrim(coalesce(p_target, '')), '');
  dir int := case when p_dir > 0 then 1 when p_dir < 0 then -1 else 0 end;
  st jsonb;
  tier int;
  credits numeric;
  crime numeric;
  cost bigint;
  strength double precision;
  bill_num bigint;
  votes_at timestamptz;
  row_cap constant int := 24;
  lobby_cap constant int := 8;
  existing int;
  worked int;
  max_targets int;
  fail_chance double precision := 0;
  refused boolean := false;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if act not in ('lobby_fac', 'bribe', 'coerce') then
    return jsonb_build_object('ok', false, 'error', 'invalid kind');
  end if;
  if tgt is null or length(tgt) > 64 then
    return jsonb_build_object('ok', false, 'error', 'invalid target');
  end if;
  if p_bill_id is null or length(p_bill_id) > 64 then
    return jsonb_build_object('ok', false, 'error', 'invalid bill');
  end if;
  -- Lobbying targets a faction bloc; bribes/coercion tgt a senator seat.
  if act = 'lobby_fac' then
    if tgt not in ('syndicate', 'mining_combine', 'free_trade', 'agri_collective') then
      return jsonb_build_object('ok', false, 'error', 'invalid target');
    end if;
    if dir = 0 then
      return jsonb_build_object('ok', false, 'error', 'declare a position first');
    end if;
  else
    if tgt !~ '^sen_[a-z0-9_]{1,56}$' then
      return jsonb_build_object('ok', false, 'error', 'invalid target');
    end if;
    if dir = 0 then
      return jsonb_build_object('ok', false, 'error', 'declare a position first');
    end if;
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

  -- Locks the caller's row for the rest of the transaction: the credit debit
  -- and the crime bump below can't interleave with a concurrent push.
  st := app._lock_state(now_ms);
  if st is null then
    return jsonb_build_object('ok', false, 'error', 'no player row');
  end if;
  st := app._crime_decay(st, now_ms);
  crime := app._crime_value(st);
  tier := coalesce((st->'prestige'->>'tier')::int, 0);
  credits := coalesce((st->>'credits')::numeric, 0);

  -- Barred: the chamber is closed to everything but reading the edicts.
  if crime >= app._crime_lockout() then
    perform app._write_state(st, now_ms);   -- keep the decayed record
    return jsonb_build_object('ok', false, 'error', 'senate_locked',
      'crime', crime, 'lockout', app._crime_lockout());
  end if;

  if tier < app._influence_min_tier(act) then
    return jsonb_build_object('ok', false, 'error', 'Baron Tier '
      || app._influence_min_tier(act) || ' required');
  end if;

  -- Rate limit: bound how many pushes one account can stack on one bill.
  select count(*) into existing
    from public.world_senate_influence w
   where w.user_id = uid and w.bill_id = p_bill_id;
  if existing >= row_cap then
    return jsonb_build_object('ok', false, 'error', 'influence limit reached for this bill');
  end if;

  if act = 'lobby_fac' then
    -- Repeat lobbies of one bloc sway less and less; cap the tail.
    -- Alias the table: `act` and `tgt` are also plpgsql variables here.
    select count(*) into existing
      from public.world_senate_influence w
     where w.user_id = uid and w.bill_id = p_bill_id
       and w.kind = 'lobby_fac' and w.target = tgt;
    if existing >= lobby_cap then
      return jsonb_build_object('ok', false, 'error', 'that bloc will not hear you again on this bill');
    end if;
    strength := app._influence_strength(act, tier, existing);
  else
    -- One senator, one working-over — and only 1 + tier of them per bill.
    if exists (
      select 1 from public.world_senate_influence w
       where w.user_id = uid and w.bill_id = p_bill_id
         and w.kind in ('bribe', 'coerce') and w.target = tgt
    ) then
      return jsonb_build_object('ok', false, 'error', 'that senator is already worked this session');
    end if;
    max_targets := 1 + greatest(0, tier);
    select count(distinct w.target) into worked
      from public.world_senate_influence w
     where w.user_id = uid and w.bill_id = p_bill_id and w.kind in ('bribe', 'coerce');
    if worked >= max_targets then
      return jsonb_build_object('ok', false, 'error',
        'only ' || max_targets || ' senator(s) per vote at your tier');
    end if;
    strength := app._influence_strength(act, tier, 0);
  end if;

  -- Price. The server takes the cheapest legitimate cost; the client debits the
  -- rest of its own (relationship- and seat-scaled) quote locally.
  cost := app._influence_floor_cost(act);
  if credits < cost then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
  end if;

  -- Coercion above the watch line can be refused — the senator reports the
  -- approach instead of folding. The attempt still costs and still counts.
  if act = 'coerce' and crime > app._crime_watch() then
    fail_chance := least(0.9, (crime - app._crime_watch()) / 100.0 * 0.35);
    refused := random() < fail_chance;
  end if;

  st := jsonb_set(st, '{credits}', to_jsonb(credits - cost));
  if act = 'bribe' then
    st := app._crime_add(st, 6);
  elsif act = 'coerce' then
    st := app._crime_add(st, 20);
  end if;                                   -- lobbying a bloc is legal: no gain
  perform app._write_state(st, now_ms);

  -- A refused coercion still books the attempt (dir 0 = no forced vote), so it
  -- burns the target slot and can't be retried on the same senator.
  insert into public.world_senate_influence(bill_id, user_id, kind, target, dir, strength)
    values (p_bill_id, uid, act, tgt,
            case when refused then 0 else dir end,
            case when refused then 0 else strength end);

  return jsonb_build_object(
    'ok', true,
    'refused', refused,
    'kind', act,
    'cost', cost,
    'strength', case when refused then 0 else strength end,
    'credits', (st->>'credits')::float8,
    'crime', app._crime_value(st),
    'lockout', app._crime_lockout()
  );
end;
$$;

revoke execute on function public.app_senate_influence(text, text, text, int, double precision) from public;
revoke execute on function public.app_senate_influence(text, text, text, int, double precision) from anon;
grant execute on function public.app_senate_influence(text, text, text, int, double precision) to authenticated;

-- ===========================================================================
-- result_slice — same as charter_rpcs.sql plus the crime record, so every RPC
-- response and app_pull carry the authoritative coefficient.
-- ===========================================================================
create or replace function app.result_slice(p_state jsonb)
returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'ok', true,
    'credits', (p_state->>'credits')::float8,
    'positions', coalesce(p_state->'positions', '{}'::jsonb),
    'avgCost', coalesce(p_state->'avgCost', '{}'::jsonb),
    'ships', coalesce(p_state->'ships', '[]'::jsonb),
    'mainShip', p_state->'mainShip',
    'missions', coalesce(p_state->'missions', '[]'::jsonb),
    'reports', coalesce(p_state->'reports', '[]'::jsonb),
    'items', coalesce(p_state->'items', '{}'::jsonb),
    'inventory', p_state->'inventory',
    'pendingContracts', coalesce(p_state->'pendingContracts', '[]'::jsonb),
    'bazaarBought', coalesce(p_state->'bazaarBought', '[]'::jsonb),
    'seq', coalesce((p_state->>'seq')::int, 1),
    'stats', p_state->'stats',
    'reputation', p_state->'reputation',
    'currentSystem', p_state->>'currentSystem',
    'travel', p_state->'travel',
    'unlockedSystems', p_state->'unlockedSystems',
    'prestige', coalesce(p_state->'prestige', '{"tier":0,"multiplier":1}'::jsonb),
    'routes', coalesce(p_state->'routes', '[]'::jsonb),
    'industries', coalesce(p_state->'industries', '[]'::jsonb),
    'expeditions', coalesce(p_state->'expeditions', '[]'::jsonb),
    'surveyed', coalesce(p_state->'surveyed', '{}'::jsonb),
    'listings', coalesce(p_state->'listings', '[]'::jsonb),
    'extractors', coalesce(p_state->'extractors', '{}'::jsonb),
    'components', coalesce(p_state->'components', '{}'::jsonb),
    'workshop', coalesce(p_state->'workshop', '{"upgrades":0,"queue":[]}'::jsonb),
    'knownRecipes', coalesce(p_state->'knownRecipes', '[]'::jsonb),
    'craftedOnce', coalesce(p_state->'craftedOnce', '[]'::jsonb),
    'workshopAdopt', p_state->'workshopAdopt',
    'charters', coalesce(p_state->'charters', '[]'::jsonb),
    'crime', app._crime_value(p_state),
    'crimeSeenAt', (p_state->>'crimeSeenAt')::bigint,
    'lastSeenAt', (p_state->>'lastSeenAt')::bigint
  );
$$;

-- ===========================================================================
-- app_commit — same as merc_expiry.sql (the last file to replace it, so this
-- extends that layer: fitment merge + workshop + charters + survey custody +
-- merc sweep) plus the server-owned crime record and its daily decay.
-- ===========================================================================
create or replace function public.app_commit(p_state jsonb)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  server jsonb;
  merged jsonb;
begin
  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'invalid state');
  end if;

  server := app._lock_state(now_ms);
  merged := p_state;

  -- Topology (Phase 1)
  merged := jsonb_set(merged, '{currentSystem}', server->'currentSystem');
  merged := jsonb_set(merged, '{travel}',
    case when app._in_transit(server) then server->'travel' else 'null'::jsonb end);
  merged := jsonb_set(merged, '{unlockedSystems}', coalesce(server->'unlockedSystems', '[]'::jsonb));

  -- Phase 2 owned slices. Ships: server owns the roster, client owns fitment
  -- (docs/sql/equip_persist.sql).
  merged := jsonb_set(merged, '{ships}', app._merge_ships(
    coalesce(server->'ships', '[]'::jsonb),
    coalesce(p_state->'ships', '[]'::jsonb),
    coalesce(server->'items', '{}'::jsonb)));
  merged := jsonb_set(merged, '{mainShip}', coalesce(server->'mainShip', '{"type":"pinnace"}'::jsonb));
  merged := jsonb_set(merged, '{missions}', coalesce(server->'missions', '[]'::jsonb));
  merged := jsonb_set(merged, '{items}', coalesce(server->'items', '{}'::jsonb));
  merged := jsonb_set(merged, '{inventory}', coalesce(server->'inventory', '{"capacity":6,"upgrades":0}'::jsonb));
  merged := jsonb_set(merged, '{pendingContracts}', coalesce(server->'pendingContracts', '[]'::jsonb));
  merged := jsonb_set(merged, '{bazaarBought}', coalesce(server->'bazaarBought', '[]'::jsonb));
  merged := jsonb_set(merged, '{reputation}', coalesce(server->'reputation', '{}'::jsonb));
  merged := jsonb_set(merged, '{bazaar}', coalesce(server->'bazaar',
    '{"mercs":[],"contracts":[],"accessories":[]}'::jsonb));

  -- Workshop: crafting is server-authoritative (docs/sql/workshop_craft.sql).
  merged := jsonb_set(merged, '{workshop}', coalesce(server->'workshop',
    '{"upgrades":0,"queue":[]}'::jsonb));
  if server ? 'workshopAdopt' then
    merged := jsonb_set(merged, '{workshopAdopt}', server->'workshopAdopt', true);
  else
    merged := merged - 'workshopAdopt';
  end if;

  -- Charters: dispatched/cancelled/resolved via app_charter_* (charter_rpcs.sql).
  merged := jsonb_set(merged, '{charters}', coalesce(server->'charters', '[]'::jsonb));

  -- Phase 3: economy + prestige + catch-up timers (server is source of truth)
  if coalesce((p_state->>'credits')::float8, 0) < coalesce((server->>'credits')::float8, 0) then
    merged := jsonb_set(merged, '{credits}', p_state->'credits');
  else
    merged := jsonb_set(merged, '{credits}', server->'credits');
  end if;
  merged := jsonb_set(merged, '{positions}', coalesce(server->'positions', '{}'::jsonb));
  merged := jsonb_set(merged, '{avgCost}', coalesce(server->'avgCost', '{}'::jsonb));
  merged := jsonb_set(merged, '{prestige}', coalesce(server->'prestige', '{"tier":0,"multiplier":1}'::jsonb));
  merged := jsonb_set(merged, '{listings}', coalesce(server->'listings', '[]'::jsonb));
  merged := jsonb_set(merged, '{surveyed}', coalesce(server->'surveyed', '{}'::jsonb));
  merged := jsonb_set(merged, '{routes}', coalesce(server->'routes', '[]'::jsonb));
  merged := jsonb_set(merged, '{industries}', app._merge_industries(
    coalesce(server->'industries', '[]'::jsonb),
    coalesce(p_state->'industries', '[]'::jsonb)));
  merged := jsonb_set(merged, '{expeditions}', app._merge_expeditions(
    coalesce(server->'expeditions', '[]'::jsonb),
    coalesce(p_state->'expeditions', '[]'::jsonb)));
  merged := jsonb_set(merged, '{extractors}', app._merge_extractors(
    coalesce(server->'extractors', '{}'::jsonb),
    coalesce(p_state->'extractors', '{}'::jsonb)));
  merged := jsonb_set(merged, '{components}', coalesce(server->'components', '{}'::jsonb));

  -- Crime coefficient: server-owned (this file). A save edit can't clear a
  -- record, and the 1/day cooling is applied on the server clock.
  merged := jsonb_set(merged, '{crime}',
    coalesce(server->'crime', to_jsonb(app._crime_start())));
  merged := jsonb_set(merged, '{crimeSeenAt}',
    coalesce(server->'crimeSeenAt', to_jsonb(now_ms)));
  merged := app._crime_decay(merged, now_ms);

  if coalesce((server->'stats'->>'trades')::int, 0) > coalesce((merged->'stats'->>'trades')::int, 0) then
    merged := jsonb_set(merged, '{stats,trades}', server->'stats'->'trades');
  end if;
  if coalesce((server->'stats'->>'biggestTrade')::float8, 0)
     > coalesce((merged->'stats'->>'biggestTrade')::float8, 0) then
    merged := jsonb_set(merged, '{stats,biggestTrade}', server->'stats'->'biggestTrade');
  end if;
  if coalesce((server->'stats'->>'contractsDone')::int, 0)
     > coalesce((merged->'stats'->>'contractsDone')::int, 0) then
    merged := jsonb_set(merged, '{stats,contractsDone}', server->'stats'->'contractsDone');
  end if;
  if coalesce((server->'stats'->>'peakNetWorth')::float8, 0)
     > coalesce((merged->'stats'->>'peakNetWorth')::float8, 0) then
    merged := jsonb_set(merged, '{stats,peakNetWorth}', server->'stats'->'peakNetWorth');
  end if;

  -- Expired mercenaries leave the roster (merc_expiry.sql).
  merged := app._prune_mercs(merged, now_ms);
  -- Survey custody: expeditions and ship statuses agree (survey_custody.sql).
  merged := app._survey_custody(merged);

  perform app._write_state(merged, now_ms);
  return jsonb_build_object('ok', true, 'state', merged);
end;
$$;

grant execute on function public.app_commit(jsonb) to authenticated;
