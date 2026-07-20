#!/usr/bin/env node
/* check_customs.js — runnable check for the customs seizure system.
   Loads the real store/data/economy scripts into a bare vm context with the
   neighbouring modules stubbed, pins Math.random, and asserts the seizure
   odds and confiscation math. Run:  node tools/check_customs.js               */
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console });
ctx.window = ctx;
for (const f of ["store.js", "data.js", "economy.js"])
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });

const { Economy, CUSTOMS, Util, SYSTEMS } = ctx;
// neighbours customsScan touches
ctx.Market = { systemPrice: () => 500 };            // contraband ~500c/unit for value math
ctx.Rep = { get: () => 0 };                          // neutral Syndicate standing by default
Economy.refreshNetWorth = () => {};                  // skip Fleet/Bazaar valuation in isolation
const homeSys = SYSTEMS.find(x => x.mods && x.mods.illicit === 1) || SYSTEMS[0]; // tolerance 1.0 → scrutiny 1.0
const state = () => ({ currentSystem: homeSys.id, positions: {}, avgCost: {}, travel: null });
const pin = v => vm.runInContext(`Math.random = () => ${v}`, ctx);

// 1) no contraband held → no scan, no event
ctx.Game = { state: state() };
assert.strictEqual(Economy.customsScan(homeSys.id), null, "empty hold = no scan");

// 2) forced hit (random 0): seizes a slice, reduces the stack, values it
ctx.Game = { state: state() }; ctx.Game.state.positions.contraband = 100; ctx.Game.state.avgCost.contraband = 300;
pin(0);   // 0 < chance → hit; randFloat(0.30,0.70) → 0.30 seized
let ev = Economy.customsScan(homeSys.id);
assert(ev && ev.qty === 30, `hit seizes 30% of 100 (got ${ev && ev.qty})`);
assert(ev.value === 30 * 500, "value = qty × price");
assert(ctx.Game.state.positions.contraband === 70, "stack reduced by seizure");
assert(ctx.Game.state.avgCost.contraband === 300, "cost basis kept while stock remains");

// 3) forced miss (random above the chance): nothing taken
ctx.Game = { state: state() }; ctx.Game.state.positions.contraband = 100;
pin(0.99);   // 0.99 >= chance (~0.10) → miss
assert.strictEqual(Economy.customsScan(homeSys.id), null, "miss leaves the hold intact");
assert(ctx.Game.state.positions.contraband === 100, "no units lost on a miss");

// 4) seizing the last unit drops the cost basis (ceil ensures ≥1 taken on a hit)
ctx.Game = { state: state() }; ctx.Game.state.positions.contraband = 1; ctx.Game.state.avgCost.contraband = 300;
pin(0);   // hit; ceil(1 × frac) = 1 → stack cleared
ev = Economy.customsScan(homeSys.id);
assert(ev && ev.qty === 1 && ctx.Game.state.positions.contraband === 0, "seizure clears a single-unit stack");
assert(ctx.Game.state.avgCost.contraband === 0, "cleared stack zeroes cost basis");

// 5) Senate border edict raises the odds; Syndicate standing lowers them
ctx.Senate = { smuggleFailAdd: () => 0.5 };   // heavy border crackdown
ctx.Game = { state: state() }; ctx.Game.state.positions.contraband = 100;
pin(0.4);   // chance = (0.10 + 0.50)*1.0 = 0.60 > 0.4 → hit under the crackdown
assert(Economy.customsScan(homeSys.id) !== null, "border edict makes 0.4 a hit");
ctx.Rep = { get: () => 100 };   // Allied Syndicate: shield 0.30 → chance 0.30 < 0.4 → miss
ctx.Game = { state: state() }; ctx.Game.state.positions.contraband = 100;
pin(0.4);
assert.strictEqual(Economy.customsScan(homeSys.id), null, "friendly Syndicate shields the same roll");
ctx.Senate = undefined; ctx.Rep = { get: () => 0 };

// 6) low-tolerance system scans harder: a roll that misses at a permissive gate
// (mod 1.0, chance = base) must HIT at a strict one (mod < 1, chance > base)
const strict = SYSTEMS.filter(x => x.mods && x.mods.illicit < 1).sort((a, b) => a.mods.illicit - b.mods.illicit)[0];
if (strict) {
  const scrut = Util.clamp(2 - strict.mods.illicit, CUSTOMS.scrutinyClamp[0], CUSTOMS.scrutinyClamp[1]);
  const roll = (CUSTOMS.base + CUSTOMS.base * scrut) / 2;   // between the two systems' chances
  pin(roll);
  ctx.Game = { state: state() }; ctx.Game.state.positions.contraband = 100;
  assert.strictEqual(Economy.customsScan(homeSys.id), null, "permissive gate misses this roll");
  ctx.Game = { state: { currentSystem: strict.id, positions: { contraband: 100 }, avgCost: {}, travel: null } };
  assert(Economy.customsScan(strict.id) !== null, "strict gate hits the same roll");
}

console.log("check_customs: all assertions passed ✔");
