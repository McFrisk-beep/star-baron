#!/usr/bin/env node
/* check_lanes.js — the hyperspace lane graph (docs/LIVING_GALAXY.md §2, §9).
   Graph connected; gate count = degree with true bearings; identical graph
   across two independent builds; ring property on capitals; Dijkstra sanity.
   Run: node tools/check_lanes.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const boot = () => {
  const ctx = vm.createContext({ console, Math });
  ctx.window = ctx;
  for (const f of ["store.js", "data.js", "flavor.js", "galaxy.js", "lanes.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
  }
  ctx.Galaxy.build();
  ctx.Lanes.build();
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

// capital ring: exactly two trunk connectors each, to the RING-order neighbours
assert.strictEqual([...Lanes.RING].sort().join(), SECTORS.map(s => s.id).sort().join(), "RING covers every sector once");
const caps = Lanes.RING.map(id => SECTORS.find(s => s.id === id).capital);
caps.forEach((cap, i) => {
  const trunks = Lanes.adj[cap].filter(l => l.trunk).map(l => l.to).sort();
  const want = [caps[(i + 1) % caps.length], caps[(i + caps.length - 1) % caps.length]].sort();
  // join(): vm-realm arrays fail deepStrictEqual's prototype check
  assert.strictEqual(trunks.join(), want.join(), `${cap} trunk lanes = its two ring neighbours`);
});
assert.strictEqual(Lanes.list.filter(l => l.trunk).length, caps.length, "trunk ring has one lane per sector pair");

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
const hypot = (a, b) => Math.hypot(Galaxy.get(a).pos.x - Galaxy.get(b).pos.x, Galaxy.get(a).pos.y - Galaxy.get(b).pos.y);
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

console.log("check_lanes: all good ✓");
