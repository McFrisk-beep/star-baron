/* check_save_migrate.js — regression: a corrupted / tampered save (localStorage
   or cloud sync) with wrong-typed fields must NOT crash Game.migrate() (which
   used to brick boot forever, since every reload re-loaded the same bad save).
   Malformed collections fall back to defaults; credits is coerced to a finite,
   non-negative number. No browser — loads main.js into vm with minimal stubs. */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const root = path.join(__dirname, "..");
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };

// Minimal globals migrate()/defaultState() touch.
const ctx = {
  console,
  CONFIG: { startingCredits: 1500, maxOfflineMs: 1, marketTickMs: 1, autosaveMs: 1 },
  SYSTEMS: [{ id: "navos", unlock: 0 }, { id: "far", unlock: 5000 }],
  FACTIONS: { syndicate: {}, senate: {} },
  DMGCFG: { maxDmg: 100 },
  Util: { clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)) },
};
ctx.window = ctx;
ctx.window.matchMedia = () => ({ matches: false });
ctx.window.addEventListener = () => {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, "js/main.js"), "utf8"), ctx);
const Game = ctx.Game;

const migrate = loaded => Game.migrate(loaded);

// 1) The classic brick: ships is not an array. Must not throw; must recover.
let s = migrate({ v: 2, ships: null });
assert(Array.isArray(s.ships) && s.ships.length > 0, "ships:null → default fleet, no crash");
s = migrate({ v: 2, ships: "corrupt" });
assert(Array.isArray(s.ships), "ships:string → array");
s = migrate({ v: 2, ships: 42 });
assert(Array.isArray(s.ships), "ships:number → array");

// 2) Other collections that get iterated / .includes()'d.
s = migrate({ v: 2, unlockedSystems: "navos" });
assert(Array.isArray(s.unlockedSystems), "unlockedSystems:string → array");
s = migrate({ v: 2, achievements: 5 });
assert(Array.isArray(s.achievements), "achievements:number → array");
s = migrate({ v: 2, positions: null });
assert(s.positions && typeof s.positions === "object" && !Array.isArray(s.positions === null), "positions:null → object");
s = migrate({ v: 2, avgCost: "x" });
assert(s.avgCost && typeof s.avgCost === "object", "avgCost:string → object");
s = migrate({ v: 2, currentSystem: 99 });
assert(typeof s.currentSystem === "string", "currentSystem:number → default string");

// 3) credits coercion: finite, non-negative, or default.
assert(migrate({ v: 2, credits: "abc" }).credits === 1500, "credits:'abc' → default");
assert(migrate({ v: 2, credits: NaN }).credits === 1500, "credits:NaN → default");
assert(migrate({ v: 2, credits: Infinity }).credits === 1500, "credits:Infinity → default");
assert(migrate({ v: 2, credits: -500 }).credits === 0, "credits:-500 → 0 (clamped)");
assert(migrate({ v: 2, credits: 12345 }).credits === 12345, "credits:12345 → kept");
assert(migrate({ v: 2, credits: "9000" }).credits === 9000, "credits numeric-string → coerced");

// 4) A well-formed save is untouched (no false positives).
s = migrate({ v: 2, credits: 777, currentSystem: "far", positions: { ore: 3 }, unlockedSystems: ["navos", "far"] });
assert(s.credits === 777 && s.currentSystem === "far" && s.positions.ore === 3, "valid save passes through unchanged");

// 5) v1 save with a corrupt avgCost still ends up an object (v1→v2 path re-reads it).
s = migrate({ v: 1, avgCost: "corrupt" });
assert(s.avgCost && typeof s.avgCost === "object", "v1 avgCost:string → object after migration");

// 6) Totally broken input still yields a usable state.
s = migrate({});
assert(Array.isArray(s.ships) && s.credits === 1500, "empty save → sane defaults");

console.log("All save-migrate checks passed.");
