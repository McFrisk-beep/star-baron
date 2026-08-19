-- save_hygiene.sql — three low-severity server-side fixes from the systems audit.
--
--   L2  Inventory capacity: the server still carries the pre-hauling default of
--       6 slots (+10 per Inventory Bay upgrade) and counts EVERY item against
--       it, equipped accessories included, while the client counts docked-bay
--       slots against a floor of 50 (js/assets.js bayCapacityFloor). A signed-in
--       player with six items got "Inventory full." on accessory buys and gear
--       crafts while the bay UI read 8/50 — with nothing on screen to explain
--       it. app_commit now normalizes inventory.capacity to the same floor the
--       client uses, and the two capacity gates count unequipped, unlisted
--       items so both sides mean the same thing by "inventory".
--
--   L4  app._merge_industries adopted a client industry row verbatim — nextAt
--       included — whenever extractorUid or commodity changed. A tampered
--       client could set nextAt=0, toggle the extractor uid and have
--       _catchup_industries bank the full min(8) cycles at no cost basis, once
--       per pull. The adopted nextAt is now floored at now + the shortest
--       possible cycle, which is a no-op for an honest install.
--
--   L9  bazaarBought grew by one string per lifetime purchase, on the client
--       and the server, and rode inside every 10s app_commit. Marks are pruned
--       once their shelf epoch can no longer regenerate the offer. Mirrors
--       Bazaar.boughtLive in js/bazaar.js.
--
-- Paste order: after docs/sql/crime_coefficient.sql (step 13 in
-- docs/PHASE3_SETUP.md) — it re-declares app_commit, carrying that file's layer
-- (fitment + workshop + charters + survey custody + merc sweep + crime record)
-- forward unchanged. Safe to re-run.
--
-- Checked by tools/check_low_priority.js.

-- ===========================================================================
-- L2 — one definition of "inventory" for both sides
-- ===========================================================================

-- The client's station-bay floor: STATION_BAY_BASE (50) plus
-- BAZAARCFG.inventoryUpgradeStep (10) per purchased upgrade. `greatest` keeps
-- any larger legacy value, exactly as js/assets.js ensureBayCapacity does.
create or replace function app._bay_capacity(p_state jsonb)
returns int
language sql immutable as $$
  select greatest(
    coalesce((p_state->'inventory'->>'capacity')::int, 0),
    50 + 10 * greatest(coalesce((p_state->'inventory'->>'upgrades')::int, 0), 0));
$$;

-- Items that occupy an inventory slot: everything in `items` that isn't bolted
-- to a hull or sitting on the resale board. Mains never carry accessories
-- (see docs/sql/equip_persist.sql), so only fleet hulls are scanned.
create or replace function app._inventory_used(p_state jsonb)
returns int
language sql immutable as $$
  select count(*)::int
    from jsonb_object_keys(coalesce(p_state->'items', '{}'::jsonb)) as k(uid)
   where not exists (
           select 1 from jsonb_array_elements(coalesce(p_state->'ships', '[]'::jsonb)) as s(value)
            where (case when jsonb_typeof(s.value->'accessories') = 'array'
                        then s.value->'accessories' else '[]'::jsonb end) ? k.uid)
     and not exists (
           select 1 from jsonb_array_elements(coalesce(p_state->'listings', '[]'::jsonb)) as l(value)
            where l.value->>'itemUid' = k.uid);
$$;

create or replace function app._normalize_inventory(p_state jsonb)
returns jsonb
language sql immutable as $$
  select jsonb_set(p_state, '{inventory}',
    jsonb_set(
      case when jsonb_typeof(p_state->'inventory') = 'object'
           then p_state->'inventory' else '{"capacity":6,"upgrades":0}'::jsonb end,
      '{capacity}', to_jsonb(app._bay_capacity(p_state))));
$$;

-- ===========================================================================
-- L9 — shed purchase marks whose shelf epoch is gone
-- ===========================================================================

-- Seeded offer ids are `{kind}-{epoch}-{slot}` and each kind rides one clock:
-- bb/bp the 24h slow shelf, sy the 5min shipyard, everything else the 60s
-- board (offers live two epochs). Anything that doesn't parse is kept — this
-- only sheds what it can positively date. Mirrors Bazaar.boughtLive.
create or replace function app._bought_live(p_id text, p_now_ms bigint)
returns boolean
language plpgsql immutable as $$
declare
  m text[];
  kind text;
  ep bigint;
begin
  m := regexp_match(coalesce(p_id, ''), '^([a-z]{2})-([0-9]+)-[0-9]+$');
  if m is null then return true; end if;
  kind := m[1];
  ep := m[2]::bigint;
  if kind in ('bb', 'bp') then
    return ep >= greatest(0, p_now_ms) / 86400000;
  elsif kind = 'sy' then
    return ep >= greatest(0, p_now_ms) / 300000;
  elsif kind in ('mc', 'ac', 'ct', 'ex', 'cp', 'fg') then
    return ep >= (greatest(0, p_now_ms) / 60000) - 2;
  end if;
  return true;
end;
$$;

create or replace function app._prune_bazaar_bought(p_state jsonb, p_now_ms bigint)
returns jsonb
language sql immutable as $$
  select jsonb_set(p_state, '{bazaarBought}', coalesce((
    select jsonb_agg(x.value)
      from jsonb_array_elements_text(
             case when jsonb_typeof(p_state->'bazaarBought') = 'array'
                  then p_state->'bazaarBought' else '[]'::jsonb end) x(value)
     where app._bought_live(x.value, p_now_ms)
  ), '[]'::jsonb));
$$;

-- ===========================================================================
-- L4 — a client-authored nextAt can't backdate a fresh industry
-- ===========================================================================

-- The shortest cycle the server will ever run is 12h × the 0.4 speed-bonus
-- floor (_catchup_industries in phase3_pull_prestige.sql). Flooring an adopted
-- timer there can never delay an honest install — its nextAt is already at
-- least now + one full cycle — but it stops a forged nextAt=0 from banking the
-- full min(8) cycles on the very next pull, repeatable every pull.
create or replace function app._clamp_industry_next(p_ind jsonb, p_now_ms bigint)
returns jsonb
language sql immutable as $$
  select case
    when jsonb_typeof(p_ind) <> 'object' or p_ind->>'nextAt' is null then p_ind
    else jsonb_set(p_ind, '{nextAt}',
           to_jsonb(greatest((p_ind->>'nextAt')::bigint, p_now_ms + 17280000)))
  end;
$$;

-- Same body as docs/sql/phase3_pull_prestige.sql, except every industry row
-- adopted from the client — the "fresh install/change" branch and the
-- client-only rows in the second loop — has its nextAt clamped. `stable`
-- rather than `immutable`, for the clock read.
create or replace function app._merge_industries(p_server jsonb, p_client jsonb)
returns jsonb
language plpgsql stable as $$
declare
  out jsonb := '[]'::jsonb;
  s jsonb;
  c jsonb;
  now_ms bigint := app._now_ms();
begin
  for s in select value from jsonb_array_elements(coalesce(p_server, '[]'::jsonb)) loop
    if exists (
      select 1 from jsonb_array_elements(coalesce(p_client, '[]'::jsonb)) c(value)
      where c.value->>'id' = s->>'id'
    ) then
      select value into c from jsonb_array_elements(p_client) x(value)
        where x.value->>'id' = s->>'id' limit 1;
      -- Server nextAt wins; accept extractor/commodity/suit/planetType/faction from client setup
      if c->>'extractorUid' is distinct from s->>'extractorUid'
         or c->>'commodity' is distinct from s->>'commodity' then
        -- Fresh install/change — adopt the client row, but never its clock.
        s := app._clamp_industry_next(c, now_ms);
      else
        s := jsonb_set(s, '{extractorUid}', coalesce(c->'extractorUid', 'null'::jsonb));
        s := jsonb_set(s, '{commodity}', coalesce(c->'commodity', 'null'::jsonb));
        s := jsonb_set(s, '{cat}', coalesce(c->'cat', 'null'::jsonb));
        if c->>'planetType' is not null then
          s := jsonb_set(s, '{planetType}', c->'planetType');
        end if;
        if c->>'suit' is not null then
          s := jsonb_set(s, '{suit}', c->'suit');
        end if;
        if c->>'faction' is not null then
          s := jsonb_set(s, '{faction}', c->'faction');
        end if;
      end if;
      out := out || jsonb_build_array(s);
    end if;
  end loop;
  for c in select value from jsonb_array_elements(coalesce(p_client, '[]'::jsonb)) loop
    if not exists (
      select 1 from jsonb_array_elements(coalesce(p_server, '[]'::jsonb)) s(value)
      where s.value->>'id' = c->>'id'
    ) then
      -- Client-only row: same clamp, same reason.
      out := out || jsonb_build_array(app._clamp_industry_next(c, now_ms));
    end if;
  end loop;
  return out;
end;
$$;

-- ===========================================================================
-- Carried forward verbatim apart from the marked lines. Each is the current
-- top-layer definition of its function; tools/check_low_priority.js diffs them
-- against their source files so these copies can't drift.
-- ===========================================================================

-- From docs/sql/phase2_missions_bazaar.sql — the capacity gate now speaks the
-- client's language: bay floor, unequipped items.
create or replace function public.app_buy_accessory(p_offer_id text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  offer jsonb;
  price double precision;
  credits double precision;
  items jsonb;
  item jsonb;
  inv jsonb;
  used int;
  cap int;
  tier int;
begin
  st := app._lock_state(now_ms);
  tier := coalesce((st->'prestige'->>'tier')::int, 0);
  if app.claim_used(st, p_offer_id) then
    return jsonb_build_object('ok', false, 'error', 'Sold to another buyer.');
  end if;
  offer := app.lookup_offer(p_offer_id, now_ms, tier);
  if offer is null or offer->'item' is null then
    return jsonb_build_object('ok', false, 'error', 'Sold to another buyer.');
  end if;
  inv := coalesce(st->'inventory', '{"capacity":6,"upgrades":0}'::jsonb);
  items := coalesce(st->'items', '{}'::jsonb);
  used := app._inventory_used(st);
  cap := app._bay_capacity(st);
  if used >= cap then
    return jsonb_build_object('ok', false, 'error', 'Inventory full.');
  end if;
  -- price & item from recomputed offer only
  price := round(coalesce((offer->>'price')::float8, 0) * (1.0 - app.rep_discount(st)));
  credits := coalesce((st->>'credits')::float8, 0);
  if price > credits then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
  end if;
  item := offer->'item';
  item := jsonb_set(item, '{value}', to_jsonb(app.item_value(item)));
  items := jsonb_set(items, array[item->>'uid'], item);
  st := jsonb_set(st, '{credits}', to_jsonb(credits - price));
  st := jsonb_set(st, '{items}', items);
  st := app.mark_claimed(st, p_offer_id);
  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('item', item);
end;
$$;

-- From docs/sql/workshop_craft.sql — same gate, same two lines.
create or replace function public.app_craft_start(p_recipe_id text, p_flavor_id text default null)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  recipe jsonb;
  flavor jsonb;
  positions jsonb;
  avg_cost jsonb;
  ing jsonb;
  need double precision;
  have double precision;
  credits double precision;
  cost double precision;
  queue jsonb;
  seq int;
  job jsonb;
  ready bigint;
  cap int;
  used int;
  tier int;
begin
  recipe := app.craft_recipe(p_recipe_id);
  if recipe is null then
    return jsonb_build_object('ok', false, 'error', 'Unknown recipe.');
  end if;

  st := app._lock_state(now_ms);
  if st is null then
    return jsonb_build_object('ok', false, 'error', 'no player row yet');
  end if;
  tier := coalesce((st->'prestige'->>'tier')::int, 0);

  -- Blueprint gate. knownRecipes stays client-owned (blueprints drop from
  -- sources with no RPC), so this mirrors Workshop.known: explicit unlock or an
  -- auto blueprint whose Baron Tier floor is met. Costs below are server-owned,
  -- so a forged unlock still pays full freight.
  if not (coalesce(st->'knownRecipes', '[]'::jsonb) ? p_recipe_id)
     and not (recipe->>'autoTier' is not null and tier >= (recipe->>'autoTier')::int) then
    return jsonb_build_object('ok', false, 'error', 'Blueprint required.');
  end if;
  if coalesce(st->'craftedOnce', '[]'::jsonb) ? p_recipe_id then
    return jsonb_build_object('ok', false, 'error', 'Already crafted — unique blueprint spent.');
  end if;

  queue := case when jsonb_typeof(st->'workshop'->'queue') = 'array'
                then st->'workshop'->'queue' else '[]'::jsonb end;

  if (recipe->>'destroyOnUse')::boolean
     and exists (select 1 from jsonb_array_elements(queue) as q(v) where q.v->>'recipeId' = p_recipe_id) then
    return jsonb_build_object('ok', false, 'error', 'That unique hull is already on the slips.');
  end if;
  if jsonb_array_length(queue) >= app._craft_slots(st) then
    return jsonb_build_object('ok', false, 'error', 'No free Workshop slots.');
  end if;

  -- Flavor ingredient (specialized extractor): explicit pick, else first affordable.
  if recipe->'flavor' is not null then
    positions := coalesce(st->'positions', '{}'::jsonb);
    if nullif(p_flavor_id, '') is not null then
      select f.v into flavor from jsonb_array_elements(recipe->'flavor') as f(v)
       where f.v->>'id' = p_flavor_id limit 1;
    else
      select f.v into flavor from jsonb_array_elements(recipe->'flavor') as f(v)
       where coalesce((positions->>(f.v->>'id'))::float8, 0) >= (f.v->>'qty')::float8
       limit 1;
    end if;
    if flavor is null then
      return jsonb_build_object('ok', false, 'error', 'Need a category-flavor ingredient.');
    end if;
  end if;

  -- Output-slot checks (mirror Workshop.canCraft).
  if recipe->>'outputType' in ('gear', 'blackbox') then
    used := app._inventory_used(st);
    cap := app._bay_capacity(st);
    if used >= cap then
      return jsonb_build_object('ok', false, 'error', 'Inventory full — free a slot first.');
    end if;
  elsif recipe->>'outputType' = 'ship' then
    cap := app.fleet_cap(tier);
    if jsonb_array_length(coalesce(st->'ships', '[]'::jsonb)) >= cap then
      return jsonb_build_object('ok', false, 'error', 'Fleet at capacity (' || cap || ').');
    end if;
    if (recipe->>'unique')::boolean and exists (
      select 1 from jsonb_array_elements(coalesce(st->'ships', '[]'::jsonb)) as s2(v)
       where s2.v->>'type' = recipe->'output'->>'shipType') then
      return jsonb_build_object('ok', false, 'error', 'You already command that unique hull.');
    end if;
  end if;

  -- Cost check. Base recipe cost only — see the Senate note at the top.
  credits := coalesce((st->>'credits')::float8, 0);
  cost := coalesce((recipe->>'credits')::float8, 0);
  if cost > credits then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
  end if;

  positions := coalesce(st->'positions', '{}'::jsonb);
  for ing in select t.v from jsonb_array_elements(coalesce(recipe->'ingredients', '[]'::jsonb)) as t(v) loop
    need := (ing->>'qty')::float8;
    have := coalesce((positions->>(ing->>'id'))::float8, 0);
    if have < need then
      return jsonb_build_object('ok', false, 'error', 'Need ' || need::int || ' ' || (ing->>'id') || '.');
    end if;
  end loop;
  if flavor is not null
     and coalesce((positions->>(flavor->>'id'))::float8, 0) < (flavor->>'qty')::float8 then
    return jsonb_build_object('ok', false, 'error', 'Need ' || (flavor->>'qty') || ' ' || (flavor->>'id') || '.');
  end if;

  -- Charge. Zeroing avgCost on depletion mirrors Workshop.craft.
  avg_cost := coalesce(st->'avgCost', '{}'::jsonb);
  for ing in select t.v from jsonb_array_elements(coalesce(recipe->'ingredients', '[]'::jsonb)) as t(v) loop
    have := coalesce((positions->>(ing->>'id'))::float8, 0) - (ing->>'qty')::float8;
    if have <= 0 then
      have := 0;
      avg_cost := jsonb_set(avg_cost, array[ing->>'id'], to_jsonb(0::float8), true);
    end if;
    positions := jsonb_set(positions, array[ing->>'id'], to_jsonb(have), true);
  end loop;
  if flavor is not null then
    have := coalesce((positions->>(flavor->>'id'))::float8, 0) - (flavor->>'qty')::float8;
    if have <= 0 then
      have := 0;
      avg_cost := jsonb_set(avg_cost, array[flavor->>'id'], to_jsonb(0::float8), true);
    end if;
    positions := jsonb_set(positions, array[flavor->>'id'], to_jsonb(have), true);
  end if;

  seq := coalesce((st->>'seq')::int, 1) + 1;
  ready := now_ms + greatest(1000, floor(
    (recipe->>'craftMs')::float8 * app._craft_time_mult(st, now_ms))::bigint);
  job := jsonb_build_object(
    'id', 'ck' || seq,
    'recipeId', p_recipe_id,
    'startedAt', now_ms,
    'readyAt', ready,
    'flavorId', flavor->>'id');   -- SQL NULL → JSON null when there is no flavor

  st := jsonb_set(st, '{positions}', positions);
  st := jsonb_set(st, '{avgCost}', avg_cost);
  st := jsonb_set(st, '{credits}', to_jsonb(credits - cost));
  st := jsonb_set(st, '{seq}', to_jsonb(seq));
  if st->'workshop' is null or jsonb_typeof(st->'workshop') <> 'object' then
    st := jsonb_set(st, '{workshop}', '{"upgrades":0,"queue":[]}'::jsonb, true);
  end if;
  st := jsonb_set(st, '{workshop,queue}', queue || jsonb_build_array(job), true);

  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('job', job);
end;
$$;

-- From docs/sql/crime_coefficient.sql — plus the two hygiene passes.
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
  -- This file: bay capacity matches the client's hauling model, and dead
  -- purchase marks stop riding in every commit.
  merged := app._normalize_inventory(merged);
  merged := app._prune_bazaar_bought(merged, now_ms);

  perform app._write_state(merged, now_ms);
  return jsonb_build_object('ok', true, 'state', merged);
end;
$$;

grant execute on function public.app_commit(jsonb) to authenticated;
grant execute on function public.app_buy_accessory(text) to authenticated;
grant execute on function public.app_craft_start(text, text) to authenticated;
