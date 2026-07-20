#!/usr/bin/env node
/* check_expeditions.js — runnable check for the anomaly-survey system.
   Loads store/data/expeditions into a vm sandbox with the neighbouring modules
   stubbed, then asserts distance/duration, dispatch gating, each outcome
   branch (forced via _roll), and the offline resolve/cooldown flow.
   Run:  node tools/check_expeditions.js                                        */
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console });
ctx.window = ctx;
for (const f of ["store.js", "data.js", "expeditions.js"])
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });

const { Expeditions, EXPEDCFG, Util } = ctx;

// ---- stub the neighbours Expeditions touches ------------------------------
const systems = {
  here:  { id: "here",  name: "Home",  tradeable: true,  pos: { x: 0.5,  y: 0.5 } },
  near1: { id: "near1", name: "Near",  tradeable: false, pos: { x: 0.55, y: 0.5 } }, // dist 0.05
  far1:  { id: "far1",  name: "Far",   tradeable: false, pos: { x: 0.95, y: 0.5 } }, // dist 0.45
};
ctx.Galaxy = {
  get: id => systems[id],
  signatureCommodity: () => ({ id: "ore", name: "Ore", cat: "mineral" }),
  fireLocalEvent: (...a) => { ctx.__seam = a; },
};
ctx.Fleet = {
  ship(uid) { return ctx.Game.state.ships.find(s => s.uid === uid); },
  stats(sh) { return { speed: sh.speed || 1 }; },
  addDamage(sh, frac) { sh.dmg = (sh.dmg || 0) + frac; },
};
ctx.Items = { gen: o => ({ uid: "it1", name: "Test Widget", bias: o && o.bias }) };
ctx.Bazaar = { inventoryUsed: () => ctx.__invUsed || 0, capacity: () => 6 };
ctx.Incidents = { apply: eff => { ctx.__applied = eff; return "applied"; } };
ctx.Economy = { refreshNetWorth() {}, checkAchievements() {} };
ctx.Rep = { factionForCategory: () => "mining_combine" };
ctx.FACTIONS = { mining_combine: { name: "Mining Combine" } };

const freshState = () => ({ seq: 1, credits: 1000, ships: [], reports: [], expeditions: [], surveyed: {}, currentSystem: "here", items: {} });
const addShip = (uid = "s1") => { const sh = { uid, name: uid, status: "idle", speed: 1, mercenary: false }; ctx.Game.state.ships.push(sh); return sh; };
const pin = v => vm.runInContext(`Math.random = () => ${v}`, ctx);

// 1) distance / danger bands
ctx.Game = { state: freshState() };
assert(Math.abs(Expeditions.distanceTo("near1") - 0.05) < 1e-6, "near distance");
assert(!Expeditions.isFar("near1") && Expeditions.isFar("far1"), "far/near banding");
assert(Expeditions.danger("far1") > Expeditions.danger("near1"), "farther = more dangerous");

// 2) duration scales with distance and honours the floor
const dNear = Expeditions.durationFor("near1", "s1"), dFar = Expeditions.durationFor("far1", "s1");
assert(dFar > dNear && dNear >= EXPEDCFG.minMs, "duration scales, floored");

// 3) dispatch gating
ctx.Game = { state: freshState() }; addShip();
assert(!Expeditions.canSurvey("here").ok, "can't survey a trade hub");
assert(Expeditions.canSurvey("near1").ok, "fresh outpost is surveyable");
const bad = Expeditions.start("near1", "nope");
assert(!bad.ok, "needs a real idle ship");
const r0 = Expeditions.start("near1", "s1");
assert(r0.ok && ctx.Fleet.ship("s1").status === "surveying" && Expeditions.list().length === 1, "dispatch ties up the ship");
assert(!Expeditions.canSurvey("near1").ok, "can't double-survey the same system");
assert(!Expeditions.start("far1", "s1").ok, "a surveying ship isn't idle");

// helper: run one matured survey with a forced outcome, return the report
function runOutcome(kind, sysId = "far1", prep = () => {}) {
  ctx.Game = { state: freshState() }; addShip();
  prep();
  Expeditions.start(sysId, "s1");
  const exp = Expeditions.list()[0];
  exp.startedAt = Date.now() - exp.etaMs - 1;   // mature it
  Expeditions._roll = () => kind;               // force the branch
  const out = Expeditions.resolve(Date.now());
  return out[0];
}

// 4) each outcome branch
let rep = runOutcome("gear");
assert(rep.items.length === 1 && ctx.Game.state.items.it1 && ctx.Fleet.ship("s1").status === "idle", "gear: item banked, ship home");
assert(rep.items[0].bias > 0, "gear rarity bias scales with danger");

rep = runOutcome("gear", "far1", () => { ctx.__invUsed = 6; });   // full hold
assert(rep.items.length === 0 && /hold was full/.test(rep.summary), "gear: full hold drops the find");
ctx.__invUsed = 0;

ctx.__seam = null;
rep = runOutcome("seam");
assert(ctx.__seam && ctx.__seam[1] === "far1" && /seam|shortfall/i.test(rep.summary), "seam: fires a targeted local event");

rep = runOutcome("credits");
assert(rep.credits >= EXPEDCFG.creditsBy.far[0] && ctx.Game.state.credits === 1000 + rep.credits, "credits: windfall banked and reported accurately");

ctx.__applied = null;
rep = runOutcome("faction");
assert(ctx.__applied && ctx.__applied.rep && /standing \+/.test(rep.summary), "faction: rep applied via Incidents.apply");

pin(0.99);   // high roll → hazard not fatal
rep = runOutcome("hazard");
assert(rep.success && rep.damaged.length === 1 && ctx.Fleet.ship("s1").dmg > 0, "hazard: non-fatal damages the hull");

pin(0);      // zero roll → hazard fatal
rep = runOutcome("hazard");
assert(!rep.success && rep.lost.length === 1 && !ctx.Game.state.ships.some(s => s.uid === "s1"), "hazard: fatal removes the ship");

rep = runOutcome("dry");
assert(rep.success && rep.items.length === 0 && ctx.Fleet.ship("s1").status === "idle", "dry: nothing found, ship home");

// 5) resolve orchestration: report banked, expedition cleared, cooldown set, no early resolve
ctx.Game = { state: freshState() }; addShip();
Expeditions.start("near1", "s1");
Expeditions._roll = () => "dry";
assert(Expeditions.resolve(Date.now()).length === 0 && Expeditions.list().length === 1, "unmatured survey is left running");
Expeditions.list()[0].startedAt = Date.now() - dNear - 1;
Expeditions.resolve(Date.now());
assert(ctx.Game.state.reports.length === 1 && Expeditions.list().length === 0, "matured survey reports and clears");
assert(Expeditions.cooldownLeft("near1") > 0 && !Expeditions.canSurvey("near1").ok, "cooldown blocks immediate re-survey");

console.log("check_expeditions: all assertions passed ✔");
