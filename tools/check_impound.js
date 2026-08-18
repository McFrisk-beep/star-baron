#!/usr/bin/env node
/* check_impound.js — the impound lot: half-value release fee, abandon-forever,
   and the no-stripping rule (docs/sql/impound_retrieve.sql + js/fleet.js).

   What this locks down:
     * The release fee is 0.5 × (hull price + EQUIPPED gear value), floored at
       600c — computed from the catalog on both sides, never from a client
       number. Fleet.impoundFine (card display + guest fallback) must mirror
       app._impound_fine or the card lies about the bill.
     * Abandoning is impounded-only and forfeits the fitted gear with the hull.
     * An impounded hull can't be stripped (client + BOTH SQL copies of
       app_unequip_item), or the gear-inclusive fee is trivially dodged.
     * Retrieve/abandon go through their RPCs when available; a project without
       the SQL keeps working locally (no dead buttons).

   Run:  node tools/check_impound.js                                            */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const root = path.join(__dirname, "..");
const sqlImp = fs.readFileSync(path.join(root, "docs/sql/impound_retrieve.sql"), "utf8");
const sqlEquip = fs.readFileSync(path.join(root, "docs/sql/repair_equip.sql"), "utf8");

// ---- 1) the SQL surface ----------------------------------------------------
for (const fn of ["app_retrieve_ship", "app_abandon_ship", "app_unequip_item"]) {
  assert.match(sqlImp, new RegExp(`create or replace function public\\.${fn}\\b`), `${fn} is defined`);
  assert.match(sqlImp, new RegExp(`grant execute on function public\\.${fn}\\(`), `${fn} is granted to authenticated`);
}
// The fee comes off the server catalog + server items — never the request, and
// never the stamped retrieveCost (older SQL stamped 1500 there).
assert.match(sqlImp, /create or replace function app\._impound_fine/, "app._impound_fine is defined");
assert.match(sqlImp, /greatest\(600\.0, round\(0\.5 \* \(/, "fine = max(600, half of …)");
assert.match(sqlImp, /app\.ship_def\(p_ship->>'type'\)/, "fine prices the hull off the catalog");
assert.match(sqlImp, /app\.item_value\(/, "fine counts equipped gear at server value");
assert.match(sqlImp, /cost := app\._impound_fine\(st, sh\)/, "retrieve charges the computed fine");
assert.ok(!/\(sh->>'retrieveCost'\)/.test(sqlImp), "retrieve no longer trusts the stamped retrieveCost");
// Abandon: impounded-only, and the fitted gear goes down with the hull.
assert.match(sqlImp, /Only an impounded ship can be abandoned/, "abandon is impounded-only");
assert.match(sqlImp, /items := items - uid/, "abandon forfeits the fitted gear");
// No stripping a hull in the lot — in BOTH files that declare app_unequip_item,
// so re-running either keeps the gate.
for (const [name, text] of [["impound_retrieve.sql", sqlImp], ["repair_equip.sql", sqlEquip]]) {
  assert.match(text, /impound lot holds the whole vessel/, `${name}: unequip refuses impounded hulls`);
}
console.log("ok: impound_retrieve.sql declares, grants and validates the RPCs");

// ---- harness ---------------------------------------------------------------
const ctx = { console, JSON, Math, Object, Array, Number, Promise, Date, setTimeout };
ctx.window = ctx;
vm.createContext(ctx);
const load = f => vm.runInContext(fs.readFileSync(path.join(root, "js", f), "utf8"), ctx, { filename: f });
for (const f of ["store.js", "data.js", "content.js", "economy.js", "cloud.js", "items.js", "fleet.js"]) load(f);
const { Economy, Cloud, Fleet, Content } = ctx;
if (Content) Content.snapshotDefaults();
ctx.Util = { clamp: (n, a, b) => Math.min(b, Math.max(a, n)), pick: a => a[0] };
Economy.refreshNetWorth = () => {};
Economy.checkAchievements = () => {};
Economy._syncSoftEconomy = async () => true;

const freshState = () => ({
  credits: 100000, seq: 9, stats: {}, positions: {}, avgCost: {},
  items: { i1: { uid: "i1", kind: "shield", rarity: "rare", value: 5400, primary: null } },
  ships: [
    { uid: "s1", type: "drift", status: "impounded", accessories: [], retrieveCost: 1500 },
    { uid: "s2", type: "corvette", status: "impounded", accessories: ["i1"], retrieveCost: 1500 },
    { uid: "s3", type: "craft_courier", status: "impounded", accessories: [] },
  ],
  shipVariants: {}, extractors: {}, components: {}, missions: [], reports: [], routes: [],
  bazaar: {}, inventory: {}, pendingContracts: [], bazaarBought: [], reputation: [],
  unlockedSystems: [], mainShip: { type: "pinnace" },
});
const offline = () => { Cloud.enabled = false; Cloud._user = null; Cloud.playersReady = false; };
const online = () => {
  Cloud.enabled = true; Cloud._user = { id: "u1" }; Cloud.playersReady = true;
  Cloud._devLocal = false; Cloud._rpcMissing = {};
};

// ---- 2) fine parity with app._impound_fine ---------------------------------
ctx.Game = { state: freshState() };
const [s1, s2, s3] = ctx.Game.state.ships;
assert.strictEqual(Fleet.impoundFine(s1), 2100, "drift (4200c, bare) → 2100c");
assert.strictEqual(Fleet.impoundFine(s2), 8200, "corvette (11000c) + rare shield (5400c) → 8200c");
assert.strictEqual(Fleet.impoundFine(s3), 600, "priceless craft hull hits the 600c floor");
// The notice is deterministic flavor — same hull, same story, and it names both halves.
assert.strictEqual(Fleet.impoundNotice(s1), Fleet.impoundNotice(s1), "notice is stable per hull");
assert.match(Fleet.impoundNotice(s1), /impounded by .+ for .+\./, "notice reads 'impounded by … for …'");
console.log("ok: Fleet.impoundFine mirrors app._impound_fine (incl. gear + floor)");

// ---- 3) local (guest) paths ------------------------------------------------
offline();
let r = Fleet._retrieveLocal("s1");
assert.ok(r.ok && r.cost === 2100, "local retrieve charges the computed fine, not the stamp");
assert.strictEqual(ctx.Game.state.credits, 97900, "fine debited");
assert.strictEqual(s1.status, "idle", "hull released");
r = Fleet._unequipLocal("s2", "i1");
assert.ok(!r.ok, "can't strip an impounded hull");
assert.deepStrictEqual(s2.accessories, ["i1"], "gear stays fitted");
r = Fleet._abandonLocal("s1");
assert.ok(!r.ok, "abandon refuses a non-impounded hull");
r = Fleet._abandonLocal("s2");
assert.ok(r.ok, "abandon works on an impounded hull");
assert.ok(!ctx.Game.state.ships.some(x => x.uid === "s2"), "hull is gone");
assert.ok(!("i1" in ctx.Game.state.items), "fitted gear went down with it");
console.log("ok: local retrieve/abandon paths behave (fine, gate, forfeit)");

// ---- 4) RPC paths ----------------------------------------------------------
(async () => {
  ctx.Game = { state: freshState() };
  online();
  const calls = [];
  Cloud.rpc = async (name) => {
    calls.push(name);
    if (name === "app_retrieve_ship") return { ok: true, cost: 2100, credits: 97900,
      ships: [{ uid: "s1", type: "drift", status: "idle", accessories: [], retrieveCost: 0 },
              { uid: "s2", type: "corvette", status: "impounded", accessories: ["i1"], retrieveCost: 1500 }] };
    if (name === "app_abandon_ship") return { ok: true,
      ships: [{ uid: "s1", type: "drift", status: "idle", accessories: [], retrieveCost: 0 }], items: {} };
    throw new Error("unexpected rpc " + name);
  };
  let rr = await Fleet.retrieve("s1");
  assert.ok(rr.ok && rr.cost === 2100, "retrieve returns the server's fine");
  assert.deepStrictEqual(calls, ["app_retrieve_ship"], "retrieve went through the RPC");
  assert.strictEqual(ctx.Game.state.ships.find(x => x.uid === "s1").status, "idle",
    "server slice released the hull");
  rr = await Fleet.abandon("s2");
  assert.ok(rr.ok, "abandon succeeded via RPC");
  assert.deepStrictEqual(calls, ["app_retrieve_ship", "app_abandon_ship"], "abandon went through the RPC");
  assert.ok(!ctx.Game.state.ships.some(x => x.uid === "s2"), "server slice removed the abandoned hull");

  // Missing SQL → latched local fallback, no dead buttons.
  ctx.Game = { state: freshState() };
  online();
  Cloud.rpc = async () => { const e = new Error("Could not find the function"); e.code = "PGRST202"; throw e; };
  rr = await Fleet.retrieve("s1");
  assert.ok(rr.ok, "missing RPC keeps the optimistic local retrieve");
  assert.strictEqual(ctx.Game.state.ships.find(x => x.uid === "s1").status, "idle", "hull released locally");
  console.log("ok: retrieve/abandon route through the RPCs, with a local fallback");
  console.log("All impound checks passed.");
})().catch(e => { console.error(e); process.exit(1); });
