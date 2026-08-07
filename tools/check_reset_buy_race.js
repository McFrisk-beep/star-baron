#!/usr/bin/env node
/* check_reset_buy_race.js — Reset Save must set _noSave (beforeunload guard);
   Buy Max must not soft-commit optimistic credits while a trade RPC is busy;
   maxBuy clamps to bay room; trade RPC uses the filled qty.
   Run: node tools/check_reset_buy_race.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout, location: { reload() { ctx.__reloaded = true; } } });
ctx.window = ctx;
let T = 1_720_000_000_000;
ctx.Date = { now: () => T };
ctx.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
ctx.document = { addEventListener() {}, getElementById() { return null; } };

for (const f of ["store.js", "data.js", "flavor.js", "market.js", "galaxy.js", "stock.js", "items.js", "fleet.js", "assets.js", "economy.js", "reputation.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}

const { Market, Galaxy, Stock, Assets, Economy, Store, SYSTEMS } = ctx;
Market.init();
Galaxy.build();
Stock.init(T);

ctx.Game = {
  state: null,
  _noSave: false,
  _saveTimer: null,
  stopSchedulers() {},
  snapshot() { return this.state; },
  save() { if (this._noSave) return; Store.save(this.snapshot()); },
  async reset() {
    // Mirror js/main.js Game.reset guards (the regression under test).
    this._noSave = true;
    if (this.stopSchedulers) this.stopSchedulers();
    clearTimeout(Store._cloudTimer);
    Store._cloudReady = false;
    await Store.clear();
    ctx.__reloaded = true;
  },
};
ctx.Bus = { emit() {}, on() {} };
ctx.UI = { toast() {} };
ctx.Bazaar = { itemsValue: () => 0, inventoryUsed: () => 0, capacity: () => 50 };
ctx.Boosts = { mag: () => 0 };
ctx.Senate = {
  smuggleFailAdd: () => 0, travelSpeedMult: () => 1, isBanned: () => false,
  tradeTax: () => 0, windfallSurtax: () => 0, tariffLines: () => [], priceEdictLines: () => [],
  banInfo: () => null, windfallLines: () => [], travelEdictNote: () => "",
};
ctx.Rep = { get: () => 0, discount: () => 0, edgeForCategory: () => 0, onTrade() {}, factionForCategory: () => null };
ctx.Stations = { customsExempt: () => false, get: () => null, scrutinyFor: () => null, escrowForNetWorth: () => 0 };

const iron = "iron_ore";

(async () => {
  ctx.Game.state = {
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
    settings: { muted: true, reduced: false, tutorialSeen: true, lang: "en" },
    lastSeenAt: T,
  };

  // ---- 1) Reset Save: beforeunload-equivalent must not resurrect the wipe ----
  Store.localSave(ctx.Game.state);
  assert.ok(Store.localLoad(), "precondition: save exists");
  await ctx.Game.reset();
  assert.strictEqual(ctx.Game._noSave, true, "reset sets _noSave before reload");
  assert.ok(ctx.__reloaded, "reset reloads");
  ctx.Game.save();
  assert.strictEqual(Store.localLoad(), null, "beforeunload save is a no-op after reset");

  // ---- 2) maxBuy clamps to bay free capacity ----
  ctx.Game._noSave = false;
  ctx.Game.state.credits = 5_000_000;
  ctx.Game.state.positions = {};
  ctx.Game.state.stationInv = { navos: { blocks: {}, gear: [] } };
  for (let i = 0; i < 49; i++) {
    ctx.Game.state.items["g" + i] = { uid: "g" + i, kind: "engine", rarity: "common", name: "G", value: 1 };
    ctx.Game.state.stationInv.navos.gear.push("g" + i);
  }
  assert.strictEqual(Assets.bayFree("navos"), 1, "one bay slot free");
  const max = Economy.maxBuy(iron);
  const size = Assets.blockSize(iron);
  assert.ok(max > 0 && max <= size, `maxBuy fits one block (got ${max}, block ${size})`);
  assert.ok(Assets.canFit(Assets.bay("navos"), "block", iron, max, Assets.bayCapacity("navos")), "maxBuy canFit");

  // ---- 3) busy() + soft-sync pre-buy ledger ----
  ctx.Game.state.stationInv = { navos: { blocks: {}, gear: [] } };
  ctx.Game.state.items = {};
  ctx.Game.state.credits = 50_000;
  ctx.Game.state.positions = {};
  ctx.Game.state.avgCost = {};
  // Ensure the shelf has units (Stock.init can leave a thin shelf after other asserts).
  if (Stock) {
    const sec = Stock.sectorOf("navos") || "core";
    Stock.units[sec] = Stock.units[sec] || {};
    Stock.units[sec][iron] = Math.max(Stock.units[sec][iron] || 0, 500);
  }
  const commits = [];
  const tradeCalls = [];
  let serverCredits = 50_000, serverPositions = {};
  ctx.Cloud = {
    playersReady: true,
    signedIn: () => true,
    user: () => ({ id: "u1" }),
    authoritative() { return true; },
    async commit(state) {
      commits.push({ credits: state.credits, pos: state.positions[iron] || 0, bay: (state.stationInv.navos && state.stationInv.navos.blocks[iron]) || 0 });
      if (state.credits < serverCredits) serverCredits = state.credits;
      return { ok: true, state: { credits: serverCredits, positions: serverPositions, currentSystem: "navos", travel: null, unlockedSystems: state.unlockedSystems } };
    },
    async trade(action, commodity, qty) {
      tradeCalls.push(qty);
      const fill = 10, cost = fill * qty;
      serverCredits -= cost;
      serverPositions[commodity] = (serverPositions[commodity] || 0) + qty;
      return {
        ok: true, action, commodity, qty, fillPrice: fill, cost,
        credits: serverCredits, positions: Object.assign({}, serverPositions), avgCost: { [commodity]: fill },
        stats: { trades: 1, biggestTrade: cost },
      };
    },
  };

  let releaseCommit;
  const commitGate = new Promise(r => { releaseCommit = r; });
  const origCommit = ctx.Cloud.commit;
  ctx.Cloud.commit = async (state) => { await commitGate; return origCommit(state); };

  assert.ok(Economy.maxBuy(iron) >= 5, "can afford a 5-unit buy for the race test");
  const buyP = Economy.buy(iron, 5);
  // Drain microtasks until soft-sync is blocked on our commit gate.
  for (let i = 0; i < 20 && !Economy.busy(); i++) await Promise.resolve();
  assert.ok(Economy.busy(), "Economy.busy during authoritative buy");
  releaseCommit();
  const buyR = await buyP;
  assert.ok(buyR.ok, buyR.msg);
  assert.strictEqual(tradeCalls[0], 5, "RPC got filled qty");
  assert.strictEqual(ctx.Game.state.positions[iron], 5, "positions after buy");
  assert.strictEqual(Assets.bayQty("navos", iron), 5, "bay has stock after buy");
  assert.ok(commits[0].pos === 0, "soft-sync sent pre-buy positions");
  assert.ok(commits[0].bay === 0, "soft-sync sent pre-buy bay (not optimistic goods)");

  ctx.Cloud.commit = origCommit;

  // ---- 4) Store._queueCloud holds the push while busy, then catches up ----
  const tick = () => new Promise(r => setTimeout(r, 1));
  let cloudPushes = 0;
  ctx.Cloud.saveRemote = async () => { cloudPushes++; };
  Store._cloudReady = true;
  Store._cloudMs = 0;
  Economy._pending = 1;
  Store._queueCloud(ctx.Game.state);
  await tick(); await tick();
  assert.strictEqual(cloudPushes, 0, "cloud push withheld while busy");
  assert.ok(Store._cloudTimer, "debounce re-armed rather than dropped");
  Economy._pending = 0;
  await tick(); await tick();
  assert.strictEqual(cloudPushes, 1, "withheld push lands once the trade finishes");
  clearTimeout(Store._cloudTimer);

  // ---- 5) Store.flush refuses while busy (tab hide / sign-out mid-trade) ----
  // Game.suspend() flushes immediately on visibilitychange — backgrounding the
  // game mid-buy used to commit optimistic credits against pre-trade positions.
  cloudPushes = 0;
  Economy._pending = 1;
  await Store.flush(ctx.Game.state);
  assert.strictEqual(cloudPushes, 0, "flush skipped while busy");
  assert.ok(Store._cloudTimer, "flush hands the push back to the debounce");
  clearTimeout(Store._cloudTimer);          // deterministic: don't let it race step 6
  Store._cloudTimer = null;
  Economy._pending = 0;
  await Store.flush(ctx.Game.state);
  assert.strictEqual(cloudPushes, 1, "flush works when idle");

  // ---- 6) busy() covers the optimistic mutation, not just the RPC ----
  // An async optimistic path yields to the event loop with credits already
  // deducted; an autosave landing in that gap is the same race.
  let releaseOptimistic;
  const optimisticGate = new Promise(r => { releaseOptimistic = r; });
  const gatedP = Economy._withRpc(
    async () => { await optimisticGate; return { ok: true }; },
    async () => ({ ok: true }),
    "nope"
  );
  await tick();
  assert.ok(Economy.busy(), "busy() during an async optimistic mutation");
  cloudPushes = 0;
  await Store.flush(ctx.Game.state);
  assert.strictEqual(cloudPushes, 0, "no flush during the optimistic window");
  releaseOptimistic();
  assert.ok((await gatedP).ok, "gated rpc completes");
  assert.ok(!Economy.busy(), "busy() clears after the rpc");

  console.log("check_reset_buy_race: reset _noSave + buy race / maxBuy bay clamp ✔");
})().catch(e => { console.error(e); process.exit(1); });
