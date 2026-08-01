/* check_corrupt_restore.js — wipe-backup helpers recover Workshop / inventory
   slices without needing a browser. Loads real sibling modules so migrate runs. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const mem = { local: null, corrupt: null };
const sandbox = {
  console,
  Date, Math, JSON, Array, Object, Number, String, Boolean, Error, TypeError, Set, Map, Promise,
  setTimeout, clearTimeout,
  matchMedia: () => ({ matches: false, addListener() {}, removeListener() {} }),
  localStorage: {
    getItem: (k) => (k === "starbaron.corrupt" ? mem.corrupt : k === "starbaron" ? mem.local : null),
    setItem: (k, v) => { if (k === "starbaron.corrupt") mem.corrupt = v; else if (k === "starbaron") mem.local = v; },
    removeItem: (k) => { if (k === "starbaron.corrupt") mem.corrupt = null; else if (k === "starbaron") mem.local = null; },
  },
  document: {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    body: { classList: { toggle() {} }, insertAdjacentHTML() {} },
    addEventListener() {},
    createElement: () => ({ classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } }, style: {}, append() {}, addEventListener() {} }),
  },
  window: null,
  performance: { now: () => Date.now() },
  navigator: { language: "en" },
  addEventListener() {},
  removeEventListener() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

// Minimal stubs for modules mergeCorruptClientSlices / migrate touch indirectly.
sandbox.Bazaar = { itemsValue: () => 0, ensure() {} };
sandbox.Galaxy = { build() {}, hydrate() {}, serialize: () => null, localLog: {}, get: () => null };
sandbox.Market = {
  init() {}, hydrate() {}, serialize: () => null, advance() {},
  effects: [], localEffects: [], volMult: 1, price: () => 10, stocks: () => true,
};
sandbox.Bus = { on() {}, emit() {} };

const files = [
  "js/data.js", "js/flavor.js", "js/cloud-config.js", "js/store.js", "js/cloud.js",
  "js/items.js", "js/fleet.js", "js/economy.js", "js/reputation.js",
  "js/workshop.js", "js/main.js",
];
for (const f of files) {
  vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx, { filename: f });
}

function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exit(1); } }

const Game = sandbox.Game;
Game.state = Game.defaultState();
Game.state.credits = 1500;
Game.state.items = {};
Game.state.knownRecipes = ["gear_plating_common"];
Game.state.workshop = { upgrades: 0, queue: [] };

const bak = Game.defaultState();
bak.credits = 9000;
bak.items = { i99: { uid: "i99", kind: "plating", name: "Lost Plating", rarity: "common" } };
bak.knownRecipes = ["gear_plating_common", "ev_jack", "ship_mule"];
bak.workshop = {
  upgrades: 1,
  queue: [{ id: "ck1", recipeId: "gear_plating_common", startedAt: 1, readyAt: 2, flavorId: null }],
};
mem.corrupt = JSON.stringify(bak);

assert(Game.readCorruptBackup(), "reads starbaron.corrupt");
assert(Game.corruptBackupIsRicher(), "backup with Workshop gear counts as richer");
assert(Game.corruptBackupSummary().includes("inventory item"), "summary mentions inventory");
assert(Game.corruptBackupSummary().includes("craft"), "summary mentions craft queue");

const r = Game.mergeCorruptClientSlices();
assert(r.ok, "soft-merge succeeds: " + (r.msg || ""));
assert(Game.state.items.i99 && Game.state.items.i99.name === "Lost Plating", "restored inventory item");
assert(Game.state.workshop.queue.some(j => j.id === "ck1"), "restored craft queue job");
assert(Game.state.workshop.upgrades === 1, "restored workshop upgrades");
assert(Game.state.knownRecipes.includes("ship_mule"), "restored blueprint");
assert(Game.state.credits === 1500, "soft-merge keeps current credits");

const r2 = Game.mergeCorruptClientSlices();
assert(!r2.ok, "second merge reports nothing missing");

console.log("All corrupt-restore checks passed.");
