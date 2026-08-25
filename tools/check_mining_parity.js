#!/usr/bin/env node
/* check_mining_parity.js — docs/sql/mining_rpcs.sql vs js/mining.js + js/raiders.js.
   The SQL banks belt batches and rolls corsair raids server-side for signed-in
   barons; the JS does it for guests and for the live tab. If the two disagree,
   a player's ore and their raids change depending on whether they were logged
   in — so this file pins them together two ways:

     1. A JS MIRROR of the SQL's arithmetic (the same trick
        tools/check_market_parity.js uses for market_price.sql) run against the
        real js/raiders.js roll over a few thousand ops.
     2. A STATIC read of the .sql text, asserting every constant baked into it
        still matches the MININGCFG / RAIDCFG / SHIP_CATALOG value it mirrors.

   (2) is the one that catches the realistic failure: somebody retunes a number
   in js/data.js and never opens the SQL. Run: node tools/check_mining_parity.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const root = path.join(__dirname, "..");
const SQL = fs.readFileSync(path.join(root, "docs/sql/mining_rpcs.sql"), "utf8");

const ctx = vm.createContext({ console, Math, Date });
ctx.window = ctx;
for (const f of ["store.js", "data.js", "flavor.js", "market.js", "galaxy.js", "pois.js",
  "reputation.js", "fleet.js", "extractors.js", "charters.js", "security.js", "raiders.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "js", f), "utf8"), ctx, { filename: f });
}
ctx.Market.init();
const { Market, Raiders, MININGCFG, RAIDCFG, SHIP_CATALOG, Util } = ctx;
ctx.Game = { state: { settings: {} } };

// ---- 1. the mirror: app._mining_raid, transcribed --------------------------
// Keep this identical to the SQL body. It is deliberately a separate
// transcription rather than a call into Raiders — a bug copied into both would
// defeat the point.
function sqlRaid(op, cycle, qty, guards) {
  if (qty <= 0) return null;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const threat = clamp(op.threat == null ? 0 : op.threat, 0.01, 0.6);
  const repel = clamp(op.repel == null ? 0 : op.repel, 0, 0.9);
  const s = Market._fnv1a(["cosmocrat-market-v1", "raid", op.id, String(cycle)].join("|"));
  if (Market._u01(s, 0) >= threat) return null;
  if (Market._u01(s, 1) < repel) {
    return { repelled: true, stolen: 0, driveOff: false, minerDmg: 0,
      guardDmg: guards > 0 ? (0.02 + Market._u01(s, 4) * 0.05) * 0.5 : 0 };
  }
  return {
    repelled: false,
    stolen: Math.min(qty, Math.max(1, Math.round(qty * (0.6 + Market._u01(s, 2) * 0.4)))),
    minerDmg: 0.05 + Market._u01(s, 3) * 0.10,
    guardDmg: guards > 0 ? 0.02 + Market._u01(s, 4) * 0.05 : 0,
    driveOff: Market._u01(s, 5) < 0.35 * (guards > 0 ? 0.4 : 1),
  };
}

const poi = { ore: { commId: "iron_ore", rich: 1, pool: 300 }, sysId: "navos", id: "navos:1" };
let raids = 0, repelled = 0, drove = 0;
for (let i = 0; i < 3000; i++) {
  const op = {
    id: "mn" + i,
    threat: (i % 61) / 100,                       // sweeps the clamp in both directions
    repel: (i % 97) / 100,
    guardUids: i % 3 === 0 ? [] : ["g1"],
    shipUid: "s1",
  };
  const qty = 1 + (i % 9);
  const cycle = 1 + (i % 24);
  const js = Raiders.rollClaim(op, cycle, poi, qty);
  const sq = sqlRaid(op, cycle, qty, op.guardUids.length);
  if (js === null || sq === null) {
    assert.strictEqual(js === null, sq === null, `op ${i} cycle ${cycle}: both must agree nobody came`);
    continue;
  }
  raids++;
  if (js.repelled) repelled++;
  if (js.driveOff) drove++;
  assert.strictEqual(js.repelled, sq.repelled, `op ${i}: repel verdict`);
  assert.strictEqual(js.stolen, sq.stolen, `op ${i}: ore taken`);
  assert.strictEqual(js.driveOff, sq.driveOff, `op ${i}: driven off the rock`);
  assert.ok(Math.abs(js.minerDmg - sq.minerDmg) < 1e-12, `op ${i}: miner damage`);
  assert.ok(Math.abs(js.guardDmg - sq.guardDmg) < 1e-12, `op ${i}: guard damage`);
}
assert.ok(raids > 400, `the sweep has to actually raid (${raids})`);
assert.ok(repelled > 40 && drove > 20, `…and cover repels (${repelled}) and drive-offs (${drove})`);

// ---- 2. the constants baked into the SQL still match js/data.js ------------
const has = (needle, why) => assert.ok(SQL.includes(needle), `mining_rpcs.sql drifted — ${why} (expected ${JSON.stringify(needle)})`);

has(`'cosmocrat-market-v1', 'raid'`, "the raid seed must match Market._seed(['raid', …])");
has(`${MININGCFG.cycleMs / 60000}.0 * 60 * 1000`, "MININGCFG.cycleMs");
has(`\n    ${MININGCFG.baseYield}.0 `, "MININGCFG.baseYield in the batch ceiling");
has(`    ${MININGCFG.maxCyclesPerResolve}   -- MININGCFG.maxCyclesPerResolve`, "MININGCFG.maxCyclesPerResolve");
has(`if op_n > ${MININGCFG.maxOps} then continue`, "MININGCFG.maxOps");
has(`if n <= ${MININGCFG.maxOps} then out :=`, "MININGCFG.maxOps in the merge");
// The pool ceiling: poolBase × the top of POIs._occupy's size jitter (0.8 + 0.6).
has(`pool_cap constant int := ${Math.round(MININGCFG.poolBase * 1.4)};`, "MININGCFG.poolBase × the size-jitter ceiling");
has(`${ctx.POICFG.churnMaxMs / 3600000}.0 * 60 * 60 * 1000`, "POICFG.churnMaxMs as the pool-prune age");

has(`(p_op->>'threat')::float8, 0), ${RAIDCFG.chanceClamp[0]}), ${RAIDCFG.chanceClamp[1]})`, "RAIDCFG.chanceClamp");
has(`(p_op->>'repel')::float8, 0), ${RAIDCFG.repelClamp[0]}), ${RAIDCFG.repelClamp[1]})`, "RAIDCFG.repelClamp");
has(`(0.6 + market.u01(s, 2) * 0.4)`, "RAIDCFG.stealFrac");
has(`0.05 + market.u01(s, 3) * 0.10`, "RAIDCFG.minerDmg");
has(`0.02 + market.u01(s, 4) * 0.05`, "RAIDCFG.guardDmg");
has(`market.u01(s, 5) < ${RAIDCFG.driveOff} *`, "RAIDCFG.driveOff");
// Spread into host arrays: RAIDCFG comes from a vm realm, so its Array has a
// different prototype and deepStrictEqual would fail on that alone.
assert.deepStrictEqual([...RAIDCFG.stealFrac], [0.6, 1], "stealFrac changed — update the SQL and this line");
assert.deepStrictEqual([...RAIDCFG.minerDmg], [0.05, 0.15], "minerDmg changed — update the SQL and this line");
assert.deepStrictEqual([...RAIDCFG.guardDmg], [0.02, 0.07], "guardDmg changed — update the SQL and this line");

// Every miner hull's yield, and no stragglers.
for (const sh of SHIP_CATALOG.miner) {
  has(`('${sh.id}', ${sh.mine}`, `${sh.id}'s mine stat in app.miner_yield`);
}
const yieldRows = (SQL.match(/create or replace function app\.miner_yield[\s\S]*?\$\$;/)[0]
  .match(/\('[a-z_]+',\s*\d+/g) || []).length;
assert.strictEqual(yieldRows, SHIP_CATALOG.miner.length,
  `app.miner_yield lists ${yieldRows} hulls, SHIP_CATALOG.miner has ${SHIP_CATALOG.miner.length}`);

// Damage clamp must match DMGCFG.maxDmg or a raid could exceed the fleet cap.
has(`least(${ctx.DMGCFG.maxDmg}, greatest(0,`, "DMGCFG.maxDmg in app._mining_damage");

// ---- 3. the copied bodies have not drifted from their sources -------------
// mining_rpcs.sql carries charter_rpcs.sql's app_commit / result_slice and
// phase3's app_pull verbatim plus its own lines. If an upstream file grows a
// protection and this copy doesn't, the mining file silently un-protects it.
const grab = (file, fn) => {
  const src = fs.readFileSync(path.join(root, "docs/sql", file), "utf8");
  const re = new RegExp("create\\s+or\\s+replace\\s+function\\s+" + fn.replace(/\./g, "\\.") + "\\b[\\s\\S]*?\\$\\$;", "i");
  const m = src.match(re);
  assert.ok(m, `${file}: missing ${fn}`);
  return m[0];
};
const lines = t => t.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("--"));
for (const [file, fn] of [["save_hygiene.sql", "public.app_commit"],
                          ["crime_coefficient.sql", "app.result_slice"],
                          ["phase3_pull_prestige.sql", "public.app_pull"]]) {
  const mine = grab("mining_rpcs.sql", fn);
  for (const line of lines(grab(file, fn))) {
    assert.ok(mine.includes(line),
      `mining_rpcs.sql's ${fn} is missing a line from ${file} — re-copy the body and re-add the mining lines:\n    ${line}`);
  }
}

console.log(`OK check_mining_parity  (${raids} raids matched: ${repelled} repelled, ${drove} drove the hull off)`);
