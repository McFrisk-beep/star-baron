#!/usr/bin/env node
/* check_voyage.js — visible voyages (docs/LIVING_GALAXY.md §3–§4, §9).
   Event schedules deterministic (within a build and across independent
   builds); pos(plan, t) identical under shuffled / odd-stepped timestamp
   evaluation (the anti-accumulation test); endpoints land on the endpoints;
   a transiting ship is never in two system scenes at once; events stay inside
   their voyage's window; safe voyages roll fewer events than extreme ones.
   Run: node tools/check_voyage.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const FILES = ["store.js", "data.js", "flavor.js", "galaxy.js", "lanes.js", "combat.js", "missions.js", "voyage.js"];
const boot = () => {
  const ctx = vm.createContext({ console, Math, Date });
  ctx.window = ctx;
  for (const f of FILES) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
  }
  ctx.Galaxy.build();
  ctx.Lanes.build();
  // voyage.js only reads state + a couple of Fleet helpers; stub the rest.
  ctx.Fleet = { ship: () => null, shipDef: () => null, mainDef: () => ({ sprite: "shuttle", name: "Pinnace" }) };
  ctx.Charters = { active: () => [], shipUids: () => [] };
  ctx.Game = { state: { currentSystem: null, travel: null, missions: [], reports: [] } };
  return ctx;
};

const ctx = boot();
const { Voyages, Galaxy, Lanes } = ctx;
const caps = Galaxy.list.filter(s => s.capital).map(s => s.id);
const from = caps[0];
const dest = Galaxy.list.find(s => !s.capital && s.id !== from);

// ---- pos(plan, t): pure, endpoint-exact, order-independent -----------------
{
  const T0 = 1000000, ETA = 600000;
  const plan = Voyages.plan(from, dest.id, T0, ETA);
  assert.ok(plan && plan.legs.length >= 2, "plan routes through the lane graph");
  for (let i = 0; i + 1 < plan.legs.length; i++)
    assert.ok(Lanes.adj[plan.legs[i]].some(l => l.to === plan.legs[i + 1]), `leg ${i} follows a lane`);

  const p0 = Voyages.pos(plan, T0), p1 = Voyages.pos(plan, T0 + ETA);
  const A = Galaxy.get(from).pos, B = Galaxy.get(dest.id).pos;
  assert.ok(Math.hypot(p0.x - A.x, p0.y - A.y) < 1e-9, "t=departedAt sits on the origin");
  assert.ok(Math.hypot(p1.x - B.x, p1.y - B.y) < 1e-9, "t=arrival sits on the destination");
  assert.ok(Math.hypot(Voyages.pos(plan, T0 - 5000).x - A.x, Voyages.pos(plan, T0 - 5000).y - A.y) < 1e-9, "pre-departure clamps to origin");

  // anti-accumulation: odd-stepped times, evaluated shuffled, match sequential
  const times = [];
  for (let t = T0; t <= T0 + ETA; t += 7321) times.push(t);
  const seq = times.map(t => Voyages.pos(plan, t));
  const shuffled = [...times].sort(() => 0.5 - ((times.length * 7919) % 17) / 17);
  const byT = {};
  for (const t of shuffled) byT[t] = Voyages.pos(plan, t);
  times.forEach((t, i) => assert.deepStrictEqual({ ...byT[t] }, { ...seq[i] },
    "pos(t) is independent of evaluation order"));
  // and identical across a second independent build
  const ctx2 = boot();
  const plan2 = ctx2.Voyages.plan(from, dest.id, T0, ETA);
  times.forEach(t => assert.deepStrictEqual({ ...ctx2.Voyages.pos(plan2, t) }, { ...byT[t] },
    "pos(t) identical across independent builds"));
}

// ---- mission voyage: out leg, on-site, return leg --------------------------
const mkMission = (uid, type, danger, startedAt, totalMs) => ({
  uid, type, danger, title: "Job " + uid, sysName: dest.name, fromSys: from,
  shipUids: [], startedAt, totalMs, successChance: 0.7,
  phases: [
    { label: "Outbound transit", dir: "out", ms: totalMs * 0.3 },
    { label: "w1", dir: "work", ms: totalMs * 0.18 },
    { label: "w2", dir: "work", ms: totalMs * 0.22 },
    { label: "Return transit", dir: "in", ms: totalMs * 0.3 },
  ],
});
{
  const T0 = 5000000, TOT = 1000000;
  ctx.Game.state.currentSystem = from;
  ctx.Game.state.missions = [mkMission("m1", "escort", "moderate", T0, TOT)];
  const at = t => Voyages.active(t).find(v => v.kind === "mission");
  const out = at(T0 + TOT * 0.15), work = at(T0 + TOT * 0.5), back = at(T0 + TOT * 0.85);
  assert.ok(out && out.at, "outbound leg renders a moving marker");
  assert.ok(work && work.sysId === dest.id && !work.at, "work phase parks at the destination");
  assert.ok(back && back.at, "return leg renders a moving marker");
  const A = Galaxy.get(from).pos;
  const home = Voyages.pos(back.plan, T0 + TOT);
  assert.ok(Math.hypot(home.x - A.x, home.y - A.y) < 1e-9, "return leg ends at the origin");

  // a transiting ship is never in two system scenes at once
  const routeSys = out.plan.legs.concat([caps[1]]);
  for (let k = 1; k < 10; k++) {
    const t = T0 + (TOT * 0.3) * (k / 10);
    const hits = routeSys.filter(id => Voyages.inSystem(id, t).some(v => v.id === "m:m1"));
    assert.strictEqual(hits.length, 1, `transit at ${k}/10 appears in exactly one system scene`);
  }
  ctx.Game.state.missions = [];
}

// ---- flagship: travel marker + docked presence in the system view ----------
{
  const T0 = 9000000, ETA = 300000;
  ctx.Game.state.currentSystem = from;
  ctx.Game.state.travel = { from, to: dest.id, departedAt: T0, etaMs: ETA };
  const mv = Voyages.markers(T0 + ETA / 2).find(v => v.id === "flag");
  assert.ok(mv && mv.at && mv.name === "You", "travelling flagship is a named moving marker");
  ctx.Game.state.travel = null;
  const parked = Voyages.inSystem(from, T0).find(v => v.id === "flag");
  assert.ok(parked && parked.mode === "docked", "docked flagship shows in its system scene");
}

// ---- event schedules: seeded at dispatch, deterministic, windowed ----------
{
  const T0 = 42000000, TOT = 2000000;
  const m = mkMission("m9", "escort", "extreme", T0, TOT);
  const a = Voyages._missionEvents(m), b = Voyages._missionEvents(m);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a.map(e => ({ id: e.id, kind: e.kind, t: e.t })))),
    JSON.parse(JSON.stringify(b.map(e => ({ id: e.id, kind: e.kind, t: e.t })))),
    "recomputed schedule is identical");
  // join(): vm-realm arrays fail deepStrictEqual's prototype check
  const other = boot().Voyages._missionEvents(m);
  assert.strictEqual([...a].map(e => e.id + ":" + e.t).join("|"), [...other].map(e => e.id + ":" + e.t).join("|"),
    "schedule identical across independent builds");
  for (const e of a) assert.ok(e.t >= T0 && e.t <= T0 + TOT, "event inside the voyage window");

  // combat missions always stage their engagement on arrival
  const cm = Voyages._missionEvents(mkMission("mc", "combat", "high", T0, TOT));
  assert.strictEqual(cm.length, 1, "combat mission has exactly one engagement");
  assert.strictEqual(cm[0].t, Math.round(T0 + TOT * 0.3), "engagement fires when the fleet arrives");

  // danger scales frequency: safe rolls fewer events than extreme, most safe roll zero
  let nSafe = 0, nExt = 0, zeroSafe = 0;
  for (let i = 0; i < 300; i++) {
    const s = Voyages._missionEvents(mkMission("s" + i, "escort", "safe", T0, TOT));
    const x = Voyages._missionEvents(mkMission("x" + i, "escort", "extreme", T0, TOT));
    nSafe += s.length; nExt += x.length;
    if (!s.length) zeroSafe++;
  }
  assert.ok(nSafe < nExt, `safe rolls fewer events than extreme (${nSafe} < ${nExt})`);
  assert.ok(zeroSafe > 200, `most safe voyages roll zero events (${zeroSafe}/300)`);
}

// ---- tick primes past events silently --------------------------------------
{
  const now = 77000000;
  ctx.Game.state.missions = [mkMission("mt", "combat", "extreme", now - 900000, 1000000)];
  let announced = 0;
  ctx.UI = { toast: () => { announced++; }, page: "hub" };
  ctx.Feed = { emit: () => { announced++; } };
  Voyages._primed = false; Voyages._seen = new Set();
  Voyages.tick(now);
  assert.strictEqual(announced, 0, "first tick primes without announcing past events");
  assert.ok(Voyages._seen.size >= 1, "past events are marked seen");
  // a still-future event announces once it matures, exactly once
  const evs = Voyages.allEvents();
  Voyages._seen = new Set();
  Voyages.tick(evs[0].t + 1);
  const once = announced;
  assert.ok(once > 0, "matured event announces");
  Voyages.tick(evs[0].t + 2);
  assert.strictEqual(announced, once, "an event never announces twice");
  ctx.Game.state.missions = [];
}

console.log("check_voyage: all good ✓");
