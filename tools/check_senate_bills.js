/* check_senate_bills.js — the Senate expansion: 4 new edict types wire into the
   effect aggregator, and the player Ballot Initiative tables a bill (stamped
   proposedBy:"you") onto the docket with dedup. Loads the real data/flavor/senate
   into a vm with light stubs for Game/Economy/Rivals. No browser. */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const root = path.join(__dirname, "..");
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };

(async () => {

const ctx = { console, Math, Date, JSON, Object, Array, Number, String, isNaN, parseInt, parseFloat };
ctx.window = ctx;
ctx.matchMedia = () => ({ matches: false });
ctx.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
vm.createContext(ctx);
const load = f => vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx);
load("js/store.js");     // Util, Bus
load("js/data.js");      // CONFIG, COMMODITIES, FACTIONS, SENATECFG, …
load("js/flavor.js");    // SENATE_EDICTS, SENATE_ISSUES, …

// Minimal live-state + stubs the tested Senate paths touch.
ctx.Game = { timeScale: 1, requestSave() {}, state: {
  credits: 5_000_000, prestige: { tier: 0 },
  senate: { bills: [], nextVoteAt: 0, reps: {}, pending: null, cycle: 0, billSeq: 0, lastBillId: null, shared: false },
} };
ctx.Economy = { refreshNetWorth() {}, authoritative() { return false; } };
ctx.Rivals = { rank() { return ctx._rank || 1; } };
load("js/senate.js");
const Senate = ctx.Senate, SENATECFG = ctx.SENATECFG, EDICTS = ctx.SENATE_EDICTS;
const edict = id => EDICTS.find(t => t.id === id);
const now = Date.now();

// ---- 1) _instantiate builds correct effects for the new types --------------
let inst = Senate._instantiate(edict("windfall_tax"), { factor: 1, label: "" });
assert(inst.effect.type === "windfall" && Math.abs(inst.effect.add - 0.06) < 1e-9, "windfall instantiates with add=0.06");

inst = Senate._instantiate(edict("convoy_act"), { factor: 1, label: "" });
assert(inst.effect.type === "routeSafety" && inst.effect.add === 0.4, "convoy mandate: +0.4 route safety");
inst = Senate._instantiate(edict("lane_dereg"), { factor: 1, label: "" });
assert(inst.effect.add === -0.4, "lane cuts: −0.4 route safety (riskier)");

inst = Senate._instantiate(edict("rationing"), { factor: 1, label: "" }, { comm: ctx.COMMODITIES[0].id });
assert(inst.effect.type === "ration" && inst.effect.commId === ctx.COMMODITIES[0].id && inst.effect.mult > 1, "rationing: commodity prop >1 on the chosen comm");

inst = Senate._instantiate(edict("salvage_act"), { factor: 1, label: "" });
assert(inst.effect.type === "salvage" && Math.abs(inst.effect.add - 0.3) < 1e-9, "salvage act: +0.3 payout");

// ---- 2) effect aggregation reads the new active edicts ----------------------
const sen = Senate.sen();
sen.bills = [
  { id: "b1", status: "passed", type: "windfall",    effect: { type: "windfall", add: 0.06 },              endsAt: now + 1e9 },
  { id: "b2", status: "passed", type: "routeSafety", effect: { type: "routeSafety", add: 0.4 },            endsAt: now + 1e9 },
  { id: "b3", status: "passed", type: "salvage",     effect: { type: "salvage", add: 0.3 },                endsAt: now + 1e9 },
  { id: "b4", status: "passed", type: "ration",      effect: { type: "ration", commId: ctx.COMMODITIES[0].id, mult: 1.3 }, endsAt: now + 1e9 },
];
Senate._bumpRev();
assert(Math.abs(Senate.windfallSurtax() - 0.06) < 1e-9, "windfallSurtax() aggregates to 0.06");
assert(Senate.routeSafetyAdd() === 0.4, "routeSafetyAdd() aggregates to 0.4");
assert(Math.abs(Senate.salvageBonusAdd() - 0.3) < 1e-9, "salvageBonusAdd() aggregates to 0.3");
const c0 = ctx.COMMODITIES[0];
assert(Math.abs(Senate.priceFactor(c0.id, c0.cat) - 1.3) < 1e-9, "rationing raises priceFactor for the chosen commodity");
// an expired edict must not count
sen.bills[0].endsAt = now - 1; Senate._bumpRev();
assert(Senate.windfallSurtax() === 0, "expired windfall no longer surtaxes");

// ---- 3) Ballot Initiative: gating, tabling, attribution, dedup --------------
sen.bills = []; Senate._bumpRev();
Senate.shared = false;
ctx.Game.state.prestige.tier = 0;
let r = Senate.proposeBill("subsidy|tech");
assert(!r.ok, "ballot gated below Baron Tier " + SENATECFG.ballotMinTier);

ctx.Game.state.prestige.tier = SENATECFG.ballotMinTier;   // now eligible
assert(Senate.canBallot(), "canBallot() true at/above the min tier");
const opts = Senate.ballotOptions();
assert(opts.length > 0 && opts.every(o => o.value && o.label), "ballotOptions() returns labelled choices");
assert(opts.some(o => o.value.startsWith("salvage_act")), "salvage act is proposable");

const floorBefore = Senate.nextBill(now);
const creditsBefore = ctx.Game.state.credits;
r = Senate.proposeBill("subsidy|tech");
assert(r.ok, "ballot: tech subsidy tabled");
assert(r.bill.proposedBy === "you", "tabled bill is stamped proposedBy:'you'");
assert(ctx.Game.state.credits === creditsBefore - Senate.ballotCost(), "ballot fee was charged");
assert(sen.bills.some(b => b.id === r.bill.id && b.proposedBy === "you"), "tabled bill is on the docket");
assert(r.bill.votesAt > floorBefore.votesAt, "tabled bill is slotted after the bill on the floor");

// duplicate measure is refused
r = Senate.proposeBill("subsidy|tech");
assert(!r.ok && /already/i.test(r.msg), "duplicate measure refused");

// shared play: guests can't table; signed-in barons go through SenateWorld
Senate.shared = true;
r = Senate.proposeBill("salvage_act");
assert(!r.ok && /sign in/i.test(r.msg), "shared ballot requires sign-in");
ctx.Cloud = {
  signedIn: () => true, user: () => ({ id: "user-1" }), email: () => "raphael@example.com",
  authoritative: () => false, _isMissingRpc: () => false,
};
assert(Senate.canBallot(), "signed-in shared play canBallot at tier");
let sharedBill = null;
ctx.SenateWorld = {
  proposeBallot: async (edictId, target) => {
    sharedBill = {
      id: "wb42", status: "upcoming", proposedBy: "user-1", proposedLabel: "raphael",
      issue: "subsidy", type: "salvage", title: "Salvage Rights Act", blurb: "…",
      effect: { type: "salvage", add: 0.3 }, votesAt: Date.now() + 1e8,
    };
    Senate.ingestSharedBill(sharedBill);
    return { ok: true, bill: sharedBill, charged: false, cost: Senate.ballotCost() };
  },
};
// Pick a proposable measure not already on the local docket (ensureSchedule may
// have randomly queued one of the ballot templates during the solo tests above).
const taken = Senate._takenSet(Date.now());
const pick = opts.find(o => {
  const [id, key] = o.value.split("|");
  const tpl = edict(id);
  const chosen = tpl.scope === "cat" ? { cat: key } : tpl.scope === "comm" ? { comm: key } : tpl.scope === "faction" ? { faction: key } : {};
  const inst = Senate._instantiate(tpl, { factor: 1, label: "" }, chosen);
  return !taken.has(Senate._effectSig(inst.effect));
});
assert(pick, "a free ballot option remains for the shared-path test");
const creditsSharedBefore = ctx.Game.state.credits;
r = await Senate.proposeBill(pick.value);
assert(r.ok && r.bill.id === "wb42", "shared ballot tables via SenateWorld: " + (r.msg || ""));
assert(ctx.Game.state.credits === creditsSharedBefore - Senate.ballotCost(), "shared ballot fee charged locally when server did not");
assert(sen.bills.some(b => b.id === "wb42" && b.proposedBy === "user-1"), "shared tabled bill is on the docket");
Senate.shared = false;
delete ctx.Cloud; delete ctx.SenateWorld;

// every ballot value round-trips through proposeBill's parser into a real edict
for (const o of opts) {
  const [id] = o.value.split("|");
  assert(!!edict(id) && edict(id).ballot, "ballot option maps to a proposable edict: " + id);
}

console.log("All senate-bills checks passed.");
})().catch(e => { console.error("FAIL:", e); process.exit(1); });
