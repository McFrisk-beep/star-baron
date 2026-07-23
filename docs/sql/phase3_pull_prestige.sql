-- Phase 3 — offline catch-up (app_pull) + prestige (app_prestige)
-- Requires: market_price.sql + phase1_players.sql + phase2_missions_bazaar.sql
-- Paste into SQL Editor and Run. See docs/PHASE3_SETUP.md.
--
-- Trust model: soft income (routes, industries, expeditions, legacy listings)
-- and prestige are computed server-side from locked state + market_price().
-- app_commit then protects credits/positions/avgCost/prestige (and timers).

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Baron-tier thresholds (net worth to ascend INTO that tier). Match BARON_TIERS.
-- ---------------------------------------------------------------------------
create or replace function app._tier_threshold(p_tier int)
returns double precision
language sql immutable as $$
  select case greatest(0, coalesce(p_tier, 0))
    when 0 then 0::float8
    when 1 then 1000000
    when 2 then 2500000
    when 3 then 6000000
    when 4 then 15000000
    when 5 then 40000000
    when 6 then 100000000
    else 1e18
  end;
$$;

create or replace function app._extractor_yield_mult(p_type text)
returns double precision
language sql immutable as $$
  select case p_type
    when 'specialized' then 1.5
    when 'semi' then 1.0
    when 'jack' then 0.6
    else 0.6 end;
$$;

-- Planet suitability lookup (PLANET_SUITABILITY in js/data.js). Unknown → 1.
create or replace function app._planet_suit(p_type text, p_cat text)
returns double precision
language sql immutable as $$
  select coalesce((
    select s from (values
      ('rocky','mineral',1.4),('rocky','gas',0.6),('rocky','agri',0.4),('rocky','tech',1.0),('rocky','luxury',0.7),('rocky','illicit',0.9),
      ('terran','mineral',0.6),('terran','gas',0.8),('terran','agri',1.8),('terran','tech',1.1),('terran','luxury',1.3),('terran','illicit',0.6),
      ('ocean','mineral',0.5),('ocean','gas',1.2),('ocean','agri',1.5),('ocean','tech',0.9),('ocean','luxury',1.2),('ocean','illicit',0.7),
      ('ice','mineral',0.8),('ice','gas',1.7),('ice','agri',0.3),('ice','tech',0.9),('ice','luxury',0.6),('ice','illicit',0.8),
      ('lava','mineral',1.8),('lava','gas',0.6),('lava','agri',0.1),('lava','tech',1.2),('lava','luxury',0.5),('lava','illicit',1.0),
      ('gas_giant','mineral',0.3),('gas_giant','gas',1.9),('gas_giant','agri',0.1),('gas_giant','tech',0.8),('gas_giant','luxury',0.6),('gas_giant','illicit',0.7),
      ('barren','mineral',1.5),('barren','gas',0.5),('barren','agri',0.1),('barren','tech',0.9),('barren','luxury',0.5),('barren','illicit',1.2),
      ('ringed','mineral',1.2),('ringed','gas',1.3),('ringed','agri',0.3),('ringed','tech',1.0),('ringed','luxury',1.1),('ringed','illicit',0.8),
      ('toxic','mineral',1.1),('toxic','gas',1.0),('toxic','agri',0.05),('toxic','tech',1.2),('toxic','luxury',0.5),('toxic','illicit',1.6)
    ) as t(ptype, cat, s) where t.ptype = p_type and t.cat = p_cat
  ), 1.0);
$$;

-- Catalog ship cargo/speed (accessories ignored — ponytail; add if fleet buffs matter).
create or replace function app._ship_cargo(p_type text)
returns double precision
language sql immutable as $$
  select coalesce((select cargo from app.ship_def(p_type)), 0);
$$;

create or replace function app._ship_speed(p_type text)
returns double precision
language sql immutable as $$
  select greatest(0.1, coalesce((select speed from app.ship_def(p_type)), 1));
$$;

-- Net worth for prestige gate (spot prices, no client impact overlays).
create or replace function app._net_worth(p_state jsonb, p_now_ms bigint)
returns double precision
language plpgsql stable as $$
declare
  nw double precision := coalesce((p_state->>'credits')::float8, 0);
  sys text := coalesce(p_state->>'currentSystem', 'navos');
  comm text;
  qty double precision;
  sh jsonb;
  def record;
  it jsonb;
begin
  for comm, qty in
    select key, coalesce(value::text::float8, 0)
    from jsonb_each(coalesce(p_state->'positions', '{}'::jsonb))
  loop
    if qty > 0 then
      nw := nw + qty * market.price_system(comm, sys, p_now_ms::float8);
    end if;
  end loop;

  -- Main ship catalog price
  select * into def from app.ship_def(coalesce(p_state->'mainShip'->>'type', 'pinnace'));
  if def.id is not null then nw := nw + coalesce(def.price, 0); end if;

  for sh in select value from jsonb_array_elements(coalesce(p_state->'ships', '[]'::jsonb)) loop
    if coalesce((sh->>'mercenary')::boolean, false) then continue; end if;
    select * into def from app.ship_def(sh->>'type');
    if def.id is not null then nw := nw + coalesce(def.price, 0); end if;
  end loop;

  for it in select value from jsonb_each(coalesce(p_state->'items', '{}'::jsonb)) loop
    nw := nw + app.item_value(it.value);
  end loop;

  return nw;
end;
$$;

-- Extended result slice (Phase 3 fields for client reconcile).
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
    'lastSeenAt', (p_state->>'lastSeenAt')::bigint
  );
$$;

-- ===========================================================================
-- Catch-up helpers (mutate state + return recap fragments)
-- ===========================================================================

-- Legacy bazaar listings: pay recomputed sell-now (item_value × 0.55), never listPrice.
create or replace function app._catchup_listings(p_state jsonb, p_now_ms bigint)
returns jsonb
language plpgsql immutable as $$
declare
  st jsonb := p_state;
  kept jsonb := '[]'::jsonb;
  sold jsonb := '[]'::jsonb;
  l jsonb;
  it jsonb;
  payout double precision;
  credits double precision := coalesce((st->>'credits')::float8, 0);
  items jsonb := coalesce(st->'items', '{}'::jsonb);
begin
  for l in select value from jsonb_array_elements(coalesce(st->'listings', '[]'::jsonb)) loop
    if p_now_ms < coalesce((l->>'sellAt')::bigint, 0) then
      kept := kept || jsonb_build_array(l);
      continue;
    end if;
    it := items->(l->>'itemUid');
    if it is null or jsonb_typeof(it) <> 'object' then
      continue;  -- item gone — drop listing
    end if;
    payout := round(app.item_value(it) * 0.55);
    credits := credits + payout;
    items := items - (l->>'itemUid');
    sold := sold || jsonb_build_array(jsonb_build_object(
      'name', coalesce(it->>'name', 'item'),
      'price', payout
    ));
  end loop;
  st := jsonb_set(st, '{credits}', to_jsonb(credits));
  st := jsonb_set(st, '{items}', items);
  st := jsonb_set(st, '{listings}', kept);
  return jsonb_build_object('state', st, 'sold', sold);
end;
$$;

-- Trade routes: bank spread × cargo × margin × cycles (capped), seeded event swing.
create or replace function app._catchup_routes(p_state jsonb, p_now_ms bigint)
returns jsonb
language plpgsql stable as $$
declare
  st jsonb := p_state;
  routes jsonb := '[]'::jsonb;
  runs jsonb := '[]'::jsonb;
  events jsonb := '[]'::jsonb;
  route jsonb;
  uids jsonb;
  uid text;
  sh jsonb;
  cargo double precision;
  speed double precision;
  min_speed double precision;
  dist double precision;
  cycle_ms double precision;
  cycles int;
  buy_p double precision;
  sell_p double precision;
  per double precision;
  gain double precision;
  total double precision := 0;
  unlocked jsonb;
  seed bigint;
  roll double precision;
  ev_mult double precision;
  delta double precision;
  tax_rate double precision;
  credits double precision;
  next_at bigint;
  any_ship boolean;
begin
  unlocked := coalesce(st->'unlockedSystems', '[]'::jsonb);
  tax_rate := app._tier_tax(coalesce((st->'prestige'->>'tier')::int, 0));

  for route in select value from jsonb_array_elements(coalesce(st->'routes', '[]'::jsonb)) loop
    -- Keep only trading ships that still exist
    uids := '[]'::jsonb;
    cargo := 0;
    min_speed := null;
    any_ship := false;
    for uid in select jsonb_array_elements_text(coalesce(route->'shipUids', '[]'::jsonb)) loop
      select value into sh from jsonb_array_elements(coalesce(st->'ships', '[]'::jsonb)) x(value)
        where x.value->>'uid' = uid and x.value->>'status' = 'trading' limit 1;
      if sh is null then continue; end if;
      any_ship := true;
      uids := uids || jsonb_build_array(uid);
      cargo := cargo + app._ship_cargo(sh->>'type');
      speed := app._ship_speed(sh->>'type');
      if min_speed is null or speed < min_speed then min_speed := speed; end if;
    end loop;

    if not any_ship or jsonb_array_length(uids) = 0 then
      continue;  -- dead route dropped
    end if;
    route := jsonb_set(route, '{shipUids}', uids);

    if not exists (
         select 1 from jsonb_array_elements_text(unlocked) u where u = route->>'from'
       )
       or not exists (
         select 1 from jsonb_array_elements_text(unlocked) u where u = route->>'to'
       ) then
      -- pause: bump nextAt if due
      if p_now_ms >= coalesce((route->>'nextAt')::bigint, 0) then
        dist := greatest(1.0, abs(app._system_distance(route->>'from') - app._system_distance(route->>'to')));
        cycle_ms := greatest(1000.0, (2.0 * dist * 150.0) / coalesce(min_speed, 1) * 1000.0);
        route := jsonb_set(route, '{nextAt}', to_jsonb((p_now_ms + cycle_ms::bigint)));
      end if;
      routes := routes || jsonb_build_array(route);
      continue;
    end if;

    next_at := coalesce((route->>'nextAt')::bigint, p_now_ms);
    if p_now_ms < next_at then
      routes := routes || jsonb_build_array(route);
      continue;
    end if;

    dist := greatest(1.0, abs(app._system_distance(route->>'from') - app._system_distance(route->>'to')));
    cycle_ms := greatest(1000.0, (2.0 * dist * 150.0) / coalesce(min_speed, 1) * 1000.0);
    cycles := least(
      (floor((p_now_ms - next_at)::float8 / cycle_ms) + 1)::int,
      50  -- ROUTECFG.maxCyclesPerResolve
    );

    buy_p := market.price_system(route->>'comm', route->>'from', p_now_ms::float8);
    sell_p := market.price_system(route->>'comm', route->>'to', p_now_ms::float8);
    per := round(greatest(0, sell_p - buy_p) * cargo * 0.5);  -- ROUTECFG.margin

    -- Seeded event (once per banking batch). Quiet if roll misses eventChance.
    delta := 0;
    if per > 0 then
      seed := market.seed_hash('cosmocrat-market-v1', 'route', route->>'id', next_at::text);
      if market.u01(seed, 0) < 0.45 then
        -- Weighted pick over 8 events (weights 3,3,3,2,2,2,3,2 → total 20)
        roll := market.u01(seed, 1) * 20.0;
        if roll < 3 then ev_mult := 0.55 + market.u01(seed, 2) * 0.30;       -- bribe
        elsif roll < 6 then ev_mult := -0.4 + market.u01(seed, 2) * 0.90;    -- pirates
        elsif roll < 9 then ev_mult := 0.55 + market.u01(seed, 2) * 0.35;     -- reroute
        elsif roll < 11 then ev_mult := -0.5 + market.u01(seed, 2) * 0.90;   -- badtrade
        elsif roll < 13 then ev_mult := 0.85 + market.u01(seed, 2) * 0.20;   -- damage (no hull for now)
        elsif roll < 15 then ev_mult := 0.4 + market.u01(seed, 2) * 0.40;    -- customs
        elsif roll < 18 then ev_mult := 1.25 + market.u01(seed, 2) * 0.45;  -- fastdeal
        else ev_mult := 1.2 + market.u01(seed, 2) * 0.35;                   -- windfall
        end if;
        delta := round(per * (ev_mult - 1.0));
        events := events || jsonb_build_array(jsonb_build_object(
          'id', 'route_ev', 'delta', delta, 'comm', route->>'comm',
          'from', route->>'from', 'to', route->>'to', 'good', delta >= 0
        ));
      end if;
    end if;

    gain := per * cycles + delta;
    if gain <> 0 then
      total := total + gain;
      runs := runs || jsonb_build_array(jsonb_build_object(
        'comm', route->>'comm', 'gain', gain, 'cycles', cycles
      ));
    end if;
    route := jsonb_set(route, '{nextAt}', to_jsonb((p_now_ms + cycle_ms::bigint)));
    routes := routes || jsonb_build_array(route);
  end loop;

  if total <> 0 then
    -- Baron tax on positive only; never drive credits below 0
    if total > 0 then total := round(total * (1.0 - tax_rate)); end if;
    credits := greatest(0, coalesce((st->>'credits')::float8, 0) + total);
    st := jsonb_set(st, '{credits}', to_jsonb(credits));
  end if;
  st := jsonb_set(st, '{routes}', routes);
  return jsonb_build_object('state', st, 'routed', jsonb_build_object('total', total, 'runs', runs, 'events', events));
end;
$$;

-- Industries: produce into positions (ignore war/strike overlays — mult=1).
create or replace function app._catchup_industries(p_state jsonb, p_now_ms bigint)
returns jsonb
language plpgsql immutable as $$
declare
  st jsonb := p_state;
  inds jsonb := '[]'::jsonb;
  made jsonb := '[]'::jsonb;
  lost jsonb := '[]'::jsonb;
  ind jsonb;
  ex jsonb;
  comps jsonb;
  comp jsonb;
  uid text;
  rate_bon double precision;
  speed_bon double precision;
  cycle_bon double precision;
  suit double precision;
  ymult double precision;
  gross double precision;
  tax_r double precision;
  net int;
  cycle_ms double precision;
  cycles int;
  qty int;
  held double precision;
  prev_avg double precision;
  positions jsonb;
  avg_cost jsonb;
  fac text;
  rep_v double precision;
  cat text;
  next_at bigint;
begin
  positions := coalesce(st->'positions', '{}'::jsonb);
  avg_cost := coalesce(st->'avgCost', '{}'::jsonb);

  for ind in select value from jsonb_array_elements(coalesce(st->'industries', '[]'::jsonb)) loop
    fac := null;
    -- Seizure: faction standing ≤ −40 (skip if planetType/core neutral — no fac stored)
    if ind->>'faction' is not null and ind->>'faction' <> '' then
      fac := ind->>'faction';
      rep_v := coalesce((st->'reputation'->>fac)::float8, 0);
      if rep_v <= -40 then
        lost := lost || jsonb_build_array(jsonb_build_object(
          'name', coalesce(ind->>'id', ind->>'systemId'), 'faction', fac
        ));
        continue;
      end if;
    end if;

    if ind->>'extractorUid' is null or ind->>'commodity' is null
       or ind->>'nextAt' is null then
      inds := inds || jsonb_build_array(ind);
      continue;
    end if;

    next_at := (ind->>'nextAt')::bigint;
    if p_now_ms < next_at then
      inds := inds || jsonb_build_array(ind);
      continue;
    end if;

    ex := st->'extractors'->(ind->>'extractorUid');
    if ex is null or jsonb_typeof(ex) <> 'object' then
      inds := inds || jsonb_build_array(ind);
      continue;
    end if;

    -- Component bonuses
    rate_bon := 1.0;
    speed_bon := 0.0;
    for uid in select jsonb_array_elements_text(coalesce(ex->'components', '[]'::jsonb)) loop
      comp := st->'components'->uid;
      if comp is null then continue; end if;
      if comp->>'kind' = 'rate' then
        rate_bon := rate_bon + coalesce((comp->>'amount')::float8, 0);
      else
        speed_bon := speed_bon + coalesce((comp->>'amount')::float8, 0);
      end if;
    end loop;
    cycle_bon := greatest(0.4, 1.0 - speed_bon);

    cat := coalesce(ind->>'cat', 'mineral');
    suit := case
      when ind->>'planetType' is not null then app._planet_suit(ind->>'planetType', cat)
      when ind->>'suit' is not null then least(2.0, greatest(0.1, (ind->>'suit')::float8))
      else 1.0
    end;
    ymult := app._extractor_yield_mult(ex->>'type');
    gross := round(50.0 * suit * ymult * rate_bon);  -- INDUSTRYCFG.baseYield

    -- Tax: neutral 5%; faction base 12% ± rep (no senate overlay)
    if fac is null or fac = '' then
      tax_r := 0.05;
    else
      rep_v := coalesce((st->'reputation'->>fac)::float8, 0);
      tax_r := 0.12;
      if rep_v >= 0 then
        tax_r := tax_r * (1.0 - rep_v / 100.0 * 0.6);
      else
        tax_r := tax_r * (1.0 + least(1.0, (-rep_v) / 40.0) * 1.5);
      end if;
    end if;
    tax_r := greatest(0.02, least(0.75, tax_r));
    net := case when gross > 0 then greatest(1, (gross - ceil(gross * tax_r))::int) else 0 end;
    cycle_ms := 12.0 * 60 * 60 * 1000 * cycle_bon;
    cycles := least(
      (floor((p_now_ms - next_at)::float8 / cycle_ms) + 1)::int,
      8  -- INDUSTRYCFG.maxCyclesPerResolve
    );
    qty := net * cycles;
    if qty > 0 then
      held := coalesce((positions->>(ind->>'commodity'))::float8, 0);
      prev_avg := coalesce((avg_cost->>(ind->>'commodity'))::float8, 0);
      positions := jsonb_set(positions, array[ind->>'commodity'], to_jsonb(held + qty));
      avg_cost := jsonb_set(avg_cost, array[ind->>'commodity'],
        to_jsonb(case when (held + qty) > 0 then (held * prev_avg) / (held + qty) else 0 end));
      made := made || jsonb_build_array(jsonb_build_object(
        'commodity', ind->>'commodity', 'qty', qty
      ));
    end if;
    ind := jsonb_set(ind, '{nextAt}', to_jsonb((p_now_ms + cycle_ms::bigint)));
    inds := inds || jsonb_build_array(ind);
  end loop;

  st := jsonb_set(st, '{industries}', inds);
  st := jsonb_set(st, '{positions}', positions);
  st := jsonb_set(st, '{avgCost}', avg_cost);
  return jsonb_build_object('state', st, 'industry', made, 'industryLost', lost);
end;
$$;

-- Expeditions: seeded outcomes. Credits / dry / hazard / faction; gear→credit stub; seam→dry.
create or replace function app._catchup_expeditions(p_state jsonb, p_now_ms bigint)
returns jsonb
language plpgsql immutable as $$
declare
  st jsonb := p_state;
  kept jsonb := '[]'::jsonb;
  reports jsonb := coalesce(st->'reports', '[]'::jsonb);
  out_reps jsonb := '[]'::jsonb;
  exp jsonb;
  sh jsonb;
  ships jsonb;
  seed bigint;
  roll double precision;
  kind text;
  band text;
  amt int;
  credits double precision;
  report jsonb;
  danger double precision;
  destroy_p double precision;
  dmg double precision;
  fac text;
  rep jsonb;
  surveyed jsonb;
begin
  ships := coalesce(st->'ships', '[]'::jsonb);
  credits := coalesce((st->>'credits')::float8, 0);
  surveyed := coalesce(st->'surveyed', '{}'::jsonb);

  for exp in select value from jsonb_array_elements(coalesce(st->'expeditions', '[]'::jsonb)) loop
    if coalesce((exp->>'resolved')::boolean, false)
       or p_now_ms < coalesce((exp->>'startedAt')::bigint, 0)
                    + coalesce((exp->>'etaMs')::float8, 0) then
      kept := kept || jsonb_build_array(exp);
      continue;
    end if;

    select value into sh from jsonb_array_elements(ships) x(value)
      where x.value->>'uid' = exp->>'shipUid' limit 1;

    report := jsonb_build_object(
      'uid', exp->>'id', 'type', 'survey',
      'title', 'Survey — ' || coalesce(exp->>'sysId', 'outpost'),
      'sysName', coalesce(exp->>'sysId', 'outpost'),
      'success', true, 'ts', p_now_ms,
      'credits', 0, 'items', '[]'::jsonb,
      'lost', '[]'::jsonb, 'damaged', '[]'::jsonb, 'summary', ''
    );

    if sh is null then
      report := jsonb_set(report, '{success}', 'false'::jsonb);
      report := jsonb_set(report, '{summary}',
        to_jsonb(('Lost contact with the survey ship near ' || coalesce(exp->>'sysId', 'an outpost') || '.')::text));
    else
      band := case when coalesce((exp->>'far')::boolean, false) then 'far' else 'near' end;
      danger := least(1.0, greatest(0.0, coalesce((exp->>'danger')::float8, 0.2)));
      seed := coalesce((exp->>'rngSeed')::bigint,
        market.seed_hash('cosmocrat-market-v1', 'exped', exp->>'id', (exp->>'startedAt')));
      roll := market.u01(seed, 0);

      -- Weights near: gear3 seam3 credits3 faction2 hazard1 dry4 = 16
      -- far: gear4 seam3 credits3 faction2 hazard4 dry2 = 18
      if band = 'far' then
        if roll < 4.0/18 then kind := 'gear';
        elsif roll < 7.0/18 then kind := 'seam';
        elsif roll < 10.0/18 then kind := 'credits';
        elsif roll < 12.0/18 then kind := 'faction';
        elsif roll < 16.0/18 then kind := 'hazard';
        else kind := 'dry'; end if;
      else
        if roll < 3.0/16 then kind := 'gear';
        elsif roll < 6.0/16 then kind := 'seam';
        elsif roll < 9.0/16 then kind := 'credits';
        elsif roll < 11.0/16 then kind := 'faction';
        elsif roll < 12.0/16 then kind := 'hazard';
        else kind := 'dry'; end if;
      end if;

      if kind in ('gear', 'seam') then
        -- Simplified: gear/seam → modest credit stub (no item gen / local events)
        amt := case when band = 'far' then 800 + floor(market.u01(seed, 1) * 1201)::int
                    else 200 + floor(market.u01(seed, 1) * 501)::int end;
        credits := credits + amt;
        report := jsonb_set(report, '{credits}', to_jsonb(amt));
        report := jsonb_set(report, '{summary}',
          to_jsonb(('Salvaged data near ' || coalesce(exp->>'sysId', 'an outpost') || '.')::text));
        ships := (
          select coalesce(jsonb_agg(
            case when x.value->>'uid' = exp->>'shipUid'
              then jsonb_set(x.value, '{status}', '"idle"') else x.value end
          ), '[]'::jsonb) from jsonb_array_elements(ships) x(value)
        );
      elsif kind = 'credits' then
        if band = 'far' then
          amt := 1500 + floor(market.u01(seed, 1) * 4501)::int;
        else
          amt := 300 + floor(market.u01(seed, 1) * 901)::int;
        end if;
        credits := credits + amt;
        report := jsonb_set(report, '{credits}', to_jsonb(amt));
        report := jsonb_set(report, '{summary}',
          to_jsonb(('Salvaged and sold data — +' || amt::text || 'c.')::text));
        ships := (
          select coalesce(jsonb_agg(
            case when x.value->>'uid' = exp->>'shipUid'
              then jsonb_set(x.value, '{status}', '"idle"') else x.value end
          ), '[]'::jsonb) from jsonb_array_elements(ships) x(value)
        );
      elsif kind = 'faction' then
        fac := coalesce(exp->>'faction', 'free_trade');
        amt := 3 + round(danger * 4)::int;
        rep := app._rep_change(coalesce(st->'reputation', '{}'::jsonb), fac, amt);
        st := jsonb_set(st, '{reputation}', rep);
        report := jsonb_set(report, '{summary}',
          to_jsonb(('Recovered a faction cache — standing +' || amt::text || '.')::text));
        ships := (
          select coalesce(jsonb_agg(
            case when x.value->>'uid' = exp->>'shipUid'
              then jsonb_set(x.value, '{status}', '"idle"') else x.value end
          ), '[]'::jsonb) from jsonb_array_elements(ships) x(value)
        );
      elsif kind = 'hazard' then
        destroy_p := 0.10 * (0.5 + danger);
        if market.u01(seed, 2) < destroy_p then
          report := jsonb_set(report, '{success}', 'false'::jsonb);
          report := jsonb_set(report, '{lost}', jsonb_build_array(jsonb_build_object(
            'uid', sh->>'uid', 'name', coalesce(sh->>'name', sh->>'uid')
          )));
          report := jsonb_set(report, '{summary}',
            to_jsonb((coalesce(sh->>'name', 'Ship') || ' was lost to a hazard.')::text));
          ships := (
            select coalesce(jsonb_agg(x.value), '[]'::jsonb)
            from jsonb_array_elements(ships) x(value)
            where x.value->>'uid' is distinct from exp->>'shipUid'
          );
        else
          dmg := (0.08 + market.u01(seed, 3) * 0.22) * (0.6 + danger);
          ships := (
            select coalesce(jsonb_agg(
              case when x.value->>'uid' = exp->>'shipUid' then
                jsonb_set(
                  jsonb_set(x.value, '{status}', '"idle"'),
                  '{dmg}', to_jsonb(least(0.85, coalesce((x.value->>'dmg')::float8, 0) + dmg))
                )
              else x.value end
            ), '[]'::jsonb) from jsonb_array_elements(ships) x(value)
          );
          report := jsonb_set(report, '{damaged}', jsonb_build_array(jsonb_build_object(
            'uid', sh->>'uid', 'name', coalesce(sh->>'name', sh->>'uid'),
            'pct', round(dmg * 100)::int
          )));
          report := jsonb_set(report, '{summary}',
            to_jsonb((coalesce(sh->>'name', 'Ship') || ' limped home shaken but intact.')::text));
        end if;
      else  -- dry
        report := jsonb_set(report, '{summary}',
          to_jsonb(('Charted ' || coalesce(exp->>'sysId', 'the system') || '. Nothing of value.')::text));
        ships := (
          select coalesce(jsonb_agg(
            case when x.value->>'uid' = exp->>'shipUid'
              then jsonb_set(x.value, '{status}', '"idle"') else x.value end
          ), '[]'::jsonb) from jsonb_array_elements(ships) x(value)
        );
      end if;
    end if;

    reports := jsonb_build_array(report) || reports;
    if jsonb_array_length(reports) > 20 then
      reports := (
        select coalesce(jsonb_agg(value), '[]'::jsonb)
        from (
          select value, ordinality from jsonb_array_elements(reports) with ordinality
          order by ordinality limit 20
        ) t
      );
    end if;
    out_reps := out_reps || jsonb_build_array(report);
    surveyed := jsonb_set(surveyed, array[exp->>'sysId'], to_jsonb(p_now_ms));
  end loop;

  st := jsonb_set(st, '{credits}', to_jsonb(credits));
  st := jsonb_set(st, '{ships}', ships);
  st := jsonb_set(st, '{expeditions}', kept);
  st := jsonb_set(st, '{reports}', reports);
  st := jsonb_set(st, '{surveyed}', surveyed);
  return jsonb_build_object('state', st, 'surveys', out_reps);
end;
$$;

-- ===========================================================================
-- app_pull() — offline / resume catch-up (server clock only)
-- ===========================================================================
create or replace function public.app_pull()
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  last_seen bigint;
  elapsed bigint;
  max_offline constant bigint := 7::bigint * 24 * 60 * 60 * 1000;
  frag jsonb;
  sold jsonb := '[]'::jsonb;
  routed jsonb := '{"total":0,"runs":[],"events":[]}'::jsonb;
  industry jsonb := '[]'::jsonb;
  surveys jsonb := '[]'::jsonb;
  mission_r jsonb;
  resolved jsonb := '[]'::jsonb;
  nw double precision;
  stats jsonb;
begin
  st := app._lock_state(now_ms);

  -- Cap catch-up window (mirrors CONFIG.maxOfflineMs). Timers older than the
  -- cap are advanced so we don't bank infinite cycles from a forged nextAt.
  last_seen := coalesce((st->>'lastSeenAt')::bigint, now_ms);
  elapsed := greatest(0, now_ms - last_seen);
  if elapsed > max_offline then
    -- Shift route/industry nextAt forward so only max_offline of work banks.
    st := jsonb_set(st, '{routes}', (
      select coalesce(jsonb_agg(
        case when r.value->>'nextAt' is not null
          then jsonb_set(r.value, '{nextAt}',
            to_jsonb(greatest((r.value->>'nextAt')::bigint, now_ms - max_offline)))
          else r.value end
      ), '[]'::jsonb)
      from jsonb_array_elements(coalesce(st->'routes', '[]'::jsonb)) r(value)
    ));
    st := jsonb_set(st, '{industries}', (
      select coalesce(jsonb_agg(
        case when i.value->>'nextAt' is not null
          then jsonb_set(i.value, '{nextAt}',
            to_jsonb(greatest((i.value->>'nextAt')::bigint, now_ms - max_offline)))
          else i.value end
      ), '[]'::jsonb)
      from jsonb_array_elements(coalesce(st->'industries', '[]'::jsonb)) i(value)
    ));
  end if;

  -- Matured missions (reuse Phase 2 RPC logic via internal call pattern:
  -- write interim state, call resolve, re-lock). Simpler: inline by invoking
  -- the public function's body through a state swap — call app_mission_resolve
  -- after writing current st so it sees our locked row.
  perform app._write_state(st, now_ms);
  mission_r := public.app_mission_resolve();
  if mission_r is not null and coalesce((mission_r->>'ok')::boolean, false) then
    -- Re-lock after mission resolve wrote
    st := app._lock_state(now_ms);
    resolved := coalesce(mission_r->'resolved', '[]'::jsonb);
  else
    st := app._lock_state(now_ms);
  end if;

  frag := app._catchup_listings(st, now_ms);
  st := frag->'state';
  sold := coalesce(frag->'sold', '[]'::jsonb);

  frag := app._catchup_routes(st, now_ms);
  st := frag->'state';
  routed := coalesce(frag->'routed', routed);

  frag := app._catchup_industries(st, now_ms);
  st := frag->'state';
  industry := coalesce(frag->'industry', '[]'::jsonb);

  frag := app._catchup_expeditions(st, now_ms);
  st := frag->'state';
  surveys := coalesce(frag->'surveys', '[]'::jsonb);

  -- Peak net worth
  nw := app._net_worth(st, now_ms);
  stats := coalesce(st->'stats', '{}'::jsonb);
  if nw > coalesce((stats->>'peakNetWorth')::float8, 0) then
    stats := jsonb_set(stats, '{peakNetWorth}', to_jsonb(nw));
    st := jsonb_set(st, '{stats}', stats);
  end if;

  perform app._write_state(st, now_ms);

  return app.result_slice(st) || jsonb_build_object(
    'away', jsonb_build_object(
      'elapsedMs', least(elapsed, max_offline),
      'sold', sold,
      'routed', routed,
      'industry', industry,
      'surveys', surveys,
      'resolved', resolved
    )
  );
end;
$$;

-- ===========================================================================
-- app_prestige() — ascend Baron Tier (keep empire; raise tax/caps)
-- ===========================================================================
create or replace function public.app_prestige()
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  tier int;
  next_tier int;
  nw double precision;
  need double precision;
  stats jsonb;
begin
  st := app._lock_state(now_ms);
  tier := coalesce((st->'prestige'->>'tier')::int, 0);
  if tier >= 6 then
    return jsonb_build_object('ok', false, 'error', 'Already Cosmocrat.');
  end if;
  next_tier := tier + 1;
  need := app._tier_threshold(next_tier);
  nw := app._net_worth(st, now_ms);
  if nw < need then
    return jsonb_build_object('ok', false, 'error', 'Net worth too low to ascend.');
  end if;

  st := jsonb_set(st, '{prestige}', jsonb_build_object('tier', next_tier, 'multiplier', 1));
  stats := coalesce(st->'stats', '{}'::jsonb);
  stats := jsonb_set(stats, '{peakNetWorth}',
    to_jsonb(greatest(coalesce((stats->>'peakNetWorth')::float8, 0), nw)));
  st := jsonb_set(st, '{stats}', stats);

  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object(
    'tier', next_tier,
    'title', case next_tier
      when 1 then 'Magnate' when 2 then 'Tycoon' when 3 then 'Oligarch'
      when 4 then 'Plutocrat' when 5 then 'Potentate' else 'Cosmocrat' end,
    'netWorth', nw
  );
end;
$$;

-- ===========================================================================
-- Tighten app_commit — protect economy + catch-up timers + prestige
-- Setup structures (new routes/industries/expeditions/extractors) still merge
-- from the client; production timers & balances are server-owned after pull.
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

  -- Phase 2 owned slices
  merged := jsonb_set(merged, '{ships}', coalesce(server->'ships', '[]'::jsonb));
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
  -- Keep server route/industry nextAt & expedition ETA; accept newly-added
  -- entries from the client (setup), but never let client rewind timers.
  merged := jsonb_set(merged, '{routes}', app._merge_routes(
    coalesce(server->'routes', '[]'::jsonb),
    coalesce(p_state->'routes', '[]'::jsonb)));
  merged := jsonb_set(merged, '{industries}', app._merge_industries(
    coalesce(server->'industries', '[]'::jsonb),
    coalesce(p_state->'industries', '[]'::jsonb)));
  merged := jsonb_set(merged, '{expeditions}', app._merge_expeditions(
    coalesce(server->'expeditions', '[]'::jsonb),
    coalesce(p_state->'expeditions', '[]'::jsonb)));
  -- Extractors/components: accept client (still soft board buys) but don't
  -- let them erase server-owned keys mid-pull — union by uid.
  merged := jsonb_set(merged, '{extractors}',
    coalesce(server->'extractors', '{}'::jsonb) || coalesce(p_state->'extractors', '{}'::jsonb));
  merged := jsonb_set(merged, '{components}',
    coalesce(server->'components', '{}'::jsonb) || coalesce(p_state->'components', '{}'::jsonb));

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

-- Merge helpers: server timers win for known ids; new client entries append.
create or replace function app._merge_routes(p_server jsonb, p_client jsonb)
returns jsonb
language plpgsql immutable as $$
declare
  out jsonb := '[]'::jsonb;
  s jsonb;
  c jsonb;
begin
  for s in select value from jsonb_array_elements(coalesce(p_server, '[]'::jsonb)) loop
    if exists (
      select 1 from jsonb_array_elements(coalesce(p_client, '[]'::jsonb)) c(value)
      where c.value->>'id' = s->>'id'
    ) then
      -- Keep server copy (nextAt authoritative); refresh shipUids from client
      select value into c from jsonb_array_elements(p_client) x(value)
        where x.value->>'id' = s->>'id' limit 1;
      s := jsonb_set(s, '{shipUids}', coalesce(c->'shipUids', s->'shipUids'));
      out := out || jsonb_build_array(s);
    end if;
    -- else: client stopped it — omit
  end loop;
  for c in select value from jsonb_array_elements(coalesce(p_client, '[]'::jsonb)) loop
    if not exists (
      select 1 from jsonb_array_elements(coalesce(p_server, '[]'::jsonb)) s(value)
      where s.value->>'id' = c->>'id'
    ) then
      out := out || jsonb_build_array(c);
    end if;
  end loop;
  return out;
end;
$$;

create or replace function app._merge_industries(p_server jsonb, p_client jsonb)
returns jsonb
language plpgsql immutable as $$
declare
  out jsonb := '[]'::jsonb;
  s jsonb;
  c jsonb;
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
        -- Fresh install/change — take client nextAt
        s := c;
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
      out := out || jsonb_build_array(c);
    end if;
  end loop;
  return out;
end;
$$;

create or replace function app._merge_expeditions(p_server jsonb, p_client jsonb)
returns jsonb
language plpgsql immutable as $$
declare
  out jsonb := '[]'::jsonb;
  s jsonb;
  c jsonb;
begin
  for s in select value from jsonb_array_elements(coalesce(p_server, '[]'::jsonb)) loop
    if exists (
      select 1 from jsonb_array_elements(coalesce(p_client, '[]'::jsonb)) c(value)
      where c.value->>'id' = s->>'id'
    ) then
      out := out || jsonb_build_array(s);  -- server ETA / seed win
    end if;
  end loop;
  for c in select value from jsonb_array_elements(coalesce(p_client, '[]'::jsonb)) loop
    if not exists (
      select 1 from jsonb_array_elements(coalesce(p_server, '[]'::jsonb)) s(value)
      where s.value->>'id' = c->>'id'
    ) then
      -- Stamp a server-ish seed so resolve is reproducible
      if c->>'rngSeed' is null then
        c := jsonb_set(c, '{rngSeed}', to_jsonb(
          market.seed_hash('cosmocrat-market-v1', 'exped', c->>'id', coalesce(c->>'startedAt', '0'))
        ));
      end if;
      out := out || jsonb_build_array(c);
    end if;
  end loop;
  return out;
end;
$$;

grant execute on function public.app_pull() to authenticated;
grant execute on function public.app_prestige() to authenticated;
grant execute on function public.app_commit(jsonb) to authenticated;
