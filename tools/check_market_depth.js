#!/usr/bin/env node
/* check_market_depth.js — proves the anti-arbitrage market rework holds:
   split-proof slippage, tier trade caps, mod compression, spot-valued net worth,
   decaying impact, and the death of the dump-arbitrage exploit.
   Run:  node tools/check_market_depth.js                                        */
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

const ctx = vm.createContext({ console });
ctx.window = ctx;
let T = 1_000_000_000;                       // pinned clock so decay is deterministic
ctx.Date = { now: () => T };
for (const f of ["store.js", "data.js", "market.js", "economy.js"])
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });

const { Market, Economy, MARKETCFG, BARON_TIERS, SYSTEMS } = ctx;
// neighbours Economy touches
ctx.Rep = { edgeForCategory: () => 0, onTrade() {} };
ctx.Fleet = { fleetValue: () => 0 };
ctx.Bazaar = { itemsValue: () => 0 };
Market.init();

const IRON = "iron_ore", BASE = 40;
const freshState = (tier = 0, sysId = "korrin", credits = 1e12) => ({
  credits, positions: {}, avgCost: {}, currentSystem: sysId, travel: null,
  prestige: { tier }, stats: { trades: 0 }, achievements: [], unlockedSystems: [], ships: [], items: {},
});
const reset = (tier = 0, sysId = "korrin", credits = 1e12) => {
  Market.tradeImpact = {}; ctx.Game = { state: freshState(tier, sysId, credits) };
};

// 1) mod compression: korrin mineral raw 0.65 → 1+(0.65-1)*0.6 = 0.79
reset();
assert(approx(Market.spot(IRON, "korrin"), BASE * 0.79, 1e-9), "compressed mod applied to spot");
// raw best/worst gap vs compressed gap for minerals across the capitals
const rawMods = SYSTEMS.map(s => s.mods.mineral), compMods = SYSTEMS.map(s => Market._mod("mineral", s.id));
const rawGap = Math.max(...rawMods) - Math.min(...rawMods), compGap = Math.max(...compMods) - Math.min(...compMods);
assert(compGap < rawGap && approx(compGap, rawGap * 0.6, 1e-9), "inter-system gap compressed 40%");

// 2) split-proof: one order of 300 costs the same as ten orders of 30
reset();
const one = Economy.buy(IRON, 300);
reset();
let chunk = 0; for (let i = 0; i < 10; i++) chunk += Economy.buy(IRON, 30).cost;
assert(approx(one.cost, chunk, 1e-9), `split-proof: 1×300 (${one.cost|0}) == 10×30 (${chunk|0})`);

// 3) slippage is real & monotonic: bigger orders fill at a worse average price
reset();
const spot = Market.spot(IRON, "korrin");
const a30 = Economy.buy(IRON, 30).price; reset();
const a300 = Economy.buy(IRON, 300).price;
assert(a30 > spot && a300 > a30, "larger orders slip to a worse average price");

// 4) per-trade cap (tier 0 = 10,000c): can't move more than cap/spot units
reset(0);
const capUnits = Math.floor(10000 / spot);
const big = Economy.buy(IRON, 1_000_000);
assert(big.ok && big.qty === capUnits && big.capped, `buy clamped to tier-0 cap (${capUnits}u)`);
// sell-all is capped too
reset(0); ctx.Game.state.positions[IRON] = 50000;
assert(Economy.maxSell(IRON) === capUnits, "Sell All clamped to the tier cap, not the whole stack");

// 5) tier scaling: Cosmocrat (tier 6, cap 500k) moves ~50× tier 0
reset(6);
assert(BARON_TIERS[6].cap === 500000, "top tier cap = 500k");
assert(Economy.buy(IRON, 1_000_000).qty === Math.floor(500000 / spot), "tier 6 cap is 50× tier 0");

// 6) net worth values holdings at SPOT (no self-inflation from your own buying)
reset(0);
Economy.buy(IRON, 200);
const held = ctx.Game.state.positions[IRON];
assert(Market.impactAt(IRON, "korrin") > 0, "buying raised local pressure");
assert(Market.systemPrice(IRON, "korrin") > Market.spot(IRON, "korrin"), "displayed price reflects your pressure");
const nwHoldings = Economy.netWorth() - ctx.Game.state.credits;
assert(approx(nwHoldings, held * Market.spot(IRON, "korrin"), 1e-6), "net worth counts holdings at spot, not inflated price");

// 7) impact decays with the half-life (recovery)
reset();
Economy.buy(IRON, 300);
const p0 = Market.impactAt(IRON, "korrin");
T += MARKETCFG.impactHalfLifeMs;                 // advance one half-life
assert(approx(Market.impactAt(IRON, "korrin"), p0 / 2, 1e-9), "pressure halves after one half-life");

// 8) the exploit is dead, but honest trading still pays. A rational MATCHED
//    round trip (buy Q at cheap korrin → hop → sell the same Q at dear sable)
//    yields a small, bounded profit that scales with tier — not a printer.
function bestRoundTrip(tier) {
  let best = -Infinity, bestQ = 0;
  for (let q = 5; q <= 100000; q += 5) {
    reset(tier);
    const b = Economy.buy(IRON, q); if (!b.ok || b.capped) break;   // stop at the tier cap
    ctx.Game.state.currentSystem = "sable";
    const sMax = Economy.maxSell(IRON); if (sMax < q) break;         // must be able to sell the whole lot at once
    const sll = Economy.sell(IRON, q);
    const p = sll.proceeds - b.cost;
    if (p > best) { best = p; bestQ = q; }
  }
  return { best, bestQ };
}
const t0 = bestRoundTrip(0), t6 = bestRoundTrip(6);
assert(t0.best > 0 && t0.best < 3000, `tier-0 best round trip is small & positive (+${t0.best | 0}c @ ${t0.bestQ}u)`);
assert(t6.best > t0.best * 10, "profit scales with tier (deeper markets)");
// and you flat-out cannot move 20,000 units in one order at tier 0
reset(0);
assert(Economy.buy(IRON, 20000).qty === capUnits, "a 20,000-unit dump is impossible — clamped to the cap");
console.log(`   tier-0 best round trip: +${t0.best | 0}c @ ${t0.bestQ}u  |  tier-6: +${t6.best | 0}c @ ${t6.bestQ}u  (was ~+400,000c uncapped)`);

console.log("check_market_depth: all assertions passed ✔");
