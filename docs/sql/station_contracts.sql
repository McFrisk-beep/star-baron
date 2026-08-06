-- Cross-player Contract Office (docs/STATIONS.md §14.1) — phase D1
-- Requires: phase4_sector_stock.sql, station_directory.sql, station_treasury.sql
--           (app._credit_user / app._lock_state), profile_username.sql.
-- Safe to re-run (create or replace / if not exists).
--
-- Phase D0 made credits and treasury authoritative. Contract Office hauls were
-- still local: a posting in the owner's save never reached the Bazaar board
-- for anyone else. This file moves hauls to the server:
--   * station hold units escrowed at post (stations.hold jsonb)
--   * bounty + posting fee debited from players.state at post
--   * open hauls readable on the shared board; claim / settle are exclusive
--   * success credits the hauler and restocks sector_stock at the capital
--
-- NPC fill and hourly expiry on a shared station stay client-side for the
-- owner only when contracts aren't shared; once live, expiry batches through
-- app_station_expire_hauls and NPC fill stands down (same as hall NPC buyers).

alter table public.stations
  add column if not exists contract_filled int not null default 0,
  add column if not exists contract_expired int not null default 0;

-- ---------------------------------------------------------------------------
-- Haul ledger. Goods sit in stations.hold; bounty is spent at post time.
-- ---------------------------------------------------------------------------
create table if not exists public.station_hauls (
  id         uuid primary key default gen_random_uuid(),
  system_id  text not null,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  comm_id    text not null,
  qty        int  not null check (qty > 0 and qty <= 500),
  rate       bigint not null check (rate >= 5),
  escrow     bigint not null check (escrow > 0),
  fee        bigint not null default 0 check (fee >= 0),
  status     text not null default 'open'
    check (status in ('open','active','filled','cancelled','expired','failed')),
  taken_by   uuid null references auth.users (id) on delete set null,
  taken_at   timestamptz null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists station_hauls_open_idx
  on public.station_hauls (system_id) where status = 'open';
create index if not exists station_hauls_owner_idx
  on public.station_hauls (owner_id, status);

alter table public.station_hauls enable row level security;

alter table public.station_payouts drop constraint if exists station_payouts_reason_check;
alter table public.station_payouts add constraint station_payouts_reason_check
  check (reason in ('sale', 'tariff', 'haul_refund', 'refund_owed'));

-- Hold helpers — stations.hold is { comm_id: qty }.
create or replace function public._station_hold_get(p_hold jsonb, p_comm text)
returns int
language sql immutable as $$
  select greatest(0, coalesce((p_hold->>left(p_comm, 40))::int, 0));
$$;

create or replace function public._station_hold_add(p_hold jsonb, p_comm text, p_qty int)
returns jsonb
language sql immutable as $$
  select case when p_qty <= 0 then coalesce(p_hold, '{}'::jsonb)
    else jsonb_set(coalesce(p_hold, '{}'::jsonb), array[left(p_comm, 40)],
         to_jsonb(public._station_hold_get(p_hold, p_comm) + p_qty), true)
  end;
$$;

create or replace function public._station_hold_take(p_hold jsonb, p_comm text, p_qty int)
returns jsonb
language sql immutable as $$
  select jsonb_set(coalesce(p_hold, '{}'::jsonb), array[left(p_comm, 40)],
         to_jsonb(greatest(0, public._station_hold_get(p_hold, p_comm) - p_qty)), true);
$$;

-- Restock sector shelf at the station's sector capital (§11).
create or replace function public._station_restock(p_system text, p_comm text, p_qty int)
returns void
language plpgsql
security definer
set search_path = public, market
as $$
declare
  sec text;
begin
  if p_qty <= 0 then return; end if;
  sec := market.sector_of_system(p_system);
  if sec is null then return; end if;
  perform market.seed_sector_stock();
  insert into public.sector_stock (sector_id, comm_id, units)
  values (sec, left(p_comm, 40), p_qty)
  on conflict (sector_id, comm_id) do update
    set units = public.sector_stock.units + excluded.units, updated_at = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- Read: open hauls for the Bazaar board (anon + authenticated).
-- ---------------------------------------------------------------------------
create or replace function public.app_station_hauls(p_systems text[])
returns table (
  id          text,
  system_id   text,
  owner_id    uuid,
  owner       text,
  station     text,
  tier        text,
  comm_id     text,
  qty         int,
  rate        bigint,
  escrow      bigint,
  created_at  timestamptz,
  expires_at  timestamptz,
  filled      int,
  expired     int
)
language sql
security definer
set search_path = public
stable
as $$
  select h.id::text, h.system_id, h.owner_id,
         coalesce(s.owner_display, 'Baron'), h.system_id,
         s.tier,
         h.comm_id, h.qty, h.rate, h.escrow, h.created_at, h.expires_at,
         coalesce(s.contract_filled, 0), coalesce(s.contract_expired, 0)
    from public.station_hauls h
    join public.stations s on s.system_id = h.system_id
   where h.status = 'open'
     and h.expires_at > now()
     and s.owner_id is not null
     and s.status in ('owned', 'refit')
     and s.updated_at > now() - interval '30 days'
     and coalesce((s.modules->>'contract_office')::int, 0) >= 1
     and h.system_id = any(coalesce(p_systems, '{}'::text[]))
   order by h.system_id, h.created_at
   limit 200;
$$;

grant execute on function public.app_station_hauls(text[]) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Post: escrow hold + bounty from owner wallet.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_post_haul(
  p_system text, p_comm_id text, p_qty int, p_rate bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, market, app
as $$
declare
  uid      uuid := auth.uid();
  st       public.stations%rowtype;
  now_ms   bigint := app._now_ms();
  pstate   jsonb;
  credits  double precision;
  comm     record;
  qty      int;
  rate     bigint;
  escrow   bigint;
  fee      bigint;
  have     int;
  new_id   uuid;
  exp      timestamptz;
  n_open   int;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_system is null or length(p_system) > 40 then
    return jsonb_build_object('ok', false, 'error', 'No station.');
  end if;

  qty  := floor(coalesce(p_qty, 0));
  rate := floor(coalesce(p_rate, 0));
  if qty < 1 then return jsonb_build_object('ok', false, 'error', 'Need at least 1 unit.'); end if;
  if qty > 500 then return jsonb_build_object('ok', false, 'error', 'Quantity too large.'); end if;
  if rate < 5 then return jsonb_build_object('ok', false, 'error', 'Rate at least 5c/unit.'); end if;
  if rate > 1000000 then return jsonb_build_object('ok', false, 'error', 'Rate too high.'); end if;

  select * into comm from market.commodity(left(p_comm_id, 40));
  if comm.id is null or comm.craft_only then
    return jsonb_build_object('ok', false, 'error', 'Unknown commodity.');
  end if;

  select * into st from public.stations where system_id = p_system for update;
  if not found or st.owner_id is distinct from uid then
    return jsonb_build_object('ok', false, 'error', 'Not your station.');
  end if;
  if st.status = 'refit' or (st.refit_until is not null and st.refit_until > now()) then
    return jsonb_build_object('ok', false, 'error', 'Station is in refit.');
  end if;
  if coalesce((st.modules->>'contract_office')::int, 0) < 1 then
    return jsonb_build_object('ok', false, 'error', 'Install a Contract Office first.');
  end if;

  have := public._station_hold_get(st.hold, comm.id);
  if qty > have then
    return jsonb_build_object('ok', false, 'error', format('Only %s in station hold.', have));
  end if;

  select count(*) into n_open from public.station_hauls
   where system_id = p_system and status = 'open' and expires_at > now();
  if n_open >= 24 then return jsonb_build_object('ok', false, 'error', 'Board is full.'); end if;

  escrow := qty * rate;
  fee := floor(escrow * 0.05);  -- STATIONCFG.contractPostFeeBps = 500
  pstate := app._lock_state(now_ms);
  credits := coalesce((pstate->>'credits')::float8, 0);
  if credits < escrow + fee then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
  end if;
  credits := credits - escrow - fee;
  pstate := jsonb_set(pstate, '{credits}', to_jsonb(credits));
  perform app._write_state(pstate, now_ms);

  exp := now() + interval '36 hours';

  update public.stations
     set hold = public._station_hold_take(hold, comm.id, qty), updated_at = now()
   where system_id = p_system;

  insert into public.station_hauls
    (system_id, owner_id, comm_id, qty, rate, escrow, fee, expires_at)
  values (p_system, uid, comm.id, qty, rate, escrow, fee, exp)
  returning id into new_id;

  return jsonb_build_object(
    'ok', true,
    'id', new_id::text,
    'contract', jsonb_build_object(
      'id', new_id::text, 'commId', comm.id, 'qty', qty, 'rate', rate,
      'escrow', escrow, 'fee', fee, 'status', 'open',
      'createdAt', extract(epoch from now()) * 1000,
      'expiresAt', extract(epoch from exp) * 1000,
      'ownerId', uid::text
    ),
    'fee', fee,
    'credits', credits,
    'hold', (select hold from public.stations where system_id = p_system)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Cancel: owner pulls an open posting; goods and bounty return.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_cancel_haul(p_haul_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid     uuid := auth.uid();
  now_ms  bigint := app._now_ms();
  h       public.station_hauls%rowtype;
  st      public.stations%rowtype;
  pstate  jsonb;
  credits double precision;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_haul_id !~ '^[0-9a-fA-F-]{36}$' then
    return jsonb_build_object('ok', false, 'error', 'Posting gone.');
  end if;

  select * into h from public.station_hauls where id = p_haul_id::uuid for update;
  if not found or h.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'Posting gone.');
  end if;
  if h.owner_id <> uid then
    return jsonb_build_object('ok', false, 'error', 'Not your posting.');
  end if;

  select * into st from public.stations where system_id = h.system_id for update;

  pstate := app._lock_state(now_ms);
  credits := coalesce((pstate->>'credits')::float8, 0) + h.escrow;
  pstate := jsonb_set(pstate, '{credits}', to_jsonb(credits));
  perform app._write_state(pstate, now_ms);

  update public.stations
     set hold = public._station_hold_add(hold, h.comm_id, h.qty), updated_at = now()
   where system_id = h.system_id;

  update public.station_hauls set status = 'cancelled' where id = h.id;

  return jsonb_build_object(
    'ok', true, 'credits', credits,
    'hold', (select hold from public.stations where system_id = h.system_id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Claim: hauler takes an open job (launch path).
-- ---------------------------------------------------------------------------
create or replace function public.app_station_claim_haul(p_haul_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  h   public.station_hauls%rowtype;
  st  public.stations%rowtype;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_haul_id !~ '^[0-9a-fA-F-]{36}$' then
    return jsonb_build_object('ok', false, 'error', 'Haul no longer available.');
  end if;

  select * into h from public.station_hauls where id = p_haul_id::uuid for update;
  if not found or h.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'Haul no longer available.');
  end if;
  if h.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'Haul no longer available.');
  end if;
  if h.owner_id = uid then
    return jsonb_build_object('ok', false, 'error', 'Can''t fly your own station haul.');
  end if;

  select * into st from public.stations where system_id = h.system_id;
  if not found or coalesce((st.modules->>'contract_office')::int, 0) < 1 then
    return jsonb_build_object('ok', false, 'error', 'Haul no longer available.');
  end if;

  update public.station_hauls
     set status = 'active', taken_by = uid, taken_at = now()
   where id = h.id;

  return jsonb_build_object(
    'ok', true,
    'contract', jsonb_build_object(
      'id', h.id::text, 'commId', h.comm_id, 'qty', h.qty, 'rate', h.rate,
      'escrow', h.escrow, 'status', 'active', 'ownerId', h.owner_id::text,
      'takenBy', uid::text,
      'createdAt', extract(epoch from h.created_at) * 1000,
      'expiresAt', extract(epoch from h.expires_at) * 1000
    ),
    'systemId', h.system_id
  );
end;
$$;

-- Lock + read another user's player row (refund path).
create or replace function app._lock_state_for_owner(p_uid uuid, p_now_ms bigint)
returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare st jsonb;
begin
  if p_uid is null then return null; end if;
  select state into st from public.players where user_id = p_uid for update;
  if st is null then return null; end if;
  return app._arrive_if_due(st, p_now_ms);
end;
$$;

create or replace function app._write_state_for(p_uid uuid, p_state jsonb, p_now_ms bigint)
returns void
language plpgsql security definer set search_path = public as $$
begin
  p_state := jsonb_set(p_state, '{lastSeenAt}', to_jsonb(p_now_ms));
  update public.players set state = p_state, updated_at = now() where user_id = p_uid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Settle: mission outcome or owner expiry batch.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_settle_haul(p_haul_id text, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid      uuid := auth.uid();
  now_ms   bigint := app._now_ms();
  h        public.station_hauls%rowtype;
  st       public.stations%rowtype;
  pstate   jsonb;
  credits  double precision;
  outc     text := lower(coalesce(p_outcome, ''));
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_haul_id !~ '^[0-9a-fA-F-]{36}$' then
    return jsonb_build_object('ok', false, 'error', 'Haul gone.');
  end if;
  if outc not in ('success', 'fail', 'abandon', 'expire') then
    return jsonb_build_object('ok', false, 'error', 'Invalid outcome.');
  end if;

  select * into h from public.station_hauls where id = p_haul_id::uuid for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Haul gone.'); end if;
  if h.status in ('filled', 'cancelled', 'expired', 'failed') then
    return jsonb_build_object('ok', false, 'error', 'Already settled.');
  end if;

  if outc = 'expire' then
    if h.owner_id <> uid then
      return jsonb_build_object('ok', false, 'error', 'Not your posting.');
    end if;
    if h.status <> 'open' or h.expires_at > now() then
      return jsonb_build_object('ok', false, 'error', 'Not expired.');
    end if;
  elsif outc in ('success', 'fail', 'abandon') then
    if h.status <> 'active' or h.taken_by is distinct from uid then
      return jsonb_build_object('ok', false, 'error', 'Not your haul.');
    end if;
  end if;

  select * into st from public.stations where system_id = h.system_id for update;

  if outc = 'success' then
    perform public._station_restock(h.system_id, h.comm_id, h.qty);
    if not app._credit_user(h.taken_by, h.escrow, now_ms) then
      insert into public.station_payouts (user_id, system_id, amount, reason, note)
      values (h.taken_by, h.system_id, h.escrow, 'sale', 'haul:' || left(h.comm_id, 20));
    end if;
    update public.station_hauls set status = 'filled' where id = h.id;
    update public.stations
       set contract_filled = contract_filled + 1, updated_at = now()
     where system_id = h.system_id;
  else
    if not app._credit_user(h.owner_id, h.escrow, now_ms) then
      insert into public.station_payouts (user_id, system_id, amount, reason, note)
      values (h.owner_id, h.system_id, h.escrow, 'haul_refund', h.id::text);
    end if;
    update public.stations
       set hold = public._station_hold_add(hold, h.comm_id, h.qty),
           contract_expired = contract_expired + case when outc = 'expire' then 1 else 0 end,
           updated_at = now()
     where system_id = h.system_id;
    update public.station_hauls
       set status = case outc when 'expire' then 'expired' else 'failed' end
     where id = h.id;
  end if;

  pstate := app._lock_state(now_ms);
  credits := coalesce((pstate->>'credits')::float8, 0);

  return jsonb_build_object(
    'ok', true, 'outcome', outc, 'credits', credits,
    'hold', (select hold from public.stations where system_id = h.system_id),
    'contract_filled', (select contract_filled from public.stations where system_id = h.system_id),
    'contract_expired', (select contract_expired from public.stations where system_id = h.system_id)
  );
end;
$$;

-- Owner sync: expire all due open hauls on one station.
create or replace function public.app_station_expire_hauls(p_system text)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid uuid := auth.uid();
  hid uuid;
  n   int := 0;
  res jsonb;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  for hid in
    select id from public.station_hauls
     where system_id = p_system and owner_id = uid
       and status = 'open' and expires_at <= now()
     for update
  loop
    res := public.app_station_settle_haul(hid::text, 'expire');
    if coalesce((res->>'ok')::boolean, false) then n := n + 1; end if;
  end loop;
  return jsonb_build_object('ok', true, 'expired', n);
end;
$$;

-- ---------------------------------------------------------------------------
-- Directory read — include reliability stats.
-- CREATE OR REPLACE can't change RETURNS TABLE shape (42P13); drop first.
-- ---------------------------------------------------------------------------
drop function if exists public.app_station_directory();
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
  contract_filled int,
  contract_expired int,
  updated_at      timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select s.system_id, s.owner_id, coalesce(s.owner_display, 'Baron'), s.tier, s.status,
         s.modules, s.reactor_level, s.lease_tax_bps, s.sale_tariff_bps,
         s.scrutiny, s.standing, s.prod_comm, s.refit_until, s.hall, s.bays,
         coalesce(s.contract_filled, 0), coalesce(s.contract_expired, 0), s.updated_at
  from public.stations s
  where s.owner_id is not null
    and s.status in ('owned', 'refit')
    and s.updated_at > now() - interval '30 days'
  order by s.system_id
  limit 500;
$$;

grant execute on function public.app_station_directory() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Publish — preserve server hold + contract stats (no client wealth bootstrap).
-- (Extends station_treasury.sql publish merge + bay merge from station_bays.)
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
  v_n       int;
  prev_bays jsonb;
  merged    jsonb;
  i         int;
  c_el      jsonb;
  s_el      jsonb;
  c_lid     text;
  s_lid     text;
  c_npc     boolean;
  s_npc     boolean;
  keep_srv  boolean;
  kept      text[] := '{}';
  conflicts text[];
  synced    jsonb;
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
    if jsonb_array_length(v_hall) > 40 then
      select jsonb_agg(x) into v_hall from (select x from jsonb_array_elements(v_hall) x limit 40) q;
    end if;

    v_n := public._station_bay_count(
      case when jsonb_typeof(r->'modules') = 'object' then r->'modules' else '{}'::jsonb end);

    select bays into prev_bays from public.stations where system_id = sid and owner_id = uid;
    prev_bays := coalesce(prev_bays, '[]'::jsonb);
    v_bays := case when jsonb_typeof(r->'bays') = 'array' then r->'bays' else '[]'::jsonb end;

    merged := '[]'::jsonb;
    for i in 0 .. greatest(v_n - 1, 0) loop
      exit when v_n <= 0;
      c_el  := v_bays -> i;
      s_el  := prev_bays -> i;
      c_lid := left(coalesce(c_el->>'lesseeId', ''), 64);
      s_lid := left(coalesce(s_el->>'lesseeId', ''), 64);
      c_npc := coalesce((c_el->>'npc')::boolean, false);
      s_npc := coalesce((s_el->>'npc')::boolean, false);

      if c_lid in ('player', uid::text) and not c_npc then
        c_lid := uid::text;
      end if;

      keep_srv := (c_lid = '' or c_npc or c_lid = 'npc')
                  and s_lid <> '' and not s_npc
                  and s_lid is distinct from uid::text
                  and s_lid <> 'player'
                  and s_lid <> 'npc';

      if keep_srv then
        merged := merged || jsonb_build_array(jsonb_build_object(
          'lesseeId', s_lid, 'npc', false,
          'taxed_at', s_el->'taxed_at'));
      elsif c_lid <> '' and not c_npc and c_lid <> 'npc' then
        if s_lid = c_lid and s_el ? 'taxed_at' and s_el->>'taxed_at' is not null then
          merged := merged || jsonb_build_array(jsonb_build_object(
            'lesseeId', c_lid, 'npc', false, 'taxed_at', s_el->'taxed_at'));
        else
          merged := merged || jsonb_build_array(jsonb_build_object(
            'lesseeId', c_lid, 'npc', false));
        end if;
      else
        merged := merged || jsonb_build_array(jsonb_build_object(
          'lesseeId', '', 'npc', false));
      end if;
    end loop;
    if v_n <= 0 then merged := '[]'::jsonb; end if;

    -- No client treasury/hold bootstrap — INSERT starts empty; UPDATE keeps server.
    insert into public.stations as s (
      system_id, owner_id, owner_display, tier, status, modules, reactor_level,
      treasury, hold, lease_tax_bps, sale_tariff_bps, scrutiny, standing, prod_comm,
      refit_until, hall, bays, updated_at
    )
    values (
      sid, uid, disp,
      coalesce(nullif(trim(coalesce(r->>'tier', '')), ''), 'Berth'),
      case when coalesce(r->>'status', '') in ('owned', 'refit') then r->>'status' else 'owned' end,
      case when jsonb_typeof(r->'modules') = 'object' then r->'modules' else '{}'::jsonb end,
      greatest(0, least(5, coalesce((r->>'reactor_level')::int, 0))),
      0,
      '{}'::jsonb,
      greatest(0, least(4000, coalesce((r->>'lease_tax_bps')::int, 1000))),
      greatest(0, least(1500, coalesce((r->>'sale_tariff_bps')::int, 500))),
      greatest(0, least(100, coalesce((r->>'scrutiny')::int, 10))),
      greatest(0, least(100, coalesce((r->>'standing')::numeric, 60))),
      left(nullif(trim(coalesce(r->>'prod_comm', '')), ''), 40),
      case when (r->>'refit_until') ~ '^\d+$' and (r->>'refit_until')::bigint > 0
           then to_timestamp((r->>'refit_until')::bigint / 1000.0) end,
      coalesce(v_hall, '[]'::jsonb),
      coalesce(merged, '[]'::jsonb),
      now()
    )
    on conflict (system_id) do update set
      owner_id        = excluded.owner_id,
      owner_display   = excluded.owner_display,
      tier            = excluded.tier,
      status          = excluded.status,
      modules         = excluded.modules,
      reactor_level   = excluded.reactor_level,
      treasury        = case
                          when s.owner_id is not null and s.owner_id is distinct from uid then 0
                          else s.treasury
                        end,
      hold            = case
                          when s.owner_id is not null and s.owner_id is distinct from uid then '{}'::jsonb
                          else s.hold
                        end,
      lease_tax_bps   = s.lease_tax_bps,
      sale_tariff_bps = s.sale_tariff_bps,
      scrutiny        = s.scrutiny,
      standing        = s.standing,
      contract_filled = s.contract_filled,
      contract_expired = s.contract_expired,
      prod_comm       = excluded.prod_comm,
      refit_until     = excluded.refit_until,
      hall            = excluded.hall,
      bays            = excluded.bays,
      updated_at      = now()
    where s.owner_id is null
       or s.owner_id = uid
       or s.updated_at < now() - interval '30 days';
  end loop;

  update public.stations
     set owner_id = null, owner_display = null, status = 'npc',
         treasury = 0, hold = '{}'::jsonb,
         hall = '[]'::jsonb, bays = '[]'::jsonb, updated_at = now()
   where owner_id = uid
     and not (system_id = any(kept));

  select array_agg(system_id) into conflicts
    from public.stations
   where system_id = any(kept) and owner_id is distinct from uid;

  select coalesce(jsonb_agg(jsonb_build_object(
           'system_id', system_id,
           'treasury', floor(treasury),
           'standing', round(standing),
           'hold', hold,
           'contract_filled', contract_filled,
           'contract_expired', contract_expired)), '[]'::jsonb)
    into synced
    from public.stations
   where owner_id = uid and system_id = any(kept);

  return jsonb_build_object(
    'ok', true,
    'display', disp,
    'held', coalesce(array_length(kept, 1), 0),
    'conflicts', to_jsonb(coalesce(conflicts, '{}'::text[])),
    'treasuries', coalesce(synced, '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.app_station_post_haul(text, text, int, bigint) from public;
revoke execute on function public.app_station_cancel_haul(text) from public;
revoke execute on function public.app_station_claim_haul(text) from public;
revoke execute on function public.app_station_settle_haul(text, text) from public;
revoke execute on function public.app_station_expire_hauls(text) from public;

grant execute on function public.app_station_post_haul(text, text, int, bigint) to authenticated;
grant execute on function public.app_station_cancel_haul(text) to authenticated;
grant execute on function public.app_station_claim_haul(text) to authenticated;
grant execute on function public.app_station_settle_haul(text, text) to authenticated;
grant execute on function public.app_station_expire_hauls(text) to authenticated;

-- Extend settle to pay queued haul refunds (offline owner) and deposit claimed
-- bay-tax cargo into stations.hold (server hold previously never grew).
create or replace function public.app_station_settle()
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid     uuid := auth.uid();
  now_ms  bigint := app._now_ms();
  pays    jsonb := '[]'::jsonb;
  items   jsonb;
  cargo   jsonb := '[]'::jsonb;
  holds   jsonb := '{}'::jsonb;
  pstate  jsonb;
  credits double precision;
  row     record;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;

  for row in
    select id, system_id, amount, reason, note
      from public.station_payouts
     where user_id = uid and claimed_at is null
     for update
  loop
    if row.reason in ('sale', 'haul_refund') then
      perform app._credit_user(uid, row.amount, now_ms);
    elsif row.reason = 'refund_owed' then
      -- Seller shortfall from a hall buy refund — claw what we can; claim anyway
      -- so a forever-broke wallet doesn't strand the row.
      perform app._debit_user(uid, row.amount, now_ms);
    elsif row.reason = 'tariff' then
      update public.stations
         set treasury = treasury + row.amount, updated_at = now()
       where system_id = row.system_id and owner_id = uid;
    end if;
    pays := pays || jsonb_build_array(jsonb_build_object(
      'systemId', row.system_id, 'amount', row.amount, 'reason', row.reason,
      'note', coalesce(row.note, '')));
    update public.station_payouts set claimed_at = now() where id = row.id;
  end loop;

  with back as (
    update public.station_listings
       set status = 'reclaimed', settled_at = now()
     where seller_id = uid
       and (status = 'cancelled' or (status = 'open' and expires_at <= now()))
     returning system_id, kind, name, payload
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'systemId', system_id, 'kind', kind, 'name', name, 'payload', payload)), '[]'::jsonb)
    into items from back;

  for row in
    select id, system_id, comm_id, qty
      from public.station_bay_tax
     where owner_id = uid and claimed_at is null
     for update
  loop
    update public.stations
       set hold = public._station_hold_add(hold, row.comm_id, row.qty), updated_at = now()
     where system_id = row.system_id and owner_id = uid;
    update public.station_bay_tax set claimed_at = now() where id = row.id;
    cargo := cargo || jsonb_build_array(jsonb_build_object(
      'systemId', row.system_id, 'commId', row.comm_id, 'qty', row.qty));
    holds := holds || jsonb_build_object(
      row.system_id, (select hold from public.stations where system_id = row.system_id));
  end loop;

  pstate := app._lock_state(now_ms);
  credits := coalesce((pstate->>'credits')::float8, 0);

  return jsonb_build_object(
    'ok', true, 'payouts', pays, 'items', items, 'cargo', cargo,
    'holds', holds, 'credits', credits
  );
end;
$$;

grant execute on function public.app_station_settle() to authenticated;

-- Draw from stations.hold (capital deliveries). Production top-up is derived
-- server-side in app_station_after_hour — this RPC only accepts negative
-- deltas so a client can't mint cargo into an authoritative hold.
create or replace function public.app_station_hold_deposit(p_system text, p_deltas jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, market
as $$
declare
  uid    uuid := auth.uid();
  st     public.stations%rowtype;
  k      text;
  v      text;
  delta  int;
  have   int;
  next_h jsonb;
  raw    int;
  comm   record;
  nkeys  int := 0;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_system is null or length(p_system) > 40 then
    return jsonb_build_object('ok', false, 'error', 'No station.');
  end if;
  if jsonb_typeof(p_deltas) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'error', 'Bad hold delta.');
  end if;

  select * into st from public.stations where system_id = p_system for update;
  if not found or st.owner_id is distinct from uid then
    return jsonb_build_object('ok', false, 'error', 'Not your station.');
  end if;

  next_h := coalesce(st.hold, '{}'::jsonb);
  for k, v in select key, value from jsonb_each_text(p_deltas)
  loop
    nkeys := nkeys + 1;
    if nkeys > 12 then
      return jsonb_build_object('ok', false, 'error', 'Bad hold delta.');
    end if;
    if k is null or length(k) > 40 then
      return jsonb_build_object('ok', false, 'error', 'Unknown commodity.');
    end if;
    select * into comm from market.commodity(left(k, 40));
    if comm.id is null or coalesce(comm.craft_only, false) then
      return jsonb_build_object('ok', false, 'error', 'Unknown commodity.');
    end if;
    begin
      raw := v::int;
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'Bad hold delta.');
    end;
    -- Draw-only: reject deposits and out-of-range takes (no silent clamp).
    if raw >= 0 or raw < -500 then
      return jsonb_build_object('ok', false, 'error', 'Bad hold delta.');
    end if;
    delta := raw;
    have := public._station_hold_get(next_h, comm.id);
    if have < -delta then
      return jsonb_build_object('ok', false, 'error',
        format('Only %s in station hold.', have));
    end if;
    next_h := public._station_hold_take(next_h, comm.id, -delta);
  end loop;

  update public.stations set hold = next_h, updated_at = now()
   where system_id = p_system
  returning * into st;

  return jsonb_build_object('ok', true, 'hold', st.hold);
end;
$$;

revoke execute on function public.app_station_hold_deposit(text, jsonb) from public;
grant execute on function public.app_station_hold_deposit(text, jsonb) to authenticated;
