-- Cross-player Production Hub bays (docs/STATIONS.md §14.1) — phase C of "stations are alive"
-- Requires: phase4_sector_stock.sql, station_directory.sql (phase A), station_hall.sql (phase B),
--           profile_username.sql.
-- Safe to re-run (create or replace / if not exists).
--
-- Phase A published bay occupancy as a read-only count. Phase B moved the hall shelf
-- to the server. Leasing a bay was still a local mutation of the visitor's own copy
-- of the station — the owner's shared `bays` column never changed, and the lease tax
-- never reached them. This file makes the bay floor one shared floor:
--
-- What the server owns here:
--   * bay occupancy in public.stations.bays (who holds which slot)
--   * the lease tax split at the moment of production, off the published rate
--   * the tax cargo queue — commodity units owed to the owner, claimed later
--
-- What the server still does NOT own: the lessee's keep, their extractor, or
-- player credits. The lessee's client mints the residual into their own cargo
-- after `app_station_bay_produce` returns. A tampered client can under-report
-- (or skip) tax; it can't occupy someone else's bay, fabricate a lease on a
-- station with no hub, or pay itself. Credits + production authority close in
-- phase D.
--
-- Publish merge: app_station_publish used to overwrite `bays` wholesale, which
-- would wipe a remote lessee the next time the owner autosaved. The replace
-- below keeps non-owner lessee slots that the owner's client doesn't know about.

-- ---------------------------------------------------------------------------
-- Tax cargo queue. Commodity units (not credits) — lease tax feeds the station
-- hold, which the owner hauls to a capital (§8). RLS on, no policies: same
-- shape as station_payouts / station_listings.
-- ---------------------------------------------------------------------------
create table if not exists public.station_bay_tax (
  id         bigserial primary key,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  system_id  text not null,
  comm_id    text not null,
  qty        int  not null check (qty > 0 and qty <= 500),
  lessee_id  uuid null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz null
);

create index if not exists station_bay_tax_unclaimed_idx
  on public.station_bay_tax (owner_id) where claimed_at is null;

alter table public.station_bay_tax enable row level security;

-- Bay count from Production Hub level (mirrors STATIONCFG.prodHub).
-- Numeric guard: a malformed modules value must return 0, not throw a 500.
create or replace function public._station_bay_count(p_modules jsonb)
returns int
language sql
immutable
as $$
  select case greatest(0, least(5, coalesce(
    case when (p_modules->>'production_hub') ~ '^[0-9]+$'
         then (p_modules->>'production_hub')::int
         else 0 end, 0)))
    when 1 then 2
    when 2 then 3
    when 3 then 4
    when 4 then 6
    when 5 then 8
    else 0
  end;
$$;

-- Normalise a bays jsonb array to exactly n slots. Preserves taxed_at so a
-- produce cycle can't be reset by a pad that dropped it.
create or replace function public._station_bays_pad(p_bays jsonb, p_n int)
returns jsonb
language plpgsql
immutable
as $$
declare
  out jsonb := '[]'::jsonb;
  i   int;
  el  jsonb;
  slot jsonb;
  lid text;
  npc boolean;
begin
  if p_n <= 0 then return '[]'::jsonb; end if;
  for i in 0 .. p_n - 1 loop
    el := case when jsonb_typeof(p_bays) = 'array' then p_bays -> i else null end;
    lid := left(coalesce(el->>'lesseeId', ''), 64);
    npc := coalesce((el->>'npc')::boolean, false);
    if lid = '' then npc := false; end if;
    slot := jsonb_build_object('lesseeId', lid, 'npc', npc);
    if el ? 'taxed_at' and el->>'taxed_at' is not null then
      slot := slot || jsonb_build_object('taxed_at', el->'taxed_at');
    end if;
    out := out || jsonb_build_array(slot);
  end loop;
  return out;
end;
$$;

-- ---------------------------------------------------------------------------
-- Publish merge — preserve remote lessees the owner can't see in their save.
-- Owner / NPC slots come from the client; anyone else's uuid stays put.
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

    -- Bay count from the modules being published (same source the client uses).
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

      -- Owner rewrite: local saves still key the owner as "player".
      if c_lid in ('player', uid::text) and not c_npc then
        c_lid := uid::text;
      end if;

      -- Keep a server-side foreign lessee when the owner's save shows vacant
      -- OR an NPC placeholder. Guest-local NPC tenants must never overwrite a
      -- paying baron — the client used to publish npc:true into every empty
      -- slot and wipe real leases on the next autosave.
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
        -- NPC tenants are guest-local only — never accept them into the shared
        -- column (a publish that races ahead of the directory load can still
        -- send them). Same lessee still in the slot → keep taxed_at so an
        -- owner publish can't reset the produce cooldown.
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

-- ---------------------------------------------------------------------------
-- Lease a vacant bay. The extractor stays in the lessee's save — the server
-- only records who holds the slot. p_extractor is accepted for the stub
-- signature and ignored (a uid from another save means nothing here).
-- ---------------------------------------------------------------------------
create or replace function public.app_station_lease_bay(
  p_system text, p_bay int, p_extractor text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid    uuid := auth.uid();
  st     public.stations%rowtype;
  n      int;
  v_bays jsonb;   -- never name a local `bays`: it shadows the column and the
                  -- UPDATE below throws "column reference is ambiguous"
  el     jsonb;
  lid    text;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_system is null or length(p_system) > 40 then
    return jsonb_build_object('ok', false, 'error', 'No station.');
  end if;
  if p_bay is null or p_bay < 0 or p_bay > 11 then
    return jsonb_build_object('ok', false, 'error', 'No such bay.');
  end if;

  select * into st from public.stations where system_id = p_system for update;
  if not found or st.owner_id is null or st.status <> 'owned' then
    return jsonb_build_object('ok', false, 'error', 'Station isn''t leasing.');
  end if;
  if st.owner_id = uid then
    return jsonb_build_object('ok', false, 'error', 'You own this station — occupy a bay instead.');
  end if;
  if st.updated_at < now() - interval '30 days' then
    return jsonb_build_object('ok', false, 'error', 'Station has gone dark.');
  end if;
  if coalesce(nullif(trim(st.prod_comm), ''), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'No Production Hub commodity assigned.');
  end if;

  n := public._station_bay_count(st.modules);
  if n <= 0 or p_bay >= n then
    return jsonb_build_object('ok', false, 'error', 'No such bay.');
  end if;

  v_bays := public._station_bays_pad(st.bays, n);
  el := v_bays -> p_bay;
  lid := coalesce(el->>'lesseeId', '');
  if lid <> '' then
    return jsonb_build_object('ok', false, 'error', 'Bay is occupied.');
  end if;

  -- One lease per baron per station — keeps a whale from parking every bay.
  if exists (
    select 1 from jsonb_array_elements(v_bays) x
     where coalesce(x->>'lesseeId', '') = uid::text
  ) then
    return jsonb_build_object('ok', false, 'error', 'You already lease a bay here.');
  end if;

  v_bays := jsonb_set(v_bays, array[p_bay::text],
    jsonb_build_object('lesseeId', uid::text, 'npc', false), true);

  update public.stations set bays = v_bays, updated_at = now() where system_id = p_system;

  return jsonb_build_object(
    'ok', true,
    'bay', p_bay,
    'prodComm', st.prod_comm,
    'leaseTaxBps', st.lease_tax_bps,
    'lesseeId', uid::text
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Vacate. Lessee leaves; owner may also evict (extractor returns on the
-- lessee's next sync when they notice the slot is gone).
-- ---------------------------------------------------------------------------
create or replace function public.app_station_vacate_bay(p_system text, p_bay int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid    uuid := auth.uid();
  st     public.stations%rowtype;
  n      int;
  v_bays jsonb;
  el     jsonb;
  lid    text;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_system is null or length(p_system) > 40 then
    return jsonb_build_object('ok', false, 'error', 'No station.');
  end if;
  if p_bay is null or p_bay < 0 or p_bay > 11 then
    return jsonb_build_object('ok', false, 'error', 'No such bay.');
  end if;

  select * into st from public.stations where system_id = p_system for update;
  if not found or st.owner_id is null then
    return jsonb_build_object('ok', false, 'error', 'No station.');
  end if;

  n := public._station_bay_count(st.modules);
  if n <= 0 or p_bay >= n then
    return jsonb_build_object('ok', false, 'error', 'Bay is empty.');
  end if;

  v_bays := public._station_bays_pad(st.bays, n);
  el := v_bays -> p_bay;
  lid := coalesce(el->>'lesseeId', '');
  if lid = '' then
    return jsonb_build_object('ok', false, 'error', 'Bay is empty.');
  end if;
  if lid is distinct from uid::text and st.owner_id is distinct from uid then
    return jsonb_build_object('ok', false, 'error', 'Not your bay.');
  end if;

  v_bays := jsonb_set(v_bays, array[p_bay::text],
    jsonb_build_object('lesseeId', '', 'npc', false), true);

  update public.stations set bays = v_bays, updated_at = now() where system_id = p_system;

  return jsonb_build_object('ok', true, 'bay', p_bay);
end;
$$;

-- ---------------------------------------------------------------------------
-- Produce. Lessee reports a cycle's gross; server splits tax at the published
-- rate into the owner's cargo queue. The residual stays with the lessee's
-- client (same trust model as hall credits). taxed_at on the bay slot stops
-- a tab from minting tax faster than one cycle.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_bay_produce(
  p_system text, p_bay int, p_gross int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid    uuid := auth.uid();
  st     public.stations%rowtype;
  n      int;
  v_bays jsonb;
  el     jsonb;
  lid    text;
  gross  int;
  bps    int;
  tax    int;
  keep   int;
  taxed  timestamptz;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_system is null or length(p_system) > 40 then
    return jsonb_build_object('ok', false, 'error', 'No station.');
  end if;
  if p_bay is null or p_bay < 0 or p_bay > 11 then
    return jsonb_build_object('ok', false, 'error', 'No such bay.');
  end if;

  select * into st from public.stations where system_id = p_system for update;
  if not found or st.owner_id is null or st.status <> 'owned' then
    return jsonb_build_object('ok', false, 'error', 'Station isn''t producing.');
  end if;
  if st.status = 'refit' or (st.refit_until is not null and st.refit_until > now()) then
    return jsonb_build_object('ok', false, 'error', 'Station is in refit.');
  end if;
  if coalesce(nullif(trim(st.prod_comm), ''), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'No Production Hub commodity assigned.');
  end if;

  n := public._station_bay_count(st.modules);
  if n <= 0 or p_bay >= n then
    return jsonb_build_object('ok', false, 'error', 'No such bay.');
  end if;

  v_bays := public._station_bays_pad(st.bays, n);
  el := v_bays -> p_bay;
  lid := coalesce(el->>'lesseeId', '');
  if lid is distinct from uid::text then
    return jsonb_build_object('ok', false, 'error', 'Not your bay.');
  end if;
  if coalesce((el->>'npc')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'Not your bay.');
  end if;

  -- One report per ~50 minutes (client hour is 60; leave a little slack).
  begin
    taxed := (el->>'taxed_at')::timestamptz;
  exception when others then
    taxed := null;
  end;
  if taxed is not null and taxed > now() - interval '50 minutes' then
    return jsonb_build_object('ok', false, 'error', 'Bay already produced this cycle.',
                              'retry_at', taxed + interval '50 minutes');
  end if;

  -- Soft cap: hub V per-bay yield × fat extractor mult ≈ 80×3. Cap stops a
  -- tampered client from flooding the owner's hold; under-reporting is free
  -- (same hole as hall credits — phase D).
  gross := greatest(0, least(300, coalesce(p_gross, 0)));
  if gross <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Nothing to produce.');
  end if;

  bps  := greatest(0, least(4000, coalesce(st.lease_tax_bps, 1000)));
  tax  := floor(gross * bps / 10000.0);
  keep := gross - tax;

  if tax > 0 then
    insert into public.station_bay_tax (owner_id, system_id, comm_id, qty, lessee_id)
    values (st.owner_id, p_system, left(st.prod_comm, 40), tax, uid);
  end if;

  v_bays := jsonb_set(v_bays, array[p_bay::text],
    jsonb_build_object('lesseeId', uid::text, 'npc', false, 'taxed_at', now()), true);
  update public.stations set bays = v_bays, updated_at = now() where system_id = p_system;

  return jsonb_build_object(
    'ok', true,
    'bay', p_bay,
    'commId', st.prod_comm,
    'gross', gross,
    'tax', tax,
    'keep', keep,
    'leaseTaxBps', bps
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Settle — extended for bay tax cargo. Same round trip as the hall: payouts,
-- reclaimed items, and now commodity units owed to station owners.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_settle()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid   uuid := auth.uid();
  pays  jsonb;
  items jsonb;
  cargo jsonb;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;

  with claimed as (
    update public.station_payouts
       set claimed_at = now()
     where user_id = uid and claimed_at is null
     returning system_id, amount, reason, note
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'systemId', system_id, 'amount', amount, 'reason', reason, 'note', note)), '[]'::jsonb)
    into pays from claimed;

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

  with tax as (
    update public.station_bay_tax
       set claimed_at = now()
     where owner_id = uid and claimed_at is null
     returning system_id, comm_id, qty
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'systemId', system_id, 'commId', comm_id, 'qty', qty)), '[]'::jsonb)
    into cargo from tax;

  return jsonb_build_object('ok', true, 'payouts', pays, 'items', items, 'cargo', cargo);
end;
$$;

revoke execute on function public.app_station_lease_bay(text, int, text)     from public;
revoke execute on function public.app_station_vacate_bay(text, int)         from public;
revoke execute on function public.app_station_bay_produce(text, int, int)   from public;
revoke execute on function public.app_station_settle()                      from public;

grant execute on function public.app_station_lease_bay(text, int, text)     to authenticated;
grant execute on function public.app_station_vacate_bay(text, int)         to authenticated;
grant execute on function public.app_station_bay_produce(text, int, int)   to authenticated;
grant execute on function public.app_station_settle()                      to authenticated;
