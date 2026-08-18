-- survey_custody.sql — survey ship status becomes server-owned (High H6).
--
-- Dispatching a survey (js/expeditions.js start) is client-side setup: the new
-- expedition merges into the server row via app_commit, but the hull it locks
-- stayed 'idle' on the server. Every RPC that checks ship status (missions,
-- routes, charters, sell) therefore saw a free hull — a second tab or a
-- tampered client could sell the ship mid-survey (orphaning the expedition into
-- the lost-contact loop) or launch it on a mission while it was "away".
--
-- app._survey_custody runs inside app_commit, after the ships/expeditions
-- merges, and makes the two slices agree:
--   * every kept expedition claims its hull: 'surveying' while under way,
--     'debrief' once parked (first claim wins — duplicate/forged expeditions
--     that reference a missing, mercenary or otherwise-busy hull are dropped);
--   * a hull stamped 'surveying'/'debrief' that no expedition references any
--     more is released to 'idle' — this also un-bricks ships stranded at
--     'debrief' by the old dropped-packet bug (High H7).
--
-- The client can still abandon a survey by omitting the expedition from its
-- commit (that only frees its own hull), but it can no longer double-book one.
--
-- Apply AFTER charter_rpcs.sql — this file re-declares app_commit extending
-- that layer (fitment + workshop + charters) with the custody pass. Safe to
-- re-run.

create or replace function app._survey_custody(p_state jsonb)
returns jsonb
language plpgsql immutable as $$
declare
  st jsonb := p_state;
  ships jsonb := coalesce(st->'ships', '[]'::jsonb);
  kept jsonb := '[]'::jsonb;
  out_ships jsonb := '[]'::jsonb;
  claimed jsonb := '{}'::jsonb;   -- shipUid -> status to stamp
  exp jsonb;
  sh jsonb;
  uid text;
  status text;
begin
  -- Pass 1: validate expeditions against the (server-owned) roster.
  for exp in select value from jsonb_array_elements(coalesce(st->'expeditions', '[]'::jsonb)) loop
    if coalesce((exp->>'resolved')::boolean, false) then
      continue;  -- drop resolved leftovers
    end if;
    uid := exp->>'shipUid';
    select value into sh from jsonb_array_elements(ships) x(value)
      where x.value->>'uid' = uid limit 1;
    if sh is null then
      -- Hull gone: keep the expedition — app_pull's catch-up closes it as
      -- lost contact; dropping it here would skip that report.
      kept := kept || jsonb_build_array(exp);
      continue;
    end if;
    if claimed ? uid then
      continue;  -- hull already claimed by an earlier expedition — drop dupe
    end if;
    status := coalesce(sh->>'status', 'idle');
    if coalesce((sh->>'mercenary')::boolean, false)
       or status not in ('idle', 'surveying', 'debrief') then
      continue;  -- busy / merc hull — forged or stale entry, drop
    end if;
    claimed := jsonb_set(claimed, array[uid],
      case when coalesce((exp->>'debrief')::boolean, false)
        then '"debrief"'::jsonb else '"surveying"'::jsonb end);
    kept := kept || jsonb_build_array(exp);
  end loop;

  -- Pass 2: stamp claimed hulls; release orphaned survey statuses.
  for sh in select value from jsonb_array_elements(ships) loop
    uid := sh->>'uid';
    if claimed ? uid then
      sh := jsonb_set(sh, '{status}', claimed->uid);
    elsif coalesce(sh->>'status', '') in ('surveying', 'debrief') then
      sh := jsonb_set(sh, '{status}', '"idle"');
    end if;
    out_ships := out_ships || jsonb_build_array(sh);
  end loop;

  st := jsonb_set(st, '{ships}', out_ships);
  st := jsonb_set(st, '{expeditions}', kept);
  return st;
end;
$$;

-- ===========================================================================
-- app_commit — same as charter_rpcs.sql (the last file to replace it, so this
-- extends that layer: fitment merge + workshop + charters) plus the survey
-- custody pass just before the write.
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

  -- Charters: dispatched/cancelled/resolved via app_charter_* (charter_rpcs.sql),
  -- so the rows are server-owned — a forged row can't ride in on the autosave.
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

  -- Survey custody: expeditions and ship statuses agree (this file).
  merged := app._survey_custody(merged);

  perform app._write_state(merged, now_ms);
  return jsonb_build_object('ok', true, 'state', merged);
end;
$$;

grant execute on function public.app_commit(jsonb) to authenticated;
