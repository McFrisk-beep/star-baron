-- Expand market.commodity + event_slot pools to match js/data.js COMMODITIES.
-- Required after the crafting-phase commodity expansion: without this, signed-in
-- trade / routes return "Unknown commodity", and galactic/local event slots
-- disagree with the client (~30–40% of slots pick a single commodity).
--
-- v2: market.commodity now also returns craft_only (mirrors data.js craftOnly).
-- Station RPCs (app_station_after_hour and friends) read comm.craft_only —
-- without this re-paste they fail with `record "comm" has no field "craft_only"`.
--
-- Canonical copy lives in docs/sql/market_price.sql — keep this patch in sync
-- when editing that file (enforced by tools/check_sql_patch_sync.js). Safe to
-- re-run. Guests are unaffected.
--
-- Supabase → SQL Editor → paste & Run.
--
-- If Phase 3 / ballot are already installed, also re-paste:
--   • docs/sql/phase3_pull_prestige.sql (app.gen_extractor) — THIS REROLLS every
--     seeded extractor offer currently on the Bazaar board. Owned extractors
--     keep their granted scope; only live offers shift.
--   • docs/sql/senate_ballot.sql — same stale 12-id commodity list.

-- ── commodity lookup (all 45) ──────────────────────────────────────────────
create or replace function market.commodity(p_id text)
returns table(id text, cat text, base double precision, vol double precision, craft_only boolean)
language sql immutable as $$
  select * from (values
    -- Minerals
    ('iron_ore',         'mineral', 40::float8,  0.04::float8, false),
    ('silicon',          'mineral', 65,          0.05, false),
    ('rare_earths',      'mineral', 220,         0.09, false),
    ('titanium_ore',     'mineral', 150,         0.07, false),
    ('cobalt_ore',       'mineral', 90,          0.06, false),
    ('graphene_lattice', 'mineral', 260,         0.09, false),
    ('pulsar_shard',     'mineral', 680,         0.17, false),
    ('voidstone',        'mineral', 1400,        0.20, true),
    -- Gas
    ('hydrogen',         'gas',     30,          0.05, false),
    ('helium3',          'gas',     180,         0.08, false),
    ('water_ice',        'gas',     25,          0.06, false),
    ('plasma_gas',       'gas',     210,         0.10, false),
    ('methane_slurry',   'gas',     85,          0.06, false),
    ('xenon_gas',        'gas',     260,         0.11, false),
    ('cryo_vapor',       'gas',     340,         0.12, false),
    ('quantum_foam',     'gas',     1100,        0.19, true),
    -- Agri
    ('foodstuffs',       'agri',    55,          0.05, false),
    ('synthsilk',        'agri',    140,         0.07, false),
    ('grain',            'agri',    35,          0.04, false),
    ('protein_stock',    'agri',    70,          0.05, false),
    ('hydro_greens',     'agri',    50,          0.05, false),
    ('algae_paste',      'agri',    45,          0.05, false),
    ('biofiber',         'agri',    160,         0.08, false),
    ('nectar_extract',   'agri',    190,         0.08, false),
    ('medicinal_herbs',  'agri',    200,         0.09, false),
    ('spore_culture',    'agri',    380,         0.14, false),
    -- Tech
    ('nanochips',        'tech',    320,         0.10, false),
    ('antimatter',       'tech',    900,         0.14, false),
    ('fusion_cell',      'tech',    260,         0.08, false),
    ('sensor_array',     'tech',    410,         0.11, false),
    ('neural_processor', 'tech',    560,         0.13, false),
    ('quantum_core',     'tech',    750,         0.13, false),
    ('ai_matrix',        'tech',    2200,        0.22, true),
    -- Luxury
    ('spice',            'luxury',  260,         0.12, false),
    ('gemstones',        'luxury',  300,         0.10, false),
    ('vintage_wine',     'luxury',  180,         0.08, false),
    ('perfume_essence',  'luxury',  220,         0.09, false),
    ('fine_art',         'luxury',  420,         0.13, false),
    ('exotic_pelts',     'luxury',  520,         0.15, false),
    -- Illicit
    ('contraband',         'illicit', 480,       0.18, false),
    ('narcotics',          'illicit', 340,       0.16, false),
    ('forged_credentials', 'illicit', 410,       0.15, false),
    ('weapons_cache',      'illicit', 600,       0.17, false),
    ('bio_toxin',          'illicit', 720,       0.19, false),
    ('cipher_shard',       'illicit', 950,       0.21, true)
  ) as c(id, cat, base, vol, craft_only)
  where c.id = p_id;
$$;

-- ── event slots (41 tradeable ids — exclude craftOnly) ─────────────────────
create or replace function market.event_slot(p_kind text, p_slot bigint)
returns table(target text, mult double precision)
language plpgsql immutable strict as $$
declare
  seed_base text := 'cosmocrat-market-v1';
  s bigint := market.seed_hash(seed_base, p_kind, 'slot', p_slot::text);
  cats text[] := array['mineral','gas','agri','tech','luxury','illicit'];
  comms text[] := array[
    'iron_ore','silicon','rare_earths','titanium_ore','cobalt_ore','graphene_lattice','pulsar_shard',
    'hydrogen','helium3','water_ice','plasma_gas','methane_slurry','xenon_gas','cryo_vapor',
    'foodstuffs','synthsilk','grain','protein_stock','hydro_greens','algae_paste','biofiber',
    'nectar_extract','medicinal_herbs','spore_culture',
    'nanochips','antimatter','fusion_cell','sensor_array','neural_processor','quantum_core',
    'spice','gemstones','vintage_wine','perfume_essence','fine_art','exotic_pelts',
    'contraband','narcotics','forged_credentials','weapons_cache','bio_toxin'
  ];
  n int := array_length(comms, 1);
  pick_cat boolean;
  up boolean;
  tgt text;
  m double precision;
begin
  pick_cat := market.u01(s, 0) < 0.7;
  if pick_cat then
    tgt := cats[1 + floor(market.u01(s, 1) * 6)::int % 6];
  else
    tgt := comms[1 + floor(market.u01(s, 1) * n)::int % n];
  end if;
  up := market.u01(s, 2) < 0.55;
  if up then m := 1.15 + market.u01(s, 3) * 0.55;
  else m := 0.55 + market.u01(s, 3) * 0.30;
  end if;
  return query select tgt, m;
end;
$$;

create or replace function market.event_slot_local(p_system text, p_slot bigint)
returns table(target text, mult double precision)
language plpgsql immutable strict as $$
declare
  seed_base text := 'cosmocrat-market-v1';
  s bigint := market.seed_hash(seed_base, 'local', p_system, 'slot', p_slot::text);
  cats text[] := array['mineral','gas','agri','tech','luxury','illicit'];
  comms text[] := array[
    'iron_ore','silicon','rare_earths','titanium_ore','cobalt_ore','graphene_lattice','pulsar_shard',
    'hydrogen','helium3','water_ice','plasma_gas','methane_slurry','xenon_gas','cryo_vapor',
    'foodstuffs','synthsilk','grain','protein_stock','hydro_greens','algae_paste','biofiber',
    'nectar_extract','medicinal_herbs','spore_culture',
    'nanochips','antimatter','fusion_cell','sensor_array','neural_processor','quantum_core',
    'spice','gemstones','vintage_wine','perfume_essence','fine_art','exotic_pelts',
    'contraband','narcotics','forged_credentials','weapons_cache','bio_toxin'
  ];
  n int := array_length(comms, 1);
  pick_cat boolean;
  up boolean;
  tgt text;
  m double precision;
begin
  pick_cat := market.u01(s, 0) < 0.6;
  if pick_cat then
    tgt := cats[1 + floor(market.u01(s, 1) * 6)::int % 6];
  else
    tgt := comms[1 + floor(market.u01(s, 1) * n)::int % n];
  end if;
  up := market.u01(s, 2) < 0.5;
  if up then m := 1.2 + market.u01(s, 3) * 0.5;
  else m := 0.5 + market.u01(s, 3) * 0.35;
  end if;
  return query select tgt, m;
end;
$$;
