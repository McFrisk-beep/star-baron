-- Cross-player Exchange Hall (docs/STATIONS.md §14.1) — phase B of "stations are alive"
-- Requires: phase4_sector_stock.sql, station_directory.sql (phase A), profile_username.sql.
-- Safe to re-run (create or replace / if not exists).
--
-- Phase A published the station record, so a visitor sees another baron's shelf.
-- It was read-only: buying or listing would only have moved goods inside the
-- visitor's own copy of the station. This file moves the shelf itself to the
-- server, so a listing one baron puts up is the same listing another baron buys.
--
-- What the server owns here:
--   * the listing row, including the item payload while it sits in escrow
--   * the expiry clock (a client can't grant its own listing a longer shelf life)
--   * the tariff split at the moment of sale, off the station's published rate
--   * the payout queue — seller proceeds and the owner's tariff, claimed later
--
-- What the server still does NOT own: player credits. The buyer's client debits
-- itself after `app_station_buy_item` succeeds. A tampered client could take an
-- item without paying; it can't fabricate an item, spend someone else's escrow,
-- or pay itself, because the payload and the payout queue are both server-side.
-- Credits become authoritative in phase D with treasury/upkeep — that is also
-- when the debit moves inside this transaction.

-- ---------------------------------------------------------------------------
-- Tables. RLS on with no policies: everything goes through the RPCs below, so
-- a payload in escrow is never directly selectable by another player.
-- ---------------------------------------------------------------------------
create table if not exists public.station_listings (
  id             uuid primary key default gen_random_uuid(),
  system_id      text not null,
  seller_id      uuid not null references auth.users (id) on delete cascade,
  seller_display text not null default 'Baron',
  kind           text not null check (kind in ('gear','blackbox','extractor','component','ship','blueprint')),
  name           text not null,
  price          bigint not null check (price > 0),
  value          bigint not null default 0,
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'open'
    check (status in ('open','sold','cancelled','reclaimed')),
  buyer_id       uuid null,
  listed_at      timestamptz not null default now(),
  expires_at     timestamptz not null,
  settled_at     timestamptz null
);

create index if not exists station_listings_open_idx
  on public.station_listings (system_id) where status = 'open';
create index if not exists station_listings_seller_idx
  on public.station_listings (seller_id, status);

-- Proceeds owed to a player: sale money to the seller, tariff to the station
-- owner. Queued rather than paid live because credits are still client-side —
-- the owner may well be offline when their tariff is charged.
create table if not exists public.station_payouts (
  id         bigserial primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  system_id  text not null,
  amount     bigint not null check (amount > 0),
  reason     text not null check (reason in ('sale','tariff')),
  note       text not null default '',
  created_at timestamptz not null default now(),
  claimed_at timestamptz null
);

create index if not exists station_payouts_unclaimed_idx
  on public.station_payouts (user_id) where claimed_at is null;

alter table public.station_listings enable row level security;
alter table public.station_payouts  enable row level security;

-- ---------------------------------------------------------------------------
-- Read: the shelf. Anon too — phase A already shows signed-out visitors who
-- holds a station, and a shelf they can see is the reason to make an account.
-- The payload stays out of this: it only ever leaves on a buy or a reclaim.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_hall(p_systems text[])
returns table (
  id         text,
  system_id  text,
  seller_id  uuid,
  seller     text,
  kind       text,
  name       text,
  price      bigint,
  value      bigint,
  listed_at  timestamptz,
  expires_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select l.id::text, l.system_id, l.seller_id, l.seller_display, l.kind, l.name,
         l.price, l.value, l.listed_at, l.expires_at
    from public.station_listings l
   where l.status = 'open'
     and l.expires_at > now()
     and l.system_id = any(coalesce(p_systems, '{}'::text[]))
   order by l.system_id, l.listed_at
   limit 400;
$$;

grant execute on function public.app_station_hall(text[]) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Write: put an item on another baron's shelf (or your own).
--
-- Everything the client sends about the *station* is ignored — the module, the
-- status and the tariff are read from public.stations, which only the owner can
-- write (phase A). The client is trusted for the payload's contents only: it
-- describes an item that came out of the seller's own save, and the buyer's
-- client re-types and re-prices it on delivery the same way it re-types a
-- directory row. It is not trusted for anything that moves credits.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_list_item(p_system text, p_listing jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid     uuid := auth.uid();
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
  -- An owner who stopped playing shouldn't hold other players' goods in escrow.
  if st.updated_at < now() - interval '30 days' then
    return jsonb_build_object('ok', false, 'error', 'Station has gone dark.');
  end if;
  if v_kind = 'blackbox' and coalesce((st.modules->>'black_market')::int, 0) < 1 then
    return jsonb_build_object('ok', false, 'error', 'Blackboxes need a Black Market.');
  end if;
  if v_kind not in ('gear','blackbox','extractor','component','ship','blueprint') then
    return jsonb_build_object('ok', false, 'error', 'Unsupported listing type.');
  end if;

  v_price := floor(coalesce((p_listing->>'price')::numeric, 0));
  if v_price < 50 then return jsonb_build_object('ok', false, 'error', 'Price at least 50c.'); end if;
  if v_price > 1000000000 then return jsonb_build_object('ok', false, 'error', 'Price too high.'); end if;
  v_value := greatest(0, least(1000000000, floor(coalesce((p_listing->>'value')::numeric, 0))));
  if v_name = '' then v_name := 'Listing'; end if;
  -- A payload is one item, not a save file.
  if pg_column_size(v_load) > 8192 then
    return jsonb_build_object('ok', false, 'error', 'Listing payload too large.');
  end if;

  -- Stall caps: the shelf is a marketplace, not a storage locker.
  select count(*) into n_open from public.station_listings
   where system_id = p_system and status = 'open' and expires_at > now();
  if n_open >= 40 then return jsonb_build_object('ok', false, 'error', 'Shelf is full.'); end if;
  select count(*) into n_open from public.station_listings
   where system_id = p_system and seller_id = uid and status = 'open' and expires_at > now();
  if n_open >= 8 then return jsonb_build_object('ok', false, 'error', 'You already have 8 stalls here.'); end if;

  select username, join_n into uname, jn from public.profiles where user_id = uid;
  disp := case
    when uname is not null and length(trim(uname)) > 0 then trim(uname)
    when jn is not null and jn > 0 then 'Baron #' || jn::text
    else 'Baron'
  end;

  -- Server clock, always: STATIONCFG.hallListMs is 48h in the client too, but
  -- the client doesn't get to decide how long its own stall stands.
  v_exp := now() + interval '48 hours';

  insert into public.station_listings
    (system_id, seller_id, seller_display, kind, name, price, value, payload, expires_at)
  values (p_system, uid, disp, v_kind, v_name, v_price, v_value, v_load, v_exp)
  returning id into new_id;

  return jsonb_build_object('ok', true, 'id', new_id::text, 'expires_at', v_exp,
                            'seller', disp, 'price', v_price);
end;
$$;

-- ---------------------------------------------------------------------------
-- Buy. One transaction takes the listing off the shelf, splits the price at the
-- station's published tariff, queues both sides, and hands the payload to the
-- buyer. `for update` is what makes two barons clicking the same stall safe:
-- the loser sees 'Listing gone.' instead of a second copy of the item.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_buy_item(p_system text, p_listing_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid      uuid := auth.uid();
  l        public.station_listings%rowtype;
  st       public.stations%rowtype;
  bps      int;
  tariff   bigint;
  net      bigint;
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

  select * into st from public.stations where system_id = p_system;
  bps    := greatest(0, least(1500, coalesce(st.sale_tariff_bps, 0)));
  tariff := floor(l.price * bps / 10000.0);
  net    := l.price - tariff;

  update public.station_listings
     set status = 'sold', buyer_id = uid, settled_at = now()
   where id = l.id;

  insert into public.station_payouts (user_id, system_id, amount, reason, note)
  values (l.seller_id, p_system, net, 'sale', l.name);

  -- The tariff is the owner's cut of a sale made on their station. It lands in
  -- the station treasury when they claim it, not in their wallet (§9).
  if tariff > 0 and st.owner_id is not null then
    insert into public.station_payouts (user_id, system_id, amount, reason, note)
    values (st.owner_id, p_system, tariff, 'tariff', l.name);
  end if;

  return jsonb_build_object(
    'ok', true, 'id', l.id::text, 'kind', l.kind, 'name', l.name,
    'price', l.price, 'tariff', tariff, 'seller', l.seller_display,
    'payload', l.payload
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Cancel. The seller pulls their own stall; the station owner may clear one off
-- their shelf but never receives the goods — the item goes back to whoever put
-- it up, through the reclaim half of app_station_settle.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_cancel_listing(p_listing_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  l   public.station_listings%rowtype;
  own uuid;
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

  -- Ours: hand it straight back, settled in the same breath. Someone else's:
  -- park it as cancelled so they reclaim it on their next sync.
  update public.station_listings
     set status = case when l.seller_id = uid then 'reclaimed' else 'cancelled' end,
         settled_at = now()
   where id = l.id;

  if l.seller_id = uid then
    return jsonb_build_object('ok', true, 'kind', l.kind, 'name', l.name, 'payload', l.payload);
  end if;
  return jsonb_build_object('ok', true, 'cleared', true, 'name', l.name);
end;
$$;

-- ---------------------------------------------------------------------------
-- Settle: everything the shelf owes this player, in one round trip.
--   payouts — sale proceeds and tariffs, marked claimed as they're handed over
--   items   — payloads of our listings that expired or were cleared by the owner
-- Both are marked settled in the same statement that returns them, so a second
-- call can't pay twice. The client's job is to bank what it receives before its
-- next save; anything it can't fit goes into the local unclaimed pouch.
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

  return jsonb_build_object('ok', true, 'payouts', pays, 'items', items);
end;
$$;

-- Postgres grants execute to PUBLIC by default, which hands anon a call on
-- every one of these. They all bail on a null auth.uid(), so this is belt and
-- braces — but the shelf moves goods now, and the write path should be reachable
-- only by the role that can actually own any of it.
revoke execute on function public.app_station_list_item(text, jsonb)  from public;
revoke execute on function public.app_station_buy_item(text, text)    from public;
revoke execute on function public.app_station_cancel_listing(text)    from public;
revoke execute on function public.app_station_settle()                from public;

grant execute on function public.app_station_list_item(text, jsonb)   to authenticated;
grant execute on function public.app_station_buy_item(text, text)     to authenticated;
grant execute on function public.app_station_cancel_listing(text)     to authenticated;
grant execute on function public.app_station_settle()                 to authenticated;
