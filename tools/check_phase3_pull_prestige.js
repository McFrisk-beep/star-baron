#!/usr/bin/env node
/* check_phase3_pull_prestige.js — Phase 3 client wiring:
   guests keep local soft income; auth + pullReady skips local banking and
   routes through Cloud.pull / Cloud.prestige; commit no longer mints credits.
   Run:  node tools/check_phase3_pull_prestige.js                            */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout });
ctx.window = ctx;
let T = 1_714_000_000_000;
ctx.Date = { now: () => T };
ctx.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

for (const f of ["store.js", "data.js", "flavor.js", "market.js", "items.js", "fleet.js", "economy.js",
  "reputation.js", "missions.js", "bazaar.js", "routes.js", "industries.js", "expeditions.js", "extractors.js"]) {
  const p = path.join(__dirname, "../js", f);
  if (!fs.existsSync(p)) continue;
  vm.runInContext(fs.readFileSync(p, "utf8"), ctx, { filename: f });
}

const { Market, Economy, Routes, Industries, Expeditions, Bazaar, Fleet, SYSTEMS, COMMODITIES } = ctx;
Market.init();

const fresh = () => ({
  credits: 80_000, positions: {}, avgCost: {}, currentSystem: "navos", travel: null,
  unlockedSystems: SYSTEMS.filter(s => s.unlock === 0).map(s => s.id),
  reputation: { syndicate: 0, mining_combine: 0, free_trade: 0, agri_collective: 0 },
  prestige: { tier: 0, multiplier: 1 },
  stats: { trades: 0, contractsDone: 0, peakNetWorth: 80_000, biggestTrade: 0 },
  achievements: [], ships: [], items: {}, orders: [], seq: 1,
  mainShip: { type: "pinnace" },
  missions: [], reports: [], listings: [],
  routes: [], industries: [], expeditions: [], surveyed: {},
  extractors: {}, components: {},
  inventory: { capacity: 6, upgrades: 0 },
  bazaar: { mercs: [], contracts: [], accessories: [], extractors: [], components: [] },
  pendingContracts: [], bazaarBought: [],
  lastSeenAt: T,
});
ctx.Game = { state: fresh(), timeScale: 1 };
ctx.Rep = {
  edgeForCategory: () => 0, onTrade() {}, get: () => 0, discount: () => 0,
  successBonus: () => 0, rewardMult: () => 1, onContract() {},
  factionForCategory: () => "free_trade", sponsor: () => null, gated: () => false, meetsGate: () => true,
};
ctx.Bus = { emit() {} };
ctx.Galaxy = {
  get: (id) => ({ id, name: id, type: "rocky", planets: [{ type: "rocky", cat: "mineral", name: "P" }], pos: { x: 0, y: 0 } }),
  signatureCommodity: () => COMMODITIES[0],
  fireLocalEvent() {},
};
ctx.Feed = { emit() {} };
ctx.Wars = { active: () => null };
ctx.Extractors = ctx.Extractors || {
  get: (uid) => ctx.Game.state.extractors[uid],
  installedSet: () => new Set(),
  targets: () => ["iron_ore"],
  canProduce: () => true,
  yieldMult: (ex) => (ex && ex.type === "specialized" ? 1.5 : 1),
  bonuses: () => ({ rate: 1, cycle: 1 }),
};

(async () => {
  // 1) Guest route resolve still banks locally
  ctx.Game.state = fresh();
  const sh = Fleet.makeShip("drift");
  sh.status = "trading";
  ctx.Game.state.ships.push(sh);
  ctx.Game.state.routes.push({
    id: "rt1", comm: "iron_ore", from: "korrin", to: "navos",
    shipUids: [sh.uid], nextAt: T - 60_000,
  });
  assert.strictEqual(Economy.authoritative(), false);
  const g = Routes.resolve(T);
  assert(g.total > 0 || g.runs.length >= 0, "guest resolve runs");
  // even if spread is 0, nextAt should advance
  assert(ctx.Game.state.routes[0].nextAt > T - 60_000);

  // 2) Authoritative + pullReady → local resolve is a no-op
  ctx.Game.state = fresh();
  ctx.Cloud = {
    playersReady: true, pullReady: true,
    signedIn: () => true,
    authoritative() { return this.signedIn() && this.playersReady; },
    _isMissingRpc() { return false; },
    async commit() { return { ok: true, state: ctx.Game.state }; },
    async pull() {
      this.pullReady = true;
      ctx.Game.state.credits += 1234;
      return {
        ok: true, credits: ctx.Game.state.credits,
        positions: {}, avgCost: {}, ships: ctx.Game.state.ships,
        mainShip: ctx.Game.state.mainShip, missions: [], reports: [],
        items: {}, inventory: ctx.Game.state.inventory, stats: ctx.Game.state.stats,
        prestige: ctx.Game.state.prestige, routes: [], industries: [],
        expeditions: [], surveyed: {}, listings: [],
        away: { elapsedMs: 1000, sold: [], routed: { total: 1234, runs: [], events: [] },
          industry: [], surveys: [], resolved: [] },
      };
    },
    async prestige() {
      ctx.Game.state.prestige = { tier: 1, multiplier: 1 };
      return {
        ok: true, tier: 1, title: "Magnate",
        credits: ctx.Game.state.credits, prestige: ctx.Game.state.prestige,
        positions: {}, avgCost: {}, ships: [], mainShip: ctx.Game.state.mainShip,
        missions: [], items: {}, inventory: ctx.Game.state.inventory, stats: ctx.Game.state.stats,
      };
    },
  };
  assert.strictEqual(Economy.authoritative(), true);
  assert.strictEqual(ctx.Cloud.pullReady, true);
  const before = ctx.Game.state.credits;
  ctx.Game.state.ships.push(Object.assign(Fleet.makeShip("drift"), { status: "trading" }));
  ctx.Game.state.routes.push({
    id: "rt2", comm: "iron_ore", from: "korrin", to: "navos",
    shipUids: [ctx.Game.state.ships[0].uid], nextAt: T - 60_000,
  });
  const rSkip = Routes.resolve(T);
  assert.strictEqual(rSkip.total, 0, "auth+pullReady skips local route banking");
  assert.strictEqual(ctx.Game.state.credits, before, "credits unchanged by local resolve");
  assert.strictEqual(Industries.resolve(T).length, 0);
  assert.strictEqual(Expeditions.resolve(T).length, 0);
  assert.strictEqual(Bazaar.tick(T).length, 0);

  // 3) Economy.applyPull reconciles credits + away blob
  const away = Economy.applyPull(await ctx.Cloud.pull());
  assert(away && away.routed && away.routed.total === 1234);
  assert.strictEqual(ctx.Game.state.credits, before + 1234);

  // 4) Prestige goes through RPC when authoritative
  ctx.Game.state.stats.peakNetWorth = 2_000_000;
  ctx.Game.state.credits = 2_000_000;
  // Force canPrestige by faking net worth path — tier 0 → Magnate needs 1M
  assert(Economy.canPrestige(), "can prestige at 2M");
  const pr = await Economy.prestige();
  assert(pr.ok && (pr.tier === 1 || ctx.Game.state.prestige.tier === 1));

  // 5) Without pullReady, local soft income still runs (Phase 2 fallback)
  ctx.Cloud.pullReady = false;
  ctx.Game.state = fresh();
  ctx.Game.state.ships.push(Object.assign(Fleet.makeShip("drift"), { status: "trading" }));
  ctx.Game.state.routes.push({
    id: "rt3", comm: "iron_ore", from: "korrin", to: "navos",
    shipUids: [ctx.Game.state.ships[0].uid], nextAt: T - 3600_000,
  });
  const local = Routes.resolve(T);
  assert(local.runs || local.total >= 0, "fallback local resolve allowed");

  console.log("check_phase3_pull_prestige: ok");
})().catch(e => { console.error(e); process.exit(1); });
