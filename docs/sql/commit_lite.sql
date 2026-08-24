-- commit_lite.sql — SUPERSEDED by docs/sql/commit_allowlist.sql.
--
-- This file used to define public.app_commit_lite (the trimmed-echo wrapper
-- around app_commit). That wrapper has since grown an input allowlist and the
-- server-owned craftedOnce substitution, and lives in commit_allowlist.sql.
--
-- The function definition was REMOVED from this file on purpose: two files
-- defining the same function is a downgrade footgun — pasting this one after
-- commit_allowlist.sql would have silently replaced the hardened wrapper with
-- the old permissive one. A stale doc or paste-order mistake now does nothing
-- instead of undoing a security fix.
--
-- Apply: nothing. Run docs/sql/commit_allowlist.sql instead.
select 'commit_lite.sql is superseded — apply docs/sql/commit_allowlist.sql'
  as notice;
