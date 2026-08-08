#!/usr/bin/env node
/* check_sql_patch_sync.js — market_commodities_expand.sql duplicates three
   functions from market_price.sql. Normalize whitespace/comments and assert
   the bodies match so the patch can't drift from the canonical copy.

   Also guards station publish paste-order + economy_trust invariants, and
   keeps app._pick_idle_ships identical between phase2 and trust.

   Run:  node tools/check_sql_patch_sync.js                                    */
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert");

const root = path.join(__dirname, "..");
const canonical = fs.readFileSync(path.join(root, "docs/sql/market_price.sql"), "utf8");
const patch = fs.readFileSync(path.join(root, "docs/sql/market_commodities_expand.sql"), "utf8");
const phase2Sql = fs.readFileSync(path.join(root, "docs/sql/phase2_missions_bazaar.sql"), "utf8");
const trustSql = fs.readFileSync(path.join(root, "docs/sql/station_economy_trust.sql"), "utf8");
const modulesSql = fs.readFileSync(path.join(root, "docs/sql/station_modules.sql"), "utf8");
const upkeepSql = fs.readFileSync(path.join(root, "docs/sql/station_upkeep.sql"), "utf8");

const FNS = [
  "market.commodity",
  "market.event_slot",
  "market.event_slot_local",
  "app._pick_idle_ships",
];

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

for (const name of FNS.slice(0, 3)) {
  const a = normalize(extract(canonical, name));
  const b = normalize(extract(patch, name));
  assert.strictEqual(a, b,
    `${name} differs between market_price.sql and market_commodities_expand.sql`);
}

// phase2 owns the canonical helper; trust recreates it for self-contained paste.
{
  const a = normalize(extract(phase2Sql, "app._pick_idle_ships"));
  const b = normalize(extract(trustSql, "app._pick_idle_ships"));
  assert.strictEqual(a, b,
    "app._pick_idle_ships differs between phase2_missions_bazaar.sql and station_economy_trust.sql");
}

// Paste order: treasury → contracts → upkeep → modules → auctions → economy_trust.
// The modules copy of app_station_publish must keep D1 contract stats + D3 modules.
const pubM = normalize(extract(modulesSql, "public.app_station_publish"));
for (const token of [
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
assert.ok(!pubM.includes("treasury_bootstrap") && !pubM.includes("hold_bootstrap"),
  "station_modules.sql must not accept client treasury/hold bootstrap");

const pubT = normalize(extract(trustSql, "public.app_station_publish"));
assert.ok(!pubT.includes("treasury_bootstrap") && !pubT.includes("hold_bootstrap"),
  "station_economy_trust.sql must not accept client treasury/hold bootstrap");
assert.ok(pubT.includes("economy_bootstrapped"),
  "station_economy_trust.sql publish must keep economy_bootstrapped sticky marker");
assert.ok(pubT.includes("treasury = 0") && pubT.includes("hold = '{}'"),
  "station_economy_trust.sql publish must clear treasury/hold on release / start empty");
assert.ok(trustSql.includes("app_station_launch_haul")
  && trustSql.includes("app_station_deliver")
  && trustSql.includes("app_station_release"),
  "station_economy_trust.sql missing launch/deliver/release RPCs");
assert.ok(trustSql.includes("economy_bootstrapped = true")
  && !/economy_bootstrapped\s*=\s*false/.test(trustSql),
  "station_economy_trust.sql must keep economy_bootstrapped sticky (never reset false)");
assert.ok(trustSql.includes("Haul not launched") || trustSql.includes("Still in flight"),
  "station_economy_trust.sql settle_haul must require a launched flight");
assert.ok(trustSql.includes("delivered_cycle"),
  "station_economy_trust.sql must track delivered_cycle for standing");
assert.ok(!/r->>'delivered'/.test(upkeepSql) && !/r->>'expected'/.test(upkeepSql),
  "station_upkeep.sql after_hour must not trust client delivered/expected");
assert.ok(/standing\s*=\s*stand\b/.test(upkeepSql),
  "station_upkeep.sql after_hour must not assign standing = standing (ambiguous)");
assert.ok(trustSql.includes("cooldown") && /status = 'cooldown'/.test(trustSql),
  "station_economy_trust.sql publish must respect revolt cooldown");
assert.ok(/taken_at < now\(\) - interval '24 hours'/.test(trustSql),
  "station_economy_trust.sql must reclaim claimed-but-never-launched hauls");
assert.ok(trustSql.includes("Too many ships"),
  "station_economy_trust.sql must dedupe/cap ship arrays");
assert.ok(trustSql.includes("double escrow"),
  "station_economy_trust.sql must fail if mission_resolve lacks station skip");
assert.ok(phase2Sql.includes("m->>'source' = 'station'"),
  "phase2_missions_bazaar.sql must skip source=station in app_mission_resolve");

const softSql = fs.readFileSync(path.join(root, "docs/sql/station_soft_income.sql"), "utf8");
assert.ok(softSql.includes("app._credit_positions"),
  "station_soft_income.sql must credit positions for bay keep / orphan tax");
assert.ok(softSql.includes("app._extractor_yield_mult"),
  "station_soft_income.sql after_hour must apply extractor quality");
assert.ok(/_extractor_yield_mult\('jack'\)/.test(softSql),
  "station_soft_income.sql after_hour must jack-fallback when extractorId is missing");
assert.ok(/not in \(uid::text, 'player'\)/.test(softSql)
  || /in \(uid::text, 'player'\)/.test(softSql),
  "station_soft_income.sql after_hour must accept legacy player lesseeId");
assert.ok(softSql.includes("toPositions") || softSql.includes("_credit_positions"),
  "station_soft_income.sql settle must handle orphan bay tax");
assert.ok(pubT.includes("extractorid"),
  "station_economy_trust.sql publish must carry owner extractorId for after_hour");

const restoreSql = fs.readFileSync(path.join(root, "docs/sql/restore_backup.sql"), "utf8");
assert.ok(restoreSql.includes("app_restore_backup"),
  "restore_backup.sql must define app_restore_backup");
assert.ok(/drop function if exists public\.app_restore_backup\s*\(\s*jsonb\s*\)/i.test(restoreSql),
  "restore_backup.sql must drop the old client-payload signature");
assert.ok(/create or replace function public\.app_restore_backup\s*\(\s*\)/i.test(restoreSql),
  "app_restore_backup must take no economy payload");
assert.ok(!/app_restore_backup\s*\(\s*p_state/i.test(restoreSql),
  "app_restore_backup must not accept client economy values");
assert.ok(!/create or replace function public\.app_reset_save/i.test(restoreSql),
  "restore_backup.sql must not redefine app_reset_save (single owner in reset_save.sql)");
assert.ok(/drop column if exists restore_snapshot/i.test(restoreSql),
  "restore_backup.sql must drop leftover restore_snapshot from earlier drafts");
assert.ok(!/['"]restored['"]/.test(restoreSql),
  "app_restore_backup must not return a dead restored field");
assert.ok(/reset_save\.sql\s*→\s*this file|Paste order:.*reset_save\.sql/i.test(restoreSql),
  "restore_backup.sql paste order must match PHASE1_SETUP (reset_save first)");
const resetSql = fs.readFileSync(path.join(root, "docs/sql/reset_save.sql"), "utf8");
assert.ok(!resetSql.includes("restore_snapshot"),
  "reset_save.sql must not maintain an unreachable restore_snapshot");

console.log(`check_sql_patch_sync: ${FNS.length} synced fns + app_station_publish + economy_trust + soft_income ✔`);
