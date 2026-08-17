-- impound_retrieve.sql — server-authoritative impound retrieval (Critical C3).
--
-- Without this RPC, a signed-in player's Fleet.retrieve() was a pure LOCAL
-- mutation: app_commit forces `ships` from the server row, so the hull re-showed
-- as impounded on the very next slice while the credit spend (a decrease) stuck.
-- The result was a money black hole — pay the 1,500c fine again and again — plus
-- a permanently unusable hull, since the server's idle checks reject launches.
--
-- This mirrors app_repair_ship (docs/sql/repair_equip.sql) exactly: lock the
-- state, read the SERVER's stored retrieveCost (never the client's), debit, and
-- flip status idle. The client keeps a graceful local fallback until this runs.
--
-- Apply any time after phase1_players.sql (needs app._lock_state / app._write_state
-- / app.result_slice). Safe to re-run.

create or replace function public.app_retrieve_ship(p_uid text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms  bigint := app._now_ms();
  st      jsonb;
  ships   jsonb;
  sh      jsonb;
  cost    double precision;
  credits double precision;
begin
  st := app._lock_state(now_ms);
  ships := coalesce(st->'ships', '[]'::jsonb);
  select value into sh from jsonb_array_elements(ships) x(value)
    where x.value->>'uid' = p_uid limit 1;
  if sh is null then
    return jsonb_build_object('ok', false, 'error', 'Ship not found.');
  end if;
  if sh->>'status' is distinct from 'impounded' then
    return jsonb_build_object('ok', false, 'error', 'Nothing to retrieve.');
  end if;
  -- The fine is whatever the server stamped when the ship was impounded
  -- (app_mission_resolve / incidents); the client value is display-only.
  cost := greatest(0, coalesce((sh->>'retrieveCost')::float8, 0));
  credits := coalesce((st->>'credits')::float8, 0);
  if cost > credits then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
  end if;

  ships := (
    select coalesce(jsonb_agg(
      case when x.value->>'uid' = p_uid
        then jsonb_set(jsonb_set(x.value, '{status}', '"idle"'::jsonb),
                       '{retrieveCost}', to_jsonb(0::float8))
        else x.value end), '[]'::jsonb)
    from jsonb_array_elements(ships) x(value)
  );
  st := jsonb_set(st, '{credits}', to_jsonb(credits - cost));
  st := jsonb_set(st, '{ships}', ships);
  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('cost', cost);
end;
$$;

grant execute on function public.app_retrieve_ship(text) to authenticated;
