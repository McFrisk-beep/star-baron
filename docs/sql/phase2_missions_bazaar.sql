-- Phase 2 — authoritative missions & bazaar (Supabase / Postgres)
-- Requires: docs/sql/market_price.sql + docs/sql/phase1_players.sql
-- Paste into SQL Editor and Run. See docs/PHASE2_SETUP.md.
--
-- Trust model: bazaar offers and mission contracts are a seeded function of
-- (MARKETCFG.seed, epoch, slot). Purchase/take/launch RPCs RECOMPUTE the offer
-- server-side — never trust client-supplied prices, rewards, or item values.

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Ship catalog — keep in sync with SHIP_CATALOG in js/data.js
-- ---------------------------------------------------------------------------
create or replace function app.ship_def(p_id text)
returns table(
  id text, cls text, price double precision, firepower double precision,
  cargo double precision, hull double precision, speed double precision
)
language sql immutable as $$
  select * from (values
    ('mule',       'transport', 0::float8,      1::float8,  12::float8, 40::float8,  1.5::float8),
    ('drift',      'transport', 4200,           2,          40,          80,          1.2),
    ('bulk',       'transport', 16000,          3,          120,         160,         1.0),
    ('leviathan',  'transport', 60000,          5,          400,         320,         0.8),
    ('corvette',   'escort',    11000,          25,         4,           120,         1.8),
    ('frigate',    'escort',    32000,          55,         8,           240,         1.5),
    ('cruiser',    'escort',    95000,          120,        14,          480,         1.2),
    ('battleship', 'escort',    270000,         260,        20,          900,         1.0),
    ('pinnace',    'main',      0,              0,          0,           200,         1.0),
    ('yacht',      'main',      24000,          0,          0,           320,         1.6),
    ('flagship',   'main',      140000,         0,          0,           640,         2.2),
    ('dreadnought','main',      650000,         0,          0,           1300,        3.0)
  ) as s(id, cls, price, firepower, cargo, hull, speed)
  where s.id = p_id;
$$;

-- DANGER.pay / baseSuccess — match js/data.js DANGER
create or replace function app.danger_pay(p_danger text)
returns double precision
language sql immutable as $$
  select case p_danger
    when 'safe' then 1.0 when 'low' then 1.4 when 'moderate' then 2.0
    when 'high' then 2.8 when 'extreme' then 3.8 else 1.0 end;
$$;

create or replace function app.danger_base_success(p_danger text)
returns double precision
language sql immutable as $$
  select case p_danger
    when 'safe' then 0.98 when 'low' then 0.85 when 'moderate' then 0.6
    when 'high' then 0.4 when 'extreme' then 0.25 else 0.6 end;
$$;

create or replace function app.fleet_cap(p_tier int)
returns int
language sql immutable as $$
  select case greatest(0, coalesce(p_tier, 0))
    when 0 then 3 when 1 then 4 when 2 then 5 when 3 then 6
    when 4 then 7 when 5 then 8 else 10 end;
$$;

-- Reputation edges: use SERVER standing only (commit protects reputation).
create or replace function app.rep_discount(p_state jsonb)
returns double precision
language plpgsql immutable as $$
declare
  best double precision := 0;
  v double precision;
  fac text;
begin
  foreach fac in array array['syndicate','mining_combine','free_trade','agri_collective'] loop
    v := coalesce((p_state->'reputation'->>fac)::float8, 0);
    if v > best then best := v; end if;
  end loop;
  return greatest(0, least(0.10, (best / 100.0) * 0.10));
end;
$$;

create or replace function app.rep_reward_mult(p_state jsonb, p_faction text)
returns double precision
language plpgsql immutable as $$
declare
  standing double precision;
begin
  if p_faction is null or p_faction = '' then return 1.0; end if;
  standing := coalesce((p_state->'reputation'->>p_faction)::float8, 0);
  return 1.0 + greatest(0, least(0.25, (standing / 100.0) * 0.25));
end;
$$;

-- Faction rival map (match FACTIONS[].rival in js/data.js).
create or replace function app._faction_rival(p_faction text)
returns text
language sql immutable as $$
  select case p_faction
    when 'syndicate' then 'free_trade'
    when 'mining_combine' then 'agri_collective'
    when 'free_trade' then 'syndicate'
    when 'agri_collective' then 'mining_combine'
    else null end;
$$;

-- Apply a standing delta to one faction, clamped to REP.min/max (-100..100).
-- Mirrors Rep.change() in js/reputation.js.
create or replace function app._rep_change(p_rep jsonb, p_faction text, p_delta double precision)
returns jsonb
language sql immutable as $$
  select case when p_faction is null or p_faction = '' then p_rep
  else jsonb_set(coalesce(p_rep, '{}'::jsonb), array[p_faction],
    to_jsonb(greatest(-100.0, least(100.0,
      coalesce((p_rep->>p_faction)::float8, 0) + p_delta)))) end;
$$;

create or replace function app.make_ship(p_seq int, p_type text, p_name text,
  p_merc boolean, p_expires bigint)
returns jsonb
language plpgsql immutable as $$
declare
  def record;
begin
  select * into def from app.ship_def(p_type);
  if def.id is null then return null; end if;
  return jsonb_build_object(
    'uid', 's' || p_seq,
    'type', p_type,
    'cls', def.cls,
    'name', coalesce(nullif(p_name, ''), initcap(p_type)),
    'status', 'idle',
    'accessories', '[]'::jsonb,
    'mercenary', coalesce(p_merc, false),
    'expiresAt', p_expires,
    'retrieveCost', 0,
    'dmg', 0
  );
end;
$$;

-- Recompute accessory value from stats (never trust client item.value).
create or replace function app.item_value(p_item jsonb)
returns double precision
language plpgsql immutable as $$
declare
  kind text := p_item->>'kind';
  rarity text := coalesce(p_item->>'rarity', 'common');
  amount double precision := coalesce((p_item->'primary'->>'amount')::float8, 0);
  pct boolean := coalesce((p_item->'primary'->>'pct')::boolean, false);
  price_mult double precision;
  base double precision;
  v double precision;
begin
  price_mult := case rarity
    when 'common' then 1.0 when 'uncommon' then 2.2 when 'rare' then 5.0
    when 'epic' then 12.0 when 'legendary' then 30.0 else 1.0 end;
  base := case when pct then amount * 8000 else amount * 90 end;
  v := base * price_mult;
  if p_item->'bonus' is not null and jsonb_typeof(p_item->'bonus') = 'object' then
    v := v * 1.4;
  end if;
  return round(v / 10.0) * 10;
end;
$$;

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
    'unlockedSystems', p_state->'unlockedSystems'
  );
$$;

-- ===========================================================================
-- Seeded bazaar board (epoch = floor(now_ms / 60000); match js Bazaar.seed*)
-- Offer ids: mc-{epoch}-{slot} | ac-{epoch}-{slot} | ct-{epoch}-{slot}
-- ===========================================================================
create or replace function app.board_epoch(p_now_ms bigint)
returns bigint
language sql immutable as $$
  select greatest(0, p_now_ms) / 60000;
$$;

create or replace function app.offer_epoch_ok(p_epoch bigint, p_now_ms bigint)
returns boolean
language sql immutable as $$
  -- current or previous epoch only (≤ ~2 minutes of lag)
  select p_epoch is not null
    and p_epoch <= app.board_epoch(p_now_ms)
    and p_epoch >= app.board_epoch(p_now_ms) - 1;
$$;

create or replace function app.claim_used(p_state jsonb, p_offer_id text)
returns boolean
language sql immutable as $$
  select exists (
    select 1 from jsonb_array_elements_text(coalesce(p_state->'bazaarBought', '[]'::jsonb)) x
    where x = p_offer_id
  );
$$;

create or replace function app.mark_claimed(p_state jsonb, p_offer_id text)
returns jsonb
language sql immutable as $$
  select jsonb_set(
    p_state,
    '{bazaarBought}',
    coalesce(p_state->'bazaarBought', '[]'::jsonb) || jsonb_build_array(p_offer_id)
  );
$$;

-- Merc offer (escort hire)
create or replace function app.gen_merc(p_epoch bigint, p_slot int)
returns jsonb
language plpgsql immutable as $$
declare
  s bigint := market.seed_hash('cosmocrat-market-v1', 'bazaar', 'merc', p_epoch::text, p_slot::text);
  escorts text[] := array['corvette','frigate','cruiser','battleship'];
  ship_type text;
  def record;
  hire double precision;
  service_ms bigint;
begin
  ship_type := escorts[1 + (floor(market.u01(s, 0) * 4)::int % 4)];
  select * into def from app.ship_def(ship_type);
  hire := round(def.price * 0.2 + def.firepower * 55);
  service_ms := (15 + floor(market.u01(s, 1) * 26)::int) * 60 * 1000; -- 15–40 min
  return jsonb_build_object(
    'id', 'mc-' || p_epoch || '-' || p_slot,
    'shipType', ship_type,
    'name', initcap(ship_type) || ' Merc ' || p_slot,
    'firepower', def.firepower,
    'hull', def.hull,
    'serviceMs', service_ms,
    'hireCost', hire
  );
end;
$$;

-- Accessory offer (server-authored item + price)
create or replace function app.gen_accessory(p_epoch bigint, p_slot int)
returns jsonb
language plpgsql immutable as $$
declare
  s bigint := market.seed_hash('cosmocrat-market-v1', 'bazaar', 'acc', p_epoch::text, p_slot::text);
  kinds text[] := array['engine','reactor','cannon','plating','shield','hold'];
  kind text;
  bases double precision[] := array[0.04, 0.06, 12, 18, 16, 8];
  pcts boolean[] := array[true, true, false, false, false, false];
  ki int;
  roll double precision;
  rarity text;
  mult double precision;
  price_mult double precision;
  amount double precision;
  item jsonb;
  val double precision;
  price double precision;
begin
  ki := 1 + (floor(market.u01(s, 0) * 6)::int % 6);
  kind := kinds[ki];
  roll := market.u01(s, 1);
  -- weights ≈ 50/28/14/6/2 — no legendary on board (keeps sell-side simple)
  if roll < 0.50 then rarity := 'common'; mult := 1.0; price_mult := 1.0;
  elsif roll < 0.78 then rarity := 'uncommon'; mult := 1.5; price_mult := 2.2;
  elsif roll < 0.92 then rarity := 'rare'; mult := 2.3; price_mult := 5.0;
  else rarity := 'epic'; mult := 3.4; price_mult := 12.0;
  end if;
  amount := bases[ki] * mult * (0.8 + market.u01(s, 2) * 0.5);
  if pcts[ki] then amount := round(amount::numeric, 3);
  else amount := round(amount); end if;
  item := jsonb_build_object(
    'uid', 'i' || p_epoch || 'a' || p_slot,
    'kind', kind,
    'rarity', rarity,
    'name', initcap(kind) || ' ' || rarity,
    'primary', jsonb_build_object(
      'stat', case kind
        when 'engine' then 'speed' when 'reactor' then 'firepower'
        when 'cannon' then 'firepower' when 'plating' then 'armor'
        when 'shield' then 'shields' else 'cargo' end,
      'amount', amount,
      'pct', pcts[ki],
      'kind', kind
    ),
    'bonus', null
  );
  val := app.item_value(item);
  item := jsonb_set(item, '{value}', to_jsonb(val));
  price := round(val * (0.95 + market.u01(s, 3) * 0.30));
  return jsonb_build_object(
    'id', 'ac-' || p_epoch || '-' || p_slot,
    'item', item,
    'price', price
  );
end;
$$;

-- Contract / tip offer — rewards & costs from template ranges (server-only)
create or replace function app.gen_contract(p_epoch bigint, p_slot int, p_tier int)
returns jsonb
language plpgsql immutable as $$
declare
  s bigint := market.seed_hash('cosmocrat-market-v1', 'bazaar', 'ct', p_epoch::text, p_slot::text);
  tpl int;
  kind text;
  typ text;
  danger text;
  dangers text[];
  cargo_lo int; cargo_hi int; fp_lo int; fp_hi int;
  dur_lo int; dur_hi int;
  rew_lo int; rew_hi int;
  tip_lo int; tip_hi int;
  impound boolean := false;
  stake int := greatest(0, coalesce(p_tier, 0));
  req_mult double precision := 1.0 + stake * 0.3;
  stake_mult double precision := 1.0 + stake * 0.5;
  pay double precision;
  cats text[] := array['mineral','gas','agri','tech','luxury','illicit'];
  factions text[] := array['syndicate','mining_combine','free_trade','agri_collective'];
  out jsonb;
begin
  -- slot 0..2 tips-ish mix: ~1/6 tips
  if market.u01(s, 0) < 0.16 then
    tip_lo := 1500; tip_hi := 9000;
    return jsonb_build_object(
      'id', 'ct-' || p_epoch || '-' || p_slot,
      'kind', 'tip', 'type', 'insider', 'status', 'open',
      'title', 'Insider whisper',
      'desc', 'Pay for a tip and front-run the newswire.',
      'cat', cats[1 + (floor(market.u01(s, 1) * 6)::int % 6)],
      'sysName', 'Sector ' || (1 + (floor(market.u01(s, 2) * 20)::int % 20)),
      'faction', factions[1 + (floor(market.u01(s, 3) * 4)::int % 4)],
      'cost', tip_lo + floor(market.u01(s, 4) * (tip_hi - tip_lo + 1))::int,
      'stakeTier', stake
    );
  end if;

  tpl := floor(market.u01(s, 1) * 5)::int % 5; -- 0..4 jobs
  case tpl
    when 0 then -- transport
      typ := 'transport'; dangers := array['safe','low'];
      cargo_lo := 8; cargo_hi := 60; fp_lo := 0; fp_hi := 0;
      dur_lo := 3; dur_hi := 8; rew_lo := 600; rew_hi := 2200;
    when 1 then -- escort
      typ := 'escort'; dangers := array['low','moderate'];
      cargo_lo := 0; cargo_hi := 0; fp_lo := 40; fp_hi := 150;
      dur_lo := 4; dur_hi := 9; rew_lo := 1800; rew_hi := 5000;
    when 2 then -- combat
      typ := 'combat'; dangers := array['moderate','high'];
      cargo_lo := 0; cargo_hi := 0; fp_lo := 90; fp_hi := 320;
      dur_lo := 5; dur_hi := 10; rew_lo := 4000; rew_hi := 11000;
    when 3 then -- smuggle
      typ := 'smuggle'; dangers := array['moderate','high','extreme'];
      cargo_lo := 10; cargo_hi := 45; fp_lo := 20; fp_hi := 120;
      dur_lo := 5; dur_hi := 12; rew_lo := 5000; rew_hi := 14000; impound := true;
    else -- assassinate
      typ := 'assassinate'; dangers := array['high','extreme'];
      cargo_lo := 0; cargo_hi := 0; fp_lo := 150; fp_hi := 520;
      dur_lo := 6; dur_hi := 12; rew_lo := 9000; rew_hi := 24000;
  end case;

  danger := dangers[1 + (floor(market.u01(s, 2) * array_length(dangers, 1))::int
    % array_length(dangers, 1))];
  pay := app.danger_pay(danger);

  out := jsonb_build_object(
    'id', 'ct-' || p_epoch || '-' || p_slot,
    'kind', 'job', 'type', typ, 'status', 'open',
    'title', initcap(typ) || ' contract #' || p_slot,
    'desc', 'A seeded board contract.',
    'sysName', 'Sector ' || (1 + (floor(market.u01(s, 3) * 20)::int % 20)),
    'danger', danger,
    'faction', factions[1 + (floor(market.u01(s, 4) * 4)::int % 4)],
    'stakeTier', stake,
    'impound', impound,
    'minFirepower', round((case when fp_hi > 0
      then fp_lo + floor(market.u01(s, 5) * (fp_hi - fp_lo + 1)) else 0 end) * req_mult),
    'cargoRequired', round((case when cargo_hi > 0
      then cargo_lo + floor(market.u01(s, 6) * (cargo_hi - cargo_lo + 1)) else 0 end) * req_mult),
    'durationMs', (dur_lo + floor(market.u01(s, 7) * (dur_hi - dur_lo + 1))::int) * 60 * 1000,
    'reward', jsonb_build_object(
      'credits', (round((rew_lo + floor(market.u01(s, 8) * (rew_hi - rew_lo + 1))::int)
        * pay * stake_mult / 10.0) * 10)::int,
      'itemChance', case typ when 'transport' then 0.1 when 'escort' then 0.3
        when 'combat' then 0.5 when 'smuggle' then 0.45 else 0.7 end,
      'stockChance', case typ when 'transport' then 0.28 else 0.1 end
    )
  );
  return out;
end;
$$;

create or replace function app.lookup_offer(p_offer_id text, p_now_ms bigint, p_tier int)
returns jsonb
language plpgsql immutable as $$
declare
  parts text[];
  kind text;
  epoch bigint;
  slot int;
begin
  if p_offer_id is null or p_offer_id = '' then return null; end if;
  parts := string_to_array(p_offer_id, '-');
  if array_length(parts, 1) < 3 then return null; end if;
  kind := parts[1];
  epoch := parts[2]::bigint;
  slot := parts[3]::int;
  if not app.offer_epoch_ok(epoch, p_now_ms) then return null; end if;
  if kind = 'mc' then return app.gen_merc(epoch, slot);
  elsif kind = 'ac' then return app.gen_accessory(epoch, slot);
  elsif kind = 'ct' then return app.gen_contract(epoch, slot, p_tier);
  else return null;
  end if;
exception when others then
  return null;
end;
$$;

create or replace function public.app_bazaar_board()
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  epoch bigint := app.board_epoch(now_ms);
  tier int;
  mercs jsonb := '[]'::jsonb;
  accs jsonb := '[]'::jsonb;
  cts jsonb := '[]'::jsonb;
  i int;
  offer jsonb;
  bought jsonb;
begin
  st := app._lock_state(now_ms);
  tier := coalesce((st->'prestige'->>'tier')::int, 0);
  bought := coalesce(st->'bazaarBought', '[]'::jsonb);
  for i in 0..7 loop
    offer := app.gen_merc(epoch, i);
    if not app.claim_used(st, offer->>'id') then
      mercs := mercs || jsonb_build_array(offer);
    end if;
  end loop;
  for i in 0..17 loop
    offer := app.gen_accessory(epoch, i);
    if not app.claim_used(st, offer->>'id') then
      accs := accs || jsonb_build_array(offer);
    end if;
  end loop;
  for i in 0..13 loop
    offer := app.gen_contract(epoch, i, tier);
    if not app.claim_used(st, offer->>'id') then
      cts := cts || jsonb_build_array(offer);
    end if;
  end loop;
  return jsonb_build_object(
    'ok', true,
    'epoch', epoch,
    'bazaar', jsonb_build_object(
      'mercs', mercs, 'accessories', accs, 'contracts', cts,
      'extractors', '[]'::jsonb, 'components', '[]'::jsonb, 'dossiers', '[]'::jsonb
    ),
    'bazaarBought', bought,
    'pendingContracts', coalesce(st->'pendingContracts', '[]'::jsonb)
  );
end;
$$;

-- ===========================================================================
-- Purchases / take / sell — recompute offers; never trust client board
-- ===========================================================================
create or replace function public.app_buy_ship(p_catalog_id text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  def record;
  price double precision;
  credits double precision;
  ships jsonb;
  seq int;
  tier int;
  sh jsonb;
begin
  select * into def from app.ship_def(p_catalog_id);
  if def.id is null or def.cls = 'main' then
    return jsonb_build_object('ok', false, 'error', 'Unknown ship.');
  end if;
  st := app._lock_state(now_ms);
  ships := coalesce(st->'ships', '[]'::jsonb);
  tier := coalesce((st->'prestige'->>'tier')::int, 0);
  if jsonb_array_length(ships) >= app.fleet_cap(tier) then
    return jsonb_build_object('ok', false, 'error', 'Fleet at capacity — ascend a Baron Tier to command more.');
  end if;
  price := round(def.price * (1.0 - app.rep_discount(st)));
  credits := coalesce((st->>'credits')::float8, 0);
  if price > credits then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
  end if;
  seq := coalesce((st->>'seq')::int, 1) + 1;
  sh := app.make_ship(seq, def.id, null, false, null);
  st := jsonb_set(st, '{credits}', to_jsonb(credits - price));
  st := jsonb_set(st, '{ships}', ships || jsonb_build_array(sh));
  st := jsonb_set(st, '{seq}', to_jsonb(seq));
  perform app._write_state(st, now_ms);
  return app.result_slice(st);
end;
$$;

create or replace function public.app_buy_main(p_catalog_id text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  def record;
  price double precision;
  credits double precision;
begin
  select * into def from app.ship_def(p_catalog_id);
  if def.id is null or def.cls <> 'main' then
    return jsonb_build_object('ok', false, 'error', 'Unknown flagship.');
  end if;
  st := app._lock_state(now_ms);
  if (st->'mainShip'->>'type') = def.id then
    return jsonb_build_object('ok', false, 'error', 'Already your flagship.');
  end if;
  price := round(def.price * (1.0 - app.rep_discount(st)));
  credits := coalesce((st->>'credits')::float8, 0);
  if price > credits then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
  end if;
  st := jsonb_set(st, '{credits}', to_jsonb(credits - price));
  st := jsonb_set(st, '{mainShip}', jsonb_build_object('type', def.id));
  perform app._write_state(st, now_ms);
  return app.result_slice(st);
end;
$$;

create or replace function public.app_upgrade_inventory()
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  lvl int;
  cost double precision;
  credits double precision;
  inv jsonb;
begin
  st := app._lock_state(now_ms);
  inv := coalesce(st->'inventory', '{"capacity":6,"upgrades":0}'::jsonb);
  lvl := coalesce((inv->>'upgrades')::int, 0);
  cost := round(6000 * power(1.8, lvl));
  credits := coalesce((st->>'credits')::float8, 0);
  if cost > credits then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
  end if;
  inv := jsonb_set(inv, '{upgrades}', to_jsonb(lvl + 1));
  inv := jsonb_set(inv, '{capacity}',
    to_jsonb(coalesce((inv->>'capacity')::int, 6) + 10));
  st := jsonb_set(st, '{credits}', to_jsonb(credits - cost));
  st := jsonb_set(st, '{inventory}', inv);
  perform app._write_state(st, now_ms);
  return app.result_slice(st);
end;
$$;

create or replace function public.app_buy_merc(p_offer_id text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  offer jsonb;
  credits double precision;
  seq int;
  sh jsonb;
  ships jsonb;
  tier int;
begin
  st := app._lock_state(now_ms);
  tier := coalesce((st->'prestige'->>'tier')::int, 0);
  if app.claim_used(st, p_offer_id) then
    return jsonb_build_object('ok', false, 'error', 'Offer gone.');
  end if;
  offer := app.lookup_offer(p_offer_id, now_ms, tier);
  if offer is null or offer->>'shipType' is null then
    return jsonb_build_object('ok', false, 'error', 'Offer gone.');
  end if;
  ships := coalesce(st->'ships', '[]'::jsonb);
  if jsonb_array_length(ships) >= app.fleet_cap(tier) then
    return jsonb_build_object('ok', false, 'error', 'Fleet at capacity — ascend a Baron Tier to command more.');
  end if;
  credits := coalesce((st->>'credits')::float8, 0);
  if coalesce((offer->>'hireCost')::float8, 0) > credits then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
  end if;
  seq := coalesce((st->>'seq')::int, 1) + 1;
  sh := app.make_ship(seq, offer->>'shipType', offer->>'name', true,
    now_ms + coalesce((offer->>'serviceMs')::bigint, 900000));
  st := jsonb_set(st, '{credits}', to_jsonb(credits - (offer->>'hireCost')::float8));
  st := jsonb_set(st, '{ships}', ships || jsonb_build_array(sh));
  st := jsonb_set(st, '{seq}', to_jsonb(seq));
  st := app.mark_claimed(st, p_offer_id);
  perform app._write_state(st, now_ms);
  return app.result_slice(st);
end;
$$;

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
  used := (select count(*)::int from jsonb_object_keys(items));
  cap := coalesce((inv->>'capacity')::int, 6);
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

create or replace function public.app_take_contract(p_offer_id text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  offer jsonb;
  credits double precision;
  pending jsonb;
  tier int;
begin
  st := app._lock_state(now_ms);
  tier := coalesce((st->'prestige'->>'tier')::int, 0);
  if app.claim_used(st, p_offer_id) then
    return jsonb_build_object('ok', false, 'error', 'Contract no longer available.');
  end if;
  offer := app.lookup_offer(p_offer_id, now_ms, tier);
  if offer is null then
    return jsonb_build_object('ok', false, 'error', 'Contract no longer available.');
  end if;

  if offer->>'kind' = 'tip' then
    credits := coalesce((st->>'credits')::float8, 0);
    if coalesce((offer->>'cost')::float8, 0) > credits then
      return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
    end if;
    st := jsonb_set(st, '{credits}', to_jsonb(credits - (offer->>'cost')::float8));
    st := app.mark_claimed(st, p_offer_id);
    perform app._write_state(st, now_ms);
    return app.result_slice(st) || jsonb_build_object('tip', true, 'cat', offer->>'cat');
  end if;

  -- job: stash server-authored contract for launch (max 5 pending)
  pending := coalesce(st->'pendingContracts', '[]'::jsonb);
  if jsonb_array_length(pending) >= 5 then
    return jsonb_build_object('ok', false, 'error', 'Too many pending contracts — launch one first.');
  end if;
  pending := pending || jsonb_build_array(offer);
  st := jsonb_set(st, '{pendingContracts}', pending);
  st := app.mark_claimed(st, p_offer_id);
  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('contract', offer);
end;
$$;

-- Mission launch: contract id must be in pendingContracts (server-authored).
drop function if exists public.app_mission_launch(jsonb, jsonb);
create or replace function public.app_mission_launch(p_contract_id text, p_ship_uids jsonb)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  ships jsonb;
  uids jsonb := '[]'::jsonb;
  uid text;
  sh jsonb;
  def record;
  power double precision := 0;
  cargo double precision := 0;
  speed double precision := 0;
  n int := 0;
  chance double precision;
  min_fp double precision;
  cargo_req double precision;
  danger text;
  duration_ms double precision;
  leg double precision;
  work double precision;
  total_ms double precision;
  seq int;
  mission jsonb;
  phases jsonb;
  pending jsonb;
  contract jsonb;
  rng_seed bigint;
begin
  if p_contract_id is null or jsonb_typeof(p_ship_uids) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'Invalid mission.');
  end if;

  st := app._lock_state(now_ms);
  pending := coalesce(st->'pendingContracts', '[]'::jsonb);
  select value into contract from jsonb_array_elements(pending) x(value)
    where x.value->>'id' = p_contract_id limit 1;
  if contract is null then
    return jsonb_build_object('ok', false, 'error', 'Contract not in hand — take it from the board first.');
  end if;
  if contract->>'kind' is distinct from 'job' then
    return jsonb_build_object('ok', false, 'error', 'Not a flyable contract.');
  end if;

  ships := coalesce(st->'ships', '[]'::jsonb);
  for uid in select jsonb_array_elements_text(p_ship_uids) loop
    select value into sh from jsonb_array_elements(ships) x(value)
      where x.value->>'uid' = uid limit 1;
    if sh is null or sh->>'status' is distinct from 'idle' then continue; end if;
    select * into def from app.ship_def(sh->>'type');
    if def.id is null then continue; end if;
    uids := uids || jsonb_build_array(uid);
    power := power + coalesce(def.firepower, 0);
    cargo := cargo + coalesce(def.cargo, 0);
    speed := speed + coalesce(def.speed, 1);
    n := n + 1;
  end loop;

  if n = 0 then
    return jsonb_build_object('ok', false, 'error', 'Select at least one idle ship.');
  end if;
  speed := speed / n;

  danger := coalesce(contract->>'danger', 'moderate');
  min_fp := coalesce((contract->>'minFirepower')::float8, 0);
  cargo_req := coalesce((contract->>'cargoRequired')::float8, 0);
  duration_ms := coalesce((contract->>'durationMs')::float8, 600000);
  -- clamp duration to template band (3–12 min) so a corrupted pending row can't mint
  duration_ms := greatest(180000, least(720000, duration_ms));
  chance := app.danger_base_success(danger);
  if min_fp > 0 then
    chance := chance + greatest(-0.6, least(0.35, ((power / min_fp) - 1.0) * 0.25));
  elsif power > 0 then
    chance := chance + 0.02;
  end if;
  if cargo_req > 0 and cargo < cargo_req then
    chance := chance - 0.45 * (1.0 - cargo / cargo_req);
  end if;
  chance := greatest(0.03, least(0.99, chance));

  leg := (duration_ms * 0.3) / greatest(speed, 0.25);
  work := duration_ms * 0.4;
  total_ms := leg + work * 0.45 + work * 0.55 + leg;
  phases := jsonb_build_array(
    jsonb_build_object('label', 'Outbound transit', 'dir', 'out', 'ms', leg),
    jsonb_build_object('label', 'On site', 'dir', 'work', 'ms', work * 0.45),
    jsonb_build_object('label', 'Working', 'dir', 'work', 'ms', work * 0.55),
    jsonb_build_object('label', 'Return transit', 'dir', 'in', 'ms', leg)
  );

  seq := coalesce((st->>'seq')::int, 1) + 1;
  -- RNG seed fixed at launch (not resolve time)
  rng_seed := market.seed_hash('cosmocrat-market-v1', 'mission', 'm' || seq, now_ms::text);
  mission := jsonb_build_object(
    'uid', 'm' || seq,
    'contractId', p_contract_id,
    'type', contract->>'type',
    'title', contract->>'title',
    'sysName', contract->>'sysName',
    'shipUids', uids,
    'phases', phases,
    'totalMs', total_ms,
    'startedAt', now_ms,
    'rngSeed', rng_seed,
    'successChance', chance,
    'reward', contract->'reward',
    'impound', coalesce((contract->>'impound')::boolean, false),
    'danger', danger,
    'stakeTier', coalesce((contract->>'stakeTier')::int, 0),
    'faction', contract->>'faction',
    'resolved', false
  );

  ships := (
    select coalesce(jsonb_agg(
      case when exists (
        select 1 from jsonb_array_elements_text(uids) u where u = sh.value->>'uid'
      )
        then jsonb_set(sh.value, '{status}', '"mission"')
        else sh.value end
    ), '[]'::jsonb)
    from jsonb_array_elements(ships) sh(value)
  );

  pending := (
    select coalesce(jsonb_agg(value), '[]'::jsonb)
    from jsonb_array_elements(pending) x(value)
    where x.value->>'id' is distinct from p_contract_id
  );

  st := jsonb_set(st, '{ships}', ships);
  st := jsonb_set(st, '{missions}', coalesce(st->'missions', '[]'::jsonb) || jsonb_build_array(mission));
  st := jsonb_set(st, '{pendingContracts}', pending);
  st := jsonb_set(st, '{seq}', to_jsonb(seq));
  perform app._write_state(st, now_ms);

  return app.result_slice(st) || jsonb_build_object('mission', mission);
end;
$$;

create or replace function public.app_mission_resolve()
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  missions jsonb;
  kept jsonb := '[]'::jsonb;
  reports jsonb;
  m jsonb;
  report jsonb;
  success boolean;
  survivors jsonb;
  ships jsonb;
  credits double precision;
  gross double precision;
  payout double precision;
  tier int;
  tax_rate double precision;
  seed bigint;
  roll double precision;
  uid text;
  lost_uids text[] := array[]::text[];
  destroy_p double precision;
  i int := 0;
  any_done boolean := false;
  stats jsonb;
  lost_json jsonb;
  rep jsonb;
  fac text;
  rival text;
  gain double precision;
begin
  st := app._lock_state(now_ms);
  missions := coalesce(st->'missions', '[]'::jsonb);
  reports := coalesce(st->'reports', '[]'::jsonb);
  ships := coalesce(st->'ships', '[]'::jsonb);
  credits := coalesce((st->>'credits')::float8, 0);
  tier := coalesce((st->'prestige'->>'tier')::int, 0);
  tax_rate := app._tier_tax(tier);

  for m in select value from jsonb_array_elements(missions) loop
    if coalesce((m->>'resolved')::boolean, false) then continue; end if;
    if now_ms - coalesce((m->>'startedAt')::bigint, 0) < coalesce((m->>'totalMs')::float8, 0) then
      kept := kept || jsonb_build_array(m);
      continue;
    end if;

    any_done := true;
    i := i + 1;
    -- Prefer launch-time seed; fall back to startedAt (never resolve-time).
    seed := coalesce((m->>'rngSeed')::bigint,
      market.seed_hash('cosmocrat-market-v1', 'mission', m->>'uid', (m->>'startedAt')));
    roll := market.u01(seed, 0);
    success := roll < coalesce((m->>'successChance')::float8, 0.5);

    survivors := '[]'::jsonb;
    lost_uids := array[]::text[];
    for uid in select jsonb_array_elements_text(coalesce(m->'shipUids', '[]'::jsonb)) loop
      destroy_p := case when success then 0.02 else 0.12 end;
      if market.u01(seed, 2 + length(uid)) < destroy_p then
        lost_uids := array_append(lost_uids, uid);
      else
        survivors := survivors || jsonb_build_array(uid);
      end if;
    end loop;
    if jsonb_array_length(survivors) = 0 and array_length(lost_uids, 1) is not null then
      success := false;
    end if;

    report := jsonb_build_object(
      'uid', m->>'uid', 'title', m->>'title', 'type', m->>'type',
      'success', success, 'ts', now_ms,
      'credits', 0, 'items', '[]'::jsonb, 'stock', null,
      'lost', '[]'::jsonb, 'impounded', '[]'::jsonb, 'damaged', '[]'::jsonb
    );

    if success then
      gross := round(coalesce((m->'reward'->>'credits')::float8, 0)
        * app.rep_reward_mult(st, m->>'faction'));
      -- Sanity net only. Rewards are server-generated (gen_contract) and rep is
      -- server-authoritative, so max legit gross ≈ 24000×3.8×4.0×1.25 ≈ 456k;
      -- this guards a corrupted row without clipping legitimate high-tier pay.
      gross := least(gross, 1000000);
      payout := case when gross > 0 then round(gross * (1.0 - tax_rate)) else 0 end;
      report := jsonb_set(report, '{credits}', to_jsonb(payout));
      report := jsonb_set(report, '{taxed}', to_jsonb(gross - payout));
      credits := credits + payout;
      stats := coalesce(st->'stats', '{}'::jsonb);
      stats := jsonb_set(stats, '{contractsDone}',
        to_jsonb(coalesce((stats->>'contractsDone')::int, 0) + 1));
      st := jsonb_set(st, '{stats}', stats);
      -- Server-side reputation from the contract (mirrors Rep.onContract):
      -- danger-scaled gain to the sponsor, half that off its rival, and a small
      -- Free-Trade penalty for dirty work. Authoritative — commit protects rep.
      fac := m->>'faction';
      if fac is not null and fac <> '' then
        gain := case m->>'danger'
          when 'safe' then 3 when 'low' then 5 when 'moderate' then 7
          when 'high' then 10 when 'extreme' then 13 else 5 end;
        rep := coalesce(st->'reputation', '{}'::jsonb);
        rep := app._rep_change(rep, fac, gain);
        rival := app._faction_rival(fac);
        if rival is not null then
          -- ::numeric so .5 rounds half-up like JS Math.round (round(float8) is half-even)
          rep := app._rep_change(rep, rival, -round((gain * 0.5)::numeric));
        end if;
        if (m->>'type') in ('smuggle', 'assassinate') then
          rep := app._rep_change(rep, 'free_trade', -2);
        end if;
        st := jsonb_set(st, '{reputation}', rep);
      end if;
      ships := (
        select coalesce(jsonb_agg(
          case when exists (
            select 1 from jsonb_array_elements_text(survivors) u where u = x.value->>'uid'
          )
            then jsonb_set(x.value, '{status}', '"idle"')
            else x.value end
        ), '[]'::jsonb)
        from jsonb_array_elements(ships) x(value)
      );
    else
      ships := (
        select coalesce(jsonb_agg(
          case
            when x.value->>'uid' = any(lost_uids) then x.value
            when exists (
              select 1 from jsonb_array_elements_text(survivors) u where u = x.value->>'uid'
            ) and coalesce((m->>'impound')::boolean, false) then
              jsonb_set(jsonb_set(x.value, '{status}', '"impounded"'),
                '{retrieveCost}', to_jsonb(1500))
            when exists (
              select 1 from jsonb_array_elements_text(survivors) u where u = x.value->>'uid'
            ) then
              jsonb_set(x.value, '{status}', '"idle"')
            else x.value
          end
        ), '[]'::jsonb)
        from jsonb_array_elements(ships) x(value)
      );
    end if;

    if array_length(lost_uids, 1) is not null then
      lost_json := (
        select coalesce(jsonb_agg(jsonb_build_object(
          'uid', u,
          'name', coalesce(
            (select x.value->>'name' from jsonb_array_elements(ships) x(value)
              where x.value->>'uid' = u limit 1),
            (select x.value->>'name' from jsonb_array_elements(coalesce(st->'ships','[]'::jsonb)) x(value)
              where x.value->>'uid' = u limit 1),
            u)
        )), '[]'::jsonb)
        from unnest(lost_uids) u
      );
      ships := (
        select coalesce(jsonb_agg(x.value), '[]'::jsonb)
        from jsonb_array_elements(ships) x(value)
        where not (x.value->>'uid' = any(lost_uids))
      );
      report := jsonb_set(report, '{lost}', lost_json);
    end if;

    reports := jsonb_build_array(report) || reports;
  end loop;

  if not any_done then
    return app.result_slice(st) || jsonb_build_object('resolved', '[]'::jsonb);
  end if;

  if jsonb_array_length(reports) > 20 then
    reports := (
      select jsonb_agg(value) from (
        select value, ordinality from jsonb_array_elements(reports) with ordinality
        order by ordinality limit 20
      ) t
    );
  end if;

  st := jsonb_set(st, '{credits}', to_jsonb(credits));
  st := jsonb_set(st, '{ships}', ships);
  st := jsonb_set(st, '{missions}', kept);
  st := jsonb_set(st, '{reports}', reports);
  perform app._write_state(st, now_ms);

  return app.result_slice(st) || jsonb_build_object(
    'resolved', (
      select coalesce(jsonb_agg(value), '[]'::jsonb)
      from (
        select value from jsonb_array_elements(reports) with ordinality
        order by ordinality
        limit greatest(1, i)
      ) t
    )
  );
end;
$$;

create or replace function public.app_sell_ship(p_uid text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  ships jsonb;
  sh jsonb;
  def record;
  credits double precision;
  payout double precision;
  items jsonb;
  uid text;
  gear double precision := 0;
  it jsonb;
begin
  st := app._lock_state(now_ms);
  ships := coalesce(st->'ships', '[]'::jsonb);
  items := coalesce(st->'items', '{}'::jsonb);
  select value into sh from jsonb_array_elements(ships) x(value)
    where x.value->>'uid' = p_uid limit 1;
  if sh is null then
    return jsonb_build_object('ok', false, 'error', 'Ship not found.');
  end if;
  if coalesce((sh->>'mercenary')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'Mercenaries are rented, not owned.');
  end if;
  if sh->>'status' is distinct from 'idle' then
    return jsonb_build_object('ok', false, 'error', 'Ship is busy — recall it first.');
  end if;
  select * into def from app.ship_def(sh->>'type');
  payout := round(greatest(0, coalesce(def.price, 0) * 0.5));
  for uid in select jsonb_array_elements_text(coalesce(sh->'accessories', '[]'::jsonb)) loop
    it := items->uid;
    if it is not null then
      gear := gear + app.item_value(it) * 0.55;
      items := items - uid;
    end if;
  end loop;
  payout := payout + round(gear);
  credits := coalesce((st->>'credits')::float8, 0) + payout;
  ships := (
    select coalesce(jsonb_agg(value), '[]'::jsonb) from jsonb_array_elements(ships) x(value)
    where x.value->>'uid' is distinct from p_uid
  );
  st := jsonb_set(st, '{credits}', to_jsonb(credits));
  st := jsonb_set(st, '{ships}', ships);
  st := jsonb_set(st, '{items}', items);
  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('creditsGained', payout);
end;
$$;

create or replace function public.app_sell_item(p_uid text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  items jsonb;
  it jsonb;
  payout double precision;
  credits double precision;
begin
  st := app._lock_state(now_ms);
  items := coalesce(st->'items', '{}'::jsonb);
  it := items->p_uid;
  if it is null or it = 'null'::jsonb then
    return jsonb_build_object('ok', false, 'error', 'Item not found.');
  end if;
  -- recompute value from stats (item.value is not trusted)
  payout := round(app.item_value(it) * 0.55);
  credits := coalesce((st->>'credits')::float8, 0) + payout;
  items := items - p_uid;
  st := jsonb_set(st, '{credits}', to_jsonb(credits));
  st := jsonb_set(st, '{items}', items);
  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('creditsGained', payout);
end;
$$;

-- Commit: protect fleet/missions/items/rep/claims; ignore client bazaar economics
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

  -- Phase 2 owned slices
  merged := jsonb_set(merged, '{ships}', coalesce(server->'ships', '[]'::jsonb));
  merged := jsonb_set(merged, '{mainShip}', coalesce(server->'mainShip', '{"type":"pinnace"}'::jsonb));
  merged := jsonb_set(merged, '{missions}', coalesce(server->'missions', '[]'::jsonb));
  merged := jsonb_set(merged, '{items}', coalesce(server->'items', '{}'::jsonb));
  merged := jsonb_set(merged, '{inventory}', coalesce(server->'inventory', '{"capacity":6,"upgrades":0}'::jsonb));
  merged := jsonb_set(merged, '{pendingContracts}', coalesce(server->'pendingContracts', '[]'::jsonb));
  merged := jsonb_set(merged, '{bazaarBought}', coalesce(server->'bazaarBought', '[]'::jsonb));
  merged := jsonb_set(merged, '{reputation}', coalesce(server->'reputation', '{}'::jsonb));
  -- Drop client bazaar entirely — board is recomputed from seed when needed
  merged := jsonb_set(merged, '{bazaar}', coalesce(server->'bazaar',
    '{"mercs":[],"contracts":[],"accessories":[]}'::jsonb));

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

  perform app._write_state(merged, now_ms);
  return jsonb_build_object('ok', true, 'state', merged);
end;
$$;

grant execute on function public.app_bazaar_board() to authenticated;
grant execute on function public.app_mission_launch(text, jsonb) to authenticated;
grant execute on function public.app_mission_resolve() to authenticated;
grant execute on function public.app_buy_ship(text) to authenticated;
grant execute on function public.app_buy_main(text) to authenticated;
grant execute on function public.app_buy_merc(text) to authenticated;
grant execute on function public.app_buy_accessory(text) to authenticated;
grant execute on function public.app_upgrade_inventory() to authenticated;
grant execute on function public.app_take_contract(text) to authenticated;
grant execute on function public.app_sell_ship(text) to authenticated;
grant execute on function public.app_sell_item(text) to authenticated;
grant execute on function public.app_commit(jsonb) to authenticated;
