-- Patch: allow signed-in players to dock at claimable system hubs.
-- app_commit protects unlockedSystems, so the client's optimistic station
-- unlock was wiped before app_dock — which then returned "System locked."
--
-- Capitals still require app_unlock. Generated / claimable ids (where
-- app._system_unlock returns null) auto-unlock on dock.
--
-- Prereq: docs/sql/phase1_players.sql (app_dock, app._system_unlock).
-- Safe to re-run. Paste in Supabase SQL Editor.

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
  if dest is null or length(dest) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Unknown system.');
  end if;

  st := app._lock_state(now_ms);
  cur := st->>'currentSystem';
  unlocked := coalesce(st->'unlockedSystems', '[]'::jsonb);

  if not (unlocked ? dest) then
    -- Capitals need app_unlock first. Claimable system hubs auto-unlock on dock.
    if app._system_unlock(dest) is null then
      unlocked := unlocked || jsonb_build_array(dest);
      st := jsonb_set(st, '{unlockedSystems}', unlocked);
    else
      return jsonb_build_object('ok', false, 'error', 'System locked.');
    end if;
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
    'currentSystem', cur, 'credits', (st->>'credits')::float8,
    'unlockedSystems', st->'unlockedSystems'
  );
end;
$$;

grant execute on function public.app_dock(text) to authenticated;
