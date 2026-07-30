#!/usr/bin/env node
/* check_equip_persist.js — docs/sql/equip_persist.sql: ship accessories must
   survive a reload (app_commit persists fitment instead of discarding it).

   Two things are checked without a live Postgres:
   1) PARITY — the slot table in app._ship_slots matches SHIP_CATALOG in
      js/data.js exactly. That table is duplicated data, so it's the part most
      likely to silently drift when a hull is added or retuned.
   2) RULES — a JS port of app._merge_ships (mergeShips below, kept in lockstep
      with the SQL) enforces the fitment validation: gear you don't own is
      dropped, an item can't be stacked or cloned across ships, the hull slot cap
      holds, an unequip persists, and a busy ship keeps its gear.

   Run:  node tools/check_equip_persist.js                                     */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const root = path.join(__dirname, "..");
const sql = fs.readFileSync(path.join(root, "docs/sql/equip_persist.sql"), "utf8");

// ---- 1) app_commit is actually wired to the merge ---------------------------
assert.match(sql, /create or replace function app\._merge_ships/,
  "equip_persist.sql defines app._merge_ships");
assert.match(sql, /jsonb_set\(merged, '\{ships\}', app\._merge_ships\(/,
  "app_commit routes ships through app._merge_ships");
// The old bug, verbatim: forcing the server array discards the client's fitment.
assert.ok(!/jsonb_set\(merged, '\{ships\}', coalesce\(server->'ships'/.test(sql),
  "app_commit no longer force-overwrites ships from the server row");
// Fitment must be validated against the SERVER's item pool, not the client's.
assert.match(sql, /app\._merge_ships\(\s*coalesce\(server->'ships'[^)]*\),\s*coalesce\(p_state->'ships'[^)]*\),\s*coalesce\(server->'items'/,
  "_merge_ships is called with (server ships, client ships, SERVER items)");

// ---- 2) slot table parity with js/data.js ----------------------------------
const ctx = vm.createContext({ console, Math, Date });
ctx.window = ctx;
for (const f of ["store.js", "data.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "js", f), "utf8"), ctx, { filename: f });
}
const { SHIP_CATALOG, ALL_SHIPS } = ctx;

const body = /create or replace function app\._ship_slots[\s\S]*?\$\$;/.exec(sql);
assert.ok(body, "app._ship_slots is defined");
const sqlSlots = {};
for (const m of body[0].matchAll(/\('([a-z_]+)',\s*(\d+)\)/g)) sqlSlots[m[1]] = +m[2];

// Mains live in state.mainShip and never carry accessories — fleet hulls only.
const mains = new Set(SHIP_CATALOG.main.map(s => s.id));
const fleetHulls = ALL_SHIPS.filter(s => !mains.has(s.id));
assert.ok(fleetHulls.length > 0, "found fleet hulls in the catalog");

for (const sh of fleetHulls) {
  assert.strictEqual(sqlSlots[sh.id], sh.slots,
    `slot parity for ${sh.id}: SQL ${sqlSlots[sh.id]} vs catalog ${sh.slots}`);
}
assert.strictEqual(Object.keys(sqlSlots).length, fleetHulls.length,
  "SQL slot table has no extra/stale hulls");
console.log(`ok: slot table matches SHIP_CATALOG for all ${fleetHulls.length} fleet hulls`);

// ---- 3) JS port of app._merge_ships (keep in lockstep with the SQL) --------
const slotsOf = type => (type in sqlSlots ? sqlSlots[type] : 2);
function mergeShips(serverShips, clientShips, serverItems) {
  const claimed = new Set();
  return (serverShips || []).map(sv => {
    const cv = (clientShips || []).find(c => c.uid === sv.uid);
    const acc = Array.isArray(cv && cv.accessories) ? cv.accessories
      : Array.isArray(sv.accessories) ? sv.accessories : [];
    const keep = [];
    for (const uid of acc) {
      if (keep.length >= slotsOf(sv.type)) break;
      if (Object.prototype.hasOwnProperty.call(serverItems || {}, uid) && !claimed.has(uid)) {
        keep.push(uid);
        claimed.add(uid);
      }
    }
    return Object.assign({}, sv, { accessories: keep });
  });
}

const items = { i1: {}, i2: {}, i3: {}, i4: {}, i5: {} };

// the actual bug: server row has empty fitment, client just equipped i1
let out = mergeShips(
  [{ uid: "s1", type: "battleship", status: "idle", accessories: [] }],
  [{ uid: "s1", type: "battleship", status: "idle", accessories: ["i1"] }],
  items);
assert.deepStrictEqual(out[0].accessories, ["i1"], "equip persists into the committed state");

// unequip persists (empty client array is honoured, not treated as "missing")
out = mergeShips(
  [{ uid: "s1", type: "battleship", accessories: ["i1"] }],
  [{ uid: "s1", type: "battleship", accessories: [] }],
  items);
assert.deepStrictEqual(out[0].accessories, [], "unequip persists");

// gear the server doesn't know about is dropped (can't forge stats)
out = mergeShips(
  [{ uid: "s1", type: "battleship", accessories: [] }],
  [{ uid: "s1", type: "battleship", accessories: ["ghost", "i2"] }],
  items);
assert.deepStrictEqual(out[0].accessories, ["i2"], "forged item uid is dropped");

// the same item can't be stacked on one ship for double stats
out = mergeShips(
  [{ uid: "s1", type: "battleship", accessories: [] }],
  [{ uid: "s1", type: "battleship", accessories: ["i1", "i1", "i1"] }],
  items);
assert.deepStrictEqual(out[0].accessories, ["i1"], "duplicate uid collapses to one");

// …nor cloned across two ships
out = mergeShips(
  [{ uid: "s1", type: "battleship", accessories: [] }, { uid: "s2", type: "gunboat", accessories: [] }],
  [{ uid: "s1", type: "battleship", accessories: ["i1"] }, { uid: "s2", type: "gunboat", accessories: ["i1", "i2"] }],
  items);
assert.deepStrictEqual(out[0].accessories, ["i1"], "first ship keeps the item");
assert.deepStrictEqual(out[1].accessories, ["i2"], "second ship can't clone it");

// hull slot cap holds (gunboat = 2)
out = mergeShips(
  [{ uid: "s1", type: "gunboat", accessories: [] }],
  [{ uid: "s1", type: "gunboat", accessories: ["i1", "i2", "i3", "i4"] }],
  items);
assert.deepStrictEqual(out[0].accessories, ["i1", "i2"], "fitment truncated to the hull's slots");

// a busy ship keeps its stored gear (no idle gate, and no wipe mid-mission)
out = mergeShips(
  [{ uid: "s1", type: "battleship", status: "mission", accessories: ["i1"] }],
  [{ uid: "s1", type: "battleship", status: "mission", accessories: ["i1"] }],
  items);
assert.deepStrictEqual(out[0].accessories, ["i1"], "busy ship keeps its fitment");

// server owns the roster: a client-only ship is dropped, server fields survive
out = mergeShips(
  [{ uid: "s1", type: "battleship", status: "mission", dmg: 0.4, name: "Twin Talon", accessories: [] }],
  [{ uid: "s1", type: "battleship", status: "idle", dmg: 0, name: "Hacked", accessories: ["i1"] },
   { uid: "s99", type: "battleship", accessories: ["i2"] }],
  items);
assert.strictEqual(out.length, 1, "client-only ship is dropped");
assert.strictEqual(out[0].status, "mission", "server status wins");
assert.strictEqual(out[0].dmg, 0.4, "server damage wins");
assert.strictEqual(out[0].name, "Twin Talon", "server name wins");
assert.deepStrictEqual(out[0].accessories, ["i1"], "…but client fitment is accepted");

// a ship the client never sent keeps whatever the server stored
out = mergeShips(
  [{ uid: "s1", type: "battleship", accessories: ["i1", "i2"] }],
  [],
  items);
assert.deepStrictEqual(out[0].accessories, ["i1", "i2"], "missing client ship keeps stored fitment");

// stale uid self-heals once the item leaves the pool (sold / listing resolved)
out = mergeShips(
  [{ uid: "s1", type: "battleship", accessories: ["i1"] }],
  [{ uid: "s1", type: "battleship", accessories: ["i1"] }],
  { i2: {} });
assert.deepStrictEqual(out[0].accessories, [], "sold item drops out of the fitment");

console.log("All equip-persist checks passed.");
