#!/usr/bin/env node
/* check_soft_income_gates.js — Phase 3/4 soft-mint gates:
   - claimHallPayouts / claimPendingCargo leave owed balances when !softIncomeLocal
   - Stock.authoritative still runs Stations.afterStockHour
   - produceRemoteLeases only clears pendingCargo when keep landed
   - Phase 4 server hold: _playerProduce does not double-count st.hold
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
  "market.js", "galaxy.js", "items.js", "fleet.js", "economy.js", "extractors.js",
  "stock.js", "stations.js"]) {
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
ctx.Assets = { parkBlocks() {}, reconcileFromPositions() {} };
ctx.Rep = { change() {}, edgeForCategory: () => 0 };

(async () => {
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

// --- Shared floor + Phase 3: _playerProduce must not phantom-park keep ---
// (produceRemoteLeases owns the payout; catch-up would multiply the bag).
ctx.Cloud.authoritative = () => true;
ctx.Cloud.pullReady = true;
ctx.Cloud.enabled = true;
ctx.Cloud.baysMissing = false;
const pool = ctx.COMMODITIES.filter(c => !c.craftOnly);
const hub = Stations.list()[1] || st;
hub.ownerId = "alice";
hub.status = "owned";
hub.modules = { production_hub: 1 };
hub.prodComm = pool[0].id;
hub.leaseTaxBps = 1000;
hub.hold = {};
hub.pendingCargo = {};
hub.standing = 60;
Stations.syncBays(hub);
const exUid = "exPhantom";
ctx.Game.state.extractors = ctx.Game.state.extractors || {};
ctx.Game.state.extractors[exUid] = { uid: exUid, type: "jack", scope: "all", name: "Jack", components: [] };
hub.bays[0] = { lesseeId: Stations.playerId(), extractorId: exUid, npc: false };
Stations.directory[hub.systemId] = {
  systemId: hub.systemId, ownerId: "alice", status: "owned",
  modules: hub.modules, prodComm: hub.prodComm, bays: hub.bays.slice(),
};
Stations.remoteLeases[hub.systemId] = { 0: exUid };
assert.ok(Stations.bayShared(hub.systemId), "shared floor for phantom test");
ctx.Game.state.positions = {};
Stations._playerProduce(hub, 1);
Stations._playerProduce(hub, 2);
Stations._playerProduce(hub, 3);
assert.ok(!hub.pendingCargo[Stations.playerId()],
  "shared + Phase 3 must not accrue pendingCargo (produceRemoteLeases owns keep)");
// Guest-local (not shared): still parks when soft-mint is blocked.
delete Stations.directory[hub.systemId];
delete Stations.remoteLeases[hub.systemId];
assert.ok(!Stations.bayShared(hub.systemId), "not shared");
hub.pendingCargo = {};
Stations._playerProduce(hub, 4);
assert.ok((hub.pendingCargo[Stations.playerId()] || {})[hub.prodComm] > 0,
  "guest-local still parks keep when Phase 3 blocks mint");

// --- Phase 4 shelf authoritative: station hour still fires ---
let afterCalls = 0;
let remoteCalls = 0;
const realAfter = Stations.afterStockHour.bind(Stations);
// afterStockHour now publishes before after_hour — stub publish so the stock
// tick tests don't hit a null Cloud client and spam the console.
const realPublish = Stations.publishOwned.bind(Stations);
Stations.publishOwned = async () => ({ ok: true });
Stations.afterStockHour = (h, opts) => {
  afterCalls++;
  if (!(opts && opts.remote === false)) remoteCalls++;
  realAfter(h, opts);
};
Stock.markServerShelf(true);
ctx.Cloud.authoritative = () => true;
assert.ok(Stock.authoritative(), "shelf latched");
const unitsBefore = JSON.stringify(Stock.units);
T += STOCKCFG.tickMs;
Stock.tick(T);
assert.strictEqual(afterCalls, 1, "afterStockHour runs when shelf is authoritative");
assert.strictEqual(remoteCalls, 1, "single-hour tick fires the remote chain");
assert.strictEqual(JSON.stringify(Stock.units), unitsBefore, "authoritative shelf units unchanged by local tick");

// Multi-hour catch-up: local hour every step, remote chain only on the last
afterCalls = 0;
remoteCalls = 0;
T += STOCKCFG.tickMs * 5;
Stock.tick(T);
assert.strictEqual(afterCalls, 5, "local station hour runs for each catch-up hour");
assert.strictEqual(remoteCalls, 1, "remote RPC chain coalesced to the final hour");

// Boot predicate smoke: Stock.advance still no-ops shelf mutations when authoritative
afterCalls = 0;
remoteCalls = 0;
T += STOCKCFG.tickMs;
Stock.advance(STOCKCFG.tickMs, T);
assert.strictEqual(afterCalls, 1, "advance → tickHour → afterStockHour under authoritative shelf");
assert.strictEqual(remoteCalls, 1);

// --- settleHall files orphan positions into the hauling ledger ---
ctx.Game.state.positions = {};
ctx.Game.state.stationInv = {};
ctx.Game.state.currentSystem = "navos";
ctx.Assets = {
  hold: () => ({ blocks: {}, gear: [] }),
  bay: (sys) => {
    const s = ctx.Game.state;
    s.stationInv = s.stationInv || {};
    return s.stationInv[sys] || (s.stationInv[sys] = { blocks: {}, gear: [] });
  },
  bagValue: () => 0,
  ledgerQty: () => 0,
  parkBlocks() {},
  reconcileFromPositions(sys) {
    // Mirror the real invariant: park server totals into the bay ledger.
    const s = ctx.Game.state;
    s.stationInv = s.stationInv || {};
    const bay = s.stationInv[sys] || (s.stationInv[sys] = { blocks: {}, gear: [] });
    for (const [id, q] of Object.entries(s.positions || {})) {
      bay.blocks[id] = Math.max(0, Math.floor(+q || 0));
    }
  },
};
Economy.refreshNetWorth = () => {};
Stations._hallWritable = () => true;
ctx.Cloud.signedIn = () => true;
ctx.Cloud.hallReady = () => true;
ctx.Cloud.stationSettle = async () => ({
  ok: true, credits: 5000, payouts: [], items: [], cargo: [],
  holds: {},
  positions: { iron_ore: 120 },
  avgCost: { iron_ore: 0 },
});
const settled = await Stations.settleHall();
assert.ok(settled && settled.ok);
assert.strictEqual(ctx.Game.state.positions.iron_ore, 120);
assert.strictEqual(ctx.Game.state.stationInv.navos.blocks.iron_ore, 120,
  "orphan tax filed into bay — next reconcile must not wipe it");

// --- produceRemoteLeases must not wipe pendingCargo when keep never landed ---
ctx.Cloud.authoritative = () => true;
ctx.Cloud.pullReady = true;
ctx.Cloud.enabled = true;
ctx.Cloud.baysMissing = false;
ctx.Cloud.stationBayProduce = async () => ({
  ok: true, keep: 12, commId: pool[0].id,
  // No positions → Phase 3 without soft-income paste; mint blocked.
});
const floor = Stations.list()[2] || hub;
floor.ownerId = "alice";
floor.status = "owned";
floor.modules = { production_hub: 1 };
floor.prodComm = pool[0].id;
floor.leaseTaxBps = 1000;
floor.hold = {};
floor.standing = 60;
floor.pendingCargo = { [Stations.playerId()]: { [floor.prodComm]: 40 } };
Stations.syncBays(floor);
const exBag = "exBag";
ctx.Game.state.extractors[exBag] = { uid: exBag, type: "jack", scope: "all", name: "Jack", components: [] };
floor.bays[0] = { lesseeId: Stations.playerId(), extractorId: exBag, npc: false };
Stations.directory[floor.systemId] = {
  systemId: floor.systemId, ownerId: "alice", status: "owned",
  modules: floor.modules, prodComm: floor.prodComm, bays: floor.bays.slice(),
};
Stations.remoteLeases[floor.systemId] = { 0: exBag };
ctx.Game.state.positions = {};
const madeBag = await Stations.produceRemoteLeases(1);
assert.strictEqual(madeBag, 0, "no keep credited without positions/mint");
assert.strictEqual(floor.pendingCargo[Stations.playerId()][floor.prodComm], 40,
  "pendingCargo kept when produce did not land keep");

// When positions land, the bag may clear.
ctx.Cloud.stationBayProduce = async () => ({
  ok: true, keep: 12, commId: pool[0].id,
  positions: { [pool[0].id]: 12 }, avgCost: {},
});
floor.pendingCargo = { [Stations.playerId()]: { [floor.prodComm]: 40 } };
ctx.Game.state.positions = {};
const madeOk = await Stations.produceRemoteLeases(1);
assert.ok(madeOk > 0, "keep credited via res.positions");
assert.ok(!floor.pendingCargo[Stations.playerId()],
  "pendingCargo cleared only after keep landed");

// --- Phase 4 server hold: _playerProduce must not double-count into st.hold ---
ctx.Cloud.treasuryReady = () => true;
const own = Stations.list()[0];
own.ownerId = Stations.playerId();
own.status = "owned";
own.modules = { production_hub: 1 };
own.prodComm = pool[0].id;
own.leaseTaxBps = 0;
own.hold = {};
own.standing = 60;
Stations.syncBays(own);
const exOwn = "exOwnHold";
ctx.Game.state.extractors[exOwn] = { uid: exOwn, type: "jack", scope: "all", name: "Jack", components: [] };
own.bays[0] = { lesseeId: Stations.playerId(), extractorId: exOwn, npc: false };
assert.ok(Stations.upkeepShared(own.systemId), "treasury live → server owns hold");
Stations._playerProduce(own, 1);
Stations._playerProduce(own, 2);
assert.strictEqual(own.hold[own.prodComm] | 0, 0,
  "local hold stays 0 when after_hour owns the shelf");

// --- afterStockHour must publish staffing before after_hour deposits hold ---
const order = [];
Stations.publishOwned = async () => { order.push("publish"); return { ok: true }; };
ctx.Cloud.stationAfterHour = async () => { order.push("after_hour"); return { ok: true, treasuries: [] }; };
ctx.Cloud.treasuryReady = () => true;
Stations.refreshAuctions = async () => {};
Stations.refreshDirectory = async () => {};
Stations.reconcileRemoteLeases = () => {};
Stations.produceRemoteLeases = async () => 0;
Stations.settleHall = async () => ({ payouts: 0, cargo: 0 });
Stations._retryPendingHaulSettles = async () => {};
Stations.auctionsShared = () => false;
own.ownerId = Stations.playerId();
own.status = "owned";
Stations.afterStockHour(99, { remote: true });
await new Promise(r => setTimeout(r, 30));
assert.deepStrictEqual(order.slice(0, 2), ["publish", "after_hour"],
  "publishOwned before stationAfterHour so prod_comm/extractorId land first");

// --- publishOwned rewrites legacy "player" bays + carries extractorId ---
Stations.publishOwned = realPublish;
ctx.Cloud.signedIn = () => true;
ctx.Cloud.user = () => ({ id: "acct-owner" });
ctx.Cloud.stationPublish = async (rows) => {
  const bay = rows[0] && rows[0].bays && rows[0].bays[0];
  assert.strictEqual(bay.lesseeId, "acct-owner", "legacy player lessee rewritten to account uuid");
  assert.strictEqual(bay.extractorId, "exLegacy", "owner extractorId published with the rewrite");
  return { ok: true, treasuries: [] };
};
own.ownerId = "player";
own.status = "owned";
own.bays[0] = { lesseeId: "player", extractorId: "exLegacy", npc: false };
const pub = await Stations.publishOwned();
assert.ok(pub && pub.ok, "publishOwned ok for legacy player bay");

console.log("check_soft_income_gates: ok");
})().catch(e => { console.error(e); process.exit(1); });
