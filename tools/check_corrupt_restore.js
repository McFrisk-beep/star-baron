/* check_corrupt_restore.js — wipe-backup helpers recover Workshop / inventory
   slices without needing a browser. Loads real sibling modules so migrate runs.

   Covers the PR #85 review must-fixes:
   1) merge must not lift Store._cloudReady / flush a defaultState boot
   2) full restore persists the backup's market/galaxy (not live session)
   3) malformed backup slices are validated (migrate or sanitize) */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const mem = { local: null, corrupt: null };
let reloads = 0;
const sandbox = {
  console,
  Date, Math, JSON, Array, Object, Number, String, Boolean, Error, TypeError, Set, Map, Promise,
  setTimeout, clearTimeout,
  structuredClone: (o) => JSON.parse(JSON.stringify(o)),
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
  location: { reload() { reloads++; } },
  addEventListener() {},
  removeEventListener() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

sandbox.Bazaar = { itemsValue: () => 0, ensure() {} };
sandbox.Galaxy = {
  build() {}, hydrate() {}, serialize: () => ({ wipedSession: true }), localLog: {}, get: () => null,
};
sandbox.Market = {
  init() {}, hydrate() {}, serialize: () => ({ wipedSession: true }), advance() {},
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
const Store = sandbox.Store;

const cloudSaved = [];
sandbox.Cloud.signedIn = () => true;
sandbox.Cloud.saveRemote = async (st) => { cloudSaved.push(JSON.parse(JSON.stringify(st))); };
sandbox.Cloud.commit = async (st) => { cloudSaved.push(JSON.parse(JSON.stringify(st))); return { ok: true, state: st }; };
sandbox.Economy.authoritative = () => true;

function plantBackup(extra = {}) {
  const bak = Game.defaultState();
  bak.credits = 9000;
  bak.market = { fromBackup: true };
  bak.galaxy = { news: ["from-backup"] };
  bak.items = { i99: { uid: "i99", kind: "plating", name: "Lost Plating", rarity: "common" } };
  bak.knownRecipes = ["gear_plating_common", "ex_jack", "ship_corvette"];
  bak.workshop = {
    upgrades: 1,
    queue: [{ id: "ck1", recipeId: "gear_plating_common", startedAt: 1, readyAt: 2, flavorId: null }],
  };
  Object.assign(bak, extra);
  mem.corrupt = JSON.stringify(bak);
  return bak;
}

(async () => {
  // --- happy path soft-merge ---
  Game.state = Game.defaultState();
  Game.state.credits = 1500;
  Game.state.items = {};
  Game.state.knownRecipes = ["gear_plating_common"];
  Game.state.workshop = { upgrades: 0, queue: [] };
  plantBackup();
  Store._cloudReady = false;
  Game._corruptSaveReset = true;
  cloudSaved.length = 0;

  assert(Game.readCorruptBackup(), "reads starbaron.corrupt");
  assert(Game.hasCorruptBackup(), "hasCorruptBackup presence check");
  assert(Game.corruptBackupIsRicher(), "backup with Workshop gear counts as richer");
  assert(Game.corruptBackupSummary().includes("inventory item"), "summary mentions inventory");
  assert(Game.corruptBackupSummary().includes("craft"), "summary mentions craft queue");

  const r = Game.mergeCorruptClientSlices();
  assert(r.ok, "soft-merge succeeds: " + (r.msg || ""));
  assert(Game.state.items.i99 && Game.state.items.i99.name === "Lost Plating", "restored inventory item");
  assert(Game.state.workshop.queue.some(j => j.id === "ck1"), "restored craft queue job");
  assert(Game.state.workshop.upgrades === 1, "restored workshop upgrades");
  assert(Game.state.knownRecipes.includes("ship_corvette"), "restored blueprint");
  assert(Game.state.credits === 1500, "soft-merge keeps current credits");
  assert(Store._cloudReady === false, "merge does not lift the cloud write gate");
  assert(cloudSaved.length === 0, "merge does not flush/commit to cloud while gated");
  assert(mem.local, "merge persists to localStorage");

  const r2 = Game.mergeCorruptClientSlices();
  assert(!r2.ok, "second merge reports nothing missing");

  // --- pullCatchUp respects the gate ---
  cloudSaved.length = 0;
  const pulled = await Game.pullCatchUp();
  assert(pulled === null, "pullCatchUp no-ops while cloud gated");
  assert(cloudSaved.length === 0, "pullCatchUp does not Cloud.commit while gated");

  // --- malformed backup: junk queue/items dropped via sanitize path ---
  Game.state = Game.defaultState();
  Game.state.items = {};
  Game.state.workshop = { upgrades: 0, queue: [] };
  Game.state.knownRecipes = [];
  Store._cloudReady = false;
  plantBackup({
    items: {
      i99: { uid: "i99", kind: "plating", name: "Lost Plating", rarity: "common" },
      bad: { uid: "nope", kind: "plating" },
      worse: "not-an-object",
    },
    knownRecipes: ["gear_plating_common", "totally_fake_recipe", 12],
    workshop: {
      upgrades: 1,
      queue: [
        { id: "ck1", recipeId: "gear_plating_common", startedAt: 1, readyAt: 2, flavorId: null },
        { id: "ckBad", recipeId: "nope", startedAt: 1, readyAt: 2, flavorId: null },
        { id: "ckNaN", recipeId: "gear_plating_common", startedAt: 1, readyAt: NaN, flavorId: null },
        { id: "ckZero", recipeId: "gear_plating_common", startedAt: 1, readyAt: 0, flavorId: null },
      ],
    },
  });
  const realMigrate = Game.migrate.bind(Game);
  Game.migrate = () => { throw new Error("simulated migrate failure"); };
  const r3 = Game.mergeCorruptClientSlices();
  Game.migrate = realMigrate;
  assert(r3.ok, "sanitize-path merge succeeds");
  assert(Game.state.items.i99, "valid item kept");
  assert(!Game.state.items.bad && !Game.state.items.worse, "malformed items dropped");
  assert(!Game.state.knownRecipes.includes("totally_fake_recipe"), "unknown recipe ids dropped");
  assert(Game.state.workshop.queue.every(j => j.id !== "ckBad"), "unknown recipe jobs dropped");
  assert(Game.state.workshop.queue.every(j => j.id !== "ckNaN"), "NaN readyAt jobs dropped");
  assert(Game.state.workshop.queue.every(j => j.id !== "ckZero"), "readyAt < startedAt jobs dropped");
  assert(Store._cloudReady === false, "sanitize-path merge still leaves cloud gated");

  // --- full restore: market/galaxy from backup, not live session ---
  cloudSaved.length = 0;
  reloads = 0;
  Game.state = Game.defaultState();
  Game._corruptSaveReset = true;
  Store._cloudReady = false;
  plantBackup();
  const rr = await Game.restoreCorruptBackup();
  assert(rr.ok, "full restore ok");
  assert(reloads === 1, "full restore reloads");
  const saved = JSON.parse(mem.local);
  assert(saved.market && saved.market.fromBackup === true, "full restore keeps backup market");
  assert(saved.galaxy && saved.galaxy.news && saved.galaxy.news[0] === "from-backup", "full restore keeps backup galaxy");
  assert(!(saved.market && saved.market.wipedSession), "full restore did not snapshot live Market");
  assert(cloudSaved.length === 1, "corrupt-save reset may flush migrated backup once");
  assert(cloudSaved[0].credits === 9000, "flushed backup is the migrated save, not 1500c default");

  // Full restore must NOT lift a failed-cloud-load gate.
  cloudSaved.length = 0;
  reloads = 0;
  Game._corruptSaveReset = false;
  Store._cloudReady = false;
  plantBackup();
  await Game.restoreCorruptBackup();
  assert(Store._cloudReady === false, "full restore leaves failed-load gate closed");
  assert(cloudSaved.length === 0, "full restore does not flush when not a corrupt-save reset");

  // Migrate-fail message points at the fix, not "too damaged".
  Game.migrate = () => { throw new Error("still broken"); };
  const bad = await Game.restoreCorruptBackup();
  Game.migrate = realMigrate;
  assert(!bad.ok && /latest fix/i.test(bad.msg), "migrate-fail message mentions latest fix");

  console.log("All corrupt-restore checks passed.");
})().catch(e => { console.error(e); process.exit(1); });
