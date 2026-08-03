-- Sector stock + stations (docs/STATIONS.md) — SERVER STUB
-- Guest / single-player already runs the finite-stock economy client-side
-- (js/stock.js, js/stations.js). Authoritative RPCs land with Phase 4.
--
-- Do NOT paste this as-is into production yet: it documents the target schema
-- and the places Cloud.trade / market.price_system must change together.
--
-- Price is no longer a pure function of (commodity, system, t). Scarcity
-- multiplies the deterministic anchor:
--   price = market.price_system(c, sys, t) × scarcity(sector_stock / baseline)
-- Keep js/market.js systemPrice and this SQL in lockstep when wiring authority.

create table if not exists public.sector_stock (
  sector_id text not null,
  comm_id   text not null,
  units     integer not null check (units >= 0),
  updated_at timestamptz not null default now(),
  primary key (sector_id, comm_id)
);

create table if not exists public.stations (
  system_id text primary key,
  owner_id uuid null,
  tier text not null,
  reactor_level int not null default 0,
  modules jsonb not null default '{}'::jsonb,
  treasury numeric not null default 0,
  standing numeric not null default 60,
  lease_tax_bps int not null default 1000,
  sale_tariff_bps int not null default 500,
  scrutiny int not null default 10,
  status text not null default 'npc'
    check (status in ('npc','owned','refit','cooldown')),
  hold jsonb not null default '{}'::jsonb,
  prod_comm text null,
  cooldown_until timestamptz null,
  refit_until timestamptz null
);

-- RPCs to implement with authority (extend Cloud.trade; do not fork a client path):
--   app_station_bid / app_station_auction_open
--   app_station_module_install / app_station_set_policy
--   app_station_withdraw / app_station_lease_bay
--   app_station_list_item / app_station_buy_item
-- Hourly cron: consumption, NPC production (+ elastic backstop), trickle,
-- sentiment/standing, revolt rolls, upkeep, auction close.
