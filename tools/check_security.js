#!/usr/bin/env node
/* check_security.js — derived security bands + system faction allegiance
   (docs/SPACE_INTERACTIVITY.md §5.3). The claim under test is that a band is
   never authored content: it is sector floor + sector capital + station
   modules + Senate edicts + war, so **players change the security map by
   playing**. Fitting a Customs House must measurably lift a system for
   everyone; a Free Port must drop it. Also: faction allegiance is derived from
   the planets a system actually works (plus §5.4's rule that Syndic space
   answers to the Syndicate), deterministic, and covers every system.
   Run: node tools/check_security.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout });
ctx.window = ctx;
let T = 1_720_000_000_000;
ctx.Date = { now: () => T, parse: Date.parse };
ctx.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

for (const f of ["store.js", "data.js", "flavor.js", "market.js", "galaxy.js", "stock.js",
  "stations.js", "wars.js", "security.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}
const { Market, Galaxy, Stock, Stations, Security, Wars, SECURITYCFG, FACTIONS, Util } = ctx;
ctx.Game = { state: { seq: 1, settings: {}, newswire: [] }, requestSave() {} };
ctx.Rep = { get: () => 0, edgeForCategory: () => 0, onTrade() {} };
ctx.Fleet = { fleetValue: () => 0, dockTravelMs: () => 1000, mainDef: () => ({ travelSpeed: 1 }) };
Market.init(); Galaxy.build(); Stock.init(T); Stations.ensure();

// ---- every system lands somewhere sane ------------------------------------
{
  const seen = {};
  for (const sys of Galaxy.list) {
    const v = Security.score(sys.id);
    assert.ok(v >= 0 && v <= 1, `${sys.id}: score in range (${v})`);
    const band = Security.bandOf(sys.id);
    assert.ok(band && band.id && band.color && band.label, `${sys.id}: has a band`);
    seen[band.id] = (seen[band.id] || 0) + 1;
    assert.strictEqual(Security.score(sys.id), v, `${sys.id}: score is a pure read`);
  }
  // A map with one colour on it is not a map. Every band the legend advertises
  // has to be somewhere in the galaxy at a cold start.
  for (const b of SECURITYCFG.bands) assert.ok(seen[b.id] > 0, `band "${b.label}" exists somewhere (got ${seen[b.id] || 0})`);
}

// ---- the sectors rank the way the fiction says they do --------------------
{
  const sc = id => Security.sectorScore(id);
  assert.ok(sc("core") > sc("green"), "the Core Worlds outrank the Green Expanse");
  assert.ok(sc("green") > sc("forge"), "the Green Expanse outranks Forge Reach");
  assert.ok(sc("forge") > sc("sprawl"), "Forge Reach outranks the Sable Sprawl");
  assert.strictEqual(Security.sectorBand("core").id, "policed", "the Core is policed");
  assert.strictEqual(Security.sectorBand("sprawl").id, "lawless", "the Sprawl is lawless (§5.4)");
  // A capital is the seat of its sector's law.
  for (const sec of Galaxy.sectors) {
    const others = sec.systems.filter(id => id !== sec.capital);
    assert.ok(Security.score(sec.capital) > Security.score(others[0]),
      `${sec.name}: the capital outranks its hinterland`);
  }
}

// ---- players change the map by playing (§5.3, the load-bearing claim) -----
{
  const sys = Galaxy.list.find(s => !s.capital && s.sectorId === "forge");
  const st = Stations.get(sys.id);
  const before = Security.score(sys.id);
  const secBefore = Security.sectorScore("forge");

  st.modules.customs_house = 1;
  const withCustoms = Security.score(sys.id);
  assert.ok(withCustoms > before, `a Customs House lifts the system (${before.toFixed(3)} → ${withCustoms.toFixed(3)})`);
  assert.ok(Security.sectorScore("forge") > secBefore, "…and nudges the whole region, competitors included");
  assert.ok(Security.factors(sys.id).some(f => /Customs House/.test(f.label)),
    "…and says so in the derivation the tip shows");

  delete st.modules.customs_house;
  st.modules.free_port = 1;
  assert.ok(Security.score(sys.id) < before, "a Free Port drops it below where it started");
  st.modules.black_market = 1;
  assert.ok(Security.score(sys.id) < before, "a Black Market drops it further");
  delete st.modules.free_port; delete st.modules.black_market;
  assert.strictEqual(Security.score(sys.id), before, "removing the modules puts it back — nothing was stored");

  // A Sprawl system can be dragged either way across a band boundary.
  const sp = Galaxy.list.find(s => !s.capital && s.sectorId === "sprawl");
  const spSt = Stations.get(sp.id);
  assert.strictEqual(Security.bandOf(sp.id).id, "lawless", "Sprawl backwater starts lawless");
  spSt.modules.customs_house = 1;
  assert.notStrictEqual(Security.bandOf(sp.id).id, "lawless", "a Customs House pulls it out of lawless");
  delete spSt.modules.customs_house;
}

// ---- Senate edicts and wars move it, using the numbers that already exist --
{
  const sys = Galaxy.list.find(s => !s.capital && s.sectorId === "belt");
  const base = Security.score(sys.id);
  ctx.Senate = { routeSafetyAdd: () => 0.4 };      // Convoy Escort Mandate
  assert.ok(Security.score(sys.id) > base, "a Convoy Escort Mandate raises the band");
  ctx.Senate = { routeSafetyAdd: () => -0.4 };     // Lane Patrol Cuts
  assert.ok(Security.score(sys.id) < base, "Lane Patrol Cuts lower it");
  ctx.Senate = { routeSafetyAdd: () => 0 };
  assert.strictEqual(Security.score(sys.id), base, "…and it returns when the edict lapses");

  // Korrin Belt's specialty is mineral → the Mining Combine's domain.
  assert.strictEqual(Security.sectorFaction("belt"), "mining_combine", "the Belt is Combine country");
  ctx.Game.state.war = { id: "w", a: "mining_combine", b: "agri_collective", startedAt: T, endsAt: T + 3600000 };
  assert.ok(Security.score(sys.id) < base, "a war drags the law out of the belligerent's own space");
  assert.ok(Security.factors(sys.id).some(f => f.label === "faction war"), "…and the tip explains why");
  delete ctx.Game.state.war;
  assert.strictEqual(Security.score(sys.id), base, "…and it lifts when the war ends");
}

// ---- raid pressure rides the same number (one truth, not two) -------------
{
  const r = SECURITYCFG.raidMult;
  const core = Security.raidMult("navos"), sprawl = Security.raidMult("sable");
  assert.ok(core < sprawl, `policed space multiplies corsairs down, lawless up (${core.toFixed(2)} vs ${sprawl.toFixed(2)})`);
  for (const sys of Galaxy.list) {
    const m = Security.raidMult(sys.id);
    assert.ok(m >= Math.min(...r) - 1e-9 && m <= Math.max(...r) + 1e-9, `${sys.id}: raid multiplier inside the config band (${m})`);
  }
}

// ---- faction allegiance ---------------------------------------------------
{
  const tally = {};
  for (const sys of Galaxy.list) {
    const f = Galaxy.factionOf(sys.id);
    assert.ok(f && FACTIONS[f], `${sys.id}: has a faction (${f})`);
    assert.strictEqual(Galaxy.factionOf(sys.id), f, `${sys.id}: allegiance is stable`);
    assert.strictEqual(Galaxy.factionColor(sys.id), FACTIONS[f].color, `${sys.id}: colour matches the faction`);
    tally[f] = (tally[f] || 0) + 1;
  }
  // Four colours on the map, none of them a rounding error.
  for (const f of Object.keys(FACTIONS)) assert.ok(tally[f] >= 5, `${FACTIONS[f].name} holds a real share (${tally[f] || 0})`);
  // §5.4: the Syndicate is the law in Syndic space.
  for (const sys of Galaxy.list) {
    if (sys.race === "syndics") assert.strictEqual(Galaxy.factionOf(sys.id), "syndicate", `${sys.id}: syndic space is Syndicate space`);
  }
  const sprawl = Galaxy.sector("sprawl").systems;
  const synd = sprawl.filter(id => Galaxy.factionOf(id) === "syndicate").length;
  assert.ok(synd > sprawl.length / 2, `the Sable Sprawl reads Syndicate (${synd}/${sprawl.length})`);
  // Determinism across a rebuild — the same galaxy paints the same map.
  const snap = Galaxy.list.map(s => [s.id, Galaxy.factionOf(s.id)]);
  Galaxy.build();
  assert.deepStrictEqual(Galaxy.list.map(s => [s.id, Galaxy.factionOf(s.id)]), snap,
    "allegiance is a pure function of the seed");
}

console.log(`OK check_security  (${Galaxy.list.length} systems banded and flagged)`);
