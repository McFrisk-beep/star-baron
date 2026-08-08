#!/usr/bin/env node
/* check_craft_client.js — the client half of server-authoritative crafting.

   The bug this guards: Workshop._deliver used to mint the finished item into
   state.items in the browser, but app_commit rewrites `items` from the server
   pool, so the next cloud sync deleted it (~5s later). On the server ledger,
   resolve() must therefore NOT deliver locally — it has to claim, and take the
   item from the server's answer.

   Checked (no browser, no Postgres — real modules in a vm sandbox):
   1) GUESTS keep the old local path exactly: craft queues, resolve delivers.
   2) AUTHORITATIVE resolve() mints nothing locally and calls app_craft_claim;
      the delivered goods come from the server slice.
   3) AUTHORITATIVE craft()/buySlot() go through the RPCs.
   4) adoptLocal() offers the local queue + crafted items once, and again when
      forced (a wipe-backup restore lands after the boot adopt).
   5) A project without docs/sql/workshop_craft.sql falls back to local crafting
      instead of erroring on every click.

   Run:  node tools/check_craft_client.js                                      */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");

const root = path.join(__dirname, "..");
const sandbox = {
  console, Date, Math, JSON, Array, Object, Number, String, Boolean, Error, TypeError,
  Set, Map, Promise, setTimeout, clearTimeout,
  matchMedia: () => ({ matches: false, addListener() {}, removeListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    body: { classList: { toggle() {} }, insertAdjacentHTML() {} },
    addEventListener() {},
    createElement: () => ({ classList: { toggle() {}, add() {}, remove() {} }, style: {}, append() {}, addEventListener() {} }),
  },
  window: null,
  performance: { now: () => Date.now() },
  navigator: { language: "en" },
  addEventListener() {}, removeEventListener() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

sandbox.Bazaar = { itemsValue: () => 0, ensure() {}, inventoryUsed: () => 0, capacity: () => 6, equippedSet: () => new Set() };
sandbox.Galaxy = { build() {}, hydrate() {}, serialize: () => null, localLog: {}, get: () => null };
sandbox.Market = { init() {}, hydrate() {}, serialize: () => null, advance() {}, effects: [], localEffects: [], volMult: 1, price: () => 10, spot: () => 10, stocks: () => true };
sandbox.Extractors = {
  pool() { return sandbox.Game.state.extractors; },
  acquire(ex) { this.pool()[ex.uid] = ex; return ex; },
  name: (t, s) => `${t} ${s}`,
};

for (const f of ["js/data.js", "js/flavor.js", "js/cloud-config.js", "js/store.js", "js/cloud.js",
                 "js/items.js", "js/fleet.js", "js/economy.js", "js/reputation.js",
                 "js/workshop.js", "js/main.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx, { filename: f });
}

const { Game, Workshop, Cloud, Economy, Bus } = sandbox;

// ---- harness ---------------------------------------------------------------
const RECIPE = "gear_plating_common";          // iron_ore 6 + silicon 2, 20 min
const CRAFT_MS = 20 * 60 * 1000;
const calls = [];
let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ok:", msg); return; }
  console.error("FAIL:", msg); failures++;
}

function freshState() {
  Game.state = Game.defaultState();
  Game.state.credits = 100000;
  Game.state.positions = { iron_ore: 50, silicon: 50 };
  Game.state.avgCost = { iron_ore: 40, silicon: 65 };
  Game.state.items = {};
  Game.state.knownRecipes = [RECIPE];
  Game.state.craftedOnce = [];
  Game.state.workshop = { upgrades: 0, queue: [] };
  Game.requestSave = () => {};
  Workshop._claiming = false;
  Workshop._claimBackoffUntil = 0;
  calls.length = 0;
}
// Server ledger on/off. Every craft RPC is recorded and answered from `replies`.
const replies = {};
function setAuthoritative(on, { craftMissing = false } = {}) {
  Cloud.signedIn = () => on;
  Cloud.playersReady = on;
  Cloud._devLocal = false;
  Cloud.craftMissing = craftMissing;
  Economy._syncSoftEconomy = async () => true;   // skip the pre-action commit
}
const slice = extra => Object.assign({
  ok: true,
  credits: Game.state.credits,
  positions: Game.state.positions,
  items: Game.state.items,
  workshop: Game.state.workshop,
}, extra);
for (const [name, rpc] of Object.entries({
  craftStart: "app_craft_start", craftClaim: "app_craft_claim",
  craftSlot: "app_craft_slot", craftAdopt: "app_craft_adopt",
})) {
  Cloud[name] = async (...args) => {
    if (Cloud.craftMissing) return null;
    calls.push({ rpc, args });
    return replies[name] ? replies[name](...args) : slice();
  };
}

async function main() {
  // ---- 1) guests keep the local path ---------------------------------------
  console.log("guest (no server ledger):");
  setAuthoritative(false);
  freshState();
  let r = Workshop.craft(RECIPE, null, 1000);
  assert(r && r.ok === true, "craft() returns a plain result");
  assert(typeof r.then !== "function", "guest craft is synchronous");
  assert(Game.state.workshop.queue.length === 1, "job queued locally");
  assert(Game.state.positions.iron_ore === 44, "ingredients spent locally");
  let guestCrafted = null;
  Bus.on("crafted", d => { guestCrafted = d; });
  assert(Workshop.resolve(1000 + CRAFT_MS + 1).length === 1, "guest resolve delivers the craft");
  assert(Object.keys(Game.state.items).length === 1, "guest gets the item locally");
  assert(guestCrafted && guestCrafted.length === 1, "guest resolve announces crafted once");
  assert(calls.length === 0, "guest never calls an RPC");

  // ---- 2) the regression: no local mint on the server ledger ---------------
  console.log("server ledger:");
  setAuthoritative(true);
  freshState();
  Game.state.workshop.queue = [{ id: "ck1", recipeId: RECIPE, startedAt: 1, readyAt: 2, flavorId: null }];
  const out = Workshop.resolve(1000);
  assert(Array.isArray(out) && out.length === 0, "resolve() delivers nothing locally");
  assert(Object.keys(Game.state.items).length === 0,
    "no item is minted in the browser (app_commit would delete it)");
  await Promise.resolve();
  assert(calls.some(c => c.rpc === "app_craft_claim"), "resolve() claimed via app_craft_claim");

  // ---- 3) craft / buySlot route through the RPCs ---------------------------
  freshState();
  replies.craftStart = () => slice({
    workshop: { upgrades: 0, queue: [{ id: "srv1", recipeId: RECIPE, startedAt: 5, readyAt: 99, flavorId: null }] },
  });
  const p = Workshop.craft(RECIPE, null, 1000);
  assert(typeof p.then === "function", "authoritative craft returns a promise");
  const res = await p;
  assert(res && res.ok, "craft resolved ok: " + ((res && res.msg) || ""));
  assert(calls.some(c => c.rpc === "app_craft_start" && c.args[0] === RECIPE),
    "craft() called app_craft_start with the recipe id");
  assert(Game.state.workshop.queue.length === 1 && Game.state.workshop.queue[0].id === "srv1",
    "the server's queue replaced the optimistic one");
  delete replies.craftStart;

  freshState();
  await Workshop.buySlot();
  assert(calls.some(c => c.rpc === "app_craft_slot"), "buySlot() called app_craft_slot");

  // ---- 4) the claim result is what reaches the player ----------------------
  freshState();
  Game.state.workshop.queue = [{ id: "ck9", recipeId: RECIPE, startedAt: 1, readyAt: 2, flavorId: null }];
  replies.craftClaim = () => slice({
    items: { iSRV: { uid: "iSRV", kind: "plating", rarity: "common", name: "Server Plating",
                     primary: { stat: "armor", amount: 18, pct: false, kind: "plating" }, value: 1620 } },
    workshop: { upgrades: 0, queue: [] },
    delivered: [{ recipeId: RECIPE, name: "Server Plating", outputType: "gear" }],
  });
  let announced = null;
  Bus.on("crafted", d => { announced = d; });
  const got = await Workshop.claimDue(1000);
  assert(got.length === 1, "claimDue returned the server's delivery");
  assert(Game.state.items.iSRV && Game.state.items.iSRV.name === "Server Plating",
    "the item the player receives is the server's");
  assert(Game.state.workshop.queue.length === 0, "server drained the queue");
  assert(announced && announced.length === 1, "a 'crafted' event announced the delivery");
  delete replies.craftClaim;

  // ---- 5) adopt -------------------------------------------------------------
  freshState();
  Game.state.items = { iOld: { uid: "iOld", kind: "shield", rarity: "rare", name: "Pre-ledger Shield" } };
  Game.state.workshop = { upgrades: 1, queue: [{ id: "ckOld", recipeId: RECIPE, startedAt: 1, readyAt: 2, flavorId: null }] };
  replies.craftAdopt = () => slice({ adoptedItems: 1, adoptedJobs: 1, workshopAdopt: { calls: 1, items: 1, at: 7 } });
  await Workshop.adoptLocal();
  const c = calls.find(x => x.rpc === "app_craft_adopt");
  assert(c, "adoptLocal() called app_craft_adopt");
  assert(c && c.args[0].queue.length === 1 && c.args[1].iOld, "it offered the local queue and items");
  assert(Game.state.workshopAdopt && Game.state.workshopAdopt.calls === 1, "adopt budget recorded");
  calls.length = 0;
  await Workshop.adoptLocal();
  assert(calls.length === 0, "adoptLocal() does not re-offer on every boot");
  await Workshop.adoptLocal(true);
  assert(calls.some(x => x.rpc === "app_craft_adopt"),
    "a forced adopt still runs (wipe-backup restore after boot)");
  delete replies.craftAdopt;

  // ---- 6) SQL not applied → stay local -------------------------------------
  console.log("workshop_craft.sql not applied:");
  setAuthoritative(true, { craftMissing: true });
  freshState();
  assert(Workshop.authoritative() === false, "craftMissing drops back to the local path");
  r = Workshop.craft(RECIPE, null, 1000);
  assert(r && r.ok === true && typeof r.then !== "function", "craft still works locally");
  assert(Game.state.workshop.queue.length === 1, "job queued locally");
  assert(Workshop.resolve(1000 + CRAFT_MS + 1).length === 1, "and still delivers locally");

  if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
  console.log("\nAll craft-client checks passed.");
}

main().catch(e => { console.error(e); process.exit(1); });
