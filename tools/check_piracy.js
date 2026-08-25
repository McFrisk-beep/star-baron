#!/usr/bin/env node
/* check_piracy.js — player piracy on NPC traffic
   (docs/SPACE_INTERACTIVITY.md §4, build step 4). The load-bearing claims:
   the verbs are gated by the law (§5.1 prevention: policed space offers no
   verb), a robbed delivery drains the DESTINATION shelf (§4.2 — the loot →
   scarcity → spike loop), stolen goods are flagged hot and only the hot slice
   is seizable at customs (§4.4), the outcome is a pure function of the op so
   offline equals online, a failed run still costs crime (§6.7 — high
   variance, never free), and no hull is ever lost or impounded to it.
   Run: node tools/check_piracy.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const FILES = ["store.js", "data.js", "flavor.js", "market.js", "galaxy.js", "lanes.js",
  "security.js", "pois.js", "stock.js", "stations.js", "reputation.js", "crime.js",
  "fleet.js", "charters.js", "voyage.js", "raiders.js", "traffic.js", "piracy.js"];
const T0 = 1_720_000_000_000;
const boot = () => {
  const ctx = vm.createContext({ console, Math, Date, setTimeout, clearTimeout });
  ctx.window = ctx;
  ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  for (const f of FILES) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
  }
  ctx.Game = { state: {
    seq: 1, ships: [], positions: {}, avgCost: {}, credits: 0, reputation: {},
    currentSystem: "navos", mainShip: { type: "pinnace" }, settings: {},
    items: {}, extractors: {}, industries: [], mining: [], piracy: [],
  }, timeScale: 1, requestSave() {} };
  ctx.Market.init(); ctx.Galaxy.build(); ctx.Lanes.build(); ctx.Stock.init(T0); ctx.Stations.ensure();
  return ctx;
};

// A live freighter with a comfortable outbound leg left, flying out of a
// system where rob is actually offered (not policed — §5.1), scanning forward
// from T0 minute by minute: loops are staggered, so one is always mid-leg soon.
const contactAt = (c, minLeftMs = 5 * 60 * 1000) => {
  for (let m = 0; m < 240; m++) {
    const t = T0 + m * 60000;
    const v = c.Traffic.flights(t).find(x => x.kind === "freighter" && !x.raided
      && x.manifest.length && c.Piracy.landsAt(x) - t > minLeftMs
      && c.Security.bandOf(x.plan.legs[0]).id !== "policed");
    if (v) return { v, t };
  }
  assert.fail("no interceptable freighter found in a 4h scan");
};

// ---- the verbs are gated by the law (§5.1 prevention) ----------------------
{
  const c = boot();
  const { v } = contactAt(c);
  const policed = c.Galaxy.list.find(s => c.Security.bandOf(s.id).id === "policed");
  const lawless = c.Galaxy.list.find(s => c.Security.bandOf(s.id).id === "lawless");
  assert.ok(policed && lawless, "both ends of the law exist on the map");
  assert.ok(!c.Piracy.verbs(v, policed.id).includes("rob"), "policed space offers no rob");
  assert.ok(!c.Piracy.verbs(v, policed.id).includes("toll"), "…and no toll");
  const open = c.Piracy.verbs(v, lawless.id);
  assert.ok(open.includes("rob") && open.includes("toll"), "lawless space offers both");
  assert.ok(!open.includes("escort"), "an ordinary run hires no escort");
  assert.strictEqual(c.Piracy.verbs({ ...v, raided: true }, lawless.id).length, 0,
    "an already-robbed hold offers nothing");
  const relief = { ...v, kind: "trader", relief: true };
  assert.ok(c.Piracy.verbs(relief, policed.id).includes("escort"),
    "a relief convoy hires escorts even in policed space");
  // Odds respond to the law: the same hull robs harder where patrols are thin.
  const gun = c.Fleet.makeShip("gunboat"); c.Game.state.ships.push(gun);
  assert.ok(c.Piracy.chance(gun.uid, v, lawless.id, "rob") > c.Piracy.chance(gun.uid, v, policed.id, "rob"),
    "lawless space is better robbing");
  assert.ok(c.Piracy.chance(gun.uid, v, lawless.id, "toll") >= c.Piracy.chance(gun.uid, v, lawless.id, "rob"),
    "a toll is the easier ask");
}

// ---- dispatch gating -------------------------------------------------------
{
  const c = boot();
  const { v, t } = contactAt(c);
  const sysId = v.plan.legs[0];
  c.Game.state.currentSystem = sysId;
  const gun = c.Fleet.makeShip("gunboat"); c.Game.state.ships.push(gun);
  const merc = c.Fleet.makeShip("cruiser", { mercenary: true }); c.Game.state.ships.push(merc);
  assert.strictEqual(c.Piracy.start(v, "rob", merc.uid, sysId, t).ok, false, "mercs won't fly it");
  assert.strictEqual(c.Piracy.start(v, "escort", gun.uid, sysId, t).ok, false, "no escort verb on a plain run");
  // Too late to catch: a contact about to dock is refused at dispatch.
  const gone = { ...v, plan: { ...v.plan, departedAt: t - 1000, etaMs: 2000 } };
  assert.strictEqual(c.Piracy.start(gone, "rob", gun.uid, sysId, t).ok, false, "docks before you arrive");
  const r = c.Piracy.start(v, "rob", gun.uid, sysId, t);
  assert.ok(r.ok, r.msg);
  assert.strictEqual(gun.status, "raiding", "the hull is committed");
  assert.strictEqual(c.Piracy.start(v, "rob", c.Fleet.makeShip("cruiser").uid, sysId, t).ok, false,
    "one hull per contact");
  assert.ok(r.op.resolveAt < c.Piracy.landsAt(v), "the intercept lands before the run ends");
  assert.ok(r.op.chance > 0 && r.op.chance <= (c.PIRACYCFG.chanceClamp[1]),
    "quoted odds inside the clamp");
}

// ---- a successful rob: loot, shelf drain, hot flag, crime ------------------
{
  const c = boot();
  const { v, t } = contactAt(c);
  const sysId = v.plan.legs[0];
  c.Game.state.currentSystem = sysId;
  const gun = c.Fleet.makeShip("cruiser"); c.Game.state.ships.push(gun);
  const r = c.Piracy.start(v, "rob", gun.uid, sysId, t);
  assert.ok(r.ok, r.msg);
  r.op.chance = 1;                        // force the win — the rules must hold at 100%
  const destSec = c.Stock.sectorOf(r.op.toSys);
  const before = {};
  for (const id of r.op.manifest) before[id] = c.Stock.available(destSec, id);
  const crime0 = c.Crime.value(), rep0 = c.Rep.get("free_trade");
  const made = c.Piracy.resolve(r.op.returnAt + 1);    // one late call: fight + landing
  assert.strictEqual(made.length, 1, "one verdict");
  const p = made[0].piracy;
  assert.ok(p.won && p.verb === "rob", "the rob landed");
  const loot = p.loot;
  const total = Object.values(loot).reduce((n, q) => n + q, 0);
  assert.ok(total > 0 && total <= r.op.cargo, `loot fits the hold (${total} ≤ ${r.op.cargo})`);
  // §4.2 — the delivery never arrives: the destination sector's shelf is down.
  const drained = Object.entries(loot).some(([id, q]) =>
    c.Stock.available(destSec, id) === Math.max(0, before[id] - q));
  assert.ok(drained, "the destination shelf lost the stolen units");
  // The take banks at landing, flagged hot (§4.4), at the home system's bay.
  for (const [id, q] of Object.entries(loot)) {
    assert.strictEqual(c.Game.state.positions[id] || 0, q, "loot banked in positions");
    assert.strictEqual(c.Piracy.hotQty(id), q, "…and every unit is hot");
  }
  assert.ok(c.Crime.value() === crime0 + c.CRIMECFG.gain.piracy, "piracy is on your record");
  assert.ok(c.Rep.get("free_trade") < rep0, "the League noticed");
  // §6.6-adjacent: the hull always comes home, never worse than damaged.
  assert.ok(c.Game.state.ships.includes(gun) && gun.status === "idle", "hull home, idle");
  assert.notStrictEqual(gun.status, "impounded", "never impounded");
  // Render the record: the robbed run limps on with an empty hold.
  assert.ok(c.Piracy.tookManifest(r.op.flightId, r.op.loop), "the hit is marked");
  const later = c.Traffic.flights(r.op.resolveAt + 1).find(x => x.id === r.op.flightId);
  if (later) assert.ok(later.raided && later.manifest.length === 0, "the hauler flies on emptied");
}

// ---- a failed rob still costs (§6.7) ---------------------------------------
{
  const c = boot();
  const { v, t } = contactAt(c);
  const sysId = v.plan.legs[0];
  c.Game.state.currentSystem = sysId;
  const gun = c.Fleet.makeShip("gunboat"); c.Game.state.ships.push(gun);
  const r = c.Piracy.start(v, "rob", gun.uid, sysId, t);
  r.op.chance = 0;
  const crime0 = c.Crime.value();
  const made = c.Piracy.resolve(r.op.returnAt + 1);
  const p = made[0].piracy;
  assert.ok(!p.won, "driven off");
  assert.strictEqual(Object.keys(c.Game.state.positions).length, 0, "no loot");
  assert.strictEqual(c.Game.state.credits, 0, "no credits");
  assert.strictEqual(c.Crime.value(), crime0 + c.CRIMECFG.gain.piracyFail, "the attempt is on the record");
  assert.ok(gun.dmg > 0 && gun.dmg <= c.PIRACYCFG.atkDmg[1], `a repair bill, clamped (${gun.dmg})`);
  assert.strictEqual(gun.status, "idle", "the hull still comes home");
}

// ---- toll and escort -------------------------------------------------------
{
  const c = boot();
  const { v, t } = contactAt(c);
  const sysId = v.plan.legs[0];
  c.Game.state.currentSystem = sysId;
  const gun = c.Fleet.makeShip("cruiser"); c.Game.state.ships.push(gun);
  const r = c.Piracy.start(v, "toll", gun.uid, sysId, t);
  assert.ok(r.ok, r.msg);
  r.op.chance = 1;
  const destSec = c.Stock.sectorOf(r.op.toSys);
  const before = c.Stock.available(destSec, r.op.manifest[0]);
  const crime0 = c.Crime.value();
  c.Piracy.resolve(r.op.returnAt + 1);
  assert.ok(c.Game.state.credits > 0, "the captain paid");
  assert.strictEqual(c.Stock.available(destSec, r.op.manifest[0]), before,
    "a tolled delivery still arrives — the shelf is untouched");
  assert.strictEqual(c.Crime.value(), crime0 + c.CRIMECFG.gain.toll, "menace is a lesser charge");
  assert.strictEqual(c.Piracy.hotQty(r.op.manifest[0]), 0, "no hot cargo from a toll");

  // Escort: lawful pay, standing up, record clean.
  const c2 = boot();
  const { v: v2, t: t2 } = contactAt(c2);
  const relief = { ...v2, kind: "trader", relief: true };
  const sys2 = v2.plan.legs[0];
  c2.Game.state.currentSystem = sys2;
  const esc = c2.Fleet.makeShip("gunboat"); c2.Game.state.ships.push(esc);
  const r2 = c2.Piracy.start(relief, "escort", esc.uid, sys2, t2);
  assert.ok(r2.ok, r2.msg);
  const crime2 = c2.Crime.value(), rep2 = c2.Rep.get("free_trade");
  c2.Piracy.resolve(r2.op.returnAt + 1);
  assert.ok(c2.Game.state.credits > 0, "the sponsor pays");
  assert.strictEqual(c2.Crime.value(), crime2, "escorting is legal");
  assert.ok(c2.Rep.get("free_trade") > rep2, "the League approves");
}

// ---- offline == online -----------------------------------------------------
// Dispatch, close the tab: one late resolve must equal staged resolves.
{
  const chunk = boot(), drip = boot();
  const setup = c => {
    const { v, t } = contactAt(c);
    const sysId = v.plan.legs[0];
    c.Game.state.currentSystem = sysId;
    const gun = c.Fleet.makeShip("cruiser"); c.Game.state.ships.push(gun);
    const r = c.Piracy.start(v, "rob", gun.uid, sysId, t);
    return { op: r.op, gun };
  };
  const a = setup(chunk), b = setup(drip);
  assert.strictEqual(a.op.id, b.op.id, "same op id in both runs (the seed)");
  chunk.Piracy.resolve(a.op.returnAt + 5000);
  drip.Piracy.resolve(b.op.resolveAt + 1);
  drip.Piracy.resolve(b.op.returnAt + 1);
  drip.Piracy.resolve(b.op.returnAt + 5000);
  assert.deepStrictEqual(chunk.Game.state.positions, drip.Game.state.positions, "same loot either way");
  assert.strictEqual(chunk.Game.state.credits, drip.Game.state.credits, "same credits");
  assert.strictEqual(chunk.Crime.value(), drip.Crime.value(), "same record");
  assert.ok(Math.abs((a.gun.dmg || 0) - (b.gun.dmg || 0)) < 1e-9, "same wear");
  assert.strictEqual(a.gun.status, b.gun.status, "same hull state");
  // And the roll itself is pure.
  assert.deepStrictEqual(chunk.Piracy.rollOutcome(a.op), chunk.Piracy.rollOutcome(a.op),
    "rollOutcome is a pure function of the op");
}

// ---- hot cargo at the customs gate (§4.4) ----------------------------------
// Separate boot with economy.js: only the HOT slice of a stack is seizable,
// and seizure sheds the flag with the goods.
{
  const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout });
  ctx.window = ctx;
  ctx.Date = { now: () => T0 };
  ctx.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  for (const f of ["store.js", "data.js", "flavor.js", "market.js", "galaxy.js", "stock.js",
    "stations.js", "extractors.js", "economy.js", "fleet.js", "reputation.js", "piracy.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
  }
  ctx.Market.init(); ctx.Galaxy.build(); ctx.Stock.init(T0); ctx.Stations.ensure();
  ctx.Game = { state: {
    credits: 10000, positions: {}, avgCost: {}, currentSystem: "navos", travel: null,
    unlockedSystems: [], reputation: {}, prestige: { tier: 0, multiplier: 1 },
    stats: {}, achievements: [], ships: [], items: {}, orders: [], seq: 1,
    mainShip: { type: "pinnace" }, extractors: {}, industries: [], listings: [], missions: [],
    hot: {},
  }, requestSave() {}, timeScale: 1 };
  ctx.Bus = { emit() {} };
  ctx.UI = { toast() {} };
  ctx.Bazaar = { itemsValue: () => 0 };
  ctx.Boosts = { mag: () => 0 };
  ctx.Senate = { smuggleFailAdd: () => 0, travelSpeedMult: () => 1 };
  const comm = ctx.COMMODITIES.find(c => c.cat !== "illicit" && !c.craftOnly && c.rarity !== "exotic");
  ctx.Game.state.positions[comm.id] = 25;      // 10 stolen on top of 15 bought fair
  ctx.Game.state.hot[comm.id] = 10;
  assert.strictEqual(ctx.Piracy.hotQty(comm.id), 10, "hot clamps to what is held");
  const rnd = Math.random;
  Math.random = () => 0;                        // certain scan, minimum slice
  const ev = ctx.Economy.customsScan("navos");
  Math.random = rnd;
  assert.ok(ev && ev.commId === comm.id, "hot goods draw the scan");
  assert.ok(ev.qty <= 10, `only the hot slice is seizable (${ev.qty})`);
  assert.ok(ctx.Game.state.positions[comm.id] >= 15, "the legitimate stack is untouched");
  assert.strictEqual(ctx.Piracy.hotQty(comm.id), 10 - ev.qty, "the flag left with the goods");
  // Clean hold, no illicit: the scan has nothing to find.
  ctx.Game.state.hot = {};
  Math.random = () => 0;
  assert.strictEqual(ctx.Economy.customsScan("navos"), null, "nothing hot, nothing illicit — no scan hit");
  Math.random = rnd;
}

console.log("OK check_piracy");
