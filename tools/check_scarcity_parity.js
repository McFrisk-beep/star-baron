#!/usr/bin/env node
/* check_scarcity_parity.js — JS Stock.scarcityMult matches SQL market.scarcity_mult.
   Run: node tools/check_scarcity_parity.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout });
ctx.window = ctx;
ctx.Date = { now: () => 1_720_000_000_000 };
ctx.localStorage = { _d: {}, getItem() { return null; }, setItem() {}, removeItem() {} };
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

for (const f of ["store.js", "data.js", "flavor.js", "market.js", "galaxy.js", "stock.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}

const { Market, Galaxy, Stock, STOCKCFG, Util } = ctx;
Market.init();
Galaxy.build();
Stock.init(Date.now());

// Mirror docs/sql/phase4_sector_stock.sql market.scarcity_mult
function sqlScarcity(units, baseline) {
  if (!baseline || baseline <= 0) return 1;
  const r = Math.max(units / baseline, 0.02);
  const raw = Math.pow(1 / r, 0.35);
  return Math.max(0.70, Math.min(3.00, raw));
}

const samples = [0, 1, 50, 100, 500, 1000, 2500, 6000, 9000, 12000, 18000];
let n = 0;
for (const sid of Stock.sectorIds()) {
  for (const c of Stock.tradeable()) {
    const base = Stock.baseline(sid, c.id);
    if (base <= 0) continue;
    for (const u of samples) {
      Stock.units[sid][c.id] = u;
      const js = Stock.scarcityMult(sid, c.id);
      const sql = sqlScarcity(u, base);
      assert.ok(Math.abs(js - sql) < 1e-9, `${sid}/${c.id} u=${u}: js=${js} sql=${sql}`);
      n++;
    }
  }
}
assert.ok(n > 100, "sampled scarcity pairs");

// Specialty baselines match SQL knobs (1.6 / 0.7)
const ironBelt = Stock.baseline("belt", "iron_ore");
const ironCore = Stock.baseline("core", "iron_ore");
assert.strictEqual(ironBelt, Math.round((STOCKCFG.baseline.common || 6000) * STOCKCFG.specialtyMult));
assert.strictEqual(ironCore, STOCKCFG.baseline.common);

console.log(`OK check_scarcity_parity (${n} pairs)`);
