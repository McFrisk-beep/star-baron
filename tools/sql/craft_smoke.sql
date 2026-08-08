\set ON_ERROR_STOP on

create or replace function app.t_reset(p_state jsonb) returns void
language plpgsql as $$
begin
  delete from public.players;
  insert into public.players (user_id, state, updated_ms) values (auth.uid(), p_state, 0);
end;
$$;

create or replace function app.t_state() returns jsonb
language sql as $$ select p.state from public.players p limit 1 $$;

create or replace function app.t_clock(p bigint) returns void
language plpgsql as $$ begin delete from app.clock; insert into app.clock values (p); end; $$;

create or replace function app.t_assert(p_cond boolean, p_msg text) returns void
language plpgsql as $$
begin
  if not p_cond then raise exception 'FAIL: %', p_msg; end if;
  raise notice 'ok: %', p_msg;
end;
$$;

do $$
declare
  base jsonb := jsonb_build_object(
    'credits', 100000::float8,
    'seq', 10,
    'positions', jsonb_build_object('titanium_ore', 20::float8, 'sensor_array', 9::float8,
                                    'quantum_core', 5::float8, 'iron_ore', 30::float8,
                                    'silicon', 10::float8),
    'avgCost', jsonb_build_object('titanium_ore', 150::float8, 'sensor_array', 400::float8,
                                  'quantum_core', 700::float8),
    'items', '{}'::jsonb,
    'inventory', '{"capacity":6,"upgrades":0}'::jsonb,
    'ships', '[]'::jsonb,
    'knownRecipes', '["gear_shield_rare"]'::jsonb,
    'craftedOnce', '[]'::jsonb,
    'prestige', '{"tier":0,"multiplier":1}'::jsonb,
    'extractors', '{}'::jsonb,
    'components', '{}'::jsonb,
    'industries', '[]'::jsonb, 'expeditions', '[]'::jsonb, 'routes', '[]'::jsonb,
    'stats', '{}'::jsonb,
    -- app_commit uses jsonb_set, which returns NULL if the new value is SQL NULL,
    -- so every slice it copies from the server must exist in the fixture.
    'currentSystem', 'sol', 'travel', 'null'::jsonb, 'unlockedSystems', '["sol"]'::jsonb,
    'mainShip', '{"type":"pinnace"}'::jsonb, 'missions', '[]'::jsonb,
    'pendingContracts', '[]'::jsonb, 'bazaarBought', '[]'::jsonb,
    'reputation', '{}'::jsonb, 'bazaar', '{"mercs":[],"contracts":[],"accessories":[]}'::jsonb,
    'listings', '[]'::jsonb, 'surveyed', '{}'::jsonb);
  r jsonb;
  st jsonb;
  job_id text;
  item jsonb;
  n int;
begin
  -- ============================ start ==================================
  perform app.t_clock(1000000000000);
  perform app.t_reset(base);

  r := public.app_craft_start('gear_shield_rare', null);
  perform app.t_assert(r->>'ok' = 'true', 'craft_start succeeds: ' || coalesce(r->>'error', ''));
  st := app.t_state();
  perform app.t_assert(jsonb_array_length(st->'workshop'->'queue') = 1, 'one job queued');
  job_id := st->'workshop'->'queue'->0->>'id';
  perform app.t_assert(
    (st->'workshop'->'queue'->0->>'readyAt')::bigint = 1000000000000 + 7200000,
    'readyAt = now + recipe craftMs');
  -- gear_shield_rare: titanium_ore 6, sensor_array 5, quantum_core 2
  perform app.t_assert((st->'positions'->>'titanium_ore')::float8 = 14, 'titanium deducted 20→14');
  perform app.t_assert((st->'positions'->>'sensor_array')::float8 = 4, 'sensor_array deducted 9→4');
  perform app.t_assert((st->'positions'->>'quantum_core')::float8 = 3, 'quantum_core deducted 5→3');
  perform app.t_assert((st->>'credits')::float8 = 100000, 'no credit cost for gear recipes');

  -- insufficient ingredients are refused
  r := public.app_craft_start('gear_shield_rare', null);
  perform app.t_assert(r->>'ok' = 'false' and r->>'error' like 'Need%',
    'second craft refused once sensor_array runs short');

  -- unknown blueprint is refused
  r := public.app_craft_start('ship_last_aegis', null);
  perform app.t_assert(r->>'ok' = 'false' and r->>'error' = 'Blueprint required.',
    'locked recipe refused');

  -- unknown recipe id is refused
  r := public.app_craft_start('nope_not_real', null);
  perform app.t_assert(r->>'ok' = 'false' and r->>'error' = 'Unknown recipe.', 'bogus recipe refused');

  -- ============================ claim ==================================
  -- not ready yet → nothing delivered, job stays queued
  r := public.app_craft_claim();
  perform app.t_assert(jsonb_array_length(r->'delivered') = 0, 'nothing delivered before readyAt');
  perform app.t_assert(jsonb_array_length(app.t_state()->'workshop'->'queue') = 1, 'job still queued');

  perform app.t_clock(1000000000000 + 7200001);
  r := public.app_craft_claim();
  perform app.t_assert(jsonb_array_length(r->'delivered') = 1, 'one craft delivered');
  st := app.t_state();
  perform app.t_assert(jsonb_array_length(st->'workshop'->'queue') = 0, 'queue drained');
  select value into item from jsonb_each(st->'items') limit 1;
  perform app.t_assert(item is not null, 'item minted into the server pool');
  perform app.t_assert(item->>'kind' = 'shield', 'minted the recipe kind');
  perform app.t_assert(item->>'rarity' = 'rare', 'minted the recipe rarity');
  perform app.t_assert((item->>'value')::float8 > 0, 'item has a server-computed value');
  perform app.t_assert((item->'primary'->>'amount')::float8 > 0, 'item has a rolled stat');
  perform app.t_assert(item->>'name' not like '%null%', 'item name rendered');
  perform app.t_assert(item->>'uid' like 'craft-%', 'deterministic craft uid from job id');

  -- Re-queue the finished job (stale unprotected commit) and claim again —
  -- must NOT mint a second item or re-announce. uid is craft-<jobId>.
  perform app._write_state(
    jsonb_set(st, '{workshop,queue}', jsonb_build_array(
      jsonb_build_object('id', substr(item->>'uid', 7), 'recipeId', 'gear_shield_rare',
                         'startedAt', 1, 'readyAt', 2, 'flavorId', null))),
    app._now_ms());
  r := public.app_craft_claim();
  perform app.t_assert(jsonb_array_length(r->'delivered') = 0, 'idempotent claim does not re-announce');
  perform app.t_assert(
    (select count(*) from jsonb_object_keys(app.t_state()->'items')) = 1,
    'idempotent claim does not mint a second item');
  perform app.t_assert(jsonb_array_length(app.t_state()->'workshop'->'queue') = 0,
    'idempotent claim still drains the re-queued job');
  st := app.t_state();

  -- ============ the actual bug: commit must not delete it ==============
  -- Simulate the client autosave round-trip that used to wipe crafted gear.
  r := public.app_commit(st || jsonb_build_object('items', '{}'::jsonb));
  perform app.t_assert(
    (select count(*) from jsonb_object_keys(r->'state'->'items')) = 1,
    'crafted item survives app_commit');

  -- a forged queue job from the client is discarded
  r := public.app_commit(st || jsonb_build_object('workshop',
    '{"upgrades":4,"queue":[{"id":"ckX","recipeId":"gear_scanner_legend","startedAt":1,"readyAt":2,"flavorId":null}]}'::jsonb));
  perform app.t_assert(jsonb_array_length(r->'state'->'workshop'->'queue') = 0,
    'forged queue job dropped by app_commit');
  perform app.t_assert((r->'state'->'workshop'->>'upgrades')::int = 0,
    'forged slot upgrades dropped by app_commit');

  -- ============================ slots ==================================
  perform app.t_reset(base);
  r := public.app_craft_slot();
  perform app.t_assert(r->>'ok' = 'true', 'slot upgrade succeeds');
  perform app.t_assert((r->>'credits')::float8 = 100000 - 14000, 'slot upgrade charged 14000');
  perform app.t_assert((r->>'slots')::int = 3, 'slots 2 → 3');

  -- ============================ adopt ==================================
  perform app.t_reset(base);
  r := public.app_craft_adopt(
    '{"upgrades":2,"queue":[{"id":"ck7","recipeId":"gear_plating_common","startedAt":1,"readyAt":900,"flavorId":null},
                            {"id":"ck8","recipeId":"not_a_recipe","startedAt":1,"readyAt":2,"flavorId":null}]}'::jsonb,
    jsonb_build_object(
      'i42', jsonb_build_object('uid','i42','kind','shield','rarity','rare','name','Lost Shield',
                                'primary', jsonb_build_object('stat','shields','amount',99999,'pct',false,'kind','shield'),
                                'value', 999999999),
      'i43', jsonb_build_object('uid','i43','kind','blackbox','rarity','rare','effectId','tax_ghost','name','x'),
      'i44', jsonb_build_object('uid','i44','kind','not_a_kind','rarity','legendary','name','Cheat')));
  perform app.t_assert(r->>'ok' = 'true', 'adopt succeeds');
  perform app.t_assert((r->>'adoptedItems')::int = 2, 'adopted the 2 legitimate items, dropped the forged kind');
  perform app.t_assert((r->>'adoptedJobs')::int = 1, 'adopted the 1 real job, dropped the unknown recipe');
  st := app.t_state();
  perform app.t_assert((st->'items'->'i42'->>'value')::float8 < 999999999,
    'adopted item was re-valued server-side, not trusted');
  perform app.t_assert((st->'items'->'i42'->'primary'->>'amount')::float8 < 99999,
    'adopted item stats re-rolled server-side');
  perform app.t_assert(st->'items'->'i43'->>'effectId' = 'tax_ghost', 'blackbox adopted by effect id');
  perform app.t_assert(st->'items' ? 'i44' = false, 'forged item kind refused');
  perform app.t_assert((st->'workshop'->>'upgrades')::int = 2, 'adopted slot upgrades');

  -- bounded, not one-shot: a wipe-backup restore can happen after the boot adopt
  r := public.app_craft_adopt('{"upgrades":3,"queue":[]}'::jsonb,
    jsonb_build_object('i50', jsonb_build_object('uid','i50','kind','cannon','rarity','common','name','Late Restore')));
  perform app.t_assert(r->>'ok' = 'true', 'a second adopt is allowed (restore-after-boot)');
  perform app.t_assert(app.t_state()->'items' ? 'i50', 'late-restored item adopted');
  perform app.t_assert(jsonb_array_length(app.t_state()->'workshop'->'queue') = 1,
    'second adopt did not stack or wipe the existing queue');
  r := public.app_craft_adopt('{"upgrades":3,"queue":[]}'::jsonb, '{}'::jsonb);
  perform app.t_assert(r->>'ok' = 'true', 'third adopt still allowed');
  r := public.app_craft_adopt('{"upgrades":3,"queue":[]}'::jsonb, '{}'::jsonb);
  perform app.t_assert(r->>'ok' = 'false' and r->>'error' = 'adopt limit reached',
    'fourth adopt refused — call budget spent');

  -- adopted job is claimable and mints for real
  perform app.t_clock(1000000000000);
  r := public.app_craft_claim();
  perform app.t_assert(jsonb_array_length(r->'delivered') = 1, 'adopted in-flight job delivers');

  -- ==================== craftTime boost is honored =====================
  perform app.t_reset(base || jsonb_build_object('activeBoosts',
    jsonb_build_array(jsonb_build_object('effectId','fabricators_boon','expiresAt', 9999999999999::bigint))));
  r := public.app_craft_start('gear_shield_rare', null);
  perform app.t_assert(r->>'ok' = 'true', 'craft with boost starts');
  st := app.t_state();
  perform app.t_assert(
    (st->'workshop'->'queue'->0->>'readyAt')::bigint = 1000000000000 + (7200000 * 0.7)::bigint,
    'Fabricator''s Boon cuts craft time 30%');

  -- expired boosts are ignored
  perform app.t_reset(base || jsonb_build_object('activeBoosts',
    jsonb_build_array(jsonb_build_object('effectId','fabricators_boon','expiresAt', 1::bigint))));
  r := public.app_craft_start('gear_shield_rare', null);
  st := app.t_state();
  perform app.t_assert(
    (st->'workshop'->'queue'->0->>'readyAt')::bigint = 1000000000000 + 7200000,
    'expired boost ignored');

  raise notice '=== ALL CRAFT SQL CHECKS PASSED ===';
end;
$$;
