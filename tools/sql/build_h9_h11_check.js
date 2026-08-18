#!/usr/bin/env node
/* build_h9_h11_check.js — emit ONE self-contained .sql file that exercises the
   usage-sim H9/H10/H11 server work against a scratch Postgres:
     docs/sql/merc_expiry.sql        expired mercenaries leave the roster
     docs/sql/crime_coefficient.sql  server-owned record + priced/capped influence
     docs/sql/senate_ballot.sql      the ballot race + the barred gate
     docs/sql/station_auctions.sql   the double-escrow race

   CI can't run this (plain `node tools/check_*.js`, no services), so it is a
   by-hand integration test — the static half lives in
   tools/check_crime_coefficient.js.

   Build:  node tools/sql/build_h9_h11_check.js > /tmp/h9_h11.sql
   Run:    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /tmp/h9_h11.sql
           (any throwaway database — it creates its own tables and a stub
            auth.uid(); never point it at a real project)                     */
"use strict";
const fs = require("fs"), path = require("path");
const root = "/home/user/star-baron";
const read = p => fs.readFileSync(path.join(root, p), "utf8");

const DEPS = [
  ["docs/sql/market_price.sql", "market.imul32"],
  ["docs/sql/market_price.sql", "market.fnv1a"],
  ["docs/sql/market_price.sql", "market.u01"],
  ["docs/sql/market_price.sql", "market.seed_hash"],
  ["docs/sql/phase1_players.sql", "app._in_transit"],
  ["docs/sql/equip_persist.sql", "app._ship_slots"],
  ["docs/sql/equip_persist.sql", "app._merge_ships"],
  ["docs/sql/phase3_pull_prestige.sql", "app._merge_industries"],
  ["docs/sql/phase3_pull_prestige.sql", "app._merge_expeditions"],
  ["docs/sql/phase3_pull_prestige.sql", "app._merge_extractors"],
  ["docs/sql/survey_custody.sql", "app._survey_custody"],
  ["docs/sql/station_modules.sql", "public._station_module_cost"],
  ["docs/sql/station_upkeep.sql", "public._station_tier_rank"],
  ["docs/sql/station_treasury.sql", "app._credit_user"],
];

function extract(file, fn) {
  const lines = read(file).split("\n");
  const head = new RegExp(`^create or replace function ${fn.replace(/\./g, "\\.")}\\s*\\(`);
  const start = lines.findIndex(l => head.test(l.trim()));
  if (start < 0) throw new Error(`not found: ${fn} in ${file}`);
  const end = lines.indexOf("$$;", start);
  if (end < 0) throw new Error(`no terminator for ${fn} in ${file}`);
  return lines.slice(start, end + 1).join("\n");
}

// Extra tables the senate RPCs need.
const TABLES = `
-- The real players table (phase1_players.sql) carries updated_at as well as the
-- harness's updated_ms; the senate ballot RPC writes it.
alter table public.players add column if not exists updated_at timestamptz not null default now();
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
insert into auth.users(id) values (auth.uid()) on conflict do nothing;
create table if not exists public.profiles (
  user_id uuid primary key, role text, username text, join_num bigint
);
create table if not exists public.world_senate (
  id bigint generated always as identity primary key,
  issue text not null, type text not null, lean numeric not null default 1,
  effect jsonb, title text not null, blurb text not null,
  votes_at timestamptz not null, ends_at timestamptz,
  proposed_by uuid, proposed_label text,
  created_at timestamptz not null default now()
);
create table if not exists public.world_senate_influence (
  id bigint generated always as identity primary key,
  bill_id text not null, user_id uuid not null default auth.uid(),
  kind text not null, target text, dir int not null default 0,
  strength numeric not null default 0, created_at timestamptz not null default now()
);
create table if not exists public.stations (
  system_id text primary key, owner_id uuid null, tier text not null default 'Berth',
  reactor_level int not null default 0, modules jsonb not null default '{}'::jsonb,
  treasury numeric not null default 0, standing numeric not null default 60,
  lease_tax_bps int not null default 1000, sale_tariff_bps int not null default 500,
  scrutiny int not null default 10,
  status text not null default 'npc' check (status in ('npc','owned','refit','cooldown')),
  hold jsonb not null default '{}'::jsonb, prod_comm text null,
  economy_bootstrapped boolean not null default false,
  cooldown_until timestamptz null, refit_until timestamptz null,
  updated_at timestamptz not null default now()
);
create table if not exists public.world_senate_result (
  bill_id text primary key, issue text, type text, lean numeric, effect jsonb,
  title text, blurb text, votes text, result jsonb, status text, repeal_of text,
  proposed_by uuid, proposed_label text,
  votes_at timestamptz, ends_at timestamptz,
  created_at timestamptz not null default now()
);
`;

const out = [
  "-- GENERATED — throwaway databases only.",
  // Supabase ships these roles; a scratch database has to make them.
  "do $r$ begin if not exists (select 1 from pg_roles where rolname = 'authenticated')\n  then create role authenticated; end if; end $r$;",
  "do $r$ begin if not exists (select 1 from pg_roles where rolname = 'anon')\n  then create role anon; end if; end $r$;",
  read("tools/sql/craft_harness.sql"),
  TABLES,
  ...DEPS.map(([f, fn]) => extract(f, fn)),
  read("docs/sql/merc_expiry.sql"),
  read("docs/sql/crime_coefficient.sql"),
  read("docs/sql/senate_ballot.sql"),
  read("docs/sql/station_auctions.sql"),
  read(process.argv[2] || "tools/sql/h9_h11_smoke.sql"),
];
process.stdout.write(out.join("\n\n") + "\n");
