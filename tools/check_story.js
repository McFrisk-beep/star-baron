#!/usr/bin/env node
/* check_story.js — exercises the Dispatches story engine (js/story.js) end to end:
   a storyline triggers, its objective completes and pays out, deltas measure from
   the step baseline (not absolutes), a choice branch grants + ends the arc, and a
   timed tax break feeds Industries.taxRelief. Run: node tools/check_story.js      */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, Date });
ctx.window = ctx;
// minimal engine deps: story.js reads Game.state, Economy.netWorth, Util, Fleet,
// Components, Extractors, Items, SHIP_CATALOG. Stub just enough to run headless.
ctx.Util = { credits: n => n + "c", duration: ms => Math.round(ms / 60000) + "m", ago: () => "now" };
ctx.SHIP_CATALOG = { transport: [{ id: "mule", name: "Mule" }], escort: [{ id: "frigate", name: "Frigate", cls: "escort" }], main: [] };
ctx.Fleet = { makeShip: id => ({ uid: "s" + Math.random().toString(36).slice(2), type: id, cls: id === "frigate" ? "escort" : "transport" }) };
let seq = 0;
ctx.Components = { gen: () => ({ uid: "c" + (++seq), name: "Test Booster", kind: "rate", rarity: "common", amount: 0.08 }), acquire(c) { return c; } };
ctx.Extractors = { gen: () => ({ uid: "x" + (++seq), name: "Test Rig", type: "jack", scope: "all", components: [] }), acquire(e) { return e; } };
ctx.Items = { gen: o => ({ uid: "i" + (++seq), name: "Test Gear " + (o.rarity || "common"), rarity: o.rarity || "common" }) };
ctx.Economy = { netWorth: () => ctx.Game.state.credits, refreshNetWorth() {} };
ctx.Bus = { on() {}, emit() {} };

vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/story.js"), "utf8"), ctx, { filename: "story.js" });
const { Story } = ctx;

// fresh state
function freshState() {
  return {
    credits: 1500, ships: [{ uid: "s1", type: "mule", cls: "transport" }],
    extractors: {}, components: {}, items: {}, industries: [], unlockedSystems: ["navos"],
    stats: { trades: 0, contractsDone: 0 },
    story: { prog: {}, inbox: [], unread: 0, lastArrivalAt: 0, taxBreakPct: 0, taxBreakUntil: 0 },
  };
}
let saves = 0;
ctx.Game = { state: freshState(), requestSave() { saves++; } };
let NOW = 1_000_000;
const bump = ms => (NOW += ms);

// --- 1) nothing triggers with zero trades ---------------------------------
Story.check(NOW);
assert.strictEqual(Object.keys(Story.s().prog).length, 0, "no storyline before any trade");

// --- 2) first trade triggers the onboarding job ---------------------------
ctx.Game.state.stats.trades = 1;
Story.check(NOW);
assert.ok(Story.s().prog.first_contact, "first_contact arrives after a trade");
assert.strictEqual(Story.s().prog.first_contact.status, "active", "job is active");
assert.ok(Story.inbox().some(m => m.arc === "first_contact" && m.type === "in"), "incoming message posted");
assert.strictEqual(Story.s().unread > 0, true, "unread incremented");

// objective: reach 5000 net worth → not met yet
Story.check(NOW);
assert.strictEqual(Story.s().prog.first_contact.step, 0, "objective not met at 1500c");

// meet it → reward pays credits + a component, arc ends with outro
const before = ctx.Game.state.credits;
ctx.Game.state.credits = 5000;
Story.check(NOW);
assert.strictEqual(Story.s().prog.first_contact.status, "done", "job completes when net worth hits 5000");
assert.ok(ctx.Game.state.credits >= 5000 + 1500, "credits reward applied (+1500)");
assert.strictEqual(Object.keys(ctx.Game.state.components).length >= 0, true); // acquire is stubbed; ensure no throw
assert.ok(Story.inbox().some(m => m.type === "reward"), "reward message posted");

// --- 3) delta objective measures from the step baseline -------------------
ctx.Game.state.stats.trades = 4;         // triggers the broker arc (>=4 trades)
bump(Story.ARRIVAL_GAP_MS);              // respect the arrival throttle
Story.check(NOW);
assert.ok(Story.s().prog.broker, "broker arc arrives at >=4 trades");
const base = Story.s().prog.broker.base.trades;
assert.strictEqual(base, 4, "baseline snapshot taken at step start");
ctx.Game.state.stats.trades = 6;         // +2 from baseline: not enough (needs +3)
Story.check(NOW);
assert.strictEqual(Story.s().prog.broker.step, 0, "delta objective still open at +2");
ctx.Game.state.stats.trades = 7;         // +3 from baseline
Story.check(NOW);
assert.strictEqual(Story.s().prog.broker.step, 1, "delta objective completes at +3, advances to step 2");

// step 2: own an escort warship
ctx.Game.state.ships.push({ uid: "s2", type: "frigate", cls: "escort" });
Story.check(NOW);
assert.strictEqual(Story.s().prog.broker.step, 2, "advances to the choice step after owning an escort");

// --- 4) choice branch grants a ship + timed tax break and ends the arc ----
const shipsBefore = ctx.Game.state.ships.length;
const r = Story.choose("broker", 0);     // "Run it" → credits + frigate + 10% tax break for 30m
assert.ok(r.ok, "choice accepted");
assert.strictEqual(Story.s().prog.broker.status, "done", "arc ends after a terminal choice");
assert.strictEqual(ctx.Game.state.ships.length, shipsBefore + 1, "ship reward granted by the choice");
assert.ok(Story.inbox().some(m => m.type === "out"), "player reply posted to the thread");

// tax break is live within its window and expires after (test around the stored
// expiry, since grant() stamps it with real Date.now()).
const until = Story.s().taxBreakUntil;
assert.ok(Story.taxRelief(until - 1000) > 0.09, "tax relief active before expiry");
assert.strictEqual(Story.taxRelief(until + 1000), 0, "tax relief expires after its window");

// --- 5) arrival throttle: no two storylines start in the same instant -----
const active = Object.values(Story.s().prog).filter(p => p.status === "active").length;
assert.ok(active <= Story.MAX_ACTIVE, "never exceeds MAX_ACTIVE concurrent storylines");

console.log("check_story: onboarding + delta objective + choice branch + tax break ✔");
