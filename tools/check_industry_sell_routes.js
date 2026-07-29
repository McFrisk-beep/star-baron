#!/usr/bin/env node
/* check_industry_sell_routes.js — regression for:
   1) Logged-in industry stock must not become unsellable ghost positions.
   2) Trade-route nextAt heal + schedule align; authoritative cycles ignore fast-time.
   Run:  node tools/check_industry_sell_routes.js                               */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout });
ctx.window = ctx;
let T = 1_714_000_000_000;
ctx.Date = { now: () => T };
ctx.localStorage = {
  _d: {}, getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; },
};
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

for (const f of ["store.js", "data.js", "flavor.js", "market.js", "items.js", "fleet.js",
  "economy.js", "reputation.js", "routes.js", "industries.js", "extractors.js", "bazaar.js", "expeditions.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}

const { Market, Fleet, Routes, Industries, Economy, SYSTEMS, CONFIG } = ctx;
Market.init();

const fresh = () => ({
  credits: 10000, positions: {}, avgCost: {}, currentSystem: "navos", travel: null,
  unlockedSystems: SYSTEMS.filter(s => s.unlock === 0).map(s => s.id),
  ships: [], routes: [], industries: [], extractors: {}, components: {}, items: {}, seq: 1,
  prestige: { tier: 0, multiplier: 1 }, mainShip: { type: "pinnace" },
  stats: { trades: 0, contractsDone: 0, peakNetWorth: 10000, biggestTrade: 0 },
  reputation: { syndicate: 0, mining_combine: 0, free_trade: 0, agri_collective: 0 },
  achievements: [], listings: [],
  bazaar: { mercs: [], contracts: [], accessories: [], extractors: [], components: [] },
});

ctx.Game = { state: fresh(), timeScale: 1 };
ctx.Rep = {
  edgeForCategory: () => 0, onTrade() {}, get: () => 0, discount: () => 0,
  priceMult: () => 1, factionForCategory: () => "free_trade", onContract() {},
  successBonus: () => 0, sponsor: () => null, gated: () => false, meetsGate: () => true,
};
ctx.Bus = { emit() {} };
ctx.Wars = { active: () => null };
ctx.Senate = {
  travelSpeedMult: () => 1, industryTaxAdd: () => 0, tradeTax: () => 0, isBanned: () => false,
  spreadAdd: () => 0, windfallSurtax: () => 0, routeSafetyAdd: () => 0, salvageBonusAdd: () => 0,
  industryTaxLines: () => [], travelEdictNote: () => "", banInfo: () => null, tariffLines: () => [],
  priceEdictLines: () => [], windfallLines: () => [],
};
ctx.Galaxy = {
  get: (id) => ({ id, name: id, sectorId: "core", planets: [{ type: "rocky", cat: "mineral", name: "P" }], pos: { x: 0, y: 0 } }),
};

(async () => {
  // ---- softIncomeLocal gates ----
  assert.strictEqual(Routes.softIncomeLocal(), true, "guest soft income local");

  ctx.Cloud = {
    playersReady: true, pullReady: false, pullMissing: false,
    signedIn: () => true,
    authoritative() { return this.signedIn() && this.playersReady; },
    _isMissingRpc() { return false; },
  };
  assert.strictEqual(Economy.authoritative(), true);
  assert.strictEqual(Routes.softIncomeLocal(), false, "auth without pull: no local mint");

  // Industry resolve must not mint ghost stock in that window
  ctx.Game.state = fresh();
  ctx.Game.state.extractors.ex1 = { uid: "ex1", type: "jack", scope: "all", name: "X", components: [] };
  ctx.Game.state.industries.push({
    id: "navos#0", systemId: "navos", planetIdx: 0, extractorUid: "ex1",
    commodity: "iron_ore", cat: "mineral", nextAt: T - 1000,
    planetType: "rocky", faction: null, suit: 1,
  });
  assert.strictEqual(Industries.resolve(T).length, 0);
  assert.strictEqual(ctx.Game.state.positions.iron_ore || 0, 0);

  // Phase 2 fallback when pull RPC is confirmed missing
  ctx.Cloud.pullMissing = true;
  assert.strictEqual(Routes.softIncomeLocal(), true);
  const made = Industries.resolve(T);
  assert(made.length > 0 && (ctx.Game.state.positions.iron_ore || 0) > 0, "fallback mints stock");

  // pullReady → no local mint
  ctx.Cloud.pullMissing = false;
  ctx.Cloud.pullReady = true;
  ctx.Game.state.positions = {};
  ctx.Game.state.industries[0].nextAt = T - 1000;
  assert.strictEqual(Industries.resolve(T).length, 0);

  // ---- sell clears / resyncs ghost stock ----
  let serverPositions = {};
  ctx.Cloud.commit = async (state) => ({
    ok: true,
    state: Object.assign({}, state, { positions: Object.assign({}, serverPositions), credits: state.credits }),
  });
  ctx.Cloud.trade = async (action, commodity, qty) => {
    const held = serverPositions[commodity] || 0;
    if (action === "sell" && held <= 0) return { ok: false, error: "Nothing to sell." };
    serverPositions[commodity] = held - qty;
    return {
      ok: true, qty, proceeds: qty * 10, fillPrice: 10, tax: 0,
      positions: Object.assign({}, serverPositions), credits: 10000, avgCost: {},
    };
  };
  ctx.Game.pullCatchUp = async () => {
    // Simulate pull adopting server positions (empty)
    ctx.Game.state.positions = Object.assign({}, serverPositions);
    return {};
  };
  ctx.Game.state.positions = { iron_ore: 40 }; // ghost
  ctx.Game.state.avgCost = { iron_ore: 0 };
  const sell = await Economy.sell("iron_ore", 10);
  assert.strictEqual(sell.ok, false);
  assert(/exchange ledger/i.test(sell.msg) || /nothing to sell/i.test(sell.msg), sell.msg);
  assert.strictEqual(ctx.Game.state.positions.iron_ore || 0, 0, "ghost cleared");

  // ---- route timing ----
  ctx.Cloud.pullReady = false;
  ctx.Cloud.pullMissing = true; // guest-like local resolve for timing checks
  // actually authoritative+pullMissing uses catalog speed in cycleMsFor
  ctx.Game.state = fresh();
  const sh = Object.assign(Fleet.makeShip("corvette"), { status: "trading", dmg: 0.5 });
  ctx.Game.state.ships.push(sh);
  ctx.Game.state.routes.push({
    id: "rt1", comm: "iron_ore", from: "korrin", to: "navos",
    shipUids: [sh.uid], nextAt: T,
  });
  ctx.Game.timeScale = 60;
  const authCycle = Routes.cycleMsFor(ctx.Game.state.routes[0]);
  assert(authCycle > 60_000, "auth cycles ignore fast-time: " + authCycle);

  // Guest path still scales
  ctx.Cloud.playersReady = false;
  assert.strictEqual(Routes.softIncomeLocal(), true);
  const guestFast = Routes.cycleMsFor(ctx.Game.state.routes[0]);
  assert(guestFast < authCycle, "guest fast-time shortens cycle");
  assert(guestFast >= CONFIG.marketTickMs);

  // Heal missing nextAt + schedule align (no per-tick spam)
  ctx.Cloud.playersReady = true;
  ctx.Cloud.pullMissing = true;
  ctx.Game.timeScale = 1;
  delete ctx.Game.state.routes[0].nextAt;
  ctx.ROUTECFG.eventChance = 1;
  let events = 0;
  for (let i = 0; i < 5; i++) {
    T += CONFIG.marketTickMs;
    const r = Routes.resolve(T);
    events += r.events.length;
  }
  // First tick heals + may bank once; later ticks must wait a full cycle (~minutes)
  assert(events <= 1, "missing nextAt must not toast every tick, got " + events);
  assert(ctx.Game.state.routes[0].nextAt > T, "nextAt in the future after resolve");

  console.log("check_industry_sell_routes: ok");
})().catch(e => { console.error(e); process.exit(1); });
