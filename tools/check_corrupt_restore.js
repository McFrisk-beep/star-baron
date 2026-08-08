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
  effects: [], localEffects: [], volMult: 1, price: () => 10, spot: () => 10, stocks: () => true,
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

  // --- full restore: economy from server snapshot/row; workshop from browser backup ---
  cloudSaved.length = 0;
  reloads = 0;
  const restoredRpc = [];
  Game.state = Game.defaultState();
  Game._corruptSaveReset = true;
  Store._cloudReady = false;
  sandbox.Cloud.playersReady = true;
  sandbox.Cloud.restoreMissing = false;
  sandbox.Cloud.restoreBackup = async (...args) => {
    restoredRpc.push({ called: true, args: args.length });
    // Corrupt-migrate never wiped the cloud row — RPC returns it unchanged.
    const server = Game.defaultState();
    server.credits = 50_000;
    server.positions = { iron_ore: 10 };
    return { ok: true, state: server, restored: false };
  };
  plantBackup();
  const rr = await Game.restoreCorruptBackup();
  assert(rr.ok, "full restore ok");
  assert(reloads === 1, "full restore reloads");
  const saved = JSON.parse(mem.local);
  assert(saved.market && saved.market.fromBackup === true, "full restore keeps backup market");
  assert(saved.galaxy && saved.galaxy.news && saved.galaxy.news[0] === "from-backup", "full restore keeps backup galaxy");
  assert(!(saved.market && saved.market.wipedSession), "full restore did not snapshot live Market");
  assert(restoredRpc.length === 1, "corrupt-save reset calls app_restore_backup");
  assert(restoredRpc[0].args === 0, "restore RPC takes no client economy payload");
  assert(saved.credits === 50_000, "economy comes from the server row, not the browser backup");
  assert(saved.items && saved.items.i99, "workshop items overlaid from the browser backup");
  assert(saved.knownRecipes && saved.knownRecipes.includes("ex_jack"), "blueprints overlaid from backup");

  // Missing RPC must not silently reload into a half-restored cloud row,
  // and must re-close cloud writes so autosave can't app_commit the wiped 1500c.
  restoredRpc.length = 0;
  reloads = 0;
  Game._corruptSaveReset = true;
  Store._cloudReady = false;
  sandbox.Cloud.restoreBackup = async () => ({ ok: false, missing: true, error: "Restore backup RPC not live." });
  plantBackup();
  const missing = await Game.restoreCorruptBackup();
  assert(!missing.ok && /restore_backup\.sql/i.test(missing.msg || ""), "missing RPC refuses restore");
  assert(reloads === 0, "missing RPC does not reload");
  assert(Store._cloudReady === false, "missing RPC re-closes the cloud write gate");

  // Null / failed RPC likewise refuses instead of reloading.
  reloads = 0;
  Store._cloudReady = false;
  Game._corruptSaveReset = true;
  sandbox.Cloud.restoreBackup = async () => null;
  const nulled = await Game.restoreCorruptBackup();
  assert(!nulled.ok, "null RPC refuses restore");
  assert(reloads === 0, "null RPC does not reload");
  assert(Store._cloudReady === false, "null RPC re-closes the cloud write gate");

  // Thrown RPC also keeps the wipe gated.
  reloads = 0;
  Store._cloudReady = false;
  Game._corruptSaveReset = true;
  sandbox.Cloud.restoreBackup = async () => { throw new Error("network down"); };
  const thrown = await Game.restoreCorruptBackup();
  assert(!thrown.ok, "thrown RPC refuses restore");
  assert(reloads === 0, "thrown RPC does not reload");
  assert(Store._cloudReady === false, "thrown RPC re-closes the cloud write gate");

  // Full restore must NOT lift a failed-cloud-load gate.
  cloudSaved.length = 0;
  reloads = 0;
  Game._corruptSaveReset = false;
  Store._cloudReady = false;
  sandbox.Cloud.restoreBackup = async () => {
    restoredRpc.push({ called: true });
    return { ok: true, state: Game.defaultState(), restored: false };
  };
  plantBackup();
  await Game.restoreCorruptBackup();
  assert(Store._cloudReady === false, "full restore leaves failed-load gate closed");
  assert(cloudSaved.length === 0, "full restore does not flush when not a corrupt-save reset");
  assert(restoredRpc.length === 0, "non-corrupt-reset path does not call restore RPC");

  // Migrate-fail message points at the fix, not "too damaged".
  Game.migrate = () => { throw new Error("still broken"); };
  const bad = await Game.restoreCorruptBackup();
  Game.migrate = realMigrate;
  assert(!bad.ok && /latest fix/i.test(bad.msg), "migrate-fail message mentions latest fix");

  console.log("All corrupt-restore checks passed.");
})().catch(e => { console.error(e); process.exit(1); });
