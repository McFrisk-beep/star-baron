#!/usr/bin/env node
/* check_soft_income_gates.js — Phase 3/4 soft-mint gates:
   - claimHallPayouts / claimPendingCargo leave owed balances when !softIncomeLocal
   - Stock.authoritative still runs Stations.afterStockHour
   - boot predicate uses Stock.authoritative (smoke via Stock.advance path)
   Run: node tools/check_soft_income_gates.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout });
ctx.window = ctx;
let T = 1_720_000_000_000;
ctx.Date = { now: () => T };
ctx.localStorage = {
  _d: {}, getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; },
};
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

for (const f of ["store.js", "data.js", "flavor.js", "cloud-config.js", "cloud.js",
  "market.js", "galaxy.js", "stock.js", "fleet.js", "economy.js", "stations.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}

const { Market, Galaxy, Stock, Stations, Economy, STOCKCFG } = ctx;
Market.init();
Galaxy.build();
Stock.init(T);
Stations.ensure();

ctx.Game = {
  state: {
    credits: 5000, positions: {}, avgCost: {}, ships: [], currentSystem: "navos",
    travel: null, unlockedSystems: ["navos"], stats: { trades: 0, contractsDone: 0, peakNetWorth: 5000, biggestTrade: 0 },
    prestige: { tier: 0, multiplier: 1 }, reputation: {}, items: {}, inventory: { capacity: 6, upgrades: 0 },
    extractors: {}, components: {}, industries: [], seq: 1, mainShip: { type: "pinnace" },
  },
  requestSave() {},
};
ctx.Bus = { emit() {}, on() {} };
ctx.Assets = { parkBlocks() {} };
ctx.Rep = { change() {}, edgeForCategory: () => 0 };

// --- claimHallPayouts must not consume under Phase 3 ---
const st = Stations.list()[0];
assert.ok(st, "has a station");
st.status = "owned";
st.ownerId = "player";
st.pendingPayouts = { player: 1234 };
ctx.Cloud.authoritative = () => true;
ctx.Cloud.pullReady = true;
ctx.Cloud.pullMissing = false;
assert.strictEqual(Economy.softIncomeLocal(), false);
assert.strictEqual(Stations._softMintLocal(), false);
const beforeCred = ctx.Game.state.credits;
const hall = Stations.claimHallPayouts();
assert.strictEqual(hall.amount, 0, "no local hall claim under Phase 3");
assert.strictEqual(ctx.Game.state.credits, beforeCred);
assert.strictEqual(st.pendingPayouts.player, 1234, "pending payout left intact");

// Guest path still claims
ctx.Cloud.authoritative = () => false;
assert.strictEqual(Stations._softMintLocal(), true);
const hall2 = Stations.claimHallPayouts();
assert.strictEqual(hall2.amount, 1234);
assert.strictEqual(ctx.Game.state.credits, beforeCred + 1234);
assert.ok(!st.pendingPayouts.player);

// --- claimPendingCargo same shape ---
ctx.Cloud.authoritative = () => true;
ctx.Cloud.pullReady = true;
st.pendingCargo = { player: { iron_ore: 40 } };
ctx.Game.state.positions = {};
const cargo = Stations.claimPendingCargo(st.systemId);
assert.ok(cargo.claimed && Object.keys(cargo.claimed).length === 0, "no cargo claim under Phase 3");
assert.strictEqual(st.pendingCargo.player.iron_ore, 40, "pending cargo left intact");
ctx.Cloud.authoritative = () => false;
const cargo2 = Stations.claimPendingCargo(st.systemId);
assert.strictEqual(cargo2.claimed.iron_ore, 40);
assert.strictEqual(ctx.Game.state.positions.iron_ore, 40);
assert.ok(!st.pendingCargo.player);

// --- Phase 4 shelf authoritative: station hour still fires ---
let afterCalls = 0;
const realAfter = Stations.afterStockHour.bind(Stations);
Stations.afterStockHour = (h) => { afterCalls++; realAfter(h); };
Stock.markServerShelf(true);
ctx.Cloud.authoritative = () => true;
assert.ok(Stock.authoritative(), "shelf latched");
const unitsBefore = JSON.stringify(Stock.units);
T += STOCKCFG.tickMs;
Stock.tick(T);
assert.strictEqual(afterCalls, 1, "afterStockHour runs when shelf is authoritative");
assert.strictEqual(JSON.stringify(Stock.units), unitsBefore, "authoritative shelf units unchanged by local tick");

// Boot predicate smoke: Stock.advance still no-ops shelf mutations when authoritative
afterCalls = 0;
T += STOCKCFG.tickMs;
Stock.advance(STOCKCFG.tickMs, T);
assert.strictEqual(afterCalls, 1, "advance → tickHour → afterStockHour under authoritative shelf");

console.log("check_soft_income_gates: ok");
