-- phase2_flavor_names.sql
-- Paste in Supabase SQL editor AFTER phase2_missions_bazaar.sql (and ideally
-- before/with phase3). Replaces stub names ("Battleship", "Shield uncommon",
-- "Battleship Merc 0") with the same flavor pools the client uses.
-- Cosmetic only — prices/stats/uids unchanged.

-- Merc company names (MERC_PREFIX × MERC_UNIT, seeds 10/11 — match js/bazaar.js)
create or replace function app.gen_merc(p_epoch bigint, p_slot int)
returns jsonb
language plpgsql immutable as $$
declare
  s bigint := market.seed_hash('cosmocrat-market-v1', 'bazaar', 'merc', p_epoch::text, p_slot::text);
  -- Order/length must match SHIP_CATALOG.escort in js/data.js (genSeededMerc).
  escorts text[] := array['gunboat','corvette','destroyer','frigate','cruiser','carrier','battleship'];
  prefixes text[] := array['Red','Iron','Ash','Storm','Void','Grim','Gilt','Razor','Black','Free'];
  units text[] := array['Talons','Lances','Wolves','Reavers','Hounds','Vultures','Sabres','Corsairs','Jackals','Ravens'];
  ship_type text;
  def record;
  hire double precision;
  service_ms bigint;
  nm text;
  n int;
begin
  n := array_length(escorts, 1);
  ship_type := escorts[1 + (floor(market.u01(s, 0) * n)::int % n)];
  select * into def from app.ship_def(ship_type);
  hire := round((def.price * 0.2 + def.firepower * 55)::numeric);
  service_ms := (15 + floor(market.u01(s, 1) * 26)::int) * 60 * 1000;
  nm := prefixes[1 + (floor(market.u01(s, 10) * array_length(prefixes, 1))::int % array_length(prefixes, 1))]
     || ' '
     || units[1 + (floor(market.u01(s, 11) * array_length(units, 1))::int % array_length(units, 1))];
  return jsonb_build_object(
    'id', 'mc-' || p_epoch || '-' || p_slot,
    'shipType', ship_type,
    'name', nm,
    'firepower', def.firepower,
    'hull', def.hull,
    'serviceMs', service_ms,
    'hireCost', hire
  );
end;
$$;

-- Accessory flavor names (ITEM_BRANDS + Mk + kind label [+ suffix for epic])
create or replace function app.gen_accessory(p_epoch bigint, p_slot int)
returns jsonb
language plpgsql immutable as $$
declare
  s bigint := market.seed_hash('cosmocrat-market-v1', 'bazaar', 'acc', p_epoch::text, p_slot::text);
  -- Order/length must match Object.keys(ACCESSORY_KINDS) insertion order in js/data.js.
  kinds text[] := array['engine','reactor','cannon','plating','shield','hold','scanner','probe','survey_shield'];
  labels text[] := array['Engine','Reactor','Cannon','Plating','Shield','Cargo Pod','Deep Scanner','Probe Rack','Survey Shield'];
  brands text[] := array['Vex','Korr','Aether','Nyx','Helion','Dragoon','Orbital','Mechan',
                         'Solar','Pulse','Grav','Volt','Hadron','Quark','Tachy','Umbra'];
  suffixes text[] := array['Howl','Vanguard','Reaver','Whisper','Tempest','Wraith','Sovereign',
                           'Verdict','Eclipse','Onslaught','Paragon','Nemesis','Requiem','Zenith'];
  mks text[] := array['I','II','III','IV','V'];
  kind text;
  bases double precision[] := array[0.04, 0.06, 12, 18, 16, 8, 1.5, 1.0, 1.2];
  pcts boolean[] := array[true, true, false, false, false, false, false, false, false];
  ki int;
  n int;
  roll double precision;
  rarity text;
  mult double precision;
  price_mult double precision;
  amount double precision;
  item jsonb;
  val double precision;
  price double precision;
  nm text;
begin
  n := array_length(kinds, 1);
  ki := 1 + (floor(market.u01(s, 0) * n)::int % n);
  kind := kinds[ki];
  roll := market.u01(s, 1);
  if roll < 0.50 then rarity := 'common'; mult := 1.0; price_mult := 1.0;
  elsif roll < 0.78 then rarity := 'uncommon'; mult := 1.5; price_mult := 2.2;
  elsif roll < 0.92 then rarity := 'rare'; mult := 2.3; price_mult := 5.0;
  else rarity := 'epic'; mult := 3.4; price_mult := 12.0;
  end if;
  amount := bases[ki] * mult * (0.8 + market.u01(s, 2) * 0.5);
  if pcts[ki] then amount := round(amount::numeric, 3);
  else amount := round(amount::numeric); end if;
  nm := brands[1 + (floor(market.u01(s, 11) * array_length(brands, 1))::int % array_length(brands, 1))]
     || ' Mk.' || mks[1 + (floor(market.u01(s, 10) * 5)::int % 5)]
     || ' ' || labels[ki];
  if rarity = 'epic' then
    nm := nm || ' "' || suffixes[1 + (floor(market.u01(s, 12) * array_length(suffixes, 1))::int % array_length(suffixes, 1))] || '"';
  end if;
  item := jsonb_build_object(
    'uid', 'i' || p_epoch || 'a' || p_slot,
    'kind', kind,
    'rarity', rarity,
    'name', nm,
    'primary', jsonb_build_object(
      'stat', case kind
        when 'engine' then 'speed' when 'reactor' then 'firepower'
        when 'cannon' then 'firepower' when 'plating' then 'armor'
        when 'shield' then 'shields' when 'hold' then 'cargo'
        when 'scanner' then 'scan' when 'probe' then 'scan'
        when 'survey_shield' then 'endure' else 'cargo' end,
      'amount', amount,
      'pct', pcts[ki],
      'kind', kind
    ),
    'bonus', null
  );
  val := app.item_value(item);
  item := jsonb_set(item, '{value}', to_jsonb(val));
  price := round((val * (0.95 + market.u01(s, 3) * 0.30))::numeric);
  return jsonb_build_object(
    'id', 'ac-' || p_epoch || '-' || p_slot,
    'item', item,
    'price', price
  );
end;
$$;

-- Owned ships: generate Iron Widow–style names when p_name is null (catalog buys).
create or replace function app.make_ship(p_seq int, p_type text, p_name text,
  p_merc boolean, p_expires bigint)
returns jsonb
language plpgsql immutable as $$
declare
  def record;
  a text[] := array['Iron','Crimson','Silent','Void','Star','Ghost','Onyx','Gilded',
                    'Howling','Drift','Pale','Hollow','Burning','Twin','Last','Lucky','Black','Wandering'];
  b text[] := array['Widow','Vagrant','Lance','Verdict','Sparrow','Maw','Comet','Promise',
                    'Reaver','Mistral','Talon','Harbinger','Sovereign','Drake','Errant','Petrel','Coil','Wake'];
  s bigint;
  nm text;
begin
  select * into def from app.ship_def(p_type);
  if def.id is null then return null; end if;
  if nullif(p_name, '') is not null then
    nm := p_name;
  else
    s := market.seed_hash('cosmocrat-market-v1', 'shipname', p_seq::text, p_type);
    nm := a[1 + (floor(market.u01(s, 0) * array_length(a, 1))::int % array_length(a, 1))]
       || ' '
       || b[1 + (floor(market.u01(s, 1) * array_length(b, 1))::int % array_length(b, 1))];
  end if;
  return jsonb_build_object(
    'uid', 's' || p_seq,
    'type', p_type,
    'cls', def.cls,
    'name', nm,
    'status', 'idle',
    'accessories', '[]'::jsonb,
    'mercenary', coalesce(p_merc, false),
    'expiresAt', p_expires,
    'retrieveCost', 0,
    'dmg', 0
  );
end;
$$;
