-- workshop_craft.sql — server-authoritative Workshop crafting.
--
-- WHY THIS EXISTS
-- Workshop crafting was 100% client-local: Workshop._deliver wrote the finished
-- item straight into state.items in the browser and no RPC ever told the server.
-- But app_commit treats `items` as server-owned:
--     merged := jsonb_set(merged, '{items}', coalesce(server->'items', '{}'));
-- and Economy.applyCommitState copies that back over the live state. The only
-- function that ever ADDED to the server item pool was app_buy_accessory. So a
-- crafted item was deleted by the next cloud sync — roughly five seconds after
-- it appeared. The save wipe did not lose those items; this hole did.
--
-- WHAT CHANGES
--   • state.workshop (queue + slot upgrades) becomes SERVER-OWNED. A client can
--     no longer invent a finished job, so minting an item requires having really
--     paid for it out of the server-owned positions/credits ledger.
--   • app_craft_start  — validate, charge ingredients + credits, queue the job.
--   • app_craft_claim  — deliver jobs whose readyAt has passed, minting gear /
--     blackboxes / extractors / ships into the server pool.
--   • app_craft_slot   — buy a Workshop slot upgrade.
--   • app_craft_adopt  — bounded migration (3 calls / 12 items per account, ever).
--     Existing players have crafted items, in-flight jobs, and slot upgrades the
--     server has never seen; without this they would all vanish the moment the
--     queue becomes server-owned.
--
-- DELIBERATELY NOT SERVER-SIDE (unchanged from today, still client-owned):
--   • knownRecipes / craftedOnce — blueprints drop from bazaar, expeditions,
--     missions, story and Senate edicts, none of which have RPCs. Keeping them
--     client-owned preserves the status quo; a forged blueprint still can't mint
--     anything for free because the ingredients and credits are server-owned.
--   • Senate craftCost / craftTime edicts. The Senate bill model is client-side,
--     so the server charges the BASE recipe cost and base duration. A Fabrication
--     Rights discount is not honored for signed-in players until the Senate model
--     moves server-side. Blackbox craftTime boosts ARE honored (see below).
--
-- Requires: phase1_players.sql, phase2_missions_bazaar.sql, phase3_pull_prestige.sql
--           (app._lock_state / app._write_state / app._now_ms / app.item_value /
--            app.make_ship / app.fleet_cap / market.seed_hash / market.u01).
--           Apply/re-apply phase2_missions_bazaar.sql FIRST: its app.ship_def is
--           where craft-only hulls live, and a ship job can't build without one.
-- Apply: paste into the Supabase SQL editor and run once. Safe to re-run.

-- ===========================================================================
-- Fixtures — keep in lockstep with js/data.js (tools/check_craft_parity.js)
--
-- Generated: `node tools/sql/gen_craft_fixtures.js` (the same generator behind
-- Admin → 🔧 Crafting → Server SQL). Edit js/data.js, regenerate, paste here.
-- ===========================================================================

-- Recipe catalog. `auto_tier` is the BLUEPRINTS source:"auto" minBaronTier
-- (null = not auto-unlocked); `destroy_on_use` marks the one-of-a-kind hull.
create or replace function app.craft_recipe(p_id text)
returns jsonb
language sql immutable as $$
  select r.row from (values
    ('gear_plating_common', jsonb_build_object(
      'id','gear_plating_common','name','Common Plating','outputType','gear',
      'craftMs', 1200000::bigint, 'credits', 0,
      'ingredients', '[{"id":"iron_ore","qty":6},{"id":"silicon","qty":2}]'::jsonb,
      'output', '{"kind":"plating","rarity":"common"}'::jsonb,
      'autoTier', 0, 'destroyOnUse', false, 'unique', false)),
    ('gear_cannon_uncommon', jsonb_build_object(
      'id','gear_cannon_uncommon','name','Uncommon Cannon','outputType','gear',
      'craftMs', 3600000::bigint, 'credits', 0,
      'ingredients', '[{"id":"titanium_ore","qty":8},{"id":"nanochips","qty":4}]'::jsonb,
      'output', '{"kind":"cannon","rarity":"uncommon"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('gear_shield_rare', jsonb_build_object(
      'id','gear_shield_rare','name','Rare Shield','outputType','gear',
      'craftMs', 7200000::bigint, 'credits', 0,
      'ingredients', '[{"id":"titanium_ore","qty":6},{"id":"sensor_array","qty":5},{"id":"quantum_core","qty":2}]'::jsonb,
      'output', '{"kind":"shield","rarity":"rare"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('gear_reactor_epic', jsonb_build_object(
      'id','gear_reactor_epic','name','Epic Reactor','outputType','gear',
      'craftMs', 14400000::bigint, 'credits', 0,
      'ingredients', '[{"id":"quantum_core","qty":4},{"id":"plasma_gas","qty":3},{"id":"gemstones","qty":2}]'::jsonb,
      'output', '{"kind":"reactor","rarity":"epic"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('gear_scanner_legend', jsonb_build_object(
      'id','gear_scanner_legend','name','Legendary Scanner','outputType','gear',
      'craftMs', 28800000::bigint, 'credits', 0,
      'ingredients', '[{"id":"ai_matrix","qty":2},{"id":"quantum_core","qty":3},{"id":"voidstone","qty":1}]'::jsonb,
      'output', '{"kind":"scanner","rarity":"legendary"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('ex_jack', jsonb_build_object(
      'id','ex_jack','name','Jack Extractor','outputType','extractor',
      'craftMs', 10800000::bigint, 'credits', 0,
      'ingredients', '[{"id":"iron_ore","qty":10},{"id":"silicon","qty":5},{"id":"nanochips","qty":2}]'::jsonb,
      'output', '{"extractorType":"jack","scope":"all"}'::jsonb,
      'autoTier', 0, 'destroyOnUse', false, 'unique', false)),
    ('ex_semi', jsonb_build_object(
      'id','ex_semi','name','Semi-Spec Extractor','outputType','extractor',
      'craftMs', 21600000::bigint, 'credits', 0,
      'ingredients', '[{"id":"titanium_ore","qty":8},{"id":"nanochips","qty":6},{"id":"sensor_array","qty":3}]'::jsonb,
      'output', '{"extractorType":"semi","scope":"mineral"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('ex_specialized', jsonb_build_object(
      'id','ex_specialized','name','Specialized Extractor','outputType','extractor',
      'craftMs', 36000000::bigint, 'credits', 0,
      'ingredients', '[{"id":"titanium_ore","qty":12},{"id":"nanochips","qty":10},{"id":"quantum_core","qty":4}]'::jsonb,
      'flavor', '[{"id":"pulsar_shard","qty":1,"scopeCat":"mineral"},{"id":"plasma_gas","qty":1,"scopeCat":"gas"},{"id":"spore_culture","qty":1,"scopeCat":"agri"},{"id":"neural_processor","qty":1,"scopeCat":"tech"},{"id":"fine_art","qty":1,"scopeCat":"luxury"},{"id":"bio_toxin","qty":1,"scopeCat":"illicit"}]'::jsonb,
      'output', '{"extractorType":"specialized"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('ship_corvette', jsonb_build_object(
      'id','ship_corvette','name','Yard Corvette','outputType','ship',
      'craftMs', 86400000::bigint, 'credits', 10000,
      'ingredients', '[{"id":"titanium_ore","qty":40},{"id":"nanochips","qty":20},{"id":"plasma_gas","qty":15}]'::jsonb,
      'output', '{"shipType":"craft_corvette"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('ship_cruiser', jsonb_build_object(
      'id','ship_cruiser','name','Yard Cruiser','outputType','ship',
      'craftMs', 172800000::bigint, 'credits', 40000,
      'ingredients', '[{"id":"titanium_ore","qty":70},{"id":"nanochips","qty":35},{"id":"quantum_core","qty":20}]'::jsonb,
      'output', '{"shipType":"craft_cruiser"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('ship_last_aegis', jsonb_build_object(
      'id','ship_last_aegis','name','The Last Aegis','outputType','ship',
      'craftMs', 432000000::bigint, 'credits', 250000,
      'ingredients', '[{"id":"voidstone","qty":30},{"id":"ai_matrix","qty":20},{"id":"quantum_core","qty":40},{"id":"antimatter","qty":25}]'::jsonb,
      'output', '{"shipType":"last_aegis"}'::jsonb,
      'autoTier', null, 'destroyOnUse', true, 'unique', true)),
    ('bb_overclock_core', jsonb_build_object(
      'id','bb_overclock_core','name','Overclock Core (box)','outputType','blackbox',
      'craftMs', 1800000::bigint, 'credits', 0,
      'ingredients', '[{"id":"quantum_core","qty":4},{"id":"plasma_gas","qty":2},{"id":"gemstones","qty":3}]'::jsonb,
      'output', '{"effectId":"overclock_core"}'::jsonb,
      'autoTier', 1, 'destroyOnUse', false, 'unique', false)),
    ('bb_smugglers_veil', jsonb_build_object(
      'id','bb_smugglers_veil','name','Smuggler''s Veil (box)','outputType','blackbox',
      'craftMs', 2700000::bigint, 'credits', 0,
      'ingredients', '[{"id":"weapons_cache","qty":5},{"id":"cipher_shard","qty":3},{"id":"narcotics","qty":2}]'::jsonb,
      'output', '{"effectId":"smugglers_veil"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('bb_autopilot_surge', jsonb_build_object(
      'id','bb_autopilot_surge','name','Autopilot Surge (box)','outputType','blackbox',
      'craftMs', 1800000::bigint, 'credits', 0,
      'ingredients', '[{"id":"sensor_array","qty":6},{"id":"plasma_gas","qty":4}]'::jsonb,
      'output', '{"effectId":"autopilot_surge"}'::jsonb,
      'autoTier', 1, 'destroyOnUse', false, 'unique', false)),
    ('bb_silver_tongue', jsonb_build_object(
      'id','bb_silver_tongue','name','Silver Tongue (box)','outputType','blackbox',
      'craftMs', 2400000::bigint, 'credits', 0,
      'ingredients', '[{"id":"fine_art","qty":4},{"id":"vintage_wine","qty":3},{"id":"gemstones","qty":2}]'::jsonb,
      'output', '{"effectId":"silver_tongue"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('bb_void_shield', jsonb_build_object(
      'id','bb_void_shield','name','Void Shield (box)','outputType','blackbox',
      'craftMs', 2400000::bigint, 'credits', 0,
      'ingredients', '[{"id":"titanium_ore","qty":5},{"id":"biofiber","qty":4},{"id":"quantum_core","qty":2}]'::jsonb,
      'output', '{"effectId":"void_shield"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('bb_tax_ghost', jsonb_build_object(
      'id','bb_tax_ghost','name','Tax Ghost (box)','outputType','blackbox',
      'craftMs', 3600000::bigint, 'credits', 0,
      'ingredients', '[{"id":"cipher_shard","qty":6},{"id":"bio_toxin","qty":4}]'::jsonb,
      'output', '{"effectId":"tax_ghost"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('bb_fabricators_boon', jsonb_build_object(
      'id','bb_fabricators_boon','name','Fabricator''s Boon (box)','outputType','blackbox',
      'craftMs', 2100000::bigint, 'credits', 0,
      'ingredients', '[{"id":"nanochips","qty":5},{"id":"graphene_lattice","qty":3},{"id":"fusion_cell","qty":2}]'::jsonb,
      'output', '{"effectId":"fabricators_boon"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('gear_hold_common', jsonb_build_object(
      'id','gear_hold_common','name','Common Cargo Pod','outputType','gear',
      'craftMs', 1500000::bigint, 'credits', 0,
      'ingredients', '[{"id":"iron_ore","qty":8},{"id":"synthsilk","qty":4}]'::jsonb,
      'output', '{"kind":"hold","rarity":"common"}'::jsonb,
      'autoTier', 0, 'destroyOnUse', false, 'unique', false)),
    ('gear_engine_uncommon', jsonb_build_object(
      'id','gear_engine_uncommon','name','Uncommon Engine','outputType','gear',
      'craftMs', 4200000::bigint, 'credits', 0,
      'ingredients', '[{"id":"cobalt_ore","qty":6},{"id":"fusion_cell","qty":5},{"id":"xenon_gas","qty":3}]'::jsonb,
      'output', '{"kind":"engine","rarity":"uncommon"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('gear_probe_uncommon', jsonb_build_object(
      'id','gear_probe_uncommon','name','Uncommon Probe Rack','outputType','gear',
      'craftMs', 4800000::bigint, 'credits', 0,
      'ingredients', '[{"id":"sensor_array","qty":5},{"id":"silicon","qty":4},{"id":"xenon_gas","qty":2}]'::jsonb,
      'output', '{"kind":"probe","rarity":"uncommon"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('gear_plating_rare', jsonb_build_object(
      'id','gear_plating_rare','name','Rare Plating','outputType','gear',
      'craftMs', 9000000::bigint, 'credits', 0,
      'ingredients', '[{"id":"titanium_ore","qty":12},{"id":"graphene_lattice","qty":6},{"id":"cobalt_ore","qty":4}]'::jsonb,
      'output', '{"kind":"plating","rarity":"rare"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('gear_survey_shield_rare', jsonb_build_object(
      'id','gear_survey_shield_rare','name','Rare Survey Shield','outputType','gear',
      'craftMs', 10800000::bigint, 'credits', 0,
      'ingredients', '[{"id":"graphene_lattice","qty":6},{"id":"sensor_array","qty":4},{"id":"cryo_vapor","qty":3}]'::jsonb,
      'output', '{"kind":"survey_shield","rarity":"rare"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('gear_cannon_epic', jsonb_build_object(
      'id','gear_cannon_epic','name','Epic Cannon','outputType','gear',
      'craftMs', 18000000::bigint, 'credits', 0,
      'ingredients', '[{"id":"titanium_ore","qty":10},{"id":"pulsar_shard","qty":5},{"id":"antimatter","qty":3}]'::jsonb,
      'output', '{"kind":"cannon","rarity":"epic"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('gear_engine_epic', jsonb_build_object(
      'id','gear_engine_epic','name','Epic Engine','outputType','gear',
      'craftMs', 18000000::bigint, 'credits', 0,
      'ingredients', '[{"id":"pulsar_shard","qty":6},{"id":"xenon_gas","qty":5},{"id":"neural_processor","qty":4}]'::jsonb,
      'output', '{"kind":"engine","rarity":"epic"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('gear_shield_legend', jsonb_build_object(
      'id','gear_shield_legend','name','Legendary Shield','outputType','gear',
      'craftMs', 32400000::bigint, 'credits', 0,
      'ingredients', '[{"id":"ai_matrix","qty":3},{"id":"voidstone","qty":2},{"id":"quantum_foam","qty":4}]'::jsonb,
      'output', '{"kind":"shield","rarity":"legendary"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('ship_courier', jsonb_build_object(
      'id','ship_courier','name','Yard Courier','outputType','ship',
      'craftMs', 43200000::bigint, 'credits', 6000,
      'ingredients', '[{"id":"titanium_ore","qty":25},{"id":"nanochips","qty":12},{"id":"plasma_gas","qty":8}]'::jsonb,
      'output', '{"shipType":"craft_courier"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('ship_freighter', jsonb_build_object(
      'id','ship_freighter','name','Yard Freighter','outputType','ship',
      'craftMs', 108000000::bigint, 'credits', 25000,
      'ingredients', '[{"id":"iron_ore","qty":60},{"id":"titanium_ore","qty":30},{"id":"nanochips","qty":18}]'::jsonb,
      'output', '{"shipType":"craft_freighter"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('ship_void_caravan', jsonb_build_object(
      'id','ship_void_caravan','name','Void Caravan','outputType','ship',
      'craftMs', 216000000::bigint, 'credits', 90000,
      'ingredients', '[{"id":"titanium_ore","qty":120},{"id":"graphene_lattice","qty":60},{"id":"quantum_core","qty":30},{"id":"fusion_cell","qty":20}]'::jsonb,
      'output', '{"shipType":"void_caravan"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('ship_argent_ark', jsonb_build_object(
      'id','ship_argent_ark','name','The Argent Ark','outputType','ship',
      'craftMs', 345600000::bigint, 'credits', 200000,
      'ingredients', '[{"id":"voidstone","qty":25},{"id":"ai_matrix","qty":15},{"id":"quantum_core","qty":30},{"id":"quantum_foam","qty":20}]'::jsonb,
      'output', '{"shipType":"argent_ark"}'::jsonb,
      'autoTier', null, 'destroyOnUse', true, 'unique', true)),
    ('ship_frigate', jsonb_build_object(
      'id','ship_frigate','name','Yard Frigate','outputType','ship',
      'craftMs', 129600000::bigint, 'credits', 22000,
      'ingredients', '[{"id":"titanium_ore","qty":55},{"id":"nanochips","qty":28},{"id":"fusion_cell","qty":12}]'::jsonb,
      'output', '{"shipType":"craft_frigate"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('ship_probe', jsonb_build_object(
      'id','ship_probe','name','Yard Probe','outputType','ship',
      'craftMs', 50400000::bigint, 'credits', 8000,
      'ingredients', '[{"id":"silicon","qty":30},{"id":"sensor_array","qty":14},{"id":"xenon_gas","qty":10}]'::jsonb,
      'output', '{"shipType":"craft_probe"}'::jsonb,
      'autoTier', 1, 'destroyOnUse', false, 'unique', false)),
    ('ship_pathfinder', jsonb_build_object(
      'id','ship_pathfinder','name','Pathfinder Cutter','outputType','ship',
      'craftMs', 144000000::bigint, 'credits', 30000,
      'ingredients', '[{"id":"titanium_ore","qty":40},{"id":"sensor_array","qty":25},{"id":"cryo_vapor","qty":10},{"id":"neural_processor","qty":6}]'::jsonb,
      'output', '{"shipType":"craft_pathfinder"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('ship_oracle_lens', jsonb_build_object(
      'id','ship_oracle_lens','name','The Oracle Lens','outputType','ship',
      'craftMs', 302400000::bigint, 'credits', 180000,
      'ingredients', '[{"id":"voidstone","qty":20},{"id":"ai_matrix","qty":18},{"id":"neural_processor","qty":25},{"id":"quantum_foam","qty":15}]'::jsonb,
      'output', '{"shipType":"oracle_lens"}'::jsonb,
      'autoTier', null, 'destroyOnUse', true, 'unique', true)),
    ('bb_foundry_blitz', jsonb_build_object(
      'id','bb_foundry_blitz','name','Foundry Blitz (box)','outputType','blackbox',
      'craftMs', 2400000::bigint, 'credits', 0,
      'ingredients', '[{"id":"nanochips","qty":6},{"id":"graphene_lattice","qty":4},{"id":"antimatter","qty":3}]'::jsonb,
      'output', '{"effectId":"foundry_blitz"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('bb_bulk_yield', jsonb_build_object(
      'id','bb_bulk_yield','name','Bulk Yield Injector (box)','outputType','blackbox',
      'craftMs', 2700000::bigint, 'credits', 0,
      'ingredients', '[{"id":"quantum_core","qty":5},{"id":"pulsar_shard","qty":4},{"id":"methane_slurry","qty":3}]'::jsonb,
      'output', '{"effectId":"bulk_yield"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('bb_iron_ledger', jsonb_build_object(
      'id','bb_iron_ledger','name','Iron Ledger (box)','outputType','blackbox',
      'craftMs', 4200000::bigint, 'credits', 0,
      'ingredients', '[{"id":"forged_credentials","qty":5},{"id":"cipher_shard","qty":4},{"id":"fine_art","qty":2}]'::jsonb,
      'output', '{"effectId":"iron_ledger"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('bb_ghost_manifest', jsonb_build_object(
      'id','bb_ghost_manifest','name','Ghost Manifest (box)','outputType','blackbox',
      'craftMs', 3300000::bigint, 'credits', 0,
      'ingredients', '[{"id":"forged_credentials","qty":6},{"id":"narcotics","qty":4},{"id":"cipher_shard","qty":3}]'::jsonb,
      'output', '{"effectId":"ghost_manifest"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('bb_hard_bargain', jsonb_build_object(
      'id','bb_hard_bargain','name','Hard Bargain (box)','outputType','blackbox',
      'craftMs', 3000000::bigint, 'credits', 0,
      'ingredients', '[{"id":"vintage_wine","qty":5},{"id":"perfume_essence","qty":4},{"id":"exotic_pelts","qty":3}]'::jsonb,
      'output', '{"effectId":"hard_bargain"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('bb_aegis_field', jsonb_build_object(
      'id','bb_aegis_field','name','Aegis Field (box)','outputType','blackbox',
      'craftMs', 3000000::bigint, 'credits', 0,
      'ingredients', '[{"id":"graphene_lattice","qty":6},{"id":"biofiber","qty":4},{"id":"cryo_vapor","qty":3}]'::jsonb,
      'output', '{"effectId":"aegis_field"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false)),
    ('bb_long_haul', jsonb_build_object(
      'id','bb_long_haul','name','Long Haul Protocol (box)','outputType','blackbox',
      'craftMs', 2700000::bigint, 'credits', 0,
      'ingredients', '[{"id":"sensor_array","qty":5},{"id":"fusion_cell","qty":4},{"id":"xenon_gas","qty":3}]'::jsonb,
      'output', '{"effectId":"long_haul"}'::jsonb,
      'autoTier', 2, 'destroyOnUse', false, 'unique', false)),
    ('bb_deep_lens', jsonb_build_object(
      'id','bb_deep_lens','name','Deep Lens (box)','outputType','blackbox',
      'craftMs', 3600000::bigint, 'credits', 0,
      'ingredients', '[{"id":"neural_processor","qty":4},{"id":"sensor_array","qty":3},{"id":"spore_culture","qty":2}]'::jsonb,
      'output', '{"effectId":"deep_lens"}'::jsonb,
      'autoTier', null, 'destroyOnUse', false, 'unique', false))
  ) as r(id, row)
  where r.id = p_id;
$$;

-- Blackbox effect table (BLACKBOX_EFFECTS in js/data.js). Only name/mag/duration
-- are needed server-side: minting a box and honoring the craftTime boost.
create or replace function app.craft_blackbox(p_id text)
returns jsonb
language sql immutable as $$
  select b.row from (values
    ('overclock_core', jsonb_build_object('id','overclock_core','name','Overclock Core','stat','industryYield','mag',0.25,'durationMs',7200000::bigint)),
    ('smugglers_veil', jsonb_build_object('id','smugglers_veil','name','Smuggler''s Veil','stat','customsSeize','mag',-0.5,'durationMs',10800000::bigint)),
    ('autopilot_surge', jsonb_build_object('id','autopilot_surge','name','Autopilot Surge','stat','missionTransit','mag',-0.2,'durationMs',14400000::bigint)),
    ('silver_tongue', jsonb_build_object('id','silver_tongue','name','Silver Tongue','stat','contractReward','mag',0.15,'durationMs',10800000::bigint)),
    ('void_shield', jsonb_build_object('id','void_shield','name','Void Shield','stat','missionDamage','mag',-0.3,'durationMs',7200000::bigint)),
    ('tax_ghost', jsonb_build_object('id','tax_ghost','name','Tax Ghost','stat','industryTax','mag',-0.5,'durationMs',14400000::bigint)),
    ('fabricators_boon', jsonb_build_object('id','fabricators_boon','name','Fabricator''s Boon','stat','craftTime','mag',-0.3,'durationMs',10800000::bigint)),
    ('foundry_blitz', jsonb_build_object('id','foundry_blitz','name','Foundry Blitz','stat','craftTime','mag',-0.55,'durationMs',3600000::bigint)),
    ('bulk_yield', jsonb_build_object('id','bulk_yield','name','Bulk Yield Injector','stat','industryYield','mag',0.45,'durationMs',3600000::bigint)),
    ('iron_ledger', jsonb_build_object('id','iron_ledger','name','Iron Ledger','stat','industryTax','mag',-0.75,'durationMs',7200000::bigint)),
    ('ghost_manifest', jsonb_build_object('id','ghost_manifest','name','Ghost Manifest','stat','customsSeize','mag',-0.8,'durationMs',5400000::bigint)),
    ('hard_bargain', jsonb_build_object('id','hard_bargain','name','Hard Bargain','stat','contractReward','mag',0.35,'durationMs',5400000::bigint)),
    ('aegis_field', jsonb_build_object('id','aegis_field','name','Aegis Field','stat','missionDamage','mag',-0.6,'durationMs',5400000::bigint)),
    ('long_haul', jsonb_build_object('id','long_haul','name','Long Haul Protocol','stat','missionTransit','mag',-0.35,'durationMs',7200000::bigint)),
    ('deep_lens', jsonb_build_object('id','deep_lens','name','Deep Lens','stat','surveyScan','mag',0.1,'durationMs',10800000::bigint))
  ) as b(id, row)
  where b.id = p_id;
$$;

-- Non-craftOnly commodity ids per category — the pool a specialized extractor
-- rolls its scope from (COMMODITIES.filter(c => c.cat === cat && !c.craftOnly)).
create or replace function app.craft_scope_pool(p_cat text)
returns text[]
language sql immutable as $$
  select p.ids from (values
    ('mineral', array['iron_ore','silicon','rare_earths','titanium_ore','cobalt_ore','graphene_lattice','pulsar_shard']),
    ('gas',     array['hydrogen','helium3','water_ice','plasma_gas','methane_slurry','xenon_gas','cryo_vapor']),
    ('agri',    array['foodstuffs','synthsilk','grain','protein_stock','hydro_greens','algae_paste','biofiber','nectar_extract','medicinal_herbs','spore_culture']),
    ('tech',    array['nanochips','antimatter','fusion_cell','sensor_array','neural_processor','quantum_core']),
    ('luxury',  array['spice','gemstones','vintage_wine','perfume_essence','fine_art','exotic_pelts']),
    ('illicit', array['contraband','narcotics','forged_credentials','weapons_cache','bio_toxin'])
  ) as p(cat, ids)
  where p.cat = p_cat;
$$;

-- ===========================================================================
-- Helpers
-- ===========================================================================

-- WORKSHOPCFG.baseSlots + upgrades, capped at maxSlots.
create or replace function app._craft_slots(p_state jsonb)
returns int
language sql immutable as $$
  select least(5, 2 + greatest(0, coalesce((p_state->'workshop'->>'upgrades')::int, 0)));
$$;

-- WORKSHOPCFG.slotUpgradeBase × 1.65^level (Workshop.upgradeCost).
create or replace function app._craft_slot_cost(p_upgrades int)
returns double precision
language sql immutable as $$
  select round((14000 * power(1.65, greatest(0, coalesce(p_upgrades, 0))))::numeric)::float8;
$$;

-- Active blackbox craftTime magnitude, clamped like Workshop.craftMs does.
-- activeBoosts is client-owned, so a forged boost buys time, never an item;
-- the 0.2 floor matches the client's Math.max(0.2, 1 + mag).
create or replace function app._craft_time_mult(p_state jsonb, p_now_ms bigint)
returns double precision
language sql immutable as $$
  select greatest(0.2, 1 + coalesce(sum((app.craft_blackbox(b->>'effectId')->>'mag')::float8), 0))
  from jsonb_array_elements(
    case when jsonb_typeof(p_state->'activeBoosts') = 'array'
         then p_state->'activeBoosts' else '[]'::jsonb end) as b
  where coalesce((b->>'expiresAt')::bigint, 0) > p_now_ms
    and app.craft_blackbox(b->>'effectId')->>'stat' = 'craftTime';
$$;

-- Deterministic gear roll (mirrors Items.gen + Items._name for a fixed
-- kind/rarity). Seeded on the job id so a retried claim can't reroll stats.
create or replace function app.gen_craft_gear(p_uid text, p_job_id text, p_kind text, p_rarity text)
returns jsonb
language plpgsql immutable as $$
declare
  s bigint := market.seed_hash('cosmocrat-market-v1', 'craft', p_job_id);
  kinds text[] := array['engine','reactor','cannon','plating','shield','hold','scanner','probe','survey_shield'];
  labels text[] := array['Engine','Reactor','Cannon','Plating','Shield','Cargo Pod','Deep Scanner','Probe Rack','Survey Shield'];
  stats text[] := array['speed','firepower','firepower','armor','shields','cargo','scan','scan','endure'];
  bases double precision[] := array[0.04, 0.06, 12, 18, 16, 8, 1.5, 1.0, 1.2];
  pcts boolean[] := array[true, true, false, false, false, false, false, false, false];
  brands text[] := array['Vex','Korr','Aether','Nyx','Helion','Dragoon','Orbital','Mechan',
                         'Solar','Pulse','Grav','Volt','Hadron','Quark','Tachy','Umbra'];
  suffixes text[] := array['Howl','Vanguard','Reaver','Whisper','Tempest','Wraith','Sovereign',
                           'Verdict','Eclipse','Onslaught','Paragon','Nemesis','Requiem','Zenith'];
  mks text[] := array['I','II','III','IV','V'];
  ki int;
  bi int;
  mult double precision;
  amount double precision;
  bonus jsonb := null;
  bamount double precision;
  nm text;
  item jsonb;
begin
  ki := coalesce(array_position(kinds, p_kind), 1);
  mult := case p_rarity
    when 'common' then 1.0 when 'uncommon' then 1.5 when 'rare' then 2.3
    when 'epic' then 3.4 when 'legendary' then 5.0 else 1.0 end;
  -- Util.randFloat(0.8, 1.3)
  amount := bases[ki] * mult * (0.8 + market.u01(s, 0) * 0.5);
  if pcts[ki] then amount := round(amount::numeric, 3);
  else amount := round(amount::numeric); end if;

  -- Legendary rolls a second stat on a different kind at 0.6× (Items.gen).
  if p_rarity = 'legendary' then
    bi := 1 + (floor(market.u01(s, 1) * 9)::int % 9);
    if bi = ki then bi := 1 + (bi % 9); end if;
    bamount := bases[bi] * mult * 0.6 * (0.8 + market.u01(s, 2) * 0.5);
    if pcts[bi] then bamount := round(bamount::numeric, 3);
    else bamount := round(bamount::numeric); end if;
    bonus := jsonb_build_object('stat', stats[bi], 'amount', bamount, 'pct', pcts[bi], 'kind', kinds[bi]);
  end if;

  nm := brands[1 + (floor(market.u01(s, 11) * array_length(brands, 1))::int % array_length(brands, 1))]
     || ' Mk.' || mks[1 + (floor(market.u01(s, 10) * 5)::int % 5)]
     || ' ' || labels[ki];
  if p_rarity in ('epic', 'legendary') then
    nm := nm || ' "' || suffixes[1 + (floor(market.u01(s, 12) * array_length(suffixes, 1))::int % array_length(suffixes, 1))] || '"';
  end if;

  item := jsonb_build_object(
    'uid', p_uid, 'kind', p_kind, 'rarity', p_rarity, 'name', nm,
    'primary', jsonb_build_object('stat', stats[ki], 'amount', amount, 'pct', pcts[ki], 'kind', p_kind),
    'bonus', bonus);
  return jsonb_set(item, '{value}', to_jsonb(app.item_value(item)));
end;
$$;

-- Mint a consumable blackbox (Items.genBlackbox + Items.blackboxValue).
create or replace function app.gen_craft_blackbox(p_uid text, p_effect_id text)
returns jsonb
language plpgsql immutable as $$
declare
  e jsonb := app.craft_blackbox(p_effect_id);
begin
  if e is null then return null; end if;
  return jsonb_build_object(
    'uid', p_uid, 'kind', 'blackbox', 'rarity', 'rare',
    'name', (e->>'name') || ' Blackbox',
    'consumable', true, 'effectId', e->>'id',
    'primary', null, 'bonus', null,
    'value', round((6000 * abs((e->>'mag')::float8) * ((e->>'durationMs')::float8 / 7200000.0) / 10)::numeric) * 10);
end;
$$;

-- Mint an extractor (Workshop._deliver extractor branch + Extractors.name).
create or replace function app.gen_craft_extractor(p_uid text, p_job_id text, p_type text,
                                                   p_scope text, p_scope_cat text)
returns jsonb
language plpgsql immutable as $$
declare
  s bigint := market.seed_hash('cosmocrat-market-v1', 'craft', p_job_id);
  cats text[] := array['mineral','gas','agri','tech','luxury','illicit'];
  mfr text[] := array['Korr','Volkov','Cygnus','Drell','Maru','Oort','Tassen','Bell4','Hjar','Nuvo'];
  pool text[];
  scope text := p_scope;
  nm text;
begin
  if p_type = 'specialized' then
    pool := app.craft_scope_pool(coalesce(p_scope_cat, 'mineral'));
    if pool is null or array_length(pool, 1) is null then pool := array['iron_ore']; end if;
    scope := pool[1 + (floor(market.u01(s, 3) * array_length(pool, 1))::int % array_length(pool, 1))];
  elsif p_type = 'semi' then
    scope := coalesce(nullif(p_scope, ''), cats[1 + (floor(market.u01(s, 3) * 6)::int % 6)]);
  else
    scope := 'all';
  end if;

  nm := mfr[1 + (floor(market.u01(s, 10) * 10)::int % 10)] || ' ' || case p_type
    when 'specialized' then initcap(replace(scope, '_', ' ')) || ' '
      || (array['Rig','Borer','Driver','Extractor'])[1 + (floor(market.u01(s, 11) * 4)::int % 4)]
    when 'semi' then initcap(scope) || ' '
      || (array['Harvester','Processor','Refinery','Works'])[1 + (floor(market.u01(s, 11) * 4)::int % 4)]
    else (array['Universal','Omni','All-Purpose','Versatile'])[1 + (floor(market.u01(s, 12) * 4)::int % 4)]
      || ' ' || (array['Array','Plant','Unit','Fabricator'])[1 + (floor(market.u01(s, 11) * 4)::int % 4)]
  end;

  return jsonb_build_object('uid', p_uid, 'type', p_type, 'scope', scope,
                            'name', nm, 'components', '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- app_craft_start — validate, charge, queue
-- ===========================================================================
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
    used := (select count(*)::int from jsonb_object_keys(coalesce(st->'items', '{}'::jsonb)));
    cap := coalesce((st->'inventory'->>'capacity')::int, 6);
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

-- ===========================================================================
-- app_craft_claim — deliver everything whose readyAt has passed
-- ===========================================================================
create or replace function public.app_craft_claim()
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  job jsonb;
  recipe jsonb;
  keep jsonb := '[]'::jsonb;
  done jsonb := '[]'::jsonb;
  items jsonb;
  extractors jsonb;
  ships jsonb;
  known jsonb;
  burned jsonb;
  seq int;
  n int := 0;
  it jsonb;
  ex jsonb;
  sh jsonb;
  scope_cat text;
  label text;
  uid text;
  already boolean;
begin
  st := app._lock_state(now_ms);
  if st is null then
    return jsonb_build_object('ok', false, 'error', 'no player row yet');
  end if;

  items := coalesce(st->'items', '{}'::jsonb);
  extractors := coalesce(st->'extractors', '{}'::jsonb);
  ships := coalesce(st->'ships', '[]'::jsonb);
  known := coalesce(st->'knownRecipes', '[]'::jsonb);
  burned := coalesce(st->'craftedOnce', '[]'::jsonb);
  seq := coalesce((st->>'seq')::int, 1);

  for job in select t.v from jsonb_array_elements(
      case when jsonb_typeof(st->'workshop'->'queue') = 'array'
           then st->'workshop'->'queue' else '[]'::jsonb end) as t(v) loop
    recipe := app.craft_recipe(job->>'recipeId');
    -- WORKSHOPCFG.maxResolvePerCatchup = 12 per call; the rest stay queued.
    if recipe is null then
      -- Unknown recipe (an admin renamed or removed it): park the job. The
      -- ingredients were already charged, so dropping it would destroy them —
      -- restoring the recipe id lets it finish. Matches Workshop._resolveLocal.
      keep := keep || jsonb_build_array(job);
      continue;
    elsif n >= 12 or coalesce((job->>'readyAt')::bigint, 0) > now_ms then
      keep := keep || jsonb_build_array(job);
      continue;
    end if;
    n := n + 1;
    label := recipe->>'name';
    -- Deterministic uid from job id so a retried claim (stale app_commit putting
    -- the finished job back on the queue) upserts the same row instead of minting
    -- another Mechan Mk.III Plating every tick.
    uid := 'craft-' || coalesce(nullif(job->>'id', ''), 'x' || n);

    if recipe->>'outputType' = 'gear' then
      already := items ? uid;
      it := app.gen_craft_gear(uid, job->>'id',
                               recipe->'output'->>'kind', recipe->'output'->>'rarity');
      items := jsonb_set(items, array[it->>'uid'], it, true);
      label := it->>'name';
      if already then continue; end if;   -- drop job, do not re-announce
    elsif recipe->>'outputType' = 'blackbox' then
      already := items ? uid;
      it := app.gen_craft_blackbox(uid, recipe->'output'->>'effectId');
      if it is not null then
        items := jsonb_set(items, array[it->>'uid'], it, true);
        label := it->>'name';
      end if;
      if already then continue; end if;
    elsif recipe->>'outputType' = 'extractor' then
      already := extractors ? uid;
      select f.v->>'scopeCat' into scope_cat
        from jsonb_array_elements(coalesce(recipe->'flavor', '[]'::jsonb)) as f(v)
       where f.v->>'id' = job->>'flavorId' limit 1;
      ex := app.gen_craft_extractor(uid, job->>'id',
                                    recipe->'output'->>'extractorType',
                                    recipe->'output'->>'scope', scope_cat);
      extractors := jsonb_set(extractors, array[ex->>'uid'], ex, true);
      label := ex->>'name';
      if already then continue; end if;
    elsif recipe->>'outputType' = 'ship' then
      -- Idempotent on craftJobId (same role as craft-<jobId> for gear) so a
      -- re-queued finish can't append a second hull. Unique recipes also refuse
      -- a second copy of the hull type.
      if exists (
        select 1 from jsonb_array_elements(ships) as s2(v)
         where s2.v->>'craftJobId' = job->>'id') then
        continue;
      end if;
      if (recipe->>'unique')::boolean and exists (
        select 1 from jsonb_array_elements(ships) as s2(v)
         where s2.v->>'type' = recipe->'output'->>'shipType') then
        continue;
      end if;
      seq := seq + 1;
      sh := app.make_ship(seq, recipe->'output'->>'shipType', null, false, null);
      if sh is null then
        -- Hull missing from app.ship_def (re-apply phase2_missions_bazaar.sql).
        -- Park the job instead of dropping it: the ingredients are already spent,
        -- so a silent drop would destroy them. It builds once the def exists.
        keep := keep || jsonb_build_array(job);
        n := n - 1;
        seq := seq - 1;
        continue;
      end if;
      sh := jsonb_set(sh, '{craftJobId}', to_jsonb(job->>'id'), true);
      ships := ships || jsonb_build_array(sh);
      label := sh->>'name';
    end if;

    -- One-of-a-kind blueprint burns on delivery (Workshop._deliver).
    if (recipe->>'destroyOnUse')::boolean then
      if not (burned ? (recipe->>'id')) then
        burned := burned || jsonb_build_array(to_jsonb(recipe->>'id'));
      end if;
      select coalesce(jsonb_agg(k.v), '[]'::jsonb) into known
        from jsonb_array_elements(known) as k(v) where k.v <> to_jsonb(recipe->>'id');
    end if;

    done := done || jsonb_build_array(jsonb_build_object(
      'recipeId', recipe->>'id', 'name', label, 'outputType', recipe->>'outputType',
      'jobId', job->>'id'));
  end loop;

  st := jsonb_set(st, '{items}', items);
  st := jsonb_set(st, '{extractors}', extractors);
  st := jsonb_set(st, '{ships}', ships);
  st := jsonb_set(st, '{knownRecipes}', known);
  st := jsonb_set(st, '{craftedOnce}', burned);
  st := jsonb_set(st, '{seq}', to_jsonb(seq));
  if st->'workshop' is null or jsonb_typeof(st->'workshop') <> 'object' then
    st := jsonb_set(st, '{workshop}', '{"upgrades":0,"queue":[]}'::jsonb, true);
  end if;
  st := jsonb_set(st, '{workshop,queue}', keep, true);

  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('delivered', done);
end;
$$;

-- ===========================================================================
-- app_craft_slot — buy a Workshop slot upgrade
-- ===========================================================================
create or replace function public.app_craft_slot()
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  ups int;
  cost double precision;
  credits double precision;
begin
  st := app._lock_state(now_ms);
  if st is null then
    return jsonb_build_object('ok', false, 'error', 'no player row yet');
  end if;
  ups := greatest(0, coalesce((st->'workshop'->>'upgrades')::int, 0));
  if app._craft_slots(st) >= 5 then
    return jsonb_build_object('ok', false, 'error', 'Workshop is fully expanded.');
  end if;
  cost := app._craft_slot_cost(ups);
  credits := coalesce((st->>'credits')::float8, 0);
  if cost > credits then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
  end if;
  if st->'workshop' is null or jsonb_typeof(st->'workshop') <> 'object' then
    st := jsonb_set(st, '{workshop}', '{"upgrades":0,"queue":[]}'::jsonb, true);
  end if;
  st := jsonb_set(st, '{workshop,upgrades}', to_jsonb(ups + 1), true);
  st := jsonb_set(st, '{credits}', to_jsonb(credits - cost));
  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('cost', cost, 'slots', app._craft_slots(st));
end;
$$;

-- ===========================================================================
-- app_craft_adopt — ONE-TIME migration for saves that predate this file
-- ===========================================================================
-- Every existing player has Workshop state the server has never seen: crafted
-- items sitting in the browser, in-flight queue jobs, and slot upgrades. Without
-- this they all disappear the moment the queue becomes server-owned, so the
-- first client boot after the migration offers its local copy exactly once.
--
-- It deliberately allows a few calls rather than exactly one: a player whose
-- gear is sitting in a `starbaron.corrupt` wipe backup has to run Settings →
-- Restore backup first, which may happen after the boot that already adopted.
--
-- Bounded so it can't become a minting API:
--   • at most 3 calls and 12 adopted items per account, ever
--     (state.workshopAdopt = {calls, items, at});
--   • only uids the server pool doesn't already have;
--   • items must look like a recipe output (a craftable kind + rarity, or a
--     known blackbox effect); stats and value are re-rolled server-side, so a
--     hand-edited backup gets an ordinary item of that kind, not its numbers;
--   • the item pool can't exceed inventory capacity;
--   • the queue is only adopted while the server queue is empty, capped at the
--     slot count, and readyAt is floored to startedAt so a backdated job can't
--     be claimed earlier than it should be.
create or replace function public.app_craft_adopt(p_workshop jsonb, p_items jsonb)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  items jsonb;
  queue jsonb := '[]'::jsonb;
  job jsonb;
  recipe jsonb;
  it jsonb;
  uid text;
  cap int;
  used int;
  slots int;
  ups int;
  adopted_items int := 0;
  adopted_jobs int := 0;
  ready bigint;
  started bigint;
  calls int;
  lifetime int;
  budget int;
begin
  st := app._lock_state(now_ms);
  if st is null then
    return jsonb_build_object('ok', false, 'error', 'no player row yet');
  end if;

  calls := coalesce((st->'workshopAdopt'->>'calls')::int, 0);
  lifetime := coalesce((st->'workshopAdopt'->>'items')::int, 0);
  if calls >= 3 or lifetime >= 12 then
    return jsonb_build_object('ok', false, 'error', 'adopt limit reached', 'state', st);
  end if;
  budget := 12 - lifetime;

  items := coalesce(st->'items', '{}'::jsonb);
  cap := coalesce((st->'inventory'->>'capacity')::int, 6);

  -- Slot upgrades: take the higher of the two, capped at maxSlots - baseSlots.
  ups := greatest(
    greatest(0, coalesce((st->'workshop'->>'upgrades')::int, 0)),
    least(3, greatest(0, coalesce((p_workshop->>'upgrades')::int, 0))));

  -- Crafted items the server never saw.
  if jsonb_typeof(p_items) = 'object' then
    for uid, it in select * from jsonb_each(p_items) loop
      used := (select count(*)::int from jsonb_object_keys(items));
      exit when used >= cap or adopted_items >= budget;
      continue when items ? uid;
      continue when jsonb_typeof(it) <> 'object' or coalesce(it->>'uid', '') <> uid;
      if coalesce(it->>'kind', '') = 'blackbox' then
        it := app.gen_craft_blackbox(uid, it->>'effectId');
        continue when it is null;   -- unknown effect id
      else
        -- Only accept shapes the Workshop can actually produce, then re-roll the
        -- stats server-side from the claimed kind/rarity — a hand-edited backup
        -- must not be able to smuggle in inflated numbers or a bogus value.
        continue when coalesce(it->>'kind', '') not in
          ('engine','reactor','cannon','plating','shield','hold','scanner','probe','survey_shield');
        continue when coalesce(it->>'rarity', '') not in
          ('common','uncommon','rare','epic','legendary');
        it := app.gen_craft_gear(uid, uid, it->>'kind', it->>'rarity');
      end if;
      items := jsonb_set(items, array[uid], it, true);
      adopted_items := adopted_items + 1;
    end loop;
  end if;

  -- In-flight jobs (the recipe must exist; readyAt can't precede startedAt).
  -- Only while the server queue is empty, so repeat calls can't stack jobs.
  slots := least(5, 2 + ups);
  if jsonb_typeof(p_workshop->'queue') = 'array'
     and jsonb_array_length(case when jsonb_typeof(st->'workshop'->'queue') = 'array'
                                 then st->'workshop'->'queue' else '[]'::jsonb end) = 0 then
    for job in select t.v from jsonb_array_elements(p_workshop->'queue') as t(v) loop
      exit when jsonb_array_length(queue) >= slots;
      recipe := app.craft_recipe(job->>'recipeId');
      continue when recipe is null or job->>'id' is null;
      started := coalesce((job->>'startedAt')::bigint, now_ms);
      ready := greatest(coalesce((job->>'readyAt')::bigint, now_ms), started);
      queue := queue || jsonb_build_array(jsonb_build_object(
        'id', job->>'id', 'recipeId', job->>'recipeId',
        'startedAt', started, 'readyAt', ready,
        'flavorId', job->>'flavorId'));
      adopted_jobs := adopted_jobs + 1;
    end loop;
  end if;

  st := jsonb_set(st, '{items}', items);
  -- An empty adopted queue must not wipe a queue the server already had.
  if jsonb_array_length(queue) > 0
     or jsonb_typeof(st->'workshop'->'queue') <> 'array' then
    st := jsonb_set(st, '{workshop}', jsonb_build_object('upgrades', ups, 'queue', queue), true);
  else
    st := jsonb_set(st, '{workshop,upgrades}', to_jsonb(ups), true);
  end if;
  st := jsonb_set(st, '{workshopAdopt}', jsonb_build_object(
    'calls', calls + 1, 'items', lifetime + adopted_items, 'at', now_ms), true);
  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('adoptedItems', adopted_items, 'adoptedJobs', adopted_jobs);
end;
$$;

-- ===========================================================================
-- result_slice + app_commit — carry and protect the workshop slice
-- ===========================================================================
-- Same as docs/sql/phase3_pull_prestige.sql plus `workshop` / `workshopAdoptedAt`,
-- so every craft RPC hands the client its authoritative queue back.
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
    'lastSeenAt', (p_state->>'lastSeenAt')::bigint
  );
$$;

-- Same as docs/sql/equip_persist.sql (the last file to replace app_commit, so
-- it is the one to extend — NOT phase3's, whose ships line predates the fitment
-- merge) plus the workshop override. The queue must be server-owned: it is now
-- the receipt that says an item was paid for, so a client that could append to
-- it could mint gear for free.
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
  -- (docs/sql/equip_persist.sql — forcing the server array here would drop every
  -- equipped accessory on the next save).
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
  -- knownRecipes / craftedOnce stay client-owned — blueprints still drop from
  -- sources with no RPC, and the ingredient/credit cost is charged server-side.
  merged := jsonb_set(merged, '{workshop}', coalesce(server->'workshop',
    '{"upgrades":0,"queue":[]}'::jsonb));
  if server ? 'workshopAdopt' then
    merged := jsonb_set(merged, '{workshopAdopt}', server->'workshopAdopt', true);
  else
    merged := merged - 'workshopAdopt';
  end if;

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

  perform app._write_state(merged, now_ms);
  return jsonb_build_object('ok', true, 'state', merged);
end;
$$;

grant execute on function public.app_craft_start(text, text) to authenticated;
grant execute on function public.app_craft_claim() to authenticated;
grant execute on function public.app_craft_slot() to authenticated;
grant execute on function public.app_craft_adopt(jsonb, jsonb) to authenticated;
