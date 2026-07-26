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

// --- 2) first trade triggers the onboarding job (gated by Accept) ----------
ctx.Game.state.stats.trades = 1;
Story.check(NOW);
assert.ok(Story.s().prog.first_contact, "first_contact arrives after a trade");
assert.strictEqual(Story.s().prog.first_contact.status, "active", "job is active");
assert.ok(Story.inbox().some(m => m.arc === "first_contact" && m.type === "in"), "incoming message posted");
assert.strictEqual(Story.s().unread > 0, true, "unread incremented (mailbox lit)");

// mailbox view model: one conversation, unread, with a pending action (the gate)
let convos = Story.conversations();
assert.strictEqual(convos.length, 1, "one conversation in the mailbox");
assert.ok(convos[0].unread >= 1 && convos[0].action, "conversation shows unread + a pending action");

// opening the conversation marks it read
Story.openConversation("first_contact");
assert.strictEqual(Story.conversations()[0].unread, 0, "opening the thread clears its unread");

// the objective must NOT auto-complete before the job is accepted
ctx.Game.state.credits = 6000;                 // net worth already past 5000
Story.check(NOW);
assert.strictEqual(Story.s().prog.first_contact.step, 0, "objective does not track until accepted");
assert.strictEqual(Story.stepView("first_contact").type, "gate", "step shows an accept/decline gate");

// accept → objective now tracks and (already met) completes with reward + outro
const ra = Story.act("first_contact", "accept");
assert.ok(ra.ok, "accept accepted");
assert.ok(Story.inbox().some(m => m.type === "out"), "accept posts a player reply");
Story.check(NOW);
assert.strictEqual(Story.s().prog.first_contact.status, "done", "job completes once accepted + objective met");
assert.ok(ctx.Game.state.credits >= 6000 + 1500, "credits reward applied (+1500)");
assert.ok(Story.inbox().some(m => m.type === "reward"), "reward message posted");

// --- 3) delta objective measures from the step baseline -------------------
// Broker still *triggers* at ≥4 trades; earlier arcs (dock_philosopher,
// quiet_ladder) arrive first under MAX_ACTIVE pacing, so mark them done here
// so the broker can land and we can exercise its objective/choice path.
ctx.Game.state.stats.trades = 4;
assert.ok(Story.storyline("broker").trigger(ctx.Game.state), "broker trigger true at ≥4 trades");
const snapEarly = Story.snap(ctx.Game.state);
Story.s().prog.dock_philosopher = { step: 0, base: snapEarly, status: "done" };
Story.s().prog.quiet_ladder = { step: 0, base: snapEarly, status: "done" };
bump(Story.ARRIVAL_GAP_MS);
Story.check(NOW);
assert.ok(Story.s().prog.broker, "broker arc arrives when earlier arcs aren't filling MAX_ACTIVE");
const base = Story.s().prog.broker.base.trades;
assert.strictEqual(base, 4, "baseline snapshot taken at step start");

// flavour reply: pure colour, posts your line, no mechanical change, then hides
const outBefore = Story.inbox().filter(m => m.type === "out").length;
assert.ok(Story.stepView("broker").replies.length > 0, "step offers flavour replies");
Story.act("broker", "reply:1");
assert.strictEqual(Story.inbox().filter(m => m.type === "out").length, outBefore + 1, "flavour reply posts a player line");
assert.strictEqual(Story.stepView("broker").replies.length, 0, "replies hide after answering once");
assert.strictEqual(Story.s().prog.broker.step, 0, "flavour reply does not advance the story");
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

// --- 5) decline a job → it ends without granting -------------------------
ctx.Game.state.credits = 20000;              // triggers foundry_grant (net worth >= 15000)
bump(Story.ARRIVAL_GAP_MS);
Story.check(NOW);
assert.ok(Story.s().prog.foundry_grant, "foundry job arrives");
assert.strictEqual(Story.stepView("foundry_grant").type, "gate", "foundry opens with an accept/decline gate");
const exBefore = Object.keys(ctx.Game.state.extractors).length;
Story.act("foundry_grant", "decline");
assert.strictEqual(Story.s().prog.foundry_grant.status, "declined", "declining ends the job");
assert.strictEqual(Object.keys(ctx.Game.state.extractors).length, exBefore, "no reward granted on decline");

// --- 6) mailbox caps at MAX_CONTACTS conversations ------------------------
for (let i = 0; i < Story.MAX_CONTACTS + 5; i++) Story._push({ arc: "spam" + i, from: "N" + i, portrait: null, text: "hi", type: "in" });
const arcs = new Set(Story.inbox().map(m => m.arc));
assert.ok(arcs.size <= Story.MAX_CONTACTS, `mailbox pruned to <= ${Story.MAX_CONTACTS} contacts (got ${arcs.size})`);
assert.ok(Story.conversations().length <= Story.MAX_CONTACTS, "conversations() never exceeds the contact cap");

// --- 7) arrival throttle: no two storylines start in the same instant -----
const active = Object.values(Story.s().prog).filter(p => p.status === "active").length;
assert.ok(active <= Story.MAX_ACTIVE, "never exceeds MAX_ACTIVE concurrent storylines");

// --- 8) declarative conditions (the admin-editor / custom-mission engine) --
{
  const s = freshState();
  // evalCond: absolute vs delta, and the operators
  assert.strictEqual(Story.evalCond({ metric: "credits", op: ">=", value: 1000 }, s), true, "credits >= 1000 (1500) true");
  assert.strictEqual(Story.evalCond({ metric: "credits", op: ">", value: 1500 }, s), false, "credits > 1500 false");
  assert.strictEqual(Story.evalCond({ metric: "ships", op: "==", value: 1 }, s), true, "ships == 1 true");
  const base = Story.snap(s);                       // baseline for delta
  s.stats.trades = 3;
  assert.strictEqual(Story.evalCond({ metric: "trades", op: ">=", value: 3, delta: true }, s, base), true, "delta trades +3 met");
  assert.strictEqual(Story.evalCond({ metric: "trades", op: ">=", value: 4, delta: true }, s, base), false, "delta trades +4 not met");
  assert.strictEqual(Story.evalCond(null, s), true, "blank condition = no gate (true)");
  assert.strictEqual(Story.evalCond({ metric: "escorts", op: ">=", value: 1 }, s), false, "escorts metric reads fleet class");
}

// --- 9) a custom (data-only) mission runs start→objective→reward→done ------
{
  ctx.Game = { state: freshState(), requestSave() {} };
  ctx.STORY_CUSTOM = [{
    id: "cust_test", kind: "job", from: "Admin NPC", portrait: 1,
    triggerCond: { metric: "credits", op: ">=", value: 1000 },   // true immediately
    outro: "Admin NPC: done.",
    steps: [{
      text: "Bank 3,000 credits.",
      goal: { desc: "Reach 3,000c", cond: { metric: "credits", op: ">=", value: 3000 } },
      reward: { credits: 500 },
    }],
  }];
  let NOW2 = 5_000_000;
  Story.check(NOW2);
  assert.ok(Story.s().prog.cust_test, "custom mission triggers from a declarative condition");
  assert.strictEqual(Story.storyline("cust_test").from, "Admin NPC", "storyline() finds custom missions");
  Story.check(NOW2);                                    // objective not met yet (1500 < 3000)
  assert.strictEqual(Story.s().prog.cust_test.status, "active", "custom objective still open below target");
  ctx.Game.state.credits = 3200;
  Story.check(NOW2);
  assert.strictEqual(Story.s().prog.cust_test.status, "done", "custom objective completes when the condition is met");
  assert.strictEqual(ctx.Game.state.credits, 3200 + 500, "custom mission reward paid out");

  // malformed / colliding custom rows are filtered by all() (cloud trust boundary)
  ctx.STORY_CUSTOM = [{ id: "first_contact", from: "Imposter", steps: [{ text: "x" }] },  // shadows a built-in → dropped
                      { id: "broken", from: "No Steps" },                                  // no steps → dropped
                      { id: "ok_one", from: "Fine", steps: [{ text: "hi" }] }];            // valid
  const ids = Story.all().map(x => x.id);
  assert.ok(Story.all().find(x => x.id === "first_contact").from !== "Imposter", "custom id cannot shadow a built-in mission");
  assert.ok(!ids.includes("broken"), "stepless custom mission is dropped");
  assert.ok(ids.includes("ok_one"), "valid custom mission is kept");
}

console.log("check_story: mailbox + accept/decline gate + flavour replies + choice + tax break + contact cap + declarative conditions + custom missions ✔");
