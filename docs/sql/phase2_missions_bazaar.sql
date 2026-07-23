-- Phase 2 — authoritative missions & bazaar (Supabase / Postgres)
-- Requires: docs/sql/market_price.sql + docs/sql/phase1_players.sql
-- Paste into SQL Editor and Run. See docs/PHASE2_SETUP.md.

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Ship catalog (prices / class) — keep in sync with SHIP_CATALOG in js/data.js
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

create or replace function app.danger_pay(p_danger text)
returns double precision
language sql immutable as $$
  select case p_danger
    when 'safe' then 1.0 when 'low' then 1.4 when 'moderate' then 2.0
    when 'high' then 3.2 when 'extreme' then 5.0 else 1.0 end;
$$;

create or replace function app.danger_base_success(p_danger text)
returns double precision
language sql immutable as $$
  select case p_danger
    when 'safe' then 0.98 when 'low' then 0.85 when 'moderate' then 0.6
    when 'high' then 0.4 when 'extreme' then 0.22 else 0.6 end;
$$;

create or replace function app.rep_discount(p_state jsonb)
returns double precision
language plpgsql immutable as $$
declare
  best double precision := 0;
  v double precision;
  fac text;
begin
  -- REP.discountMax = 0.10 at +100 standing with best faction
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
  if p_faction is null then return 1.0; end if;
  standing := coalesce((p_state->'reputation'->>p_faction)::float8, 0);
  -- REP.rewardMaxBonus = 0.25 at +100
  return 1.0 + greatest(0, least(0.25, (standing / 100.0) * 0.25));
end;
$$;

create or replace function app.fleet_power(p_ships jsonb, p_uids jsonb)
returns double precision
language plpgsql immutable as $$
declare
  total double precision := 0;
  uid text;
  sh jsonb;
  def record;
begin
  for uid in select jsonb_array_elements_text(p_uids) loop
    select value into sh from jsonb_array_elements(p_ships) sh(value)
      where sh.value->>'uid' = uid limit 1;
    if sh is null then continue; end if;
    select * into def from app.ship_def(sh->>'type');
    if def.id is null then continue; end if;
    total := total + coalesce(def.firepower, 0);
  end loop;
  return total;
end;
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
    'name', coalesce(p_name, initcap(p_type)),
    'status', 'idle',
    'accessories', '[]'::jsonb,
    'mercenary', coalesce(p_merc, false),
    'expiresAt', p_expires,
    'retrieveCost', 0,
    'dmg', 0
  );
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
    'bazaar', p_state->'bazaar',
    'seq', coalesce((p_state->>'seq')::int, 1),
    'stats', p_state->'stats',
    'reputation', p_state->'reputation',
    'currentSystem', p_state->>'currentSystem',
    'travel', p_state->'travel',
    'unlockedSystems', p_state->'unlockedSystems'
  );
$$;

-- ---------------------------------------------------------------------------
-- app_mission_launch(contract, ship_uids)
-- ---------------------------------------------------------------------------
create or replace function public.app_mission_launch(p_contract jsonb, p_ship_uids jsonb)
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
begin
  if p_contract is null or jsonb_typeof(p_ship_uids) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'Invalid mission.');
  end if;

  st := app._lock_state(now_ms);
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

  danger := coalesce(p_contract->>'danger', 'moderate');
  min_fp := coalesce((p_contract->>'minFirepower')::float8, 0);
  cargo_req := coalesce((p_contract->>'cargoRequired')::float8, 0);
  duration_ms := coalesce((p_contract->>'durationMs')::float8, 600000);
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
  mission := jsonb_build_object(
    'uid', 'm' || seq,
    'type', p_contract->>'type',
    'title', p_contract->>'title',
    'sysName', p_contract->>'sysName',
    'shipUids', uids,
    'phases', phases,
    'totalMs', total_ms,
    'startedAt', now_ms,
    'successChance', chance,
    'reward', p_contract->'reward',
    'impound', coalesce((p_contract->>'impound')::boolean, false),
    'danger', danger,
    'stakeTier', coalesce((p_contract->>'stakeTier')::int, 0),
    'faction', p_contract->>'faction',
    'resolved', false
  );

  -- mark ships as on mission
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

  st := jsonb_set(st, '{ships}', ships);
  st := jsonb_set(st, '{missions}', coalesce(st->'missions', '[]'::jsonb) || jsonb_build_array(mission));
  st := jsonb_set(st, '{seq}', to_jsonb(seq));
  perform app._write_state(st, now_ms);

  return app.result_slice(st) || jsonb_build_object('mission', mission);
end;
$$;

-- ---------------------------------------------------------------------------
-- app_mission_resolve() — mature due missions with server RNG
-- ---------------------------------------------------------------------------
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
  sh jsonb;
  lost_uids text[] := array[]::text[];
  destroy_p double precision;
  i int := 0;
  any_done boolean := false;
  stats jsonb;
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
    seed := market.seed_hash('cosmocrat-market-v1', 'mission', m->>'uid', now_ms::text);
    roll := market.u01(seed, 0);
    success := roll < coalesce((m->>'successChance')::float8, 0.5);

    -- simplified attrition: small destroy chance on failure
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
      payout := case when gross > 0 then round(gross * (1.0 - tax_rate)) else 0 end;
      report := jsonb_set(report, '{credits}', to_jsonb(payout));
      report := jsonb_set(report, '{taxed}', to_jsonb(gross - payout));
      credits := credits + payout;
      stats := coalesce(st->'stats', '{}'::jsonb);
      stats := jsonb_set(stats, '{contractsDone}',
        to_jsonb(coalesce((stats->>'contractsDone')::int, 0) + 1));
      st := jsonb_set(st, '{stats}', stats);
      -- free survivors
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
      -- impound or free
      ships := (
        select coalesce(jsonb_agg(
          case
            when x.value->>'uid' = any(lost_uids) then x.value  -- drop below
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

    -- remove destroyed ships
    if array_length(lost_uids, 1) is not null then
      ships := (
        select coalesce(jsonb_agg(x.value), '[]'::jsonb)
        from jsonb_array_elements(ships) x(value)
        where not (x.value->>'uid' = any(lost_uids))
      );
      report := jsonb_set(report, '{lost}', (
        select coalesce(jsonb_agg(jsonb_build_object('uid', u, 'name', u)), '[]'::jsonb)
        from unnest(lost_uids) u
      ));
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

-- ---------------------------------------------------------------------------
-- Catalog purchases
-- ---------------------------------------------------------------------------
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
  cap double precision;
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
  cap := case tier when 0 then 3 when 1 then 4 when 2 then 5 when 3 then 6
    when 4 then 7 when 5 then 8 else 10 end;
  if jsonb_array_length(ships) >= cap then
    return jsonb_build_object('ok', false, 'error', 'Fleet at capacity — ascend a Baron Tier to command more.');
  end if;
  price := round(def.price * (1.0 - app.rep_discount(st)));
  credits := coalesce((st->>'credits')::float8, 0);
  if price > credits then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
  end if;
  seq := coalesce((st->>'seq')::int, 1) + 1;
  sh := app.make_ship(seq, def.id, null, false, null);
  credits := credits - price;
  st := jsonb_set(st, '{credits}', to_jsonb(credits));
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
  cost := round(6000 * power(1.8, lvl));  -- BAZAARCFG.inventoryUpgradeBase
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

-- Board offers: validate against state.bazaar (client soft-syncs board; prices locked at purchase)
create or replace function public.app_buy_merc(p_offer_id text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  bazaar jsonb;
  mercs jsonb;
  offer jsonb;
  credits double precision;
  seq int;
  sh jsonb;
  ships jsonb;
begin
  st := app._lock_state(now_ms);
  bazaar := coalesce(st->'bazaar', '{}'::jsonb);
  mercs := coalesce(bazaar->'mercs', '[]'::jsonb);
  select value into offer from jsonb_array_elements(mercs) x(value)
    where x.value->>'id' = p_offer_id limit 1;
  if offer is null then
    return jsonb_build_object('ok', false, 'error', 'Offer gone.');
  end if;
  credits := coalesce((st->>'credits')::float8, 0);
  if coalesce((offer->>'hireCost')::float8, 0) > credits then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
  end if;
  seq := coalesce((st->>'seq')::int, 1) + 1;
  sh := app.make_ship(seq, offer->>'shipType', offer->>'name', true,
    now_ms + coalesce((offer->>'serviceMs')::bigint, 900000));
  ships := coalesce(st->'ships', '[]'::jsonb) || jsonb_build_array(sh);
  mercs := (
    select coalesce(jsonb_agg(value), '[]'::jsonb) from jsonb_array_elements(mercs) x(value)
    where x.value->>'id' is distinct from p_offer_id
  );
  bazaar := jsonb_set(bazaar, '{mercs}', mercs);
  st := jsonb_set(st, '{credits}', to_jsonb(credits - (offer->>'hireCost')::float8));
  st := jsonb_set(st, '{ships}', ships);
  st := jsonb_set(st, '{bazaar}', bazaar);
  st := jsonb_set(st, '{seq}', to_jsonb(seq));
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
  bazaar jsonb;
  accs jsonb;
  offer jsonb;
  price double precision;
  credits double precision;
  items jsonb;
  item jsonb;
  inv jsonb;
  used int;
  cap int;
begin
  st := app._lock_state(now_ms);
  bazaar := coalesce(st->'bazaar', '{}'::jsonb);
  accs := coalesce(bazaar->'accessories', '[]'::jsonb);
  select value into offer from jsonb_array_elements(accs) x(value)
    where x.value->>'id' = p_offer_id limit 1;
  if offer is null then
    return jsonb_build_object('ok', false, 'error', 'Sold to another buyer.');
  end if;
  inv := coalesce(st->'inventory', '{"capacity":6,"upgrades":0}'::jsonb);
  items := coalesce(st->'items', '{}'::jsonb);
  used := (select count(*)::int from jsonb_object_keys(items));
  cap := coalesce((inv->>'capacity')::int, 6);
  if used >= cap then
    return jsonb_build_object('ok', false, 'error', 'Inventory full.');
  end if;
  price := round(coalesce((offer->>'price')::float8, 0) * (1.0 - app.rep_discount(st)));
  credits := coalesce((st->>'credits')::float8, 0);
  if price > credits then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
  end if;
  item := offer->'item';
  if item is null or item->>'uid' is null then
    return jsonb_build_object('ok', false, 'error', 'Malformed offer.');
  end if;
  items := jsonb_set(items, array[item->>'uid'], item);
  accs := (
    select coalesce(jsonb_agg(value), '[]'::jsonb) from jsonb_array_elements(accs) x(value)
    where x.value->>'id' is distinct from p_offer_id
  );
  bazaar := jsonb_set(bazaar, '{accessories}', accs);
  st := jsonb_set(st, '{credits}', to_jsonb(credits - price));
  st := jsonb_set(st, '{items}', items);
  st := jsonb_set(st, '{bazaar}', bazaar);
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
  bazaar jsonb;
  contracts jsonb;
  offer jsonb;
  credits double precision;
begin
  st := app._lock_state(now_ms);
  bazaar := coalesce(st->'bazaar', '{}'::jsonb);
  contracts := coalesce(bazaar->'contracts', '[]'::jsonb);
  select value into offer from jsonb_array_elements(contracts) x(value)
    where x.value->>'id' = p_offer_id and x.value->>'status' = 'open' limit 1;
  if offer is null then
    return jsonb_build_object('ok', false, 'error', 'Contract no longer available.');
  end if;

  contracts := (
    select coalesce(jsonb_agg(value), '[]'::jsonb) from jsonb_array_elements(contracts) x(value)
    where x.value->>'id' is distinct from p_offer_id
  );
  bazaar := jsonb_set(bazaar, '{contracts}', contracts);

  if offer->>'kind' = 'tip' then
    credits := coalesce((st->>'credits')::float8, 0);
    if coalesce((offer->>'cost')::float8, 0) > credits then
      return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
    end if;
    st := jsonb_set(st, '{credits}', to_jsonb(credits - (offer->>'cost')::float8));
    st := jsonb_set(st, '{bazaar}', bazaar);
    perform app._write_state(st, now_ms);
    return app.result_slice(st) || jsonb_build_object('tip', true, 'cat', offer->>'cat');
  end if;

  st := jsonb_set(st, '{bazaar}', bazaar);
  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('contract', offer);
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
  payout := round(greatest(0, coalesce(def.price, 0) * 0.5));  -- shipResaleMult
  -- gear resale + remove installed accessories from items
  for uid in select jsonb_array_elements_text(coalesce(sh->'accessories', '[]'::jsonb)) loop
    it := items->uid;
    if it is not null then
      gear := gear + coalesce((it->>'value')::float8, 0) * 0.55;  -- itemResaleMult
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
  payout := round(coalesce((it->>'value')::float8, 0) * 0.55);
  credits := coalesce((st->>'credits')::float8, 0) + payout;
  items := items - p_uid;
  st := jsonb_set(st, '{credits}', to_jsonb(credits));
  st := jsonb_set(st, '{items}', items);
  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('creditsGained', payout);
end;
$$;

-- Tighten app_commit: protect mission/bazaar-owned slices; still accept soft
-- credits/positions for routes/industries/expeditions until Phase 3.
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

  -- Phase 2: fleet / missions / items / inventory owned by RPCs
  merged := jsonb_set(merged, '{ships}', coalesce(server->'ships', '[]'::jsonb));
  merged := jsonb_set(merged, '{mainShip}', coalesce(server->'mainShip', '{"type":"pinnace"}'::jsonb));
  merged := jsonb_set(merged, '{missions}', coalesce(server->'missions', '[]'::jsonb));
  merged := jsonb_set(merged, '{items}', coalesce(server->'items', '{}'::jsonb));
  merged := jsonb_set(merged, '{inventory}', coalesce(server->'inventory', '{"capacity":6,"upgrades":0}'::jsonb));
  -- Bazaar board: accept client (display/seed sync) so offer purchases can validate.
  -- Purchase RPCs still debit server credits & mutate server fleet/items.

  -- Soft income interim: credits/positions/avgCost still from client (routes etc.)
  -- Trade / contract counters: keep the higher server value when ahead.
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

grant execute on function public.app_mission_launch(jsonb, jsonb) to authenticated;
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
