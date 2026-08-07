-- restore_backup.sql — Settings → Restore backup for signed-in players.
--
-- Trust model: economy values NEVER come from the client. A forged p_state
-- used to be an arbitrary credit setter (and a "wiped row" gate didn't help —
-- every new account is born wiped, and app_reset_save re-wipes on demand).
--
-- Instead:
--   1. app_reset_save snapshots the pre-wipe players.state into
--      players.restore_snapshot (server-side).
--   2. app_restore_backup() — no arguments — writes that snapshot back and
--      clears it (one-shot). Corrupt-migrate never wipes the cloud row, so
--      there is no snapshot; the RPC returns the current state unchanged.
--
-- Same pattern as stationPublish → after_hour looking up players.extractors
-- rather than trusting a client-sent yield.
--
-- Prereq: docs/sql/phase1_players.sql, docs/sql/reset_save.sql.
-- Safe to re-run. Paste AFTER reset_save.sql (this file redefines app_reset_save
-- with the snapshot).

-- Server-side undo buffer for Reset Save. Not readable/writable via RLS.
alter table public.players
  add column if not exists restore_snapshot jsonb;

-- Drop the old client-supplied signature if a prior paste left it around.
drop function if exists public.app_restore_backup(jsonb);

-- Redefine Reset Save so it snapshots before wiping.
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
    return jsonb_build_object('ok', true, 'state', app._default_state());
  end if;

  keep_settings := case
    when jsonb_typeof(st->'settings') = 'object' then st->'settings'
    else null
  end;
  keep_epoch := app._applied_epoch(st);

  -- Snapshot the pre-wipe row for app_restore_backup(). Overwrites any older
  -- snapshot — latest Reset Save is the only undo. (Global admin reset does
  -- NOT snapshot; that wipe is intentional and non-undoable.)
  update public.players
     set restore_snapshot = st,
         state = (
           select case
             when keep_settings is not null then
               jsonb_set(
                 jsonb_set(
                   jsonb_set(app._default_state(), '{settings}', keep_settings),
                   '{appliedResetEpoch}', to_jsonb(keep_epoch)),
                 '{lastSeenAt}', to_jsonb(now_ms))
             else
               jsonb_set(
                 jsonb_set(app._default_state(), '{appliedResetEpoch}', to_jsonb(keep_epoch)),
                 '{lastSeenAt}', to_jsonb(now_ms))
           end
         ),
         updated_at = now()
   where user_id = uid
  returning state into st;

  return jsonb_build_object('ok', true, 'state', st);
end;
$$;

revoke execute on function public.app_reset_save() from public;
revoke execute on function public.app_reset_save() from anon;
grant execute on function public.app_reset_save() to authenticated;

-- Restore from the server-side snapshot. No client economy payload.
create or replace function public.app_restore_backup()
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid uuid := auth.uid();
  now_ms bigint := app._now_ms();
  st jsonb;
  snap jsonb;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select state, restore_snapshot into st, snap
    from public.players where user_id = uid for update;
  if st is null then
    return jsonb_build_object('ok', false, 'error', 'no player row');
  end if;

  if snap is null or jsonb_typeof(snap) <> 'object' then
    -- Corrupt-migrate gates cloud writes and never wipes the row — there is
    -- nothing to restore. Caller keeps the current ledger.
    return jsonb_build_object('ok', true, 'state', st, 'restored', false);
  end if;

  st := snap;
  st := jsonb_set(st, '{lastSeenAt}', to_jsonb(now_ms));

  update public.players
     set state = st,
         restore_snapshot = null,
         updated_at = now()
   where user_id = uid;

  return jsonb_build_object('ok', true, 'state', st, 'restored', true);
end;
$$;

revoke execute on function public.app_restore_backup() from public;
revoke execute on function public.app_restore_backup() from anon;
grant execute on function public.app_restore_backup() to authenticated;
