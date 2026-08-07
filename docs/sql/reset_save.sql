-- reset_save.sql — Settings → Reset Save for signed-in players.
-- Replaces the caller's players.state with app._default_state(), keeping only
-- cosmetic settings (mute / language / reduced-motion). Credits, fleet, cargo,
-- unlocks, prestige, etc. all wipe. Idempotent — safe to re-run.
--
-- Prereq: docs/sql/phase1_players.sql (app._default_state, app._lock_state,
--         app._write_state, app._now_ms).
-- Apply: paste into the Supabase SQL editor and run once.
--
-- Why an RPC: players has no client DELETE/UPDATE RLS (by design). Store.clear()
-- only wiped the legacy `saves` row, so Reset Save bounced back on bootstrap.

create or replace function public.app_reset_save()
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid uuid := auth.uid();
  now_ms bigint := app._now_ms();
  st jsonb;
  keep_settings jsonb;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select state into st from public.players where user_id = uid for update;
  if st is null then
    -- No row yet — next bootstrap creates a fresh default. Nothing to wipe.
    return jsonb_build_object('ok', true, 'state', app._default_state());
  end if;

  keep_settings := case
    when jsonb_typeof(st->'settings') = 'object' then st->'settings'
    else null
  end;

  st := app._default_state();
  if keep_settings is not null then
    st := jsonb_set(st, '{settings}', keep_settings);
  end if;
  st := jsonb_set(st, '{lastSeenAt}', to_jsonb(now_ms));

  update public.players set state = st, updated_at = now() where user_id = uid;
  return jsonb_build_object('ok', true, 'state', st);
end;
$$;

revoke execute on function public.app_reset_save() from public;
revoke execute on function public.app_reset_save() from anon;
grant execute on function public.app_reset_save() to authenticated;
