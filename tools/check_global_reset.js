#!/usr/bin/env node
/* check_global_reset.js — the two wipes have to be AUTHORITATIVE or not happen.

   app_commit protects credits/positions/ships/items/prestige, so no client-side
   wipe can reach players.state. Both resets therefore go through an RPC:

   1) Admin global reset (Game.applyGlobalReset)
      - guest / legacy `saves`  → local wipe is the wipe
      - Phase 1 + app_world_reset_apply → adopt the server's fresh row
      - Phase 1, RPC missing    → null, save untouched, retry next load
        (the old path stamped appliedResetEpoch through app_commit and echoed
         every protected slice back: marked reset, nothing reset, never again)
   2) Settings → Reset Save (Game.reset)
      - refuses to clear localStorage when app_reset_save didn't land, so the
        reload can't restore the cloud row over a wiped local one

   Run: node tools/check_global_reset.js                                       */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const root = path.join(__dirname, "..");
const mem = { local: null };
let reloads = 0;

const sandbox = {
  console: { log() {}, warn() {}, error: console.error },
  Date, Math, JSON, Array, Object, Number, String, Boolean, Error, TypeError, Set, Map, Promise,
  setTimeout, clearTimeout, setInterval, clearInterval,
  matchMedia: () => ({ matches: false, addListener() {}, removeListener() {} }),
  localStorage: {
    getItem: (k) => (k === "starbaron" ? mem.local : null),
    setItem: (k, v) => { if (k === "starbaron") mem.local = v; },
    removeItem: (k) => { if (k === "starbaron") mem.local = null; },
  },
  document: {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    body: { classList: { toggle() {} }, insertAdjacentHTML() {} },
    addEventListener() {},
    createElement: () => ({ classList: { toggle() {}, add() {}, remove() {} }, style: {}, append() {}, addEventListener() {} }),
  },
  performance: { now: () => Date.now() },
  navigator: { language: "en" },
  location: { reload() { reloads++; } },
  addEventListener() {}, removeEventListener() {},
  window: null,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

sandbox.Bus = { on() {}, emit() {} };
sandbox.Feed = { start() {}, stop() {}, wire() {} };
sandbox.Broadcast = { start() {}, stop() {} };
sandbox.Bazaar = { itemsValue: () => 0, ensure() {} };
sandbox.Galaxy = { build() {}, hydrate() {}, serialize: () => null, localLog: {}, get: () => null };
sandbox.Market = {
  init() {}, hydrate() {}, serialize: () => null, advance() {},
  effects: [], localEffects: [], volMult: 1, price: () => 10, stocks: () => true,
};

for (const f of ["js/data.js", "js/flavor.js", "js/cloud-config.js", "js/store.js", "js/cloud.js",
                 "js/items.js", "js/fleet.js", "js/assets.js", "js/economy.js", "js/reputation.js",
                 "js/workshop.js", "js/main.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx, { filename: f });
}

const { Game, Store } = ctx;

// A save that must survive a reset the server never confirmed.
function richSave(epoch) {
  const s = Game.defaultState();
  s.credits = 2_500_000;
  s.positions = { iron_ore: 400 };
  s.appliedResetEpoch = epoch;
  s.senate = { shared: true, passed: ["edict-1"] };
  s.settings = Object.assign({}, s.settings, { lang: "fi", muted: false });
  return s;
}

// cloud.js declares `const Cloud`, a lexical binding the other modules resolve
// directly — replacing the sandbox property would only fool `window.Cloud`.
// Mutate the real object instead.
function stubCloud(over) {
  const C = sandbox.Cloud;
  delete C.worldResetApply;
  delete C.resetSave;
  Object.assign(C, {
    enabled: true, playersReady: true, client: {},
    signedIn: () => true, authoritative: () => true, user: () => ({ id: "u1" }),
    saveRemote: async () => { throw new Error("a wipe must never go through app_commit"); },
  }, over || {});
}

(async () => {
  // ---- 1) guest: the local wipe IS the wipe ----------------------------------
  stubCloud({ signedIn: () => false, authoritative: () => false, playersReady: false });
  const guest = await Game.applyGlobalReset(richSave(0), 3);
  assert.ok(guest, "guest reset returns a fresh state");
  assert.strictEqual(guest.credits, 5000, "guest reset hands out the 5,000c stake");
  assert.strictEqual(guest.appliedResetEpoch, 3, "guest reset stamps the epoch");
  // (Object.keys — the sandbox realm has its own Object.prototype.)
  assert.deepStrictEqual(Object.keys(guest.positions), [], "guest reset wipes positions");
  assert.ok(guest.senate && guest.senate.shared, "senate legislation survives");
  assert.strictEqual(guest.settings.lang, "fi", "cosmetic settings survive");

  // ---- 2) Phase 1 + app_world_reset_apply: adopt the server's fresh row ------
  let rpcCalls = 0;
  const serverFresh = Game.defaultState();
  serverFresh.credits = 5000;
  serverFresh.appliedResetEpoch = 3;
  serverFresh.senate = { shared: true, passed: ["edict-1"] };
  stubCloud({
    worldResetApply: async () => {
      rpcCalls++;
      return { ok: true, applied: true, epoch: 3, state: JSON.parse(JSON.stringify(serverFresh)) };
    },
    // Must never be reached — app_commit can't wipe a protected slice.
    saveRemote: async () => { throw new Error("saveRemote must not be used to wipe"); },
  });
  const applied = await Game.applyGlobalReset(richSave(0), 3);
  assert.strictEqual(rpcCalls, 1, "authoritative reset goes through the RPC");
  assert.ok(applied, "server-confirmed reset returns a state");
  assert.strictEqual(applied.credits, 5000, "adopts the server's wiped credits");
  assert.strictEqual(applied.appliedResetEpoch, 3, "server stamped the epoch");

  // ---- 3) Phase 1, RPC not applied: leave the save completely alone ----------
  const missing = new Error("Could not find the function public.app_world_reset_apply");
  for (const stub of [
    { worldResetApply: async () => { throw missing; } },       // SQL not pasted
    { worldResetApply: async () => ({ ok: false, error: "x" }) },
    { worldResetApply: async () => ({ ok: true, applied: false, epoch: 3 }) },
    {},                                                        // older client build
  ]) {
    stubCloud(Object.assign({
      saveRemote: async () => { throw new Error("must not touch the cloud row"); },
    }, stub));
    const r = await Game.applyGlobalReset(richSave(0), 3);
    assert.strictEqual(r, null, "unconfirmed reset returns null (retry next load)");
  }

  // ---- 4) Settings → Reset Save refuses to wipe local when the RPC fails -----
  mem.local = JSON.stringify(richSave(3));
  reloads = 0;
  Game.state = richSave(3);
  Game._noSave = false;
  Game.timeScale = 1;
  Store._cloudReady = true;
  sandbox.UI = { toast() {} };
  stubCloud({ resetSave: async () => { throw missing; } });
  await Game.reset();
  assert.ok(mem.local, "local save kept when the cloud wipe didn't land");
  assert.strictEqual(reloads, 0, "no reload into a save that would just come back");
  assert.strictEqual(Game._noSave, false, "autosave stays live — nothing was reset");
  assert.strictEqual(Store._cloudReady, true, "cloud sync restored after a refused reset");
  Game.stopSchedulers();

  // ---- 5) …and does wipe when the RPC lands ---------------------------------
  stubCloud({ resetSave: async () => ({ ok: true, state: Game.defaultState() }) });
  await Game.reset();
  assert.strictEqual(mem.local, null, "local save cleared after a confirmed cloud wipe");
  assert.strictEqual(reloads, 1, "reset reloads into the fresh game");
  assert.strictEqual(Game._noSave, true, "_noSave blocks the beforeunload resurrect");

  console.log("check_global_reset: admin + settings wipes are authoritative or no-ops ✔");
})().catch(e => { console.error(e); process.exit(1); });
