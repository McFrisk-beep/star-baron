#!/usr/bin/env node
/* check_route_price.js — routePrice drops rare-stock premium; bestPair ranks by ¢/h.
   Run:  node tools/check_route_price.js                                         */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math });
ctx.window = ctx;
let T = 1_714_000_000_000;
ctx.Date = { now: () => T };

// Stub Fleet before routes.js so we don't need the full fleet/mainShip graph.
ctx.Fleet = {
  ship(uid) { return (ctx.Game.state.ships || []).find(s => s.uid === uid) || null; },
  stats() { return { cargo: 12, speed: 1.5, firepower: 1, hull: 40, armor: 5, shields: 0, scan: 0, endure: 0 }; },
  shipDef() { return { speed: 1.5, cls: "transport", name: "Mule" }; },
  addDamage() {},
};
for (const f of ["store.js", "data.js", "market.js", "routes.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}
const { Market, Routes, SYSTEMS, COMMODITIES, MARKETCFG } = ctx;
Market.init();

ctx.Game = {
  state: {
    unlockedSystems: SYSTEMS.map(s => s.id),
    ships: [{ uid: "s1", type: "mule", name: "Hauler", status: "idle", accessories: [], dmg: 0 }],
    routes: [], seq: 1, mainShip: { type: "pinnace" },
  },
  timeScale: 1,
};
ctx.Senate = { travelSpeedMult: () => 1, travelEdictNote: () => "", routeSafetyAdd: () => 0 };

// 1) common: routePrice === systemPrice
assert.ok(Math.abs(Market.routePrice("iron_ore", "navos") - Market.systemPrice("iron_ore", "navos")) < 1e-9,
  "routePrice == systemPrice for common goods");

// 2) rare stocked at a host: routePrice = systemPrice / rareStockPremium
const rare = COMMODITIES.find(c => c.id === "exotic_pelts") || COMMODITIES.find(c => c.rarity === "rare" && !c.craftOnly);
assert.ok(rare, "have a rare tradeable");
const host = SYSTEMS.map(s => s.id).find(id => Market.stocks(rare.id, id));
assert.ok(host, `${rare.id} has a rare host`);
const prem = MARKETCFG.rareStockPremium || 1.35;
const sysP = Market.systemPrice(rare.id, host);
const routeP = Market.routePrice(rare.id, host);
assert.ok(routeP < sysP - 1e-6, `rare premium dropped at ${host}: route=${routeP} sys=${sysP}`);
assert.ok(Math.abs(routeP * prem - sysP) / sysP < 1e-6, "routePrice × premium ≈ systemPrice");

// 3) bestPair maximizes spread/cycleMs (¢/h with unit cargo)
const unlocked = SYSTEMS.map(s => s.id);
const best = Routes.bestPair(rare.id, unlocked, ["s1"]);
assert.ok(best && best.from !== best.to, "bestPair returns a pair");
let bestScore = -Infinity;
for (const from of unlocked) for (const to of unlocked) {
  if (from === to) continue;
  const e = Routes.preview(["s1"], rare.id, from, to);
  if (!(e.spread > 0) || !(e.cycleMs > 0)) continue;
  bestScore = Math.max(bestScore, e.spread / e.cycleMs);
}
const picked = Routes.preview(["s1"], rare.id, best.from, best.to);
assert.ok(Math.abs(picked.spread / picked.cycleMs - bestScore) < 1e-12, "bestPair maximizes spread/cycleMs");

console.log(`check_route_price: routePrice premium skip + bestPair ¢/h ✔ (${rare.id} @ ${host})`);
