-- publish_keep_won_stations.sql — stop the publish sweep from releasing a won
-- station (Critical C1).
--
-- THE BUG: app_station_close_due can transfer a matured auction's station to the
-- winner while ANY other authenticated client runs the hourly close — and only
-- that caller receives the `closed` result. The winner (offline at close) never
-- hears about the win, so their local save doesn't list the station. On their
-- next login, syncStations → publishOwned() sends only the stations they locally
-- hold, and this function's trailing "dropped stations" sweep then released every
-- station owned server-side but absent from that list — including the just-won
-- one. Bid credits were already sunk (winners get no refund), the station snapped
-- back to NPC, and NOT ONE error surfaced anywhere.
--
-- THE FIX: remove the automatic release sweep. It was only ever a catch-all for
-- "stations I silently stopped listing" — but every INTENTIONAL way to give up a
-- station already clears ownership server-side on its own:
--   • relinquish  → app_station_release (sets npc/cooldown, zeroes treasury/hold)
--   • revolt/loss → the world cron / auction close
-- A station dropped from publish without one of those keeps owner_id = uid, so it
-- is not up for grabs and its wealth can't be inherited (the inheritance the
-- sweep guarded against is already handled where ownership actually changes).
-- The worst case the sweep now stops covering — a briefly orphaned claim after a
-- genuine desync — is self-healing and far milder than losing a paid-for station.
--
-- This is the currently-deployed app_station_publish body with ONLY the trailing
-- release UPDATE removed; everything else (bay merge, wealth guards, conflict
-- report, treasury sync) is unchanged. SQL-only, no client change required.
--
-- APPLY LAST — after station_treasury.sql / station_economy_trust.sql /
-- station_modules.sql / station_contracts.sql so this definition wins.

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

  -- CRITICAL C1: the "dropped stations" release sweep was removed here. It used
  -- to run
  --   update public.stations set owner_id = null, status = 'npc', ...
  --    where owner_id = uid and not (system_id = any(kept));
  -- which released an auction win the winner hadn't synced yet. Intentional
  -- give-ups already clear ownership themselves (app_station_release / auction /
  -- revolt), so publish no longer needs — and must not — auto-release.

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
