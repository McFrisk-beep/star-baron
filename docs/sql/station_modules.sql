-- Station module install (docs/STATIONS.md §14.1) — phase D3
-- Requires: station_treasury.sql, station_upkeep.sql (helpers optional).
-- Safe to re-run (create or replace / if not exists).
--
-- Module installs debit players.state credits in-RPC; publish stops overwriting
-- modules / reactor_level from the client. Uninstall refunds 50%, triggers refit.

alter table public.stations
  add column if not exists economy_bootstrapped boolean not null default false;

-- ---------------------------------------------------------------------------
-- Module catalogue — costs mirror js/data.js STATION_MODULES (index = level-1).
-- ---------------------------------------------------------------------------
create or replace function public._station_module_cost(p_module text, p_level int)
returns bigint language sql immutable as $$
  select case left(coalesce(p_module, ''), 40)
    when 'production_hub'  then (array[25000,55000,110000,200000,350000])[greatest(1, least(5, p_level))]
    when 'refinery'        then (array[80000])[greatest(1, least(1, p_level))]
    when 'exchange_hall'   then (array[60000])[1]
    when 'workshop_annex'  then (array[40000,90000,160000])[greatest(1, least(3, p_level))]
    when 'dry_dock'        then (array[45000])[1]
    when 'charter_office'  then (array[40000])[1]
    when 'contract_office' then (array[70000])[1]
    when 'survey_relay'    then (array[55000])[1]
    when 'warehouse'       then (array[30000,50000])[greatest(1, least(2, p_level))]
    when 'customs_house'   then (array[65000])[1]
    when 'free_port'       then (array[65000])[1]
    when 'black_market'    then (array[90000])[1]
    when 'lane_buoy'       then (array[35000])[1]
    when 'reactor'         then (array[40000,90000,160000,280000,450000])[greatest(1, least(5, p_level))]
    else null
  end;
$$;

create or replace function public._station_module_max(p_module text)
returns int language sql immutable as $$
  select case left(coalesce(p_module, ''), 40)
    when 'production_hub' then 5 when 'refinery' then 1 when 'exchange_hall' then 1
    when 'workshop_annex' then 3 when 'dry_dock' then 1 when 'charter_office' then 1
    when 'contract_office' then 1 when 'survey_relay' then 1 when 'warehouse' then 2
    when 'customs_house' then 1 when 'free_port' then 1 when 'black_market' then 1
    when 'lane_buoy' then 1 when 'reactor' then 5
    else 0
  end;
$$;

create or replace function public._station_module_power(p_module text, p_level int)
returns int language sql immutable as $$
  select case left(coalesce(p_module, ''), 40)
    when 'production_hub'  then (array[4,6,8,10,12])[greatest(1, least(5, p_level))]
    when 'refinery'        then 5
    when 'exchange_hall'   then 4
    when 'workshop_annex'  then (array[3,5,7])[greatest(1, least(3, p_level))]
    when 'dry_dock'        then 3
    when 'charter_office'  then 3
    when 'contract_office' then 4
    when 'survey_relay'    then 4
    when 'warehouse'       then (array[2,3])[greatest(1, least(2, p_level))]
    when 'customs_house'   then 3
    when 'free_port'       then 3
    when 'black_market'    then 5
    when 'lane_buoy'       then 2
    when 'reactor'         then 0
    else 0
  end;
$$;

create or replace function public._station_reactor_power(p_level int)
returns int language sql immutable as $$
  select case greatest(0, least(5, coalesce(p_level, 0)))
    when 1 then 2 when 2 then 4 when 3 then 6 when 4 then 8 when 5 then 10 else 0 end;
$$;

create or replace function public._station_power_budget(p_tier text, p_reactor int)
returns int language sql immutable as $$
  select public._station_tier_power(p_tier) + public._station_reactor_power(p_reactor);
$$;

create or replace function public._station_power_used(p_modules jsonb, p_reactor int)
returns int language plpgsql immutable as $$
declare
  m jsonb := coalesce(p_modules, '{}'::jsonb);
  k text;
  lvl int;
  used int := 0;
begin
  for k, lvl in select key, (value#>>'{}')::int from jsonb_each(m) loop
    if k = 'reactor' then continue; end if;
    if lvl > 0 then used := used + public._station_module_power(k, lvl); end if;
  end loop;
  return used;
end;
$$;

create or replace function public._station_module_level(
  p_modules jsonb, p_reactor int, p_module text
) returns int language sql immutable as $$
  select case when left(coalesce(p_module, ''), 40) = 'reactor'
    then greatest(0, least(5, coalesce(p_reactor, 0)))
    else greatest(0, least(public._station_module_max(p_module),
           coalesce((coalesce(p_modules, '{}'::jsonb)->>left(p_module, 40))::int, 0)))
  end;
$$;

-- ---------------------------------------------------------------------------
-- Install — debit wallet, bump module / reactor.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_module_install(p_system text, p_module text)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid      uuid := auth.uid();
  mod      text := left(coalesce(p_module, ''), 40);
  st       public.stations%rowtype;
  now_ms   bigint := app._now_ms();
  pstate   jsonb;
  credits  double precision;
  cur      int;
  nxt      int;
  cost     bigint;
  need_pwr int;
  budget   int;
  used     int;
  rep      jsonb;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_system is null or length(p_system) > 40 then
    return jsonb_build_object('ok', false, 'error', 'No station.');
  end if;
  if public._station_module_max(mod) <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Unknown module.');
  end if;

  select * into st from public.stations where system_id = p_system for update;
  if not found or st.owner_id is distinct from uid or st.status <> 'owned' then
    return jsonb_build_object('ok', false, 'error', 'Not your station.');
  end if;

  cur := public._station_module_level(st.modules, st.reactor_level, mod);
  if cur >= public._station_module_max(mod) then
    return jsonb_build_object('ok', false, 'error', 'Already at max level.');
  end if;
  nxt := cur + 1;
  cost := public._station_module_cost(mod, nxt);
  if cost is null or cost <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Unknown module.');
  end if;

  need_pwr := public._station_module_power(mod, nxt);
  budget := public._station_power_budget(st.tier, st.reactor_level);
  used := public._station_power_used(st.modules, st.reactor_level);
  if mod = 'reactor' then
    budget := budget + public._station_reactor_power(nxt);
  else
    used := used + need_pwr;
  end if;
  if used > budget then
    return jsonb_build_object('ok', false, 'error', 'Not enough power.');
  end if;

  -- Conflicts / requires (mirror STATION_MODULES).
  if mod = 'customs_house' and coalesce((st.modules->>'free_port')::int, 0) > 0 then
    return jsonb_build_object('ok', false, 'error', 'Conflicts with Free Port.');
  end if;
  if mod = 'customs_house' and coalesce((st.modules->>'black_market')::int, 0) > 0 then
    return jsonb_build_object('ok', false, 'error', 'Conflicts with Black Market.');
  end if;
  if mod = 'free_port' and coalesce((st.modules->>'customs_house')::int, 0) > 0 then
    return jsonb_build_object('ok', false, 'error', 'Conflicts with Customs House.');
  end if;
  if mod = 'black_market' and coalesce((st.modules->>'customs_house')::int, 0) > 0 then
    return jsonb_build_object('ok', false, 'error', 'Conflicts with Customs House.');
  end if;
  if mod = 'refinery' and coalesce((st.modules->>'production_hub')::int, 0) < 2 then
    return jsonb_build_object('ok', false, 'error', 'Requires Production Hub II.');
  end if;
  if mod = 'black_market' and coalesce((st.modules->>'exchange_hall')::int, 0) < 1 then
    return jsonb_build_object('ok', false, 'error', 'Requires Exchange Hall.');
  end if;

  pstate := app._lock_state(now_ms);
  credits := coalesce((pstate->>'credits')::float8, 0);
  rep := coalesce(pstate->'reputation', '{}'::jsonb);

  if mod = 'customs_house' then
    if greatest(coalesce((rep->>'mining_combine')::float8, 0),
               coalesce((rep->>'free_trade')::float8, 0),
               coalesce((rep->>'agri_collective')::float8, 0)) < 0 then
      return jsonb_build_object('ok', false, 'error', 'Needs Neutral+ with a lawful faction.');
    end if;
  end if;
  if mod = 'black_market' and coalesce((rep->>'syndicate')::float8, 0) < 25 then
    return jsonb_build_object('ok', false, 'error', 'Needs Syndicate ≥ Friendly.');
  end if;

  if credits < cost then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
  end if;
  credits := credits - cost;
  pstate := jsonb_set(pstate, '{credits}', to_jsonb(credits));
  perform app._write_state(pstate, now_ms);

  if mod = 'reactor' then
    update public.stations set reactor_level = nxt, updated_at = now() where system_id = p_system;
  else
    update public.stations set
      modules = jsonb_set(coalesce(modules, '{}'::jsonb), array[mod], to_jsonb(nxt), true),
      updated_at = now()
    where system_id = p_system;
  end if;

  return jsonb_build_object(
    'ok', true, 'module', mod, 'level', nxt, 'cost', cost, 'credits', credits
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Uninstall — 50% refund, refit downtime, drop dependents.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_module_uninstall(p_system text, p_module text)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid     uuid := auth.uid();
  mod     text := left(coalesce(p_module, ''), 40);
  st      public.stations%rowtype;
  now_ms  bigint := app._now_ms();
  pstate  jsonb;
  credits double precision;
  cur     int;
  refund  bigint := 0;
  i       int;
  refit_ms bigint := 21600000; -- STATIONCFG.refitMs
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_system is null or length(p_system) > 40 then
    return jsonb_build_object('ok', false, 'error', 'No station.');
  end if;

  select * into st from public.stations where system_id = p_system for update;
  if not found or st.owner_id is distinct from uid or st.status <> 'owned' then
    return jsonb_build_object('ok', false, 'error', 'Not your station.');
  end if;

  cur := public._station_module_level(st.modules, st.reactor_level, mod);
  if cur <= 0 then return jsonb_build_object('ok', false, 'error', 'Not installed.'); end if;

  for i in 1..cur loop
    refund := refund + floor(coalesce(public._station_module_cost(mod, i), 0) * 0.5);
  end loop;

  pstate := app._lock_state(now_ms);
  credits := coalesce((pstate->>'credits')::float8, 0) + refund;
  pstate := jsonb_set(pstate, '{credits}', to_jsonb(credits));
  perform app._write_state(pstate, now_ms);

  if mod = 'reactor' then
    update public.stations set reactor_level = 0 where system_id = p_system;
  elsif mod = 'production_hub' then
    update public.stations set
      modules = (coalesce(modules, '{}'::jsonb) - mod - 'refinery'),
      prod_comm = null,
      bays = '[]'::jsonb
    where system_id = p_system;
  else
    update public.stations set modules = coalesce(modules, '{}'::jsonb) - mod where system_id = p_system;
    if coalesce((st.modules->>'production_hub')::int, 0) < 2 then
      update public.stations set modules = modules - 'refinery' where system_id = p_system;
    end if;
  end if;

  update public.stations set
    status = 'refit',
    refit_until = now() + (refit_ms || ' milliseconds')::interval,
    updated_at = now()
  where system_id = p_system;

  return jsonb_build_object('ok', true, 'module', mod, 'refund', refund, 'credits', credits);
end;
$$;

grant execute on function public.app_station_module_install(text, text) to authenticated;
grant execute on function public.app_station_module_uninstall(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Publish — D1 contract stats; preserve server modules/reactor/treasury/hold.
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
          'taxed_at', s_el->'taxed_at'));
      elsif c_lid <> '' and not c_npc and c_lid <> 'npc' then
        if s_lid = c_lid and s_el ? 'taxed_at' and s_el->>'taxed_at' is not null then
          merged := merged || jsonb_build_array(jsonb_build_object(
            'lesseeId', c_lid, 'npc', false, 'taxed_at', s_el->'taxed_at'));
        else
          merged := merged || jsonb_build_array(jsonb_build_object(
            'lesseeId', c_lid, 'npc', false));
        end if;
      else
        merged := merged || jsonb_build_array(jsonb_build_object(
          'lesseeId', '', 'npc', false));
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

  update public.stations
     set owner_id = null, owner_display = null, status = 'npc',
         treasury = 0, hold = '{}'::jsonb,
         hall = '[]'::jsonb, bays = '[]'::jsonb, updated_at = now()
   where owner_id = uid
     and not (system_id = any(kept));

  select array_agg(system_id) into conflicts
    from public.stations
   where system_id = any(kept) and owner_id is distinct from uid;

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

-- app_station_buy_refund lives in station_treasury.sql (D0) next to
-- app_station_buy_item — do not redefine it here.
