#!/usr/bin/env node
/* check_market_depth.js — finite sector stock replaces tradeImpact.
   Buying depletes the shelf and raises scarcity; selling restocks it.
   Run: node tools/check_market_depth.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout });
ctx.window = ctx;
let T = 1_720_000_000_000;
ctx.Date = { now: () => T };
ctx.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

for (const f of ["store.js", "data.js", "flavor.js", "market.js", "galaxy.js", "stock.js", "stations.js", "economy.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}

const { Market, Galaxy, Stock, Stations, Economy, SYSTEMS } = ctx;
Market.init();
Galaxy.build();
Stock.init(T);
Stations.ensure();

ctx.Game = {
  state: {
    credits: 200_000, positions: {}, avgCost: {}, currentSystem: "korrin", travel: null,
    unlockedSystems: SYSTEMS.map(s => s.id),
    reputation: { syndicate: 0, mining_combine: 0, free_trade: 0, agri_collective: 0 },
    prestige: { tier: 0, multiplier: 1 },
    stats: { trades: 0, contractsDone: 0, peakNetWorth: 50000, biggestTrade: 0 },
    achievements: [], ships: [], items: {}, orders: [], seq: 1,
    mainShip: { type: "pinnace" },
  },
  requestSave() {},
};
ctx.Rep = { edgeForCategory: () => 0, onTrade() {}, get: () => 0 };
ctx.Fleet = { fleetValue: () => 0, dockTravelMs: () => 1000, mainDef: () => ({ travelSpeed: 1 }) };
ctx.Bazaar = { itemsValue: () => 0 };
ctx.Bus = { emit() {} };

const IRON = "iron_ore";
const before = Stock.availableHere("korrin", IRON);
const p0 = Market.systemPrice(IRON, "korrin");
const r = Economy.buy(IRON, 100);
assert.ok(r.ok, r.msg);
assert.strictEqual(Stock.availableHere("korrin", IRON), before - 100, "buy depletes sector stock");
const p1 = Market.systemPrice(IRON, "korrin");
assert.ok(p1 > p0, `scarcity raised price ${p0} → ${p1}`);

const max = Economy.maxBuy(IRON);
assert.ok(max <= Stock.availableHere("korrin", IRON), "maxBuy clamps to shelf");

(async () => {
  const sell = await Economy.sell(IRON, 50);
  assert.ok(sell.ok, sell.msg);
  assert.ok(Stock.availableHere("korrin", IRON) > before - 100, "sell restocks sector");

  // Empty shelf blocks buys
  Stock.takeHere("korrin", IRON, Stock.availableHere("korrin", IRON));
  assert.strictEqual(Economy.maxBuy(IRON), 0, "empty shelf → maxBuy 0");
  const empty = Economy.buy(IRON, 1);
  assert.ok(!empty.ok, "cannot buy from empty shelf");

  console.log("OK check_market_depth");
})().catch(e => { console.error(e); process.exit(1); });
