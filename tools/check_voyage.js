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

  // gate choreography: eased distance is monotonic, 0→0 / 1→1, and the ship
  // holds AT the gate through both gate windows (slow in, spool, jump)
  let prev = -1;
  for (let f = 0; f <= 1.0001; f += 0.01) {
    const d = Voyages._legD(Math.min(1, f));
    assert.ok(d >= prev - 1e-12, "leg distance never runs backwards");
    prev = d;
  }
  assert.strictEqual(Voyages._legD(0), 0, "leg starts at the near system");
  assert.strictEqual(Voyages._legD(1), 1, "leg ends at the far system");
  const gd = Voyages.LEG.gateD;
  assert.strictEqual(Voyages._legD(0.32), gd, "holds at the outbound gate while spooling");
  assert.strictEqual(Voyages._legD(0.65), 1 - gd, "holds at the arrival gate after drop-out");
  assert.strictEqual(Voyages.legPhase(0.5).mode, "hyper", "mid-leg is hyperspace");
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

  // never in two system scenes at once; mid-hyperspace it's in none at all
  const routeSys = out.plan.legs.concat([caps[1]]);
  for (let k = 1; k < 10; k++) {
    const t = T0 + (TOT * 0.3) * (k / 10);
    const hits = routeSys.filter(id => Voyages.inSystem(id, t).some(v => v.id === "m:m1"));
    assert.ok(hits.length <= 1, `transit at ${k}/10 appears in at most one system scene`);
  }
  ctx.Game.state.missions = [];
}

// ---- one-lane leg: departing → gate → hyperspace → gate → arriving ---------
{
  const lane = Lanes.list[0];
  const T0 = 7000000, ETA = 400000;
  ctx.Game.state.currentSystem = lane.a;
  ctx.Game.state.travel = { from: lane.a, to: lane.b, departedAt: T0, etaMs: ETA };
  const at = f => T0 + ETA * f;
  const inA = f => Voyages.inSystem(lane.a, at(f)).find(v => v.id === "flag");
  const inB = f => Voyages.inSystem(lane.b, at(f)).find(v => v.id === "flag");
  assert.strictEqual(inA(0.15).mode, "departing", "cruises for its gate");
  assert.strictEqual(inA(0.35).mode, "gateOut", "holds at the gate, hyperdrive spooling");
  assert.ok(!inA(0.5) && !inB(0.5), "mid-hyperspace it is in neither system");
  assert.strictEqual(inB(0.65).mode, "gateIn", "drops out at the arrival gate");
  assert.strictEqual(inB(0.85).mode, "arriving", "then cruises in from the gate");
  ctx.Game.state.travel = null;
}

// ---- server-shaped missions (placeholder destinations) ---------------------
// app_board_contract names destinations "Sector 12" — the SQL has no galaxy
// table. Those missions must still fly somewhere real, or every signed-in
// player's Live View is empty.
{
  const T0 = 6100000, TOT = 900000;
  ctx.Game.state.currentSystem = from;
  const srv = mkMission("mSRV", "escort", "moderate", T0, TOT);
  srv.title = "Escort contract #4";        // the server's title format
  srv.sysName = "Sector 12";               // the server's placeholder destination
  ctx.Game.state.missions = [srv];
  const v = Voyages.active(T0 + TOT * 0.1).find(x => x.kind === "mission");
  assert.ok(v, "a mission with a placeholder destination still becomes a voyage");
  assert.ok(v.at, "…and it is actually flying");
  assert.ok(Voyages.followable(T0 + TOT * 0.1).some(x => x.id === "m:mSRV"),
    "…and it can be followed on the Live View");
  // stable: the same placeholder always resolves to the same real system
  const again = boot();
  again.Game.state.currentSystem = from;
  const srv2 = { ...srv };
  again.Game.state.missions = [srv2];
  const v2 = again.Voyages.active(T0 + TOT * 0.1).find(x => x.kind === "mission");
  assert.strictEqual(v2.plan.legs[v2.plan.legs.length - 1], v.plan.legs[v.plan.legs.length - 1],
    "the same placeholder name resolves to the same system on every client");
  // a different placeholder generally lands somewhere else
  const names = ["Sector 1", "Sector 5", "Sector 12", "Sector 19"];
  const dests = new Set(names.map(n => {
    ctx.Game.state.missions = [Object.assign(mkMission("mS" + n, "escort", "low", T0, TOT), { sysName: n })];
    const vv = Voyages.active(T0 + TOT * 0.1).find(x => x.kind === "mission");
    return vv && vv.plan ? vv.plan.legs[vv.plan.legs.length - 1] : null;
  }));
  assert.ok(dests.size > 1, "different placeholder sectors spread across systems");
  ctx.Game.state.missions = [];
}

// ---- flagship: travel marker; docked = berthed, not drawn ------------------
{
  const T0 = 9000000, ETA = 300000;
  ctx.Game.state.currentSystem = from;
  ctx.Game.state.travel = { from, to: dest.id, departedAt: T0, etaMs: ETA };
  const mv = Voyages.markers(T0 + ETA / 2).find(v => v.id === "flag");
  assert.ok(mv && mv.at && mv.name === "You", "travelling flagship is a named moving marker");
  ctx.Game.state.travel = null;
  assert.ok(!Voyages.inSystem(from, T0).some(v => v.id === "flag"),
    "a docked flagship is berthed inside the station — not in the scene");
  assert.ok(!Voyages.markers(T0).some(v => v.id === "flag"), "and not on the chart");
}

// ---- §4.4: the dice roll moves to dispatch ---------------------------------
// Client-local outcomes are drawn from a stream seeded by the voyage uid:
// identical across runs, and independent of WHEN resolve happens.
{
  const bootResolve = () => {
    const c = vm.createContext({ console, Math, Date });
    c.window = c;
    for (const f of ["store.js", "data.js", "fleet.js", "missions.js", "charters.js", "combat.js"])
      vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), c, { filename: f });
    c.Economy = { authoritative: () => false, afterTax: x => x, refreshNetWorth() {}, checkAchievements() {}, depth: () => 1e9 };
    c.Rep = { rewardMult: () => 1, successBonus: () => 0, onContract() {}, onContractCancel: () => 0 };
    c.Items = { gen: () => ({ uid: "it1", kind: "gear", value: 1 }) };
    c.SHIP_NAME_A = ["Test"]; c.SHIP_NAME_B = ["Ship"];   // live in flavor.js
    c.Game = { state: { credits: 0, seq: 1, ships: [], missions: [], charters: [], reports: [],
      items: {}, positions: {}, avgCost: {}, stats: {}, currentSystem: "navos",
      mainShip: { type: c.SHIP_CATALOG.main[0].id } } };
    return c;
  };
  const runMission = (now) => {
    const c = bootResolve();
    const s = c.Game.state;
    const a = c.Fleet.makeShip("corvette"), b = c.Fleet.makeShip("frigate");
    a.uid = "sA"; b.uid = "sB"; s.ships.push(a, b); a.status = b.status = "mission";
    s.missions.push({ uid: "m77", type: "combat", title: "t", shipUids: ["sA", "sB"], phases: [],
      totalMs: 1000, startedAt: now - 5000, successChance: 0.5, reward: { credits: 1000, itemChance: 0.5, stockChance: 0.5 },
      impound: false, danger: "extreme", stakeTier: 0, faction: null, resolved: false });
    const rep = c.Missions.resolveMatured(now)[0];
    return { success: rep.success, lost: [...rep.lost].map(x => x.uid).join(),
      dmg: [...rep.damaged].map(x => x.uid + ":" + x.pct).join(), credits: c.Game.state.credits };
  };
  const r1 = runMission(50000000), r2 = runMission(50000000), r3 = runMission(50000000 + 3600000);
  assert.deepStrictEqual(r1, r2, "same mission resolves to the same outcome every time");
  assert.strictEqual(r1.success, r3.success, "resolving an hour later applies the SAME dispatch-seeded verdict");
  assert.strictEqual(r1.lost, r3.lost, "…including which hulls were lost");

  const runCharter = (now) => {
    const c = bootResolve();
    const s = c.Game.state;
    const a = c.Fleet.makeShip("mule"); a.uid = "cA"; s.ships.push(a); a.status = "charter";
    s.charters.push({ id: "ch77", shipUid: "cA", shipUids: ["cA"], band: "extreme", durationMs: 1000,
      startedAt: now - 5000, reward: 500, cargoByShip: { cA: 10 }, cargoTotal: 10, faction: null,
      destroyChance: 0.5, impoundChance: 0.3, impound: true, resolved: false });
    const rep = c.Charters._resolveLocal(now)[0];
    return { success: rep.success, lost: [...rep.lost].map(x => x.uid).join(),
      imp: [...rep.impounded].map(x => x.uid).join() };
  };
  const c1 = runCharter(60000000), c2 = runCharter(60000000 + 7200000);
  assert.deepStrictEqual(c1, c2, "charter outcome is fixed at dispatch, not at maturity");

  // rolledSuccess previews the exact verdict the resolver will apply
  const c = bootResolve();
  const m = { uid: "m77", successChance: 0.5 };
  assert.strictEqual(c.Missions.rolledSuccess(m), r1.success, "rolledSuccess = the resolver's first draw");
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

// ---- §4.5 ordered catch-up: missed entries post once, in order -------------
{
  const c = boot();
  const now = 88000000;
  let m = null, fired = [];
  for (let i = 0; i < 400 && !fired.length; i++) {
    const cand = mkMission("cu" + i, "escort", "extreme", now - 1500000, 1000000);
    fired = c.Voyages._missionEvents(cand).filter(e => e.t <= now);
    if (fired.length) m = cand;
  }
  assert.ok(fired.length, "found a voyage with past events");
  c.Game.state.missions = [m];
  c.Game.state.voySeenT = now - 2000000;         // watermark before the events
  const lines = [], order = [];
  c.Feed = { emit: t => lines.push(t) };
  const orig = c.Voyages.announceOutcome;
  c.Voyages.announceOutcome = function (e, out) { order.push(e.t); return orig.call(this, e, out); };
  c.Voyages._primed = false; c.Voyages._seen = new Set();
  c.Voyages.tick(now);
  assert.strictEqual(lines.length, Math.min(8, fired.length), "missed entries post on catch-up");
  for (let i = 1; i < order.length; i++)
    assert.ok(order[i] >= order[i - 1], "catch-up entries post in chronological order");
  assert.ok(c.Game.state.voySeenT >= now, "watermark advances");
  c.Voyages.tick(now + 1);
  assert.strictEqual(lines.length, Math.min(8, fired.length), "catch-up posts exactly once");
  c.Voyages.announceOutcome = orig;

  // pre-watermark saves (voySeenT 0) still prime silently — no retro wall
  const c0 = boot();
  c0.Game.state.missions = [m];
  const l0 = [];
  c0.Feed = { emit: t => l0.push(t) };
  c0.Voyages._primed = false;
  c0.Voyages.tick(now);
  assert.strictEqual(l0.length, 0, "no watermark → silent prime (old behavior)");
}

// ---- §4.3 checks: seeded auto-roll, applied exactly once -------------------
{
  const mkCtx = () => {
    const c = boot();
    c.Charters.fleetStats = () => ({ cargo: 0, firepower: 120, hull: 0, armor: 0, shields: 150 });
    return c;
  };
  const c = mkCtx();
  const now = 99000000;
  let m = null, ev = null;
  for (let i = 0; i < 600 && !ev; i++) {
    const cand = mkMission("ck" + i, "smuggle", "extreme", now - 1500000, 1000000);
    ev = c.Voyages._missionEvents(cand).find(e => e.kind === "toll" || e.kind === "customs");
    if (ev) m = cand;
  }
  assert.ok(ev, "found a check event");
  c.Game.state.missions = [m];
  const applied = [];
  c.Incidents = { apply: eff => { applied.push(eff); return "fx"; } };
  const o1 = c.Voyages.applyCheck(ev);
  assert.ok(o1, "check applies");
  assert.strictEqual(c.Voyages.applyCheck(ev), null, "…exactly once (ledgered)");
  assert.strictEqual(applied.length, 1, "one wallet application");
  assert.strictEqual(c.Game.state.voyChecks[ev.id], 1, "ledger persisted in state");
  const c2 = mkCtx();
  c2.Game.state.missions = [mkMission(m.uid, m.type, m.danger, m.startedAt, m.totalMs)];
  c2.Incidents = { apply: () => "" };
  const o2 = c2.Voyages.applyCheck(c2.Voyages.allEvents().find(x => x.id === ev.id));
  assert.strictEqual(o2.won, o1.won, "auto-roll verdict is deterministic across builds");
  // signed-in play keeps announce-only events: checks are gated local
  const c3 = mkCtx();
  c3.Incidents = { apply: () => { throw new Error("wallet touched while authoritative"); } };
  c3.Economy = { softIncomeLocal: () => false };
  assert.strictEqual(c3.Voyages.isCheck(ev), false, "checks are guest/local-only");
}

// ---- §4.4: the server-seed mirrors — u01 IS Combat._mk ---------------------
{
  const c = vm.createContext({ console, Math, Date });
  c.window = c;
  for (const f of ["store.js", "data.js", "flavor.js", "market.js", "combat.js", "missions.js", "charters.js"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), c, { filename: f });
  // market.u01(seed, n) (SQL, mirrored by Market._u01) is mulberry32 — the
  // same generator as Combat._mk — so the client verdict mirrors are exact.
  for (const seed of [1, 42, 0xDEADBEEF, 4294967295, 123456789]) {
    assert.strictEqual(c.Market._u01(seed, 0), c.Combat._mk(seed)(), "u01(seed,0) == first _mk draw @" + seed);
    const r = c.Combat._mk(seed); for (let i = 0; i < 7; i++) r();
    assert.strictEqual(c.Market._u01(seed, 7), r(), "u01(seed,7) == 8th _mk draw @" + seed);
  }
  // a server-launched mission (rngSeed stamped by app_mission_launch)
  // predicts app_mission_resolve's verdict: u01(rngSeed, 0) < successChance
  const seed = c.Market._seed(["mission", "m1", "1700000000000"]);
  const m = { uid: "m1", rngSeed: seed, successChance: 0.5 };
  assert.strictEqual(c.Missions.rolledSuccess(m), c.Market._u01(seed, 0) < 0.5, "rolledSuccess mirrors u01(rngSeed, 0)");
  assert.strictEqual(c.Missions.rolledSuccess(m), c.Missions.rolledSuccess(m), "…and is stable");
  // signed-in charter mirror: app_charter_resolve's draws are indexed off the
  // (id, startedAt) seed — destroy at i*4+1, impound at i*4+2 per hull
  c.Cloud = { shipRpcReady: () => true };
  c.Fleet = { ship: () => null };
  const ch = { id: "ch9", startedAt: 1700000000000, shipUids: ["a", "b"],
    destroyChance: 0.5, impoundChance: 0.5, impound: true };
  const cseed = c.Market._seed(["charter", "ch9", "1700000000000"]);
  let clean = true;
  for (let i = 1; i <= 2 && clean; i++) {
    if (c.Market._u01(cseed, i * 4 + 1) < 0.5) clean = false;
    else if (c.Market._u01(cseed, i * 4 + 2) < 0.5) clean = false;
  }
  assert.strictEqual(c.Charters.predictClean(ch), clean, "predictClean mirrors the charter resolve draws");
  assert.strictEqual(c.Charters.predictClean(ch), c.Charters.predictClean(ch), "…and is stable");
}

console.log("check_voyage: all good ✓");
