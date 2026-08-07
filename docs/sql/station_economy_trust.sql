-- Station economy trust hardening (paste AFTER station_auctions.sql).
-- Requires: station D0–D4 + phase2_missions_bazaar.sql (app_mission_resolve must
--   skip source='station' — this file raises if that guard is missing).
-- Closes Phase D critical/high holes:
--   1. settle_haul no longer trusts client success — requires server launch + roll
--   2. publish never accepts client treasury/hold (INSERT empty; no bootstrap fields)
--   3. ownership release clears treasury/hold; relinquish/revolt go through RPC
--   4. deliverToExchange credits via app_station_deliver (market-priced, no client mint)
-- Medium follow-ups:
--   5. standing uses delivered_cycle (deliver/haul), not client after_hour fields
--   6. publish respects revolt cooldown; expire reclaims never-launched claims
--   7. release queues haul_refund when _credit_user can't pay escrow back
--
-- Requires: station_treasury/contracts/upkeep/modules/auctions + phase2 ship_def
--           + phase4 market.price_system / scarcity helpers.
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- One-shot economy bootstrap flag (stops remint after withdraw/draw-to-empty).
-- ---------------------------------------------------------------------------
alter table public.stations
  add column if not exists economy_bootstrapped boolean not null default false,
  add column if not exists delivered_cycle int not null default 0;

-- Haul flight ledger — set by app_station_launch_haul; required for success settle.
alter table public.station_hauls
  add column if not exists flight_ms bigint null,
  add column if not exists flight_seed bigint null,
  add column if not exists flight_chance double precision null,
  add column if not exists ship_uids jsonb null;

-- ---------------------------------------------------------------------------
-- Helper: free ships that were locked onto a haul flight.
-- ---------------------------------------------------------------------------
create or replace function app._station_free_haul_ships(p_state jsonb, p_uids jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  ships jsonb := coalesce(p_state->'ships', '[]'::jsonb);
begin
  if p_uids is null or jsonb_typeof(p_uids) <> 'array' then
    return p_state;
  end if;
  ships := (
    select coalesce(jsonb_agg(
      case when exists (
        select 1 from jsonb_array_elements_text(p_uids) u where u = sh.value->>'uid'
      ) and sh.value->>'status' = 'mission'
        then jsonb_set(sh.value, '{status}', '"idle"')
        else sh.value end
    ), '[]'::jsonb)
    from jsonb_array_elements(ships) sh(value)
  );
  return jsonb_set(p_state, '{ships}', ships);
end;
$$;

-- Dedupe + cap (also defined in phase2; recreate here so trust paste is enough).
create or replace function app._pick_idle_ships(p_ships jsonb, p_ship_uids jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  uid_txt text;
  sh      jsonb;
  def     record;
  uids    jsonb := '[]'::jsonb;
  power   double precision := 0;
  cargo   double precision := 0;
  speed   double precision := 0;
  n       int := 0;
begin
  if jsonb_typeof(coalesce(p_ship_uids, 'null'::jsonb)) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'Invalid mission.');
  end if;
  if jsonb_array_length(p_ship_uids) > 64 then
    return jsonb_build_object('ok', false, 'error', 'Too many ships.');
  end if;
  for uid_txt in select distinct value from jsonb_array_elements_text(p_ship_uids) t(value) loop
    exit when n >= 64;
    select value into sh from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) x(value)
      where x.value->>'uid' = uid_txt limit 1;
    if sh is null or sh->>'status' is distinct from 'idle' then continue; end if;
    select * into def from app.ship_def(sh->>'type');
    if def.id is null then continue; end if;
    uids := uids || jsonb_build_array(uid_txt);
    power := power + coalesce(def.firepower, 0);
    cargo := cargo + coalesce(def.cargo, 0);
    speed := speed + coalesce(def.speed, 1);
    n := n + 1;
  end loop;
  if n = 0 then
    return jsonb_build_object('ok', false, 'error', 'Select at least one idle ship.');
  end if;
  return jsonb_build_object(
    'ok', true, 'uids', uids, 'power', power, 'cargo', cargo,
    'speed', speed / n, 'n', n);
end;
$$;

-- ---------------------------------------------------------------------------
-- Launch a claimed station haul: stamp flight timer + RNG on the haul row,
-- lock ships in players.state. Instant claim→success is impossible without this.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_launch_haul(p_haul_id text, p_ship_uids jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, market, app
as $$
declare
  uid        uuid := auth.uid();
  now_ms     bigint := app._now_ms();
  h          public.station_hauls%rowtype;
  st         jsonb;
  ships      jsonb;
  pick       jsonb;
  uids       jsonb := '[]'::jsonb;
  power      double precision := 0;
  cargo      double precision := 0;
  speed      double precision := 0;
  n          int := 0;
  chance     double precision;
  min_fp     double precision;
  cargo_req  double precision;
  duration_ms double precision;
  leg        double precision;
  work       double precision;
  total_ms   double precision;
  seq        int;
  mission    jsonb;
  phases     jsonb;
  rng_seed   bigint;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_haul_id !~ '^[0-9a-fA-F-]{36}$' or jsonb_typeof(coalesce(p_ship_uids, 'null'::jsonb)) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'Invalid haul launch.');
  end if;

  select * into h from public.station_hauls where id = p_haul_id::uuid for update;
  if not found or h.status <> 'active' or h.taken_by is distinct from uid then
    return jsonb_build_object('ok', false, 'error', 'Haul not claimed by you.');
  end if;
  if h.flight_ms is not null then
    return jsonb_build_object('ok', false, 'error', 'Haul already launched.');
  end if;

  st := app._lock_state(now_ms);
  ships := coalesce(st->'ships', '[]'::jsonb);
  pick := app._pick_idle_ships(ships, p_ship_uids);
  if not coalesce((pick->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', coalesce(pick->>'error', 'Select at least one idle ship.'));
  end if;
  uids := pick->'uids';
  power := coalesce((pick->>'power')::float8, 0);
  cargo := coalesce((pick->>'cargo')::float8, 0);
  speed := coalesce((pick->>'speed')::float8, 1);
  n := coalesce((pick->>'n')::int, 0);

  -- Matches Stations._toBoardJob duration + Missions.buildPhases.
  duration_ms := 25 * 60 * 1000 + h.qty * 8000;
  duration_ms := greatest(180000, least(6 * 60 * 60 * 1000, duration_ms));
  min_fp := greatest(4, round(h.qty / 40.0));
  cargo_req := h.qty;
  chance := app.danger_base_success('low');
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
    jsonb_build_object('label', 'Loading hold', 'dir', 'work', 'ms', work * 0.45),
    jsonb_build_object('label', 'Hauling', 'dir', 'work', 'ms', work * 0.55),
    jsonb_build_object('label', 'Return transit', 'dir', 'in', 'ms', leg)
  );

  seq := coalesce((st->>'seq')::int, 1) + 1;
  rng_seed := market.seed_hash('cosmocrat-market-v1', 'station-haul', h.id::text, now_ms::text);

  update public.station_hauls set
    flight_ms = floor(total_ms)::bigint,
    flight_seed = rng_seed,
    flight_chance = chance,
    ship_uids = uids,
    taken_at = now()
  where id = h.id;

  mission := jsonb_build_object(
    'uid', 'm' || seq,
    'contractId', h.id::text,
    'type', 'transport',
    'title', 'Station haul',
    'sysName', h.system_id,
    'shipUids', uids,
    'phases', phases,
    'totalMs', total_ms,
    'startedAt', now_ms,
    'rngSeed', rng_seed,
    'successChance', chance,
    'reward', jsonb_build_object('credits', h.escrow, 'itemChance', 0, 'stockChance', 0),
    'impound', false,
    'danger', 'low',
    'stakeTier', 0,
    'faction', null,
    'resolved', false,
    'source', 'station',
    'stationId', h.system_id
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
  st := jsonb_set(st, '{ships}', ships);
  st := jsonb_set(st, '{seq}', to_jsonb(seq));
  st := jsonb_set(st, '{missions}', coalesce(st->'missions', '[]'::jsonb) || jsonb_build_array(mission));
  perform app._write_state(st, now_ms);

  return jsonb_build_object('ok', true, 'mission', mission) || coalesce(app.result_slice(st), '{}'::jsonb);
end;
$$;

revoke execute on function public.app_station_launch_haul(text, jsonb) from public;
grant execute on function public.app_station_launch_haul(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Settle: success/fail require a launched, matured flight; server rolls RNG.
-- abandon/expire unchanged (early cancel / owner expiry).
-- ---------------------------------------------------------------------------
create or replace function public.app_station_settle_haul(p_haul_id text, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, market
as $$
declare
  uid      uuid := auth.uid();
  now_ms   bigint := app._now_ms();
  h        public.station_hauls%rowtype;
  st       public.stations%rowtype;
  pstate   jsonb;
  credits  double precision;
  outc     text := lower(coalesce(p_outcome, ''));
  success  boolean;
  roll     double precision;
  missions jsonb;
  kept     jsonb := '[]'::jsonb;
  m        jsonb;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_haul_id !~ '^[0-9a-fA-F-]{36}$' then
    return jsonb_build_object('ok', false, 'error', 'Haul gone.');
  end if;
  if outc not in ('success', 'fail', 'abandon', 'expire') then
    return jsonb_build_object('ok', false, 'error', 'Invalid outcome.');
  end if;

  select * into h from public.station_hauls where id = p_haul_id::uuid for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Haul gone.'); end if;
  if h.status in ('filled', 'cancelled', 'expired', 'failed') then
    return jsonb_build_object('ok', false, 'error', 'Already settled.');
  end if;

  if outc = 'expire' then
    if h.owner_id <> uid then
      return jsonb_build_object('ok', false, 'error', 'Not your posting.');
    end if;
    if h.status = 'open' then
      if h.expires_at > now() then
        return jsonb_build_object('ok', false, 'error', 'Not expired.');
      end if;
    elsif h.status = 'active' and h.flight_ms is null
          and h.taken_at is not null
          and h.taken_at < now() - interval '24 hours' then
      null; -- claimed but never launched — owner reclaim
    else
      return jsonb_build_object('ok', false, 'error', 'Not expired.');
    end if;
  elsif outc in ('success', 'fail', 'abandon') then
    if h.status <> 'active' or h.taken_by is distinct from uid then
      return jsonb_build_object('ok', false, 'error', 'Not your haul.');
    end if;
  end if;

  -- success/fail: must have launched and finished the server flight timer.
  -- Client outcome is ignored for the roll — only abandon skips the flight.
  if outc in ('success', 'fail') then
    if h.flight_ms is null or h.flight_seed is null then
      return jsonb_build_object('ok', false, 'error', 'Haul not launched.');
    end if;
    if h.taken_at + (h.flight_ms || ' milliseconds')::interval > now() then
      return jsonb_build_object('ok', false, 'error', 'Still in flight.');
    end if;
    roll := market.u01(h.flight_seed, 0);
    success := roll < coalesce(h.flight_chance, 0.5);
  elsif outc = 'abandon' then
    success := false;
  else
    success := false; -- expire
  end if;

  select * into st from public.stations where system_id = h.system_id for update;

  if success then
    perform public._station_restock(h.system_id, h.comm_id, h.qty);
    if not app._credit_user(h.taken_by, h.escrow, now_ms) then
      insert into public.station_payouts (user_id, system_id, amount, reason, note)
      values (h.taken_by, h.system_id, h.escrow, 'sale', 'haul:' || left(h.comm_id, 20));
    end if;
    update public.station_hauls set status = 'filled',
      flight_ms = null, flight_seed = null, flight_chance = null, ship_uids = null
     where id = h.id;
    update public.stations
       set contract_filled = contract_filled + 1,
           delivered_cycle = coalesce(delivered_cycle, 0) + h.qty,
           updated_at = now()
     where system_id = h.system_id;
    outc := 'success';
  else
    if not app._credit_user(h.owner_id, h.escrow, now_ms) then
      insert into public.station_payouts (user_id, system_id, amount, reason, note)
      values (h.owner_id, h.system_id, h.escrow, 'haul_refund', h.id::text);
    end if;
    update public.stations
       set hold = public._station_hold_add(hold, h.comm_id, h.qty),
           contract_expired = contract_expired + case when outc = 'expire' then 1 else 0 end,
           updated_at = now()
     where system_id = h.system_id;
    update public.station_hauls
       set status = case outc when 'expire' then 'expired' else 'failed' end,
           flight_ms = null, flight_seed = null, flight_chance = null, ship_uids = null
     where id = h.id;
    if outc not in ('expire', 'abandon') then outc := 'fail'; end if;
  end if;

  -- Free ships + drop matching station mission from the hauler's save.
  if h.taken_by is not null and outc <> 'expire' then
    pstate := app._lock_state_for_owner(h.taken_by, now_ms);
    if pstate is not null then
      pstate := app._station_free_haul_ships(pstate, h.ship_uids);
      missions := coalesce(pstate->'missions', '[]'::jsonb);
      kept := '[]'::jsonb;
      for m in select value from jsonb_array_elements(missions) loop
        if m->>'contractId' is not distinct from h.id::text then continue; end if;
        kept := kept || jsonb_build_array(m);
      end loop;
      pstate := jsonb_set(pstate, '{missions}', kept);
      perform app._write_state_for(h.taken_by, pstate, now_ms);
    end if;
  end if;

  pstate := app._lock_state(now_ms);
  credits := coalesce((pstate->>'credits')::float8, 0);

  return jsonb_build_object(
    'ok', true, 'outcome', outc, 'credits', credits,
    'hold', (select hold from public.stations where system_id = h.system_id),
    'contract_filled', (select contract_filled from public.stations where system_id = h.system_id),
    'contract_expired', (select contract_expired from public.stations where system_id = h.system_id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Deliver hold → sector capital exchange (server-priced credits + restock).
-- ---------------------------------------------------------------------------
create or replace function public.app_station_deliver(p_system text, p_comm text, p_qty int)
returns jsonb
language plpgsql
security definer
set search_path = public, market, app
as $$
declare
  uid      uuid := auth.uid();
  now_ms   bigint := app._now_ms();
  strow    public.stations%rowtype;
  pstate   jsonb;
  credits  double precision;
  qty      int := floor(coalesce(p_qty, 0));
  have     int;
  sec      text;
  sys      text;
  comm     record;
  mid      double precision;
  scar     double precision;
  spread   double precision;
  unit     double precision;
  proceeds double precision;
  base_u   integer;
  have_u   integer;
  glut_cap integer;
  next_h   jsonb;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_system is null or length(p_system) > 40 then
    return jsonb_build_object('ok', false, 'error', 'No station.');
  end if;
  if qty < 1 or qty > 500 then
    return jsonb_build_object('ok', false, 'error', 'Bad quantity.');
  end if;

  select * into strow from public.stations where system_id = p_system for update;
  if not found or strow.owner_id is distinct from uid or strow.status <> 'owned' then
    return jsonb_build_object('ok', false, 'error', 'Not your station.');
  end if;

  select * into comm from market.commodity(left(coalesce(p_comm, ''), 40));
  if comm.id is null or coalesce(comm.craft_only, false) then
    return jsonb_build_object('ok', false, 'error', 'Unknown commodity.');
  end if;

  have := public._station_hold_get(coalesce(strow.hold, '{}'::jsonb), comm.id);
  if qty > have then
    return jsonb_build_object('ok', false, 'error', format('Only %s in station hold.', have));
  end if;

  pstate := app._lock_state(now_ms);
  if app._in_transit(pstate) then
    return jsonb_build_object('ok', false, 'error', 'Can''t deliver in transit.');
  end if;
  -- Same gate as app_trade: only the six curated capitals map to a sector.
  sys := pstate->>'currentSystem';
  sec := market.sector_of_system(sys);
  if sec is null then
    return jsonb_build_object('ok', false, 'error', 'Dock at the sector capital to deliver.');
  end if;

  perform market.seed_sector_stock();
  perform market.ensure_stock_row(sec, comm.id);
  select units into have_u from public.sector_stock
    where sector_id = sec and comm_id = comm.id for update;
  have_u := coalesce(have_u, 0);
  base_u := market.stock_baseline(sec, comm.id);
  if base_u <= 0 then
    return jsonb_build_object('ok', false, 'error', 'This station doesn''t stock that commodity.');
  end if;
  glut_cap := greatest(base_u * 3, 1);
  if have_u >= glut_cap then
    return jsonb_build_object('ok', false, 'error', 'Sector shelves are full — try another capital.');
  end if;
  qty := least(qty, glut_cap - have_u);
  if qty <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Sector shelves are full — try another capital.');
  end if;

  mid := market.price_system(comm.id, sys, now_ms::float8);
  if mid is null or mid <= 0 then
    return jsonb_build_object('ok', false, 'error', 'No price.');
  end if;
  scar := market.scarcity_mult(have_u, base_u);
  mid := mid * scar;
  spread := app._spread(pstate, comm.cat);
  unit := mid * (1.0 - spread);
  proceeds := unit * qty;
  credits := coalesce((pstate->>'credits')::float8, 0) + proceeds;
  pstate := jsonb_set(pstate, '{credits}', to_jsonb(credits));

  next_h := public._station_hold_take(coalesce(strow.hold, '{}'::jsonb), comm.id, qty);
  update public.stations
     set hold = next_h,
         delivered_cycle = coalesce(delivered_cycle, 0) + qty,
         updated_at = now()
   where system_id = p_system;
  update public.sector_stock set units = have_u + qty, updated_at = now()
    where sector_id = sec and comm_id = comm.id;
  perform app._write_state(pstate, now_ms);

  return jsonb_build_object(
    'ok', true, 'qty', qty, 'proceeds', proceeds, 'price', unit,
    'credits', credits, 'hold', next_h
  );
end;
$$;

revoke execute on function public.app_station_deliver(text, text, int) from public;
grant execute on function public.app_station_deliver(text, text, int) to authenticated;

-- ---------------------------------------------------------------------------
-- Release ownership — clears treasury/hold (no double-pay / winner inheritance).
-- mode 'relinquish': buyback treasury + sell hold into sector at mid price.
-- mode 'revolt': forfeit treasury + hold (faction sink); 24h cooldown.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_release(p_system text, p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = public, market, app
as $$
declare
  uid      uuid := auth.uid();
  now_ms   bigint := app._now_ms();
  mode     text := lower(coalesce(p_mode, 'relinquish'));
  strow    public.stations%rowtype;
  pstate   jsonb;
  credits  double precision;
  buyback  double precision := 0;
  hold_pay double precision := 0;
  k        text;
  v        text;
  qty      int;
  sec      text;
  comm     record;
  mid      double precision;
  unit     double precision;
  open_h   record;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if mode not in ('relinquish', 'revolt') then
    return jsonb_build_object('ok', false, 'error', 'Bad release mode.');
  end if;
  if p_system is null or length(p_system) > 40 then
    return jsonb_build_object('ok', false, 'error', 'No station.');
  end if;

  select * into strow from public.stations where system_id = p_system for update;
  if not found or strow.owner_id is distinct from uid
     or strow.status not in ('owned', 'refit') then
    return jsonb_build_object('ok', false, 'error', 'Not your station.');
  end if;

  -- Cancel open hauls: refund escrow + restore hold goods before wipe.
  for open_h in
    select * from public.station_hauls
     where system_id = p_system and owner_id = uid and status = 'open'
     for update
  loop
    if not app._credit_user(uid, open_h.escrow, now_ms) then
      insert into public.station_payouts (user_id, system_id, amount, reason, note)
      values (uid, p_system, open_h.escrow, 'haul_refund', open_h.id::text);
    end if;
    strow.hold := public._station_hold_add(coalesce(strow.hold, '{}'::jsonb), open_h.comm_id, open_h.qty);
    update public.station_hauls set status = 'cancelled' where id = open_h.id;
  end loop;

  pstate := app._lock_state(now_ms);
  credits := coalesce((pstate->>'credits')::float8, 0);

  if mode = 'relinquish' then
    buyback := greatest(0, floor(coalesce(strow.treasury, 0)));
    credits := credits + buyback;
    sec := market.sector_of_system(p_system);
    if sec is not null then
      perform market.seed_sector_stock();
      for k, v in select key, value from jsonb_each_text(coalesce(strow.hold, '{}'::jsonb)) loop
        begin qty := greatest(0, least(500, v::int)); exception when others then qty := 0; end;
        if qty <= 0 then continue; end if;
        select * into comm from market.commodity(left(k, 40));
        if comm.id is null or coalesce(comm.craft_only, false) then continue; end if;
        mid := coalesce(market.price_system(comm.id, p_system, now_ms::float8), 0);
        unit := mid * (1.0 - app._spread(pstate, comm.cat));
        hold_pay := hold_pay + unit * qty;
        perform public._station_restock(p_system, comm.id, qty);
      end loop;
    end if;
    credits := credits + hold_pay;
    pstate := jsonb_set(pstate, '{credits}', to_jsonb(credits));
    perform app._write_state(pstate, now_ms);

    update public.stations set
      owner_id = null, owner_display = null, status = 'npc',
      treasury = 0, hold = '{}'::jsonb,
      standing = 60, prod_comm = null,
      hall = '[]'::jsonb, bays = '[]'::jsonb,
      cooldown_until = null, updated_at = now()
    where system_id = p_system;
  else
    -- Revolt: forfeit treasury + hold; modules remain for next owner.
    -- economy_bootstrapped stays sticky — release already zeroes wealth.
    update public.stations set
      owner_id = null, owner_display = null, status = 'cooldown',
      treasury = 0, hold = '{}'::jsonb,
      hall = '[]'::jsonb, bays = '[]'::jsonb,
      standing = 60, prod_comm = null,
      cooldown_until = now() + interval '24 hours',
      updated_at = now()
    where system_id = p_system;
  end if;

  return jsonb_build_object(
    'ok', true, 'mode', mode, 'credits', credits,
    'treasury', buyback, 'holdCredits', hold_pay
  );
end;
$$;

revoke execute on function public.app_station_release(text, text) from public;
grant execute on function public.app_station_release(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Publish: server owns treasury/hold (never from client). Release clears wealth.
-- (Replaces D3 modules publish — paste this file last among station SQL.)
-- ---------------------------------------------------------------------------
create or replace function public.app_station_publish(p_stations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid       uuid := auth.uid();
  v_rows    jsonb := coalesce(p_stations, '[]'::jsonb);
  r         jsonb;
  sid       text;
  uname     text;
  jn        bigint;
  disp      text;
  v_hall    jsonb;
  v_bays    jsonb;
  v_n       int;
  prev_bays jsonb;
  merged    jsonb;
  i         int;
  c_el      jsonb;
  s_el      jsonb;
  c_lid     text;
  s_lid     text;
  c_npc     boolean;
  s_npc     boolean;
  keep_srv  boolean;
  kept      text[] := '{}';
  blocked   text[] := '{}';
  conflicts text[];
  synced    jsonb;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'error', 'not signed in');
  end if;
  if jsonb_typeof(v_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'stations must be an array');
  end if;
  if jsonb_array_length(v_rows) > 24 then
    return jsonb_build_object('ok', false, 'error', 'too many stations');
  end if;

  select username, join_n into uname, jn from public.profiles where user_id = uid;
  disp := case
    when uname is not null and length(trim(uname)) > 0 then trim(uname)
    when jn is not null and jn > 0 then 'Baron #' || jn::text
    else 'Baron'
  end;

  for r in select * from jsonb_array_elements(v_rows) loop
    sid := nullif(trim(coalesce(r->>'system_id', '')), '');
    continue when sid is null or length(sid) > 40;

    -- Revolt cooldown: auction_open respects it; publish must too.
    if exists (
      select 1 from public.stations s
       where s.system_id = sid and s.status = 'cooldown'
         and s.cooldown_until is not null and s.cooldown_until > now()
    ) then
      blocked := blocked || sid;
      continue;
    end if;
    kept := kept || sid;

    v_hall := case when jsonb_typeof(r->'hall') = 'array' then r->'hall' else '[]'::jsonb end;
    if jsonb_array_length(v_hall) > 40 then
      select jsonb_agg(x) into v_hall from (select x from jsonb_array_elements(v_hall) x limit 40) q;
    end if;

    v_n := public._station_bay_count(
      case when jsonb_typeof(r->'modules') = 'object' then r->'modules' else '{}'::jsonb end);

    select bays into prev_bays from public.stations where system_id = sid and owner_id = uid;
    prev_bays := coalesce(prev_bays, '[]'::jsonb);
    v_bays := case when jsonb_typeof(r->'bays') = 'array' then r->'bays' else '[]'::jsonb end;

    merged := '[]'::jsonb;
    for i in 0 .. greatest(v_n - 1, 0) loop
      exit when v_n <= 0;
      c_el  := v_bays -> i;
      s_el  := prev_bays -> i;
      c_lid := left(coalesce(c_el->>'lesseeId', ''), 64);
      s_lid := left(coalesce(s_el->>'lesseeId', ''), 64);
      c_npc := coalesce((c_el->>'npc')::boolean, false);
      s_npc := coalesce((s_el->>'npc')::boolean, false);

      if c_lid in ('player', uid::text) and not c_npc then
        c_lid := uid::text;
      end if;

      keep_srv := (c_lid = '' or c_npc or c_lid = 'npc')
                  and s_lid <> '' and not s_npc
                  and s_lid is distinct from uid::text
                  and s_lid <> 'player'
                  and s_lid <> 'npc';

      if keep_srv then
        merged := merged || jsonb_build_array(jsonb_build_object(
          'lesseeId', s_lid, 'npc', false,
          'taxed_at', s_el->'taxed_at',
          'extractorId', coalesce(s_el->>'extractorId', '')));
      elsif c_lid <> '' and not c_npc and c_lid <> 'npc' then
        -- Owner-staffed bays may carry extractorId (after_hour yield quality).
        -- Remote lessees: occupancy only — their extractor stays in their save.
        if s_lid = c_lid and s_el ? 'taxed_at' and s_el->>'taxed_at' is not null then
          merged := merged || jsonb_build_array(jsonb_build_object(
            'lesseeId', c_lid, 'npc', false, 'taxed_at', s_el->'taxed_at',
            'extractorId', case when c_lid = uid::text
              then left(coalesce(nullif(c_el->>'extractorId', ''), s_el->>'extractorId'), 40)
              else '' end));
        else
          merged := merged || jsonb_build_array(jsonb_build_object(
            'lesseeId', c_lid, 'npc', false,
            'extractorId', case when c_lid = uid::text
              then left(coalesce(c_el->>'extractorId', ''), 40) else '' end));
        end if;
      else
        merged := merged || jsonb_build_array(jsonb_build_object(
          'lesseeId', '', 'npc', false, 'extractorId', ''));
      end if;
    end loop;
    if v_n <= 0 then merged := '[]'::jsonb; end if;

    -- No client treasury/hold bootstrap — INSERT starts empty; UPDATE keeps server.
    insert into public.stations as s (
      system_id, owner_id, owner_display, tier, status, modules, reactor_level,
      treasury, hold, lease_tax_bps, sale_tariff_bps, scrutiny, standing, prod_comm,
      refit_until, hall, bays, economy_bootstrapped, updated_at
    )
    values (
      sid, uid, disp,
      coalesce(nullif(trim(coalesce(r->>'tier', '')), ''), 'Berth'),
      case when coalesce(r->>'status', '') in ('owned', 'refit') then r->>'status' else 'owned' end,
      case when jsonb_typeof(r->'modules') = 'object' then r->'modules' else '{}'::jsonb end,
      greatest(0, least(5, coalesce((r->>'reactor_level')::int, 0))),
      0,
      '{}'::jsonb,
      greatest(0, least(4000, coalesce((r->>'lease_tax_bps')::int, 1000))),
      greatest(0, least(1500, coalesce((r->>'sale_tariff_bps')::int, 500))),
      greatest(0, least(100, coalesce((r->>'scrutiny')::int, 10))),
      greatest(0, least(100, coalesce((r->>'standing')::numeric, 60))),
      left(nullif(trim(coalesce(r->>'prod_comm', '')), ''), 40),
      case when (r->>'refit_until') ~ '^\d+$' and (r->>'refit_until')::bigint > 0
           then to_timestamp((r->>'refit_until')::bigint / 1000.0) end,
      coalesce(v_hall, '[]'::jsonb),
      coalesce(merged, '[]'::jsonb),
      true,
      now()
    )
    on conflict (system_id) do update set
      owner_id        = excluded.owner_id,
      owner_display   = excluded.owner_display,
      tier            = excluded.tier,
      status          = excluded.status,
      modules         = s.modules,
      reactor_level   = s.reactor_level,
      -- Never accept client wealth. New owner taking over starts at zero.
      treasury        = case
                          when s.owner_id is not null and s.owner_id is distinct from uid then 0
                          else s.treasury
                        end,
      hold            = case
                          when s.owner_id is not null and s.owner_id is distinct from uid then '{}'::jsonb
                          else s.hold
                        end,
      economy_bootstrapped = true,
      lease_tax_bps   = s.lease_tax_bps,
      sale_tariff_bps = s.sale_tariff_bps,
      scrutiny        = s.scrutiny,
      standing        = s.standing,
      contract_filled = s.contract_filled,
      contract_expired = s.contract_expired,
      prod_comm       = excluded.prod_comm,
      refit_until     = excluded.refit_until,
      hall            = excluded.hall,
      bays            = excluded.bays,
      updated_at      = now()
    where s.owner_id is null
       or s.owner_id = uid
       or s.updated_at < now() - interval '30 days';
  end loop;

  -- Dropped stations: clear wealth so the next owner/auction can't inherit it.
  -- economy_bootstrapped stays sticky across ownership.
  update public.stations
     set owner_id = null, owner_display = null, status = 'npc',
         treasury = 0, hold = '{}'::jsonb,
         hall = '[]'::jsonb, bays = '[]'::jsonb,
         cooldown_until = null, updated_at = now()
   where owner_id = uid
     and not (system_id = any(kept));

  select array_agg(system_id) into conflicts
    from public.stations
   where system_id = any(kept) and owner_id is distinct from uid;
  conflicts := coalesce(conflicts, '{}'::text[]) || blocked;

  select coalesce(jsonb_agg(jsonb_build_object(
           'system_id', system_id,
           'treasury', floor(treasury),
           'standing', round(standing),
           'hold', hold,
           'modules', modules,
           'reactor_level', reactor_level,
           'contract_filled', contract_filled,
           'contract_expired', contract_expired)), '[]'::jsonb)
    into synced
    from public.stations
   where owner_id = uid and system_id = any(kept);

  return jsonb_build_object(
    'ok', true,
    'display', disp,
    'held', coalesce(array_length(kept, 1), 0),
    'conflicts', to_jsonb(coalesce(conflicts, '{}'::text[])),
    'treasuries', coalesce(synced, '[]'::jsonb)
  );
end;
$$;

grant execute on function public.app_station_publish(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Auction close: winner must not bootstrap-mint; zero leftover wealth.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_close_due()
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  a         public.station_auctions%rowtype;
  st        public.stations%rowtype;
  tier      int;
  cap       int;
  owned     int;
  closed    jsonb := '[]'::jsonb;
begin
  for a in
    select * from public.station_auctions
     where status = 'open' and closes_at <= now()
     for update
  loop
    select * into st from public.stations where system_id = a.system_id for update;

    if a.high_bidder is null then
      update public.station_auctions set status = 'closed' where system_id = a.system_id;
      continue;
    end if;

    select coalesce((state->'prestige'->>'tier')::int, 0) into tier
      from public.players where user_id = a.high_bidder for update;

    if not found then
      update public.station_auctions set status = 'forfeit' where system_id = a.system_id;
      closed := closed || jsonb_build_array(jsonb_build_object(
        'system_id', a.system_id, 'outcome', 'forfeit', 'bidder', a.high_bidder));
      continue;
    end if;

    cap := public._station_owner_cap(tier);
    owned := public._station_owned_count(a.high_bidder);

    if owned >= cap then
      perform app._credit_user(a.high_bidder, a.high_bid, app._now_ms());
      update public.station_auctions set status = 'forfeit' where system_id = a.system_id;
      closed := closed || jsonb_build_array(jsonb_build_object(
        'system_id', a.system_id, 'outcome', 'forfeit', 'bidder', a.high_bidder));
      continue;
    end if;

    -- Winner: credits sunk (no refund). Claim station — no wealth inheritance,
    -- bootstrap already spent for this row (sticky flag).
    insert into public.stations (system_id, owner_id, tier, status, standing,
      modules, reactor_level, treasury, hold, economy_bootstrapped, updated_at)
    values (a.system_id, a.high_bidder,
      coalesce(st.tier, 'Berth'), 'owned', 60,
      coalesce(st.modules, '{}'::jsonb), coalesce(st.reactor_level, 0),
      0, '{}'::jsonb, true, now())
    on conflict (system_id) do update set
      owner_id = excluded.owner_id,
      status = 'owned',
      standing = 60,
      treasury = 0,
      hold = '{}'::jsonb,
      economy_bootstrapped = true,
      cooldown_until = null,
      updated_at = now();

    update public.station_auctions set status = 'closed' where system_id = a.system_id;
    closed := closed || jsonb_build_array(jsonb_build_object(
      'system_id', a.system_id, 'outcome', 'won', 'bidder', a.high_bidder, 'amount', a.high_bid));
  end loop;

  return jsonb_build_object('ok', true, 'closed', closed);
end;
$$;

grant execute on function public.app_station_close_due() to authenticated;

-- ---------------------------------------------------------------------------
-- Expire open hauls + reclaim claims that never launched (24h).
-- ---------------------------------------------------------------------------
create or replace function public.app_station_expire_hauls(p_system text)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid uuid := auth.uid();
  hid uuid;
  n   int := 0;
  res jsonb;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  for hid in
    select id from public.station_hauls
     where system_id = p_system and owner_id = uid
       and (
         (status = 'open' and expires_at <= now())
         or (status = 'active' and flight_ms is null
             and taken_at is not null
             and taken_at < now() - interval '24 hours')
       )
     for update
  loop
    res := public.app_station_settle_haul(hid::text, 'expire');
    if coalesce((res->>'ok')::boolean, false) then n := n + 1; end if;
  end loop;
  return jsonb_build_object('ok', true, 'expired', n);
end;
$$;

revoke execute on function public.app_station_expire_hauls(text) from public;
grant execute on function public.app_station_expire_hauls(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Fail loud if app_mission_resolve still pays station hauls (double escrow).
-- Prefer re-pasting phase2_missions_bazaar.sql (has the source=station skip);
-- this check makes a docs-only paste of trust.sql refuse to leave a mint open.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'app_mission_resolve'
      and pg_get_functiondef(p.oid) like '%''source'' = ''station''%'
  ) then
    raise exception
      'Re-paste docs/sql/phase2_missions_bazaar.sql first — app_mission_resolve still pays station hauls (double escrow).';
  end if;
end $$;
