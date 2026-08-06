-- Station treasury + authoritative credits (docs/STATIONS.md §14.1) — phase D0
-- Requires: phase4_sector_stock.sql, station_directory.sql, station_hall.sql,
--           station_bays.sql, phase1_players.sql (app._lock_state / app._write_state).
-- Safe to re-run (create or replace / if not exists).
--
-- Phase B moved the hall shelf server-side but the buyer's client still debited
-- itself; phase C queued lease tax as cargo but credits stayed client-side.
-- This paste makes money authoritative:
--   * station treasury on public.stations (withdraw via RPC)
--   * hall buy debits the buyer's players.state credits in the same transaction
--   * sale tariff credits the station treasury directly (not a payout queue)
--   * sale proceeds credit the seller's wallet on settle (or live if online)
--   * publish stops overwriting treasury / standing / policy from the client
--
-- Contract Office, auctions, and module install remain stubs until later D slices.

alter table public.stations
  add column if not exists upkeep_paid_through timestamptz null;

-- Credit another baron's wallet (seller proceeds). No-op when they have no row.
create or replace function app._credit_user(p_uid uuid, p_amount bigint, p_now_ms bigint)
returns boolean
language plpgsql
security definer
set search_path = public, app
as $$
declare
  st jsonb;
  credits double precision;
begin
  if p_uid is null or p_amount <= 0 then return false; end if;
  select state into st from public.players where user_id = p_uid for update;
  if st is null then return false; end if;
  credits := coalesce((st->>'credits')::float8, 0) + p_amount;
  st := jsonb_set(st, '{credits}', to_jsonb(credits));
  st := jsonb_set(st, '{lastSeenAt}', to_jsonb(p_now_ms));
  update public.players set state = st, updated_at = now() where user_id = p_uid;
  return true;
end;
$$;

-- Debit another baron's wallet (refund clawback). Clamps at zero; returns the
-- amount actually removed so a broke seller can't strand the refund.
create or replace function app._debit_user(p_uid uuid, p_amount bigint, p_now_ms bigint)
returns bigint
language plpgsql
security definer
set search_path = public, app
as $$
declare
  st jsonb;
  credits double precision;
  take bigint;
begin
  if p_uid is null or p_amount <= 0 then return 0; end if;
  select state into st from public.players where user_id = p_uid for update;
  if st is null then return 0; end if;
  credits := coalesce((st->>'credits')::float8, 0);
  take := least(p_amount, greatest(0, floor(credits)::bigint));
  if take <= 0 then return 0; end if;
  st := jsonb_set(st, '{credits}', to_jsonb(credits - take));
  st := jsonb_set(st, '{lastSeenAt}', to_jsonb(p_now_ms));
  update public.players set state = st, updated_at = now() where user_id = p_uid;
  return take;
end;
$$;

-- ---------------------------------------------------------------------------
-- Withdraw: treasury → owner wallet. Both rows locked in one transaction.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_withdraw(p_system text, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid       uuid := auth.uid();
  st        public.stations%rowtype;
  now_ms    bigint := app._now_ms();
  pstate    jsonb;
  credits   double precision;
  amt       bigint;
  treas     numeric;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_system is null or length(p_system) > 40 then
    return jsonb_build_object('ok', false, 'error', 'No station.');
  end if;

  amt := floor(coalesce(p_amount, 0));
  if amt <= 0 then return jsonb_build_object('ok', false, 'error', 'Invalid amount.'); end if;

  select * into st from public.stations where system_id = p_system for update;
  if not found or st.owner_id is distinct from uid then
    return jsonb_build_object('ok', false, 'error', 'Not your station.');
  end if;
  if st.status not in ('owned', 'refit') then
    return jsonb_build_object('ok', false, 'error', 'Not your station.');
  end if;
  if floor(st.treasury) < amt then
    return jsonb_build_object('ok', false, 'error', 'Invalid amount.');
  end if;

  pstate := app._lock_state(now_ms);
  credits := coalesce((pstate->>'credits')::float8, 0);

  treas := floor(st.treasury) - amt;
  update public.stations set treasury = greatest(0, treas), updated_at = now()
   where system_id = p_system;

  credits := credits + amt;
  pstate := jsonb_set(pstate, '{credits}', to_jsonb(credits));
  perform app._write_state(pstate, now_ms);

  return jsonb_build_object(
    'ok', true, 'amount', amt,
    'treasury', greatest(0, treas),
    'credits', credits
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Policy: tariffs and scrutiny. Treasury and standing are not client-writable.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_set_policy(p_system text, p_policy jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  st  public.stations%rowtype;
  pol jsonb := coalesce(p_policy, '{}'::jsonb);
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_system is null or length(p_system) > 40 then
    return jsonb_build_object('ok', false, 'error', 'No station.');
  end if;

  select * into st from public.stations where system_id = p_system for update;
  if not found or st.owner_id is distinct from uid then
    return jsonb_build_object('ok', false, 'error', 'Not your station.');
  end if;

  update public.stations set
    lease_tax_bps   = case when pol ? 'lease_tax_bps'
      then greatest(0, least(4000, coalesce((pol->>'lease_tax_bps')::int, lease_tax_bps)))
      else lease_tax_bps end,
    sale_tariff_bps = case when pol ? 'sale_tariff_bps'
      then greatest(0, least(1500, coalesce((pol->>'sale_tariff_bps')::int, sale_tariff_bps)))
      else sale_tariff_bps end,
    scrutiny        = case when pol ? 'scrutiny'
      then greatest(0, least(100, coalesce((pol->>'scrutiny')::int, scrutiny)))
      else scrutiny end,
    updated_at      = now()
  where system_id = p_system
  returning * into st;

  return jsonb_build_object(
    'ok', true,
    'lease_tax_bps', st.lease_tax_bps,
    'sale_tariff_bps', st.sale_tariff_bps,
    'scrutiny', st.scrutiny
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Hall buy — debit buyer credits server-side; tariff → treasury; seller paid live
-- or queued if they have no players row yet.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_buy_item(p_system text, p_listing_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid      uuid := auth.uid();
  now_ms   bigint := app._now_ms();
  l        public.station_listings%rowtype;
  st       public.stations%rowtype;
  pstate   jsonb;
  credits  double precision;
  bps      int;
  tariff   bigint;
  net      bigint;
  paid     boolean;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_listing_id !~ '^[0-9a-fA-F-]{36}$' then
    return jsonb_build_object('ok', false, 'error', 'Listing gone.');
  end if;

  select * into l from public.station_listings
   where id = p_listing_id::uuid and system_id = p_system
   for update;
  if not found or l.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'Listing gone.');
  end if;
  if l.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'Listing expired.');
  end if;
  if l.seller_id = uid then
    return jsonb_build_object('ok', false, 'error', 'That is your listing.');
  end if;

  select * into st from public.stations where system_id = p_system for update;
  bps    := greatest(0, least(1500, coalesce(st.sale_tariff_bps, 0)));
  tariff := floor(l.price * bps / 10000.0);
  net    := l.price - tariff;

  pstate  := app._lock_state(now_ms);
  credits := coalesce((pstate->>'credits')::float8, 0);
  if credits < l.price then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
  end if;
  credits := credits - l.price;
  pstate  := jsonb_set(pstate, '{credits}', to_jsonb(credits));
  perform app._write_state(pstate, now_ms);

  update public.station_listings
     set status = 'sold', buyer_id = uid, settled_at = now()
   where id = l.id;

  paid := app._credit_user(l.seller_id, net, now_ms);
  if not paid then
    insert into public.station_payouts (user_id, system_id, amount, reason, note)
    values (l.seller_id, p_system, net, 'sale', l.name);
  end if;

  if tariff > 0 and st.owner_id is not null then
    update public.stations
       set treasury = treasury + tariff, updated_at = now()
     where system_id = p_system;
  end if;

  return jsonb_build_object(
    'ok', true, 'id', l.id::text, 'kind', l.kind, 'name', l.name,
    'price', l.price, 'tariff', tariff, 'seller', l.seller_display,
    'payload', l.payload, 'credits', credits
  );
end;
$$;

-- Refund buyer when a sold listing payload can't be delivered client-side.
-- Inverse of app_station_buy_item: claw tariff from treasury, reverse seller
-- net (delete unclaimed payout or debit wallet), credit buyer full price.
-- Status 'refunded' is not reclaimed by app_station_settle's back CTE.
alter table public.station_listings drop constraint if exists station_listings_status_check;
alter table public.station_listings add constraint station_listings_status_check
  check (status in ('open','sold','cancelled','reclaimed','refunded'));

create or replace function public.app_station_buy_refund(p_listing_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid      uuid := auth.uid();
  now_ms   bigint := app._now_ms();
  l        public.station_listings%rowtype;
  st       public.stations%rowtype;
  pstate   jsonb;
  credits  double precision;
  bps      int;
  tariff   bigint;
  net      bigint;
  deleted  int;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_listing_id !~ '^[0-9a-fA-F-]{36}$' then
    return jsonb_build_object('ok', false, 'error', 'Listing gone.');
  end if;

  select * into l from public.station_listings
   where id = p_listing_id::uuid and buyer_id = uid and status = 'sold'
     and settled_at > now() - interval '5 minutes'
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Nothing to refund.');
  end if;

  select * into st from public.stations where system_id = l.system_id for update;
  bps    := greatest(0, least(1500, coalesce(st.sale_tariff_bps, 0)));
  tariff := floor(l.price * bps / 10000.0);
  net    := l.price - tariff;

  -- Prefer deleting an unclaimed sale payout; else claw from the seller's wallet.
  delete from public.station_payouts
   where id = (
     select id from public.station_payouts
      where user_id = l.seller_id and system_id = l.system_id
        and reason = 'sale' and claimed_at is null and amount = net
        and coalesce(note, '') = coalesce(l.name, '')
      order by created_at desc nulls last
      limit 1
      for update
   );
  get diagnostics deleted = row_count;
  if deleted = 0 and net > 0 then
    perform app._debit_user(l.seller_id, net, now_ms);
  end if;

  if tariff > 0 then
    update public.stations
       set treasury = greatest(0, treasury - tariff), updated_at = now()
     where system_id = l.system_id;
  end if;

  update public.station_listings set status = 'refunded' where id = l.id;

  pstate  := app._lock_state(now_ms);
  credits := coalesce((pstate->>'credits')::float8, 0) + l.price;
  pstate  := jsonb_set(pstate, '{credits}', to_jsonb(credits));
  perform app._write_state(pstate, now_ms);

  return jsonb_build_object('ok', true, 'credits', credits, 'refunded', l.price,
                            'tariff', tariff, 'net', net);
end;
$$;

-- ---------------------------------------------------------------------------
-- Settle — sale payouts credit wallets server-side. Legacy tariff payouts still
-- in the queue (pre-D0 sales) land in the station treasury when claimed.
-- ---------------------------------------------------------------------------
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
  cargo   jsonb;
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
    if row.reason = 'sale' then
      perform app._credit_user(uid, row.amount, now_ms);
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

  with tax as (
    update public.station_bay_tax
       set claimed_at = now()
     where owner_id = uid and claimed_at is null
     returning system_id, comm_id, qty
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'systemId', system_id, 'commId', comm_id, 'qty', qty)), '[]'::jsonb)
    into cargo from tax;

  pstate := app._lock_state(now_ms);
  credits := coalesce((pstate->>'credits')::float8, 0);

  return jsonb_build_object(
    'ok', true, 'payouts', pays, 'items', items, 'cargo', cargo, 'credits', credits
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Publish — preserve treasury, standing, and policy once the server owns them.
-- One-time treasury bootstrap when the server row is still zero.
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
  boot_treas numeric;
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

    boot_treas := greatest(0, least(500000000::numeric,
      floor(coalesce((r->>'treasury_bootstrap')::numeric, 0))));

    insert into public.stations as s (
      system_id, owner_id, owner_display, tier, status, modules, reactor_level,
      treasury, lease_tax_bps, sale_tariff_bps, scrutiny, standing, prod_comm,
      refit_until, hall, bays, updated_at
    )
    values (
      sid, uid, disp,
      coalesce(nullif(trim(coalesce(r->>'tier', '')), ''), 'Berth'),
      case when coalesce(r->>'status', '') in ('owned', 'refit') then r->>'status' else 'owned' end,
      case when jsonb_typeof(r->'modules') = 'object' then r->'modules' else '{}'::jsonb end,
      greatest(0, least(5, coalesce((r->>'reactor_level')::int, 0))),
      boot_treas,
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
      treasury        = case when s.treasury = 0 and boot_treas > 0 then boot_treas else s.treasury end,
      lease_tax_bps   = s.lease_tax_bps,
      sale_tariff_bps = s.sale_tariff_bps,
      scrutiny        = s.scrutiny,
      standing        = s.standing,
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

  select coalesce(jsonb_agg(jsonb_build_object(
           'system_id', system_id,
           'treasury', floor(treasury),
           'standing', round(standing))), '[]'::jsonb)
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

-- Stubs below are replaced by station_modules.sql (D3) and station_auctions.sql (D4).
create or replace function public.app_station_bid(p_system text, p_amount numeric)
returns jsonb language sql security definer as $$
  select jsonb_build_object('ok', false, 'error', 'Station auctions not live on server yet.');
$$;
create or replace function public.app_station_auction_open(p_system text, p_amount numeric)
returns jsonb language sql security definer as $$
  select jsonb_build_object('ok', false, 'error', 'Station auctions not live on server yet.');
$$;
create or replace function public.app_station_module_install(p_system text, p_module text)
returns jsonb language sql security definer as $$
  select jsonb_build_object('ok', false, 'error', 'Station modules not live on server yet.');
$$;

grant execute on function public.app_station_withdraw(text, numeric) to authenticated;
grant execute on function public.app_station_set_policy(text, jsonb) to authenticated;
grant execute on function public.app_station_buy_item(text, text) to authenticated;
grant execute on function public.app_station_buy_refund(text) to authenticated;
grant execute on function public.app_station_settle() to authenticated;
grant execute on function public.app_station_publish(jsonb) to authenticated;
