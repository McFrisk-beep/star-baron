#!/usr/bin/env node
/* check_police.js — the law's response (docs/SPACE_INTERACTIVITY.md §5.2,
   built form). The load-bearing claims: precincts are DERIVED from the same
   security bands the chart paints (never authored); patrols are deterministic
   seeded flight plans that always fly in pairs and only where the law lives;
   the chase is a pure function of the op so offline equals online; being
   caught costs exactly the stolen cargo (recovered to the shelf it was bound
   for) and a repair bill — never the hull, never banked stock, never credits;
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

// ---- caught: the cargo is recovered, and nothing worse ---------------------
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
  assert.ok(sh.dmg > 0 && sh.dmg <= c.POLICECFG.chaseDmg[1], `a repair bill, clamped (${sh.dmg})`);
  assert.ok(c.Game.state.ships.includes(sh), "the hull still exists");
  assert.notStrictEqual(sh.status, "impounded", "never impounded");
  // The fight is on the record and watchable, fielding a pair.
  const rep = c.Game.state.reports.find(r => r.uid === out.report);
  assert.ok(rep && !rep.success && rep.faction === "police", "a failed-escape report is filed");
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
  const madeA = chunk.Piracy.resolve(a.op.returnAt + 1);
  drip.Piracy.resolve(b.op.resolveAt + 1);
  drip.Piracy.resolve(b.op.returnAt + 1);
  assert.deepStrictEqual(chunk.Game.state.positions, drip.Game.state.positions, "same outcome either way");
  assert.strictEqual(chunk.Crime.value(), drip.Crime.value(), "same record");
  assert.ok(Math.abs(a.sh.dmg - b.sh.dmg) < 1e-9, "same wear");
  const p = madeA.find(m => m.piracy).piracy;
  assert.ok(p.chase, "the chase is part of the verdict");
  if (p.chase.caught) {
    assert.strictEqual(Object.keys(chunk.Game.state.positions).length, 0, "a seized haul never banks");
    assert.strictEqual(chunk.Piracy.hotQty(a.op.manifest[0]), 0, "…and never goes hot");
  }
  assert.strictEqual(a.sh.status, "idle", "the hull always comes home");
}

console.log("OK check_police");
