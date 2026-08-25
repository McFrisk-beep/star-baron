#!/usr/bin/env node
/* check_pois.js — the seeded deep-space POI layer
   (docs/SPACE_INTERACTIVITY.md §2, build order step 1).
   Identical layout across two independent builds; every system gets 4–12
   POIs; every POI sits in the ring between coreSpan and worldSpan (clear of
   the gate ring); solo types (den / buoy / listening post) place at most
   once; POIs keep clear of each other at every generation; the hit-test
   finds what it should. Plus the churn (POICFG): slots are permanent, their
   occupants are not — belts, debris fields and derelicts are worked out by
   NPC crews and replaced, while gas clouds, buoys, posts, rigs and pirate
   dens stay put forever.
   Run: node tools/check_pois.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const FILES = ["store.js", "data.js", "flavor.js", "galaxy.js", "pois.js"];
const boot = () => {
  const ctx = vm.createContext({ console, Math });
  ctx.window = ctx;
  for (const f of FILES) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
  }
  ctx.Galaxy.build();
  return ctx;
};

const ctx = boot();
const { Galaxy, POIs, POI_TYPES, SYSTEMVIEW, POICFG } = ctx;
const CORE = SYSTEMVIEW.coreSpan, WORLD = SYSTEMVIEW.worldSpan, c = WORLD / 2;
const T0 = 1_800_000_000_000;   // fixed clock — churn makes the layout time-dependent

// ---- identical layout across two independent builds -----------------------
const snap = x => JSON.stringify(x.Galaxy.list.map(s => x.POIs.list(s.id, T0)));
assert.strictEqual(snap(ctx), snap(boot()), "two builds produce the identical POI layout");

// ---- per-system structure --------------------------------------------------
let dens = 0;
for (const sys of Galaxy.list) {
  const pois = POIs.list(sys.id, T0);
  assert.strictEqual(POIs.list(sys.id, T0), pois, `${sys.id}: list is cached`);
  assert.ok(pois.length >= 4 && pois.length <= 12, `${sys.id}: 4–12 POIs (${pois.length})`);
  const solo = {};
  for (const p of pois) {
    const def = POI_TYPES[p.type];
    assert.ok(def, `${sys.id}: known type ${p.type}`);
    assert.ok(p.name && p.name.indexOf("{BASE}") < 0, `${sys.id}: named (${p.name})`);
    const d = Math.hypot(p.x - c, p.y - c);
    // ring floor clears the gate ring (gates reach CORE/2−64 on the diagonal)
    assert.ok(d >= CORE * 0.63 && d <= WORLD * 0.475, `${sys.id}: ${p.name} in the ring (${d.toFixed(0)})`);
    if (def.solo) { assert.ok(!solo[p.type], `${sys.id}: at most one ${p.type}`); solo[p.type] = true; }
    if (p.type === "den") dens++;
  }
  for (let i = 0; i < pois.length; i++) for (let j = i + 1; j < pois.length; j++) {
    const d = Math.hypot(pois[i].x - pois[j].x, pois[i].y - pois[j].y);
    assert.ok(d > 90, `${sys.id}: POIs keep clear of each other (${d.toFixed(0)})`);
  }
}
assert.ok(dens > 0, `some systems have a pirate den (${dens})`);

// ---- churn: what rolls, what never does -----------------------------------
// Walk a day of clock in 20-minute steps: every churning site must turn over
// at least once, every permanent one must never move, and sites must keep
// clear of each other at EVERY generation (not just the first).
{
  const STEP = 20 * 60 * 1000, DAY = 24 * 60 * 60 * 1000;
  const seen = {}, moved = {}, kinds = new Set();
  let checkedGens = 0, minSep = Infinity;
  for (const sys of Galaxy.list.slice(0, 12)) {
    for (let t = T0; t < T0 + DAY; t += STEP) {
      const pois = POIs.list(sys.id, t);
      checkedGens++;
      for (let i = 0; i < pois.length; i++) {
        const p = pois[i];
        (seen[p.id] = seen[p.id] || new Set()).add(p.name + "@" + Math.round(p.x) + "," + Math.round(p.y));
        for (let j = i + 1; j < pois.length; j++)
          minSep = Math.min(minSep, Math.hypot(p.x - pois[j].x, p.y - pois[j].y));
      }
    }
    for (const slot of POIs.slots(sys.id)) {
      const n = seen[slot.id].size;
      kinds.add(slot.type);
      if (POIs.churns(slot)) {
        assert.ok(n > 1, `${slot.id} (${slot.type}): churns — NPC crews clear it and a new site takes the slot (${n} over a day)`);
        moved[slot.type] = (moved[slot.type] || 0) + 1;
        const life = POIs.lifeMs(slot);
        assert.ok(life >= POICFG.churnMinMs && life <= POICFG.churnMaxMs,
          `${slot.id}: lifetime inside the POICFG window (${Math.round(life / 60000)}m)`);
      } else {
        assert.strictEqual(n, 1, `${slot.id} (${slot.type}): permanent — never rolls over`);
        assert.strictEqual(POIs.lifeMs(slot), Infinity, `${slot.id}: permanent sites have no lifetime`);
      }
    }
  }
  assert.ok(minSep > 90, `sites keep clear of each other at every generation (${minSep.toFixed(0)})`);
  for (const t of ["belt", "debris", "derelict"]) assert.ok(moved[t] > 0, `${t} sites churn`);
  for (const t of ["gas", "buoy", "den", "post"]) assert.ok(!moved[t], `${t} sites are permanent`);
  console.log(`  churn: ${checkedGens} system-snapshots over a day · churning ${Object.keys(moved).join("/")} · sites stay ${minSep.toFixed(0)}+ apart`);
}

// ---- hit-test ---------------------------------------------------------------
{
  const sys = Galaxy.list[0], pois = POIs.list(sys.id, T0);
  const p = pois[0];
  assert.strictEqual(POIs.at(sys.id, p.x + p.r * 0.5, p.y, 0, T0), p, "hit inside the radius");
  assert.strictEqual(POIs.at(sys.id, c, c, 0, T0), null, "miss at the star (core is POI-free)");
  assert.strictEqual(POIs.at("nope", 0, 0, 0, T0), null, "unknown system misses");
  assert.strictEqual(POIs.get(p.id, T0).name, p.name, "get() resolves the current occupant");
}

console.log(`check_pois: OK — ${Galaxy.list.length} systems, ` +
  `${Galaxy.list.reduce((n, s) => n + POIs.list(s.id, T0).length, 0)} POIs, ${dens} dens`);
