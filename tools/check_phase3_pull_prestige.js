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
  "reputation.js", "missions.js", "bazaar.js", "charters.js", "industries.js", "expeditions.js", "extractors.js"]) {
  const p = path.join(__dirname, "../js", f);
  if (!fs.existsSync(p)) continue;
  vm.runInContext(fs.readFileSync(p, "utf8"), ctx, { filename: f });
}

const { Market, Economy, Charters, Industries, Expeditions, Bazaar, Fleet, SYSTEMS, COMMODITIES } = ctx;
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
  charters: [], industries: [], expeditions: [], surveyed: {},
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
ctx.Boosts = { mag: () => 0 };
ctx.Extractors = ctx.Extractors || {
  get: (uid) => ctx.Game.state.extractors[uid],
  installedSet: () => new Set(),
  targets: () => ["iron_ore"],
  canProduce: () => true,
  yieldMult: (ex) => (ex && ex.type === "specialized" ? 1.5 : 1),
  bonuses: () => ({ rate: 1, cycle: 1 }),
};

(async () => {
  // 1) Guest charter resolve still banks locally
  ctx.Game.state = fresh();
  const sh = Object.assign(Fleet.makeShip("drift"), { status: "idle" });
  ctx.Game.state.ships.push(sh, Object.assign(Fleet.makeShip("mule"), { status: "idle" }));
  const d = Charters.dispatch(sh.uid, "safe", 60, T);
  assert(d.ok, d.msg);
  assert.strictEqual(Economy.authoritative(), false);
  T += 3600000;
  const g = Charters.resolve(T);
  assert.strictEqual(g.length, 1, "guest charter resolves");
  assert(g[0].credits > 0);

  // 2) Authoritative + pullReady → local soft income is a no-op
  T = 1_714_000_000_000;
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
  const sh2 = Object.assign(Fleet.makeShip("drift"), { status: "idle" });
  ctx.Game.state.ships.push(sh2, Object.assign(Fleet.makeShip("mule"), { status: "idle" }));
  const d2 = Charters.dispatch(sh2.uid, "safe", 60, T);
  assert(d2.ok);
  T += 3600000;
  const rSkip = Charters.resolve(T);
  // Charters are client-local until app_charter_* — matured jobs pay out even
  // under Phase 3 (same ledger path the old Buy out used).
  assert.strictEqual(rSkip.length, 1, "auth+pullReady still resolves matured charters");
  assert.ok(rSkip[0].credits > 0, "charter payout credited under Phase 3");
  assert.strictEqual(sh2.status, "idle", "chartered hull unlocked");
  const paid = rSkip[0].credits;
  assert.strictEqual(ctx.Game.state.credits, before + paid, "payout landed");
  assert.strictEqual(ctx.Game.state.charters.length, 0, "no payout-pending row left behind");
  assert.strictEqual(Industries.resolve(T).length, 0);
  assert.strictEqual(Expeditions.resolve(T).length, 0);
  assert.strictEqual(Bazaar.tick(T).length, 0);

  // 3) Economy.applyPull reconciles credits + away blob
  const away = Economy.applyPull(await ctx.Cloud.pull());
  assert(away && away.routed && away.routed.total === 1234);
  assert.strictEqual(ctx.Game.state.credits, before + paid + 1234);

  // 4) Prestige goes through RPC when authoritative
  ctx.Game.state.stats.peakNetWorth = 2_000_000;
  ctx.Game.state.credits = 2_000_000;
  assert(Economy.canPrestige(), "can prestige at 2M");
  const pr = await Economy.prestige();
  assert(pr.ok && (pr.tier === 1 || ctx.Game.state.prestige.tier === 1));

  // 5) Without pullReady, local soft income is gated:
  //    - pull not missing yet → no local mint
  //    - pullMissing → Phase 2 fallback allowed
  T = 1_714_000_000_000;
  ctx.Cloud.pullReady = false;
  ctx.Cloud.pullMissing = false;
  ctx.Game.state = fresh();
  const sh3 = Object.assign(Fleet.makeShip("drift"), { status: "idle" });
  ctx.Game.state.ships.push(sh3, Object.assign(Fleet.makeShip("mule"), { status: "idle" }));
  Charters.dispatch(sh3.uid, "safe", 60, T);
  T += 3600000;
  const gated = Charters.resolve(T);
  assert.strictEqual(gated.length, 1, "auth without pullReady still resolves");
  assert.ok(gated[0].credits > 0, "charter pays regardless of pull state");
  assert.strictEqual(ctx.Game.state.credits, fresh().credits + gated[0].credits, "payout landed");
  // Dispatch another under pullMissing (Phase 2 fallback)
  ctx.Cloud.pullMissing = true;
  const sh3b = Object.assign(Fleet.makeShip("drift"), { status: "idle" });
  ctx.Game.state.ships.push(sh3b);
  Charters.dispatch(sh3b.uid, "safe", 60, T);
  T += 3600000;
  const local = Charters.resolve(T);
  assert.strictEqual(local.length, 1, "pullMissing Phase 2 fallback allowed");
  assert.ok(local[0].credits > 0, "pullMissing still pays charter credits");

  // 6) Charter reconcile restores status after a server ship slice
  ctx.Cloud.pullReady = true;
  ctx.Game.state = fresh();
  const rShip = Object.assign(Fleet.makeShip("drift"), { status: "idle" });
  ctx.Game.state.ships.push(rShip, Object.assign(Fleet.makeShip("mule"), { status: "idle" }));
  const rs = Charters.dispatch(rShip.uid, "safe", 60, T);
  assert(rs.ok);
  // Simulate commit echoing ships as idle
  ctx.Game.state.ships[0].status = "idle";
  Charters.reconcileShips();
  assert.strictEqual(ctx.Game.state.ships[0].status, "charter", "reconcile re-locks charter hull");

  console.log("check_phase3_pull_prestige: ok");
})().catch(e => { console.error(e); process.exit(1); });
