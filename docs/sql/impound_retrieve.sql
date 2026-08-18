-- impound_retrieve.sql — server-authoritative impound retrieval + abandonment.
--
-- Without app_retrieve_ship, a signed-in player's Fleet.retrieve() was a pure
-- LOCAL mutation: app_commit forces `ships` from the server row, so the hull
-- re-showed as impounded on the very next slice while the credit spend (a
-- decrease) stuck. The result was a money black hole — pay the fine again and
-- again — plus a permanently unusable hull, since the server's idle checks
-- reject launches. (Critical C3.)
--
-- Release fee: half the VESSEL's value — hull price plus everything bolted to
-- it (equipped accessories) — floored at 600c. Computed here from the server's
-- own catalog + items pool at retrieve time; any retrieveCost stamped on the
-- row (older SQL stamped 1500) is display-legacy and ignored. The client
-- mirrors this formula in Fleet.impoundFine for the card + guest fallback.
--
-- app_abandon_ship is the other door out: forfeit the hull — and its fitted
-- gear, the lot holds the whole vessel — forever, for free.
--
-- Because the fee includes fitted gear, app_unequip_item is re-defined here to
-- refuse impounded hulls (repair_equip.sql's version predates the fee and lets
-- anyone strip a hull in the lot, dodging most of the fine). Both files now
-- carry the same gate, so re-running either is safe.
--
-- Apply after phase2_missions_bazaar.sql (needs app.ship_def / app.item_value
-- plus app._lock_state / app._write_state / app.result_slice). Safe to re-run.

-- Half of (hull price + equipped gear value), floored at 600c.
create or replace function app._impound_fine(p_state jsonb, p_ship jsonb)
returns double precision
language sql stable as $$
  select greatest(600.0, round(0.5 * (
    coalesce((select d.price from app.ship_def(p_ship->>'type') d), 0)
    + coalesce((
        select sum(app.item_value(coalesce(p_state->'items', '{}'::jsonb) -> u.value))
        from jsonb_array_elements_text(
          case when jsonb_typeof(p_ship->'accessories') = 'array'
               then p_ship->'accessories' else '[]'::jsonb end
        ) u(value)
      ), 0)
  )));
$$;

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
  cost := app._impound_fine(st, sh);
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

-- Walk away: the hull — and everything fitted to it — is forfeit, forever.
create or replace function public.app_abandon_ship(p_uid text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st     jsonb;
  ships  jsonb;
  sh     jsonb;
  items  jsonb;
  uid    text;
begin
  st := app._lock_state(now_ms);
  ships := coalesce(st->'ships', '[]'::jsonb);
  select value into sh from jsonb_array_elements(ships) x(value)
    where x.value->>'uid' = p_uid limit 1;
  if sh is null then
    return jsonb_build_object('ok', false, 'error', 'Ship not found.');
  end if;
  if sh->>'status' is distinct from 'impounded' then
    return jsonb_build_object('ok', false, 'error', 'Only an impounded ship can be abandoned.');
  end if;

  -- Fitted gear goes down with the hull (otherwise it would orphan back into
  -- the player's inventory and gut the "abandon forfeits everything" trade).
  items := coalesce(st->'items', '{}'::jsonb);
  for uid in select jsonb_array_elements_text(
    case when jsonb_typeof(sh->'accessories') = 'array'
         then sh->'accessories' else '[]'::jsonb end
  ) loop
    items := items - uid;
  end loop;

  ships := (
    select coalesce(jsonb_agg(x.value), '[]'::jsonb)
    from jsonb_array_elements(ships) x(value)
    where x.value->>'uid' <> p_uid
  );
  st := jsonb_set(st, '{ships}', ships);
  st := jsonb_set(st, '{items}', items);
  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('abandoned', p_uid);
end;
$$;

-- Same as repair_equip.sql's version PLUS the impound gate: the lot holds the
-- whole vessel, so gear can't be stripped to shrink the release fee.
create or replace function public.app_unequip_item(p_ship_uid text, p_item_uid text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  ships jsonb;
  sh jsonb;
begin
  st := app._lock_state(now_ms);
  ships := coalesce(st->'ships', '[]'::jsonb);
  select value into sh from jsonb_array_elements(ships) x(value)
    where x.value->>'uid' = p_ship_uid limit 1;
  if sh is null then
    return jsonb_build_object('ok', false, 'error', 'Not found.');
  end if;
  if sh->>'status' = 'impounded' then
    return jsonb_build_object('ok', false, 'error', 'The impound lot holds the whole vessel — gear included.');
  end if;
  ships := (
    select coalesce(jsonb_agg(
      case when x.value->>'uid' = p_ship_uid then jsonb_set(x.value, '{accessories}', (
        select coalesce(jsonb_agg(u.value), '[]'::jsonb)
        from jsonb_array_elements(
          case when jsonb_typeof(x.value->'accessories') = 'array' then x.value->'accessories' else '[]'::jsonb end
        ) u(value)
        where u.value <> to_jsonb(p_item_uid)
      )) else x.value end), '[]'::jsonb)
    from jsonb_array_elements(ships) x(value)
  );
  st := jsonb_set(st, '{ships}', ships);
  perform app._write_state(st, now_ms);
  return app.result_slice(st);
end;
$$;

grant execute on function public.app_retrieve_ship(text) to authenticated;
grant execute on function public.app_abandon_ship(text) to authenticated;
grant execute on function public.app_unequip_item(text, text) to authenticated;
