#!/usr/bin/env node
/* check_customs.js — non-capital docking, Customs/Free Port scrutiny, impound.
   Run: node tools/check_customs.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout });
ctx.window = ctx;
let T = 1_720_000_000_000;
ctx.Date = { now: () => T };
ctx.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

for (const f of ["store.js", "data.js", "flavor.js", "market.js", "galaxy.js", "stock.js", "stations.js", "extractors.js", "economy.js", "fleet.js", "reputation.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}

const { Market, Galaxy, Stock, Stations, Economy, Fleet, SYSTEMS, STATIONCFG, CUSTOMS, Util, COMMODITIES } = ctx;
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
    achievements: [], ships: [{ uid: "sh1", type: "mule", name: "Test", status: "idle", accessories: [], dmg: 0 }],
    items: {}, orders: [], seq: 1, mainShip: { type: "pinnace" },
    extractors: {}, components: {}, industries: [], listings: [], missions: [],
  },
  requestSave() {},
  timeScale: 1,
};
ctx.Bus = { emit() {} };
ctx.UI = { toast() {} };
ctx.Bazaar = { itemsValue: () => 0 };
ctx.Boosts = { mag: () => 0 };
ctx.Senate = { smuggleFailAdd: () => 0, travelSpeedMult: () => 1 };

const target = Stations.list()[0];
assert.ok(target);
target.ownerId = "alice";
target.status = "owned";
target.modules = { customs_house: 1 };
target.scrutiny = 50;
target.reactorLevel = 2;

// Public scrutiny is never hidden
const pub = Stations.publicScrutiny(target.systemId);
assert.ok(pub && pub.chanceHint === 50, "public scrutiny shows dial");
assert.strictEqual(Stations.scrutinyFor(target.systemId), 0.5);

// Docking: barred blocks; guest auto-unlocks
assert.ok(Stations.canDock(target.systemId).ok, "guest can dock");
Stations.setRole = Stations.setRole.bind(Stations);
// Owner is alice — setRole needs owner. Pretend we are alice via playerId override.
const realPid = Stations.playerId;
Stations.playerId = () => "alice";
assert.ok(Stations.setRole(target.systemId, "player", "barred").ok);
Stations.playerId = realPid;
assert.ok(!Stations.canDock(target.systemId).ok, "barred denied");
Stations.playerId = () => "alice";
Stations.setRole(target.systemId, "player", "guest");
Stations.playerId = realPid;
assert.ok(Stations.canDock(target.systemId).ok);

const dock = Economy._dockLocal(target.systemId);
assert.ok(dock.ok, dock.msg);
assert.ok(ctx.Game.state.unlockedSystems.includes(target.systemId), "station auto-unlocked");
assert.ok(ctx.Game.state.travel, "transit started");
assert.ok(Fleet.dockTravelMs("navos", target.systemId) > 0, "map travel time");

// Arrive + customs seize → impound
ctx.Game.state.travel.etaMs = 0;
ctx.Game.state.travel.departedAt = T - 1;
const illicit = COMMODITIES.find(c => c.cat === "illicit");
assert.ok(illicit, "has illicit commodity");
ctx.Game.state.positions[illicit.id] = 20;
// Force seize: high scrutiny, stub Math.random
const rnd = Math.random;
Math.random = () => 0; // always seize / max seize slice lower bound path
const arrived = Economy.checkArrival(T);
Math.random = rnd;
assert.ok(arrived && arrived.to === target.systemId);
assert.ok(arrived.customs, "customs fired");
assert.strictEqual(arrived.customs.impoundedTo, target.systemId, "cargo → station impound");
assert.ok((target.impoundHold[illicit.id] | 0) > 0, "impound hold filled");
assert.ok((target.impoundClaims || []).length, "claim issued");

// Allied exempt
Stations.playerId = () => "alice";
Stations.setRole(target.systemId, "player", "allied");
Stations.playerId = realPid;
ctx.Game.state.positions[illicit.id] = 10;
assert.ok(Stations.customsExempt(target.systemId), "allied exempt");
assert.strictEqual(Economy.customsScan(target.systemId), null, "allied skips scan");

// Free Port lowers scrutiny
Stations.playerId = () => "alice";
Stations.setRole(target.systemId, "player", "guest");
delete target.modules.customs_house;
target.modules.free_port = 1;
Stations.playerId = realPid;
const fp = Stations.scrutinyFor(target.systemId);
assert.ok(fp < CUSTOMS.base, "free port below baseline");
const pubFp = Stations.publicScrutiny(target.systemId);
assert.strictEqual(pubFp.label, "Free Port");

// Ransom path (restore customs + claim)
delete target.modules.free_port;
target.modules.customs_house = 1;
target.impoundHold = { [illicit.id]: 5 };
target.impoundClaims = [{ id: "icTest", commId: illicit.id, qty: 5, value: 1000, ransom: 1250, fromId: "player", at: T }];
ctx.Game.state.currentSystem = target.systemId;
ctx.Game.state.credits = 10_000;
ctx.Game.state.positions[illicit.id] = 0;
const before = ctx.Game.state.credits;
const ransom = Stations.payRansom(target.systemId, "icTest");
assert.ok(ransom.ok, ransom.msg);
assert.strictEqual(ctx.Game.state.credits, before - 1250);
assert.strictEqual(ctx.Game.state.positions[illicit.id], 5);
assert.strictEqual(target.treasury, 1250);

// Black Market requires Exchange Hall
target.modules = { customs_house: 0 };
target.ownerId = "player";
Stations.playerId = realPid;
target.status = "owned";
target.reactorLevel = 4;
const bmNoHall = Stations.canInstall(target, "black_market");
assert.ok(!bmNoHall.ok, "BM needs exchange hall");

// Hub gating: capitals open; NPC stations gray services; modules wake when owned.
assert.ok(Stations.hubAccess("exchange", "navos").ok, "capital exchange open");
ctx.Game.state.currentSystem = target.systemId;
target.status = "npc";
target.modules = { exchange_hall: 1, workshop_annex: 1 };
assert.ok(!Stations.hubAccess("exchange").ok, "no commodity exchange at station");
assert.ok(!Stations.hubAccess("bazaar").ok, "NPC modules dormant");
assert.ok(Stations.serviceList(target.systemId).every(r => r.id === "exchange" || !r.ok), "NPC services gray");
target.status = "owned";
target.ownerId = "player";
assert.ok(Stations.hubAccess("bazaar").ok, "owned hall unlocks bazaar gate");
assert.ok(Stations.hubAccess("workshop").ok, "owner annex unlocks workshop");
assert.ok(Stations.serviceList(target.systemId).find(r => r.id === "exchange_hall").ok, "hall online when owned");

console.log("OK check_customs");
