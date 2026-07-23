#!/usr/bin/env node
/* check_market_parity.js — Phase 0 guarantee: js/market.js formulaGlobal /
   formulaSystem match the SQL reference (tools/market_sql_ref.js ↔
   docs/sql/market_price.sql) within ε across many (commodity, t, system) samples.
   Also asserts determinism and that the live tick is a pure recompute.
   Run:  node tools/check_market_parity.js                                       */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const sqlRef = require("./market_sql_ref.js");

const eps = (a, b, tol = 1e-9) => {
  const d = Math.abs(a - b);
  if (d <= tol) return true;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return d / scale <= tol;
};

const ctx = vm.createContext({ console, Math });
ctx.window = ctx;
let T = 1_700_000_000_000; // pinned clock
ctx.Date = { now: () => T };
for (const f of ["store.js", "data.js", "market.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}
const { Market, COMMODITIES, SYSTEMS, MARKETCFG, CONFIG } = ctx;
Market.init();

// 0) constants wired through
assert.strictEqual(MARKETCFG.seed, "cosmocrat-market-v1");
assert.strictEqual(MARKETCFG.volGain, 1.15);
assert.strictEqual(CONFIG.priceFloorMult, 0.88);
assert.strictEqual(CONFIG.priceCeilMult, 1.12);

// 1) JS ↔ SQL-ref parity over a grid of times / commodities / capitals
const times = [
  0, 1, 2_000, 60_000, 1_800_000, 5_400_000, 86_400_000,
  1_700_000_000_000, 1_700_000_000_000 + 2_000, 1_714_000_000_000,
];
let n = 0;
for (const c of COMMODITIES) {
  for (const t of times) {
    const jsG = Market.formulaGlobal(c, t);
    const sqlG = sqlRef.priceGlobal(c.id, t);
    assert(eps(jsG, sqlG), `global mismatch ${c.id} @${t}: js=${jsG} sql=${sqlG}`);
    for (const sys of SYSTEMS) {
      const jsS = Market.formulaSystem(c, sys.id, t);
      const sqlS = sqlRef.priceSystem(c.id, sys.id, t);
      assert(eps(jsS, sqlS), `system mismatch ${c.id}/${sys.id} @${t}: js=${jsS} sql=${sqlS}`);
      n++;
    }
  }
}
assert(n >= COMMODITIES.length * times.length * SYSTEMS.length, "sampled full grid");

// 2) determinism: same t → identical price (no hidden RNG / accumulated state)
const t0 = 1_714_123_456_789;
const a = Market.formulaGlobal("antimatter", t0);
Market.tick(t0 + 50_000);
Market.tick(t0 + 100_000);
const b = Market.formulaGlobal("antimatter", t0);
assert.strictEqual(a, b, "formulaGlobal is referentially transparent");

// 3) tick recomputes from the clock (does not random-walk away from the formula)
T = t0;
Market.effects = []; Market.localEffects = [];
Market.tick(t0);
for (const c of COMMODITIES) {
  assert(eps(Market.price(c.id), Market.formulaGlobal(c, t0)), `tick price == formula for ${c.id}`);
}

// 4) advance is O(1)-ish: lands on the end time's formula price
Market.advance(3_600_000, t0 + 3_600_000);
T = t0 + 3_600_000;
for (const c of COMMODITIES) {
  assert(eps(Market.price(c.id), Market.displayGlobal(c, T)), `advance lands on displayGlobal for ${c.id}`);
}

// 5) band respected
for (const c of COMMODITIES) {
  for (const t of times) {
    const p = Market.formulaGlobal(c, t);
    assert(p >= c.base * CONFIG.priceFloorMult - 1e-9 && p <= c.base * CONFIG.priceCeilMult + 1e-9,
      `${c.id} out of band @${t}: ${p}`);
  }
}

console.log(`check_market_parity: ${n} system samples + determinism/tick/advance/band ✔`);
