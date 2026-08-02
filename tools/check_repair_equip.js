#!/usr/bin/env node
/* check_repair_equip.js — repairing a hull and equipping gear must be SERVER
   actions when the server owns the fleet (docs/sql/repair_equip.sql).

   The bug this locks down, twice now:
     * Repair was a local mutation. app_commit rebuilds `ships` from the server
       row (app._merge_ships keeps the server's `dmg`) while accepting the
       client's LOWER credits — so the player paid the bill and the damage came
       straight back on the next autosave.
     * Equip was a local mutation too. The fitment merge only re-accepts
       accessory uids present in the SERVER items pool, so gear that only ever
       existed client-side silently popped off the ship on the next save.

   Checked here without a live Postgres:
     1) the SQL declares + grants the three RPCs, and app_commit still merges;
     2) Fleet.repair / equip / unequip call the RPC when it's available;
     3) a repair that goes through the RPC is NOT undone by the commit readback;
     4) a project without the SQL still repairs/equips locally (no dead button).

   Run:  node tools/check_repair_equip.js                                       */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const root = path.join(__dirname, "..");
const sql = fs.readFileSync(path.join(root, "docs/sql/repair_equip.sql"), "utf8");

// ---- 1) the SQL surface ----------------------------------------------------
for (const fn of ["app_repair_ship", "app_equip_item", "app_unequip_item"]) {
  assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\b`), `${fn} is defined`);
  assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\(`), `${fn} is granted to authenticated`);
}
// Damage and price must come off the server row, never the request.
assert.match(sql, /dmg := coalesce\(\(sh->>'dmg'\)::float8, 0\)/, "repair reads dmg from the server ship");
assert.match(sql, /select \* into def from app\.ship_def\(sh->>'type'\)/, "repair prices off the server catalog");
assert.ok(!/p_cost|p_dmg|p_price/.test(sql), "no client-supplied cost/damage parameters");
// Equip re-checks ownership and the slot cap server-side.
assert.match(sql, /app\._ship_slots\(sh->>'type'\)/, "equip enforces the hull's slot cap");
assert.match(sql, /fitted_elsewhere/, "equip refuses gear already fitted to another hull");
console.log("ok: repair_equip.sql declares, grants and validates the three RPCs");

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
// _withRpc's soft pre-sync is an app_commit; it isn't what we're testing here.
Economy._syncSoftEconomy = async () => true;

const freshState = () => ({
  credits: 100000, seq: 9, stats: {}, positions: {}, avgCost: {}, items: { i1: { uid: "i1", kind: "plating", rarity: "common", primary: null } },
  ships: [{ uid: "s1", type: "battleship", status: "idle", dmg: 0.5, accessories: [] }],
  extractors: {}, components: {}, missions: [], reports: [], routes: [], bazaar: {}, inventory: {},
  pendingContracts: [], bazaarBought: [], reputation: {}, unlockedSystems: [], mainShip: { type: "pinnace" },
});
const online = () => {
  Cloud.enabled = true; Cloud._user = { id: "u1" }; Cloud.playersReady = true;
  Cloud._devLocal = false; Cloud._rpcMissing = {};
};

// ---- 2+3) repair goes through the RPC, and the readback keeps it fixed ------
ctx.Game = { state: freshState() };
online();
let calls = [];
// The server: charges the bill, clears the damage, echoes the whole fleet back —
// exactly the slice shape that used to resurrect `dmg`.
Cloud.rpc = async (name, args) => {
  calls.push(name);
  if (name !== "app_repair_ship") throw new Error("unexpected rpc " + name);
  return { ok: true, cost: 15750, credits: 84250,
    ships: [{ uid: "s1", type: "battleship", status: "idle", dmg: 0, accessories: [] }] };
};
(async () => {
  const r = await Fleet.repair("s1");
  assert.ok(r && r.ok, "repair succeeded");
  assert.deepStrictEqual(calls, ["app_repair_ship"], "repair called app_repair_ship");
  assert.strictEqual(ctx.Game.state.ships[0].dmg, 0, "damage is cleared after the server slice lands");
  assert.strictEqual(ctx.Game.state.credits, 84250, "credits come back from the server");
  console.log("ok: repair runs server-side and survives the slice readback");

  // A server that refuses (busy ship, no credits) must roll the optimism back.
  ctx.Game.state = freshState();
  Cloud.rpc = async () => ({ ok: false, error: "Ship is busy — repairs need a drydock." });
  const bad = await Fleet.repair("s1");
  assert.ok(!bad.ok, "a refused repair reports failure");
  assert.strictEqual(bad.msg, "Ship is busy — repairs need a drydock.", "the server's reason reaches the player");
  assert.strictEqual(ctx.Game.state.ships[0].dmg, 0.5, "refused repair leaves the damage alone");
  assert.strictEqual(ctx.Game.state.credits, 100000, "refused repair refunds the optimistic charge");
  console.log("ok: a refused repair rolls back instead of silently reverting later");

  // ---- 2) equip / unequip route through their RPCs --------------------------
  ctx.Game.state = freshState();
  calls = [];
  Cloud.rpc = async (name, args) => {
    calls.push(name);
    if (name === "app_equip_item") {
      return { ok: true, ships: [{ uid: "s1", type: "battleship", status: "idle", dmg: 0.5, accessories: [args.p_item_uid] }] };
    }
    return { ok: true, ships: [{ uid: "s1", type: "battleship", status: "idle", dmg: 0.5, accessories: [] }] };
  };
  const eq = await Fleet.equip("s1", "i1");
  assert.ok(eq.ok, "equip succeeded");
  assert.deepStrictEqual(ctx.Game.state.ships[0].accessories, ["i1"], "gear is fitted");
  const un = await Fleet.unequip("s1", "i1");
  assert.ok(un.ok, "unequip succeeded");
  assert.deepStrictEqual(ctx.Game.state.ships[0].accessories, [], "unequip is not undone by the equip-restore guard");
  assert.deepStrictEqual(calls, ["app_equip_item", "app_unequip_item"], "both went through their RPCs");
  console.log("ok: equip/unequip run server-side");

  // ---- 4) no SQL installed → local fallback, never a dead button ------------
  ctx.Game.state = freshState();
  online();
  calls = [];
  const missing = Object.assign(new Error("Could not find the function"), { code: "PGRST202" });
  Cloud.rpc = async name => { calls.push(name); throw missing; };
  const r2 = await Fleet.repair("s1");
  assert.ok(r2.ok, "repair still works with the RPC missing");
  assert.strictEqual(ctx.Game.state.ships[0].dmg, 0, "local fallback clears the damage");
  assert.ok(Cloud._rpcMissing.app_repair_ship, "the missing RPC is latched");
  ctx.Game.state = freshState();
  await Fleet.repair("s1");
  assert.strictEqual(calls.length, 1, "a latched-missing RPC isn't retried on every click");
  console.log("ok: a project without repair_equip.sql falls back locally, once");

  console.log("All repair/equip checks passed.");
})().catch(e => { console.error(e); process.exit(1); });
