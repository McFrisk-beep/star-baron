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

// 4) per-trade cap (tier 0): limits the ACTUAL credits moved to ≤ cap
reset(0);
const TIER0_CAP = BARON_TIERS[0].cap;
const big = Economy.buy(IRON, 1_000_000);
assert(big.ok && big.capped && big.cost <= TIER0_CAP, `buy spend clamped to tier-0 cap (${big.cost | 0}c ≤ ${TIER0_CAP})`);
// sell-all is capped by proceeds too
reset(0); ctx.Game.state.positions[IRON] = 50000;
const sellAllN = Economy.maxSell(IRON);
assert(sellAllN > 0 && sellAllN < 50000, "Sell All clamped below the whole stack");
const sa = Economy.sell(IRON, sellAllN);
assert(sa.proceeds + sa.tax <= TIER0_CAP + spot, `Sell All gross ≤ cap (${(sa.proceeds + sa.tax) | 0}c)`);

// 5) tier scaling: Cosmocrat (tier 6, cap 500k) moves far more per trade than tier 0
assert(BARON_TIERS[6].cap === 500000, "top tier cap = 500k");
reset(0); const q0 = Economy.buy(IRON, 1_000_000).qty;
reset(6); const q6 = Economy.buy(IRON, 1_000_000).qty;
assert(q6 > q0 * 10, `tier 6 moves far more than tier 0 (${q0}u → ${q6}u)`);

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
// and a 20,000-unit dump is impossible — clamped, and the spend stays ≤ cap
reset(0);
const dump = Economy.buy(IRON, 20000);
assert(dump.capped && dump.qty < 20000 && dump.cost <= TIER0_CAP, "a 20,000-unit dump is clamped and never exceeds the cap");
console.log(`   tier-0 best round trip: +${t0.best | 0}c @ ${t0.bestQ}u  |  tier-6: +${t6.best | 0}c @ ${t6.bestQ}u  (was ~+400,000c uncapped)`);

// 9) REGRESSION (the "73.9Kc spent on a 15Kc cap" bug): the cap limits ACTUAL
//    credits moved even when your OWN buying has pumped the price far above spot.
reset(0, "navos");
const AM = "antimatter";
for (let i = 0; i < 40; i++) Economy.buy(AM, Economy.maxBuy(AM));       // pump the local price up
assert(Market.impactAt(AM, "navos") > 1, "repeated buying pumped antimatter above spot");
const r9 = Economy.buy(AM, Economy.maxBuy(AM));
assert(r9.ok && r9.price > Market.spot(AM, "navos") * 2, "…trade really is far above spot now");
assert(r9.cost <= TIER0_CAP + 1, `Buy Max still spends ≤ cap when pumped (spent ${r9.cost | 0}c, cap ${TIER0_CAP}) — the reported bug`);

console.log("check_market_depth: all assertions passed ✔");
