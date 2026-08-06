-- Station auctions (docs/STATIONS.md §5.2) — phase D4
-- Requires: station_treasury.sql (app._lock_state / app._credit_user),
--           station_modules.sql (module cost helpers).
-- Safe to re-run (create or replace / if not exists).
--
-- Cross-player auction escrow: opening bid and raises debit players.state;
-- outbids refund immediately. Close runs on bid/read via app_station_close_due.

create table if not exists public.station_auctions (
  system_id    text primary key,
  status       text not null default 'open'
    check (status in ('open', 'closed', 'cancelled', 'forfeit')),
  opens_at     timestamptz not null default now(),
  closes_at    timestamptz not null,
  high_bid     bigint not null check (high_bid > 0),
  high_bidder  uuid null references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists station_auctions_open_idx
  on public.station_auctions (closes_at) where status = 'open';

alter table public.station_auctions enable row level security;
-- No policies — reads/writes via SECURITY DEFINER RPCs only.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public._station_owner_cap(p_tier int)
returns int language sql immutable as $$
  select case greatest(0, least(coalesce(p_tier, 0), 6))
    when 0 then 1 when 1 then 1 when 2 then 1 when 3 then 2 when 4 then 2 when 5 then 2 else 3 end;
$$;

create or replace function public._station_module_value(p_modules jsonb, p_reactor int)
returns bigint language plpgsql immutable as $$
declare
  m jsonb := coalesce(p_modules, '{}'::jsonb);
  k text;
  lvl int;
  v bigint := 0;
  i int;
begin
  for k, lvl in select key, (value#>>'{}')::int from jsonb_each(m) loop
    for i in 1..greatest(0, lvl) loop
      v := v + coalesce(public._station_module_cost(k, i), 0);
    end loop;
  end loop;
  for i in 1..greatest(0, least(5, coalesce(p_reactor, 0))) loop
    v := v + coalesce(public._station_module_cost('reactor', i), 0);
  end loop;
  return v;
end;
$$;

create or replace function public._station_opening_bid(
  p_tier text, p_modules jsonb, p_reactor int
) returns bigint language sql immutable as $$
  select greatest(50000::bigint,
    (round((150000
      + public._station_tier_rank(p_tier) * 100000
      + public._station_module_value(p_modules, p_reactor) * 0.5) / 50000.0) * 50000)::bigint);
$$;

create or replace function public._station_owned_count(p_uid uuid)
returns int language sql stable as $$
  select count(*)::int from public.stations
   where owner_id = p_uid and status in ('owned', 'refit');
$$;

create or replace function public._station_escrow_total(p_uid uuid)
returns bigint language sql stable as $$
  select coalesce(sum(high_bid), 0)::bigint from public.station_auctions
   where status = 'open' and high_bidder = p_uid;
$$;

-- ---------------------------------------------------------------------------
-- Read open auctions (anon + authenticated).
-- ---------------------------------------------------------------------------
create or replace function public.app_station_auctions()
returns table (
  system_id   text,
  status      text,
  opens_at    timestamptz,
  closes_at   timestamptz,
  high_bid    bigint,
  high_bidder uuid
)
language sql security definer stable set search_path = public as $$
  select system_id, status, opens_at, closes_at, high_bid, high_bidder
  from public.station_auctions
  where status = 'open' and closes_at > now()
  order by system_id
  limit 200;
$$;

grant execute on function public.app_station_auctions() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Close due auctions — refunds forfeits, transfers ownership.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_close_due()
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  a         public.station_auctions%rowtype;
  st        public.stations%rowtype;
  tier      int;
  cap       int;
  owned     int;
  closed    jsonb := '[]'::jsonb;
begin
  for a in
    select * from public.station_auctions
     where status = 'open' and closes_at <= now()
     for update
  loop
    select * into st from public.stations where system_id = a.system_id for update;

    if a.high_bidder is null then
      update public.station_auctions set status = 'closed' where system_id = a.system_id;
      continue;
    end if;

    select coalesce((state->'prestige'->>'tier')::int, 0) into tier
      from public.players where user_id = a.high_bidder for update;

    if not found then
      update public.station_auctions set status = 'forfeit' where system_id = a.system_id;
      closed := closed || jsonb_build_array(jsonb_build_object(
        'system_id', a.system_id, 'outcome', 'forfeit', 'bidder', a.high_bidder));
      continue;
    end if;

    cap := public._station_owner_cap(tier);
    owned := public._station_owned_count(a.high_bidder);

    if owned >= cap then
      perform app._credit_user(a.high_bidder, a.high_bid, app._now_ms());
      update public.station_auctions set status = 'forfeit' where system_id = a.system_id;
      closed := closed || jsonb_build_array(jsonb_build_object(
        'system_id', a.system_id, 'outcome', 'forfeit', 'bidder', a.high_bidder));
      continue;
    end if;

    -- Winner: credits sunk (no refund). Claim station.
    insert into public.stations (system_id, owner_id, tier, status, standing,
      modules, reactor_level, updated_at)
    values (a.system_id, a.high_bidder,
      coalesce(st.tier, 'Berth'), 'owned', 60,
      coalesce(st.modules, '{}'::jsonb), coalesce(st.reactor_level, 0), now())
    on conflict (system_id) do update set
      owner_id = excluded.owner_id,
      status = 'owned',
      standing = 60,
      updated_at = now();

    update public.station_auctions set status = 'closed' where system_id = a.system_id;
    closed := closed || jsonb_build_array(jsonb_build_object(
      'system_id', a.system_id, 'outcome', 'won', 'bidder', a.high_bidder, 'amount', a.high_bid));
  end loop;

  return jsonb_build_object('ok', true, 'closed', closed);
end;
$$;

grant execute on function public.app_station_close_due() to authenticated;

-- ---------------------------------------------------------------------------
-- Open auction on an NPC / unowned station.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_auction_open(p_system text, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid       uuid := auth.uid();
  st        public.stations%rowtype;
  min_bid   bigint;
  amt       bigint;
  now_ms    bigint := app._now_ms();
  pstate    jsonb;
  credits   double precision;
  escrow    bigint;
  tier      int;
  cap       int;
  dur_ms    bigint := 72 * 3600 * 1000;
  closes    timestamptz;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_system is null or length(p_system) > 40 then
    return jsonb_build_object('ok', false, 'error', 'No station.');
  end if;

  perform public.app_station_close_due();

  if exists (select 1 from public.station_auctions where system_id = p_system and status = 'open') then
    return jsonb_build_object('ok', false, 'error', 'Auction already open.');
  end if;

  select * into st from public.stations where system_id = p_system;
  if found and st.owner_id is not null and st.status in ('owned', 'refit') then
    return jsonb_build_object('ok', false, 'error', 'Already owned.');
  end if;
  if found and st.status = 'cooldown' and st.cooldown_until > now() then
    return jsonb_build_object('ok', false, 'error', 'Station is cooling down after a revolt.');
  end if;

  min_bid := public._station_opening_bid(
    coalesce(st.tier, 'Berth'),
    coalesce(st.modules, '{}'::jsonb),
    coalesce(st.reactor_level, 0));
  amt := floor(coalesce(p_amount, 0));
  if amt < min_bid then
    return jsonb_build_object('ok', false, 'error', 'Opening bid too low.', 'min', min_bid);
  end if;

  pstate := app._lock_state(now_ms);
  tier := coalesce((pstate->'prestige'->>'tier')::int, 0);
  cap := public._station_owner_cap(tier);
  if public._station_owned_count(uid) >= cap then
    return jsonb_build_object('ok', false, 'error', 'Station ownership cap reached for your tier.');
  end if;

  credits := coalesce((pstate->>'credits')::float8, 0);
  escrow := public._station_escrow_total(uid);
  if credits - escrow < amt then
    return jsonb_build_object('ok', false, 'error', 'Not enough free credits (escrow counts).');
  end if;

  credits := credits - amt;
  pstate := jsonb_set(pstate, '{credits}', to_jsonb(credits));
  perform app._write_state(pstate, now_ms);

  closes := now() + (dur_ms || ' milliseconds')::interval;

  insert into public.station_auctions (system_id, status, opens_at, closes_at, high_bid, high_bidder)
  values (p_system, 'open', now(), closes, amt, uid)
  on conflict (system_id) do update set
    status = 'open', opens_at = now(), closes_at = excluded.closes_at,
    high_bid = excluded.high_bid, high_bidder = excluded.high_bidder;

  return jsonb_build_object(
    'ok', true, 'system_id', p_system, 'high_bid', amt, 'closes_at', closes,
    'credits', credits
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Place bid — refund previous high bidder, anti-snipe extension.
-- ---------------------------------------------------------------------------
create or replace function public.app_station_bid(p_system text, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  uid       uuid := auth.uid();
  a         public.station_auctions%rowtype;
  amt       bigint;
  min_bid   bigint;
  need      bigint;
  escrow    bigint;
  now_ms    bigint := app._now_ms();
  pstate    jsonb;
  credits   double precision;
  tier      int;
  cap       int;
  anti_ms   bigint := 30 * 60 * 1000;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if p_system is null or length(p_system) > 40 then
    return jsonb_build_object('ok', false, 'error', 'No station.');
  end if;

  perform public.app_station_close_due();

  select * into a from public.station_auctions where system_id = p_system for update;
  if not found or a.status <> 'open' or a.closes_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'No open auction.');
  end if;

  amt := floor(coalesce(p_amount, 0));
  min_bid := a.high_bid + 50000;
  if amt < min_bid then
    return jsonb_build_object('ok', false, 'error', 'Bid too low.', 'min', min_bid);
  end if;

  pstate := app._lock_state(now_ms);
  tier := coalesce((pstate->'prestige'->>'tier')::int, 0);
  cap := public._station_owner_cap(tier);
  if a.high_bidder is distinct from uid and public._station_owned_count(uid) >= cap then
    return jsonb_build_object('ok', false, 'error', 'Station ownership cap reached for your tier.');
  end if;

  need := amt;
  if a.high_bidder = uid then need := amt - a.high_bid; end if;
  escrow := public._station_escrow_total(uid) - case when a.high_bidder = uid then a.high_bid else 0 end;
  credits := coalesce((pstate->>'credits')::float8, 0);
  if credits - escrow < need then
    return jsonb_build_object('ok', false, 'error', 'Not enough free credits.');
  end if;

  -- Refund previous high bidder (other player).
  if a.high_bidder is not null and a.high_bidder is distinct from uid then
    perform app._credit_user(a.high_bidder, a.high_bid, now_ms);
  end if;

  if a.high_bidder = uid then
    credits := credits - need;
  else
    credits := credits - amt;
  end if;
  pstate := jsonb_set(pstate, '{credits}', to_jsonb(credits));
  perform app._write_state(pstate, now_ms);

  if a.closes_at - now() < (anti_ms || ' milliseconds')::interval then
    a.closes_at := now() + (anti_ms || ' milliseconds')::interval;
  end if;

  update public.station_auctions set
    high_bid = amt, high_bidder = uid, closes_at = a.closes_at
  where system_id = p_system;

  return jsonb_build_object(
    'ok', true, 'system_id', p_system, 'high_bid', amt, 'closes_at', a.closes_at,
    'credits', credits
  );
end;
$$;

grant execute on function public.app_station_auction_open(text, numeric) to authenticated;
grant execute on function public.app_station_bid(text, numeric) to authenticated;
