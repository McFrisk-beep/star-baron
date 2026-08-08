-- Station soft-income trust (paste AFTER station_economy_trust.sql).
-- Closes remaining Phase 3/4 holes where the client minted protected
-- credits/positions and app_commit erased them:
--   1. app_station_bay_produce credits lessee keep into players.positions
--   2. app_station_after_hour applies owner extractor quality (not jack-only)
--   3. app_station_settle credits orphan bay-tax into positions when the
--      station is no longer owned (hold deposit missed)
-- Requires: station D0–D4 + station_economy_trust.sql + phase3
--           (app._extractor_yield_mult / app._component_amount / app._lock_state).
-- Safe to re-run.

-- Owner-staffed bay count: accept legacy "player" lesseeId (local save key)
-- as well as the account uuid publish rewrites to.
create or replace function public._station_owner_staffed(p_bays jsonb, p_owner uuid)
returns int language sql immutable as $$
  select coalesce(count(*)::int, 0)
  from jsonb_array_elements(coalesce(p_bays, '[]'::jsonb)) b
  where left(coalesce(b->>'lesseeId', ''), 64) in (p_owner::text, 'player')
    and not coalesce((b->>'npc')::boolean, false);
$$;

-- ---------------------------------------------------------------------------
-- Credit commodity units into a player's positions (zero cost basis).
-- ---------------------------------------------------------------------------
create or replace function app._credit_positions(
  p_uid uuid, p_comm text, p_qty int, p_now_ms bigint
) returns boolean
language plpgsql
security definer
set search_path = public, app
as $$
declare
  st jsonb;
  positions jsonb;
  avg_cost jsonb;
  held double precision;
  qty int;
  cid text;
begin
  qty := greatest(0, least(500, coalesce(p_qty, 0)));
  cid := left(coalesce(nullif(trim(p_comm), ''), ''), 40);
  if p_uid is null or qty <= 0 or cid = '' then return false; end if;
  select state into st from public.players where user_id = p_uid for update;
  if st is null then return false; end if;
  positions := coalesce(st->'positions', '{}'::jsonb);
  avg_cost := coalesce(st->'avgCost', '{}'::jsonb);
  held := coalesce((positions->>cid)::float8, 0);
  -- Soft income at zero cost basis (same as industry minting in app_pull).
  if held > 0 then
    avg_cost := jsonb_set(avg_cost, array[cid],
      to_jsonb((coalesce((avg_cost->>cid)::float8, 0) * held) / (held + qty)));
  else
    avg_cost := jsonb_set(avg_cost, array[cid], to_jsonb(0::float8), true);
  end if;
  positions := jsonb_set(positions, array[cid], to_jsonb(held + qty), true);
  st := jsonb_set(st, '{positions}', positions);
  st := jsonb_set(st, '{avgCost}', avg_cost);
  st := jsonb_set(st, '{lastSeenAt}', to_jsonb(p_now_ms));
  update public.players set state = st, updated_at = now() where user_id = p_uid;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Bay produce — tax still queues for the owner; keep credits the lessee ledger.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_bay_produce(
  p_system text, p_bay int, p_gross int
)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid    uuid := auth.uid();
  now_ms bigint := app._now_ms();
  st     public.stations%rowtype;
  n      int;
  v_bays jsonb;
  el     jsonb;
  lid    text;
  gross  int;
  bps    int;
  tax    int;
  keep   int;
  taxed  timestamptz;
  pstate jsonb;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_system is null or length(p_system) > 40 then
    return jsonb_build_object('ok', false, 'error', 'No station.');
  end if;
  if p_bay is null or p_bay < 0 or p_bay > 11 then
    return jsonb_build_object('ok', false, 'error', 'No such bay.');
  end if;

  select * into st from public.stations where system_id = p_system for update;
  if not found or st.owner_id is null or st.status <> 'owned' then
    return jsonb_build_object('ok', false, 'error', 'Station isn''t producing.');
  end if;
  if st.status = 'refit' or (st.refit_until is not null and st.refit_until > now()) then
    return jsonb_build_object('ok', false, 'error', 'Station is in refit.');
  end if;
  if coalesce(nullif(trim(st.prod_comm), ''), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'No Production Hub commodity assigned.');
  end if;

  n := public._station_bay_count(st.modules);
  if n <= 0 or p_bay >= n then
    return jsonb_build_object('ok', false, 'error', 'No such bay.');
  end if;

  v_bays := public._station_bays_pad(st.bays, n);
  el := v_bays -> p_bay;
  lid := coalesce(el->>'lesseeId', '');
  if lid is distinct from uid::text then
    return jsonb_build_object('ok', false, 'error', 'Not your bay.');
  end if;
  if coalesce((el->>'npc')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'Not your bay.');
  end if;

  begin
    taxed := (el->>'taxed_at')::timestamptz;
  exception when others then
    taxed := null;
  end;
  if taxed is not null and taxed > now() - interval '50 minutes' then
    return jsonb_build_object('ok', false, 'error', 'Bay already produced this cycle.',
                              'retry_at', taxed + interval '50 minutes');
  end if;

  -- Soft cap: hub V per-bay × fat extractor ≈ 80×3. Under-reporting is free.
  gross := greatest(0, least(300, coalesce(p_gross, 0)));
  if gross <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Nothing to produce.');
  end if;

  bps  := greatest(0, least(4000, coalesce(st.lease_tax_bps, 1000)));
  tax  := floor(gross * bps / 10000.0);
  keep := gross - tax;

  if tax > 0 then
    insert into public.station_bay_tax (owner_id, system_id, comm_id, qty, lessee_id)
    values (st.owner_id, p_system, left(st.prod_comm, 40), tax, uid);
  end if;

  if keep > 0 then
    perform app._credit_positions(uid, st.prod_comm, keep, now_ms);
  end if;

  v_bays := jsonb_set(v_bays, array[p_bay::text],
    jsonb_build_object(
      'lesseeId', uid::text, 'npc', false, 'taxed_at', now(),
      'extractorId', left(coalesce(el->>'extractorId', ''), 40)), true);
  update public.stations set bays = v_bays, updated_at = now() where system_id = p_system;

  pstate := app._lock_state(now_ms);

  return jsonb_build_object(
    'ok', true,
    'bay', p_bay,
    'commId', st.prod_comm,
    'gross', gross,
    'tax', tax,
    'keep', keep,
    'leaseTaxBps', bps,
    'positions', coalesce(pstate->'positions', '{}'::jsonb),
    'avgCost', coalesce(pstate->'avgCost', '{}'::jsonb)
  );
end;
$$;

grant execute on function public.app_station_bay_produce(text, int, int) to authenticated;

-- ---------------------------------------------------------------------------
-- After-hour hub output — per owner bay, apply extractor yieldMult + rate.
-- Falls back to jack (0.6) when extractorId is missing / invalid.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_after_hour(p_reports jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, market
as $$
declare
  uid       uuid := auth.uid();
  now_ms    bigint := app._now_ms();
  pstate    jsonb;
  credits   double precision;
  r         jsonb;
  sid       text;
  st        public.stations%rowtype;
  delivered int;
  expected  int;
  stand     numeric;
  upkeep    bigint;
  hub       int;
  staffed   int;
  bay_n     int;
  bay_cap   int;
  staff_fac numeric;
  paid      boolean;
  synced    jsonb;
  tick_at   timestamptz;
  produced  int;
  per_bay   numeric;
  strike    boolean;
  comm      record;
  next_h    jsonb;
  bay       jsonb;
  ex_id     text;
  ex        jsonb;
  can_prod  boolean;
  ymult     double precision;
  rate_bon  double precision;
  comp_n    int;
  cuid      text;
  comp      jsonb;
  bay_out   int;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if jsonb_typeof(coalesce(p_reports, 'null'::jsonb)) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'reports must be an array');
  end if;
  if jsonb_array_length(p_reports) > 24 then
    return jsonb_build_object('ok', false, 'error', 'too many stations');
  end if;

  select last_tick_at into tick_at from public.sector_stock_meta where id = 'global';
  if tick_at is null then tick_at := now(); end if;

  pstate := app._lock_state(now_ms);
  credits := coalesce((pstate->>'credits')::float8, 0);

  for r in select * from jsonb_array_elements(p_reports) loop
    sid := nullif(trim(coalesce(r->>'system_id', '')), '');
    continue when sid is null or length(sid) > 40;

    select * into st from public.stations where system_id = sid for update;
    if not found or st.owner_id is distinct from uid or st.status <> 'owned' then
      continue;
    end if;

    if st.upkeep_paid_through is not null and st.upkeep_paid_through >= tick_at then
      continue;
    end if;

    strike := coalesce(st.standing, 60) < 20;

    hub := greatest(0, coalesce((st.modules->>'production_hub')::int, 0));
    staffed := public._station_owner_staffed(st.bays, uid);
    bay_n := greatest(1, coalesce(jsonb_array_length(st.bays), 0));
    staff_fac := greatest(0.35, staffed::numeric / bay_n);
    expected := round(40.0 * hub * (1.0 + public._station_tier_rank(st.tier) * 0.15) * staff_fac)::int;
    if expected < 1 then expected := 40; end if;
    delivered := greatest(0, coalesce(st.delivered_cycle, 0));

    stand := coalesce(st.standing, 60);
    if delivered >= expected then stand := stand + 4;
    elsif delivered > 0 then stand := stand + 1;
    else stand := stand - 5;
    end if;

    if hub <= 0 or st.prod_comm is null or staffed <= 0 then stand := stand - 3; end if;
    if coalesce(st.lease_tax_bps, 0) > 2000 then stand := stand - 2; end if;

    upkeep := public._station_upkeep_per_cycle(st.tier, st.reactor_level, st.modules);
    paid := false;
    if floor(st.treasury) >= upkeep then
      update public.stations set treasury = greatest(0, floor(st.treasury) - upkeep) where system_id = sid;
      select * into st from public.stations where system_id = sid;
      paid := true;
    elsif credits >= upkeep then
      credits := credits - upkeep;
      paid := true;
    else
      stand := stand - 6;
    end if;

    if coalesce((st.modules->>'customs_house')::int, 0) > 0 then
      update public.stations set treasury = floor(treasury) + 800 where system_id = sid;
      stand := stand + 1;
    elsif coalesce((st.modules->>'free_port')::int, 0) > 0 then
      stand := stand - 1;
    end if;

    stand := greatest(0, least(100, stand));

    -- Per-bay Production Hub output → hold (extractor quality from player state).
    next_h := coalesce(st.hold, '{}'::jsonb);
    produced := 0;
    if hub > 0 and staffed > 0 and coalesce(nullif(trim(st.prod_comm), ''), '') <> '' then
      select * into comm from market.commodity(left(st.prod_comm, 40));
      if comm.id is not null and not coalesce(comm.craft_only, false) then
        bay_cap := greatest(1, public._station_bay_count(st.modules));
        per_bay := public._station_hub_yield(hub)::numeric / bay_cap;
        for bay in select value from jsonb_array_elements(coalesce(st.bays, '[]'::jsonb)) loop
          -- Owner bay: uuid (published) or legacy "player" (pre-publish local key).
          continue when left(coalesce(bay->>'lesseeId', ''), 64)
            not in (uid::text, 'player');
          continue when coalesce((bay->>'npc')::boolean, false);
          ex_id := left(coalesce(bay->>'extractorId', ''), 40);
          ex := case when ex_id <> '' then pstate->'extractors'->ex_id else null end;
          ymult := app._extractor_yield_mult('jack');
          rate_bon := 1.0;
          -- Extractor quality when present; otherwise jack baseline so a missing
          -- publish of extractorId can't leave a staffed hub at 0 hold forever.
          if ex is not null and jsonb_typeof(ex) = 'object' then
            can_prod := case ex->>'type'
              when 'jack' then true
              when 'specialized' then (st.prod_comm = (ex->>'scope'))
              when 'semi' then (select c.cat from market.commodity(st.prod_comm) c)
                              is not distinct from (ex->>'scope')
              else false end;
            continue when not can_prod;
            ymult := app._extractor_yield_mult(ex->>'type');
            comp_n := 0;
            for cuid in select jsonb_array_elements_text(coalesce(ex->'components', '[]'::jsonb)) loop
              comp := pstate->'components'->cuid;
              if comp is null then continue; end if;
              comp_n := comp_n + 1;
              exit when comp_n > 2;
              if comp->>'kind' = 'rate' then
                rate_bon := rate_bon + app._component_amount('rate', comp->>'rarity');
              end if;
            end loop;
          end if;
          bay_out := greatest(0, floor(per_bay * ymult * rate_bon));
          if strike then bay_out := floor(bay_out / 2); end if;
          produced := produced + bay_out;
        end loop;
        if produced > 0 then
          next_h := public._station_hold_add(next_h, comm.id, produced);
        end if;
      end if;
    end if;

    update public.stations set
      standing = stand,
      hold = next_h,
      delivered_cycle = 0,
      upkeep_paid_through = tick_at,
      updated_at = now()
    where system_id = sid;
  end loop;

  pstate := jsonb_set(pstate, '{credits}', to_jsonb(credits));
  perform app._write_state(pstate, now_ms);

  select coalesce(jsonb_agg(jsonb_build_object(
           'system_id', system_id,
           'treasury', floor(treasury),
           'standing', round(standing),
           'hold', hold)), '[]'::jsonb)
    into synced
    from public.stations
   where owner_id = uid and status in ('owned', 'refit');

  return jsonb_build_object('ok', true, 'treasuries', coalesce(synced, '[]'::jsonb), 'credits', credits);
end;
$$;

grant execute on function public.app_station_after_hour(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Settle — orphan bay tax (station no longer owned) → positions, not a ghost.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_settle()
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid     uuid := auth.uid();
  now_ms  bigint := app._now_ms();
  pays    jsonb := '[]'::jsonb;
  items   jsonb;
  cargo   jsonb := '[]'::jsonb;
  holds   jsonb := '{}'::jsonb;
  pstate  jsonb;
  credits double precision;
  row     record;
  taken   bigint;
  deposited boolean;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;

  for row in
    select id, system_id, amount, reason, note
      from public.station_payouts
     where user_id = uid and claimed_at is null
     for update
  loop
    if row.reason in ('sale', 'haul_refund') then
      perform app._credit_user(uid, row.amount, now_ms);
    elsif row.reason = 'refund_owed' then
      taken := app._debit_user(uid, row.amount, now_ms);
      if taken < row.amount then
        if taken > 0 then
          update public.station_payouts
             set amount = row.amount - taken where id = row.id;
        end if;
        continue;
      end if;
    elsif row.reason = 'tariff' then
      update public.stations
         set treasury = treasury + row.amount, updated_at = now()
       where system_id = row.system_id and owner_id = uid;
    end if;
    pays := pays || jsonb_build_array(jsonb_build_object(
      'systemId', row.system_id, 'amount', row.amount, 'reason', row.reason,
      'note', coalesce(row.note, '')));
    update public.station_payouts set claimed_at = now() where id = row.id;
  end loop;

  with back as (
    update public.station_listings
       set status = 'reclaimed', settled_at = now()
     where seller_id = uid
       and (status = 'cancelled' or (status = 'open' and expires_at <= now()))
     returning system_id, kind, name, payload
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'systemId', system_id, 'kind', kind, 'name', name, 'payload', payload)), '[]'::jsonb)
    into items from back;

  for row in
    select id, system_id, comm_id, qty
      from public.station_bay_tax
     where owner_id = uid and claimed_at is null
     for update
  loop
    deposited := false;
    update public.stations
       set hold = public._station_hold_add(hold, row.comm_id, row.qty), updated_at = now()
     where system_id = row.system_id and owner_id = uid;
    if found then
      deposited := true;
      holds := holds || jsonb_build_object(
        row.system_id, (select hold from public.stations where system_id = row.system_id));
    else
      -- Lost the station since tax was queued — residual follows the wallet.
      perform app._credit_positions(uid, row.comm_id, row.qty, now_ms);
    end if;
    update public.station_bay_tax set claimed_at = now() where id = row.id;
    cargo := cargo || jsonb_build_array(jsonb_build_object(
      'systemId', row.system_id, 'commId', row.comm_id, 'qty', row.qty,
      'toPositions', not deposited));
  end loop;

  pstate := app._lock_state(now_ms);
  credits := coalesce((pstate->>'credits')::float8, 0);

  return jsonb_build_object(
    'ok', true, 'payouts', pays, 'items', items, 'cargo', cargo,
    'holds', holds, 'credits', credits,
    'positions', coalesce(pstate->'positions', '{}'::jsonb),
    'avgCost', coalesce(pstate->'avgCost', '{}'::jsonb)
  );
end;
$$;

grant execute on function public.app_station_settle() to authenticated;
