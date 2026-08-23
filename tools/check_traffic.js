#!/usr/bin/env node
/* check_traffic.js — 5-day consumption pace + visible NPC cargo traffic.
   Confirms: a shelf with no resupply drains in ~5 days; relief convoys surge
   below 10% and brake on glut; Traffic.flights is a deterministic, finite view
   that rides the Voyages marker pipeline. Run: node tools/check_traffic.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout });
ctx.window = ctx;
let T = 1_720_000_000_000;
ctx.Date = { now: () => T };
ctx.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

for (const f of ["store.js", "data.js", "flavor.js", "market.js", "galaxy.js", "lanes.js", "stock.js", "stations.js", "voyage.js", "traffic.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}
const { Market, Galaxy, Lanes, Stock, Stations, Traffic, Voyages, STOCKCFG, TRAFFICCFG } = ctx;
ctx.Game = { state: { settings: {} } };   // Voyages.s() guard
Market.init(); Galaxy.build(); Lanes.build(); Stock.init(T); Stations.ensure();
const step = () => { T += STOCKCFG.tickMs; return Stock.tickHour(Math.floor(T / STOCKCFG.tickMs)); };

// ---- consumption pace: full shelf → empty in ~drainHours with no resupply --
{
  const put = Stock.put.bind(Stock);
  Stock.put = () => 0;                       // no convoys land
  const sid = "belt", cid = "foodstuffs";    // pop 1.0 × agri cat 1.0 — the nominal case
  Stock.units[sid][cid] = Stock.baseline(sid, cid);
  let hrs = 0;
  while (Stock.available(sid, cid) > 0 && hrs < 24 * 20) { step(); hrs++; }
  const days = hrs / 24;
  assert.ok(days > 4 && days < 6.5, `no-resupply drain should be ~5 days, got ${days.toFixed(1)}`);
  Stock.put = put;
}

// ---- convoy load factor: surge under 10%, brake on glut --------------------
{
  const sid = "belt", cid = "foodstuffs";
  Stock.units[sid][cid] = Math.floor(Stock.baseline(sid, cid) * 0.05);
  assert.ok(Stock.npcOutputMult(sid, cid) > STOCKCFG.npcOutputMultMax,
    "sub-10% shelf must surge past the plain boost cap");
  Stock.units[sid][cid] = Stock.baseline(sid, cid) * 2;
  assert.ok(Stock.npcOutputMult(sid, cid) < 1, "glutted shelf must brake below 1");
  Stock.units[sid][cid] = Stock.baseline(sid, cid);
}

// ---- 30-day zero-player equilibrium still lives ----------------------------
for (let h = 0; h < 30 * 24; h++) step();
const health = Stock.health();
for (const [sid, h] of Object.entries(health)) {
  assert.ok(h.avgRatio > 0.35 && h.avgRatio < 2.6, `${sid} avgRatio out of band: ${h.avgRatio}`);
  assert.ok(h.empty < 5, `${sid} too many empty shelves: ${h.empty}`);
  assert.ok(h.sentiment >= 25, `${sid} sentiment collapsed: ${h.sentiment}`);
}

// ---- visible traffic: deterministic, finite, manifests ≤ manifestSize ------
const fl = Traffic.flights(T);
const freighters = fl.filter(v => v.kind === "freighter");
const traders = fl.filter(v => v.kind === "trader");
assert.ok(freighters.length >= 20, `expected a busy sky, got ${freighters.length} freighters`);
assert.ok(freighters.length <= Stations.list().length, "at most one freighter per station");
assert.ok(traders.length >= 1, "some traders in flight");
for (const v of fl) {
  assert.ok(Number.isFinite(v.at.x) && Number.isFinite(v.at.y), `bad coords on ${v.id}`);
  assert.ok(v.name && typeof v.name === "string", `unnamed ship ${v.id}`);
  assert.ok((v.manifest || []).length <= TRAFFICCFG.manifestSize, `oversized manifest on ${v.id}`);
}
const fl2 = Traffic.flights(T);
assert.deepStrictEqual(fl2.map(v => [v.id, v.at.x, v.at.y]), fl.map(v => [v.id, v.at.x, v.at.y]),
  "flights must be a pure function of the clock");

// rides the voyage pipeline into both views
assert.ok(Voyages.markers(T).some(v => v.npc), "markers() must include NPC traffic");

// surge is visible: crash a sector's shelf, relief traders appear
const base2 = TRAFFICCFG.tradersPerSector;
const beforeN = Traffic.traders(T).filter(v => v.plan.legs && v.id.includes(":green:")).length;
for (const c of Stock.tradeable()) Stock.units.green[c.id] = 0;
const afterN = Traffic.traders(T).filter(v => v.id.includes(":green:")).length;
assert.ok(afterN > Math.min(beforeN, base2), `relief traders should surge into a starving sector (${beforeN} → ${afterN})`);

console.log(`OK check_traffic  (freighters=${freighters.length} traders=${traders.length})`);
