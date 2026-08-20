#!/usr/bin/env node
/* check_lanes.js — the hyperspace lane graph (docs/LIVING_GALAXY.md §2, §9).
   Graph connected; gate count = degree with true bearings; identical graph
   across two independent builds; sector ring anchored on edge systems;
   Dijkstra sanity; travel distance actually follows the lanes; a RING/SECTORS
   desync degrades instead of taking boot down.
   Run: node tools/check_lanes.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const DEFAULT_FILES = ["store.js", "data.js", "flavor.js", "galaxy.js", "lanes.js"];
// load() stops before build() so a test can mutate SECTORS first; boot() builds.
const load = (files = DEFAULT_FILES) => {
  const ctx = vm.createContext({ console, Math });
  ctx.window = ctx;
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
  }
  return ctx;
};
const boot = (files) => {
  const ctx = load(files);
  ctx.Galaxy.build();
  if (ctx.Lanes) ctx.Lanes.build();
  return ctx;
};

const ctx = boot();
const { Galaxy, Lanes, SECTORS } = ctx;

// ---- identical graph across two independent builds ------------------------
const snap = c => JSON.stringify({ adj: c.Lanes.adj, list: c.Lanes.list });
assert.strictEqual(snap(ctx), snap(boot()), "two builds produce the identical lane graph");

// ---- structure ------------------------------------------------------------
assert.ok(Galaxy.list.length > 50, `galaxy built (${Galaxy.list.length} systems)`);
assert.strictEqual(Object.keys(Lanes.adj).length, Galaxy.list.length, "every system is on the graph");

// connected: BFS from the first capital reaches everything
{
  const seen = new Set([SECTORS[0].capital]), q = [SECTORS[0].capital];
  while (q.length) for (const l of Lanes.adj[q.pop()]) if (!seen.has(l.to)) { seen.add(l.to); q.push(l.to); }
  assert.strictEqual(seen.size, Galaxy.list.length, "lane graph is connected");
}

// sector ring: each RING-adjacent pair of sectors is joined by exactly one
// trunk lane, anchored on their edge systems — the closest cross-border pair
assert.strictEqual([...Lanes.RING].sort().join(), SECTORS.map(s => s.id).sort().join(), "RING covers every sector once");
const hypot = (a, b) => Math.hypot(Galaxy.get(a).pos.x - Galaxy.get(b).pos.x, Galaxy.get(a).pos.y - Galaxy.get(b).pos.y);
const secOf = id => Galaxy.get(id).sectorId;
Lanes.RING.forEach((secId, i) => {
  const nextId = Lanes.RING[(i + 1) % Lanes.RING.length];
  const t = Lanes.list.filter(l => l.trunk &&
    ((secOf(l.a) === secId && secOf(l.b) === nextId) || (secOf(l.a) === nextId && secOf(l.b) === secId)));
  assert.strictEqual(t.length, 1, `${secId}↔${nextId}: exactly one trunk lane`);
  let best = null;
  const A = Galaxy.sectors.find(s => s.id === secId), B = Galaxy.sectors.find(s => s.id === nextId);
  for (const a of A.systems) for (const b of B.systems) {
    const d = hypot(a, b);
    if (!best || d < best.d) best = { d, a, b };
  }
  // join(): vm-realm arrays fail deepStrictEqual's prototype check
  assert.strictEqual([t[0].a, t[0].b].sort().join(), [best.a, best.b].sort().join(),
    `${secId}↔${nextId} trunk joins the closest edge systems`);
});
assert.strictEqual(Lanes.list.filter(l => l.trunk).length, Lanes.RING.length, "trunk ring has one lane per sector pair");
for (const sec of SECTORS) {
  const n = Lanes.list.filter(l => l.trunk && (secOf(l.a) === sec.id || secOf(l.b) === sec.id)).length;
  assert.strictEqual(n, 2, `${sec.id} has exactly two trunk connections`);
}
const caps = SECTORS.map(s => s.capital);

// lanes stay inside their sector (trunk ring aside)
for (const l of Lanes.list) {
  if (l.trunk) continue;
  assert.strictEqual(Galaxy.get(l.a).sectorId, Galaxy.get(l.b).sectorId, `lane ${l.a}→${l.b} is intra-sector`);
}

// ---- gates ----------------------------------------------------------------
for (const sys of Galaxy.list) {
  const gs = Lanes.gates(sys.id);
  assert.strictEqual(gs.length, Lanes.adj[sys.id].length, `${sys.id}: gate count = lane degree`);
  for (const g of gs) {
    const o = Galaxy.get(g.to).pos;
    assert.strictEqual(g.angle, Math.atan2(o.y - sys.pos.y, o.x - sys.pos.x), `${sys.id}: gate bearing points at ${g.to}`);
  }
}

// ---- routes ---------------------------------------------------------------
for (const a of caps) for (const b of Galaxy.list.map(s => s.id)) {
  const r = Lanes.route(a, b);
  assert.ok(r && r.path[0] === a && r.path[r.path.length - 1] === b, `route ${a}→${b} exists with correct endpoints`);
  for (let i = 0; i + 1 < r.path.length; i++)
    assert.ok(Lanes.adj[r.path[i]].some(l => l.to === r.path[i + 1]), `route ${a}→${b} hop ${i} follows a lane`);
  assert.ok(r.len >= hypot(a, b) - 1e-9, `route ${a}→${b} is no shorter than the straight line`);
  assert.ok(Math.abs(Lanes.routeLength(b, a) - r.len) < 1e-9, `route ${a}↔${b} symmetric`);
}
assert.strictEqual(Lanes.route(caps[0], caps[0]).len, 0, "route to self is zero-length");
assert.strictEqual(Lanes.route("nope", caps[0]), null, "unknown system routes to null");

// ---- travel distance follows the lanes (LIVING_GALAXY.md §2.5) -------------
{
  const c = boot(["store.js", "data.js", "flavor.js", "galaxy.js", "lanes.js", "assets.js"]);
  const gen = c.Galaxy.list.filter(s => !s.capital).map(s => s.id);
  const [a, b] = [gen[0], gen[gen.length - 1]];
  assert.strictEqual(c.Shipments.distance(a, b), c.Lanes.routeLength(a, b),
    "generated-system distance = lane route length, not straight line");
  assert.ok(c.Shipments.distance(a, b) > Math.hypot(
    c.Galaxy.get(a).pos.x - c.Galaxy.get(b).pos.x, c.Galaxy.get(a).pos.y - c.Galaxy.get(b).pos.y),
    "routing through lanes is longer than flying straight");
  // curated capital-to-capital keeps SYSTEMS.distance, so trade-loop balance holds
  assert.strictEqual(c.Shipments.distance("navos", "sable"),
    Math.abs(c.SYSTEMS.find(s => s.id === "navos").distance - c.SYSTEMS.find(s => s.id === "sable").distance),
    "capital pairs still use curated SYSTEMS.distance");
  // no lane graph (module absent) → the straight-line fallback still works
  const nl = boot(["store.js", "data.js", "flavor.js", "galaxy.js", "assets.js"]);
  assert.ok(nl.Shipments.distance(a, b) > 0, "distance falls back cleanly when Lanes is absent");
}

// ---- RING/SECTORS desync degrades, never kills boot ------------------------
{
  // a sector RING names but SECTORS no longer has
  const gone = load();
  gone.SECTORS.splice(gone.SECTORS.findIndex(s => s.id === "forge"), 1);
  gone.Galaxy.build();
  assert.doesNotThrow(() => gone.Lanes.build(), "a sector missing from SECTORS doesn't throw in build()");
  // a sector SECTORS has but RING forgot — must still be reachable
  const added = load();
  added.SECTORS.push({ id: "rim", name: "Rim", capital: "navos", specialty: null,
    race: "voidkin", nebula: "void", star: "white", pos: { x: 0.12, y: 0.14 } });
  added.Galaxy.build(); added.Lanes.build();
  const seen = new Set([added.Galaxy.list[0].id]), q = [added.Galaxy.list[0].id];
  while (q.length) for (const l of added.Lanes.adj[q.pop()] || []) if (!seen.has(l.to)) { seen.add(l.to); q.push(l.to); }
  // unique ids, not list.length: this fixture's extra sector reuses a curated capital
  assert.strictEqual(seen.size, Object.keys(added.Galaxy.systems).length,
    "a sector RING forgot is still connected to the graph");
}

console.log("check_lanes: all good ✓");
