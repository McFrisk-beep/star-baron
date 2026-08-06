-- Station standing + upkeep (docs/STATIONS.md §14.1) — phase D2
-- Requires: station_treasury.sql (treasury, app._credit_user, app._lock_state),
--           station_bays.sql (_station_bay_count), station_contracts.sql
--           (_station_hold_add — production deposits into hold here).
-- Safe to re-run (create or replace / if not exists).
--
-- Phase D0 made treasury authoritative; standing and upkeep were still client-side.
-- This paste moves the hourly standing/upkeep cycle server-side for published
-- stations: standing uses server-tracked delivered_cycle (from deliver/haul
-- settle), not client report fields; upkeep debits treasury/wallet; customs
-- subsidies credit; baseline Production Hub output deposits into stations.hold.
-- Revolt rolls stay client-side for now.

alter table public.stations
  add column if not exists delivered_cycle int not null default 0;

-- ---------------------------------------------------------------------------
-- Tier / upkeep helpers — mirror js/data.js STATION_TIERS + STATIONCFG.
-- ---------------------------------------------------------------------------
create or replace function public._station_tier_upkeep(p_tier text)
returns int language sql immutable as $$
  select case coalesce(nullif(trim(p_tier), ''), 'Berth')
    when 'Relay'      then 1600
    when 'Waystation' then 3000
    when 'Dock'       then 5200
    when 'Outpost'    then 8500
    when 'Anchorage'  then 13000
    when 'Station'    then 13000
    when 'Spire'      then 13000
    when 'Platform'   then 13000
    else 800
  end;
$$;

create or replace function public._station_tier_rank(p_tier text)
returns int language sql immutable as $$
  select case coalesce(nullif(trim(p_tier), ''), 'Berth')
    when 'Relay'      then 1
    when 'Waystation' then 2
    when 'Dock'       then 3
    when 'Outpost'    then 4
    when 'Anchorage'  then 5
    when 'Station'    then 5
    when 'Spire'      then 5
    when 'Platform'   then 5
    else 0
  end;
$$;

create or replace function public._station_tier_power(p_tier text)
returns int language sql immutable as $$
  select case coalesce(nullif(trim(p_tier), ''), 'Berth')
    when 'Relay'      then 5
    when 'Waystation' then 7
    when 'Dock'       then 9
    when 'Outpost'    then 12
    when 'Anchorage'  then 15
    when 'Station'    then 15
    when 'Spire'      then 15
    when 'Platform'   then 15
    else 3
  end;
$$;

create or replace function public._station_upkeep_per_cycle(
  p_tier text, p_reactor int, p_modules jsonb
) returns bigint language sql immutable as $$
  with mods as (
    select coalesce(p_modules, '{}'::jsonb) m,
           greatest(0, least(5, coalesce(p_reactor, 0))) rl,
           greatest(0, least(5, coalesce((coalesce(p_modules, '{}'::jsonb)->>'production_hub')::int, 0))) hub,
           greatest(0, least(3, coalesce((coalesce(p_modules, '{}'::jsonb)->>'workshop_annex')::int, 0))) ws
  )
  select public._station_tier_upkeep(p_tier)::bigint
       + case mods.rl when 1 then 1200 when 2 then 3000 when 3 then 6000 when 4 then 11000 when 5 then 18000 else 0 end
       + case mods.hub when 1 then 900 when 2 then 1800 when 3 then 3200 when 4 then 5000 when 5 then 7500 else 0 end
       + case mods.ws when 1 then 1000 when 2 then 2200 when 3 then 4000 else 0 end
  from mods;
$$;

create or replace function public._station_owner_staffed(p_bays jsonb, p_owner uuid)
returns int language sql immutable as $$
  select coalesce(count(*)::int, 0)
  from jsonb_array_elements(coalesce(p_bays, '[]'::jsonb)) b
  where left(coalesce(b->>'lesseeId', ''), 64) = p_owner::text
    and not coalesce((b->>'npc')::boolean, false);
$$;

-- Hub total yield (mirrors STATIONCFG.prodHub). Per-bay = yield / bay_count.
create or replace function public._station_hub_yield(p_hub int)
returns int language sql immutable as $$
  select case greatest(0, least(5, coalesce(p_hub, 0)))
    when 1 then 60 when 2 then 140 when 3 then 260 when 4 then 420 when 5 then 640
    else 0 end;
$$;

-- ---------------------------------------------------------------------------
-- After stock hour: standing + upkeep for the caller's published stations.
-- p_reports: [{ "system_id": "..." }, ...] — delivered/expected ignored.
-- Standing uses stations.delivered_cycle (bumped by deliver/haul success).
-- Also deposits baseline Production Hub output into stations.hold so the
-- Contract Office escrow grows without a client-trusted deposit RPC.
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

    -- Idempotent: at most one server tick per stock hour.
    if st.upkeep_paid_through is not null and st.upkeep_paid_through >= tick_at then
      continue;
    end if;

    -- Strike uses standing *before* this hour's delivery deltas (client
    -- produces in npcProduceHour before afterStockHour updates standing).
    strike := coalesce(st.standing, 60) < 20;

    hub := greatest(0, coalesce((st.modules->>'production_hub')::int, 0));
    staffed := public._station_owner_staffed(st.bays, uid);
    bay_n := greatest(1, coalesce(jsonb_array_length(st.bays), 0));
    staff_fac := greatest(0.35, staffed::numeric / bay_n);
    -- Mirror STATIONCFG.expectedDeliveryBase × hub × tier × staffFactor.
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

    -- Baseline Production Hub output → hold (jack yield; no client quantity).
    next_h := coalesce(st.hold, '{}'::jsonb);
    produced := 0;
    if hub > 0 and staffed > 0 and coalesce(nullif(trim(st.prod_comm), ''), '') <> '' then
      select * into comm from market.commodity(left(st.prod_comm, 40));
      if comm.id is not null and not coalesce(comm.craft_only, false) then
        bay_cap := greatest(1, public._station_bay_count(st.modules));
        per_bay := public._station_hub_yield(hub)::numeric / bay_cap;
        produced := greatest(0, floor(per_bay * staffed));
        if strike then produced := floor(produced / 2); end if;
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
