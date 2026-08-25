-- ===========================================================================
-- equip_persist.sql — make ship accessories SURVIVE A RELOAD.
--
-- Bug: equipping gear is a client-side action (no RPC — Fleet.equip just pushes
-- the item uid onto ship.accessories). app_commit forced the whole `ships` array
-- from the server row, so the accessories array was discarded on every autosave
-- and the players row kept `accessories: []` forever. Economy._restoreEquip
-- patched it back IN MEMORY, so the equip looked fine until the next reload —
-- when app_bootstrap returned the server row and the gear popped back into
-- inventory.
--
-- Fix: app_commit now merges ships the same way it already merges extractors
-- (see app._merge_extractors): the server keeps the roster and every ship field
-- it owns (uid/type/cls/name/status/dmg/mercenary/expiresAt/retrieveCost), and
-- ONLY the fitment array comes from the client — validated so it can't be used
-- to forge stats.
--
-- Apply: paste this whole file into the Supabase SQL editor AFTER
-- docs/sql/phase3_pull_prestige.sql. Safe to re-run (all create-or-replace).
-- ===========================================================================

-- Accessory slots per hull. Keep in lockstep with SHIP_CATALOG in js/data.js —
-- tools/check_equip_persist.js asserts this table matches the catalog exactly.
-- Regenerate with `node tools/sql/gen_craft_fixtures.js slots`. A hull missing
-- here silently falls back to 2 slots and truncates its fitment on commit.
-- Mains (s.mainShip) never carry accessories, so only fleet hulls are listed;
-- the fallback of 2 mirrors the client's `def.slots || 2`.
create or replace function app._ship_slots(p_type text)
returns int
language sql immutable as $$
  select coalesce((
    select t.slots from (values
      ('mule', 2), ('clipper', 2), ('drift', 2), ('tanker', 3), ('bulk', 3),
      ('ore_mule', 3), ('leviathan', 3), ('craft_courier', 3), ('craft_freighter', 4), ('void_caravan', 4),
      ('argent_ark', 5), ('gunboat', 2), ('corvette', 2), ('destroyer', 3), ('frigate', 3),
      ('cruiser', 4), ('carrier', 4), ('battleship', 4), ('craft_corvette', 3), ('craft_frigate', 3),
      ('craft_cruiser', 4), ('last_aegis', 5), ('probe_skiff', 3), ('survey_cutter', 3), ('deep_mapper', 4),
      ('void_cartograph', 4), ('craft_probe', 3), ('craft_pathfinder', 4), ('oracle_lens', 5),
      ('prospector', 2), ('rock_hopper', 3), ('core_driller', 3), ('belt_leviathan', 4)
    ) as t(id, slots) where t.id = p_type
  ), 2);
$$;

-- Merge the client's fitment into the server's ship roster.
--
-- Server wins on everything it owns; the client contributes only `accessories`,
-- and every uid is validated before it is kept:
--   * must exist in the server's items pool  → can't fit gear you don't own
--   * de-duplicated within a ship            → can't stack one item for 2x stats
--   * claimed globally, first ship wins      → can't clone one item onto N ships
--   * truncated to the hull's slot count     → can't exceed the hull's fitment
-- A client ship the server doesn't know is dropped (roster stays server-owned),
-- and an EMPTY client array is honoured so an unequip actually persists.
--
-- No idle-status gate: app_pull's mission/route math ignores accessories
-- entirely (see app._ship_cargo), so re-fitting a busy ship buys no advantage.
-- A uid that is both equipped and listed self-heals — once the listing resolver
-- deletes the item, the stale uid fails the items-pool check on the next commit.
create or replace function app._merge_ships(p_server jsonb, p_client jsonb, p_items jsonb)
returns jsonb
language plpgsql immutable as $$
declare
  out_ships jsonb := '[]'::jsonb;
  claimed   jsonb := '{}'::jsonb;   -- item uid -> true, across the whole fleet
  items     jsonb := coalesce(p_items, '{}'::jsonb);
  sv jsonb;
  cv jsonb;
  acc jsonb;
  keep jsonb;
  slots int;
  uid text;
begin
  for sv in select value from jsonb_array_elements(coalesce(p_server, '[]'::jsonb)) loop
    cv := null;
    select value into cv
      from jsonb_array_elements(coalesce(p_client, '[]'::jsonb)) x(value)
      where x.value->>'uid' = sv->>'uid'
      limit 1;

    if cv is not null and jsonb_typeof(cv->'accessories') = 'array' then
      acc := cv->'accessories';                      -- player's live fitment
    elsif jsonb_typeof(sv->'accessories') = 'array' then
      acc := sv->'accessories';                      -- no client copy → keep stored
    else
      acc := '[]'::jsonb;
    end if;

    slots := app._ship_slots(sv->>'type');
    keep := '[]'::jsonb;
    for uid in select value from jsonb_array_elements_text(acc) loop
      exit when jsonb_array_length(keep) >= slots;
      if items ? uid and not (claimed ? uid) then
        keep := keep || jsonb_build_array(to_jsonb(uid));
        claimed := jsonb_set(claimed, array[uid], 'true'::jsonb, true);
      end if;
    end loop;

    out_ships := out_ships || jsonb_build_array(jsonb_set(sv, '{accessories}', keep));
  end loop;
  return out_ships;
end;
$$;

-- ===========================================================================
-- app_commit — identical to docs/sql/phase3_pull_prestige.sql except that
-- `ships` now goes through app._merge_ships so fitment persists.
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

  -- Phase 2 owned slices. Ships: server owns the roster, client owns fitment.
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

  -- Phase 3: economy + prestige + catch-up timers (server is source of truth)
  -- Credits: accept client value only when LOWER (permit spends, repairs, etc.);
  -- never accept an increase — soft income must come from app_pull / trade RPCs.
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
  -- Routes are created/stopped via app_route_start / app_route_stop (they set
  -- ship 'trading' status server-side), so routes are fully server-owned — the
  -- client can neither add a route nor reuse trading ships across forged routes.
  merged := jsonb_set(merged, '{routes}', coalesce(server->'routes', '[]'::jsonb));
  -- Industries/expeditions keep the client-setup merge (no build RPC yet); their
  -- production is bounded server-side in app_pull (see _catchup_industries).
  merged := jsonb_set(merged, '{industries}', app._merge_industries(
    coalesce(server->'industries', '[]'::jsonb),
    coalesce(p_state->'industries', '[]'::jsonb)));
  merged := jsonb_set(merged, '{expeditions}', app._merge_expeditions(
    coalesce(server->'expeditions', '[]'::jsonb),
    coalesce(p_state->'expeditions', '[]'::jsonb)));
  -- Extractors/components are bought via app_buy_extractor / app_buy_component
  -- (server-authored stats), so the component pool is forced from the server and
  -- the extractor pool keeps server type/scope while accepting the client's
  -- component-attachment array (validated at production). A forged extractor
  -- (not server-owned) is dropped; a forged component uid is ignored on pull.
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

  perform app._write_state(merged, now_ms);
  return jsonb_build_object('ok', true, 'state', merged);
end;
$$;

grant execute on function public.app_commit(jsonb) to authenticated;
