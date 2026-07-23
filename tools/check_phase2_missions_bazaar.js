#!/usr/bin/env node
/* check_phase2_missions_bazaar.js — Phase 2 client wiring + trust boundaries:
   guests stay local; auth path soft-syncs then RPCs; mission launch uses
   contract id (not client reward blob); board ids are seeded.
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

const { Market, Economy, Missions, Bazaar, Fleet, SYSTEMS } = ctx;
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
  pendingContracts: [], bazaarBought: [],
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
ctx.EXTRACTORCFG = ctx.EXTRACTORCFG || { bazaarSlots: 0 };
ctx.COMPONENTCFG = ctx.COMPONENTCFG || { bazaarSlots: 0 };

(async () => {
  // 1) Guest buy ship is sync
  assert.strictEqual(Economy.authoritative(), false);
  const r0 = Bazaar.buyShip("drift");
  assert(r0 && r0.ok && !(r0 instanceof Promise), "guest buyShip is sync");
  assert.strictEqual(ctx.Game.state.ships.length, 1);

  // 2) Guest mission launch + resolve
  ctx.Game.state = fresh();
  ctx.Game.state.ships.push(Fleet.makeShip("corvette"));
  const contract = {
    id: "ct-local", kind: "job", type: "escort", title: "Test run", sysName: "Alpha",
    danger: "safe", minFirepower: 0, cargoRequired: 0, durationMs: 1000,
    reward: { credits: 5000, itemChance: 0, stockChance: 0 },
    impound: false, stakeTier: 0, faction: null,
  };
  const uid = ctx.Game.state.ships[0].uid;
  assert(Missions.launch(contract, [uid]).ok);
  T += 5000;
  const reps = Missions.resolveMatured(T);
  assert(Array.isArray(reps) && reps.length === 1);

  // 3) Seeded board ids are deterministic
  const epoch = Bazaar.boardEpoch(T);
  const m0 = Bazaar.genSeededMerc(epoch, 0);
  const m0b = Bazaar.genSeededMerc(epoch, 0);
  assert.strictEqual(m0.id, `mc-${epoch}-0`);
  assert.strictEqual(m0.hireCost, m0b.hireCost);
  assert(m0.hireCost > 0, "seeded merc has real hire cost");
  const ac = Bazaar.genSeededAccessory(epoch, 0);
  assert.strictEqual(ac.id, `ac-${epoch}-0`);
  assert(ac.price > 0 && ac.item.value > 0);
  const ct = Bazaar.genSeededContract(epoch, 1, 0);
  assert.strictEqual(ct.id, `ct-${epoch}-1`);
  if (ct.kind === "job") assert(ct.reward.credits > 0 && ct.reward.credits < 100000);

  // 4) Authoritative buyShip + take/launch by contract id (not reward blob)
  ctx.Game.state = fresh();
  const calls = [];
  let server = JSON.parse(JSON.stringify(ctx.Game.state));
  ctx.Cloud = {
    playersReady: true,
    signedIn: () => true,
    authoritative() { return this.signedIn() && this.playersReady; },
    _isMissingRpc() { return false; },
    async commit(state) {
      calls.push(["commit", state.credits, (state.ships || []).length]);
      server.credits = state.credits;
      server.positions = state.positions;
      server.avgCost = state.avgCost;
      server.stats = state.stats;
      // Phase 2 commit ignores client bazaar / protects fleet
      return { ok: true, state: JSON.parse(JSON.stringify(server)) };
    },
    async buyShip(catalogId) {
      calls.push(["buyShip", catalogId]);
      const price = 4200;
      server.credits -= price;
      server.seq = (server.seq || 1) + 1;
      server.ships = (server.ships || []).concat([{
        uid: "s" + server.seq, type: catalogId, cls: "transport", name: "Server Drift",
        status: "idle", accessories: [], mercenary: false, dmg: 0,
      }]);
      return {
        ok: true, credits: server.credits, ships: server.ships, seq: server.seq,
        positions: {}, avgCost: {}, stats: server.stats, mainShip: server.mainShip,
        missions: [], items: {}, inventory: server.inventory,
        pendingContracts: server.pendingContracts || [], bazaarBought: server.bazaarBought || [],
      };
    },
    async takeContract(id) {
      calls.push(["takeContract", id]);
      // Server recomputes offer — reject forged ids outside seed pattern
      assert(/^ct-\d+-\d+$/.test(id), "only seeded contract ids");
      const offer = Bazaar.genSeededContract(Bazaar.boardEpoch(T), Number(id.split("-")[2]), 0);
      assert.strictEqual(offer.id, id);
      server.bazaarBought = (server.bazaarBought || []).concat([id]);
      server.pendingContracts = (server.pendingContracts || []).concat([offer]);
      return {
        ok: true, contract: offer, credits: server.credits, ships: server.ships,
        pendingContracts: server.pendingContracts, bazaarBought: server.bazaarBought,
        positions: {}, avgCost: {}, stats: server.stats, mainShip: server.mainShip,
        missions: [], items: {}, inventory: server.inventory,
      };
    },
    async missionLaunch(contractId, shipUids) {
      calls.push(["missionLaunch", contractId, shipUids]);
      // Must NOT accept a client reward blob — only an id already in pending
      const pending = (server.pendingContracts || []).find(c => c.id === contractId);
      assert(pending, "launch requires server pending contract");
      assert(pending.reward.credits < 100000, "reward is server-authored");
      const sh = server.ships.find(s => s.uid === shipUids[0]);
      sh.status = "mission";
      server.seq = (server.seq || 1) + 1;
      const mission = {
        uid: "m" + server.seq, contractId, type: pending.type, title: pending.title,
        shipUids, totalMs: pending.durationMs, startedAt: T, rngSeed: 42,
        successChance: 0.99, reward: pending.reward, resolved: false,
        phases: [{ label: "x", dir: "out", ms: pending.durationMs }],
      };
      server.missions = (server.missions || []).concat([mission]);
      server.pendingContracts = server.pendingContracts.filter(c => c.id !== contractId);
      return {
        ok: true, credits: server.credits, ships: server.ships, missions: server.missions,
        pendingContracts: server.pendingContracts, mission, seq: server.seq,
        positions: {}, avgCost: {}, stats: server.stats, mainShip: server.mainShip,
        items: {}, inventory: server.inventory, bazaarBought: server.bazaarBought,
      };
    },
    async missionResolve() {
      calls.push(["missionResolve"]);
      const done = (server.missions || []).filter(m => T - m.startedAt >= m.totalMs);
      const kept = (server.missions || []).filter(m => T - m.startedAt < m.totalMs);
      const resolved = [];
      for (const m of done) {
        const pay = Math.min(m.reward.credits, 200000);
        server.credits += pay;
        for (const u of m.shipUids) {
          const sh = server.ships.find(s => s.uid === u); if (sh) sh.status = "idle";
        }
        resolved.push({ uid: m.uid, success: true, credits: pay, title: m.title });
      }
      server.missions = kept;
      return {
        ok: true, credits: server.credits, ships: server.ships, missions: server.missions,
        resolved, stats: server.stats, positions: {}, avgCost: {},
        mainShip: server.mainShip, items: {}, inventory: server.inventory, seq: server.seq,
        pendingContracts: server.pendingContracts || [], bazaarBought: server.bazaarBought || [],
      };
    },
  };

  ctx.Game.state.credits = 90_000;
  assert.strictEqual(Economy.authoritative(), true);
  const buyR = await Bazaar.buyShip("drift");
  assert(buyR.ok);
  assert.strictEqual(ctx.Game.state.ships[0].name, "Server Drift");

  // Seed board + take a real seeded contract id
  Bazaar.fillSeededBoard(T);
  const job = ctx.Game.state.bazaar.contracts.find(c => c.kind === "job");
  assert(job, "seeded board has a job");
  const takeR = await Bazaar.takeContract(job.id);
  assert(takeR.ok && takeR.contract && takeR.contract.id === job.id);
  assert(calls.some(c => c[0] === "takeContract" && c[1] === job.id));

  const launchR = await Missions.launch(takeR.contract, [ctx.Game.state.ships[0].uid]);
  assert(launchR.ok);
  assert(calls.some(c => c[0] === "missionLaunch" && c[1] === job.id));

  T += 10_000_000;
  const authReps = await Missions.resolveMatured(T);
  assert(authReps.length === 1 && authReps[0].success);
  assert(calls.some(c => c[0] === "missionResolve"));

  console.log("check_phase2_missions_bazaar: ok");
})().catch(e => { console.error(e); process.exit(1); });
