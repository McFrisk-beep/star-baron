#!/usr/bin/env node
/* check_encounters.js — the canvas-first engagement model (js/encounters.js).
   The load-bearing claims: an encounter is rebuilt from a REPORT alone (uid =
   seed, roster + hauler/wave/enemyCount = cast, success/lost/damaged = the
   verdict); the shield/hull bars only ever fall and land EXACTLY on that
   verdict; projectiles fly and deaths burn; the hauler never dies and always
   jumps; and a snapshot is a pure function of the clock, so the scene, the
   zoom view and every spectating client render the identical moment.
   Run: node tools/check_encounters.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const FILES = ["store.js", "data.js", "flavor.js", "market.js", "galaxy.js", "lanes.js",
  "security.js", "pois.js", "stock.js", "stations.js", "reputation.js", "crime.js",
  "fleet.js", "charters.js", "voyage.js", "raiders.js", "traffic.js", "items.js",
  "combat.js", "piracy.js", "police.js", "encounters.js"];
const ctx = vm.createContext({ console, Math, Date, setTimeout, clearTimeout });
ctx.window = ctx;
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}
ctx.Game = { state: { seq: 1, ships: [], positions: {}, avgCost: {}, credits: 0, reputation: {},
  currentSystem: "navos", mainShip: { type: "pinnace" }, settings: {},
  items: {}, extractors: {}, industries: [], mining: [], piracy: [], reports: [] },
  timeScale: 1, requestSave() {} };
ctx.Market.init(); ctx.Galaxy.build(); ctx.Lanes.build();
const E = ctx.Encounters;

// ---- a lost wave: the player's hull burns, the pair holds the field --------
{
  const r = { uid: "encT1w0", type: "smuggle", police: true, wave: 0, success: false, wipe: true,
    enemyCount: 2, lost: [{ uid: "s1", name: "Test Hull" }], damaged: [],
    roster: [{ uid: "s1", name: "Test Hull", type: "corvette" }], sysId: "navos" };
  const e = E.fromReport(r);
  assert.ok(e && e.kind === "wave" && e.sides.you.length === 1 && e.sides.foe.length === 2, "cast built from the report");
  assert.strictEqual(e.sides.you[0].fate, "dead", "the verdict rides the descriptor");
  const D = e.t1 - e.t0;
  let lastHull = 1, sawBoom = false, shots = 0;
  for (let t = 0; t <= D; t += 500) {
    const s = E.snapshot(e, t);
    const me = s.ships.find(x => x.side === "you");
    if (me) { assert.ok(me.hull <= lastHull + 1e-9, "hull only ever falls"); lastHull = me.hull; }
    shots += s.shots.length;
    if (s.booms.length) sawBoom = true;
  }
  const end = E.snapshot(e, D);
  assert.ok(!end.ships.some(x => x.side === "you"), "the lost hull is gone at the end");
  assert.strictEqual(end.ships.filter(x => x.side === "foe").length, 2, "the pair holds the field");
  assert.ok(sawBoom && shots > 0 && end.done, "fireball, projectiles, and an ending on schedule");
}

// ---- a won boarding: the hauler survives, jumps, and damage lands exactly --
{
  const r = { uid: "encT2rob", type: "combat", success: true, hauler: { name: "Star Maw", kind: "freighter" },
    enemyCount: 3, lost: [], damaged: [{ uid: "s1", name: "Test Hull", pct: 12 }],
    roster: [{ uid: "s1", name: "Test Hull", type: "corvette" }], sysId: "navos" };
  const e = E.fromReport(r);
  const D = e.t1 - e.t0;
  const mid = E.snapshot(e, D * 0.5);
  const hauler = mid.ships.find(x => x.convoy);
  assert.ok(hauler, "the hauler itself is on the field");
  assert.strictEqual(hauler.hull, 1, "…and is never destroyed — stripped, not sunk");
  assert.ok(!E.snapshot(e, D * 0.99).ships.some(x => x.convoy), "…and jumps clear at the end");
  const me = E.snapshot(e, D * 0.99).ships.find(x => x.side === "you");
  assert.ok(Math.abs(me.hull - 0.88) < 1e-9, "the bars land exactly on the verdict (12% damage)");
}

// ---- purity: every watcher sees the same moment ----------------------------
{
  const r = { uid: "encT3rob", type: "combat", success: true, hauler: { name: "Mark", kind: "trader" },
    enemyCount: 2, lost: [], damaged: [], roster: [{ uid: "s1", name: "A", type: "gunboat" }], sysId: "navos" };
  const a = JSON.stringify(E.snapshot(E.fromReport(r), 9999));
  const b = JSON.stringify(E.snapshot(E.fromReport(r), 9999));
  assert.strictEqual(a, b, "a snapshot is a pure function of (report, t)");
}

// ---- live: an op mid-boarding yields the SAME encounter the report will ----
{
  const c = ctx;
  const sh = c.Fleet.makeShip("corvette"); c.Game.state.ships.push(sh);
  sh.status = "raiding";
  const op = { id: "prE1", verb: "rob", shipUid: sh.uid, sysId: "navos", toSys: "navos",
    fromSys: "navos", flightId: "f1", loop: 0, kind: "freighter", name: "Star Maw",
    manifest: ["foodstuffs"], chance: 1, atk: 300, law: 0.1, value: 500, cargo: 40,
    startedAt: 0, travelMs: 60000, resolveAt: 60000, returnAt: 120000, resolved: false };
  c.Game.state.piracy = [op];
  const live = E.active(65000);
  assert.strictEqual(live.length, 1, "the boarding window yields one live encounter");
  assert.strictEqual(live[0].uid, op.id + "rob", "…under the report's own uid, so live and replay agree");
  assert.ok(live[0].t0 === op.resolveAt && live[0].t1 === c.Piracy.robEndAt(op), "…on the stage clock");
  const snap = E.snapshot(live[0], 70000);
  assert.ok(snap.ships.some(x => x.side === "you") && snap.ships.some(x => x.convoy),
    "raider and hauler both on the field, live");
  assert.strictEqual(E.active(20000).length, 0, "nothing renders before the intercept");
}

// ---- the spectator round-trip: publish params, rebuild the SAME fight ------
// What a baron's client posts to encounter_presence is what every other
// client rebuilds from. The rebuilt snapshot must be identical to the
// publisher's own — that is the whole multiplayer trick.
{
  const r = { uid: "encT4w1", type: "smuggle", police: true, wave: 1, success: true,
    enemyCount: 4, lost: [], damaged: [{ uid: "s9", name: "My Hull", pct: 9 }],
    roster: [{ uid: "s9", name: "My Hull", type: "frigate" }], sysId: "navos" };
  const p = E._params(r);
  assert.ok(!JSON.stringify(p).includes("s9"), "internal ship uids never leave the client");
  const rebuilt = { uid: r.uid, sysId: "navos", police: p.police, wave: p.wave,
    hauler: p.hauler, enemyCount: p.enemyCount, success: p.success, wipe: p.wipe,
    roster: p.roster, lost: p.lost, damaged: p.damaged };
  const mine = E.snapshot(E.fromReport(r), 22222);
  const theirs = E.snapshot(E.fromReport(rebuilt), 22222);
  const strip = s2 => JSON.stringify(s2.ships.map(x => [x.name, x.side, +x.sh.toFixed(6), +x.hull.toFixed(6), +x.x.toFixed(6), +x.y.toFixed(6)]));
  assert.strictEqual(strip(mine), strip(theirs),
    "a spectator rebuilds the publisher's exact fight from the posted params");
  // and the window filter behaves
  E._remote = [{ user_id: "u2", enc_id: r.uid, display: "Rival", kind: "wave",
    sys_id: "navos", t0: 1000, t1: 41000, params: p }];
  assert.strictEqual(E.remoteActive(500).length, 0, "nothing before the window");
  const act = E.remoteActive(2000);
  assert.strictEqual(act.length, 1, "inside the window the fight exists");
  assert.ok(act[0].remote && act[0].display === "Rival" && act[0].sysId === "navos",
    "…tagged with the baron's name and place");
  assert.strictEqual(E.remoteActive(42000).length, 0, "…and gone after it");
  E._remote = [];
}

console.log("OK check_encounters");
