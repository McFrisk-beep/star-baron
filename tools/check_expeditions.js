#!/usr/bin/env node
/* check_expeditions.js — runnable check for anomaly surveys.
   Matured surveys open a Dispatches debrief (SurveyStory) instead of auto-loot.
   Asserts distance/duration, dispatch gating, debrief stubs, choiceChance, leave
   payout via SurveyStory.applyOutcome, and the Phase 3 softIncomeLocal gate.
   Run:  node tools/check_expeditions.js                                        */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math });
ctx.window = ctx;
ctx.Date = Date;
for (const f of ["store.js", "data.js", "story.js", "survey-story.js", "expeditions.js"])
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });

const { Expeditions, EXPEDCFG, SurveyStory, Story, Util } = ctx;

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
  stats(sh) { return { speed: sh.speed || 1, scan: sh.scan || 0, endure: sh.endure || 0 }; },
  addDamage(sh, frac) { sh.dmg = (sh.dmg || 0) + frac; },
  mainBonus() { return 0; },
};
ctx.Items = { gen: o => ({ uid: "it1", name: "Test Widget", kind: (o && o.kind) || "engine", rarity: (o && o.rarity) || "common", bias: o && o.bias }) };
ctx.Bazaar = { inventoryUsed: () => ctx.__invUsed || 0, capacity: () => 6 };
ctx.Incidents = { apply: eff => { ctx.__applied = eff; return "applied"; } };
ctx.Economy = {
  netWorth: () => ctx.Game.state.credits, refreshNetWorth() {}, checkAchievements() {},
  softIncomeLocal() {
    if (!(ctx.Cloud && ctx.Cloud.authoritative && ctx.Cloud.authoritative())) return true;
    if (ctx.Cloud.pullReady) return false;
    if (ctx.Cloud.pullMissing) return true;
    return false;
  },
};
ctx.Rep = { factionForCategory: () => "mining_combine", change() {} };
ctx.FACTIONS = { mining_combine: { name: "Mining Combine" } };
ctx.Bus = { on() {}, emit() {} };
ctx.Senate = {
  travelSpeedMult: () => 1, salvageBonusAdd: () => 0, windfallSurtax: () => 0, routeSafetyAdd: () => 0,
  travelEdictNote: () => "", industryTaxLines: () => [],
};
// softIncomeLocal lives on Economy; stub Cloud so guest path stays local.
ctx.Cloud = { authoritative: () => false, pullReady: false, pullMissing: false };
ctx.Game = { timeScale: 1, state: null, requestSave() {} };

const freshState = () => ({
  seq: 1, credits: 1000, ships: [], reports: [], expeditions: [], surveyed: {},
  currentSystem: "here", items: {}, stats: { trades: 0, contractsDone: 0 },
  unlockedSystems: ["here"], industries: [],
  story: { prog: {}, inbox: [], unread: 0, lastArrivalAt: 0, taxBreakPct: 0, taxBreakUntil: 0, flags: {}, ephemeral: {} },
});
const addShip = (uid = "s1") => {
  const sh = { uid, name: uid, status: "idle", speed: 1, scan: 2, endure: 1, mercenary: false };
  ctx.Game.state.ships.push(sh);
  return sh;
};

// 1) distance / danger bands
ctx.Game.state = freshState();
assert(Math.abs(Expeditions.distanceTo("near1") - 0.05) < 1e-6, "near distance");
assert(!Expeditions.isFar("near1") && Expeditions.isFar("far1"), "far/near banding");
assert(Expeditions.danger("far1") > Expeditions.danger("near1"), "farther = more dangerous");

// 2) duration scales with distance and honours the floor
const dNear = Expeditions.durationFor("near1", "s1"), dFar = Expeditions.durationFor("far1", "s1");
assert(dFar > dNear && dNear >= EXPEDCFG.minMs, "duration scales, floored");

// 3) dispatch gating
ctx.Game.state = freshState(); addShip();
assert(!Expeditions.canSurvey("here").ok, "can't survey a trade hub");
assert(Expeditions.canSurvey("near1").ok, "fresh outpost is surveyable");
const bad = Expeditions.start("near1", "nope");
assert(!bad.ok, "needs a real idle ship");
const r0 = Expeditions.start("near1", "s1");
assert(r0.ok && ctx.Fleet.ship("s1").status === "surveying" && Expeditions.list().length === 1, "dispatch ties up the ship");
assert(!Expeditions.canSurvey("near1").ok, "can't double-survey the same system");
assert(!Expeditions.start("far1", "s1").ok, "a surveying ship isn't idle");

// 4) choiceChance: scan helps, danger hurts, clamp to [0.05, 0.95]
const c0 = Expeditions.choiceChance(0.50, 0, 0, 0, false);
const cScan = Expeditions.choiceChance(0.50, 2, 0, 0, false);
const cDanger = Expeditions.choiceChance(0.50, 0, 0, 1, false);
assert(c0 === 0.50, "base chance");
assert(cScan > c0, "scan raises odds");
assert(cDanger < c0, "danger lowers odds");
assert(Expeditions.choiceChance(0.01, 0, 0, 1, false) === 0.05, "floor 5%");
assert(Expeditions.choiceChance(0.99, 5, 5, 0, true) === 0.95, "ceil 95%");

// 5) mature → Dispatches debrief stub (not auto-loot)
ctx.Game.state = freshState(); addShip();
Expeditions.start("far1", "s1");
const exp = Expeditions.list()[0];
exp.startedAt = Date.now() - exp.etaMs - 1;
SurveyStory.pickEvent = () => SurveyStory.EVENTS.find(e => e.id === "credit_drift");
const out = Expeditions.resolve(Date.now());
assert.strictEqual(out.length, 1, "one stub report");
assert.ok(out[0].awaitingDebrief, "report flags awaiting debrief");
assert.strictEqual(out[0].items.length, 0, "no auto-loot items on mature");
assert.strictEqual(ctx.Fleet.ship("s1").status, "debrief", "ship waits in debrief");
assert.ok(Expeditions.list().some(e => e.id === exp.id && e.debrief), "expedition kept until choice");
const sid = "survey_" + exp.id;
assert.ok(Story.s().ephemeral[sid], "SurveyStory thread opened in Dispatches");
assert.ok(Story.s().prog[sid] && Story.s().prog[sid].status === "active", "debrief prog active");

// 6) Dispatches leave choice → grant → applyOutcome (ship idle, cooldown, ephemeral cleared)
const creditsBefore = ctx.Game.state.credits;
const leave = Story.choose(sid, 1); // "Break off / play it safe"
assert.ok(leave.ok, "leave choice accepted");
assert.strictEqual(ctx.Fleet.ship("s1").status, "idle", "ship released after debrief");
assert.strictEqual(Expeditions.list().length, 0, "expedition cleared after outcome");
assert.ok(Expeditions.cooldownLeft("far1") > 0, "cooldown set on close");
assert.ok(!Story.s().ephemeral[sid], "ephemeral survey thread dropped when arc ends");
assert.strictEqual(Story.s().prog[sid].status, "done", "debrief marked done");
assert.strictEqual(ctx.Game.state.credits, creditsBefore, "credit_drift leave pays nothing");

// 7) push_ok dry_chart mints credits via applyOutcome
ctx.Game.state = freshState(); addShip();
Expeditions.start("near1", "s1");
const exp2 = Expeditions.list()[0];
exp2.debrief = true;
ctx.Fleet.ship("s1").status = "debrief";
const cBefore = ctx.Game.state.credits;
SurveyStory.applyOutcome({ expId: exp2.id, outcome: "push_ok", tplId: "dry_chart" });
assert.ok(ctx.Game.state.credits > cBefore, "dry_chart push_ok grants credits");
assert.ok(ctx.Game.state.reports.some(r => r.uid === exp2.id), "report banked");
assert.strictEqual(ctx.Fleet.ship("s1").status, "idle", "ship idle after payout");

// 8) Phase 3 gate: resolve does not auto-loot when !softIncomeLocal; opens parked debriefs
ctx.Game.state = freshState(); addShip();
Expeditions.start("near1", "s1");
const parked = Expeditions.list()[0];
parked.startedAt = Date.now() - parked.etaMs - 1;
parked.debrief = true;                         // as app_pull would park it
ctx.Fleet.ship("s1").status = "debrief";
ctx.Cloud = { authoritative: () => true, pullReady: true, pullMissing: false, signedIn: () => true, playersReady: true };
assert.strictEqual(Expeditions.resolve(Date.now()).length, 0, "resolve noop when server-authoritative soft income");
assert.ok(Story.s().ephemeral["survey_" + parked.id], "openPendingDebriefs opens SurveyStory under Phase 3");

ctx.Game.state = freshState(); addShip();
const exp3 = { id: "xp99", sysId: "near1", shipUid: "s1", danger: 0.2, debrief: true };
ctx.Game.state.expeditions = [exp3];
ctx.Fleet.ship("s1").status = "debrief";
const cGate = ctx.Game.state.credits;
// Phase 3 live (!softIncomeLocal) but no surveyDebrief RPC → local apply, no mint.
ctx.Cloud = { authoritative: () => true, pullReady: true, pullMissing: false, surveyDebrief: null };
SurveyStory.applyOutcome({ expId: "xp99", outcome: "push_ok", tplId: "dry_chart" });
assert.strictEqual(ctx.Game.state.credits, cGate, "_pay skips credit mint when !softIncomeLocal");
assert.strictEqual(ctx.Fleet.ship("s1").status, "idle", "ship still released under Phase 3 gate");
ctx.Cloud = { authoritative: () => false, pullReady: false, pullMissing: false };

// 9) unmatured survey left running; matured debrief does not set cooldown early
ctx.Game.state = freshState(); addShip();
Expeditions.start("near1", "s1");
assert.strictEqual(Expeditions.resolve(Date.now()).length, 0, "unmatured survey left running");
assert.strictEqual(Expeditions.list().length, 1, "still listed while surveying");

console.log("check_expeditions: debrief + SurveyStory + softIncomeLocal gate ✔");
