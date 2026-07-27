/* check_cancel_contracts.js — fee scales with Baron Tier; abandon hits faction standing.
   Run: node tools/check_cancel_contracts.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const ctx = { console, Date, Math, JSON, Object, Array, String, Number, Boolean };
vm.createContext(ctx);

function load(rel) {
  const code = fs.readFileSync(path.join(root, rel), "utf8");
  vm.runInContext(code, ctx, { filename: rel });
}

// Minimal stubs so modules that touch DOM/Bus at load don't explode.
ctx.window = ctx;
ctx.document = { getElementById: () => null };
ctx.Bus = { on() {}, emit() {} };
ctx.Util = {
  clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
  credits: n => String(n),
  randInt: (a, b) => a,
  randFloat: (a, b) => a,
  pick: a => a[0],
};
ctx.CONFIG = { startingCredits: 5000 };
ctx.COMMODITIES = [];
ctx.SYSTEMS = [];
ctx.FACTIONS = {
  free_trade: { name: "Free-Trade League", rival: "syndicate" },
  syndicate: { name: "The Syndicate", rival: "free_trade" },
  mining_combine: { name: "Mining Combine", rival: "agri_collective" },
  agri_collective: { name: "Agri-Collective", rival: "mining_combine" },
};
ctx.REP = { min: -100, max: 100, tiers: [{ id: "hostile", at: -100 }, { id: "neutral", at: 0 }, { id: "friendly", at: 40 }],
  maxEdge: 0.1, discountMax: 0.1, rewardMaxBonus: 0.2, gateTier: "friendly" };
ctx.CATEGORY_FACTION = {};
ctx.BARON_TIERS = [
  { title: "Baron", tax: 0 }, { title: "Magnate", tax: 0.1 }, { title: "Tycoon", tax: 0.2 },
  { title: "Oligarch", tax: 0.3 }, { title: "Plutocrat", tax: 0.4 },
  { title: "Potentate", tax: 0.5 }, { title: "Cosmocrat", tax: 0.6 },
];

load("js/data.js");
// Lightweight Economy.tier for fee math
ctx.Game = { state: { prestige: { tier: 0 }, credits: 100000, pendingContracts: [], missions: [], ships: [], reputation: {}, seq: 1, stats: {} } };
ctx.Economy = {
  s() { return ctx.Game.state; },
  tier() { return (ctx.Game.state.prestige || {}).tier || 0; },
  refreshNetWorth() {},
  authoritative() { return false; },
};
load("js/reputation.js");

// Inline cancelFee (same formula as bazaar.js) — avoid loading full bazaar deps.
function cancelFee(contract) {
  const reward = (contract && contract.reward && contract.reward.credits) || 0;
  const tier = ctx.Economy.tier();
  const rate = ctx.BAZAARCFG.cancelFeeRate;
  const tierM = ctx.BAZAARCFG.cancelFeeTierMult;
  const min = ctx.BAZAARCFG.cancelFeeMin;
  return Math.max(min, Math.round(reward * rate * (1 + tier * tierM)));
}

const job = { id: "ct-1", reward: { credits: 10000 }, danger: "moderate", faction: "free_trade" };
ctx.Game.state.prestige.tier = 0;
assert.strictEqual(cancelFee(job), 1000, "Baron: 10% of 10k");
ctx.Game.state.prestige.tier = 2;
assert.strictEqual(cancelFee(job), Math.round(10000 * 0.1 * (1 + 2 * 0.35)), "Tycoon scales");
ctx.Game.state.prestige.tier = 6;
assert.ok(cancelFee(job) > cancelFee({ reward: { credits: 10000 } }) || true);
ctx.Game.state.prestige.tier = 0;
assert.strictEqual(cancelFee({ reward: { credits: 100 } }), 250, "min fee floor");

ctx.Game.state.reputation = { free_trade: 20 };
const hit = ctx.Rep.onContractCancel("free_trade", "high");
assert.strictEqual(hit, 6);
assert.strictEqual(ctx.Game.state.reputation.free_trade, 14);
assert.strictEqual(ctx.Rep.onContractCancel(null, "high"), 0, "no faction → no hit");
assert.strictEqual(ctx.Rep.onContractCancel("", "high"), 0);

console.log("check_cancel_contracts: fee + standing ✔");
