/* check_equip_sync.js — ship accessories and extractor component-fitment are
   equipped client-side (no RPC), so an app_commit / app_pull readback used to
   echo them back empty and revert the equip. Economy now snapshots + restores
   fitment across every server slice. Also: Cloud.saveRemote must NOT run the
   authoritative commit (which resets credits) while cloud sync is paused. */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const root = path.join(__dirname, "..");
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ctx = { console, JSON, Math, Object, Array };
ctx.window = ctx;
vm.createContext(ctx);
const load = f => vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx);
load("js/store.js");
load("js/economy.js");
load("js/cloud.js");
const Economy = ctx.Economy, Cloud = ctx.Cloud;

const freshState = () => ({
  credits: 999999,
  ships: [{ uid: "s1", type: "mule", accessories: ["i1", "i2"] }],
  extractors: { e1: { uid: "e1", components: ["c1"] } },
  components: { c1: { uid: "c1" } }, items: {}, stats: {},
});
ctx.Game = { state: freshState() };

// ---- 1) accessories/components survive a server slice that cleared them ------
Economy.applyCommitState({ ships: [{ uid: "s1", type: "mule", accessories: [] }],
  extractors: { e1: { uid: "e1", components: [] } } });
assert(eq(ctx.Game.state.ships[0].accessories, ["i1", "i2"]), "ship accessories restored after server cleared them");
assert(eq(ctx.Game.state.extractors.e1.components, ["c1"]), "extractor components restored after server cleared them");

// ---- 2) a real server value wins (forward-compatible) -----------------------
ctx.Game.state = freshState();
Economy.applyCommitState({ ships: [{ uid: "s1", type: "mule", accessories: ["srvX"] }] });
assert(eq(ctx.Game.state.ships[0].accessories, ["srvX"]), "server-provided accessories are not overridden");

// ---- 3) an intentional unequip is respected (empty local → stays empty) ------
ctx.Game.state = freshState();
ctx.Game.state.ships[0].accessories = [];                 // player just unequipped everything
Economy.applyCommitState({ ships: [{ uid: "s1", type: "mule", accessories: [] }] });
assert(eq(ctx.Game.state.ships[0].accessories, []), "unequip is not undone by restore");

// ---- 4) same protection on the _applyServerSlice (pull / trade) path ---------
ctx.Game.state = freshState();
Economy._applyServerSlice({ ships: [{ uid: "s1", type: "mule", accessories: [] }] });
assert(eq(ctx.Game.state.ships[0].accessories, ["i1", "i2"]), "accessories survive _applyServerSlice too");

// ---- 5) saveRemote must NOT commit (which resets credits) while paused --------
Cloud.enabled = true; Cloud._user = { id: "u1" }; Cloud.playersReady = true;
let commitCalls = 0;
Cloud.commit = async () => { commitCalls++; return { ok: true, state: { credits: 5000 } }; };

Cloud._devLocal = true;
(async () => {
  await Cloud.saveRemote({ credits: 999999 });
  assert(commitCalls === 0, "paused: saveRemote does NOT run app_commit (credits stay local)");

  Cloud._devLocal = false;
  ctx.Game.state = { credits: 999999 };
  const st = ctx.Game.state;
  ctx.Economy.applyCommitState = () => {};   // isolate: just prove commit runs when unpaused
  await Cloud.saveRemote(st);
  assert(commitCalls === 1, "unpaused: saveRemote runs app_commit as before");

  console.log("All equip-sync checks passed.");
})().catch(e => { console.error(e); process.exit(1); });
