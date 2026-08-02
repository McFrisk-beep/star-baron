-- Expand market.commodity to the full COMMODITIES list in js/data.js.
-- Required after the crafting-phase commodity expansion: without this, signed-in
-- trade / routes / industry return "Unknown commodity" for new resources
-- (e.g. Exotic Pelts). Safe to re-run. Guests are unaffected (client-side prices).
--
-- Supabase → SQL Editor → paste & Run.

create or replace function market.commodity(p_id text)
returns table(id text, cat text, base double precision, vol double precision)
language sql immutable as $$
  select * from (values
    -- Minerals
    ('iron_ore',         'mineral', 40::float8,  0.04::float8),
    ('silicon',          'mineral', 65,          0.05),
    ('rare_earths',      'mineral', 220,         0.09),
    ('titanium_ore',     'mineral', 150,         0.07),
    ('cobalt_ore',       'mineral', 90,          0.06),
    ('graphene_lattice', 'mineral', 260,         0.09),
    ('pulsar_shard',     'mineral', 680,         0.17),
    ('voidstone',        'mineral', 1400,        0.20),
    -- Gas
    ('hydrogen',         'gas',     30,          0.05),
    ('helium3',          'gas',     180,         0.08),
    ('water_ice',        'gas',     25,          0.06),
    ('plasma_gas',       'gas',     210,         0.10),
    ('methane_slurry',   'gas',     85,          0.06),
    ('xenon_gas',        'gas',     260,         0.11),
    ('cryo_vapor',       'gas',     340,         0.12),
    ('quantum_foam',     'gas',     1100,        0.19),
    -- Agri
    ('foodstuffs',       'agri',    55,          0.05),
    ('synthsilk',        'agri',    140,         0.07),
    ('grain',            'agri',    35,          0.04),
    ('protein_stock',    'agri',    70,          0.05),
    ('hydro_greens',     'agri',    50,          0.05),
    ('algae_paste',      'agri',    45,          0.05),
    ('biofiber',         'agri',    160,         0.08),
    ('nectar_extract',   'agri',    190,         0.08),
    ('medicinal_herbs',  'agri',    200,         0.09),
    ('spore_culture',    'agri',    380,         0.14),
    -- Tech
    ('nanochips',        'tech',    320,         0.10),
    ('antimatter',       'tech',    900,         0.14),
    ('fusion_cell',      'tech',    260,         0.08),
    ('sensor_array',     'tech',    410,         0.11),
    ('neural_processor', 'tech',    560,         0.13),
    ('quantum_core',     'tech',    750,         0.13),
    ('ai_matrix',        'tech',    2200,        0.22),
    -- Luxury
    ('spice',            'luxury',  260,         0.12),
    ('gemstones',        'luxury',  300,         0.10),
    ('vintage_wine',     'luxury',  180,         0.08),
    ('perfume_essence',  'luxury',  220,         0.09),
    ('fine_art',         'luxury',  420,         0.13),
    ('exotic_pelts',     'luxury',  520,         0.15),
    -- Illicit
    ('contraband',         'illicit', 480,       0.18),
    ('narcotics',          'illicit', 340,       0.16),
    ('forged_credentials', 'illicit', 410,       0.15),
    ('weapons_cache',      'illicit', 600,       0.17),
    ('bio_toxin',          'illicit', 720,       0.19),
    ('cipher_shard',       'illicit', 950,       0.21)
  ) as c(id, cat, base, vol)
  where c.id = p_id;
$$;
