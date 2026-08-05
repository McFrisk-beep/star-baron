-- Shared station record (docs/STATIONS.md §14) — phase A of "stations are alive"
-- Requires: phase4_sector_stock.sql (creates public.stations), profile_username.sql.
-- Safe to re-run (create or replace / if not exists).
--
-- Why: a station's whole record — owner, modules, tariffs, scrutiny, hall
-- listings, bays — lived only in its owner's save. Nothing ever published it,
-- so a claimed, fully upgraded station rendered as a vacant "NPC" berth for
-- every other client and for signed-out visitors.
--
-- Phase A (this file) makes the record public and read-only: every client sees
-- who holds a station, what's installed, what the tariffs and scrutiny are, and
-- what's on the hall shelf. Effects that are pure reads of that record — Customs
-- House scans, Free Port, Dry Dock, Workshop Annex, Survey Relay, Lane Buoy —
-- start applying to visitors immediately, because the client already computes
-- them from `modules`.
--
-- Phase B adds the mutating RPCs (hall buy/list, bay lease, impound ransom) that
-- write back into these same `hall` / `bays` columns and queue the owner's cut.
-- Until then a visitor can look but not touch: nothing here moves credits.

alter table public.stations
  add column if not exists owner_display text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists hall jsonb not null default '[]'::jsonb,
  add column if not exists bays jsonb not null default '[]'::jsonb;

create index if not exists stations_owner_idx
  on public.stations (owner_id) where owner_id is not null;

-- ---------------------------------------------------------------------------
-- Read: every client (including anon) sees the public record.
-- Treasury and hold stay unpublished — an owner's bank balance is nobody's
-- business until the server owns the transactions that move it (phase B).
-- Rows go stale after 30 days without a refresh so an abandoned save can't lock
-- a station out of the auction pool.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_directory()
returns table (
  system_id       text,
  owner_id        uuid,
  display         text,
  tier            text,
  status          text,
  modules         jsonb,
  reactor_level   int,
  lease_tax_bps   int,
  sale_tariff_bps int,
  scrutiny        int,
  standing        numeric,
  prod_comm       text,
  refit_until     timestamptz,
  hall            jsonb,
  bays            jsonb,
  updated_at      timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select s.system_id, s.owner_id, coalesce(s.owner_display, 'Baron'), s.tier, s.status,
         s.modules, s.reactor_level, s.lease_tax_bps, s.sale_tariff_bps,
         s.scrutiny, s.standing, s.prod_comm, s.refit_until, s.hall, s.bays, s.updated_at
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
--
-- The payload is client-supplied and stays client-trusted for now: nothing here
-- moves credits, so the caps below are about keeping the row a sane size, not
-- about economic integrity. Phase B must validate listings server-side before
-- they can be bought.
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
  v_hall    jsonb;
  v_bays    jsonb;
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

    v_hall := case when jsonb_typeof(r->'hall') = 'array' then r->'hall' else '[]'::jsonb end;
    v_bays := case when jsonb_typeof(r->'bays') = 'array' then r->'bays' else '[]'::jsonb end;
    if jsonb_array_length(v_hall) > 40 then
      select jsonb_agg(x) into v_hall from (select x from jsonb_array_elements(v_hall) x limit 40) q;
    end if;
    if jsonb_array_length(v_bays) > 12 then
      select jsonb_agg(x) into v_bays from (select x from jsonb_array_elements(v_bays) x limit 12) q;
    end if;

    insert into public.stations as s (
      system_id, owner_id, owner_display, tier, status, modules, reactor_level,
      lease_tax_bps, sale_tariff_bps, scrutiny, standing, prod_comm, refit_until,
      hall, bays, updated_at
    )
    values (
      sid, uid, disp,
      coalesce(nullif(trim(coalesce(r->>'tier', '')), ''), 'Berth'),
      case when coalesce(r->>'status', '') in ('owned', 'refit') then r->>'status' else 'owned' end,
      case when jsonb_typeof(r->'modules') = 'object' then r->'modules' else '{}'::jsonb end,
      greatest(0, least(5, coalesce((r->>'reactor_level')::int, 0))),
      greatest(0, least(10000, coalesce((r->>'lease_tax_bps')::int, 1000))),
      greatest(0, least(10000, coalesce((r->>'sale_tariff_bps')::int, 500))),
      greatest(0, least(100, coalesce((r->>'scrutiny')::int, 10))),
      greatest(0, least(100, coalesce((r->>'standing')::numeric, 60))),
      left(nullif(trim(coalesce(r->>'prod_comm', '')), ''), 40),
      case when (r->>'refit_until') ~ '^\d+$' and (r->>'refit_until')::bigint > 0
           then to_timestamp((r->>'refit_until')::bigint / 1000.0) end,
      coalesce(v_hall, '[]'::jsonb),
      coalesce(v_bays, '[]'::jsonb),
      now()
    )
    on conflict (system_id) do update set
      owner_id        = excluded.owner_id,
      owner_display   = excluded.owner_display,
      tier            = excluded.tier,
      status          = excluded.status,
      modules         = excluded.modules,
      reactor_level   = excluded.reactor_level,
      lease_tax_bps   = excluded.lease_tax_bps,
      sale_tariff_bps = excluded.sale_tariff_bps,
      scrutiny        = excluded.scrutiny,
      standing        = excluded.standing,
      prod_comm       = excluded.prod_comm,
      refit_until     = excluded.refit_until,
      hall            = excluded.hall,
      bays            = excluded.bays,
      updated_at      = now()
    where s.owner_id is null
       or s.owner_id = uid
       or s.updated_at < now() - interval '30 days';
  end loop;

  -- Anything still ours but no longer claimed goes back to the pool. Modules
  -- persist through ownership changes (§7.3) — only the claim is cleared.
  update public.stations
     set owner_id = null, owner_display = null, status = 'npc',
         hall = '[]'::jsonb, bays = '[]'::jsonb, updated_at = now()
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
