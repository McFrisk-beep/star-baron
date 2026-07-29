-- admin_grant.sql — admin-only dev helper.
-- Lets an ADMIN set their OWN credits and/or Baron Tier server-side, so they can
-- test tier-gated features (e.g. the Senate Ballot Initiative, which reads the
-- server-authoritative prestige tier). This is deliberately narrow:
--   • gated on profiles.role = 'admin' (server-side; a client can't spoof it), and
--   • only ever writes the CALLER'S OWN players row (auth.uid()).
-- A normal player calling it gets {ok:false,'admin only'}; it grants nothing to
-- anyone else's account, so it is not a cheat vector.
--
-- Requires: docs/ADMIN_SETUP.md (public.profiles + role) and
--           docs/sql/phase1_players.sql (public.players + app._lock_state /
--           app._write_state / app._now_ms).
-- Apply: paste into the Supabase SQL editor and run once.

create or replace function public.app_admin_grant(
  p_credits double precision default null,
  p_tier    int              default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
begin
  -- server-side admin check (never trust the client)
  if not exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role = 'admin'
  ) then
    return jsonb_build_object('ok', false, 'error', 'admin only');
  end if;

  -- lock + read the caller's own authoritative state
  st := app._lock_state(now_ms);
  if st is null then
    return jsonb_build_object('ok', false, 'error', 'no player row yet — play once, then retry');
  end if;

  if p_credits is not null then
    st := jsonb_set(st, '{credits}', to_jsonb(greatest(0::double precision, p_credits)));
  end if;

  if p_tier is not null then
    -- ensure a prestige object exists before setting the nested leaf
    if st->'prestige' is null or jsonb_typeof(st->'prestige') <> 'object' then
      st := jsonb_set(st, '{prestige}', '{"tier":0,"multiplier":1}'::jsonb, true);
    end if;
    st := jsonb_set(st, '{prestige,tier}', to_jsonb(greatest(0, least(6, p_tier))));
  end if;

  perform app._write_state(st, now_ms);
  return jsonb_build_object('ok', true, 'state', st);
end;
$$;

grant execute on function public.app_admin_grant(double precision, int) to authenticated;
