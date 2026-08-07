-- reset_save.sql — the two server-side wipes for signed-in players:
--   app_reset_save()        Settings → Reset Save (this player, on demand)
--   app_world_reset_apply() Admin → Issue Global Reset (this player, once per epoch)
--
-- Both replace the caller's players.state with app._default_state(), keeping
-- only cosmetic settings (mute / language / reduced-motion) — and, for the
-- global reset, the shared senate. Credits, fleet, cargo, unlocks, prestige,
-- etc. all wipe. Idempotent — safe to re-run.
--
-- Reset Save also snapshots the pre-wipe row into players.restore_snapshot
-- when that column exists (added by docs/sql/restore_backup.sql) so
-- app_restore_backup() can undo without taking economy values from the client.
-- Paste restore_backup.sql AFTER this file — it redefines app_reset_save with
-- the snapshot wired in. This copy is defensive if the column isn't there yet.
--
-- Prereq: docs/sql/phase1_players.sql (app._default_state, app._lock_state,
--         app._write_state, app._now_ms). app_world_reset_apply also reads
--         public.world_reset (docs/ADMIN_SETUP.md) — missing table = no-op.
-- Apply: paste into the Supabase SQL editor and run once.
--
-- Why RPCs: players has no client DELETE/UPDATE RLS (by design), and app_commit
-- deliberately protects credits/positions/ships/items/prestige — so NO client
-- wipe can reach the authoritative row. Store.clear() only wiped the legacy
-- `saves` row (Reset Save bounced back on bootstrap), and the global reset
-- pushed its fresh state through app_commit, which stamped appliedResetEpoch
-- and echoed every protected slice straight back: the reset silently no-opped.

-- appliedResetEpoch, defensively. A save that predates the field (or carries a
-- forged non-numeric one) reads as 0 instead of raising on the cast.
create or replace function app._applied_epoch(p_state jsonb)
returns bigint
language sql immutable as $$
  select case
    when coalesce(p_state->>'appliedResetEpoch', '') ~ '^[0-9]+$'
      then (p_state->>'appliedResetEpoch')::bigint
    else 0
  end;
$$;

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
  keep_epoch bigint;
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
  -- Carry the applied global-reset epoch over the wipe. _default_state() has 0,
  -- which would make the next boot re-run the admin reset (popup and all) for a
  -- player who just wiped themselves.
  keep_epoch := app._applied_epoch(st);

  -- Snapshot pre-wipe state when restore_backup.sql has added the column.
  begin
    update public.players set restore_snapshot = st where user_id = uid;
  exception when undefined_column then
    null; -- paste docs/sql/restore_backup.sql for undo support
  end;

  st := app._default_state();
  if keep_settings is not null then
    st := jsonb_set(st, '{settings}', keep_settings);
  end if;
  st := jsonb_set(st, '{appliedResetEpoch}', to_jsonb(keep_epoch));
  st := jsonb_set(st, '{lastSeenAt}', to_jsonb(now_ms));

  update public.players set state = st, updated_at = now() where user_id = uid;
  return jsonb_build_object('ok', true, 'state', st);
end;
$$;

revoke execute on function public.app_reset_save() from public;
revoke execute on function public.app_reset_save() from anon;
grant execute on function public.app_reset_save() to authenticated;

-- ---------------------------------------------------------------------------
-- app_world_reset_apply() — consume the admin-issued global reset, server-side.
--
-- The epoch is read HERE, from public.world_reset, not taken from the caller:
-- a client-supplied epoch would let a player stamp themselves immune to every
-- future reset. Returns { ok, applied, epoch, state }; applied=false means the
-- caller was already at (or past) the current epoch and nothing was touched.
-- ---------------------------------------------------------------------------
create or replace function public.app_world_reset_apply()
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid uuid := auth.uid();
  now_ms bigint := app._now_ms();
  st jsonb;
  world_epoch bigint := 0;
  seen_epoch bigint := 0;
  keep_settings jsonb;
  keep_senate jsonb;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  -- world_reset is optional (docs/ADMIN_SETUP.md) — no table means no resets.
  begin
    select coalesce(w.epoch, 0) into world_epoch from public.world_reset w where w.id = 1;
  exception when undefined_table then
    world_epoch := 0;
  end;
  world_epoch := coalesce(world_epoch, 0);

  select state into st from public.players where user_id = uid for update;
  if st is null then
    -- No row yet — app_bootstrap will mint a default stamped by the client.
    return jsonb_build_object('ok', true, 'applied', false, 'epoch', world_epoch, 'state', null);
  end if;

  seen_epoch := app._applied_epoch(st);
  if world_epoch <= seen_epoch then
    return jsonb_build_object('ok', true, 'applied', false, 'epoch', world_epoch, 'state', st);
  end if;

  keep_settings := case
    when jsonb_typeof(st->'settings') = 'object' then st->'settings'
    else null
  end;
  -- The senate is galaxy-wide legislation, not player progress — it survives.
  keep_senate := st->'senate';

  st := app._default_state();
  -- Matches Game.applyAdminReset: a global reset hands out a 5,000c stake.
  st := jsonb_set(st, '{credits}', to_jsonb(5000));
  st := jsonb_set(st, '{stats,peakNetWorth}', to_jsonb(5000));
  if keep_settings is not null then
    st := jsonb_set(st, '{settings}', keep_settings);
  end if;
  if keep_senate is not null then
    st := jsonb_set(st, '{senate}', keep_senate);
  end if;
  st := jsonb_set(st, '{appliedResetEpoch}', to_jsonb(world_epoch));
  st := jsonb_set(st, '{lastSeenAt}', to_jsonb(now_ms));

  update public.players set state = st, updated_at = now() where user_id = uid;
  return jsonb_build_object('ok', true, 'applied', true, 'epoch', world_epoch, 'state', st);
end;
$$;

revoke execute on function public.app_world_reset_apply() from public;
revoke execute on function public.app_world_reset_apply() from anon;
grant execute on function public.app_world_reset_apply() to authenticated;
