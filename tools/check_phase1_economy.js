#!/usr/bin/env node
/* check_phase1_economy.js — Phase 1 client wiring: guest path stays sync/local;
   authoritative path calls Cloud.trade/dock/unlock and reconciles server slices
   (optimistic apply + rollback on failure).
   Run:  node tools/check_phase1_economy.js                                      */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout });
ctx.window = ctx;
let T = 1_714_000_000_000;
ctx.Date = { now: () => T };
ctx.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

for (const f of ["store.js", "data.js", "market.js", "economy.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}

const { Market, Economy, SYSTEMS } = ctx;
Market.init();

const fresh = () => ({
  credits: 50_000, positions: {}, avgCost: {}, currentSystem: "navos", travel: null,
  unlockedSystems: SYSTEMS.filter(s => s.unlock === 0).map(s => s.id),
  reputation: { syndicate: 0, mining_combine: 0, free_trade: 0, agri_collective: 0 },
  prestige: { tier: 0, multiplier: 1 },
  stats: { trades: 0, contractsDone: 0, peakNetWorth: 50_000, biggestTrade: 0 },
  achievements: [], ships: [], items: {},
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

  // 2) Authoritative success: rpc called, server slice wins
  ctx.Game.state = fresh();
  const calls = [];
  ctx.Cloud = {
    playersReady: true,
    signedIn: () => true,
    authoritative() { return this.signedIn() && this.playersReady; },
    async trade(action, commodity, qty) {
      calls.push(["trade", action, commodity, qty]);
      return {
        ok: true, action, commodity, qty, fillPrice: 41.5,
        cost: 41.5 * qty, credits: 50_000 - 41.5 * qty,
        positions: { [commodity]: qty }, avgCost: { [commodity]: 41.5 },
        stats: { trades: 1, biggestTrade: 41.5 * qty },
      };
    },
    async dock(system) {
      calls.push(["dock", system]);
      return { ok: true, travel: true, etaMs: 12345, travelObj: { from: "navos", to: system, departedAt: T, etaMs: 12345 } };
    },
    async unlock(system) {
      calls.push(["unlock", system]);
      return { ok: true, credits: 44_000, unlockedSystems: ["navos", "korrin", "velm", system] };
    },
  };

  const r1 = await Economy.buy("iron_ore", 5);
  assert(r1.ok, "auth buy ok");
  assert.deepStrictEqual(calls[0], ["trade", "buy", "iron_ore", 5], "Cloud.trade args");
  assert.strictEqual(ctx.Game.state.credits, 50_000 - 41.5 * 5, "server credits applied");
  assert.strictEqual(r1.price, 41.5, "fillPrice reconciled onto result");

  // 3) Authoritative failure rolls back optimistic credits
  ctx.Game.state = fresh();
  calls.length = 0;
  ctx.Cloud.trade = async () => { calls.push("fail"); return { ok: false, error: "Nope." }; };
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
  calls.length = 0;
  ctx.Cloud.dock = async (system) => {
    calls.push(["dock", system]);
    return { ok: true, travel: true, etaMs: 999, travelObj: { from: "navos", to: system, departedAt: T, etaMs: 999 } };
  };
  const d = await Economy.dockAt("korrin");
  assert(d.ok && d.etaMs === 999, "server etaMs wins");
  assert.strictEqual(ctx.Game.state.travel.to, "korrin");

  ctx.Game.state = fresh();
  ctx.Game.state.credits = 100_000;
  const u = await Economy.unlockSystem("thessa");
  assert(u.ok && ctx.Game.state.unlockedSystems.includes("thessa"), "unlock applied");
  assert.strictEqual(ctx.Game.state.credits, 44_000, "server unlock credits");

  console.log("check_phase1_economy: all assertions passed ✔");
})().catch(e => { console.error(e); process.exit(1); });
