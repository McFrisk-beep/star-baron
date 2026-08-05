#!/usr/bin/env node
/* check_hauling.js — Assets ledger invariant: buy → haul → sell → migrate.
   Run: node tools/check_hauling.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout });
ctx.window = ctx;
let T = 1_720_000_000_000;
ctx.Date = { now: () => T };
ctx.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

for (const f of ["store.js", "data.js", "flavor.js", "market.js", "galaxy.js", "stock.js", "items.js", "fleet.js", "assets.js", "economy.js", "reputation.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}

const { Market, Galaxy, Stock, Assets, Shipments, Economy, Fleet, SYSTEMS, COMMODITIES, BLOCKCFG, Util } = ctx;
Market.init();
Galaxy.build();
Stock.init(T);

ctx.Game = {
  state: {
    credits: 5_000_000, positions: {}, avgCost: {}, currentSystem: "navos", travel: null,
    hold: { blocks: {}, gear: [] }, stationInv: {}, shipments: [], _haulingMigrated: true,
    unlockedSystems: SYSTEMS.filter(s => s.unlock === 0).map(s => s.id),
    reputation: { syndicate: 0, mining_combine: 0, free_trade: 0, agri_collective: 0 },
    prestige: { tier: 0, multiplier: 1 },
    stats: { trades: 0, contractsDone: 0, peakNetWorth: 50000, biggestTrade: 0 },
    achievements: [], ships: [{ uid: "sh1", type: "mule", name: "Test", status: "idle", accessories: [], dmg: 0 }],
    items: {}, orders: [], seq: 1, mainShip: { type: "pinnace" },
    inventory: { capacity: 50, upgrades: 0 },
    extractors: {}, components: {}, industries: [], listings: [], missions: [],
  },
  requestSave() {},
  timeScale: 1,
};
ctx.Bus = { emit() {} };
ctx.UI = { toast() {} };
ctx.Bazaar = { itemsValue: () => 0, inventoryUsed: () => 0, capacity: () => 50 };
ctx.Boosts = { mag: () => 0 };
ctx.Senate = {
  smuggleFailAdd: () => 0, travelSpeedMult: () => 1, isBanned: () => false, routeSafetyAdd: () => 0,
  tradeTax: () => 0, windfallSurtax: () => 0, tariffLines: () => [], priceEdictLines: () => [],
  banInfo: () => null, windfallLines: () => [],
};
ctx.Rep = { get: () => 0, discount: () => 0 };
ctx.Stations = {
  customsExempt: () => false, get: () => null, scrutinyFor: () => null,
  escrowForNetWorth: () => 0, impoundCargo: () => ({ ok: false }), playerId: () => "p",
};

const iron = "iron_ore";
assert.ok(BLOCKCFG.byRarity.common === 5000, "block size");
assert.strictEqual(Assets.holdCapacity(), 4, "pinnace hold = 4");

// Buy parks into bay
const buy = Economy._buyLocal(iron, 100);
assert.ok(buy.ok, buy.msg);
assert.strictEqual(Assets.bayQty("navos", iron), 100, "buy → bay");
assert.strictEqual(Assets.holdQty(iron), 0, "buy not in hold");
assert.strictEqual(ctx.Game.state.positions[iron], 100, "positions total");
assert.strictEqual(Assets.ledgerQty(iron), 100, "ledger matches");

// Transfer bay → hold (one block / all)
const tr = Assets.transfer("navos", "hold", "block", iron, 100);
assert.ok(tr.ok, tr.msg);
assert.strictEqual(Assets.holdQty(iron), 100);
assert.strictEqual(Assets.bayQty("navos", iron), 0);
assert.strictEqual(ctx.Game.state.positions[iron], 100, "positions unchanged by transfer");

// Can't sell from empty bay
const sellFail = Economy._sellLocal(iron, 50);
assert.ok(!sellFail.ok, "sell requires bay stock");

// Move back and sell
Assets.transfer("hold", "navos", "block", iron, 100);
const sell = Economy._sellLocal(iron, 50);
assert.ok(sell.ok, sell.msg);
assert.strictEqual(Assets.bayQty("navos", iron), 50);
assert.strictEqual(ctx.Game.state.positions[iron], 50);
assert.strictEqual(Assets.ledgerQty(iron), 50);

// Capacity: hold of 4 slots — partial blocks still cost a slot each
Assets.deposit("hold", "block", "silicon", 10, { force: true });
Assets.deposit("hold", "block", "cobalt_ore", 10, { force: true });
assert.ok(Assets.slotsUsed(Assets.hold()) >= 2);

// reconcileFromPositions trusts positions
ctx.Game.state.positions[iron] = 80;
Assets.reconcileFromPositions("navos");
assert.strictEqual(Assets.ledgerQty(iron), 80, "delta parked in bay");
assert.strictEqual(ctx.Game.state.positions[iron], 80);

// Migration: flat save → bay
const flat = {
  credits: 1000, positions: { iron_ore: 200, silicon: 50 }, avgCost: {},
  currentSystem: "navos", items: { i1: { uid: "i1", kind: "engine", rarity: "common", name: "Test", value: 100 } },
  ships: [], listings: [], inventory: { capacity: 6, upgrades: 0 },
};
Assets.migrateState(flat);
assert.ok(flat._haulingMigrated);
assert.strictEqual(flat.stationInv.navos.blocks.iron_ore, 200);
assert.ok(flat.stationInv.navos.gear.includes("i1"));
assert.strictEqual(flat.inventory.capacity, 50, "default 6 → bay base 50");

// Courier quote + dispatch
ctx.Game.state.positions = { iron_ore: 50 };
ctx.Game.state.stationInv = { navos: { blocks: { iron_ore: 50 }, gear: [] }, vesper: { blocks: {}, gear: [] } };
ctx.Game.state.hold = { blocks: {}, gear: [] };
ctx.Game.state.shipments = [];
ctx.Game.state.credits = 1_000_000;
// Ensure vesper is a real destination name — use another unlocked capital if present
const other = SYSTEMS.find(s => s.id !== "navos") || { id: "kel" };
ctx.Game.state.stationInv[other.id] = { blocks: {}, gear: [] };
const q = Shipments.quote("navos", other.id, { iron_ore: 50 }, []);
assert.ok(q.fee > 0 && q.etaMs > 0 && q.slots >= 1, "courier quote");
const d = Shipments.dispatch("navos", other.id, { iron_ore: 50 }, []);
assert.ok(d.ok, d.msg);
assert.strictEqual(Assets.bayQty("navos", iron), 0, "manifest left origin");
assert.strictEqual(Assets.ledgerQty(iron), 50, "in-transit still on ledger");
T += d.shipment.etaMs + 1;
const done = Shipments.resolve(T);
assert.ok(done.length === 1, "courier arrived");
assert.strictEqual(Assets.bayQty(other.id, iron), 50, "landed in dest bay");

// Soft-item merge (blackbox persistence) — must work with Game.state = null,
// which is the real Store.load() call site (before main assigns this.state).
const liveState = ctx.Game.state;
ctx.Game.state = null;
const boot = { items: {}, activeBoosts: [], bazaarBought: [], currentSystem: "navos",
  hold: { blocks: {}, gear: [] }, stationInv: {}, shipments: [], ships: [], listings: [] };
const local = {
  items: { ib1: { uid: "ib1", kind: "blackbox", consumable: true, effectId: "overclock_core", name: "Overclock Core Blackbox", value: 1000 } },
  activeBoosts: [{ effectId: "smugglers_veil", expiresAt: T + 3600000 }],
  bazaarBought: ["bb-1-0", "acc-other"],
};
assert.doesNotThrow(() => ctx.Store.mergeSoftItems(boot, local), "mergeSoftItems with Game.state=null");
assert.ok(boot.items.ib1, "blackbox preserved across bootstrap");
assert.ok(boot.activeBoosts.some(b => b.effectId === "smugglers_veil"), "boost preserved");
assert.ok(boot.bazaarBought.includes("bb-1-0"), "slow-shelf mark preserved");
assert.ok(!boot.bazaarBought.includes("acc-other"), "non-slow marks not forced from local");
// Orphan parking is Game.migrate's job (after state exists), not mergeSoftItems.
assert.strictEqual(Assets.parkOrphanGear(boot), 1, "parkOrphanGear places restored box");
assert.ok(boot.stationInv.navos.gear.includes("ib1"), "box parked in current bay");
ctx.Game.state = liveState;

// _applyServerSlice / applyCommitState must keep soft blackboxes across RPC echoes.
// Regression: trade/pull used _applyServerSlice without mergeSoftItems, so a
// bazaar blackbox vanished from inventory on the next app_pull.
ctx.Game.state.items = {
  ib2: { uid: "ib2", kind: "blackbox", consumable: true, effectId: "overclock_core",
    name: "Overclock Core Blackbox", value: 1000 },
};
ctx.Game.state.activeBoosts = [{ effectId: "smugglers_veil", expiresAt: T + 3600000 }];
ctx.Game.state.bazaarBought = ["bb-9-0"];
ctx.Game.state.stationInv = { navos: { blocks: {}, gear: ["ib2"] } };
ctx.Game.state.hold = { blocks: {}, gear: [] };
Economy._applyServerSlice({
  ok: true, credits: ctx.Game.state.credits, items: {}, bazaarBought: [],
  inventory: { capacity: 50, upgrades: 0 },
});
assert.ok(ctx.Game.state.items.ib2, "blackbox survives _applyServerSlice");
assert.ok(ctx.Game.state.bazaarBought.includes("bb-9-0"), "bb buy mark survives _applyServerSlice");
assert.ok(ctx.Game.state.activeBoosts.some(b => b.effectId === "smugglers_veil"), "boost survives slice");
assert.ok(
  (ctx.Game.state.stationInv.navos && ctx.Game.state.stationInv.navos.gear.includes("ib2"))
    || ctx.Game.state.hold.gear.includes("ib2"),
  "blackbox still parked after slice");
// applyCommitState: server bazaarBought must not wipe soft marks after merge.
ctx.Game.state.items = { ib3: { uid: "ib3", kind: "blackbox", consumable: true, effectId: "tax_ghost",
  name: "Tax Ghost Blackbox", value: 800 } };
ctx.Game.state.bazaarBought = ["bb-10-1"];
ctx.Game.state.stationInv = { navos: { blocks: {}, gear: [] } };
Economy.applyCommitState({ items: {}, bazaarBought: ["acc-server"], inventory: { capacity: 50, upgrades: 0 } });
assert.ok(ctx.Game.state.items.ib3, "blackbox survives applyCommitState");
assert.ok(ctx.Game.state.bazaarBought.includes("bb-10-1"), "soft bb mark kept after commit");
assert.ok(ctx.Game.state.bazaarBought.includes("acc-server"), "server marks kept too");
assert.ok(ctx.Game.state.stationInv.navos.gear.includes("ib3"), "orphan box re-parked on commit");

// Bay capacity: an upgraded Inventory Bay must not end up worse than a fresh account.
const upgraded = { inventory: { capacity: 16, upgrades: 1 }, hold: { blocks: {}, gear: [] },
  stationInv: {}, shipments: [], _haulingMigrated: true, items: {}, ships: [], listings: [] };
Assets.migrateState(upgraded);
assert.strictEqual(upgraded.inventory.capacity, 60, "base 50 + 1×10 upgrade");
const freshish = { inventory: { capacity: 6, upgrades: 0 }, hold: { blocks: {}, gear: [] },
  stationInv: {}, shipments: [], _haulingMigrated: true, items: {}, ships: [], listings: [] };
Assets.migrateState(freshish);
assert.strictEqual(freshish.inventory.capacity, 50, "unupgraded 6 → base 50");

// bayCapacity() floors at read time even if a server slice stomped inventory.capacity.
ctx.Game.state.inventory = { capacity: 16, upgrades: 1 };
assert.strictEqual(Assets.bayCapacity("navos"), 60, "bayCapacity floors stale server capacity");

console.log("check_hauling: ledger + courier + blackbox merge ✔");
