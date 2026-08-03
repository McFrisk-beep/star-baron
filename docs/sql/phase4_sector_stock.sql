-- Phase 4 — sector stock authority (docs/STATIONS.md §2 + §14)
-- Requires: market_price.sql, phase1_players.sql (+ later phases already applied).
-- Safe to re-run (create or replace / if not exists).
--
-- Price = market.price_system(c, sys, t) × scarcity(units / baseline)
-- Keep js/stock.js STOCKCFG knobs in lockstep with the constants below.
--
-- Station auction / module / hall RPCs remain stubbed (return not-implemented).
-- Hourly consumption cron: call public.app_stock_tick() from pg_cron when ready.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
create table if not exists public.sector_stock (
  sector_id  text not null,
  comm_id    text not null,
  units      integer not null check (units >= 0),
  updated_at timestamptz not null default now(),
  primary key (sector_id, comm_id)
);

create table if not exists public.sector_stock_meta (
  id text primary key default 'global',
  last_tick_at timestamptz not null default now()
);
insert into public.sector_stock_meta(id) values ('global') on conflict do nothing;

-- Minimal stations row (ownership RPCs later). Guest client still owns the loop
-- until app_station_* land; table exists so dock / directory can share ids.
create table if not exists public.stations (
  system_id text primary key,
  owner_id uuid null,
  tier text not null default 'Berth',
  reactor_level int not null default 0,
  modules jsonb not null default '{}'::jsonb,
  treasury numeric not null default 0,
  standing numeric not null default 60,
  lease_tax_bps int not null default 1000,
  sale_tariff_bps int not null default 500,
  scrutiny int not null default 10,
  status text not null default 'npc'
    check (status in ('npc','owned','refit','cooldown')),
  hold jsonb not null default '{}'::jsonb,
  prod_comm text null,
  cooldown_until timestamptz null,
  refit_until timestamptz null
);

alter table public.sector_stock enable row level security;
alter table public.stations enable row level security;

drop policy if exists sector_stock_public_read on public.sector_stock;
create policy sector_stock_public_read on public.sector_stock
  for select to anon, authenticated using (true);

drop policy if exists stations_public_read on public.stations;
create policy stations_public_read on public.stations
  for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------
-- Catalog helpers (mirror js/stock.js + SECTORS)
-- ---------------------------------------------------------------------------
create or replace function market.sector_of_system(p_system text)
returns text
language sql immutable as $$
  select case p_system
    when 'navos'  then 'core'
    when 'korrin' then 'belt'
    when 'velm'   then 'tide'
    when 'thessa' then 'green'
    when 'orin'   then 'forge'
    when 'sable'  then 'sprawl'
    else null
  end;
$$;

create or replace function market.sector_specialty(p_sector text)
returns text
language sql immutable as $$
  select case p_sector
    when 'belt'   then 'mineral'
    when 'tide'   then 'gas'
    when 'green'  then 'agri'
    when 'forge'  then 'tech'
    when 'sprawl' then 'luxury'
    else null
  end;
$$;

-- Rarity + craft flag for tradeable shelf (excludes exotic craftOnly).
create or replace function market.commodity_rarity(p_id text)
returns table(id text, cat text, rarity text, craft_only boolean)
language sql immutable as $$
  select * from (values
    ('iron_ore',         'mineral', 'common',   false),
    ('silicon',          'mineral', 'common',   false),
    ('rare_earths',      'mineral', 'uncommon', false),
    ('titanium_ore',     'mineral', 'uncommon', false),
    ('cobalt_ore',       'mineral', 'common',   false),
    ('graphene_lattice', 'mineral', 'uncommon', false),
    ('pulsar_shard',     'mineral', 'rare',     false),
    ('hydrogen',         'gas',     'common',   false),
    ('helium3',          'gas',     'common',   false),
    ('water_ice',        'gas',     'common',   false),
    ('plasma_gas',       'gas',     'uncommon', false),
    ('methane_slurry',   'gas',     'common',   false),
    ('xenon_gas',        'gas',     'uncommon', false),
    ('cryo_vapor',       'gas',     'rare',     false),
    ('foodstuffs',       'agri',    'common',   false),
    ('synthsilk',        'agri',    'common',   false),
    ('grain',            'agri',    'common',   false),
    ('protein_stock',    'agri',    'common',   false),
    ('hydro_greens',     'agri',    'common',   false),
    ('algae_paste',      'agri',    'common',   false),
    ('biofiber',         'agri',    'uncommon', false),
    ('nectar_extract',   'agri',    'uncommon', false),
    ('medicinal_herbs',  'agri',    'uncommon', false),
    ('spore_culture',    'agri',    'rare',     false),
    ('nanochips',        'tech',    'common',   false),
    ('antimatter',       'tech',    'rare',     false),
    ('fusion_cell',      'tech',    'common',   false),
    ('sensor_array',     'tech',    'uncommon', false),
    ('neural_processor', 'tech',    'rare',     false),
    ('quantum_core',     'tech',    'rare',     false),
    ('spice',            'luxury',  'common',   false),
    ('gemstones',        'luxury',  'common',   false),
    ('vintage_wine',     'luxury',  'common',   false),
    ('perfume_essence',  'luxury',  'common',   false),
    ('fine_art',         'luxury',  'uncommon', false),
    ('exotic_pelts',     'luxury',  'rare',     false),
    ('contraband',         'illicit', 'common',   false),
    ('narcotics',          'illicit', 'common',   false),
    ('forged_credentials', 'illicit', 'uncommon', false),
    ('weapons_cache',      'illicit', 'uncommon', false),
    ('bio_toxin',          'illicit', 'rare',     false)
  ) as t(id, cat, rarity, craft_only)
  where t.id = p_id;
$$;

-- STOCKCFG.baseline / specialtyMult / offSpecialtyMult
create or replace function market.stock_baseline(p_sector text, p_comm text)
returns integer
language plpgsql immutable as $$
declare
  meta record;
  base integer;
  spec text;
  want text;
begin
  select * into meta from market.commodity_rarity(p_comm);
  if meta.id is null or meta.craft_only then return 0; end if;
  base := case meta.rarity
    when 'common' then 6000
    when 'uncommon' then 2500
    when 'rare' then 800
    else 0
  end;
  if base <= 0 then return 0; end if;
  spec := market.sector_specialty(p_sector);
  if spec is null then return base; end if;
  want := case when meta.cat = 'illicit' then 'luxury' else meta.cat end;
  if spec = want then
    return round(base * 1.6)::int;
  end if;
  return round(base * 0.7)::int;
end;
$$;

-- scarcity = clamp((1/ratio)^elasticity, minMult, maxMult); ratio floor 0.02
create or replace function market.scarcity_mult(p_units integer, p_baseline integer)
returns double precision
language plpgsql immutable as $$
declare
  r double precision;
  raw double precision;
  elasticity constant double precision := 0.35;
  min_m constant double precision := 0.70;
  max_m constant double precision := 3.00;
begin
  if p_baseline is null or p_baseline <= 0 then return 1.0; end if;
  r := greatest(coalesce(p_units, 0)::float8 / p_baseline::float8, 0.02);
  raw := power(1.0 / r, elasticity);
  return greatest(min_m, least(max_m, raw));
end;
$$;

create or replace function market.ensure_stock_row(p_sector text, p_comm text)
returns integer
language plpgsql security definer set search_path = public, market as $$
declare
  base integer;
  u integer;
begin
  base := market.stock_baseline(p_sector, p_comm);
  if base <= 0 then return 0; end if;
  insert into public.sector_stock(sector_id, comm_id, units)
  values (p_sector, p_comm, base)
  on conflict (sector_id, comm_id) do nothing;
  select units into u from public.sector_stock
    where sector_id = p_sector and comm_id = p_comm;
  return coalesce(u, 0);
end;
$$;

-- Seed all sector × tradeable commodities at baseline (idempotent).
create or replace function market.seed_sector_stock()
returns void
language plpgsql security definer set search_path = public, market as $$
declare
  sec text;
  rec record;
begin
  for sec in select unnest(array['core','belt','tide','green','forge','sprawl']) loop
    for rec in
      select t.id from (values
        ('iron_ore'),('silicon'),('rare_earths'),('titanium_ore'),('cobalt_ore'),
        ('graphene_lattice'),('pulsar_shard'),
        ('hydrogen'),('helium3'),('water_ice'),('plasma_gas'),('methane_slurry'),
        ('xenon_gas'),('cryo_vapor'),
        ('foodstuffs'),('synthsilk'),('grain'),('protein_stock'),('hydro_greens'),
        ('algae_paste'),('biofiber'),('nectar_extract'),('medicinal_herbs'),('spore_culture'),
        ('nanochips'),('antimatter'),('fusion_cell'),('sensor_array'),('neural_processor'),('quantum_core'),
        ('spice'),('gemstones'),('vintage_wine'),('perfume_essence'),('fine_art'),('exotic_pelts'),
        ('contraband'),('narcotics'),('forged_credentials'),('weapons_cache'),('bio_toxin')
      ) as t(id)
    loop
      perform market.ensure_stock_row(sec, rec.id);
    end loop;
  end loop;
end;
$$;

select market.seed_sector_stock();

-- ---------------------------------------------------------------------------
-- Client sync: full shelf snapshot
-- ---------------------------------------------------------------------------
create or replace function public.app_sector_stock()
returns jsonb
language plpgsql security definer set search_path = public, market as $$
declare
  out jsonb := '{}'::jsonb;
  r record;
  bag jsonb;
begin
  perform market.seed_sector_stock();
  for r in select sector_id, jsonb_object_agg(comm_id, units) as bag
             from public.sector_stock group by sector_id
  loop
    out := jsonb_set(out, array[r.sector_id], coalesce(r.bag, '{}'::jsonb));
  end loop;
  return jsonb_build_object('ok', true, 'units', out,
    'lastTickAt', (select extract(epoch from last_tick_at) * 1000 from public.sector_stock_meta where id = 'global'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Replace app_trade — stock lock + scarcity fill (extends phase1, does not fork)
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
  sector text;
  mid double precision;
  scar double precision;
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
  fac text;
  rep jsonb;
  base_u integer;
  have_u integer;
  glut_cap integer;
  shelf integer;
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
  sector := market.sector_of_system(sys);
  if sector is null then
    return jsonb_build_object('ok', false, 'error', 'Dock at a sector capital to trade commodities.');
  end if;

  -- Lock the shelf row for this sector/commodity.
  perform market.ensure_stock_row(sector, p_commodity);
  select units into have_u from public.sector_stock
    where sector_id = sector and comm_id = p_commodity for update;
  have_u := coalesce(have_u, 0);
  base_u := market.stock_baseline(sector, p_commodity);
  if base_u <= 0 then
    return jsonb_build_object('ok', false, 'error', 'This station doesn''t stock that commodity.');
  end if;

  mid := market.price_system(p_commodity, sys, now_ms::float8);
  if mid is null or mid <= 0 then
    return jsonb_build_object('ok', false, 'error', 'No price.');
  end if;
  scar := market.scarcity_mult(have_u, base_u);
  mid := mid * scar;

  spread := app._spread(st, comm.cat);
  tier := coalesce((st->'prestige'->>'tier')::int, 0);
  cap := app._tier_cap(tier);
  credits := coalesce((st->>'credits')::float8, 0);
  positions := coalesce(st->'positions', '{}'::jsonb);
  avg_cost := coalesce(st->'avgCost', '{}'::jsonb);
  held := coalesce((positions->>p_commodity)::float8, 0);
  prev_cost := coalesce((avg_cost->>p_commodity)::float8, 0);

  if action = 'buy' then
    if have_u <= 0 then
      return jsonb_build_object('ok', false, 'error', 'Sector stock is empty — nothing to buy.');
    end if;
    qty := least(qty, have_u);
    unit := mid * (1.0 + spread);
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
    have_u := have_u - qty;
    update public.sector_stock set units = have_u, updated_at = now()
      where sector_id = sector and comm_id = p_commodity;
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
    -- Soft glut cap (STOCKCFG.glutCapMult = 3)
    glut_cap := greatest(base_u * 3, 1);
    if have_u >= glut_cap then
      return jsonb_build_object('ok', false, 'error', 'Sector shelves are full — try another capital.');
    end if;
    qty := least(qty, glut_cap - have_u);
    if qty <= 0 then
      return jsonb_build_object('ok', false, 'error', 'Sector shelves are full — try another capital.');
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
    have_u := have_u + qty;
    update public.sector_stock set units = have_u, updated_at = now()
      where sector_id = sector and comm_id = p_commodity;
  end if;

  stats := coalesce(st->'stats', '{}'::jsonb);
  stats := jsonb_set(stats, '{trades}', to_jsonb(coalesce((stats->>'trades')::int, 0) + 1));
  if value > coalesce((stats->>'biggestTrade')::float8, 0) then
    stats := jsonb_set(stats, '{biggestTrade}', to_jsonb(value));
  end if;

  if value >= 4000 then
    fac := app._cat_faction(comm.cat);
    rep := coalesce(st->'reputation', '{}'::jsonb);
    rep := jsonb_set(rep, array[fac], to_jsonb(greatest(-100.0, least(100.0,
      coalesce((rep->>fac)::float8, 0) + (case when action = 'sell' then 0.5 else 0.3 end)))));
    st := jsonb_set(st, '{reputation}', rep);
  end if;

  st := jsonb_set(st, '{credits}', to_jsonb(credits));
  st := jsonb_set(st, '{positions}', positions);
  st := jsonb_set(st, '{avgCost}', avg_cost);
  st := jsonb_set(st, '{stats}', stats);
  perform app._write_state(st, now_ms);

  shelf := have_u;

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
    'reputation', coalesce(st->'reputation', '{}'::jsonb),
    'currentSystem', sys,
    'travel', st->'travel',
    'sectorId', sector,
    'stockUnits', shelf,
    'scarcity', scar
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Lightweight hourly tick (consumption + NPC elastic backstop + trickle)
-- Call from pg_cron: select public.app_stock_tick();
-- Mirrors js/stock.js at a coarse level — not a full parity port.
-- ---------------------------------------------------------------------------
create or replace function public.app_stock_tick()
returns jsonb
language plpgsql security definer set search_path = public, market as $$
declare
  meta_ts timestamptz;
  hours int;
  i int;
  sec text;
  rec record;
  base integer;
  have integer;
  demand integer;
  put_n integer;
  rarity text;
  npc_base integer;
  ratio double precision;
  mult double precision;
begin
  perform market.seed_sector_stock();
  select last_tick_at into meta_ts from public.sector_stock_meta where id = 'global' for update;
  hours := greatest(0, least(168, floor(extract(epoch from (now() - meta_ts)) / 3600.0)::int));
  if hours <= 0 then
    return jsonb_build_object('ok', true, 'hours', 0);
  end if;

  for i in 1..hours loop
    for sec in select unnest(array['core','belt','tide','green','forge','sprawl']) loop
      for rec in select sector_id, comm_id, units from public.sector_stock where sector_id = sec for update loop
        base := market.stock_baseline(sec, rec.comm_id);
        if base <= 0 then continue; end if;
        select rarity into rarity from market.commodity_rarity(rec.comm_id);
        demand := case rarity when 'common' then 8 when 'uncommon' then 3 when 'rare' then 1 else 0 end;
        -- sector pop pressure (CONSUMPTION.sectorPop)
        demand := greatest(0, round(demand * case sec
          when 'core' then 1.35 when 'belt' then 1.0 when 'tide' then 0.95
          when 'green' then 1.1 when 'forge' then 1.05 when 'sprawl' then 1.2 else 1.0 end)::int);
        have := greatest(0, rec.units - demand);
        -- NPC elastic backstop
        npc_base := case rarity when 'common' then 12 when 'uncommon' then 5 when 'rare' then 2 else 0 end;
        ratio := have::float8 / base::float8;
        mult := greatest(1.0, least(3.5, 1.0 + (1.0 - ratio) * 2.5));
        put_n := greatest(1, round(npc_base * mult)::int);
        have := least(base * 3, have + put_n);
        update public.sector_stock set units = have, updated_at = now()
          where sector_id = sec and comm_id = rec.comm_id;
      end loop;
    end loop;
  end loop;

  update public.sector_stock_meta set last_tick_at = meta_ts + make_interval(hours => hours)
    where id = 'global';

  return jsonb_build_object('ok', true, 'hours', hours);
end;
$$;

-- ---------------------------------------------------------------------------
-- Station RPC stubs (wire bodies in a later paste; keep names reserved)
-- ---------------------------------------------------------------------------
create or replace function public.app_station_bid(p_system text, p_amount numeric)
returns jsonb language sql security definer as $$
  select jsonb_build_object('ok', false, 'error', 'Station auctions not live on server yet.');
$$;
create or replace function public.app_station_auction_open(p_system text, p_amount numeric)
returns jsonb language sql security definer as $$
  select jsonb_build_object('ok', false, 'error', 'Station auctions not live on server yet.');
$$;
create or replace function public.app_station_module_install(p_system text, p_module text)
returns jsonb language sql security definer as $$
  select jsonb_build_object('ok', false, 'error', 'Station modules not live on server yet.');
$$;
create or replace function public.app_station_set_policy(p_system text, p_policy jsonb)
returns jsonb language sql security definer as $$
  select jsonb_build_object('ok', false, 'error', 'Station policy not live on server yet.');
$$;
create or replace function public.app_station_withdraw(p_system text, p_amount numeric)
returns jsonb language sql security definer as $$
  select jsonb_build_object('ok', false, 'error', 'Station treasury not live on server yet.');
$$;
create or replace function public.app_station_lease_bay(p_system text, p_bay int, p_extractor text)
returns jsonb language sql security definer as $$
  select jsonb_build_object('ok', false, 'error', 'Station bays not live on server yet.');
$$;
create or replace function public.app_station_list_item(p_system text, p_listing jsonb)
returns jsonb language sql security definer as $$
  select jsonb_build_object('ok', false, 'error', 'Exchange Hall not live on server yet.');
$$;
create or replace function public.app_station_buy_item(p_system text, p_listing_id text)
returns jsonb language sql security definer as $$
  select jsonb_build_object('ok', false, 'error', 'Exchange Hall not live on server yet.');
$$;

grant execute on function public.app_trade(text, text, int) to authenticated;
grant execute on function public.app_sector_stock() to authenticated;
grant execute on function public.app_sector_stock() to anon;
grant execute on function public.app_stock_tick() to authenticated;
grant execute on function public.app_station_bid(text, numeric) to authenticated;
grant execute on function public.app_station_auction_open(text, numeric) to authenticated;
grant execute on function public.app_station_module_install(text, text) to authenticated;
grant execute on function public.app_station_set_policy(text, jsonb) to authenticated;
grant execute on function public.app_station_withdraw(text, numeric) to authenticated;
grant execute on function public.app_station_lease_bay(text, int, text) to authenticated;
grant execute on function public.app_station_list_item(text, jsonb) to authenticated;
grant execute on function public.app_station_buy_item(text, text) to authenticated;
