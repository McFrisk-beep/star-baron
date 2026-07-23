-- Phase 0 — deterministic market_price() (Supabase / Postgres)
-- Mirror of js/market.js formulaGlobal / formulaSystem.
-- Paste into the Supabase SQL Editor when you're ready; Phase 0 clients do not
-- call this yet. The Node parity test (tools/check_market_parity.js) embeds a
-- JS reference of this SQL — keep the two in lockstep when tuning.
--
-- Constants MUST match MARKETCFG / CONFIG in js/data.js.

create schema if not exists market;

-- FNV-1a 32-bit over UTF-16 code units (matches JS string charCodeAt loop).
create or replace function market.fnv1a(p_text text)
returns bigint
language plpgsql immutable strict as $$
declare
  h bigint := 2166136261;
  i int;
  c int;
begin
  for i in 1..char_length(p_text) loop
    c := ascii(substr(p_text, i, 1));
    -- JS charCodeAt for BMP; our seeds/ids are ASCII so ascii() matches.
    h := (h # c) & 4294967295;
    h := (h * 16777619) & 4294967295;
  end loop;
  return h;
end;
$$;

-- Low 32 bits of a 32×32-bit product, matching JS Math.imul(a,b) >>> 0.
-- Done in `numeric` because a plain bigint multiply of two ~2^32 operands can
-- reach ~2^64 and overflow bigint (max ~9.2e18); JS wraps mod 2^32, so must we.
create or replace function market.imul32(p_a bigint, p_b bigint)
returns bigint
language sql immutable strict as $$
  select (((p_a & 4294967295)::numeric * (p_b & 4294967295)::numeric) % 4294967296)::bigint;
$$;

-- mulberry32 draw n (0-based) → double in [0,1).
create or replace function market.u01(p_seed bigint, p_n int default 0)
returns double precision
language plpgsql immutable strict as $$
declare
  a bigint := p_seed & 4294967295;
  t bigint;
  r double precision := 0;
  i int;
begin
  for i in 0..p_n loop
    a := (a + 1831565813) & 4294967295;             -- 0x6D2B79F5
    t := a;
    t := market.imul32(t # (t >> 15), t | 1) & 4294967295;
    t := (t # ((t + market.imul32(t # (t >> 7), t | 61)) & 4294967295)) & 4294967295;
    r := ((t # (t >> 14)) & 4294967295)::double precision / 4294967296.0;
  end loop;
  return r;
end;
$$;

create or replace function market.seed_hash(variadic parts text[])
returns bigint
language sql immutable strict as $$
  select market.fnv1a(array_to_string(parts, '|'));
$$;

-- Commodity catalog (base/vol/cat). Keep in sync with COMMODITIES in data.js.
create or replace function market.commodity(p_id text)
returns table(id text, cat text, base double precision, vol double precision)
language sql immutable as $$
  select * from (values
    ('iron_ore',    'mineral', 40::float8,  0.04::float8),
    ('silicon',     'mineral', 65,          0.05),
    ('rare_earths', 'mineral', 220,         0.09),
    ('hydrogen',    'gas',     30,          0.05),
    ('helium3',     'gas',     180,         0.08),
    ('water_ice',   'gas',     25,          0.06),
    ('foodstuffs',  'agri',    55,          0.05),
    ('synthsilk',   'agri',    140,         0.07),
    ('nanochips',   'tech',    320,         0.10),
    ('antimatter',  'tech',    900,         0.14),
    ('spice',       'luxury',  260,         0.12),
    ('contraband',  'illicit', 480,         0.18)
  ) as c(id, cat, base, vol)
  where c.id = p_id;
$$;

-- Curated capital mods (SYSTEMS in data.js). Generated galaxy systems stay client-only for now.
create or replace function market.system_mod_raw(p_system text, p_cat text)
returns double precision
language sql immutable as $$
  select coalesce((
    select m from (values
      ('navos',  'mineral',1.0),('navos','gas',1.0),('navos','agri',1.0),('navos','tech',1.0),('navos','luxury',1.0),('navos','illicit',1.0),
      ('korrin', 'mineral',0.65),('korrin','gas',0.9),('korrin','agri',1.25),('korrin','tech',1.2),('korrin','luxury',1.15),('korrin','illicit',1.1),
      ('velm',   'mineral',1.2),('velm','gas',0.6),('velm','agri',0.85),('velm','tech',1.15),('velm','luxury',1.1),('velm','illicit',1.0),
      ('thessa', 'mineral',1.15),('thessa','gas',1.1),('thessa','agri',0.55),('thessa','tech',1.25),('thessa','luxury',1.2),('thessa','illicit',1.05),
      ('orin',   'mineral',1.1),('orin','gas',1.15),('orin','agri',1.2),('orin','tech',0.6),('orin','luxury',1.1),('orin','illicit',1.15),
      ('sable',  'mineral',1.25),('sable','gas',1.2),('sable','agri',1.3),('sable','tech',1.2),('sable','luxury',0.7),('sable','illicit',0.55)
    ) as x(sys, cat, m)
    where x.sys = p_system and x.cat = p_cat
  ), 1.0);
$$;

create or replace function market.mod_compressed(p_system text, p_cat text)
returns double precision
language sql immutable as $$
  -- MARKETCFG.modCompression = 0.35
  select 1.0 + (market.system_mod_raw(p_system, p_cat) - 1.0) * 0.35;
$$;

create or replace function market.category_drift(p_cat text, p_t double precision)
returns double precision
language plpgsql immutable strict as $$
declare
  cats text[] := array['mineral','gas','agri','tech','luxury','illicit'];
  idx int;
  phase double precision;
  drift_amp constant double precision := 0.04;
  drift_period constant double precision := 1800000; -- 30 min
begin
  idx := array_position(cats, p_cat) - 1;
  if idx is null then idx := 0; end if;
  phase := (idx::float8 / 6.0) * pi() * 2.0;
  return 1.0 + drift_amp * sin((p_t / drift_period) * pi() * 2.0 + phase);
end;
$$;

create or replace function market.osc(p_comm text, p_t double precision)
returns double precision
language plpgsql immutable strict as $$
declare
  seed_base text := 'cosmocrat-market-v1';
  amin double precision[] := array[120000, 480000, 1500000];
  amax double precision[] := array[360000, 1200000, 4200000];
  s bigint;
  raw double precision[] := array[0,0,0];
  periods double precision[] := array[0,0,0];
  thetas double precision[] := array[0,0,0];
  norm double precision;
  sum double precision := 0;
  i int;
  a double precision;
begin
  for i in 0..2 loop
    s := market.seed_hash(seed_base, p_comm, 'osc', i::text);
    raw[i+1] := 0.35 + market.u01(s, 0) * 0.65;
    periods[i+1] := amin[i+1] + market.u01(s, 1) * (amax[i+1] - amin[i+1]);
    thetas[i+1] := market.u01(s, 2) * pi() * 2.0;
  end loop;
  norm := sqrt(raw[1]*raw[1] + raw[2]*raw[2] + raw[3]*raw[3]);
  if norm = 0 then norm := 1; end if;
  for i in 1..3 loop
    a := raw[i] / norm;
    sum := sum + a * sin((pi() * 2.0 * p_t) / periods[i] + thetas[i]);
  end loop;
  return sum;
end;
$$;

create or replace function market.event_slot(p_kind text, p_slot bigint)
returns table(target text, mult double precision)
language plpgsql immutable strict as $$
declare
  seed_base text := 'cosmocrat-market-v1';
  s bigint := market.seed_hash(seed_base, p_kind, 'slot', p_slot::text);
  cats text[] := array['mineral','gas','agri','tech','luxury','illicit'];
  comms text[] := array['iron_ore','silicon','rare_earths','hydrogen','helium3','water_ice',
                        'foodstuffs','synthsilk','nanochips','antimatter','spice','contraband'];
  pick_cat boolean;
  up boolean;
  tgt text;
  m double precision;
begin
  pick_cat := market.u01(s, 0) < 0.7;
  if pick_cat then
    tgt := cats[1 + floor(market.u01(s, 1) * 6)::int % 6];
  else
    tgt := comms[1 + floor(market.u01(s, 1) * 12)::int % 12];
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
  comms text[] := array['iron_ore','silicon','rare_earths','hydrogen','helium3','water_ice',
                        'foodstuffs','synthsilk','nanochips','antimatter','spice','contraband'];
  pick_cat boolean;
  up boolean;
  tgt text;
  m double precision;
begin
  pick_cat := market.u01(s, 0) < 0.6;
  if pick_cat then
    tgt := cats[1 + floor(market.u01(s, 1) * 6)::int % 6];
  else
    tgt := comms[1 + floor(market.u01(s, 1) * 12)::int % 12];
  end if;
  up := market.u01(s, 2) < 0.5;
  if up then m := 1.2 + market.u01(s, 3) * 0.5;
  else m := 0.5 + market.u01(s, 3) * 0.35;
  end if;
  return query select tgt, m;
end;
$$;

create or replace function market.schedule_mult(
  p_comm_id text, p_cat text, p_t double precision,
  p_period double precision, p_duration double precision,
  p_kind text, p_system text default null
) returns double precision
language plpgsql immutable as $$
declare
  m double precision := 1.0;
  slot bigint := floor(p_t / p_period);
  lookback int := ceil(p_duration / p_period)::int + 1;
  s bigint;
  start_t double precision;
  remain double precision;
  ev record;
  news_impact constant double precision := 0.10;
begin
  for s in (slot - lookback)..slot loop
    if s < 0 then continue; end if;
    if p_system is null then
      select * into ev from market.event_slot(p_kind, s);
    else
      select * into ev from market.event_slot_local(p_system, s);
    end if;
    start_t := s * p_period;
    if p_t < start_t or p_t >= start_t + p_duration then continue; end if;
    if ev.target is distinct from p_comm_id and ev.target is distinct from p_cat then continue; end if;
    remain := 1.0 - (p_t - start_t) / p_duration;
    m := m * (1.0 + (ev.mult - 1.0) * remain * news_impact);
  end loop;
  return m;
end;
$$;

create or replace function market.price_global(p_commodity text, p_t double precision)
returns double precision
language plpgsql immutable strict as $$
declare
  c record;
  drift double precision;
  osc double precision;
  vol_gain constant double precision := 1.15;
  floor_m constant double precision := 0.88;
  ceil_m constant double precision := 1.12;
  price double precision;
  event_period constant double precision := 5400000;   -- 90 min
  event_dur constant double precision := 2700000;      -- 45 min
begin
  select * into c from market.commodity(p_commodity);
  if c.id is null then return null; end if;
  drift := market.category_drift(c.cat, p_t);
  osc := market.osc(c.id, p_t);
  price := c.base * drift * (1.0 + c.vol * vol_gain * osc)
        * market.schedule_mult(c.id, c.cat, p_t, event_period, event_dur, 'galactic', null);
  return greatest(c.base * floor_m, least(c.base * ceil_m, price));
end;
$$;

create or replace function market.price_system(p_commodity text, p_system text, p_t double precision)
returns double precision
language plpgsql immutable strict as $$
declare
  c record;
  local_period constant double precision := 2700000;  -- 45 min
  local_dur constant double precision := 1200000;     -- 20 min
begin
  select * into c from market.commodity(p_commodity);
  if c.id is null then return null; end if;
  return market.price_global(p_commodity, p_t)
       * market.mod_compressed(p_system, c.cat)
       * market.schedule_mult(c.id, c.cat, p_t, local_period, local_dur, 'local', p_system);
end;
$$;

-- Convenience wrappers matching the design-doc names.
create or replace function public.market_price(p_commodity text, p_system text, p_t timestamptz default now())
returns double precision
language sql stable as $$
  select market.price_system(p_commodity, p_system, (extract(epoch from p_t) * 1000.0));
$$;

grant execute on function public.market_price(text, text, timestamptz) to authenticated, anon;
