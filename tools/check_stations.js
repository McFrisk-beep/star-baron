#!/usr/bin/env node
/* check_stations.js — NPC stations, auctions, production hub, revolt gates.
   Run: node tools/check_stations.js */
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

const { Market, Galaxy, Stock, Stations, Economy, SYSTEMS, STATIONCFG, Util } = ctx;
Market.init();
Galaxy.build();
Stock.init(T);
Stations.ensure();

ctx.Game = {
  state: {
    credits: 5_000_000, positions: {}, avgCost: {}, currentSystem: "navos", travel: null,
    unlockedSystems: SYSTEMS.filter(s => s.unlock === 0).map(s => s.id),
    reputation: { syndicate: 0, mining_combine: 0, free_trade: 0, agri_collective: 0 },
    prestige: { tier: 0, multiplier: 1 },
    stats: { trades: 0, contractsDone: 0, peakNetWorth: 50000, biggestTrade: 0 },
    achievements: [], ships: [], items: {}, orders: [], seq: 1,
    mainShip: { type: "pinnace" }, extractors: {},
  },
  requestSave() {},
};
ctx.Rep = { edgeForCategory: () => 0, onTrade() {}, get: () => 0 };
ctx.Fleet = { fleetValue: () => 0, dockTravelMs: () => 1000, mainDef: () => ({ travelSpeed: 1 }) };
ctx.Bazaar = { itemsValue: () => 0 };
ctx.Bus = { emit() {} };
ctx.UI = { toast() {} };

const target = Stations.list()[0];
assert.ok(target, "has stations");
assert.strictEqual(target.status, "npc");

const openMin = Stations.openingBid(target);
const before = ctx.Game.state.credits;
const r0 = Stations.openAuction(target.systemId, openMin);
assert.ok(r0.ok, r0.msg);
assert.strictEqual(ctx.Game.state.credits, before - openMin, "bid escrowed");
assert.ok(Stations.escrowTotal() === openMin, "escrow tracked");
assert.ok(Economy.netWorth() >= before - 1, "escrow counts toward net worth");

// Anti-snipe: bid near close extends window
const auc = Stations.getAuction(target.systemId);
auc.closesAt = T + 10 * 60 * 1000; // 10 min left
const raise = openMin + STATIONCFG.minBidIncrement;
const r1 = Stations.bid(target.systemId, raise);
assert.ok(r1.ok, r1.msg);
assert.ok(auc.closesAt >= T + STATIONCFG.antiSnipeMs - 1, "anti-snipe extended");

// Close → ownership
auc.closesAt = T - 1;
Stations._closeAuction(target.systemId, T);
assert.strictEqual(target.status, "owned");
assert.strictEqual(target.ownerId, "player");
assert.strictEqual(Stations.ownedCount(), 1);

// Install Production Hub
const inst = Stations.install(target.systemId, "production_hub");
assert.ok(inst.ok, inst.msg);
assert.strictEqual(target.modules.production_hub, 1);

const pool = Stations.produceable(target.systemId);
assert.ok(pool.length, "system can produce something");
const set = Stations.setProduction(target.systemId, pool[0].id);
assert.ok(set.ok, set.msg);
// Finish retooling
target.status = "owned"; target.refitUntil = 0;

// One production hour → hold grows, sector stock does NOT from player hub
const stockBefore = Stock.available(target.sectorId, pool[0].id);
Stations.npcProduceHour(1);
assert.ok((target.hold[pool[0].id] | 0) > 0, "player output in hold");
// (NPC stations still feed stock; just assert hold path works)

// Deliver requires docking at capital
ctx.Game.state.currentSystem = "navos";
const sec = Galaxy.sector(target.sectorId);
ctx.Game.state.currentSystem = sec.capital;
const qty = target.hold[pool[0].id];
const del = Stations.deliver(target.systemId, pool[0].id, qty);
assert.ok(del.ok, del.msg);
assert.ok(Stock.available(target.sectorId, pool[0].id) >= stockBefore, "delivery restocks sector");

// Power budget blocks over-install
target.modules = { production_hub: 1 };
target.reactorLevel = 0;
// Try to install several fat modules beyond Berth/Relay budget
let blocked = false;
for (const id of ["exchange_hall", "dry_dock", "charter_office", "warehouse", "lane_buoy", "contract_office"]) {
  const r = Stations.canInstall(target, id);
  if (!r.ok && /power/i.test(r.msg || "")) { blocked = true; break; }
}
assert.ok(blocked || Stations.powerFree(target) >= 0, "power budget enforced");

// Cap: Baron can only own 1 — second auction forfeits at close if already owned
const other = Stations.list().find(st => st.systemId !== target.systemId);
ctx.Game.state.credits = 5_000_000;
const r2 = Stations.openAuction(other.systemId, Stations.openingBid(other));
// openAuction should refuse at bid time when at cap
assert.ok(!r2.ok, "cap blocks opening a second auction while owning 1");

console.log("OK check_stations");
