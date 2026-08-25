#!/usr/bin/env node
/* check_mining.js — asteroid mining (docs/SPACE_INTERACTIVITY.md §3, step 2).
   Belt POIs carry a seeded seam; only miner-class hulls dispatch; batches are
   a pure function of the clock, UNTAXED, land in positions, and deplete the
   rock's finite epoch pool; offline banking is capped; the pool regenerates
   on the epoch; recall lands the hull idle; a rig (extractor) boosts the take
   and is locked while riding the op; signed-in dispatch is gated.
   Run: node tools/check_mining.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const FILES = ["store.js", "data.js", "flavor.js", "galaxy.js", "pois.js", "fleet.js", "extractors.js", "mining.js"];
const boot = () => {
  const ctx = vm.createContext({ console, Math, Date });
  ctx.window = ctx;
  for (const f of FILES) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
  }
  ctx.Galaxy.build();
  ctx.Game = { state: {
    seq: 1, ships: [], positions: {}, avgCost: {}, credits: 0,
    currentSystem: "navos", mainShip: { type: "pinnace" },
    settings: {}, items: {}, extractors: {}, industries: [],
  } };
  return ctx;
};

const ctx = boot();
const { Galaxy, POIs, Mining, Fleet, Extractors, MININGCFG } = ctx;
const T0 = 1_800_000_000_000;   // fixed clock — everything below is clock math

// ---- seeded seams ---------------------------------------------------------
let belts = 0;
for (const sys of Galaxy.list) {
  for (const p of POIs.list(sys.id)) {
    if (p.type === "belt") {
      belts++;
      assert.ok(p.ore && p.ore.commId && p.ore.pool > 0, `${p.id}: belt has a seam`);
      assert.ok(p.ore.rich > 0.3 && p.ore.rich < 2.5, `${p.id}: richness sane (${p.ore.rich})`);
    } else {
      assert.ok(!p.ore, `${p.id}: only belts carry ore`);
    }
  }
}
assert.ok(belts > 20, `plenty of belts (${belts})`);

// a belt to work: reachable rich-ish rock with a decent pool
const belt = Galaxy.list.flatMap(s => POIs.list(s.id)).find(p => p.ore && p.ore.pool > 100);
assert.ok(belt, "found a workable belt");

// ---- dispatch gates -------------------------------------------------------
const s = ctx.Game.state;
const miner = Fleet.makeShip("core_driller"); s.ships.push(miner);
const mule = Fleet.makeShip("mule"); s.ships.push(mule);
assert.strictEqual(Mining.start(belt.id, mule.uid, null, T0).ok, false, "non-miner hulls are refused");
assert.strictEqual(Mining.start("nope:0", miner.uid, null, T0).ok, false, "unknown POI refused");

const r = Mining.start(belt.id, miner.uid, null, T0);
assert.ok(r.ok, "miner dispatches");
assert.strictEqual(miner.status, "mining", "hull is committed");
assert.ok(r.op.arriveAt > T0, "travel leg first");
assert.strictEqual(Mining.start(belt.id, miner.uid, null, T0).ok, false, "one op per rock / busy hull");

// ---- batches: untaxed clock math into positions ---------------------------
const per = Mining.batchQty(belt, miner.uid, null);
assert.ok(per >= 1, `per-batch qty (${per})`);
const t1 = r.op.arriveAt + MININGCFG.cycleMs * 3 + 1000;   // 3 full cycles banked
const made = Mining.resolve(t1);
assert.ok(made.length === 1 && made[0].mining && made[0].tax === 0, "one untaxed mining entry");
assert.strictEqual(made[0].qty, per * 3, "3 batches banked");
assert.strictEqual(s.positions[belt.ore.commId], per * 3, "ore landed in positions");
assert.strictEqual(Mining.poolLeft(belt, t1), belt.ore.pool - per * 3, "pool depleted by the take");
assert.strictEqual(s.avgCost[belt.ore.commId], 0, "mined ore carries zero cost basis");

// ---- offline cap ----------------------------------------------------------
{
  const c2 = boot();
  const b2 = c2.Galaxy.list.flatMap(x => c2.POIs.list(x.id)).find(p => p.ore && p.ore.pool > 100);
  const m2 = c2.Fleet.makeShip("prospector"); c2.Game.state.ships.push(m2);
  const r2 = c2.Mining.start(b2.id, m2.uid, null, T0);
  const far = r2.op.arriveAt + c2.MININGCFG.cycleMs * 500;   // ~6 weeks away
  const got = c2.Mining.resolve(far);
  const per2 = c2.Mining.batchQty(b2, m2.uid, null);
  assert.ok(got[0].qty <= Math.min(per2 * c2.MININGCFG.maxCyclesPerResolve, b2.ore.pool),
    `offline banking capped (${got[0].qty})`);
}

// ---- depletion + epoch regeneration --------------------------------------
{
  const c3 = boot();
  const b3 = c3.Galaxy.list.flatMap(x => c3.POIs.list(x.id)).find(p => p.ore && p.ore.pool > 100);
  const m3 = c3.Fleet.makeShip("belt_leviathan"); c3.Game.state.ships.push(m3);
  const r3 = c3.Mining.start(b3.id, m3.uid, null, T0);
  let t = r3.op.arriveAt;
  for (let i = 0; i < 60 && c3.Mining.poolLeft(b3, t) > 0; i++) {
    t += c3.MININGCFG.cycleMs * c3.MININGCFG.maxCyclesPerResolve;
    if (Math.floor(t / c3.MININGCFG.epochMs) !== Math.floor(T0 / c3.MININGCFG.epochMs)) break; // stop before regen
    c3.Mining.resolve(t);
  }
  const sameEpoch = Math.floor(t / c3.MININGCFG.epochMs) === Math.floor(T0 / c3.MININGCFG.epochMs);
  if (sameEpoch && c3.Mining.poolLeft(b3, t) === 0) {
    const held = c3.Game.state.positions[b3.ore.commId];
    c3.Mining.resolve(t + c3.MININGCFG.cycleMs * 2);
    if (Math.floor((t + c3.MININGCFG.cycleMs * 2) / c3.MININGCFG.epochMs) === Math.floor(t / c3.MININGCFG.epochMs))
      assert.strictEqual(c3.Game.state.positions[b3.ore.commId], held, "worked-out rock mints nothing");
  }
  // epoch rollover regenerates the pool
  const tNext = (Math.floor(t / c3.MININGCFG.epochMs) + 1) * c3.MININGCFG.epochMs + 1000;
  assert.strictEqual(c3.Mining.poolLeft(b3, tNext), b3.ore.pool, "pool regenerates on the epoch");
}

// ---- rigs reuse extractors wholesale --------------------------------------
{
  const c4 = boot();
  const b4 = c4.Galaxy.list.flatMap(x => c4.POIs.list(x.id)).find(p => p.ore && p.ore.pool > 100);
  const m4 = c4.Fleet.makeShip("rock_hopper"); c4.Game.state.ships.push(m4);
  const ex = { uid: "ex1", type: "specialized", scope: b4.ore.commId, name: "Test Rig", components: [] };
  c4.Extractors.acquire(ex);
  const bare = c4.Mining.batchQty(b4, m4.uid, null);
  const rigged = c4.Mining.batchQty(b4, m4.uid, "ex1");
  assert.ok(rigged > bare, `specialized rig boosts the take (${bare} → ${rigged})`);
  const r4 = c4.Mining.start(b4.id, m4.uid, "ex1", T0);
  assert.ok(r4.ok, "dispatch with rig");
  assert.ok(c4.Extractors.installedSet().has("ex1"), "rig locked while riding the op");
  assert.ok(!c4.Extractors.unequipped().some(e => e.uid === "ex1"), "rig off the shelf");
  // recall lands the hull idle and frees the rig
  const rec = c4.Mining.recall(r4.op.id, T0 + 1000);
  assert.ok(rec.ok, "recall accepted");
  c4.Mining.resolve(T0 + 1000 + r4.op.travelMs + 1);
  assert.strictEqual(m4.status, "idle", "hull home and idle");
  assert.strictEqual(c4.Mining.list().length, 0, "op closed out");
  assert.ok(!c4.Extractors.installedSet().has("ex1"), "rig freed");
}

// ---- signed-in gate -------------------------------------------------------
{
  const c5 = boot();
  const b5 = c5.Galaxy.list.flatMap(x => c5.POIs.list(x.id)).find(p => p.ore);
  const m5 = c5.Fleet.makeShip("prospector"); c5.Game.state.ships.push(m5);
  c5.Economy = { softIncomeLocal: () => false, refreshNetWorth() {}, checkAchievements() {} };
  assert.strictEqual(c5.Mining.start(b5.id, m5.uid, null, T0).ok, false,
    "server-ledger saves can't dispatch until the mining SQL phase");
}

console.log(`check_mining: OK — ${belts} belts with seams, per-batch ${per}, pool math + gates hold`);
