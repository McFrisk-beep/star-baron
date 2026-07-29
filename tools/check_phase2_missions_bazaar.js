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

for (const f of ["store.js", "data.js", "flavor.js", "market.js", "items.js", "extractors.js", "fleet.js", "economy.js", "reputation.js", "missions.js", "bazaar.js"]) {
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

  // 2) Guest mission launch + resolve (claim happens at launch from the board)
  ctx.Game.state = fresh();
  ctx.Game.state.ships.push(Fleet.makeShip("corvette"));
  const contract = {
    id: "ct-local", kind: "job", type: "escort", title: "Test run", sysName: "Alpha",
    danger: "safe", minFirepower: 0, cargoRequired: 0, durationMs: 1000,
    reward: { credits: 5000, itemChance: 0, stockChance: 0 },
    impound: false, stakeTier: 0, faction: null, status: "open",
  };
  ctx.Game.state.bazaar.contracts = [contract];
  const uid = ctx.Game.state.ships[0].uid;
  assert(Missions.launch(contract, [uid]).ok);
  assert.strictEqual(ctx.Game.state.bazaar.contracts.length, 0, "launch claims off the board");
  assert(ctx.Game.state.bazaarBought.includes("ct-local"));
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
  assert.strictEqual(ct.createdAt, epoch * Bazaar.boardEpochMs);
  assert.strictEqual(ct.expiresAt, (epoch + 2) * Bazaar.boardEpochMs);
  assert(Number.isFinite(ct.expiresAt - T), "board expiry delta is finite");
  assert.notStrictEqual(ctx.Util.duration(ct.expiresAt - T), "NaNs");
  assert.strictEqual(ctx.Util.duration(NaN), "now");
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
        ok: true, credits: server.credits, ships: JSON.parse(JSON.stringify(server.ships)), seq: server.seq,
        positions: {}, avgCost: {}, stats: server.stats, mainShip: server.mainShip,
        missions: [], items: {}, inventory: server.inventory,
        pendingContracts: (server.pendingContracts || []).slice(),
        bazaarBought: (server.bazaarBought || []).slice(),
      };
    },
    async takeContract(id) {
      calls.push(["takeContract", id]);
      assert(/^ct-\d+-\d+$/.test(id), "only seeded contract ids");
      const offer = Bazaar.genSeededContract(Bazaar.boardEpoch(T), Number(id.split("-")[2]), 0);
      assert.strictEqual(offer.id, id);
      if (offer.kind === "tip") {
        server.bazaarBought = (server.bazaarBought || []).concat([id]);
        return {
          ok: true, tip: true, cat: offer.cat, credits: server.credits, ships: server.ships,
          pendingContracts: (server.pendingContracts || []).slice(),
          bazaarBought: (server.bazaarBought || []).slice(),
          positions: {}, avgCost: {}, stats: server.stats, mainShip: server.mainShip,
          missions: [], items: {}, inventory: server.inventory,
        };
      }
      // Jobs are claimed at missionLaunch — take is preview-only client-side.
      return { ok: false, error: "Open the contract and Launch to take it." };
    },
    async missionLaunch(contractId, shipUids) {
      calls.push(["missionLaunch", contractId, shipUids]);
      assert(/^ct-\d+-\d+$/.test(contractId), "only seeded contract ids");
      let offer = (server.pendingContracts || []).find(c => c.id === contractId);
      if (!offer) {
        offer = Bazaar.genSeededContract(Bazaar.boardEpoch(T), Number(contractId.split("-")[2]), 0);
        assert.strictEqual(offer.id, contractId);
        assert.strictEqual(offer.kind, "job");
        assert(!(server.bazaarBought || []).includes(contractId), "not already claimed");
        server.bazaarBought = (server.bazaarBought || []).concat([contractId]);
      } else {
        server.pendingContracts = server.pendingContracts.filter(c => c.id !== contractId);
      }
      assert(offer.reward.credits < 100000, "reward is server-authored");
      const sh = server.ships.find(s => s.uid === shipUids[0]);
      sh.status = "mission";
      server.seq = (server.seq || 1) + 1;
      const mission = {
        uid: "m" + server.seq, contractId, type: offer.type, title: offer.title,
        shipUids, totalMs: offer.durationMs, startedAt: T, rngSeed: 42,
        successChance: 0.99, reward: offer.reward, resolved: false,
        phases: [{ label: "x", dir: "out", ms: offer.durationMs }],
      };
      server.missions = (server.missions || []).concat([mission]);
      return {
        ok: true, credits: server.credits,
        ships: JSON.parse(JSON.stringify(server.ships)),
        missions: JSON.parse(JSON.stringify(server.missions)),
        pendingContracts: (server.pendingContracts || []).slice(), mission, seq: server.seq,
        positions: {}, avgCost: {}, stats: server.stats, mainShip: server.mainShip,
        items: {}, inventory: server.inventory,
        bazaarBought: (server.bazaarBought || []).slice(),
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

  // Seed board + launch a real seeded contract id (claim at launch; no take step)
  Bazaar.fillSeededBoard(T);
  const job = ctx.Game.state.bazaar.contracts.find(c => c.kind === "job");
  assert(job, "seeded board has a job");
  const launchR = await Missions.launch(job, [ctx.Game.state.ships[0].uid]);
  assert(launchR.ok);
  assert(calls.some(c => c[0] === "missionLaunch" && c[1] === job.id));
  assert(!(ctx.Game.state.bazaar.contracts || []).some(c => c.id === job.id), "claimed off board");
  assert((ctx.Game.state.bazaarBought || []).includes(job.id));

  T += 10_000_000;
  const authReps = await Missions.resolveMatured(T);
  assert(authReps.length === 1 && authReps[0].success);
  assert(calls.some(c => c[0] === "missionResolve"));

  // 5) Pre-phase2c SQL: launch requires pending — client takes then retries
  T = Date.UTC(2026, 0, 1, 12);
  ctx.Game.state = fresh();
  ctx.Game.state.credits = 90_000;
  ctx.Game.state.ships = [{
    uid: "s1", type: "drift", cls: "transport", name: "Hauler",
    status: "idle", accessories: [], mercenary: false, dmg: 0,
  }];
  server = JSON.parse(JSON.stringify(ctx.Game.state));
  const legacyCalls = [];
  ctx.Cloud.takeContract = async (id) => {
    legacyCalls.push(["takeContract", id]);
    const offer = Bazaar.genSeededContract(Bazaar.boardEpoch(T), Number(id.split("-")[2]), 0);
    assert.strictEqual(offer.kind, "job");
    server.pendingContracts = (server.pendingContracts || []).concat([offer]);
    server.bazaarBought = (server.bazaarBought || []).concat([id]);
    return {
      ok: true, contract: offer, credits: server.credits, ships: server.ships,
      pendingContracts: server.pendingContracts.slice(),
      bazaarBought: server.bazaarBought.slice(),
      positions: {}, avgCost: {}, stats: server.stats, mainShip: server.mainShip,
      missions: [], items: {}, inventory: server.inventory, seq: server.seq,
    };
  };
  ctx.Cloud.missionLaunch = async (contractId, shipUids) => {
    legacyCalls.push(["missionLaunch", contractId, shipUids]);
    let offer = (server.pendingContracts || []).find(c => c.id === contractId);
    if (!offer) {
      return { ok: false, error: "Contract not in hand — take it from the board first." };
    }
    server.pendingContracts = server.pendingContracts.filter(c => c.id !== contractId);
    const sh = server.ships.find(s => s.uid === shipUids[0]);
    sh.status = "mission";
    server.seq = (server.seq || 1) + 1;
    const mission = {
      uid: "m" + server.seq, contractId, type: offer.type, title: offer.title,
      shipUids, totalMs: offer.durationMs, startedAt: T, rngSeed: 7,
      successChance: 0.9, reward: offer.reward, resolved: false,
      phases: [{ label: "x", dir: "out", ms: offer.durationMs }],
    };
    server.missions = (server.missions || []).concat([mission]);
    return {
      ok: true, credits: server.credits,
      ships: JSON.parse(JSON.stringify(server.ships)),
      missions: JSON.parse(JSON.stringify(server.missions)),
      pendingContracts: server.pendingContracts.slice(), mission, seq: server.seq,
      positions: {}, avgCost: {}, stats: server.stats, mainShip: server.mainShip,
      items: {}, inventory: server.inventory,
      bazaarBought: (server.bazaarBought || []).slice(),
    };
  };
  Bazaar.fillSeededBoard(T);
  const legacyJob = ctx.Game.state.bazaar.contracts.find(c => c.kind === "job");
  assert(legacyJob, "legacy board has a job");
  const legacyLaunch = await Missions.launch(legacyJob, ["s1"]);
  assert(legacyLaunch.ok, legacyLaunch.msg || "legacy launch should succeed via take→launch");
  assert.deepStrictEqual(
    legacyCalls.map(c => c[0]),
    ["missionLaunch", "takeContract", "missionLaunch"]
  );

  console.log("check_phase2_missions_bazaar: ok");
})().catch(e => { console.error(e); process.exit(1); });
