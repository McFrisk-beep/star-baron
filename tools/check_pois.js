#!/usr/bin/env node
/* check_pois.js — the seeded deep-space POI layer
   (docs/SPACE_INTERACTIVITY.md §2, build order step 1).
   Identical layout across two independent builds; every system gets 4–12
   POIs; every POI sits in the ring between coreSpan and worldSpan (clear of
   the gate ring); solo types (den / buoy / listening post) place at most
   once; POIs keep clear of each other; the hit-test finds what it should.
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
const { Galaxy, POIs, POI_TYPES, SYSTEMVIEW } = ctx;
const CORE = SYSTEMVIEW.coreSpan, WORLD = SYSTEMVIEW.worldSpan, c = WORLD / 2;

// ---- identical layout across two independent builds -----------------------
const snap = x => JSON.stringify(x.Galaxy.list.map(s => x.POIs.list(s.id)));
assert.strictEqual(snap(ctx), snap(boot()), "two builds produce the identical POI layout");

// ---- per-system structure --------------------------------------------------
let dens = 0;
for (const sys of Galaxy.list) {
  const pois = POIs.list(sys.id);
  assert.strictEqual(POIs.list(sys.id), pois, `${sys.id}: list is cached`);
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

// ---- hit-test ---------------------------------------------------------------
{
  const sys = Galaxy.list[0], pois = POIs.list(sys.id);
  const p = pois[0];
  assert.strictEqual(POIs.at(sys.id, p.x + p.r * 0.5, p.y, 0), p, "hit inside the radius");
  assert.strictEqual(POIs.at(sys.id, c, c, 0), null, "miss at the star (core is POI-free)");
  assert.strictEqual(POIs.at("nope", 0, 0, 0), null, "unknown system misses");
}

console.log(`check_pois: OK — ${Galaxy.list.length} systems, ` +
  `${Galaxy.list.reduce((n, s) => n + POIs.list(s.id).length, 0)} POIs, ${dens} dens`);
