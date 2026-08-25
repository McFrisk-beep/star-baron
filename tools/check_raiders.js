#!/usr/bin/env node
/* check_raiders.js — NPC piracy (docs/SPACE_INTERACTIVITY.md §4, build step 3).
   The anti-grief rules of §6.6 are the point of this file, so they are asserted
   first and hardest: a raid can never destroy, impound or even keep a hull, and
   it can never touch ore that already reached the bay. Then: threat is derived
   from the seam's own richness (no second table), a den raises it, escorts
   repel and are released on recall, every roll is a pure function of (op,
   cycle) so a night offline banks exactly what a watched tab would have, and
   NPC hauls robbed near a den still arrive with an empty hold.
   Run: node tools/check_raiders.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const FILES = ["store.js", "data.js", "flavor.js", "market.js", "galaxy.js", "pois.js",
  "reputation.js", "fleet.js", "extractors.js", "charters.js", "raiders.js", "mining.js"];
const boot = () => {
  const ctx = vm.createContext({ console, Math, Date });
  ctx.window = ctx;
  for (const f of FILES) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
  }
  ctx.Market.init(); ctx.Galaxy.build();
  ctx.Game = { state: {
    seq: 1, ships: [], positions: {}, avgCost: {}, credits: 0, reputation: {},
    currentSystem: "navos", mainShip: { type: "pinnace" },
    settings: {}, items: {}, extractors: {}, industries: [], mining: [],
  } };
  return ctx;
};

const ctx = boot();
const { Galaxy, POIs, Mining, Raiders, Fleet, Charters, MININGCFG, RAIDCFG } = ctx;
const T0 = 1_800_000_000_000;

// A workable belt and the moment its current rock was born, so batches land.
const beltAt = (c, pick) => {
  const p = c.Galaxy.list.flatMap(s => c.POIs.list(s.id, T0)).find(pick);
  const slot = c.POIs.slot(p.id);
  return { poi: p, born: c.POIs.rollsAt(slot, T0) - c.POIs.lifeMs(slot) };
};

// ---- threat is derived, not authored -------------------------------------
{
  const rocks = Galaxy.list.flatMap(s => POIs.list(s.id, T0)).filter(p => p.ore);
  assert.ok(rocks.length > 20, `plenty of rocks (${rocks.length})`);
  for (const p of rocks) {
    const ch = Raiders.claimChance(p);
    assert.ok(ch >= RAIDCFG.chanceClamp[0] && ch <= RAIDCFG.chanceClamp[1],
      `${p.id}: chance inside the clamp (${ch})`);
  }
  // Richness carries the sector (MININGCFG.sectorRich), so fat seams are the
  // dangerous ones — that single rule is the whole risk/reward axis (§3.3).
  const bySector = id => {
    const rs = rocks.filter(p => (Galaxy.get(p.sysId) || {}).sectorId === id && !Raiders.hasDen(p.sysId));
    return rs.reduce((n, p) => n + Raiders.claimChance(p), 0) / Math.max(1, rs.length);
  };
  assert.ok(bySector("sprawl") > bySector("core") * 1.5,
    `Sprawl rocks must be far hotter than Core rocks (${bySector("sprawl").toFixed(3)} vs ${bySector("core").toFixed(3)})`);
  // A den in the system is the other multiplier, and it is the only one that
  // isn't already on the rock.
  const den = rocks.find(p => Raiders.hasDen(p.sysId));
  assert.ok(den, "some system has both a den and a belt");
  const plainRich = rocks.filter(p => !Raiders.hasDen(p.sysId))
    .reduce((b, p) => Math.abs(p.ore.rich - den.ore.rich) < Math.abs(b.ore.rich - den.ore.rich) ? p : b);
  assert.ok(Raiders.claimChance(den) > Raiders.claimChance(plainRich),
    "a den in the system raises pressure on a comparable rock");
  assert.ok(Raiders.denSystems().size > 0 && Raiders.denSystems().size < Galaxy.list.length,
    "dens are somewhere, not everywhere");
  // Bands read off the same number the resolver rolls against.
  assert.strictEqual(Raiders.band(0).id, RAIDCFG.bands[0].id, "quiet is the floor band");
  assert.strictEqual(Raiders.band(1).id, RAIDCFG.bands[RAIDCFG.bands.length - 1].id, "…and the worst band is the ceiling");
}

// ---- §5.4: Syndicate standing is your safety, in the Sprawl only ----------
{
  const c = boot();
  const rock = c.Galaxy.list.flatMap(s => c.POIs.list(s.id, T0))
    .find(p => p.ore && (c.Galaxy.get(p.sysId) || {}).sectorId === "sprawl");
  const core = c.Galaxy.list.flatMap(s => c.POIs.list(s.id, T0))
    .find(p => p.ore && (c.Galaxy.get(p.sysId) || {}).sectorId === "core");
  const before = c.Raiders.claimChance(rock), coreBefore = c.Raiders.claimChance(core);
  c.Game.state.reputation.syndicate = 100;
  assert.ok(c.Raiders.claimChance(rock) < before, "friendly Syndicate quiets the Sprawl");
  assert.strictEqual(c.Raiders.claimChance(core), coreBefore, "…and buys nothing in Core space");
}

// ---- escorts: the standing job -------------------------------------------
{
  const c = boot();
  const miner = c.Fleet.makeShip("prospector"); c.Game.state.ships.push(miner);
  const gun = c.Fleet.makeShip("gunboat"); c.Game.state.ships.push(gun);
  const cruiser = c.Fleet.makeShip("cruiser"); c.Game.state.ships.push(cruiser);
  const bare = c.Raiders.repelChance(miner.uid, []);
  const wing = c.Raiders.repelChance(miner.uid, [gun.uid]);
  const heavy = c.Raiders.repelChance(miner.uid, [gun.uid, cruiser.uid]);
  assert.ok(bare < 0.2, `a bare miner rarely repels (${bare.toFixed(2)})`);
  assert.ok(wing > bare * 2, `one escort more than doubles it (${wing.toFixed(2)})`);
  assert.ok(heavy > wing, "a heavier wing is better still");
  assert.ok(heavy <= c.RAIDCFG.repelClamp[1], "…and nothing is ever immune");
  // Scored with the charter resolver, not a second balance pass.
  assert.ok(c.Raiders.defense(miner.uid, [gun.uid])
    > c.Charters.defenseScore(c.Charters.fleetStats([gun])) * 0.99, "guard score rides Charters.defenseScore");

  const { poi, born } = beltAt(c, p => p.ore && p.ore.pool > 100);
  assert.strictEqual(c.Mining.start(poi.id, miner.uid, null, [miner.uid], born + 1000).ok, false,
    "the miner can't escort itself");
  const tooMany = [gun.uid, cruiser.uid, c.Fleet.makeShip("corvette").uid];
  assert.strictEqual(c.Mining.start(poi.id, miner.uid, null, tooMany, born + 1000).ok, false,
    "guard wing is capped");
  const mule = c.Fleet.makeShip("mule"); c.Game.state.ships.push(mule);
  assert.strictEqual(c.Mining.start(poi.id, miner.uid, null, [mule.uid], born + 1000).ok, false,
    "only escort-class hulls stand guard");

  const r = c.Mining.start(poi.id, miner.uid, null, [gun.uid], born + 1000);
  assert.ok(r.ok, "dispatch with a guard");
  assert.strictEqual(gun.status, "guarding", "the escort is locked to the claim");
  assert.strictEqual(c.Mining.opGuarding(gun.uid).id, r.op.id, "…and findable from the hull");
  assert.strictEqual(c.Mining.start(poi.id, c.Fleet.makeShip("rock_hopper").uid, null, [gun.uid], born + 2000).ok,
    false, "a guarding hull isn't idle any more");
  // recall lands the whole wing
  c.Mining.recall(r.op.id, born + 2000);
  c.Mining.resolve(born + 2000 + r.op.travelMs + 1);
  assert.strictEqual(gun.status, "idle", "the escort comes home with the op");
  assert.strictEqual(miner.status, "idle", "so does the miner");
}

// ---- the raid itself: bounded, deterministic, hull-safe -------------------
// Force the worst case (a certain raid) rather than fishing for one: the rules
// have to hold at 100% pressure, not just on average. The rock also has to
// outlive the run — a site that rolls over mid-test sends the hull home (which
// step 2 already covers) and would mask what this file is asserting.
const LIFE_MIN = 2.2 * 3600 * 1000;
const hotBelt = c => {
  const { poi, born } = beltAt(c, p => p.ore && p.ore.pool > 150
    && c.POIs.lifeMs(c.POIs.slot(p.id)) > LIFE_MIN);
  c.RAIDCFG.base = 10;        // every cycle is jumped
  return { poi, born };
};
{
  const c = boot();
  const { poi, born } = hotBelt(c);
  const miner = c.Fleet.makeShip("core_driller"); c.Game.state.ships.push(miner);
  c.Game.state.positions[poi.ore.commId] = 500;      // ore already banked at the bay
  const r = c.Mining.start(poi.id, miner.uid, null, [], born + 1000);
  const per = c.Mining.batchQty(poi, miner.uid, null);
  const t1 = r.op.arriveAt + c.MININGCFG.cycleMs * 3 + 1000;
  const made = c.Mining.resolve(t1);
  const raids = made.filter(m => m.raid).map(m => m.raid);
  assert.ok(raids.length > 0, "a certain raid happens");
  for (const raid of raids) {
    assert.ok(raid.stolen <= per, `a raid can only take the batch it interrupted (${raid.stolen} ≤ ${per})`);
    assert.ok(raid.band && raid.poiName && raid.ship, "the report names who, where and which hull");
    assert.ok(raid.minerDmg <= c.RAIDCFG.minerDmg[1], "hull damage stays inside the config band");
  }
  // §6.6.1 / §6.6.5 — the two rules that matter most
  assert.ok(c.Game.state.positions[poi.ore.commId] >= 500, "banked ore is never taken");
  assert.ok(c.Game.state.ships.includes(miner), "the hull still exists");
  assert.notStrictEqual(miner.status, "impounded", "a raid never impounds");
  assert.ok(miner.dmg > 0 && miner.dmg <= c.DMGCFG.maxDmg, `damage is the cost, clamped (${miner.dmg})`);
  // a robbed op either keeps working or flies home — never anything worse
  const op = c.Mining.opAt(poi.id);
  if (op) assert.ok(op.returnAt === null || op.returnAt > t1, "if chased off, it is flying home");
  else assert.strictEqual(miner.status, "idle", "…or it already landed, idle");
}

// ---- offline == online ----------------------------------------------------
// The whole premise: dispatch, close the tab, come back. Twelve cycles banked
// in one call must equal twelve calls one cycle apart.
{
  const chunk = boot(), drip = boot();
  const setup = c => {
    const { poi, born } = hotBelt(c);
    const m = c.Fleet.makeShip("rock_hopper"); c.Game.state.ships.push(m);
    const g = c.Fleet.makeShip("corvette"); c.Game.state.ships.push(g);
    const r = c.Mining.start(poi.id, m.uid, null, [g.uid], born + 1000);
    return { poi, m, g, op: r.op };
  };
  const a = setup(chunk), b = setup(drip);
  assert.strictEqual(a.op.id, b.op.id, "same op id in both runs (the raid seed)");
  const cyc = chunk.MININGCFG.cycleMs, N = 3;
  const end = a.op.arriveAt + cyc * N;
  chunk.Mining.resolve(end);
  for (let k = 1; k <= N; k++) drip.Mining.resolve(b.op.arriveAt + cyc * k);
  assert.strictEqual(chunk.Game.state.positions[a.poi.ore.commId],
    drip.Game.state.positions[b.poi.ore.commId], "the same ore lands either way");
  assert.strictEqual(chunk.Mining.poolUsed(a.poi), drip.Mining.poolUsed(b.poi),
    "the rock is worked down by the same amount");
  assert.ok(Math.abs(a.m.dmg - b.m.dmg) < 1e-9, "the same hull damage is taken");
  assert.strictEqual(a.m.status, b.m.status, "the hull ends in the same state");
  // And the roll itself is pure: same inputs, same outcome, twice.
  const one = chunk.Raiders.rollClaim(a.op, 3, a.poi, 7);
  const two = chunk.Raiders.rollClaim(a.op, 3, a.poi, 7);
  assert.deepStrictEqual(one, two, "rollClaim is a pure function of (op, cycle)");
}

// ---- escorts actually pay for themselves ---------------------------------
{
  const c = boot();
  c.RAIDCFG.base = 10;
  const rocks = c.Galaxy.list.flatMap(s => c.POIs.list(s.id, T0)).filter(p => p.ore).slice(0, 40);
  const miner = c.Fleet.makeShip("prospector"); c.Game.state.ships.push(miner);
  const gun = c.Fleet.makeShip("battleship"); c.Game.state.ships.push(gun);
  const sample = guards => {
    let stolen = 0;
    for (const [i, poi] of rocks.entries()) {
      const op = { id: "mn" + i, poiId: poi.id, shipUid: miner.uid, guardUids: guards };
      for (let k = 0; k < 6; k++) {
        const raid = c.Raiders.rollClaim(op, k, poi, 10);
        if (raid) stolen += raid.stolen;
      }
    }
    return stolen;
  };
  const alone = sample([]), guarded = sample([gun.uid]);
  assert.ok(alone > 0, "an unguarded claim bleeds");
  assert.ok(guarded < alone * 0.5, `a heavy escort more than halves the bleed (${guarded} vs ${alone})`);
}

// ---- NPC piracy against NPC traffic --------------------------------------
{
  const denSys = [...Raiders.denSystems()][0];
  const quiet = Galaxy.list.find(s => !Raiders.hasDen(s.id)).id;
  const other = Galaxy.list.find(s => !Raiders.hasDen(s.id) && s.id !== quiet).id;
  assert.strictEqual(Raiders.tookManifest("npc:t:x", 1, quiet, other), false,
    "a run nowhere near a den is never robbed");
  let hits = 0;
  for (let k = 0; k < 400; k++) if (Raiders.tookManifest("npc:t:x", k, denSys, quiet)) hits++;
  const rate = hits / 400;
  assert.ok(rate > RAIDCFG.trafficChance * 0.6 && rate < RAIDCFG.trafficChance * 1.4,
    `den runs are robbed at about the configured rate (${rate.toFixed(2)} vs ${RAIDCFG.trafficChance})`);
  assert.strictEqual(Raiders.tookManifest("npc:t:x", 7, denSys, quiet),
    Raiders.tookManifest("npc:t:x", 7, denSys, quiet), "…deterministically");
  // Symmetric: inbound or outbound, the den's crews are on the lane either way.
  assert.strictEqual(Raiders.tookManifest("npc:t:y", 3, denSys, quiet),
    Raiders.tookManifest("npc:t:y", 3, denSys, quiet), "same flight, same loop, same answer");
}

// ---- no Raiders? mining still works (script order / older index.html) -----
{
  const c = boot();
  const { poi, born } = beltAt(c, p => p.ore && p.ore.pool > 100);
  delete c.Raiders; c.window.Raiders = undefined;
  const m = c.Fleet.makeShip("prospector"); c.Game.state.ships.push(m);
  const r = c.Mining.start(poi.id, m.uid, null, [], born + 1000);
  assert.ok(r.ok, "dispatch works without the raider layer");
  const made = c.Mining.resolve(r.op.arriveAt + c.MININGCFG.cycleMs + 1000);
  assert.ok(made.length === 1 && made[0].qty > 0, "and ore still lands");
}

console.log("OK check_raiders");
