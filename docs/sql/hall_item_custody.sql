-- hall_item_custody.sql — server-authoritative Exchange Hall custody (Critical C2).
--
-- THE BUG: app_station_list_item inserted a client-supplied payload but never
-- validated the seller owned the item and never removed it from the seller's
-- server-side state. Because app_commit force-restores items/ships/extractors/
-- components from the server row, the "listed" item reappeared in the seller's
-- inventory on the next autosave — while the buyer's real credits were debited
-- and the payload they received was wiped by their own next commit. Net: the
-- seller kept the item AND collected the buyer's money (repeatable ×8 stalls),
-- and a tampered client could list best-in-catalog gear it never owned.
--
-- THE FIX: make the hall move goods for real, mirroring the client's local
-- custody (_takeListable / _deliverListable / _restoreListable in js/stations.js):
--   • list  — validate the seller owns it, REMOVE it from their state, and escrow
--             the SERVER's authoritative copy as the listing payload.
--   • buy   — DELIVER the escrowed item into the buyer's state.
--   • cancel(own) / settle(expired|cleared) — RESTORE it to the seller's state.
--   • buy_refund — REMOVE it from the buyer and route it back to the seller.
--
-- These are SQL-only; the client already does the matching local mutations, so
-- applying (or not applying) this file only changes whether they're authoritative.
-- No client version is required.
--
-- APPLY LAST — after station_hall.sql, station_treasury.sql, station_bays.sql,
-- station_economy_trust.sql and station_contracts.sql, so these definitions win.
-- The function bodies below are the currently-deployed versions plus the custody
-- lines; re-running is safe.

-- ===========================================================================
-- Shared custody helpers (app schema — NOT client-callable).
-- ===========================================================================

-- Remove one item from a player state by listing kind, returning the removed
-- (authoritative) copy. { found: bool, item: jsonb, state: jsonb, error: text }.
create or replace function app._state_remove_item(p_state jsonb, p_kind text, p_uid text)
returns jsonb
language plpgsql as $$
declare
  it jsonb;
begin
  if p_uid is null or p_uid = '' then
    return jsonb_build_object('found', false, 'error', 'No item id.');
  end if;

  if p_kind in ('gear', 'blackbox') then
    it := p_state->'items'->p_uid;
    if it is null then return jsonb_build_object('found', false, 'error', 'You don''t hold that item.'); end if;
    -- Equipped gear is referenced in a ship's accessories — don't sell it out from under the hull.
    if exists (
      select 1 from jsonb_array_elements(coalesce(p_state->'ships', '[]'::jsonb)) s(v)
       where s.v->'accessories' @> to_jsonb(p_uid)
    ) then
      return jsonb_build_object('found', false, 'error', 'Unequip it first.');
    end if;
    return jsonb_build_object('found', true, 'item', it,
      'state', jsonb_set(p_state, '{items}', coalesce(p_state->'items', '{}'::jsonb) - p_uid));

  elsif p_kind = 'extractor' then
    it := p_state->'extractors'->p_uid;
    if it is null then return jsonb_build_object('found', false, 'error', 'Extractor not found.'); end if;
    return jsonb_build_object('found', true, 'item', it,
      'state', jsonb_set(p_state, '{extractors}', coalesce(p_state->'extractors', '{}'::jsonb) - p_uid));

  elsif p_kind = 'component' then
    it := p_state->'components'->p_uid;
    if it is null then return jsonb_build_object('found', false, 'error', 'Component not found.'); end if;
    return jsonb_build_object('found', true, 'item', it,
      'state', jsonb_set(p_state, '{components}', coalesce(p_state->'components', '{}'::jsonb) - p_uid));

  elsif p_kind = 'ship' then
    select s.v into it from jsonb_array_elements(coalesce(p_state->'ships', '[]'::jsonb)) s(v)
      where s.v->>'uid' = p_uid limit 1;
    if it is null then return jsonb_build_object('found', false, 'error', 'Ship not found.'); end if;
    if it->>'status' is distinct from 'idle' then
      return jsonb_build_object('found', false, 'error', 'Ship must be idle.');
    end if;
    if coalesce((it->>'mercenary')::boolean, false) then
      return jsonb_build_object('found', false, 'error', 'Can''t list a mercenary.');
    end if;
    return jsonb_build_object('found', true, 'item', it,
      'state', jsonb_set(p_state, '{ships}', (
        select coalesce(jsonb_agg(s.v), '[]'::jsonb)
          from jsonb_array_elements(coalesce(p_state->'ships', '[]'::jsonb)) s(v)
         where s.v->>'uid' <> p_uid
      )));
  end if;

  return jsonb_build_object('found', false, 'error', 'Unsupported listing type.');
end;
$$;

-- Add one item to a player state by listing kind (idempotent per uid / recipe).
create or replace function app._state_add_item(p_state jsonb, p_kind text, p_item jsonb)
returns jsonb
language plpgsql as $$
declare
  uid text := p_item->>'uid';
  rid text := p_item->>'recipeId';
begin
  if p_item is null or jsonb_typeof(p_item) = 'null' then return p_state; end if;

  if p_kind in ('gear', 'blackbox') then
    if uid is null then return p_state; end if;
    return jsonb_set(p_state, '{items}',
      coalesce(p_state->'items', '{}'::jsonb) || jsonb_build_object(uid, p_item));
  elsif p_kind = 'extractor' then
    if uid is null then return p_state; end if;
    return jsonb_set(p_state, '{extractors}',
      coalesce(p_state->'extractors', '{}'::jsonb) || jsonb_build_object(uid, p_item));
  elsif p_kind = 'component' then
    if uid is null then return p_state; end if;
    return jsonb_set(p_state, '{components}',
      coalesce(p_state->'components', '{}'::jsonb) || jsonb_build_object(uid, p_item));
  elsif p_kind = 'ship' then
    if uid is null then return p_state; end if;
    if exists (select 1 from jsonb_array_elements(coalesce(p_state->'ships', '[]'::jsonb)) s(v)
                where s.v->>'uid' = uid) then
      return p_state;
    end if;
    return jsonb_set(p_state, '{ships}',
      coalesce(p_state->'ships', '[]'::jsonb) || jsonb_build_array(p_item));
  elsif p_kind = 'blueprint' then
    if rid is null then return p_state; end if;
    if coalesce(p_state->'knownRecipes', '[]'::jsonb) @> to_jsonb(rid) then return p_state; end if;
    return jsonb_set(p_state, '{knownRecipes}',
      coalesce(p_state->'knownRecipes', '[]'::jsonb) || to_jsonb(rid));
  end if;
  return p_state;
end;
$$;

-- ===========================================================================
-- list — validate ownership + remove from seller; escrow the server copy.
-- ===========================================================================
create or replace function public.app_station_list_item(p_system text, p_listing jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid     uuid := auth.uid();
  now_ms  bigint := app._now_ms();
  st      public.stations%rowtype;
  uname   text;
  jn      bigint;
  disp    text;
  v_kind  text := coalesce(p_listing->>'kind', '');
  v_name  text := left(trim(coalesce(p_listing->>'name', '')), 48);
  v_price bigint;
  v_value bigint;
  v_load  jsonb := case when jsonb_typeof(p_listing->'payload') in ('object','array')
                        then p_listing->'payload' else '{}'::jsonb end;
  v_uid   text := coalesce((case when jsonb_typeof(p_listing->'payload') = 'object'
                                 then p_listing->'payload'->>'uid' else null end), '');
  v_rem   jsonb;
  pstate  jsonb;
  n_open  int;
  new_id  uuid;
  v_exp   timestamptz;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;

  select * into st from public.stations where system_id = p_system;
  if not found or st.owner_id is null or st.status <> 'owned' then
    return jsonb_build_object('ok', false, 'error', 'No Exchange Hall here.');
  end if;
  if coalesce((st.modules->>'exchange_hall')::int, 0) < 1 then
    return jsonb_build_object('ok', false, 'error', 'No Exchange Hall here.');
  end if;
  if st.updated_at < now() - interval '30 days' then
    return jsonb_build_object('ok', false, 'error', 'Station has gone dark.');
  end if;
  if v_kind = 'blackbox' and coalesce((st.modules->>'black_market')::int, 0) < 1 then
    return jsonb_build_object('ok', false, 'error', 'Blackboxes need a Black Market.');
  end if;
  -- Blueprints are knowledge, not stock — never sellable (matches _takeListable).
  if v_kind = 'blueprint' then
    return jsonb_build_object('ok', false, 'error', 'Blueprints can''t be sold.');
  end if;
  if v_kind not in ('gear','blackbox','extractor','component','ship') then
    return jsonb_build_object('ok', false, 'error', 'Unsupported listing type.');
  end if;

  v_price := floor(coalesce((p_listing->>'price')::numeric, 0));
  if v_price < 50 then return jsonb_build_object('ok', false, 'error', 'Price at least 50c.'); end if;
  if v_price > 1000000000 then return jsonb_build_object('ok', false, 'error', 'Price too high.'); end if;
  v_value := greatest(0, least(1000000000, floor(coalesce((p_listing->>'value')::numeric, 0))));
  if v_name = '' then v_name := 'Listing'; end if;

  -- Stall caps: the shelf is a marketplace, not a storage locker.
  select count(*) into n_open from public.station_listings
   where system_id = p_system and status = 'open' and expires_at > now();
  if n_open >= 40 then return jsonb_build_object('ok', false, 'error', 'Shelf is full.'); end if;
  select count(*) into n_open from public.station_listings
   where system_id = p_system and seller_id = uid and status = 'open' and expires_at > now();
  if n_open >= 8 then return jsonb_build_object('ok', false, 'error', 'You already have 8 stalls here.'); end if;

  -- CUSTODY (Critical C2): the item must actually LEAVE the seller's state, and
  -- the escrowed payload is the SERVER's copy — a tampered client can no longer
  -- list gear it doesn't own, nor keep a duplicate after listing.
  pstate := app._lock_state(now_ms);
  v_rem  := app._state_remove_item(pstate, v_kind, v_uid);
  if not coalesce((v_rem->>'found')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', coalesce(v_rem->>'error', 'You don''t hold that item.'));
  end if;
  v_load := v_rem->'item';                       -- escrow the authoritative copy
  if pg_column_size(v_load) > 8192 then
    return jsonb_build_object('ok', false, 'error', 'Listing payload too large.');
  end if;
  perform app._write_state(v_rem->'state', now_ms);

  select username, join_n into uname, jn from public.profiles where user_id = uid;
  disp := case
    when uname is not null and length(trim(uname)) > 0 then trim(uname)
    when jn is not null and jn > 0 then 'Baron #' || jn::text
    else 'Baron'
  end;

  -- Server clock, always: 48h stall regardless of what the client claims.
  v_exp := now() + interval '48 hours';

  insert into public.station_listings
    (system_id, seller_id, seller_display, kind, name, price, value, payload, expires_at)
  values (p_system, uid, disp, v_kind, v_name, v_price, v_value, v_load, v_exp)
  returning id into new_id;

  return jsonb_build_object('ok', true, 'id', new_id::text, 'expires_at', v_exp,
                            'seller', disp, 'price', v_price);
end;
$$;

-- ===========================================================================
-- buy — deliver the escrowed item into the buyer's state (+ existing money flow).
-- ===========================================================================
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
  -- CUSTODY (Critical C2): the buyer actually RECEIVES the item server-side.
  pstate  := app._state_add_item(pstate, l.kind, l.payload);
  perform app._write_state(pstate, now_ms);

  update public.station_listings
     set status = 'sold', buyer_id = uid, settled_at = now()
   where id = l.id;

  paid := app._credit_user(l.seller_id, net, now_ms);
  if not paid then
    insert into public.station_payouts (user_id, system_id, amount, reason, note)
    values (l.seller_id, p_system, net, 'sale', l.id::text);
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

-- ===========================================================================
-- cancel — a seller reclaiming their OWN stall gets the item back immediately.
-- (An owner clearing someone else's stall still parks it 'cancelled'; that
--  seller reclaims via app_station_settle below.)
-- ===========================================================================
create or replace function public.app_station_cancel_listing(p_listing_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid    uuid := auth.uid();
  now_ms bigint := app._now_ms();
  l      public.station_listings%rowtype;
  own    uuid;
  pstate jsonb;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_listing_id !~ '^[0-9a-fA-F-]{36}$' then
    return jsonb_build_object('ok', false, 'error', 'Listing gone.');
  end if;

  select * into l from public.station_listings where id = p_listing_id::uuid for update;
  if not found or l.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'Listing gone.');
  end if;

  select owner_id into own from public.stations where system_id = l.system_id;
  if l.seller_id <> uid and own is distinct from uid then
    return jsonb_build_object('ok', false, 'error', 'Not your listing.');
  end if;

  update public.station_listings
     set status = case when l.seller_id = uid then 'reclaimed' else 'cancelled' end,
         settled_at = now()
   where id = l.id;

  if l.seller_id = uid then
    -- CUSTODY (Critical C2): restore the escrowed item to us right now.
    pstate := app._lock_state(now_ms);
    pstate := app._state_add_item(pstate, l.kind, l.payload);
    perform app._write_state(pstate, now_ms);
    return jsonb_build_object('ok', true, 'kind', l.kind, 'name', l.name, 'payload', l.payload);
  end if;
  return jsonb_build_object('ok', true, 'cleared', true, 'name', l.name);
end;
$$;

-- ===========================================================================
-- settle — reclaim expired/cleared listings back into the seller's state
-- (keeps all existing payout + bay-tax behavior; only adds the item restore).
-- ===========================================================================
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
  taken   bigint;
  deposited boolean;
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
      taken := app._debit_user(uid, row.amount, now_ms);
      if taken < row.amount then
        if taken > 0 then
          update public.station_payouts
             set amount = row.amount - taken where id = row.id;
        end if;
        continue;
      end if;
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
    deposited := false;
    update public.stations
       set hold = public._station_hold_add(hold, row.comm_id, row.qty), updated_at = now()
     where system_id = row.system_id and owner_id = uid;
    if found then
      deposited := true;
      holds := holds || jsonb_build_object(
        row.system_id, (select hold from public.stations where system_id = row.system_id));
    else
      perform app._credit_positions(uid, row.comm_id, row.qty, now_ms);
    end if;
    update public.station_bay_tax set claimed_at = now() where id = row.id;
    cargo := cargo || jsonb_build_array(jsonb_build_object(
      'systemId', row.system_id, 'commId', row.comm_id, 'qty', row.qty,
      'toPositions', not deposited));
  end loop;

  pstate := app._lock_state(now_ms);
  -- CUSTODY (Critical C2): fold reclaimed listing items back into our state so
  -- the client's local restore isn't erased by the next app_commit.
  if jsonb_array_length(items) > 0 then
    for row in select value from jsonb_array_elements(items) loop
      pstate := app._state_add_item(pstate, row.value->>'kind', row.value->'payload');
    end loop;
    perform app._write_state(pstate, now_ms);
  end if;
  credits := coalesce((pstate->>'credits')::float8, 0);

  return jsonb_build_object(
    'ok', true, 'payouts', pays, 'items', items, 'cargo', cargo,
    'holds', holds, 'credits', credits,
    'positions', coalesce(pstate->'positions', '{}'::jsonb),
    'avgCost', coalesce(pstate->'avgCost', '{}'::jsonb)
  );
end;
$$;

-- ===========================================================================
-- buy_refund — reverse a mistaken buy: remove the item from the buyer and,
-- only when that succeeds, route it back to the seller (via 'cancelled', which
-- settle reclaims). If the buyer already moved/equipped it, fall back to the
-- credit-only refund ('refunded') so an item can never be duplicated.
-- ===========================================================================
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
  taken    bigint;
  shortfall bigint;
  v_rem    jsonb;
  restored boolean := false;
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

  -- CUSTODY (Critical C2): take the item back out of the buyer first.
  pstate := app._lock_state(now_ms);
  v_rem  := app._state_remove_item(pstate, l.kind, coalesce(l.payload->>'uid', ''));
  restored := coalesce((v_rem->>'found')::boolean, false);
  if restored then pstate := v_rem->'state'; end if;

  -- Reverse the seller's proceeds (delete the unclaimed payout, else claw wallet).
  delete from public.station_payouts
   where id = (
     select id from public.station_payouts
      where user_id = l.seller_id and system_id = l.system_id
        and reason = 'sale' and claimed_at is null and amount = net
        and (note = l.id::text or note = coalesce(l.name, ''))
      order by case when note = l.id::text then 0 else 1 end, created_at desc nulls last
      limit 1
      for update
   );
  get diagnostics deleted = row_count;
  if deleted = 0 and net > 0 then
    taken := app._debit_user(l.seller_id, net, now_ms);
    shortfall := net - coalesce(taken, 0);
    if shortfall > 0 then
      insert into public.station_payouts (user_id, system_id, amount, reason, note)
      values (l.seller_id, l.system_id, shortfall, 'refund_owed', l.id::text);
    end if;
  end if;

  if tariff > 0 then
    update public.stations
       set treasury = greatest(0, treasury - tariff), updated_at = now()
     where system_id = l.system_id;
  end if;

  -- Only hand the item back to the seller if we actually pulled it from the buyer,
  -- so it can never exist in two places. 'cancelled' → seller reclaims via settle.
  update public.station_listings
     set status = case when restored then 'cancelled' else 'refunded' end,
         buyer_id = null
   where id = l.id;

  credits := coalesce((pstate->>'credits')::float8, 0) + l.price;
  pstate  := jsonb_set(pstate, '{credits}', to_jsonb(credits));
  perform app._write_state(pstate, now_ms);

  return jsonb_build_object('ok', true, 'credits', credits, 'refunded', l.price,
                            'tariff', tariff, 'net', net);
end;
$$;

grant execute on function public.app_station_list_item(text, jsonb)     to authenticated;
grant execute on function public.app_station_buy_item(text, text)       to authenticated;
grant execute on function public.app_station_cancel_listing(text)       to authenticated;
grant execute on function public.app_station_settle()                   to authenticated;
grant execute on function public.app_station_buy_refund(text)           to authenticated;
revoke execute on function public.app_station_list_item(text, jsonb)    from public;
revoke execute on function public.app_station_buy_item(text, text)      from public;
revoke execute on function public.app_station_cancel_listing(text)      from public;
revoke execute on function public.app_station_settle()                  from public;
revoke execute on function public.app_station_buy_refund(text)          from public;
