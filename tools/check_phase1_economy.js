#!/usr/bin/env node
/* check_phase1_economy.js — Phase 1 client wiring: guest path stays sync/local;
   authoritative path syncs soft income then calls Cloud.trade/dock/unlock and
   reconciles server slices (optimistic apply + rollback on failure).
   Run:  node tools/check_phase1_economy.js                                      */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout });
ctx.window = ctx;
let T = 1_714_000_000_000;
ctx.Date = { now: () => T };
ctx.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

for (const f of ["store.js", "data.js", "market.js", "economy.js", "orders.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}

const { Market, Economy, Orders, SYSTEMS } = ctx;
Market.init();

const fresh = () => ({
  credits: 50_000, positions: {}, avgCost: {}, currentSystem: "navos", travel: null,
  unlockedSystems: SYSTEMS.filter(s => s.unlock === 0).map(s => s.id),
  reputation: { syndicate: 0, mining_combine: 0, free_trade: 0, agri_collective: 0 },
  prestige: { tier: 0, multiplier: 1 },
  stats: { trades: 0, contractsDone: 0, peakNetWorth: 50_000, biggestTrade: 0 },
  achievements: [], ships: [], items: {}, orders: [], seq: 1,
  mainShip: { type: "pinnace" },
});
ctx.Game = { state: fresh() };
ctx.Rep = { edgeForCategory: () => 0, onTrade() {}, get: () => 0 };
ctx.Fleet = {
  fleetValue: () => 0,
  dockTravelMs(a, b) {
    const A = SYSTEMS.find(s => s.id === a), B = SYSTEMS.find(s => s.id === b);
    return Math.max(1, Math.abs((A?.distance ?? 0) - (B?.distance ?? 0))) * 18 * 1000;
  },
  mainDef: () => ({ travelSpeed: 1 }),
};
ctx.Bazaar = { itemsValue: () => 0 };
ctx.Bus = { emit() {} };

(async () => {
  // 1) Guest / non-authoritative: sync local buy
  assert.strictEqual(Economy.authoritative(), false);
  const r0 = Economy.buy("iron_ore", 10);
  assert(r0 && r0.ok && !(r0 instanceof Promise), "guest buy is sync");
  assert(ctx.Game.state.credits < 50_000 && ctx.Game.state.positions.iron_ore === 10, "guest buy mutates local state");

  // 2) Authoritative success: soft-sync commit then trade; server slice wins
  ctx.Game.state = fresh();
  const calls = [];
  let serverCredits = 50_000, serverPositions = {}, serverAvg = {};
  ctx.Cloud = {
    playersReady: true,
    signedIn: () => true,
    authoritative() { return this.signedIn() && this.playersReady; },
    async commit(state) {
      calls.push(["commit", state.credits, state.positions.iron_ore || 0]);
      // Simulate app_commit accepting client credits/positions, protecting travel.
      serverCredits = state.credits;
      serverPositions = JSON.parse(JSON.stringify(state.positions || {}));
      serverAvg = JSON.parse(JSON.stringify(state.avgCost || {}));
      return {
        ok: true,
        state: Object.assign({}, state, {
          credits: serverCredits, positions: serverPositions, avgCost: serverAvg,
          currentSystem: "navos", travel: null,
          unlockedSystems: state.unlockedSystems,
        }),
      };
    },
    async trade(action, commodity, qty) {
      calls.push(["trade", action, commodity, qty, serverCredits]);
      const fill = 41.5, cost = fill * qty;
      assert(serverCredits >= cost, "server must already have soft income before trade");
      assert((serverPositions[commodity] || 0) === 0, "commit must be pre-trade (no double position)");
      serverCredits -= cost;
      serverPositions[commodity] = qty;
      serverAvg[commodity] = fill;
      return {
        ok: true, action, commodity, qty, fillPrice: fill, cost,
        credits: serverCredits, positions: serverPositions, avgCost: serverAvg,
        stats: { trades: 1, biggestTrade: cost },
      };
    },
    async dock(system) {
      return { ok: true, travel: true, etaMs: 999, travelObj: { from: "navos", to: system, departedAt: T, etaMs: 999 } };
    },
    async unlock(system) {
      return { ok: true, credits: serverCredits - 6000, unlockedSystems: ["navos", "korrin", "velm", system] };
    },
  };

  // Soft income (mission) then trade — must not evaporate.
  ctx.Game.state.credits += 10_000;
  const r1 = await Economy.buy("iron_ore", 5);
  assert(r1.ok, "auth buy ok");
  assert(calls.some(c => c[0] === "commit" && c[1] === 60_000), "commit pushed pre-trade credits incl. mission");
  assert(calls.some(c => c[0] === "trade" && c[4] === 60_000), "trade saw synced credits");
  assert.strictEqual(ctx.Game.state.credits, 60_000 - 41.5 * 5, "mission income kept after trade reconcile");
  assert.strictEqual(r1.price, 41.5, "fillPrice reconciled onto result");

  // 3) Authoritative failure rolls back optimistic credits
  ctx.Game.state = fresh();
  calls.length = 0;
  serverCredits = 50_000; serverPositions = {};
  ctx.Cloud.trade = async () => { calls.push(["fail"]); return { ok: false, error: "Nope." }; };
  const before = ctx.Game.state.credits;
  const r2 = await Economy.buy("iron_ore", 3);
  assert(!r2.ok && r2.msg === "Nope.", "rpc error surfaced");
  assert.strictEqual(ctx.Game.state.credits, before, "credits restored after failed rpc");
  assert.strictEqual(ctx.Game.state.positions.iron_ore || 0, 0, "position restored");

  // 4) Network throw → friendly toast message + rollback
  ctx.Game.state = fresh();
  ctx.Cloud.trade = async () => { throw new Error("offline"); };
  const r3 = await Economy.buy("iron_ore", 2);
  assert(!r3.ok && /couldn't reach the exchange/i.test(r3.msg), "offline message");
  assert.strictEqual(ctx.Game.state.credits, 50_000, "rollback after throw");

  // 5) dock / unlock rpc wiring
  ctx.Game.state = fresh();
  serverCredits = 100_000;
  ctx.Game.state.credits = 100_000;
  ctx.Cloud.dock = async (system) => ({
    ok: true, travel: true, etaMs: 999,
    travelObj: { from: "navos", to: system, departedAt: T, etaMs: 999 },
  });
  const d = await Economy.dockAt("korrin");
  assert(d.ok && d.etaMs === 999, "server etaMs wins");
  assert.strictEqual(ctx.Game.state.travel.to, "korrin");

  ctx.Game.state = fresh();
  ctx.Game.state.credits = 100_000;
  serverCredits = 100_000;
  const u = await Economy.unlockSystem("thessa");
  assert(u.ok && ctx.Game.state.unlockedSystems.includes("thessa"), "unlock applied");

  // 6) Standing orders await authoritative buys (no silent stall)
  ctx.Game.state = fresh();
  ctx.Game.state.credits = 50_000;
  serverCredits = 50_000; serverPositions = {}; serverAvg = {};
  calls.length = 0;
  ctx.Cloud.trade = async (action, commodity, qty) => {
    calls.push(["trade", action, commodity, qty]);
    const fill = 40, cost = fill * qty;
    serverCredits -= cost;
    serverPositions[commodity] = (serverPositions[commodity] || 0) + qty;
    return {
      ok: true, action, commodity, qty, fillPrice: fill, cost,
      credits: serverCredits, positions: serverPositions, avgCost: { [commodity]: fill },
      stats: { trades: 1, biggestTrade: cost },
    };
  };
  // Force a fill: priceNow always ≤ trigger
  const realPrice = Orders.priceNow.bind(Orders);
  Orders.priceNow = () => 1;
  ctx.Game.state.orders = [{ id: "o1", kind: "buy", commId: "iron_ore", qty: 4, price: 100 }];
  const ev = await Orders.process();
  Orders.priceNow = realPrice;
  assert(ev.length === 1 && ev[0].type === "filled" && ev[0].qty === 4, "order filled via await");
  assert(calls.some(c => c[0] === "trade"), "order used Cloud.trade");
  assert.strictEqual(ctx.Game.state.orders.length, 0, "filled order removed");

  console.log("check_phase1_economy: all assertions passed ✔");
})().catch(e => { console.error(e); process.exit(1); });
