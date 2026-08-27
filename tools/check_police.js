#!/usr/bin/env node
/* check_police.js — the law's response (docs/SPACE_INTERACTIVITY.md §5.2,
   built form). The load-bearing claims: precincts are DERIVED from the same
   security bands the chart paints (never authored); patrols are deterministic
   seeded flight plans that always fly in pairs and only where the law lives;
   the chase is a pure function of the op so offline equals online; being
   caught costs the stolen cargo (recovered to the shelf it was bound for)
   AND the raiding hull itself — destroyed with all hands, filed as a wipe —
   while banked stock and credits are still never touched;
   destroying police is the worst crime on the books and draws a heavier wave,
   capped; the police-only item comes from a broken pair and from nowhere
   else; and every fought wave files a mission-shaped report BattleView can
   replay, fielding police hulls in pairs.
   Run: node tools/check_police.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const FILES = ["store.js", "data.js", "flavor.js", "market.js", "galaxy.js", "lanes.js",
  "security.js", "pois.js", "stock.js", "stations.js", "reputation.js", "crime.js",
  "fleet.js", "charters.js", "voyage.js", "raiders.js", "traffic.js", "items.js",
  "combat.js", "piracy.js", "police.js"];
const T0 = 1_720_000_000_000;
const boot = () => {
  const ctx = vm.createContext({ console, Math, Date, setTimeout, clearTimeout });
  ctx.window = ctx;
  ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  for (const f of FILES) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
  }
  ctx.Game = { state: {
    seq: 1, ships: [], positions: {}, avgCost: {}, credits: 0, reputation: {},
    currentSystem: "navos", mainShip: { type: "pinnace" }, settings: {},
    items: {}, extractors: {}, industries: [], mining: [], piracy: [], reports: [],
  }, timeScale: 1, requestSave() {} };
  ctx.Market.init(); ctx.Galaxy.build(); ctx.Lanes.build(); ctx.Stock.init(T0); ctx.Stations.ensure();
  return ctx;
};

// ---- precincts sit at the capitals, and only where the law runs ------------
{
  const c = boot();
  const seats = c.Galaxy.list.filter(s => c.Police.hasPrecinct(s.id));
  assert.ok(seats.length > 0, "somewhere the Senate writ runs");
  for (const s of seats) {
    assert.ok(s.capital, `${s.id} is a sector capital`);
    assert.ok(c.Security.score(s.id) >= c.POLICECFG.precinctMinScore, "…where the law actually runs");
  }
  // One per sector at most — the seat of that sector's law, not a scattering.
  const bySector = {};
  for (const s of seats) bySector[s.sectorId] = (bySector[s.sectorId] || 0) + 1;
  for (const [sid, n] of Object.entries(bySector)) assert.strictEqual(n, 1, `${sid} has one seat`);
  // Every sector but the Sprawl polices itself — the coverage the band rule
  // never gave (it put 12 of 13 precincts in the Core alone).
  const covered = c.Galaxy.sectors.filter(sec => c.Police.hasPrecinct(sec.capital));
  assert.ok(covered.length >= c.Galaxy.sectors.length - 1,
    `every sector but the Sprawl has a seat (${covered.length}/${c.Galaxy.sectors.length})`);
  // §5.4: the Syndicate is the law in the Sprawl — no Senate station there.
  const sprawl = c.Galaxy.sector("sprawl");
  for (const id of sprawl.systems)
    assert.ok(!c.Police.hasPrecinct(id), "no precinct anywhere in the Sprawl");
  // A plain high-scoring system is NOT a seat — that was the old rule's bug.
  const inner = c.Galaxy.list.find(s => !s.capital && c.Security.bandOf(s.id).id === "policed");
  assert.ok(inner && !c.Police.hasPrecinct(inner.id),
    "a policed non-capital system hosts no precinct of its own");
}

// ---- patrols: seeded pairs, only where the law lives -----------------------
{
  const c = boot();
  // Loops are staggered; scan a few minutes so at least one pair is mid-sweep.
  let flights = [];
  for (let m = 0; m < 60 && !flights.length; m++) flights = c.Police.patrols(T0 + m * 60000);
  assert.ok(flights.length > 0, "patrols fly");
  const t = T0 + 7 * 60000;
  const a = c.Police.patrols(t), b = c.Police.patrols(t);
  assert.strictEqual(JSON.stringify(a.map(v => [v.id, v.at && v.at.p])),
    JSON.stringify(b.map(v => [v.id, v.at && v.at.p])), "a pure view of the clock");
  const pre = c.Police._precincts(t);
  for (const v of a.length ? a : flights) {
    assert.ok(v.police && v.pair && v.npc && v.kind === "police", "flagged as a police pair");
    assert.strictEqual(v.manifest.length, 0, "carrying nothing to steal");
    const secId = v.id.split(":")[2];
    assert.ok(pre[secId], "…and only sectors with a precinct fly one");
    const sec = c.Galaxy.sector(secId);
    for (const leg of v.plan.legs) assert.ok(sec.systems.includes(leg), "the sweep stays in-sector");
  }
  assert.ok(!Object.keys(pre).includes("sprawl"), "the Sprawl polices nobody");
  // The intercept card offers no verb on a patrol.
  const v = (a.length ? a : flights)[0];
  const lawless = c.Galaxy.list.find(s => c.Security.bandOf(s.id).id === "lawless");
  assert.strictEqual(c.Piracy.verbs(v, lawless.id).length, 0, "no verbs on the law");
}

// ---- patrols reach the galaxy chart, and the Law layer can hide them -------
// The chart is SVG + CSS, so what this can pin without a DOM is the contract
// between them: patrols ride the same markers() pipeline the haulers do, and
// the layer id the CSS keys on exists in both files.
{
  const c = boot();
  let t = T0, marks = [];
  for (let m = 0; m < 60 && !marks.some(v => v.police); m++) {
    t = T0 + m * 60000;
    marks = c.Voyages.markers(t);
  }
  const pol = marks.filter(v => v.police);
  assert.ok(pol.length > 0, "patrols are drawn on the galaxy chart, like the haulers");
  for (const v of pol) {
    assert.ok(v.at && Number.isFinite(v.at.x) && Number.isFinite(v.at.y), "…with a real chart position");
    assert.ok(v.name, "…and a name over the hull");
  }
  const sm = fs.readFileSync(path.join(__dirname, "../js/starmap.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../css/style.css"), "utf8");
  assert.ok(/\{ id: "law"/.test(sm), "the chart offers a Law layer");
  assert.ok(/case "law": return/.test(sm), "…which carries its own legend key");
  assert.ok(/v\.police \? "voy-law"/.test(sm), "patrol markers are tagged for that layer");
  assert.ok(/"node-precinct"/.test(sm) && /Police\.hasPrecinct\(sys\.id\)/.test(sm),
    "…and a precinct badge is drawn on the systems that seat one");
  assert.ok(/\.lay-off-law \.voy-law/.test(css) && /\.lay-off-law[^{]*\.node-precinct/.test(css),
    "switching the layer off hides patrols AND precincts");
}

// ---- the response gate scales with the law ---------------------------------
{
  const c = boot();
  assert.strictEqual(c.Police.responseChance(0), 0, "truly lawless space answers to nobody");
  assert.ok(c.Police.responseChance(0.9) > c.Police.responseChance(0.3), "more law, more response");
  assert.ok(c.Police.responseChance(1) <= c.POLICECFG.responseClamp[1], "never a certainty");
  assert.ok(c.Police.pairScoreAt(0.7, 1) > c.Police.pairScoreAt(0.7, 0), "each wave comes heavier");
}

// A crafted robbed op + hull, for driving pursue() directly.
const armed = (c, type = "corvette") => {
  const sh = c.Fleet.makeShip(type); c.Game.state.ships.push(sh);
  return sh;
};
const robbedOp = (c, law, loot = { foodstuffs: 10 }) => ({
  id: "prT", verb: "rob", sysId: "navos", toSys: "navos", law,
  loot: JSON.parse(JSON.stringify(loot)),
});

// ---- caught: the cargo is recovered and the hull is lost -------------------
{
  const c = boot();
  c.POLICECFG.destroyClamp = [0, 0];    // the pair cannot be broken
  c.POLICECFG.catchClamp = [1, 1];      // and always runs you down
  c.POLICECFG.responseClamp = [1, 1];   // response is certain
  const sh = armed(c);
  const op = robbedOp(c, 0.8);
  const sid = c.Stock.sectorOf(op.toSys);
  const before = c.Stock.available(sid, "foodstuffs");
  const crime0 = c.Crime.value(), credits0 = c.Game.state.credits;
  c.Game.state.positions.foodstuffs = 50;         // banked stock, untouchable
  const out = c.Police.pursue(op, sh, T0);
  assert.ok(out && out.caught && !out.escaped, "run down");
  assert.strictEqual(op.loot, null, "the stolen cargo is gone");
  assert.strictEqual(out.seized, 10, "…all of it");
  assert.strictEqual(c.Stock.available(sid, "foodstuffs"), before + 10,
    "recovered to the shelf the delivery was bound for");
  assert.strictEqual(c.Game.state.positions.foodstuffs, 50, "banked stock never touched");
  assert.strictEqual(c.Game.state.credits, credits0, "credits never touched");
  assert.strictEqual(c.Crime.value(), crime0, "being caught adds no charge — the rob already did");
  assert.ok(out.lost && out.lost.uid === sh.uid && out.lost.name === sh.name,
    "the hull is lost with all hands");
  assert.ok(!c.Game.state.ships.includes(sh), "…and gone from the fleet");
  // The fight is on the record and watchable, fielding a pair.
  const rep = c.Game.state.reports.find(r => r.uid === out.report);
  assert.ok(rep && !rep.success && rep.faction === "police", "a failed-escape report is filed");
  assert.ok(rep.wipe && rep.lost.length === 1 && rep.lost[0].uid === sh.uid,
    "…as a wipe, naming the lost hull");
  assert.ok(c.Combat.replayable(rep), "…and BattleView can play it");
  const script = c.Combat.script(rep, rep.roster);
  assert.strictEqual(script.ships.filter(s => s.side === "enemy").length, 2, "the first wave is one pair");
  const names = new Set(c.ENEMY_CATALOG.police.map(e => e.name));
  for (const s of script.ships) if (s.side === "enemy") assert.ok(names.has(s.name), "police hulls on the field");
}

// ---- destroyed: the worst crime on the books, escalating, capped -----------
{
  const c = boot();
  c.POLICECFG.destroyClamp = [1, 1];    // every wave is broken
  c.POLICECFG.responseClamp = [1, 1];
  c.POLICECFG.itemChance = 1;           // salvage is certain, for the test
  const sh = armed(c, "cruiser");
  const op = robbedOp(c, 0.8);
  const crime0 = c.Crime.value();
  const out = c.Police.pursue(op, sh, T0);
  assert.strictEqual(out.destroyed, c.POLICECFG.maxWaves, "every wave came, every wave broke");
  assert.strictEqual(out.waves, c.POLICECFG.maxWaves, "…and then the trail went cold");
  assert.ok(out.escaped && !out.caught, "the loot came home");
  assert.deepStrictEqual(op.loot, { foodstuffs: 10 }, "untouched");
  assert.strictEqual(c.Crime.value(), crime0 + c.CRIMECFG.gain.police * c.POLICECFG.maxWaves,
    "each broken pair is charged");
  // The police-only item: minted once, from POLICE_ITEM's fixed shape.
  const items = Object.values(c.Game.state.items);
  assert.strictEqual(items.length, 1, "one salvage per chase, however many pairs broke");
  assert.strictEqual(items[0].name, c.POLICE_ITEM.name, "…and it is the enforcement kit");
  assert.ok(items[0].primary.amount > 0.39, "stronger than anything Items.gen can roll");
  assert.ok(items[0].value > 0, "priced by the ordinary item math");
  // One report per fought wave, reinforcements visible in each.
  const reps = c.Game.state.reports.filter(r => r.faction === "police");
  assert.strictEqual(reps.length, c.POLICECFG.maxWaves, "every wave is on the record");
  assert.deepStrictEqual(reps.map(r => r.enemyCount).sort(), [2, 4, 6], "pairs, reinforced per wave");
}

// ---- pure: the same op meets the same fate in any boot ---------------------
{
  const one = boot(), two = boot();
  for (const c of [one, two]) { c.POLICECFG.responseClamp = [1, 1]; }
  const o1 = one.Police.pursue(robbedOp(one, 0.7), armed(one), T0);
  const o2 = two.Police.pursue(robbedOp(two, 0.7), armed(two), T0);
  assert.strictEqual(JSON.stringify([o1.waves, o1.destroyed, o1.caught, o1.escaped, o1.seized, o1.crime]),
    JSON.stringify([o2.waves, o2.destroyed, o2.caught, o2.escaped, o2.seized, o2.crime]),
    "pursue is a pure function of the op");
}
{
  const c = boot();
  assert.strictEqual(c.Police.pursue(robbedOp(c, 0), armed(c), T0), null, "lawless space answers to nobody");
}

// ---- through the whole piracy loop: offline == online ----------------------
{
  const setup = c => {
    c.POLICECFG.responseClamp = [1, 1];
    let v = null, t = T0;
    for (let m = 0; m < 240 && !v; m++) {
      t = T0 + m * 60000;
      v = c.Traffic.flights(t).find(x => x.kind === "freighter" && !x.raided
        && x.manifest.length && c.Piracy.landsAt(x) - t > 5 * 60000
        && c.Security.bandOf(x.plan.legs[0]).id !== "policed");
    }
    assert.ok(v, "an interceptable freighter exists");
    const sysId = v.plan.legs[0];
    c.Game.state.currentSystem = sysId;
    const sh = armed(c, "cruiser");
    const r = c.Piracy.start(v, "rob", sh.uid, sysId, t);
    assert.ok(r.ok, r.msg);
    r.op.chance = 1;
    return { op: r.op, sh };
  };
  const chunk = boot(), drip = boot();
  const a = setup(chunk), b = setup(drip);
  assert.strictEqual(a.op.id, b.op.id, "same op, same seed");
  assert.ok(a.op.law > 0, "the law at the scene rides the op");
  const madeA = chunk.Piracy.resolve(chunk.Piracy.landAt(a.op) + 1);
  drip.Piracy.resolve(b.op.resolveAt + 1);              // mid-boarding: nothing settles
  drip.Piracy.resolve(drip.Piracy.settleAt(b.op) + 1);  // the staged clock ran — settle
  drip.Piracy.resolve(drip.Piracy.landAt(b.op) + 1);    // the hull lands (if it can)
  assert.deepStrictEqual(chunk.Game.state.positions, drip.Game.state.positions, "same outcome either way");
  assert.strictEqual(chunk.Crime.value(), drip.Crime.value(), "same record");
  assert.ok(Math.abs(a.sh.dmg - b.sh.dmg) < 1e-9, "same wear");
  const p = madeA.find(m => m.piracy).piracy;
  assert.ok(p.chase, "the chase is part of the verdict");
  if (p.chase.caught) {
    assert.strictEqual(Object.keys(chunk.Game.state.positions).length, 0, "a seized haul never banks");
    assert.strictEqual(chunk.Piracy.hotQty(a.op.manifest[0]), 0, "…and never goes hot");
    assert.ok(!chunk.Game.state.ships.includes(a.sh), "a run-down hull is lost, not landed");
  } else {
    assert.strictEqual(a.sh.status, "idle", "an uncaught hull comes home");
  }
}

// ---- the duel on the chart: stages, and who is left standing ---------------
// The visual is a pure view of the derived stage clock, so it can be driven
// headlessly: sample Voyages.active() at each stage and assert what is drawn.
{
  const c = boot();
  c.POLICECFG.responseClamp = [1, 1];      // the law always answers
  c.POLICECFG.destroyClamp = [0, 0];       // …and can't be broken
  c.POLICECFG.catchClamp = [1, 1];         // …so it runs the hull down
  // Dispatch from a NEIGHBOUR of the mark, so there is a real outbound leg to
  // draw (a same-system intercept has no transit and is skipped by design).
  let v = null, t = T0, sysId = null, from = null;
  for (let m = 0; m < 240 && !v; m++) {
    t = T0 + m * 60000;
    for (const x of c.Traffic.flights(t)) {
      if (x.kind !== "freighter" || x.raided || !x.manifest.length) continue;
      if (c.Piracy.landsAt(x) - t < 12 * 60000) continue;
      const at = x.plan.legs[0];
      if (c.Security.bandOf(at).id === "policed") continue;
      const nb = (c.Lanes.adj[at] || []).map(e => e.to).find(id => c.Galaxy.get(id));
      if (!nb) continue;
      v = x; sysId = at; from = nb; break;
    }
  }
  assert.ok(v, "an interceptable freighter with a neighbouring staging system exists");
  c.Game.state.currentSystem = from;
  const sh = armed(c, "corvette");
  const r = c.Piracy.start(v, "rob", sh.uid, sysId, t);
  assert.ok(r.ok, r.msg);
  r.op.chance = 1;                          // force the rob so a chase forms
  const op = r.op;
  const ids = at => new Set(c.Voyages.active(at).map(m => m.id));
  const mark = (at, id) => c.Voyages.active(at).find(m => m.id === id);

  // Stage order is strictly increasing, and the run home now departs only
  // after the duel is over (Piracy.landAt).
  assert.ok(op.resolveAt < c.Piracy.robEndAt(op), "boarding follows the approach");
  assert.ok(c.Piracy.robEndAt(op) < c.Piracy.duelAt(op), "the law needs arriveMs to close");
  assert.ok(c.Piracy.duelAt(op) < c.Piracy.settleAt(op), "the duel takes the wave windows");
  assert.ok(c.Piracy.landAt(op) > c.Piracy.settleAt(op), "the run home departs after the settle");

  // Outbound.
  assert.ok(ids(op.startedAt + 1000).has("pr:" + op.id), "the raider flies out on the chart");
  // Boarding: alongside the CONTACT, with a real chart position (a marker
  // with no `at` falls out of markers() and the hull vanishes mid-op — the
  // original sin this block guards against).
  const board = mark(op.resolveAt + 1000, "pr:" + op.id);
  assert.ok(board && board.engaged, "…and engages at the mark to board");
  assert.ok(board.at && Number.isFinite(board.at.x) && Number.isFinite(board.at.y),
    "…with a real chart position, so it never vanishes mid-op");
  const contact = c.Piracy.contactAt(op, op.resolveAt + 1000);
  if (contact) assert.ok(Math.hypot(board.at.x - contact.x, board.at.y - contact.y) < 1e-9,
    "…following the hauler itself, not parked at the star");
  assert.ok(!ids(op.resolveAt + 1000).has("pr:duel:" + op.id), "no duel while boarding");
  // Holding (patrol closing): still drawn, pinned where the hauler broke away.
  const holdT = c.Piracy.robEndAt(op) + 1000;
  if (holdT < c.Piracy.duelAt(op)) {
    const hold = mark(holdT, "pr:" + op.id);
    assert.ok(hold && hold.at, "the hull is still on the chart while the patrol closes");
    const broke = c.Piracy.contactAt(op, c.Piracy.robEndAt(op));
    if (broke) assert.ok(Math.hypot(hold.at.x - broke.x, hold.at.y - broke.y) < 1e-9,
      "…holding where the boarding happened");
  }
  // The law inbound — ALWAYS seen arriving when a chase formed, whatever the
  // sector's precinct geography (this went missing whenever the robbery
  // happened at the precinct capital itself, which read as "the police are
  // gone"). It closes on the duel's anchor as the window runs.
  const early = mark(c.Piracy.robEndAt(op) + 1000, "pr:pol:" + op.id);
  const late = mark(c.Piracy.duelAt(op) - 1000, "pr:pol:" + op.id);
  assert.ok(early && early.police && early.at, "the response pair is seen arriving once the boarding ends");
  assert.ok(late && late.at, "…and is still inbound just before the duel opens");
  const anchor0 = c.Piracy.contactAt(op, c.Piracy.robEndAt(op)) || c.Galaxy.get(op.sysId).pos;
  const dEarly = Math.hypot(early.at.x - anchor0.x, early.at.y - anchor0.y);
  const dLate = Math.hypot(late.at.x - anchor0.x, late.at.y - anchor0.y);
  assert.ok(dLate <= dEarly + 1e-9, "…closing on the scene, never drifting away");
  const mid = c.Piracy.duelAt(op) + 5000;
  const you = mark(mid, "pr:duel:" + op.id), law = mark(mid, "pr:duel:pol:" + op.id);
  assert.ok(you && law, "the duel draws BOTH hulls");
  assert.ok(you.duel && law.duel && law.police, "…flagged as a duel, the law as police");
  const sep = Math.hypot(you.at.x - law.at.x, you.at.y - law.at.y);
  assert.ok(Math.abs(sep - 2 * c.POLICECFG.duelRadius) < 1e-9, "…on opposite arcs of one circle");
  // Circling: the pair moves, but stays on the circle (holding station).
  const later = c.Piracy.duelAt(op) + 5000 + c.POLICECFG.duelTurnMs / 4;
  const you2 = mark(later, "pr:duel:" + op.id);
  assert.ok(Math.hypot(you2.at.x - you.at.x, you2.at.y - you.at.y) > 1e-6, "the hulls circle");
  const anchor = c.Piracy.contactAt(op, c.Piracy.robEndAt(op)) || c.Galaxy.get(op.sysId).pos;
  for (const m of [you, law, you2]) {
    const rad = Math.hypot(m.at.x - anchor.x, m.at.y - anchor.y);
    assert.ok(Math.abs(rad - c.POLICECFG.duelRadius) < 1e-9, "…and never drift off the scene");
  }
  // The settle: this hull was run down, so it burns and never flies home.
  const boom = mark(c.Piracy.settleAt(op) + 500, "pr:boom:" + op.id);
  assert.ok(boom && boom.boom && boom.you, "the loser leaves a fireball");
  assert.ok(!ids(c.Piracy.settleAt(op) + 500).has("pr:" + op.id), "…and no hull flies home");
  const after = c.Piracy.settleAt(op) + c.POLICECFG.wreckMs + 1000;
  assert.ok(!ids(after).has("pr:boom:" + op.id), "the fireball burns out");
}

// ---- a survivor flies home, and the fireball is the PATROL's --------------
{
  const c = boot();
  c.POLICECFG.responseClamp = [1, 1];
  c.POLICECFG.destroyClamp = [1, 1];        // every pair breaks
  const sh = armed(c, "cruiser");
  const home = (c.Lanes.adj["navos"] || []).map(e => e.to).find(id => c.Galaxy.get(id));
  const op = { id: "prD", verb: "rob", shipUid: sh.uid, sysId: "navos", toSys: "navos",
    fromSys: home, law: 0.8, chance: 1, atk: 3000, cargo: 50, value: 500,
    kind: "freighter", manifest: ["foodstuffs"], name: "Mark",
    startedAt: T0, travelMs: 60000, resolveAt: T0 + 60000, returnAt: T0 + 120000,
    resolved: false };
  {
    assert.ok(home, "navos has a lane neighbour to stage from");
    c.Game.state.piracy = [op];
    c.Game.state.currentSystem = home;
    const pre = c.Piracy.preview(op);
    assert.ok(pre.chase && !pre.chase.caught, "the hull broke every wave");
    const boom = c.Voyages.active(c.Piracy.settleAt(op) + 500).find(m => m.id === "pr:boom:" + op.id);
    assert.ok(boom && !boom.you, "the PATROL is the wreck when the raider wins");
    const runner = c.Voyages.active(c.Piracy.settleAt(op) + 2000).find(m => m.id === "pr:" + op.id);
    assert.ok(runner && runner.plan, "…and the survivor flies home after the duel");
  }
}

// ---- the crime tag rides on every hull a baron has out ---------------------
{
  const c = boot();
  c.Game.state.crime = 0;
  assert.strictEqual(c.Crime.tag(), null, "a clean record flies no tag");
  c.Game.state.crime = c.CRIMECFG.watch;
  assert.strictEqual(c.Crime.tag().id, "watched", "the watch line tags Watchlisted");
  c.Game.state.crime = c.CRIMECFG.lockout;
  assert.strictEqual(c.Crime.tag().id, "barred", "…then Barred");
  c.Game.state.crime = c.CRIMECFG.criminal;
  assert.strictEqual(c.Crime.tag().id, "criminal", "…then Criminal");
  // And it reaches the markers active() produces.
  c.Game.state.travel = { from: "navos", to: c.Galaxy.list.find(x => x.id !== "navos").id,
    departedAt: T0, etaMs: 120000 };
  const flag = c.Voyages.active(T0 + 1000).find(m => m.kind === "flagship");
  if (flag) assert.strictEqual(flag.tag.id, "criminal", "the flagship flies the tag");
}

// ---- the manhunt: past the criminal line, the law takes you on the way OUT -
const mhOp = (c, shipUid, from) => ({
  id: "prM", verb: "rob", shipUid, sysId: "navos", toSys: "navos", fromSys: from,
  law: 0.8, chance: 1, atk: 400, cargo: 50, value: 500, kind: "freighter",
  manifest: ["foodstuffs"], name: "Mark", startedAt: T0, travelMs: 60000,
  resolveAt: T0 + 60000, returnAt: T0 + 120000, resolved: false,
});
{
  const c = boot();
  const sh = armed(c, "corvette");
  const from = (c.Lanes.adj["navos"] || []).map(e => e.to).find(id => c.Galaxy.get(id));
  const op = mhOp(c, sh.uid, from);
  // Under the line the law waits for a crime — no hunt at all.
  c.Game.state.crime = c.CRIMECFG.criminal - 1;
  assert.strictEqual(c.Piracy.manhunt(op), null, "under the criminal line, nobody is hunting");
  assert.strictEqual(c.Piracy.manhuntAt(op), Infinity, "…so there is no contact time");
  // At the line they come.
  c.POLICECFG.manhuntClamp = [1, 1];       // they always find the hull
  c.Game.state.crime = c.CRIMECFG.criminal;
  const mh = c.Piracy.manhunt(op);
  assert.ok(mh, "at the criminal line the hunt is on");
  assert.ok(mh.frac >= c.POLICECFG.manhuntAt[0] && mh.frac <= c.POLICECFG.manhuntAt[1],
    "…cutting in partway along the outbound leg");
  assert.ok(c.Piracy.manhuntAt(op) > op.startedAt && c.Piracy.manhuntEndAt(op) < op.resolveAt,
    "…and it is settled before the mark is ever reached");
  // Lying low calls them off, live — the gate is not stamped on the op.
  c.Game.state.crime = c.CRIMECFG.criminal - 1;
  assert.strictEqual(c.Piracy.manhunt(op), null, "dropping under the line calls them off mid-flight");
}

// Run down by a manhunt: the hull is destroyed before the rob ever happens.
{
  const c = boot();
  c.POLICECFG.manhuntClamp = [1, 1];
  c.POLICECFG.destroyClamp = [0, 0];       // the pair cannot be broken
  const sh = armed(c, "corvette");
  const from = (c.Lanes.adj["navos"] || []).map(e => e.to).find(id => c.Galaxy.get(id));
  const op = mhOp(c, sh.uid, from);
  c.Game.state.piracy = [op];
  c.Game.state.crime = c.CRIMECFG.criminal;
  sh.status = "raiding";
  const made = c.Piracy.resolve(c.Piracy.manhuntEndAt(op) + 1);
  assert.strictEqual(made.length, 1, "one verdict — the manhunt");
  const m = made[0].piracy.manhunt;
  assert.ok(m && m.caught && m.lost && m.lost.uid === sh.uid, "the hull was run down and lost");
  assert.ok(!c.Game.state.ships.includes(sh), "…and is gone from the fleet");
  assert.strictEqual(c.Game.state.piracy.length, 0, "the op dies with the ship");
  assert.strictEqual(Object.keys(c.Game.state.positions).length, 0, "the rob never happened — no loot");
  const rep = c.Game.state.reports.find(r => r.uid === m.report);
  assert.ok(rep && rep.wipe && !rep.success && rep.faction === "police", "filed as a police wipe");
  assert.ok(c.Combat.replayable(rep), "…and BattleView can play it");
}

// Shot their way clear: damaged, charged for the pair, and the run continues.
{
  const c = boot();
  c.POLICECFG.manhuntClamp = [1, 1];
  c.POLICECFG.destroyClamp = [1, 1];       // every pair breaks
  c.POLICECFG.responseClamp = [0, 0];      // no post-rob chase, to isolate this
  const sh = armed(c, "cruiser");
  const from = (c.Lanes.adj["navos"] || []).map(e => e.to).find(id => c.Galaxy.get(id));
  const op = mhOp(c, sh.uid, from);
  c.Game.state.piracy = [op];
  c.Game.state.crime = c.CRIMECFG.criminal;
  sh.status = "raiding";
  const crime0 = c.Crime.value();
  const made = c.Piracy.resolve(c.Piracy.manhuntEndAt(op) + 1);
  const m = made[0].piracy.manhunt;
  assert.ok(m && !m.caught && !m.lost, "the hull shot its way clear");
  assert.ok(c.Game.state.ships.includes(sh), "…and survives");
  assert.ok(sh.dmg > 0, "…carrying a repair bill");
  assert.strictEqual(c.Crime.value(), crime0 + c.CRIMECFG.gain.police, "breaking a pair is charged");
  assert.strictEqual(c.Game.state.piracy.length, 1, "the run continues to the mark");
  assert.ok(op.mh, "…and the manhunt is once-gated");
  // It does not fire twice, however often the loop runs.
  const again = c.Piracy.resolve(c.Piracy.manhuntEndAt(op) + 2000);
  assert.ok(!again.some(x => x.piracy && x.piracy.manhunt), "a manhunt resolves exactly once");
}

// ---- the movie fields what the chart sold ----------------------------------
// A rob report plays the ACTUAL hauler — convoy role (it never shoots), never
// destroyed, and it runs for its jump in every outcome — plus its hired guns.
// A police wave plays a UNIFORM pair matched to the wave. Counts and sprites
// must agree with what the player saw outside the movie.
{
  const c = boot();
  const mk = (success, policeInbound) => ({
    uid: "prV" + (success ? "w" : "l") + "rob",
    title: "Intercept — Star Maw", type: "combat", success, ts: T0,
    faction: "free_trade", danger: "moderate", enemyCount: 3,
    hauler: { name: "Star Maw", kind: "freighter" }, policeInbound,
    credits: 0, items: [], lost: [], impounded: [],
    damaged: success ? [] : [{ uid: "s1", name: "Test Hull", pct: 8 }],
    roster: [{ uid: "s1", name: "Test Hull", type: "corvette" }],
  });
  for (const success of [true, false]) {
    const rep = mk(success, success);
    assert.ok(c.Combat.replayable(rep), "a rob report is replayable");
    const script = c.Combat.script(rep, rep.roster);
    const foes = script.ships.filter(x => x.side === "enemy");
    assert.strictEqual(foes.length, 3, "the movie fields exactly the report's count");
    const hauler = foes.find(x => x.name === "Star Maw");
    assert.ok(hauler, "the hauler ITSELF is on the field");
    assert.strictEqual(hauler.sprite, "ship:freighter", "…wearing the chart's own hull");
    assert.strictEqual(hauler.role, "convoy", "…flying convoy");
    assert.ok(!hauler.deathT, "…and it is never destroyed — stripped, not sunk");
    assert.ok(hauler.jumpT, "…and it runs for its jump, win or lose");
    for (const e of foes.filter(x => x !== hauler))
      assert.ok(c.ENEMY_CATALOG.corporate.some(g => g.name === e.name && g.tier <= 1),
        "the guns are light hired security, not warships");
    // The hauler never fires: no weapon event originates from it.
    for (const ev of script.events) {
      if (["beam", "missile", "flak"].includes(ev.kind))
        assert.notStrictEqual(ev.from, hauler.id, "the hauler never shoots — its job is to run");
    }
  }
  // Police waves: uniform pairs, stepped by the wave.
  for (const wave of [0, 1, 2]) {
    const rep = {
      uid: "prVw" + wave, title: "Patrol response", type: "smuggle", success: false,
      ts: T0, faction: "police", police: true, wave,
      danger: ["moderate", "high", "extreme"][wave], enemyCount: 2 * (wave + 1),
      credits: 0, items: [], impounded: [], wipe: true,
      lost: [{ uid: "s1", name: "Test Hull" }], damaged: [],
      roster: [{ uid: "s1", name: "Test Hull", type: "corvette" }],
    };
    const script = c.Combat.script(rep, rep.roster);
    const foes = script.ships.filter(x => x.side === "enemy");
    assert.strictEqual(foes.length, 2 * (wave + 1), `wave ${wave} fields its pairs exactly`);
    const want = c.ENEMY_CATALOG.police[wave].name;
    for (const e of foes) assert.strictEqual(e.name, want,
      `wave ${wave} flies a UNIFORM ${want} formation — no mixed bag`);
  }
}

console.log("OK check_police");
