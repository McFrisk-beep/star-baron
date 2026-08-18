/* check_save_migrate.js — regression: a corrupted / tampered save (localStorage
   or cloud sync) with wrong-typed fields must NOT crash Game.migrate() (which
   used to brick boot forever, since every reload re-loaded the same bad save).
   Malformed collections fall back to defaults; credits is coerced to a finite,
   non-negative number.

   This check loads the REAL sibling modules, not stubs. That matters: migrate()
   is full of `if (window.Senate)` / `if (window.Workshop)` / `if (window.Economy)`
   branches, and an earlier version of this file stubbed `window` as a bare object
   — so every one of those branches was skipped and the whole cross-module half of
   migrate went untested. That blind spot shipped a bug (PR #83) where migrate threw
   on EVERY boot and the save was replaced with a fresh game; this check passed the
   entire time. If you add a module to the migrate path, load it here too.

   No browser — loads the modules into vm with minimal DOM stubs.                */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const root = path.join(__dirname, "..");
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };

// Every module migrate() reaches for, in index.html order. data.js/flavor.js carry
// the CONFIG/SYSTEMS/FACTIONS/RECIPES/BLUEPRINTS globals; store.js carries Util.
const MODULES = ["data.js", "flavor.js", "store.js", "economy.js", "reputation.js",
                 "fleet.js", "items.js", "workshop.js", "senate.js", "main.js"];

const warnings = [];
const ctx = {
  console: Object.assign({}, console, {
    // migrate() catches module failures so a bug can't brick persistence. That
    // guard also HIDES such bugs from this check — so capture what it logs and
    // assert below that it never had to fire.
    warn: (...a) => warnings.push(a.join(" ")),
    error: (...a) => warnings.push(a.join(" ")),
  }),
  Date, Math, JSON, Set, Map, Object, Array, Number, String, Boolean, Error, Promise,
  setTimeout, clearTimeout, setInterval, clearInterval,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
ctx.addEventListener = () => {};
ctx.requestAnimationFrame = () => 0;
ctx.navigator = { userAgent: "node", onLine: true };
ctx.location = { href: "file:///", search: "", reload() {} };
ctx.document = {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {},
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
  body: { classList: { add() {}, remove() {} } },
};
vm.createContext(ctx);
for (const f of MODULES) {
  try { vm.runInContext(fs.readFileSync(path.join(root, "js", f), "utf8"), ctx, { filename: f }); }
  catch (e) { console.error("FAIL: could not load js/" + f + " —", e.message); process.exit(1); }
}
const Game = ctx.Game;
assert(ctx.Workshop && ctx.Senate && ctx.Economy, "real Senate/Workshop/Economy loaded (migrate's branches are live)");

const START = ctx.CONFIG.startingCredits;

// Game.state is null while migrate() runs — init() only assigns it once migrate
// RETURNS. Any module that reaches for Game.state from inside migrate explodes and
// takes the save with it. Trap the read so it fails with a message that says so.
let trapped = null;
Object.defineProperty(Game, "state", {
  configurable: true,
  get() { trapped = new Error("Game.state was read during migrate() — take the migrating state as a parameter instead (see Workshop.ensureAutoUnlocks / Economy.repairCosmeticNames)"); throw trapped; },
  set() {},
});
const migrate = loaded => { warnings.length = 0; trapped = null; return Game.migrate(loaded); };

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
assert(s.positions && typeof s.positions === "object" && !Array.isArray(s.positions), "positions:null → object");
s = migrate({ v: 2, avgCost: "x" });
assert(s.avgCost && typeof s.avgCost === "object", "avgCost:string → object");
s = migrate({ v: 2, currentSystem: 99 });
assert(typeof s.currentSystem === "string", "currentSystem:number → default string");

// 2b) …and every OTHER array-typed collection, not a hand-picked few. `newswire`
//     was the one that slipped through: Broadcast.backfill spreads it, so a save
//     with newswire:{} threw OUTSIDE migrate's try/catch and before UI.init —
//     an unrecoverable blank page on every reload.
for (const key of ["newswire", "reports", "orders", "listings", "missions", "charters",
                   "expeditions", "industries", "shipments", "activeBoosts", "bazaarBought"]) {
  for (const bad of [{}, 7, "x", null, true]) {
    const out = migrate({ v: 2, [key]: bad });
    assert(Array.isArray(out[key]), `${key}:${JSON.stringify(bad)} → array`);
  }
  const kept = migrate({ v: 2, [key]: [] });
  assert(Array.isArray(kept[key]), `${key}:[] → kept as an array`);
}
// The real backfill path over a wrong-typed newswire — the actual crash site.
{
  const st = migrate({ v: 2, newswire: {} });
  ctx.Game.state = st;   // setter is a no-op under the trap; backfill takes state via s()
  assert(Array.isArray(st.newswire) && st.newswire.length === 0,
    "newswire:{} is an empty array before anything spreads it");
}

// 3) credits coercion: finite, non-negative, or default.
assert(migrate({ v: 2, credits: "abc" }).credits === START, "credits:'abc' → default");
assert(migrate({ v: 2, credits: NaN }).credits === START, "credits:NaN → default");
assert(migrate({ v: 2, credits: Infinity }).credits === START, "credits:Infinity → default");
assert(migrate({ v: 2, credits: -500 }).credits === 0, "credits:-500 → 0 (clamped)");
assert(migrate({ v: 2, credits: 12345 }).credits === 12345, "credits:12345 → kept");
assert(migrate({ v: 2, credits: "9000" }).credits === 9000, "credits numeric-string → coerced");

// 4) A well-formed save is untouched (no false positives).
s = migrate({ v: 2, credits: 777, currentSystem: "syn", positions: { ore: 3 }, unlockedSystems: ["navos"] });
assert(s.credits === 777 && s.currentSystem === "syn" && s.positions.ore === 3, "valid save passes through unchanged");

// 5) v1 save with a corrupt avgCost still ends up an object (v1→v2 path re-reads it).
s = migrate({ v: 1, avgCost: "corrupt" });
assert(s.avgCost && typeof s.avgCost === "object", "v1 avgCost:string → object after migration");

// 6) Totally broken input still yields a usable state.
s = migrate({});
assert(Array.isArray(s.ships) && s.credits === START, "empty save → sane defaults");

// 7) PR #83: a real returning player's save. Everything the player earned has to
//    come back out the other side — this is the case that was silently wiped.
const player = {
  v: 2, credits: 999999, positions: { food: 42 }, prestige: { tier: 3, multiplier: 1.4 },
  achievements: ["first_trade"], knownRecipes: [], craftedOnce: [],
  workshop: { upgrades: 2, queue: [] }, settings: { tutorialSeen: true, muted: false },
  senate: { bills: [], gen: 0 },
};
s = migrate(JSON.parse(JSON.stringify(player)));
assert(s.credits === 999999, "returning save keeps credits");
assert(s.settings.tutorialSeen === true, "returning save keeps tutorialSeen (the dismissed tutorial stays dismissed)");
assert(s.positions.food === 42, "returning save keeps Exchange positions");
assert(s.prestige.tier === 3, "returning save keeps Baron Tier");
assert(s.workshop.upgrades === 2, "returning save keeps Workshop slots");

// 8) Yard refits (state.shipVariants). This is a CLIENT-owned slice — app_commit
//    passes it through untouched, which is what lets a refit survive the server
//    rebuilding `ships`, and also what makes it untrusted save data.
s = migrate({
  v: 2, ships: [{ uid: "s1", type: "bulk", cls: "transport", status: "idle", accessories: [] }],
  shipVariants: {
    s1: { v: "widebelly", name: "Iron Widow" },   // real ship, real refit → keep
    ghost: { v: "runner", name: "Nope" },          // no such ship
    s1x: { v: "forged_variant" },                  // not in SHIP_VARIANTS
  },
});
assert(Object.keys(s.shipVariants).join() === "s1", "orphan + forged refits are dropped on load");
assert(s.shipVariants.s1.name === "Iron Widow", "a real refit survives the reload");
assert(s.ships[0].name === "Iron Widow",
  "…and repairCosmeticNames restores the yard name over the server's stub (during migrate, with no Game.state)");
assert(migrate({ v: 2, shipVariants: "junk" }).shipVariants
  && Object.keys(migrate({ v: 2, shipVariants: "junk" }).shipVariants).length === 0,
  "shipVariants:string → empty object");
assert(Object.keys(migrate({ v: 2 }).shipVariants).length === 0, "pre-feature saves get an empty refit map");

// 9) …and it got there cleanly. migrate() wraps its module calls so a throw can't
//    brick persistence, which means a reintroduced bug would be swallowed and every
//    assertion above would still pass. Fail loudly if a guard had to catch anything.
assert(!trapped, "no module read Game.state during migrate" + (trapped ? " — " + trapped.message : ""));
assert(warnings.length === 0, "migrate ran without tripping a defensive catch" +
  (warnings.length ? " — got: " + warnings.join(" | ") : ""));

console.log("All save-migrate checks passed.");
