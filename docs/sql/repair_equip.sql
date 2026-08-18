-- ===========================================================================
-- repair_equip.sql — make REPAIR and EQUIP server-authoritative actions.
--
-- Why this file exists (read before "simplifying" it away):
--
-- Repairing a hull and equipping an accessory were the last two economy
-- actions with NO RPC — the client mutated `state.ships` and hoped autosave
-- carried it. It cannot, by design:
--
--   * app_commit owns the ship roster. app._merge_ships (equip_persist.sql)
--     keeps every SERVER field of a ship — uid/type/name/status/DMG/… — and
--     takes only `accessories` from the client. So a local repair debited the
--     player's credits (app_commit accepts a LOWER client balance) and then
--     handed the damage straight back on the next autosave. The player paid
--     and stayed broken.
--   * The fitment merge validates each accessory uid against the SERVER items
--     pool, so gear the server has never seen (crafted while
--     docs/sql/workshop_craft.sql wasn't applied, or granted by a local-only
--     drop) is silently dropped from the ship on commit — the equip "worked"
--     until the next save, then popped off.
--
-- Both are now explicit RPCs that mutate the authoritative row directly, so
-- they no longer depend on what a later app_commit chooses to keep. An action
-- that the server refuses now says so out loud instead of quietly reverting.
--
-- app._merge_ships stays exactly as-is: it is still what carries fitment for
-- clients that equip while offline, and it is the belt to this file's braces.
--
-- APPLY ORDER (each file replaces functions from the previous one):
--   1. docs/sql/phase1_players.sql
--   2. docs/sql/phase2_missions_bazaar.sql  (+ phase2b / phase2c)
--   3. docs/sql/phase3_pull_prestige.sql
--   4. docs/sql/equip_persist.sql      ← defines app._ship_slots / _merge_ships
--   5. docs/sql/workshop_craft.sql
--   6. docs/sql/repair_equip.sql       ← THIS FILE (needs 4 and 5)
--   7. docs/sql/charter_rpcs.sql       (re-declares app_commit; keeps the merge)
--
-- Safe to re-run (all create-or-replace). Paste the whole file into the
-- Supabase SQL editor.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- app_repair_ship(uid) → result_slice + { cost }
-- Mirrors Fleet.repairCost in js/fleet.js:
--   cost = max(50, round(price × DMGCFG.costRate × dmg))   (costRate = 0.35)
-- The price and the damage both come from the server row, so the bill cannot
-- be talked down by the client.
-- ---------------------------------------------------------------------------
create or replace function public.app_repair_ship(p_uid text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  ships jsonb;
  sh jsonb;
  def record;
  dmg double precision;
  cost double precision;
  credits double precision;
begin
  st := app._lock_state(now_ms);
  ships := coalesce(st->'ships', '[]'::jsonb);
  select value into sh from jsonb_array_elements(ships) x(value)
    where x.value->>'uid' = p_uid limit 1;
  if sh is null then
    return jsonb_build_object('ok', false, 'error', 'Ship not found.');
  end if;
  if sh->>'status' is distinct from 'idle' then
    return jsonb_build_object('ok', false, 'error', 'Ship is busy — repairs need a drydock.');
  end if;
  dmg := coalesce((sh->>'dmg')::float8, 0);
  if dmg <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Nothing to repair.');
  end if;

  select * into def from app.ship_def(sh->>'type');
  -- A hull the server catalog doesn't know still repairs, at the client's
  -- 2000c stand-in price — never free, never an error.
  cost := greatest(50, round((case when coalesce(def.price, 0) > 0 then def.price else 2000 end
                              * 0.35 * dmg)::numeric));
  credits := coalesce((st->>'credits')::float8, 0);
  if cost > credits then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
  end if;

  ships := (
    select coalesce(jsonb_agg(
      case when x.value->>'uid' = p_uid then jsonb_set(x.value, '{dmg}', to_jsonb(0::float8))
           else x.value end), '[]'::jsonb)
    from jsonb_array_elements(ships) x(value)
  );
  st := jsonb_set(st, '{credits}', to_jsonb(credits - cost));
  st := jsonb_set(st, '{ships}', ships);
  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('cost', cost);
end;
$$;

-- ---------------------------------------------------------------------------
-- app_equip_item(ship_uid, item_uid) → result_slice
-- Same rules the client enforces in Fleet.equip, re-checked against the
-- authoritative row: the item must be owned, must not be a consumable
-- blackbox, must not already be fitted to another hull (no cloning one item
-- across the fleet), the ship must be idle, and the hull must have a free slot.
-- ---------------------------------------------------------------------------
create or replace function public.app_equip_item(p_ship_uid text, p_item_uid text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  ships jsonb;
  sh jsonb;
  it jsonb;
  acc jsonb;
  slots int;
  fitted_elsewhere boolean;
begin
  st := app._lock_state(now_ms);
  ships := coalesce(st->'ships', '[]'::jsonb);
  select value into sh from jsonb_array_elements(ships) x(value)
    where x.value->>'uid' = p_ship_uid limit 1;
  if sh is null then
    return jsonb_build_object('ok', false, 'error', 'Not found.');
  end if;
  it := coalesce(st->'items', '{}'::jsonb) -> p_item_uid;
  if it is null or it = 'null'::jsonb then
    -- The usual cause is gear that only ever existed on the client (a craft
    -- that never reached the server). Say so — silently dropping it on the
    -- next commit is what this file exists to stop.
    return jsonb_build_object('ok', false, 'error',
      'That item isn''t on your server ledger yet — reload and try again.');
  end if;
  if coalesce((it->>'consumable')::boolean, false) or it->>'kind' = 'blackbox' then
    return jsonb_build_object('ok', false, 'error', 'Blackboxes are used from Inventory, not equipped.');
  end if;
  if sh->>'status' is distinct from 'idle' then
    return jsonb_build_object('ok', false, 'error', 'Ship is busy.');
  end if;

  select exists (
    select 1 from jsonb_array_elements(ships) x(value)
    where x.value->'accessories' ? p_item_uid
  ) into fitted_elsewhere;
  if fitted_elsewhere then
    return jsonb_build_object('ok', false, 'error', 'Already fitted to a ship.');
  end if;

  acc := case when jsonb_typeof(sh->'accessories') = 'array' then sh->'accessories' else '[]'::jsonb end;
  slots := app._ship_slots(sh->>'type');
  if jsonb_array_length(acc) >= slots then
    return jsonb_build_object('ok', false, 'error', 'No free slots.');
  end if;

  ships := (
    select coalesce(jsonb_agg(
      case when x.value->>'uid' = p_ship_uid
        then jsonb_set(x.value, '{accessories}', acc || jsonb_build_array(to_jsonb(p_item_uid)))
        else x.value end), '[]'::jsonb)
    from jsonb_array_elements(ships) x(value)
  );
  st := jsonb_set(st, '{ships}', ships);
  perform app._write_state(st, now_ms);
  return app.result_slice(st);
end;
$$;

-- ---------------------------------------------------------------------------
-- app_unequip_item(ship_uid, item_uid) → result_slice
-- Succeeds for any ship the server knows EXCEPT an impounded one: the release
-- fee is half of hull + fitted gear (docs/sql/impound_retrieve.sql), so
-- stripping a hull in the lot would dodge most of the fine. Otherwise ungated —
-- removing gear can only ever weaken you. An unknown uid is a no-op write,
-- which is what makes a double-click harmless.
-- ---------------------------------------------------------------------------
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

grant execute on function public.app_repair_ship(text) to authenticated;
grant execute on function public.app_equip_item(text, text) to authenticated;
grant execute on function public.app_unequip_item(text, text) to authenticated;
