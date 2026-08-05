-- Shared station ownership directory (docs/STATIONS.md §14)
-- Requires: phase4_sector_stock.sql (creates public.stations), profile_username.sql.
-- Safe to re-run (create or replace / if not exists).
--
-- Why: station ownership lives in each player's save. Nothing ever published it,
-- so a station claimed by one baron rendered as "NPC" for every *other* client
-- and for signed-out visitors. This is the smallest shared row that fixes that:
-- a public, anon-readable "who holds this station" directory plus a first-come
-- claim guard. It is NOT server-authoritative ownership — modules, treasury,
-- production and auctions all still run client-side until app_station_* land.

alter table public.stations
  add column if not exists owner_display text,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists stations_owner_idx
  on public.stations (owner_id) where owner_id is not null;

-- ---------------------------------------------------------------------------
-- Read: every client (including anon) sees who holds what.
-- Rows go stale after 30 days without a refresh so an abandoned save can't lock
-- a station out of the auction pool forever.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_directory()
returns table (
  system_id  text,
  owner_id   uuid,
  display    text,
  tier       text,
  status     text,
  updated_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select s.system_id, s.owner_id, coalesce(s.owner_display, 'Baron'), s.tier, s.status, s.updated_at
  from public.stations s
  where s.owner_id is not null
    and s.status in ('owned', 'refit')
    and s.updated_at > now() - interval '30 days'
  order by s.system_id
  limit 500;
$$;

grant execute on function public.app_station_directory() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Write: publish the caller's held stations. Claims are first-come — a row held
-- by someone else is left alone and reported back in `conflicts`. Stations the
-- caller no longer lists (relinquish / revolt) are released to npc.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_publish(p_stations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid       uuid := auth.uid();
  v_rows    jsonb := coalesce(p_stations, '[]'::jsonb);
  r         jsonb;
  sid       text;
  uname     text;
  jn        bigint;
  disp      text;
  kept      text[] := '{}';
  conflicts text[];
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'error', 'not signed in');
  end if;
  if jsonb_typeof(v_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'stations must be an array');
  end if;
  if jsonb_array_length(v_rows) > 24 then
    return jsonb_build_object('ok', false, 'error', 'too many stations');
  end if;

  -- Same display rule as the baron board (username → Baron #n → Baron).
  select username, join_n into uname, jn from public.profiles where user_id = uid;
  disp := case
    when uname is not null and length(trim(uname)) > 0 then trim(uname)
    when jn is not null and jn > 0 then 'Baron #' || jn::text
    else 'Baron'
  end;

  for r in select * from jsonb_array_elements(v_rows) loop
    sid := nullif(trim(coalesce(r->>'system_id', '')), '');
    continue when sid is null or length(sid) > 40;
    kept := kept || sid;

    insert into public.stations as s (system_id, owner_id, owner_display, tier, status, updated_at)
    values (
      sid, uid, disp,
      coalesce(nullif(trim(coalesce(r->>'tier', '')), ''), 'Berth'),
      case when coalesce(r->>'status', '') in ('owned', 'refit') then r->>'status' else 'owned' end,
      now()
    )
    on conflict (system_id) do update set
      owner_id      = excluded.owner_id,
      owner_display = excluded.owner_display,
      tier          = excluded.tier,
      status        = excluded.status,
      updated_at    = now()
    where s.owner_id is null
       or s.owner_id = uid
       or s.updated_at < now() - interval '30 days';
  end loop;

  -- Anything still ours but no longer claimed goes back to the pool.
  update public.stations
     set owner_id = null, owner_display = null, status = 'npc', updated_at = now()
   where owner_id = uid
     and not (system_id = any(kept));

  select array_agg(system_id) into conflicts
    from public.stations
   where system_id = any(kept) and owner_id is distinct from uid;

  return jsonb_build_object(
    'ok', true,
    'display', disp,
    'held', coalesce(array_length(kept, 1), 0),
    'conflicts', to_jsonb(coalesce(conflicts, '{}'::text[]))
  );
end;
$$;

grant execute on function public.app_station_publish(jsonb) to authenticated;
