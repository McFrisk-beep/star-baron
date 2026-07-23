-- Phase 1 — server-authoritative trading (Supabase / Postgres)
-- Requires docs/sql/market_price.sql (market.price_system) to be installed first.
-- Paste into the Supabase SQL Editor and Run. See docs/PHASE1_SETUP.md.

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- players table: authoritative state; clients may READ only
-- ---------------------------------------------------------------------------
create table if not exists public.players (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  state      jsonb       not null,
  updated_at timestamptz not null default now()
);
alter table public.players enable row level security;

drop policy if exists "read own player" on public.players;
create policy "read own player" on public.players
  for select using (auth.uid() = user_id);
-- Intentionally NO insert/update/delete policies — only SECURITY DEFINER fns write.

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
create or replace function app._now_ms()
returns bigint
language sql stable as $$
  select (extract(epoch from clock_timestamp()) * 1000.0)::bigint;
$$;

create or replace function app._default_state()
returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'v', 2,
    'credits', 1500,
    'currentSystem', 'navos',
    'positions', '{}'::jsonb,
    'avgCost', '{}'::jsonb,
    'mainShip', jsonb_build_object('type', 'pinnace'),
    'ships', jsonb_build_array(
      jsonb_build_object(
        'uid', 's1', 'type', 'mule', 'cls', 'transport', 'name', 'Old Faithful',
        'status', 'idle', 'accessories', '[]'::jsonb, 'mercenary', false,
        'expiresAt', null, 'retrieveCost', 0
      )
    ),
    'missions', '[]'::jsonb,
    'reports', '[]'::jsonb,
    'listings', '[]'::jsonb,
    'orders', '[]'::jsonb,
    'routes', '[]'::jsonb,
    'expeditions', '[]'::jsonb,
    'surveyed', '{}'::jsonb,
    'industries', '[]'::jsonb,
    'extractors', '{}'::jsonb,
    'components', '{}'::jsonb,
    'items', '{}'::jsonb,
    'inventory', jsonb_build_object('capacity', 6, 'upgrades', 0),
    'bazaar', jsonb_build_object(
      'mercs', '[]'::jsonb, 'contracts', '[]'::jsonb, 'accessories', '[]'::jsonb,
      'extractors', '[]'::jsonb, 'components', '[]'::jsonb
    ),
    'travel', null,
    'seq', 1,
    'unlockedSystems', jsonb_build_array('navos', 'korrin', 'velm'),
    'reputation', jsonb_build_object(
      'syndicate', 0, 'mining_combine', 0, 'free_trade', 0, 'agri_collective', 0
    ),
    'achievements', '[]'::jsonb,
    'prestige', jsonb_build_object('tier', 0, 'multiplier', 1.0),
    'stats', jsonb_build_object(
      'trades', 0, 'contractsDone', 0, 'peakNetWorth', 1500, 'biggestTrade', 0
    ),
    'newswire', '[]'::jsonb,
    'settings', jsonb_build_object('muted', true, 'reduced', false, 'tutorialSeen', false, 'lang', 'en'),
    'lastSeenAt', 0,
    'market', null,
    'galaxy', null,
    'senate', null,
    'rivals', null,
    'rivalsMeta', null,
    'appliedResetEpoch', 0
  );
$$;

create or replace function app._system_distance(p_system text)
returns double precision
language sql immutable as $$
  -- Curated capitals have fixed distances; anything else (future trade hubs /
  -- generated ids that somehow get unlocked) gets a mid-range hop so dock works.
  select coalesce((
    select d from (values
      ('navos', 0::float8), ('korrin', 3), ('velm', 5),
      ('thessa', 7), ('orin', 10), ('sable', 14)
    ) as x(id, d) where x.id = p_system
  ), 8);
$$;

create or replace function app._system_unlock(p_system text)
returns double precision
language sql immutable as $$
  select coalesce((
    select u from (values
      ('navos', 0::float8), ('korrin', 0), ('velm', 0),
      ('thessa', 6000), ('orin', 18000), ('sable', 45000)
    ) as x(id, u) where x.id = p_system
  ), null);
$$;

create or replace function app._cat_faction(p_cat text)
returns text
language sql immutable as $$
  select case p_cat
    when 'mineral' then 'mining_combine'
    when 'gas' then 'mining_combine'
    when 'agri' then 'agri_collective'
    when 'luxury' then 'agri_collective'
    when 'tech' then 'free_trade'
    when 'illicit' then 'syndicate'
    else 'free_trade'
  end;
$$;

create or replace function app._travel_speed(p_state jsonb)
returns double precision
language sql immutable as $$
  select case coalesce(p_state->'mainShip'->>'type', 'pinnace')
    when 'yacht' then 1.6
    when 'flagship' then 2.2
    when 'dreadnought' then 3.0
    else 1.0
  end;
$$;

create or replace function app._tier_cap(p_tier int)
returns double precision
language sql immutable as $$
  select case greatest(0, least(coalesce(p_tier, 0), 6))
    when 0 then 15000
    when 1 then 30000
    when 2 then 60000
    when 3 then 120000
    when 4 then 220000
    when 5 then 350000
    else 500000
  end;
$$;

create or replace function app._tier_tax(p_tier int)
returns double precision
language sql immutable as $$
  select case greatest(0, least(coalesce(p_tier, 0), 6))
    when 0 then 0.0
    when 1 then 0.10
    when 2 then 0.20
    when 3 then 0.30
    when 4 then 0.40
    when 5 then 0.50
    else 0.60
  end;
$$;

-- Spread matching js/economy.js: max(minSpread, spread - edge).
create or replace function app._spread(p_state jsonb, p_cat text)
returns double precision
language plpgsql immutable as $$
declare
  fac text := app._cat_faction(p_cat);
  standing double precision := coalesce((p_state->'reputation'->>fac)::float8, 0);
  edge double precision := (standing / 100.0) * 0.06;   -- REP.maxEdge
  spread constant double precision := 0.04;
  min_spread constant double precision := 0.005;
begin
  return greatest(min_spread, spread - edge);
end;
$$;

create or replace function app._in_transit(p_state jsonb)
returns boolean
language sql immutable as $$
  select jsonb_typeof(p_state->'travel') = 'object';
$$;

-- Apply due travel arrivals using server time.
create or replace function app._arrive_if_due(p_state jsonb, p_now_ms bigint)
returns jsonb
language plpgsql immutable as $$
declare
  tr jsonb := p_state->'travel';
  departed bigint;
  eta bigint;
  dest text;
begin
  if not app._in_transit(p_state) then
    return p_state;
  end if;
  departed := coalesce((tr->>'departedAt')::bigint, 0);
  eta := coalesce((tr->>'etaMs')::bigint, 0);
  if p_now_ms < departed + eta then
    return p_state;
  end if;
  dest := tr->>'to';
  if dest is null then
    return jsonb_set(p_state, '{travel}', 'null'::jsonb);
  end if;
  p_state := jsonb_set(p_state, '{currentSystem}', to_jsonb(dest));
  p_state := jsonb_set(p_state, '{travel}', 'null'::jsonb);
  return p_state;
end;
$$;

create or replace function app._lock_state(p_now_ms bigint)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  uid uuid := auth.uid();
  st jsonb;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  select state into st from public.players where user_id = uid for update;
  if st is null then
    raise exception 'no player row — call app_bootstrap first';
  end if;
  return app._arrive_if_due(st, p_now_ms);
end;
$$;

create or replace function app._write_state(p_state jsonb, p_now_ms bigint)
returns void
language plpgsql security definer set search_path = public as $$
begin
  p_state := jsonb_set(p_state, '{lastSeenAt}', to_jsonb(p_now_ms));
  update public.players
     set state = p_state, updated_at = now()
   where user_id = auth.uid();
end;
$$;

-- ---------------------------------------------------------------------------
-- app_bootstrap() → full state
-- Creates a row from saves.data (legacy) or the default state.
-- ---------------------------------------------------------------------------
create or replace function public.app_bootstrap()
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  uid uuid := auth.uid();
  st jsonb;
  legacy jsonb;
  now_ms bigint := app._now_ms();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select state into st from public.players where user_id = uid for update;
  if st is null then
    -- one-time migrate from the local-first `saves` table if present
    begin
      select data into legacy from public.saves where user_id = uid;
    exception when undefined_table then
      legacy := null;
    end;
    if legacy is null or legacy = '{}'::jsonb then
      st := app._default_state();
    else
      st := legacy;
    end if;
    -- ensure required economy keys exist
    st := coalesce(st, app._default_state());
    if st->'credits' is null then st := jsonb_set(st, '{credits}', '1500'); end if;
    if st->'positions' is null then st := jsonb_set(st, '{positions}', '{}'::jsonb); end if;
    if st->'avgCost' is null then st := jsonb_set(st, '{avgCost}', '{}'::jsonb); end if;
    if st->'currentSystem' is null then st := jsonb_set(st, '{currentSystem}', '"navos"'); end if;
    if st->'unlockedSystems' is null then
      st := jsonb_set(st, '{unlockedSystems}', '["navos","korrin","velm"]'::jsonb);
    end if;
    if st->'reputation' is null then
      st := jsonb_set(st, '{reputation}', app._default_state()->'reputation');
    end if;
    if st->'prestige' is null then
      st := jsonb_set(st, '{prestige}', '{"tier":0,"multiplier":1.0}'::jsonb);
    end if;
    if st->'stats' is null then
      st := jsonb_set(st, '{stats}', app._default_state()->'stats');
    end if;
    st := jsonb_set(st, '{lastSeenAt}', to_jsonb(now_ms));
    insert into public.players(user_id, state, updated_at) values (uid, st, now());
  end if;

  st := app._arrive_if_due(st, now_ms);
  update public.players set state = st, updated_at = now() where user_id = uid;
  return st;
end;
$$;

-- ---------------------------------------------------------------------------
-- app_trade(action, commodity, qty) → result json
-- Fill price = market.price_system × (1 ± spread). No client impact / senate.
-- ---------------------------------------------------------------------------
create or replace function public.app_trade(p_action text, p_commodity text, p_qty int)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  action text := lower(coalesce(p_action, ''));
  qty int := floor(coalesce(p_qty, 0));
  comm record;
  sys text;
  mid double precision;
  spread double precision;
  unit double precision;
  cost double precision;
  proceeds double precision;
  held double precision;
  prev_cost double precision;
  avg double precision;
  credits double precision;
  tier int;
  cap double precision;
  tax_rate double precision;
  tax double precision;
  gross_realized double precision;
  positions jsonb;
  avg_cost jsonb;
  stats jsonb;
  value double precision;
begin
  if action not in ('buy', 'sell') then
    return jsonb_build_object('ok', false, 'error', 'invalid action');
  end if;
  if qty <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Quantity must be positive.');
  end if;

  select * into comm from market.commodity(p_commodity);
  if comm.id is null then
    return jsonb_build_object('ok', false, 'error', 'Unknown commodity.');
  end if;

  st := app._lock_state(now_ms);
  if app._in_transit(st) then
    return jsonb_build_object('ok', false, 'error', 'Can''t trade in transit.');
  end if;

  sys := st->>'currentSystem';
  mid := market.price_system(p_commodity, sys, now_ms::float8);
  if mid is null or mid <= 0 then
    return jsonb_build_object('ok', false, 'error', 'No price.');
  end if;

  spread := app._spread(st, comm.cat);
  tier := coalesce((st->'prestige'->>'tier')::int, 0);
  cap := app._tier_cap(tier);
  credits := coalesce((st->>'credits')::float8, 0);
  positions := coalesce(st->'positions', '{}'::jsonb);
  avg_cost := coalesce(st->'avgCost', '{}'::jsonb);
  held := coalesce((positions->>p_commodity)::float8, 0);
  prev_cost := coalesce((avg_cost->>p_commodity)::float8, 0);

  if action = 'buy' then
    unit := mid * (1.0 + spread);
    -- clamp qty to tier notional cap and credits
    if unit * qty > cap then qty := floor(cap / unit); end if;
    if qty <= 0 then
      return jsonb_build_object('ok', false, 'error', 'Beyond this station''s depth for your tier.');
    end if;
    cost := unit * qty;
    if cost > credits then
      return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
    end if;
    credits := credits - cost;
    avg := case when held + qty > 0
      then (held * prev_cost + cost) / (held + qty) else unit end;
    positions := jsonb_set(positions, array[p_commodity], to_jsonb(held + qty));
    avg_cost := jsonb_set(avg_cost, array[p_commodity], to_jsonb(avg));
    value := cost;
  else
    if held <= 0 then
      return jsonb_build_object('ok', false, 'error', 'Nothing to sell.');
    end if;
    qty := least(qty, floor(held)::int);
    unit := mid * (1.0 - spread);
    if unit * qty > cap then qty := floor(cap / unit); end if;
    if qty <= 0 then
      return jsonb_build_object('ok', false, 'error', 'Beyond this station''s depth for your tier.');
    end if;
    tax_rate := app._tier_tax(tier);
    gross_realized := (unit - prev_cost) * qty;
    tax := case when gross_realized > 0 then round(gross_realized * tax_rate) else 0 end;
    proceeds := unit * qty - tax;
    credits := credits + proceeds;
    held := held - qty;
    if held <= 0 then
      positions := positions - p_commodity;
      avg_cost := avg_cost - p_commodity;
    else
      positions := jsonb_set(positions, array[p_commodity], to_jsonb(held));
    end if;
    value := proceeds;
  end if;

  stats := coalesce(st->'stats', '{}'::jsonb);
  stats := jsonb_set(stats, '{trades}', to_jsonb(coalesce((stats->>'trades')::int, 0) + 1));
  if value > coalesce((stats->>'biggestTrade')::float8, 0) then
    stats := jsonb_set(stats, '{biggestTrade}', to_jsonb(value));
  end if;

  st := jsonb_set(st, '{credits}', to_jsonb(credits));
  st := jsonb_set(st, '{positions}', positions);
  st := jsonb_set(st, '{avgCost}', avg_cost);
  st := jsonb_set(st, '{stats}', stats);
  perform app._write_state(st, now_ms);

  return jsonb_build_object(
    'ok', true,
    'action', action,
    'commodity', p_commodity,
    'qty', qty,
    'fillPrice', unit,
    'cost', case when action = 'buy' then cost else null end,
    'proceeds', case when action = 'sell' then proceeds else null end,
    'tax', case when action = 'sell' then tax else null end,
    'credits', credits,
    'positions', positions,
    'avgCost', avg_cost,
    'stats', stats,
    'currentSystem', sys,
    'travel', st->'travel'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- app_dock(system) → start transit (server stamps departedAt / etaMs)
-- ---------------------------------------------------------------------------
create or replace function public.app_dock(p_system text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  dest text := p_system;
  cur text;
  unlocked jsonb;
  dist double precision;
  speed double precision;
  eta_ms bigint;
  dock_k constant double precision := 18;  -- MARKETCFG.dockK
begin
  -- Any unlocked system id is dockable (not only the six curated capitals).
  if dest is null or length(dest) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Unknown system.');
  end if;

  st := app._lock_state(now_ms);
  cur := st->>'currentSystem';
  unlocked := coalesce(st->'unlockedSystems', '[]'::jsonb);

  if not (unlocked ? dest) then
    return jsonb_build_object('ok', false, 'error', 'System locked.');
  end if;
  if app._in_transit(st) then
    return jsonb_build_object('ok', false, 'error', 'Already in transit.');
  end if;
  if dest = cur then
    return jsonb_build_object('ok', false, 'error', 'Already docked here.');
  end if;

  dist := greatest(1.0, abs(app._system_distance(cur) - app._system_distance(dest)));
  speed := greatest(0.25, app._travel_speed(st));
  eta_ms := (dist * dock_k * 1000.0 / speed)::bigint;

  st := jsonb_set(st, '{travel}', jsonb_build_object(
    'from', cur, 'to', dest, 'departedAt', now_ms, 'etaMs', eta_ms
  ));
  perform app._write_state(st, now_ms);

  return jsonb_build_object(
    'ok', true, 'travel', true, 'etaMs', eta_ms,
    'travelObj', st->'travel',
    'currentSystem', cur, 'credits', (st->>'credits')::float8
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- app_unlock(system) → pay unlock cost
-- ---------------------------------------------------------------------------
create or replace function public.app_unlock(p_system text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  dest text := p_system;
  cost double precision;
  credits double precision;
  unlocked jsonb;
begin
  cost := app._system_unlock(dest);
  if cost is null then
    return jsonb_build_object('ok', false, 'error', 'Unknown system.');
  end if;

  st := app._lock_state(now_ms);
  unlocked := coalesce(st->'unlockedSystems', '[]'::jsonb);
  if unlocked ? dest then
    return jsonb_build_object('ok', false, 'error', 'Already unlocked.');
  end if;
  credits := coalesce((st->>'credits')::float8, 0);
  if cost > credits then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
  end if;

  credits := credits - cost;
  unlocked := unlocked || jsonb_build_array(dest);
  st := jsonb_set(st, '{credits}', to_jsonb(credits));
  st := jsonb_set(st, '{unlockedSystems}', unlocked);
  perform app._write_state(st, now_ms);

  return jsonb_build_object(
    'ok', true, 'credits', credits, 'unlockedSystems', unlocked
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- app_commit(client_state) → persist client blob with travel topology protected
--
-- Phase 1 interim: credits / positions / avgCost are taken from the CLIENT so
-- mission / bazaar / industry / route income still persists (those systems are
-- still client-side until Phase 2). Travel / currentSystem / unlockedSystems
-- stay server-authored so you can't teleport or forge unlocks via autosave.
-- Trade *fills* remain validated by app_trade against market_price().
-- ---------------------------------------------------------------------------
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

  -- Protect docking topology (anti-teleport / anti-forge-unlock).
  merged := jsonb_set(merged, '{currentSystem}', server->'currentSystem');
  merged := jsonb_set(merged, '{travel}',
    case when app._in_transit(server) then server->'travel' else 'null'::jsonb end);
  merged := jsonb_set(merged, '{unlockedSystems}', coalesce(server->'unlockedSystems', '[]'::jsonb));

  -- credits / positions / avgCost / stats / … come from the client (interim).

  perform app._write_state(merged, now_ms);
  return jsonb_build_object('ok', true, 'state', merged);
end;
$$;

grant execute on function public.app_bootstrap() to authenticated;
grant execute on function public.app_trade(text, text, int) to authenticated;
grant execute on function public.app_dock(text) to authenticated;
grant execute on function public.app_unlock(text) to authenticated;
grant execute on function public.app_commit(jsonb) to authenticated;
