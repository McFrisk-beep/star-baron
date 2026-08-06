#!/usr/bin/env node
/* check_mission_story.js — completed contracts open a Dispatches after-action.
   Run: node tools/check_mission_story.js                                      */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math });
ctx.window = ctx;
ctx.Date = Date;
for (const f of ["store.js", "data.js", "flavor.js", "story.js", "mission-story.js", "missions.js"])
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });

const { MissionStory, Story, Missions, Util } = ctx;

ctx.Galaxy = { get: () => ({ id: "navos", name: "Navos" }) };
ctx.Fleet = {
  ship(uid) { return ctx.Game.state.ships.find(s => s.uid === uid); },
  shipDef() { return { price: 2000, cls: "transport", sprite: 0 }; },
  power() { return 1; }, cargoCap() { return 20; }, avgSpeed() { return 1; },
  stats() { return { speed: 1 }; },
  addDamage(sh, f) { sh.dmg = (sh.dmg || 0) + f; },
};
ctx.Items = { gen: () => ({ uid: "it1", name: "Widget" }) };
ctx.Economy = {
  authoritative: () => false, afterTax: n => n, refreshNetWorth() {}, checkAchievements() {},
  netWorth: () => ctx.Game.state.credits,
};
ctx.Rep = { successBonus: () => 0, rewardMult: () => 1, onContract() {}, onContractCancel: () => 0 };
ctx.Bazaar = { claimForLaunch: c => ({ ok: true, contract: c }) };
// store.js binds a lexical Bus — listen on the real one (don't replace ctx.Bus).
ctx.__bus = [];
ctx.Bus.on("missionDone", p => ctx.__bus.push(["missionDone", p]));
ctx.Bus.on("missionDebrief", p => ctx.__bus.push(["missionDebrief", p]));
ctx.Senate = { shipClassBanned: () => false, smuggleFailAdd: () => 0 };
ctx.COMMODITIES = [{ id: "ore", name: "Ore" }];
ctx.DMGCFG = { types: { transport: { chance: 0, dmg: [0, 0], destroy: 0, destroyFail: 0, failMult: 1 } },
  dangerMult: { safe: 1 }, maxDmg: 0.85 };
ctx.BAZAARCFG = { tierRiskMult: 0.1 };
ctx.Game = { timeScale: 1, state: null, requestSave() {} };

ctx.Game.state = {
  seq: 1, credits: 5000, ships: [{ uid: "s1", name: "Hauler", status: "idle", cls: "transport", type: "drift", dmg: 0 }],
  missions: [], reports: [], items: {}, positions: {}, avgCost: {},
  stats: { contractsDone: 0 }, pendingContracts: [],
  story: { prog: {}, inbox: [], unread: 0, lastArrivalAt: 0, taxBreakPct: 0, taxBreakUntil: 0, flags: {}, ephemeral: {} },
};

const contract = {
  id: "c1", type: "transport", title: "Ice Run to Navos", sysName: "Navos",
  danger: "safe", minFirepower: 0, cargoRequired: 0, durationMs: 1000,
  reward: { credits: 500, itemChance: 0, stockChance: 0 }, impound: false, faction: null,
};
// Mission launch is async (it may claim a shared station haul) — wrap the tail.
(async () => {
const launched = await Missions.launch(contract, ["s1"]);
assert.ok(launched.ok, "launch ok");
const m = ctx.Game.state.missions[0];
m.startedAt = Date.now() - m.totalMs - 1;
m.successChance = 1;   // force success

ctx.__bus.length = 0;
const out = Missions.resolveMatured(Date.now());
assert.strictEqual(out.length, 1, "one report");
assert.ok(out[0].success, "success");
assert.ok(out[0].sysName === "Navos", "sysName on report");

const id = "mrep_" + out[0].uid;
assert.ok(Story.s().ephemeral[id], "mission report thread in Dispatches");
assert.strictEqual(Story.s().prog[id].status, "active", "report active");
assert.ok(ctx.__bus.some(x => x[0] === "missionDebrief"), "missionDebrief emitted");
assert.ok(ctx.__bus.some(x => x[0] === "missionDone"), "missionDone emitted");

// File the report
const filed = Story.act(id, "continue");
assert.ok(filed.ok, "file continue ok");
assert.strictEqual(Story.s().prog[id].status, "done", "report filed");
assert.ok(!Story.s().ephemeral[id], "ephemeral dropped after file");

// Idempotent — won't reopen
assert.strictEqual(MissionStory.begin(out[0]), null, "no duplicate thread");

console.log("check_mission_story: Dispatch after-action ✔");
})().catch(e => { console.error(e); process.exit(1); });
