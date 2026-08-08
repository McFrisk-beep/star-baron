-- restore_backup.sql — Settings → Restore backup for signed-in players.
--
-- Trust model: economy values NEVER come from the client. A prior version took
-- a forged p_state (arbitrary credit setter). This RPC takes no arguments and
-- returns the caller's current players.state.
--
-- Corrupt-migrate never wipes the cloud row — Restore backup adopts that ledger
-- and overlays Workshop / recipes from the browser `starbaron.corrupt` blob.
-- (Reset Save undo via a server-side snapshot is deliberately not wired — YAGNI
-- until Settings grows an Undo Reset path that actually invokes it.)
--
-- Prereq: docs/sql/phase1_players.sql.
-- Safe to re-run. If an older paste left players.restore_snapshot / a snapshotting
-- app_reset_save, re-paste docs/sql/reset_save.sql after this file so Reset Save
-- no longer writes the dead column.

-- Drop leftover undo buffer from earlier drafts (nothing reads it back).
alter table public.players
  drop column if exists restore_snapshot;

-- Drop the old client-supplied signature if a prior paste left it around.
drop function if exists public.app_restore_backup(jsonb);

-- Return the caller's current server ledger. No client economy payload.
create or replace function public.app_restore_backup()
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid uuid := auth.uid();
  st jsonb;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select state into st from public.players where user_id = uid;
  if st is null then
    return jsonb_build_object('ok', false, 'error', 'no player row');
  end if;

  return jsonb_build_object('ok', true, 'state', st, 'restored', false);
end;
$$;

revoke execute on function public.app_restore_backup() from public;
revoke execute on function public.app_restore_backup() from anon;
grant execute on function public.app_restore_backup() to authenticated;
