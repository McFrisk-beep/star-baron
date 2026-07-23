#!/usr/bin/env node
/* check_phase2_missions_bazaar.js — Phase 2 client wiring: guest path stays
   sync/local; authoritative path soft-syncs then calls Cloud mission/bazaar
   RPCs and reconciles server slices.
   Run:  node tools/check_phase2_missions_bazaar.js                            */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout });
ctx.window = ctx;
let T = 1_714_000_000_000;
ctx.Date = { now: () => T };
ctx.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

for (const f of ["store.js", "data.js", "flavor.js", "market.js", "items.js", "fleet.js", "economy.js", "reputation.js", "missions.js", "bazaar.js"]) {
  const p = path.join(__dirname, "../js", f);
  if (!fs.existsSync(p)) continue;
  vm.runInContext(fs.readFileSync(p, "utf8"), ctx, { filename: f });
}

const { Market, Economy, Missions, Bazaar, Fleet, SYSTEMS, SHIP_CATALOG } = ctx;
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
  inventory: { capacity: 6, upgrades: 0 },
  bazaar: { mercs: [], contracts: [], accessories: [], extractors: [], components: [] },
});
ctx.Game = { state: fresh(), timeScale: 1 };
ctx.Rep = {
  edgeForCategory: () => 0, onTrade() {}, get: () => 0, discount: () => 0,
  successBonus: () => 0, rewardMult: () => 1, onContract() {},
  factionForCategory: () => null, sponsor: () => null, gated: () => false, meetsGate: () => true,
};
ctx.Bus = { emit() {} };
ctx.Galaxy = { list: [{ id: "a", name: "Alpha" }] };
ctx.Feed = { emit() {} };
ctx.Extractors = { gen() { return { id: "ex1" }; }, price() { return 100; }, acquire() {} };
ctx.Components = { gen() { return { id: "cp1" }; }, price() { return 50; }, acquire() {} };

(async () => {
  // 1) Guest buy ship is sync
  assert.strictEqual(Economy.authoritative(), false);
  const r0 = Bazaar.buyShip("drift");
  assert(r0 && r0.ok && !(r0 instanceof Promise), "guest buyShip is sync");
  assert.strictEqual(ctx.Game.state.ships.length, 1);
  assert(ctx.Game.state.credits < 80_000);

  // 2) Guest mission launch + resolve
  ctx.Game.state = fresh();
  ctx.Game.state.ships.push(Fleet.makeShip("corvette"));
  const contract = {
    id: "ct1", kind: "job", type: "escort", title: "Test run", sysName: "Alpha",
    danger: "safe", minFirepower: 0, cargoRequired: 0, durationMs: 1000,
    reward: { credits: 5000, itemChance: 0, stockChance: 0 },
    impound: false, stakeTier: 0, faction: null,
  };
  const uid = ctx.Game.state.ships[0].uid;
  const launch0 = Missions.launch(contract, [uid]);
  assert(launch0.ok && ctx.Game.state.missions.length === 1);
  T += 5000;
  const reps = Missions.resolveMatured(T);
  assert(Array.isArray(reps) && reps.length === 1, "guest resolve returns reports");
  assert.strictEqual(ctx.Game.state.missions.length, 0);
  assert(ctx.Game.state.credits >= 80_000); // payout after tax

  // 3) Authoritative buyShip: soft-sync then RPC; server slice wins
  ctx.Game.state = fresh();
  const calls = [];
  let server = JSON.parse(JSON.stringify(ctx.Game.state));
  ctx.Cloud = {
    playersReady: true,
    signedIn: () => true,
    authoritative() { return this.signedIn() && this.playersReady; },
    _isMissingRpc() { return false; },
    async commit(state) {
      calls.push(["commit", state.credits, (state.ships || []).length, (state.bazaar.mercs || []).length]);
      // Phase 2 commit: accept credits + bazaar; protect ships
      server.credits = state.credits;
      server.positions = state.positions;
      server.avgCost = state.avgCost;
      server.bazaar = JSON.parse(JSON.stringify(state.bazaar || {}));
      server.stats = state.stats;
      return { ok: true, state: JSON.parse(JSON.stringify(server)) };
    },
    async buyShip(catalogId) {
      calls.push(["buyShip", catalogId, server.credits]);
      const price = 4200;
      assert(server.credits >= price, "soft income must be on server before buy");
      server.credits -= price;
      server.seq = (server.seq || 1) + 1;
      server.ships = (server.ships || []).concat([{
        uid: "s" + server.seq, type: catalogId, cls: "transport", name: "Server Drift",
        status: "idle", accessories: [], mercenary: false, dmg: 0,
      }]);
      return {
        ok: true, credits: server.credits, ships: server.ships, seq: server.seq,
        positions: server.positions, avgCost: server.avgCost, bazaar: server.bazaar,
        stats: server.stats, mainShip: server.mainShip, missions: server.missions || [],
        items: server.items || {}, inventory: server.inventory,
      };
    },
    async missionLaunch(contract, shipUids) {
      calls.push(["missionLaunch", shipUids]);
      const sh = server.ships.find(s => s.uid === shipUids[0]);
      assert(sh && sh.status === "idle");
      sh.status = "mission";
      server.seq = (server.seq || 1) + 1;
      const mission = {
        uid: "m" + server.seq, type: contract.type, title: contract.title,
        shipUids, totalMs: contract.durationMs, startedAt: T, successChance: 0.99,
        reward: contract.reward, resolved: false, phases: [{ label: "x", dir: "out", ms: contract.durationMs }],
      };
      server.missions = (server.missions || []).concat([mission]);
      return {
        ok: true, credits: server.credits, ships: server.ships, missions: server.missions,
        seq: server.seq, mission, positions: {}, avgCost: {}, bazaar: server.bazaar,
        stats: server.stats, mainShip: server.mainShip, items: {}, inventory: server.inventory,
      };
    },
    async missionResolve() {
      calls.push(["missionResolve"]);
      const done = (server.missions || []).filter(m => T - m.startedAt >= m.totalMs);
      const kept = (server.missions || []).filter(m => T - m.startedAt < m.totalMs);
      const resolved = [];
      for (const m of done) {
        server.credits += 5000;
        for (const u of m.shipUids) {
          const sh = server.ships.find(s => s.uid === u); if (sh) sh.status = "idle";
        }
        resolved.push({ uid: m.uid, success: true, credits: 5000, title: m.title });
      }
      server.missions = kept;
      server.stats.contractsDone = (server.stats.contractsDone || 0) + resolved.length;
      return {
        ok: true, credits: server.credits, ships: server.ships, missions: server.missions,
        resolved, stats: server.stats, positions: {}, avgCost: {}, bazaar: server.bazaar,
        mainShip: server.mainShip, items: {}, inventory: server.inventory, seq: server.seq,
      };
    },
    async takeContract(id) {
      calls.push(["takeContract", id]);
      const offer = (server.bazaar.contracts || []).find(c => c.id === id);
      assert(offer, "offer must exist on soft-synced board");
      server.bazaar.contracts = server.bazaar.contracts.filter(c => c.id !== id);
      return {
        ok: true, contract: offer, credits: server.credits, ships: server.ships,
        bazaar: server.bazaar, positions: {}, avgCost: {}, stats: server.stats,
        mainShip: server.mainShip, missions: [], items: {}, inventory: server.inventory,
      };
    },
  };

  // Soft income then buy
  ctx.Game.state.credits = 90_000; // route income
  assert.strictEqual(Economy.authoritative(), true, "Cloud mock should enable auth");
  const buyP = Bazaar.buyShip("drift");
  assert(buyP && typeof buyP.then === "function", "auth buyShip is async");
  const buyR = await buyP;
  assert(buyR.ok);
  assert.strictEqual(ctx.Game.state.ships.length, 1);
  assert.strictEqual(ctx.Game.state.ships[0].name, "Server Drift", "server slice wins");
  assert(calls.some(c => c[0] === "commit"));
  assert(calls.some(c => c[0] === "buyShip"));
  // commit must have been pre-buy credits (90000), not post-optimistic
  const commitCall = calls.find(c => c[0] === "commit");
  assert.strictEqual(commitCall[1], 90_000, "soft-sync uses pre-buy credits");
  assert.strictEqual(commitCall[2], 0, "soft-sync uses pre-buy ships");

  // 4) takeContract soft-syncs board with offer still present
  calls.length = 0;
  server = JSON.parse(JSON.stringify(ctx.Game.state));
  const job = {
    id: "ct99", kind: "job", type: "escort", title: "Board job", sysName: "Alpha",
    status: "open", danger: "low", minFirepower: 0, cargoRequired: 0, durationMs: 2000,
    reward: { credits: 1000 }, impound: false,
  };
  ctx.Game.state.bazaar.contracts.push(job);
  const takeR = await Bazaar.takeContract("ct99");
  assert(takeR.ok && takeR.contract && takeR.contract.id === "ct99");
  const takeCommit = calls.find(c => c[0] === "commit");
  assert(takeCommit[3] >= 0);
  // pre-take board must still include the offer (mercs length check is weak — verify via commit state)
  assert(calls.some(c => c[0] === "takeContract"));

  // 5) mission launch + resolve auth
  calls.length = 0;
  server = JSON.parse(JSON.stringify(ctx.Game.state));
  const launchR = await Missions.launch(job, [ctx.Game.state.ships[0].uid]);
  assert(launchR.ok);
  assert.strictEqual(ctx.Game.state.ships[0].status, "mission");
  T += 10_000;
  const authReps = await Missions.resolveMatured(T);
  assert(authReps.length === 1 && authReps[0].success);
  assert.strictEqual(ctx.Game.state.missions.length, 0);
  assert.strictEqual(ctx.Game.state.ships[0].status, "idle");
  assert(calls.some(c => c[0] === "missionResolve"));

  console.log("check_phase2_missions_bazaar: ok");
})().catch(e => { console.error(e); process.exit(1); });
