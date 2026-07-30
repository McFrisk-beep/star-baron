#!/usr/bin/env node
/* check_fleet_sort.js — runnable check for the Fleet subtab sorters.
   Loads the real scripts (store, data, fleet, ui) into a bare vm context and
   asserts UI.shipSorter / UI.invSorter order the Owned Ships and Inventory
   panes as advertised, ties included.  Run:  node tools/check_fleet_sort.js  */
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console });
ctx.window = ctx;
ctx.document = { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} };
for (const f of ["store.js", "data.js", "fleet.js", "ui.js"])
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });

const { UI, Fleet, RARITIES, SHIP_CATALOG, ALL_SHIPS } = ctx;
ctx.Economy = { authoritative: () => false };
ctx.Game = { state: { credits: 0, seq: 1, ships: [], items: {}, mainShip: { type: SHIP_CATALOG.main[0].id } } };

const order = (list, sorter) => [...list].sort(sorter).map(x => x.name);

// ---- ships ---------------------------------------------------------------
// two hull types with different stats, so cargo/firepower have something to say
const light = ALL_SHIPS.find(d => d.cls === "escort"), heavy = ALL_SHIPS.find(d => d.cls === "transport");
assert(light && heavy, "catalog exposes an escort and a transport to compare");
const ships = [
  { uid: "s1", type: heavy.id, name: "Zeta", status: "idle", accessories: [] },
  { uid: "s2", type: light.id, name: "Alpha", status: "mission", accessories: [] },
  { uid: "s3", type: heavy.id, name: "Mira", status: "idle", accessories: [] },
];
ctx.Game.state.ships = ships;

assert.deepStrictEqual(order(ships, UI.shipSorter("name")), ["Alpha", "Mira", "Zeta"], "ships sort by name");
// idle < mission alphabetically; ties inside a status fall back to name
assert.deepStrictEqual(order(ships, UI.shipSorter("status")), ["Mira", "Zeta", "Alpha"], "ships group by status, then name");
// same hull for Zeta/Mira → equal cargo → name breaks the tie, never a coin flip
const byCargo = order(ships, UI.shipSorter("cargo"));
assert(byCargo.indexOf("Mira") < byCargo.indexOf("Zeta"), "equal-cargo ships keep a stable name order");
assert.deepStrictEqual(
  order(ships, UI.shipSorter("cargo")),
  [...ships].sort((a, z) => Fleet.stats(z).cargo - Fleet.stats(a).cargo || a.name.localeCompare(z.name)).map(s => s.name),
  "cargo sort is descending on the real stat");
assert.deepStrictEqual(order(ships, UI.shipSorter("nonsense")), ["Alpha", "Mira", "Zeta"], "unknown ship key falls back to name");

// ---- inventory -----------------------------------------------------------
const items = [
  { uid: "i1", name: "Delta Coil", rarity: RARITIES[0].id, kind: "b", value: 900 },
  { uid: "i2", name: "Alpha Plate", rarity: RARITIES[2].id, kind: "a", value: 4200 },
  { uid: "i3", name: "Omega Lens", rarity: RARITIES[1].id, kind: "a", value: 4200 },
];
assert.deepStrictEqual(order(items, UI.invSorter("value")), ["Alpha Plate", "Omega Lens", "Delta Coil"],
  "inventory sorts by value, descending, name breaking the 4200 tie");
assert.deepStrictEqual(order(items, UI.invSorter("rarity")), ["Alpha Plate", "Omega Lens", "Delta Coil"],
  "inventory sorts rarest first");
assert.deepStrictEqual(order(items, UI.invSorter("kind")), ["Alpha Plate", "Omega Lens", "Delta Coil"],
  "inventory groups by kind, then name");
assert.deepStrictEqual(order(items, UI.invSorter("name")), ["Alpha Plate", "Delta Coil", "Omega Lens"],
  "inventory sorts by name");
assert.deepStrictEqual(order(items, UI.invSorter()), ["Alpha Plate", "Delta Coil", "Omega Lens"],
  "missing inventory key falls back to name");

// sorters must not mutate the caller's array — the panes re-sort every render
UI.shipSorter("cargo"); UI.invSorter("rarity");
assert.deepStrictEqual(ships.map(s => s.name), ["Zeta", "Alpha", "Mira"], "ship list untouched by sorting");
assert.deepStrictEqual(items.map(i => i.name), ["Delta Coil", "Alpha Plate", "Omega Lens"], "item list untouched by sorting");

console.log("check_fleet_sort: all assertions passed");
