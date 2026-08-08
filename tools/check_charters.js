#!/usr/bin/env node
/* check_charters.js — Charter Contracts: quote, cancel curve, locking, resolve,
   migration, multi-ship grouping, cargo/defense risk. Run: node tools/check_charters.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout });
ctx.window = ctx;
let T = 1_714_000_000_000;
ctx.Date = { now: () => T };
ctx.localStorage = {
  _d: {}, getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; },
};
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

for (const f of ["store.js", "data.js", "flavor.js", "market.js", "items.js", "fleet.js",
  "economy.js", "reputation.js", "missions.js", "charters.js", "expeditions.js", "bazaar.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}

const { Market, Fleet, Charters, Economy, Missions, Expeditions, Bazaar, SYSTEMS, CHARTERCFG, DANGER } = ctx;
Market.init();

const fresh = () => ({
  credits: 50_000, positions: {}, avgCost: {}, currentSystem: "navos", travel: null,
  unlockedSystems: SYSTEMS.filter(s => s.unlock === 0).map(s => s.id),
  ships: [], charters: [], missions: [], reports: [], expeditions: [], surveyed: {},
  industries: [], extractors: {}, components: {}, items: {}, seq: 1,
  prestige: { tier: 0, multiplier: 1 }, mainShip: { type: "pinnace" },
  stats: { trades: 0, contractsDone: 0, peakNetWorth: 50_000, biggestTrade: 0 },
  reputation: { syndicate: 0, mining_combine: 0, free_trade: 0, agri_collective: 0 },
  achievements: [], listings: [], pendingContracts: [], bazaarBought: [],
  inventory: { capacity: 6, upgrades: 0 },
  bazaar: { mercs: [], contracts: [], accessories: [], extractors: [], components: [], yard: [], flagships: [] },
});
// Mirror Game.migrate's charter/route trust-boundary bits (full main.js needs too many stubs).
ctx.Game = {
  state: fresh(), timeScale: 1,
  migrate(loaded) {
    const s = Object.assign({}, fresh(), loaded);
    if (!Array.isArray(s.ships)) s.ships = [];
    for (const sh of s.ships) if (sh.status === "trading") sh.status = "idle";
    delete s.routes;
    const bands = ctx.CHARTER_BANDS || {};
    const shipUids = new Set(s.ships.map(sh => sh && sh.uid).filter(Boolean));
    const maxShips = (ctx.CHARTERCFG && ctx.CHARTERCFG.maxShips) || 6;
    s.charters = (Array.isArray(s.charters) ? s.charters : []).map(c => {
      if (!c || typeof c.id !== "string" || typeof c.band !== "string" || !bands[c.band]) return null;
      if (!(Number.isFinite(+c.durationMs) && +c.durationMs > 0)) return null;
      if (!(Number.isFinite(+c.startedAt) && Number.isFinite(+c.reward) && +c.reward >= 0)) return null;
      if (c.resolved) return null;
      let uids = Array.isArray(c.shipUids) ? c.shipUids.filter(u => typeof u === "string" && shipUids.has(u)) : [];
      if (!uids.length && typeof c.shipUid === "string" && shipUids.has(c.shipUid)) uids = [c.shipUid];
      uids = [...new Set(uids)].slice(0, maxShips);
      if (!uids.length) return null;
      const cargoByShip = {};
      let cargoTotal = 0;
      if (c.cargoByShip && typeof c.cargoByShip === "object") {
        for (const uid of uids) {
          const n = Math.max(0, Math.round(+c.cargoByShip[uid] || 0));
          cargoByShip[uid] = n;
          cargoTotal += n;
        }
      }
      return {
        id: c.id, shipUid: uids[0], shipUids: uids, band: c.band,
        durationMs: +c.durationMs, startedAt: +c.startedAt, reward: Math.round(+c.reward),
        cargoByShip, cargoTotal,
        faction: bands[c.band].faction || null,
        destroyChance: ctx.Util.clamp(+c.destroyChance || 0, 0, 0.85),
        impoundChance: ctx.Util.clamp(+c.impoundChance || 0, 0, 0.85),
        impound: !!(bands[c.band].impound > 0), resolved: false,
      };
    }).filter(Boolean);
    const onCharter = (uid) => s.charters.some(c =>
      (Array.isArray(c.shipUids) && c.shipUids.includes(uid)) || c.shipUid === uid);
    for (const sh of s.ships) {
      if (sh.status === "charter" && !onCharter(sh.uid)) sh.status = "idle";
      else if (onCharter(sh.uid) && sh.status !== "impounded") sh.status = "charter";
    }
    return s;
  },
};
ctx.Rep = {
  edgeForCategory: () => 0, onTrade() {}, get: () => 0, discount: () => 0,
  rewardMult: () => 1, onContract() {}, onContractCancel: () => 0,
  successBonus: () => 0, factionForCategory: () => "free_trade",
  sponsor: () => null, gated: () => false, meetsGate: () => true,
};
ctx.Bus = { emit() {} };
ctx.Galaxy = {
  get: (id) => ({ id, name: id, tradeable: false, planets: [{ type: "rocky", cat: "mineral", name: "P" }], pos: { x: 0.1, y: 0.1 } }),
  signatureCommodity: () => null,
};
ctx.Wars = { active: () => null };
let _senateSafety = 0;
ctx.Senate = {
  travelSpeedMult: () => 1, smuggleFailAdd: () => 0, shipClassBanned: () => false, shipBanInfo: () => null,
  windfallSurtax: () => 0, tradeTax: () => 0,
  routeSafetyAdd: () => _senateSafety,
};
ctx.SENATECFG = ctx.SENATECFG || { routeSafetyClamp: [0.1, 2.5] };
ctx.Boosts = { mag: () => 0 };

const mule = () => Object.assign(Fleet.makeShip("mule"), { name: "Old Faithful", status: "idle" });
const drift = () => Object.assign(Fleet.makeShip("drift"), { name: "Hauler", status: "idle" });
const bulk = () => Object.assign(Fleet.makeShip("bulk"), { name: "Bulk", status: "idle" });
const gunboat = () => Object.assign(Fleet.makeShip("gunboat"), { name: "Gunboat", status: "idle" });

// 1) Quote determinism — reward stored at dispatch is the base paid at resolve
ctx.Game.state = fresh();
const sh1 = mule(); ctx.Game.state.ships.push(sh1);
const d = Charters.dispatch(sh1.uid, "safe", 60, T);
assert(d.ok, d.msg);
const locked = d.charter.reward;
assert.strictEqual(locked, Charters.quote(sh1, "safe", 3600000));
assert.ok(Array.isArray(d.charter.shipUids) && d.charter.shipUids.length === 1
  && d.charter.shipUids[0] === sh1.uid, "shipUids populated");
// Force a clean resolve (no RNG destroy on safe)
T += 3600000;
const reps = Charters.resolve(T);
assert.strictEqual(reps.length, 1);
assert.strictEqual(reps[0].credits, Economy.afterTax(locked), "resolve pays locked reward (after tax)");
assert.strictEqual(ctx.Game.state.ships[0].status, "idle");

// 2) Taper monotonicity — payout rises with duration; c/hr falls
ctx.Game.state = fresh();
const sh2 = mule(); ctx.Game.state.ships.push(sh2);
let prevPay = 0, prevRate = Infinity;
for (const m of CHARTERCFG.durations) {
  const pay = Charters.quote(sh2, "safe", m * 60000);
  const rate = pay / (m / 60);
  assert(pay >= prevPay, `payout rises ${m}m: ${pay} >= ${prevPay}`);
  assert(rate <= prevRate + 1e-6, `c/hr falls ${m}m: ${rate} <= ${prevRate}`);
  prevPay = pay; prevRate = rate;
}

// 3) Band ordering; starter Mule c/hr sits below active-contract median (~15k)
const medianContractCph = 15000;
for (const mk of [mule, drift, bulk]) {
  ctx.Game.state = fresh();
  const sh = mk(); ctx.Game.state.ships.push(sh);
  const pays = DANGER.map(d => Charters.quote(sh, d.id, 3600000));
  for (let i = 1; i < pays.length; i++) assert(pays[i] > pays[i - 1], `${sh.type} band order`);
}
ctx.Game.state = fresh();
const muleOrd = mule(); ctx.Game.state.ships.push(muleOrd);
for (const d of DANGER) {
  const pay = Charters.quote(muleOrd, d.id, 3600000);
  assert(pay < medianContractCph, `mule/${d.id} c/hr ${pay} below active median`);
}

// 4) Cancel curve — §5 table on 1h / 5,000c (destroyChance 0 → full salvageCeil)
const fake = { reward: 5000, destroyChance: 0, durationMs: 3600000, startedAt: T };
const at = (min) => Charters.cancelValue(fake, T + min * 60000);
assert.strictEqual(at(5), -3500);
assert.strictEqual(at(29), -3500);
assert.strictEqual(at(30), 1750);
assert.strictEqual(at(40), 2375);
assert.strictEqual(at(50), 3000);
assert.strictEqual(at(59), 3000);
assert(at(30) > 0 && at(29) < 0, "sign flips at bailoutAt");
assert(at(59) <= Math.round(5000 * CHARTERCFG.salvageCeil));

// 5) Cancel affordability — refuse, never negative credits
ctx.Game.state = fresh();
ctx.Game.state.credits = 100;
const sh5 = mule(); ctx.Game.state.ships.push(sh5);
const d5 = Charters.dispatch(sh5.uid, "high", 60, T);
assert(d5.ok);
const fee = -Charters.cancelValue(d5.charter, T + 60000);
assert(fee > 100);
const refused = Charters.cancel(d5.charter.id, T + 60000);
assert.strictEqual(refused.ok, false);
assert.strictEqual(ctx.Game.state.credits, 100, "credits unchanged on refuse");
assert.strictEqual(ctx.Game.state.ships[0].status, "charter");

// 6) Ship locking — missions / expeditions / shipyard reject chartered hulls
ctx.Game.state = fresh();
ctx.Game.state.credits = 50_000;
const sh6 = mule(); ctx.Game.state.ships.push(sh6, mule());
const d6 = Charters.dispatch(sh6.uid, "safe", 60, T);
assert(d6.ok);
// Mission launch is async (it may claim a shared station haul) — wrap the tail.
(async () => {
const launch = await Missions._launchLocal({
  id: "c1", type: "transport", title: "t", sysName: "X", danger: "safe",
  minFirepower: 0, cargoRequired: 0, durationMs: 60000,
  reward: { credits: 100, itemChance: 0, stockChance: 0 },
}, [sh6.uid]);
assert.strictEqual(launch.ok, false, "mission rejects chartered hull");
const survey = Expeditions.start("bg1", sh6.uid, T);
assert.strictEqual(survey.ok, false, "survey rejects chartered hull");
const sell = Bazaar._sellShipLocal(sh6.uid);
assert.strictEqual(sell.ok, false, "shipyard rejects chartered hull");

// 7) Offline resolve — pays exactly once even days late
ctx.Game.state = fresh();
const sh7 = mule(); ctx.Game.state.ships.push(sh7);
const d7 = Charters.dispatch(sh7.uid, "safe", 60, T);
const startCredits = ctx.Game.state.credits;
T += 3600000 + 3 * 86400000;
const r7a = Charters.resolve(T);
assert.strictEqual(r7a.length, 1);
const mid = ctx.Game.state.credits;
const r7b = Charters.resolve(T + 1000);
assert.strictEqual(r7b.length, 0);
assert.strictEqual(ctx.Game.state.credits, mid);
assert(mid > startCredits);

// 8) No stranding — destroy last hull → starter path still available
ctx.Game.state = fresh();
ctx.Game.state.credits = 5000;
const last = mule(); ctx.Game.state.ships.push(last);
// Force destroy by patching chance
const d8 = Charters.dispatch(last.uid, "extreme", 60, T);
d8.charter.destroyChance = 1;
d8.charter.impoundChance = 0;
T += 3600000;
const _rand = Math.random;
Math.random = () => 0; // always < destroyChance
Charters.resolve(T);
Math.random = _rand;
assert.strictEqual(ctx.Game.state.ships.length, 0, "last hull destroyed");
const starterDef = ctx.SHIP_CATALOG.transport.find(d => d.price === 0 && !d.craftOnly);
assert(starterDef, "free starter exists for wiped fleet");

// 9) Migration — routes + trading → idle; bad charter rows dropped; good ones kept
const loaded = {
  credits: 2000,
  ships: [
    { uid: "s1", type: "mule", cls: "transport", name: "X", status: "trading", accessories: [] },
    { uid: "s2", type: "mule", cls: "transport", name: "Y", status: "charter", accessories: [] },
    { uid: "s3", type: "gunboat", cls: "escort", name: "Z", status: "charter", accessories: [] },
  ],
  routes: [{ id: "rt1", comm: "iron_ore", from: "a", to: "b", shipUids: ["s1"] }],
  charters: [
    { id: "ch1", shipUid: "s2", band: "high", durationMs: 3600000, startedAt: T, reward: 5000, destroyChance: 0.07 },
    { id: "ch2", shipUids: ["s2", "s3"], shipUid: "s2", band: "moderate", durationMs: 3600000, startedAt: T, reward: 8000, destroyChance: 0.04 },
    { id: "bad", shipUid: "gone", band: "high", durationMs: 3600000, startedAt: T, reward: 100 }, // missing ship
    { id: "bad2", shipUid: "s1", band: "nope", durationMs: 3600000, startedAt: T, reward: 100 }, // bad band
    null,
  ],
};
const mig = ctx.Game.migrate(loaded);
assert.strictEqual(mig.ships[0].status, "idle");
assert.strictEqual(mig.routes, undefined);
assert.strictEqual(mig.charters.length, 2);
assert.strictEqual(mig.charters[0].id, "ch1");
assert.strictEqual(mig.charters[0].shipUids.join(","), "s2");
assert.strictEqual(mig.charters[0].impound, false, "high band has no impound");
assert.strictEqual(mig.charters[1].shipUids.join(","), "s2,s3", "group charter kept");
assert.strictEqual(mig.ships[1].status, "charter", "valid charter re-locks hull");
assert.strictEqual(mig.ships[2].status, "charter", "group escort re-locked");

// 10) Senate routeSafety softens / sharpens destroy odds; impound reads config table
ctx.Game.state = fresh();
const shS = mule(); ctx.Game.state.ships.push(shS);
_senateSafety = 0;
const base = Charters.destroyChance(shS, "high", 3600000);
_senateSafety = 0.4; // Convoy Escort Mandate
const safer = Charters.destroyChance(shS, "high", 3600000);
_senateSafety = -0.4; // Lane Patrol Cuts
const riskier = Charters.destroyChance(shS, "high", 3600000);
_senateSafety = 0;
assert(safer < base && riskier > base, `senate safety swings destroy chance ${safer} < ${base} < ${riskier}`);
const dExt = Charters.dispatch(shS.uid, "extreme", 60, T);
assert.strictEqual(dExt.charter.impound, true, "impound from CHARTER_BANDS.impound > 0");
ctx.Game.state.ships.push(mule());
const dHi = Charters.dispatch(ctx.Game.state.ships[1].uid, "high", 60, T);
assert.strictEqual(dHi.charter.impound, false);

// 11) Pay scales with cargo (not firepower); fat holds riskier; escorts cut risk
ctx.Game.state = fresh();
const mPay = Charters.quote(mule(), "safe", 3600000);
const gPay = Charters.quote(gunboat(), "safe", 3600000);
const bPay = Charters.quote(bulk(), "safe", 3600000);
assert(bPay > mPay, `bulk pays more than mule ${bPay} > ${mPay}`);
assert(mPay > gPay, `mule (more cargo) pays more than gunboat ${mPay} > ${gPay}`);
assert.strictEqual(mPay, 960, "mule safe 1h cargo-only rate");

const mRisk = Charters.destroyChance(mule(), "extreme", 3600000);
const bRisk = Charters.destroyChance(bulk(), "extreme", 3600000);
const escortRisk = Charters.destroyChance([bulk(), gunboat()], "extreme", 3600000);
assert(bRisk > mRisk, `bulk riskier than mule ${bRisk} > ${mRisk}`);
assert(escortRisk < bRisk, `escort cuts bulk risk ${escortRisk} < ${bRisk}`);

// 12) Multi-ship dispatch locks all hulls; cancel frees all
ctx.Game.state = fresh();
ctx.Game.state.credits = 50_000;
const h1 = bulk(), h2 = gunboat(), spare = mule();
ctx.Game.state.ships.push(h1, h2, spare);
const dg = Charters.dispatch([h1.uid, h2.uid], "safe", 60, T);
assert(dg.ok, dg.msg);
assert.strictEqual(h1.status, "charter");
assert.strictEqual(h2.status, "charter");
assert.strictEqual(spare.status, "idle");
assert.strictEqual(Charters.ofShip(h2.uid).id, dg.charter.id);
const cg = Charters.cancel(dg.charter.id, T + 60000);
assert(cg.ok, cg.msg);
assert.strictEqual(h1.status, "idle");
assert.strictEqual(h2.status, "idle");

// 13) Group payout pro-rates by surviving cargo — losing the hauler can't cash full quote
ctx.Game.state = fresh();
ctx.Game.state.credits = 50_000;
const haul = bulk(), escort = gunboat(), spare2 = mule();
ctx.Game.state.ships.push(haul, escort, spare2);
const dPr = Charters.dispatch([haul.uid, escort.uid], "safe", 60, T);
assert(dPr.ok, dPr.msg);
assert.ok(dPr.charter.cargoTotal > 0 && dPr.charter.cargoByShip[haul.uid] > dPr.charter.cargoByShip[escort.uid]);
const lockedGroup = dPr.charter.reward;
// Simulate hauler already gone before resolve; escort still on the job.
ctx.Game.state.ships = ctx.Game.state.ships.filter(s => s.uid !== haul.uid);
dPr.charter.destroyChance = 0;
dPr.charter.impoundChance = 0;
T += 3600000;
const beforePr = ctx.Game.state.credits;
const rPr = Charters.resolve(T);
assert.strictEqual(rPr.length, 1);
assert.ok(ctx.Game.state.ships.some(s => s.uid === escort.uid), "escort survived");
const frac = Charters.payoutFrac(dPr.charter, [escort]);
assert(frac < 0.1, `escort-only cargo frac small ${frac}`);
const expected = Economy.afterTax(Math.round(lockedGroup * frac));
assert.strictEqual(rPr[0].credits, expected, "payout pro-rated to surviving cargo");
assert.strictEqual(ctx.Game.state.credits, beforePr + expected);
assert.ok(/Payout cut/i.test(rPr[0].summary || ""), "report notes cargo cut");

// 14) Phase 3 softIncomeLocal=false: free hulls, do not mint credits
ctx.Game.state = fresh();
ctx.Game.state.credits = 50_000;
const shLock = mule(); ctx.Game.state.ships.push(shLock);
const dLock = Charters.dispatch(shLock.uid, "safe", 60, T);
assert(dLock.ok, dLock.msg);
assert.strictEqual(shLock.status, "charter");
const beforeLock = ctx.Game.state.credits;
ctx.Cloud = { authoritative: () => true, pullReady: true, pullMissing: false };
assert.strictEqual(Economy.softIncomeLocal(), false, "phase 3 live → no local soft income");
T += 3600000;
const rLock = Charters.resolve(T);
assert.strictEqual(rLock.length, 1, "matured charter still resolves under Phase 3");
assert.strictEqual(shLock.status, "idle", "hull freed even when payout is server-owned");
assert.strictEqual(ctx.Game.state.credits, beforeLock, "no credit mint under Phase 3");
assert.strictEqual(rLock[0].credits, 0);
assert.strictEqual(rLock[0].success, false, "zero-credit Phase 3 return is not a win");
assert.ok(/defer/i.test(rLock[0].summary || ""), "report notes deferred payout");
assert.strictEqual(ctx.Game.state.charters.length, 1, "row kept for later app_charter_*");
assert.ok(ctx.Game.state.charters[0].deferred, "flagged deferred, not resolved");
assert.strictEqual(Charters.active().length, 0, "deferred does not count as active");
Charters.reconcileShips();
assert.strictEqual(shLock.status, "idle", "reconcile must not re-lock a deferred charter");
delete ctx.Cloud;

console.log("check_charters: ok");
})().catch(e => { console.error(e); process.exit(1); });
