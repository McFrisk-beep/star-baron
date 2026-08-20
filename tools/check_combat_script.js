#!/usr/bin/env node
/* check_combat_script.js — the battle choreographer (LIVING_GALAXY.md §5, §9).
   The script's terminal state must match the report EXACTLY: same dead ships,
   damage sums equal to each pct, untouched ships never hit. Runs real
   Missions._resolveLocal() reports (seeded RNG) through Combat.script across
   many seeds, mission types and outcomes. Run: node tools/check_combat_script.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console });
ctx.window = ctx;
for (const f of ["store.js", "data.js", "fleet.js", "missions.js", "combat.js"])
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });

// neighbours the fleet/mission code calls at runtime (same stubs as check_damage)
ctx.Economy = { authoritative: () => false, afterTax: x => x, refreshNetWorth() {}, checkAchievements() {} };
ctx.Rep = { rewardMult: () => 1, successBonus: () => 0, onContract() {} };
ctx.Items = { gen: () => ({ uid: "it" + Math.random() }) };
ctx.SHIP_NAME_A = ["Test"]; ctx.SHIP_NAME_B = ["Ship"];

const { Fleet, Missions, Combat, SHIP_CATALOG } = ctx;

// seeded Math.random inside the vm so every run exercises identical reports
const mk = seed => { let a = seed >>> 0; return () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

const freshState = () => ({
  credits: 100000, seq: 1, ships: [], missions: [], reports: [], items: {},
  positions: {}, avgCost: {}, stats: {}, mainShip: { type: SHIP_CATALOG.main[0].id },
});

const HULLS = ["gunboat", "corvette", "destroyer", "frigate", "cruiser", "carrier", "battleship", "bulk", "drift", "probe_skiff"];
const TYPES = ["combat", "escort", "smuggle", "assassinate", "transport"];
const DANGERS = ["safe", "low", "moderate", "high", "extreme"];
const FACTIONS_T = [null, "syndicate", "free_trade", "mining_combine"];

// checks one script against its report; returns stats for coverage assertions
function verify(report, tag) {
  const sc = Combat.script(report, report.roster);
  const label = m => `${tag}: ${m}`;

  // determinism — seeded by mission uid, the same fight plays every time
  assert.strictEqual(JSON.stringify(sc), JSON.stringify(Combat.script(report, report.roster)), label("deterministic"));

  assert.ok(sc.duration >= 6 && sc.duration <= 62, label(`duration ${sc.duration} within 6..62`));
  const ids = new Set(sc.ships.map(s => s.id));
  const players = sc.ships.filter(s => s.side === "player");
  const enemies = sc.ships.filter(s => s.side === "enemy");
  assert.ok(enemies.length >= 1, label("at least one enemy"));
  assert.strictEqual(players.length, report.roster.length, label("every roster ship is on stage"));

  // same dead: player deathTs == report.lost exactly (wipe ⇒ everyone)
  const wantDead = report.wipe ? players.map(p => p.id).sort()
    : (report.lost || []).map(x => x.uid).sort();
  assert.strictEqual(players.filter(p => p.deathT).map(p => p.id).sort().join(),
    wantDead.join(), label("script deaths = report.lost"));

  // damage sums within rounding: Σ dmg per ship == pct EXACTLY (integers)
  const sums = {};
  for (const e of sc.events) if (e.dmg) sums[e.to] = (sums[e.to] || 0) + e.dmg;
  for (const d of (report.damaged || []))
    assert.strictEqual(sums[d.uid] || 0, d.pct, label(`dmg sum for ${d.uid} = ${d.pct}`));
  const damagedIds = new Set((report.damaged || []).map(d => d.uid));
  for (const id of Object.keys(sums))
    assert.ok(damagedIds.has(id), label(`dmg only lands on report.damaged (got ${id})`));

  let prev = -1;
  const deathEvents = new Set();
  for (const e of sc.events) {
    assert.ok(e.t >= prev, label("events sorted"));
    prev = e.t;
    assert.ok(e.t >= 0 && e.t <= sc.duration + 1e-9, label("event inside the runtime"));
    assert.ok(["beam", "missile", "flak", "shieldhit", "shielddown", "death", "launch", "say"].includes(e.kind), label(`known kind ${e.kind}`));
    assert.ok(ids.has(e.from) && ids.has(e.to), label("events reference real ships"));
    if (e.kind === "say") assert.ok(typeof e.text === "string" && e.text.length, label("say events carry text"));
    if (e.kind === "death") deathEvents.add(e.from);
    const from = sc.ships.find(s => s.id === e.from);
    if (e.kind !== "death") assert.ok(!from.deathT || e.t <= from.deathT + 1e-9, label("the dead don't fire"));
  }
  for (const s of sc.ships) {
    assert.strictEqual(!!s.deathT, deathEvents.has(s.id), label(`deathT ⇔ death event for ${s.id}`));
    assert.ok(s.path.length >= 2 || s.deathT, label("every ship moves"));
    for (const w of s.path) assert.ok(isFinite(w.t) && isFinite(w.x) && isFinite(w.y), label("finite waypoints"));
  }
  return sc;
}

// ---- many seeded end-to-end reports through the REAL resolver --------------
let engagements = 0, wipes = 0, flawless = 0, checked = 0;
vm.runInContext(`Math.random = () => window.__r()`, ctx);   // sandbox-only, reseeded per run
for (let seed = 1; seed <= 120; seed++) {
  const rng = mk(seed * 2654435761);
  ctx.__r = rng;
  const s = freshState(); ctx.Game = { state: s, requestSave() {} };
  const n = 1 + Math.floor(rng() * 5);
  const uids = [];
  for (let i = 0; i < n; i++) {
    const sh = Fleet.makeShip(HULLS[Math.floor(rng() * HULLS.length)]);
    sh.status = "mission"; s.ships.push(sh); uids.push(sh.uid);
  }
  s.missions.push({
    uid: "m" + seed, type: TYPES[seed % TYPES.length], title: "Job " + seed,
    shipUids: uids, phases: [], totalMs: 1000, startedAt: Date.now() - 5000,
    successChance: 0.15 + rng() * 0.8, reward: { credits: 1000 },
    impound: TYPES[seed % TYPES.length] === "smuggle",
    danger: DANGERS[seed % DANGERS.length], stakeTier: 0,
    faction: FACTIONS_T[seed % FACTIONS_T.length], resolved: false,
  });
  const rep = Missions.resolveMatured(Date.now())[0];
  assert.ok(Array.isArray(rep.roster) && rep.roster.length === n, `seed ${seed}: report carries the roster`);
  // a lost fight always costs: every surviving hull comes home damaged
  if (!rep.success) {
    const lostIds = new Set((rep.lost || []).map(x => x.uid));
    const dmgIds = new Set((rep.damaged || []).map(x => x.uid));
    for (const p of rep.roster) if (!lostIds.has(p.uid))
      assert.ok(dmgIds.has(p.uid), `seed ${seed}: failed mission → survivor ${p.uid} is damaged`);
  }
  if (!Combat.replayable(rep)) continue;     // clean runs have no scene — by design
  const sc = verify(rep, "seed " + seed);
  checked++;
  engagements++;
  if (sc.outcome === "wipe") wipes++;
  if (sc.outcome === "flawless") flawless++;
}
assert.ok(checked >= 60, `coverage: ${checked} engagements scripted (want ≥60)`);
assert.ok(wipes >= 1 && flawless >= 1, `coverage: saw wipes (${wipes}) and flawless (${flawless})`);

// ---- edges -----------------------------------------------------------------
// roster cap: a 14-ship report stages at most 12
{
  const roster = Array.from({ length: 14 }, (_, i) => ({ uid: "x" + i, name: "S" + i, type: "corvette" }));
  const rep = { uid: "big", type: "combat", success: true, danger: "extreme",
    lost: [], damaged: [{ uid: "x0", name: "S0", pct: 9 }], impounded: [], roster };
  const sc = Combat.script(rep, rep.roster);
  assert.ok(sc.ships.filter(x => x.side === "player").length <= 12, "roster is capped on stage");
}
// unknown hull type falls back to a generic def instead of throwing
{
  const rep = { uid: "odd", type: "combat", success: false, danger: "low",
    lost: [{ uid: "z1", name: "Ghost" }], damaged: [], impounded: [],
    roster: [{ uid: "z1", name: "Ghost", type: "no_such_hull" }] };
  const sc = verify(rep, "unknown-hull");
  assert.ok(sc.ships.length >= 2, "unknown hull still stages");
}
// not replayable: no roster, or nothing happened on a clean haul
assert.ok(!Combat.replayable({ uid: "r1", type: "combat", success: true, lost: [], damaged: [] }), "no roster → no replay");
assert.ok(!Combat.replayable({ uid: "r2", type: "transport", success: true, lost: [], damaged: [], impounded: [],
  roster: [{ uid: "a", name: "A", type: "mule" }] }), "clean haul → nothing to watch");
assert.ok(Combat.replayable({ uid: "r3", type: "combat", success: true, lost: [], damaged: [], impounded: [],
  roster: [{ uid: "a", name: "A", type: "gunboat" }] }), "combat mission is always an engagement");

// charter reports replay with the freight templates (LIVING_GALAXY.md §5)
{
  const rep = { uid: "ch1", type: "charter", success: true, danger: "high", faction: null,
    lost: [{ uid: "c1", name: "Hauler A" }], damaged: [{ uid: "c2", name: "Hauler B", pct: 14 }], impounded: [],
    roster: [{ uid: "c1", name: "Hauler A", type: "drift" }, { uid: "c2", name: "Hauler B", type: "bulk" }] };
  assert.ok(Combat.replayable(rep), "charter with an incident is replayable");
  verify(rep, "charter");
  assert.ok(!Combat.replayable({ uid: "ch2", type: "charter", success: true, danger: "low",
    lost: [], damaged: [], impounded: [], roster: [{ uid: "c3", name: "C", type: "drift" }] }),
    "clean charter → nothing to watch");
}

console.log(`check_combat_script: all good ✓ (${checked} engagements, ${wipes} wipes, ${flawless} flawless)`);
