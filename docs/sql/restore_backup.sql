-- restore_backup.sql — Settings → Restore backup for signed-in players.
--
-- app_commit deliberately protects credits / positions / ships / items, so a
-- Store.flush of a richer wiped-save backup is theatre: the cloud row wins on
-- reload. This RPC replaces those protected slices from a migrated backup.
--
-- Trust model: the caller already owns the players row. This is a recovery
-- tool for the corrupt-save / wipe path — same surface as app_reset_save, but
-- writing the backup instead of defaults. Caps reject absurd forged blobs.
--
-- Prereq: docs/sql/phase1_players.sql (app._lock_state / app._write_state /
--         app._now_ms / app._default_state). Safe to re-run.

create or replace function public.app_restore_backup(p_state jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid uuid := auth.uid();
  now_ms bigint := app._now_ms();
  st jsonb;
  src jsonb := coalesce(p_state, '{}'::jsonb);
  credits double precision;
  ships jsonb;
  positions jsonb;
  avg_cost jsonb;
  items jsonb;
  inventory jsonb;
  extractors jsonb;
  components jsonb;
  main_ship jsonb;
  n int;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if jsonb_typeof(src) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'backup must be an object');
  end if;

  st := app._lock_state(now_ms);

  -- Credits: finite, non-negative, hard cap against forged infinity.
  credits := coalesce((src->>'credits')::float8, 0);
  if credits <> credits or credits < 0 then credits := 0; end if;
  credits := least(credits, 1e15);
  st := jsonb_set(st, '{credits}', to_jsonb(credits));

  -- Positions / avgCost — object maps of commodity → number.
  positions := case when jsonb_typeof(src->'positions') = 'object' then src->'positions' else '{}'::jsonb end;
  avg_cost := case when jsonb_typeof(src->'avgCost') = 'object' then src->'avgCost' else '{}'::jsonb end;
  -- Drop non-finite / negative entries; cap map size.
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into positions
    from (
      select left(key, 40) as k, least(1e12, greatest(0, (value::text)::float8)) as v
        from jsonb_each(positions)
       where jsonb_typeof(value) = 'number'
         and (value::text)::float8 = (value::text)::float8
       limit 80
    ) q;
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into avg_cost
    from (
      select left(key, 40) as k, least(1e12, greatest(0, (value::text)::float8)) as v
        from jsonb_each(avg_cost)
       where jsonb_typeof(value) = 'number'
         and (value::text)::float8 = (value::text)::float8
       limit 80
    ) q;
  st := jsonb_set(st, '{positions}', coalesce(positions, '{}'::jsonb));
  st := jsonb_set(st, '{avgCost}', coalesce(avg_cost, '{}'::jsonb));

  -- Ships — array, capped; keep objects only.
  ships := case when jsonb_typeof(src->'ships') = 'array' then src->'ships' else '[]'::jsonb end;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into ships
    from (
      select x from jsonb_array_elements(ships) x
       where jsonb_typeof(x) = 'object'
       limit 40
    ) q;
  st := jsonb_set(st, '{ships}', coalesce(ships, '[]'::jsonb));

  main_ship := case when jsonb_typeof(src->'mainShip') = 'object' then src->'mainShip' else '{}'::jsonb end;
  st := jsonb_set(st, '{mainShip}', main_ship);

  items := case when jsonb_typeof(src->'items') = 'object' then src->'items' else '{}'::jsonb end;
  select coalesce(jsonb_object_agg(left(key, 40), value), '{}'::jsonb) into items
    from (
      select key, value from jsonb_each(items)
       where jsonb_typeof(value) = 'object'
       limit 200
    ) q;
  st := jsonb_set(st, '{items}', coalesce(items, '{}'::jsonb));

  inventory := case when jsonb_typeof(src->'inventory') = 'object' then src->'inventory' else '{}'::jsonb end;
  st := jsonb_set(st, '{inventory}', inventory);

  extractors := case when jsonb_typeof(src->'extractors') = 'object' then src->'extractors' else '{}'::jsonb end;
  select coalesce(jsonb_object_agg(left(key, 40), value), '{}'::jsonb) into extractors
    from (
      select key, value from jsonb_each(extractors)
       where jsonb_typeof(value) = 'object'
       limit 80
    ) q;
  st := jsonb_set(st, '{extractors}', coalesce(extractors, '{}'::jsonb));

  components := case when jsonb_typeof(src->'components') = 'object' then src->'components' else '{}'::jsonb end;
  select coalesce(jsonb_object_agg(left(key, 40), value), '{}'::jsonb) into components
    from (
      select key, value from jsonb_each(components)
       where jsonb_typeof(value) = 'object'
       limit 120
    ) q;
  st := jsonb_set(st, '{components}', coalesce(components, '{}'::jsonb));

  -- Client-owned slices the wipe also needs: workshop / recipes / story bits.
  if jsonb_typeof(src->'workshop') = 'object' then
    st := jsonb_set(st, '{workshop}', src->'workshop');
  end if;
  if jsonb_typeof(src->'knownRecipes') = 'array' then
    st := jsonb_set(st, '{knownRecipes}', src->'knownRecipes');
  end if;
  if jsonb_typeof(src->'craftedOnce') = 'array' then
    st := jsonb_set(st, '{craftedOnce}', src->'craftedOnce');
  end if;

  st := jsonb_set(st, '{lastSeenAt}', to_jsonb(now_ms));
  perform app._write_state(st, now_ms);

  return jsonb_build_object('ok', true, 'state', st);
end;
$$;

revoke execute on function public.app_restore_backup(jsonb) from public;
revoke execute on function public.app_restore_backup(jsonb) from anon;
grant execute on function public.app_restore_backup(jsonb) to authenticated;
