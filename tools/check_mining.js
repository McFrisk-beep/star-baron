#!/usr/bin/env node
/* check_mining.js — asteroid mining (docs/SPACE_INTERACTIVITY.md §3, step 2).
   Belt POIs carry a seeded seam; only miner-class hulls dispatch; batches are
   a pure function of the clock, UNTAXED, land in positions, and deplete the
   rock's finite pool; offline banking is capped; NPC crews work the seam out
   over the site's life so a rock nobody touches still empties, and when the
   site rolls over a fresh rock replaces it and any parked op flies home;
   recall lands the hull idle; a rig (extractor) boosts the take and is locked
   while riding the op; signed-in dispatch is gated.
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
const { Galaxy, POIs, Mining, Fleet, Extractors, MININGCFG, POICFG } = ctx;
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
const belt = Galaxy.list.flatMap(s => POIs.list(s.id, T0)).find(p => p.ore && p.ore.pool > 100);
assert.ok(belt, "found a workable belt");

// ---- dispatch gates -------------------------------------------------------
const s = ctx.Game.state;
const miner = Fleet.makeShip("core_driller"); s.ships.push(miner);
const mule = Fleet.makeShip("mule"); s.ships.push(mule);
assert.strictEqual(Mining.start(belt.id, mule.uid, null, T0).ok, false, "non-miner hulls are refused");
assert.strictEqual(Mining.start("nope:0", miner.uid, null, T0).ok, false, "unknown POI refused");

const beltSlot = POIs.slot(belt.id);
const BORN = POIs.rollsAt(beltSlot, T0) - POIs.lifeMs(beltSlot);   // this rock's birth
const r = Mining.start(belt.id, miner.uid, null, BORN + 1000);
assert.ok(r.ok, "miner dispatches");
assert.strictEqual(miner.status, "mining", "hull is committed");
assert.ok(r.op.arriveAt > r.op.startedAt, "travel leg first");
assert.strictEqual(Mining.start(belt.id, miner.uid, null, BORN + 1000).ok, false, "one op per rock / busy hull");

// ---- batches: untaxed clock math into positions ---------------------------
const per = Mining.batchQty(belt, miner.uid, null);
assert.ok(per >= 1, `per-batch qty (${per})`);
const t1 = r.op.arriveAt + MININGCFG.cycleMs * 3 + 1000;   // 3 full cycles banked
const made = Mining.resolve(t1);
assert.ok(made.length === 1 && made[0].mining && made[0].tax === 0, "one untaxed mining entry");
assert.strictEqual(made[0].qty, per * 3, "3 batches banked");
assert.strictEqual(s.positions[belt.ore.commId], per * 3, "ore landed in positions");
assert.strictEqual(Mining.poolUsed(belt), per * 3, "your take is the stored field");
// reading a rock must never create a save row (the scene asks every frame)
{
  const fresh = boot();
  const fp = fresh.Galaxy.list.flatMap(x => fresh.POIs.list(x.id, T0)).find(p => p.ore);
  fresh.Mining.poolLeft(fp, T0); fresh.Mining.npcTaken(fp, T0);
  assert.strictEqual(Object.keys(fresh.Mining.pools()).length, 0,
    "looking at a rock writes nothing to the save");
}
assert.strictEqual(Mining.poolLeft(belt, t1),
  belt.ore.pool - Mining.npcTaken(belt, t1) - per * 3, "pool nets off both you and the crews");
assert.strictEqual(s.avgCost[belt.ore.commId], 0, "mined ore carries zero cost basis");

// ---- offline cap ----------------------------------------------------------
{
  const c2 = boot();
  const b2 = c2.Galaxy.list.flatMap(x => c2.POIs.list(x.id, T0)).find(p => p.ore && p.ore.pool > 100);
  const m2 = c2.Fleet.makeShip("prospector"); c2.Game.state.ships.push(m2);
  const slot2 = c2.POIs.slot(b2.id);
  const born2 = c2.POIs.rollsAt(slot2, T0) - c2.POIs.lifeMs(slot2);
  const r2 = c2.Mining.start(b2.id, m2.uid, null, born2 + 1000);
  // away for most of the site's life: capped by the batch cap AND by whatever
  // the NPC crews left behind
  const far = born2 + c2.POIs.lifeMs(slot2) * 0.9;
  const got = c2.Mining.resolve(far);
  const per2 = c2.Mining.batchQty(b2, m2.uid, null);
  const banked = got.length ? got[0].qty : 0;
  assert.ok(banked <= per2 * c2.MININGCFG.maxCyclesPerResolve, `offline banking capped (${banked})`);
  assert.ok(banked <= b2.ore.pool, "never more than the rock held");
}

// ---- NPC crews work the seam out over the site's life ---------------------
{
  const c3 = boot();
  const b3 = c3.Galaxy.list.flatMap(x => c3.POIs.list(x.id, T0)).find(p => p.ore);
  const slot3 = c3.POIs.slot(b3.id);
  const life = c3.POIs.lifeMs(slot3);
  assert.ok(life >= c3.POICFG.churnMinMs && life <= c3.POICFG.churnMaxMs,
    `site life inside the POICFG window (${Math.round(life / 60000)}m)`);
  const rolls = c3.POIs.rollsAt(slot3, T0);
  const born = rolls - life;
  assert.strictEqual(c3.Mining.npcTaken(b3, born), 0, "a fresh rock is untouched");
  const mid = c3.Mining.npcTaken(b3, born + life / 2);
  assert.ok(mid > 0 && mid < b3.ore.pool, `crews are part-way through at half-life (${mid}/${b3.ore.pool})`);
  assert.ok(c3.Mining.npcTaken(b3, rolls - 1000) >= b3.ore.pool - 2,
    "a rock nobody touched is worked out by the time the crews move on");
  assert.ok(c3.Mining.poolLeft(b3, rolls - 1000) <= 1, "…so nothing is left for a latecomer");
  assert.ok(c3.Mining.poolLeft(b3, born) > 0, "…but a fresh rock is worth flying to");
  // a player racing them takes from the same finite pool
  const before = c3.Mining.poolLeft(b3, born + life / 2);
  c3.Mining.poolRow(b3).used += 10;
  assert.strictEqual(c3.Mining.poolLeft(b3, born + life / 2), before - 10,
    "what you take comes off the same pool the crews are draining");
}

// ---- the site rolls over: fresh rock, parked op flies home ----------------
{
  const c4 = boot();
  const b4 = c4.Galaxy.list.flatMap(x => c4.POIs.list(x.id, T0)).find(p => p.ore);
  const slot4 = c4.POIs.slot(b4.id);
  const rolls = c4.POIs.rollsAt(slot4, T0);
  const born = rolls - c4.POIs.lifeMs(slot4);
  const after = c4.POIs.get(b4.id, rolls + 1000);
  assert.notStrictEqual(after.name, b4.name, "a different rock takes the slot");
  assert.ok(after.gen === b4.gen + 1, "the generation advanced by one");
  assert.ok(after.ore, "the replacement is still a belt (the slot's type is permanent)");

  c4.Game.state.currentSystem = b4.sysId;
  const m4 = c4.Fleet.makeShip("core_driller"); c4.Game.state.ships.push(m4);
  const r4 = c4.Mining.start(b4.id, m4.uid, null, born + 1000);
  assert.ok(r4.ok, "dispatched to the rock that is there now");
  assert.strictEqual(r4.op.gen, b4.gen, "the op remembers which rock it was sent to");
  c4.Mining.resolve(rolls + 1000);
  assert.ok(r4.op.returnAt, "the seam it was working got cleared — the hull heads home");
  c4.Mining.resolve(rolls + 1000 + r4.op.travelMs + 1);
  assert.strictEqual(m4.status, "idle", "hull home and idle");
  assert.strictEqual(c4.Mining.list().length, 0, "op closed out");
  // and the stored row for the old rock is gone
  assert.ok(!Object.keys(c4.Mining.pools()).some(k => c4.Mining.pools()[k].gen === b4.gen),
    "the old generation's depletion row is pruned");
}

// ---- rigs reuse extractors wholesale --------------------------------------
{
  const c4 = boot();
  const b4 = c4.Galaxy.list.flatMap(x => c4.POIs.list(x.id, T0)).find(p => p.ore && p.ore.pool > 100);
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
  const b5 = c5.Galaxy.list.flatMap(x => c5.POIs.list(x.id, T0)).find(p => p.ore);
  const m5 = c5.Fleet.makeShip("prospector"); c5.Game.state.ships.push(m5);
  c5.Economy = { softIncomeLocal: () => false, refreshNetWorth() {}, checkAchievements() {} };
  assert.strictEqual(c5.Mining.start(b5.id, m5.uid, null, T0).ok, false,
    "server-ledger saves can't dispatch until the mining SQL phase");
}

console.log(`check_mining: OK — ${belts} belts with seams, per-batch ${per}, pool math + gates hold`);
