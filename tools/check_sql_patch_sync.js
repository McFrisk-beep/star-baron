#!/usr/bin/env node
/* check_sql_patch_sync.js — market_commodities_expand.sql duplicates three
   functions from market_price.sql. Normalize whitespace/comments and assert
   the bodies match so the patch can't drift from the canonical copy.

   Also guards station publish paste-order: station_modules.sql (D3) is applied
   last and must keep D1's hold bootstrap + sync fields (plus D3 modules).

   Run:  node tools/check_sql_patch_sync.js                                    */
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert");

const root = path.join(__dirname, "..");
const canonical = fs.readFileSync(path.join(root, "docs/sql/market_price.sql"), "utf8");
const patch = fs.readFileSync(path.join(root, "docs/sql/market_commodities_expand.sql"), "utf8");

const FNS = ["market.commodity", "market.event_slot", "market.event_slot_local"];

function extract(sql, name) {
  // Grab from `create or replace function <name>` through that function's `$$;`
  const esc = name.replace(/\./g, "\\.");
  const re = new RegExp(
    "create\\s+or\\s+replace\\s+function\\s+" + esc + "\\b[\\s\\S]*?\\$\\$;",
    "i"
  );
  const m = sql.match(re);
  assert.ok(m, `missing ${name}`);
  return m[0];
}

function normalize(body) {
  return body
    .replace(/--[^\n]*/g, "")          // strip SQL line comments
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

for (const name of FNS) {
  const a = normalize(extract(canonical, name));
  const b = normalize(extract(patch, name));
  assert.strictEqual(a, b,
    `${name} differs between market_price.sql and market_commodities_expand.sql`);
}

// Paste order: treasury → contracts → upkeep → modules → auctions → economy_trust.
// The modules copy of app_station_publish must be the union of D1 (hold + contract stats)
// and D3 (modules / reactor_level) — a D0 fork silently bricks the Contract Office.
// economy_trust.sql (pasted last) tightens bootstrap to economy_bootstrapped.
const contractsSql = fs.readFileSync(path.join(root, "docs/sql/station_contracts.sql"), "utf8");
const modulesSql = fs.readFileSync(path.join(root, "docs/sql/station_modules.sql"), "utf8");
const trustSql = fs.readFileSync(path.join(root, "docs/sql/station_economy_trust.sql"), "utf8");
const pubM = normalize(extract(modulesSql, "public.app_station_publish"));
for (const token of [
  "hold_bootstrap",
  "contract_filled",
  "contract_expired",
  "'hold'",
  "modules",
  "reactor_level",
  "economy_bootstrapped",
]) {
  assert.ok(pubM.includes(normalize(token)) || pubM.includes(token.toLowerCase()),
    `station_modules.sql app_station_publish missing ${token} (D1∪D3 required)`);
}
// One-shot bootstrap gate (not "whenever treasury/hold is empty").
assert.ok(pubM.includes("economy_bootstrapped"),
  "station_modules.sql app_station_publish missing economy_bootstrapped one-shot gate");

const pubT = normalize(extract(trustSql, "public.app_station_publish"));
assert.ok(pubT.includes("economy_bootstrapped"),
  "station_economy_trust.sql publish must keep one-shot bootstrap");
assert.ok(pubT.includes("treasury = 0") && pubT.includes("hold = '{}'"),
  "station_economy_trust.sql publish must clear treasury/hold on release");
assert.ok(trustSql.includes("app_station_launch_haul")
  && trustSql.includes("app_station_deliver")
  && trustSql.includes("app_station_release"),
  "station_economy_trust.sql missing launch/deliver/release RPCs");
assert.ok(trustSql.includes("Haul not launched") || trustSql.includes("Still in flight"),
  "station_economy_trust.sql settle_haul must require a launched flight");

console.log(`check_sql_patch_sync: ${FNS.length} market fns + app_station_publish + economy_trust ✔`);
