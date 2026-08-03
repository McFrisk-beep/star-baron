#!/usr/bin/env node
/* check_stock_economy.js — 30-day zero-player sector-stock sim.
   Confirms the galaxy reaches a living equilibrium (not pinned empty / not
   runaway glut) with NPC production alone. Run: node tools/check_stock_economy.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout });
ctx.window = ctx;
let T = 1_720_000_000_000;
ctx.Date = { now: () => T };
ctx.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

for (const f of ["store.js", "data.js", "flavor.js", "market.js", "galaxy.js", "stock.js", "stations.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}

const { Market, Galaxy, Stock, Stations, STOCKCFG, Util } = ctx;
Market.init();
Galaxy.build();
Stock.init(T);
Stations.ensure();

const claimable = Stations.list().length;
assert.strictEqual(claimable, Galaxy.list.filter(s => !s.capital).length, "one station per non-capital");
assert.ok(claimable >= 70 && claimable <= 90, `expected ~78 claimable, got ${claimable}`);

// Scarcity table sanity (docs/STATIONS.md §2.2)
Stock.units.core.iron_ore = Math.floor(Stock.baseline("core", "iron_ore") * 0.5);
const m50 = Stock.scarcityMult("core", "iron_ore");
assert.ok(m50 > 1.2 && m50 < 1.4, `50% stock mult ~1.27, got ${m50}`);
Stock.units.core.iron_ore = 0;
assert.strictEqual(Stock.scarcityMult("core", "iron_ore"), STOCKCFG.maxMult, "empty pins maxMult");
Stock.units.core.iron_ore = Stock.baseline("core", "iron_ore");

// 30-day sim, hourly ticks, zero players
const hours = 30 * 24;
for (let h = 1; h <= hours; h++) {
  T += STOCKCFG.tickMs;
  Stock.tickHour(h);
}
Stock.lastTickAt = T;

const health = Stock.health();
console.log("30-day health:", JSON.stringify(health, null, 2));
console.log(`claimable stations: ${claimable}`);

for (const [sid, h] of Object.entries(health)) {
  assert.ok(h.avgRatio > 0.35 && h.avgRatio < 2.6, `${sid} avgRatio out of band: ${h.avgRatio}`);
  assert.ok(h.empty < 5, `${sid} too many empty shelves: ${h.empty}`);
  assert.ok(h.sentiment >= 25, `${sid} sentiment collapsed: ${h.sentiment}`);
}

// Buy depletes stock and raises scarcity
const before = Stock.available("core", "iron_ore");
Stock.take("core", "iron_ore", 200);
assert.strictEqual(Stock.available("core", "iron_ore"), before - 200);
assert.ok(Stock.scarcityMult("core", "iron_ore") > 1, "taking stock raises scarcity");

console.log("OK check_stock_economy");
