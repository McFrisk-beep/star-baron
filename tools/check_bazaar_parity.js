#!/usr/bin/env node
/* check_bazaar_parity.js — Phase 2 guarantee: the client's seeded bazaar board
   (js/bazaar.js genSeededMerc/Accessory/Contract) matches the server generators
   (app.gen_merc / gen_accessory / gen_contract in docs/sql/phase2_missions_bazaar.sql).

   The client renders a LOCAL board but purchases are validated by the server
   RECOMPUTING the offer from (seed, epoch, slot). If the two drift, players see
   offers whose price/reward/stats differ from what the server charges/grants.
   Both sides share Market._seed / Market._u01 (already proven equal to the SQL
   RNG by check_market_parity), so this asserts only the formula/constants layer.

   Rounding: the SQL generators cast to ::numeric before round() (half-up), which
   matches JS Math.round for these positive values — so the mirror's Math.round is
   faithful and there's no half-even vs half-up gap left to hide a divergence.

   The `sql*` functions below mirror the SQL verbatim — keep them in lockstep
   with docs/sql/phase2_missions_bazaar.sql when tuning the board.
   Run:  node tools/check_bazaar_parity.js                                       */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math });
ctx.window = ctx;
let T = 1_700_000_000_000;
ctx.Date = { now: () => T };
for (const f of ["store.js", "data.js", "content.js", "market.js", "items.js", "bazaar.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}
const { Market, Bazaar, Content } = ctx;
if (Content) Content.snapshotDefaults();
Market.init();
ctx.Game = { state: { seq: 1 } };

const seed = parts => Market._seed(["bazaar", ...parts]);
const u01 = (s, n) => Market._u01(s, n);
const round = x => Math.round(x);

// ---- SQL mirror (docs/sql/phase2_missions_bazaar.sql) ----------------------
const SHIP = {
  corvette:   { price: 11000,  firepower: 25 },
  frigate:    { price: 32000,  firepower: 55 },
  cruiser:    { price: 95000,  firepower: 120 },
  battleship: { price: 270000, firepower: 260 },
};
function sqlMerc(epoch, slot) {
  const s = seed(["merc", String(epoch), String(slot)]);
  const escorts = ["corvette", "frigate", "cruiser", "battleship"];
  const type = escorts[Math.floor(u01(s, 0) * 4) % 4];
  const def = SHIP[type];
  return {
    shipType: type,
    hireCost: round(def.price * 0.2 + def.firepower * 55),
    serviceMs: (15 + Math.floor(u01(s, 1) * 26)) * 60 * 1000,
  };
}
const REP_PRICE = { common: 1.0, uncommon: 2.2, rare: 5.0, epic: 12.0, legendary: 30.0 };
function sqlItemValue(item) {
  const base = item.primary.pct ? item.primary.amount * 8000 : item.primary.amount * 90;
  let v = base * (REP_PRICE[item.rarity] || 1.0);
  if (item.bonus) v *= 1.4;
  return round(v / 10) * 10;
}
function sqlAccessory(epoch, slot) {
  const s = seed(["acc", String(epoch), String(slot)]);
  const kinds = ["engine", "reactor", "cannon", "plating", "shield", "hold"];
  const bases = [0.04, 0.06, 12, 18, 16, 8];
  const pcts = [true, true, false, false, false, false];
  const ki = Math.floor(u01(s, 0) * 6) % 6;
  const roll = u01(s, 1);
  let rarity = "common", mult = 1.0;
  if (roll >= 0.50 && roll < 0.78) { rarity = "uncommon"; mult = 1.5; }
  else if (roll >= 0.78 && roll < 0.92) { rarity = "rare"; mult = 2.3; }
  else if (roll >= 0.92) { rarity = "epic"; mult = 3.4; }
  let amount = bases[ki] * mult * (0.8 + u01(s, 2) * 0.5);
  amount = pcts[ki] ? +amount.toFixed(3) : round(amount);
  const item = { kind: kinds[ki], rarity, primary: { amount, pct: pcts[ki] }, bonus: null };
  const val = sqlItemValue(item);
  return { price: round(val * (0.95 + u01(s, 3) * 0.30)), value: val, rarity, kind: kinds[ki], amount };
}
const DANGER_PAY = { safe: 1.0, low: 1.4, moderate: 2.0, high: 2.8, extreme: 3.8 };
function sqlContract(epoch, slot, tier) {
  const s = seed(["ct", String(epoch), String(slot)]);
  const stake = Math.max(0, tier | 0);
  const reqMult = 1 + stake * 0.3, stakeMult = 1 + stake * 0.5;
  if (u01(s, 0) < 0.16) {
    return { kind: "tip", cost: 1500 + Math.floor(u01(s, 4) * 7501) };
  }
  const tpls = [
    { type: "transport",   dangers: ["safe", "low"],                 cargo: [8, 60], fp: [0, 0],     dur: [3, 8],  reward: [600, 2200] },
    { type: "escort",      dangers: ["low", "moderate"],             cargo: [0, 0],  fp: [40, 150],  dur: [4, 9],  reward: [1800, 5000] },
    { type: "combat",      dangers: ["moderate", "high"],            cargo: [0, 0],  fp: [90, 320],  dur: [5, 10], reward: [4000, 11000] },
    { type: "smuggle",     dangers: ["moderate", "high", "extreme"], cargo: [10, 45],fp: [20, 120],  dur: [5, 12], reward: [5000, 14000] },
    { type: "assassinate", dangers: ["high", "extreme"],             cargo: [0, 0],  fp: [150, 520], dur: [6, 12], reward: [9000, 24000] },
  ];
  const tpl = tpls[Math.floor(u01(s, 1) * 5) % 5];
  const danger = tpl.dangers[Math.floor(u01(s, 2) * tpl.dangers.length) % tpl.dangers.length];
  const pay = DANGER_PAY[danger];
  const ri = (lo, hi, n) => lo + Math.floor(u01(s, n) * (hi - lo + 1));
  const fp = tpl.fp[1] > 0 ? ri(tpl.fp[0], tpl.fp[1], 5) : 0;
  const cargo = tpl.cargo[1] > 0 ? ri(tpl.cargo[0], tpl.cargo[1], 6) : 0;
  return {
    kind: "job", type: tpl.type, danger,
    minFirepower: round(fp * reqMult),
    cargoRequired: round(cargo * reqMult),
    durationMs: ri(tpl.dur[0], tpl.dur[1], 7) * 60 * 1000,
    credits: round(ri(tpl.reward[0], tpl.reward[1], 8) * pay * stakeMult / 10) * 10,
  };
}

const EX_COMMS = ["iron_ore", "silicon", "rare_earths", "hydrogen", "helium3", "water_ice",
  "foodstuffs", "synthsilk", "nanochips", "antimatter", "spice", "contraband"];
const EX_CATS = ["mineral", "gas", "agri", "tech", "luxury", "illicit"];
function sqlExtractor(epoch, slot) {
  const s = seed(["ex", String(epoch), String(slot)]);
  const r = u01(s, 0);
  if (r < 0.45) return { uid: `ex${epoch}x${slot}`, type: "specialized", scope: EX_COMMS[Math.floor(u01(s, 1) * 12) % 12], price: 14000 };
  if (r < 0.80) return { uid: `ex${epoch}x${slot}`, type: "semi", scope: EX_CATS[Math.floor(u01(s, 1) * 6) % 6], price: 9000 };
  return { uid: `ex${epoch}x${slot}`, type: "jack", scope: "all", price: 5000 };
}
function sqlComponent(epoch, slot) {
  const s = seed(["cp", String(epoch), String(slot)]);
  const kind = u01(s, 0) < 0.5 ? "rate" : "speed";
  const roll = u01(s, 1) * 100;
  let rarity, rprice;
  if (roll < 50) { rarity = "common"; rprice = 1.0; }
  else if (roll < 78) { rarity = "uncommon"; rprice = 2.2; }
  else if (roll < 92) { rarity = "rare"; rprice = 5.0; }
  else if (roll < 98) { rarity = "epic"; rprice = 12.0; }
  else { rarity = "legendary"; rprice = 30.0; }
  const mult = { common: 1, uncommon: 1.5, rare: 2.3, epic: 3.4, legendary: 5.0 }[rarity];
  const amount = +((kind === "rate" ? 0.08 : 0.06) * mult).toFixed(3);
  return { uid: `cp${epoch}c${slot}`, kind, rarity, amount, price: round(1800 * rprice) };
}

// ---- compare client (bazaar.js) vs SQL mirror ------------------------------
const epochs = [0, 1, 100, 28_900_000, Math.floor(1_700_000_000_000 / 60000)];
const tiers = [0, 3, 6];
let n = 0;
for (const epoch of epochs) {
  for (let slot = 0; slot < 18; slot++) {
    // merc (0..7 on the real board, but the generator is defined for any slot)
    const cm = Bazaar.genSeededMerc(epoch, slot), sm = sqlMerc(epoch, slot);
    assert.strictEqual(cm.shipType, sm.shipType, `merc shipType @${epoch}-${slot}`);
    assert.strictEqual(cm.hireCost, sm.hireCost, `merc hireCost @${epoch}-${slot}: js=${cm.hireCost} sql=${sm.hireCost}`);
    assert.strictEqual(cm.serviceMs, sm.serviceMs, `merc serviceMs @${epoch}-${slot}`);

    // accessory
    const ca = Bazaar.genSeededAccessory(epoch, slot), sa = sqlAccessory(epoch, slot);
    assert.strictEqual(ca.item.kind, sa.kind, `acc kind @${epoch}-${slot}`);
    assert.strictEqual(ca.item.rarity, sa.rarity, `acc rarity @${epoch}-${slot}`);
    assert.strictEqual(ca.item.value, sa.value, `acc value @${epoch}-${slot}: js=${ca.item.value} sql=${sa.value}`);
    assert.strictEqual(ca.price, sa.price, `acc price @${epoch}-${slot}: js=${ca.price} sql=${sa.price}`);

    // extractor (economic fields: type/scope/price)
    const cx = Bazaar.genSeededExtractor(epoch, slot), sx = sqlExtractor(epoch, slot);
    assert.strictEqual(cx.ex.uid, sx.uid, `extractor uid @${epoch}-${slot}`);
    assert.strictEqual(cx.ex.type, sx.type, `extractor type @${epoch}-${slot}: js=${cx.ex.type} sql=${sx.type}`);
    assert.strictEqual(cx.ex.scope, sx.scope, `extractor scope @${epoch}-${slot}: js=${cx.ex.scope} sql=${sx.scope}`);
    assert.strictEqual(cx.price, sx.price, `extractor price @${epoch}-${slot}`);

    // component (kind/rarity/amount/price)
    const cp = Bazaar.genSeededComponent(epoch, slot), sp = sqlComponent(epoch, slot);
    assert.strictEqual(cp.comp.uid, sp.uid, `component uid @${epoch}-${slot}`);
    assert.strictEqual(cp.comp.kind, sp.kind, `component kind @${epoch}-${slot}`);
    assert.strictEqual(cp.comp.rarity, sp.rarity, `component rarity @${epoch}-${slot}: js=${cp.comp.rarity} sql=${sp.rarity}`);
    assert.strictEqual(cp.comp.amount, sp.amount, `component amount @${epoch}-${slot}: js=${cp.comp.amount} sql=${sp.amount}`);
    assert.strictEqual(cp.price, sp.price, `component price @${epoch}-${slot}: js=${cp.price} sql=${sp.price}`);

    // contract (per tier)
    for (const tier of tiers) {
      const cc = Bazaar.genSeededContract(epoch, slot, tier), sc = sqlContract(epoch, slot, tier);
      assert.strictEqual(cc.kind, sc.kind, `contract kind @${epoch}-${slot} t${tier}`);
      if (sc.kind === "tip") {
        assert.strictEqual(cc.cost, sc.cost, `tip cost @${epoch}-${slot} t${tier}`);
      } else {
        assert.strictEqual(cc.type, sc.type, `contract type @${epoch}-${slot} t${tier}`);
        assert.strictEqual(cc.danger, sc.danger, `contract danger @${epoch}-${slot} t${tier}`);
        assert.strictEqual(cc.durationMs, sc.durationMs, `contract dur @${epoch}-${slot} t${tier}`);
        assert.strictEqual(cc.minFirepower, sc.minFirepower, `contract minFp @${epoch}-${slot} t${tier}`);
        assert.strictEqual(cc.cargoRequired, sc.cargoRequired, `contract cargo @${epoch}-${slot} t${tier}`);
        assert.strictEqual(cc.reward.credits, sc.credits,
          `contract reward @${epoch}-${slot} t${tier}: js=${cc.reward.credits} sql=${sc.credits}`);
      }
      n++;
    }
  }
}
console.log(`check_bazaar_parity: ${n} contract samples + merc/accessory/extractor/component across ${epochs.length} epochs ✔`);
