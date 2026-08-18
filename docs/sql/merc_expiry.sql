-- merc_expiry.sql — expired mercenaries leave the roster server-side (High H9).
--
-- Fleet.pruneMercs deletes an expired merc LOCALLY, but nothing ever pruned the
-- server row: app_commit force-restores `ships` from the server, so the merc
-- resurrected on the very next slice. Worse, app.fleet_cap checks count those
-- zombies, so after a few hires every purchase failed with "Too many ships."
-- against a fleet the player could not see.
--
-- app._prune_mercs mirrors the client rule exactly (js/fleet.js pruneMercs):
-- drop a ship that is a mercenary AND idle AND has an expiresAt at or before
-- now. A merc still out on a mission/charter keeps its contract until the hull
-- comes home — the sweep catches it on a later commit.
--
-- Runs inside app_commit (every autosave), so the roster the fleet-cap checks
-- read is already clean. Fitted gear is left in the item pool: accessories are
-- owned separately and a merc's slots are cleared with the hull.
--
-- Apply AFTER survey_custody.sql — this file re-declares app_commit extending
-- that layer (fitment merge + workshop + charters + survey custody). Safe to
-- re-run.

create or replace function app._prune_mercs(p_state jsonb, p_now_ms bigint)
returns jsonb
language plpgsql immutable as $$
declare
  kept jsonb := '[]'::jsonb;
  sh jsonb;
  exp_ms bigint;
begin
  for sh in select value from jsonb_array_elements(coalesce(p_state->'ships', '[]'::jsonb)) loop
    exp_ms := nullif(sh->>'expiresAt', '')::bigint;
    if coalesce((sh->>'mercenary')::boolean, false)
       and coalesce(sh->>'status', 'idle') = 'idle'
       and exp_ms is not null
       and exp_ms <= p_now_ms then
      continue;   -- contract ran out and the hull is home — release it
    end if;
    kept := kept || jsonb_build_array(sh);
  end loop;
  return jsonb_set(p_state, '{ships}', kept);
end;
$$;

-- ===========================================================================
-- app_commit — same as survey_custody.sql (the last file to replace it, so this
-- extends that layer: fitment merge + workshop + charters + survey custody)
-- plus the expired-mercenary sweep.
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

  -- Expired mercenaries leave the roster (this file) BEFORE survey custody, so
  -- an expedition that referenced a released merc is closed as lost contact.
  merged := app._prune_mercs(merged, now_ms);

  -- Survey custody: expeditions and ship statuses agree (survey_custody.sql).
  merged := app._survey_custody(merged);

  perform app._write_state(merged, now_ms);
  return jsonb_build_object('ok', true, 'state', merged);
end;
$$;

grant execute on function public.app_commit(jsonb) to authenticated;
