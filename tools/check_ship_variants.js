#!/usr/bin/env node
/* check_ship_variants.js — the Bazaar shipyard sells NAMED, REFITTED hulls off a
   rotating shelf, and the refit has to follow the ship into the fleet.

   The things that can quietly break here:
     1) A refit that isn't a trade-off. The sale price is the plain catalog
        price because app_buy_ship charges from the SQL catalog and knows
        nothing about refits — so a strictly-better variant is free power.
     2) A shelf price that isn't the catalog price, which would bill the player
        for credits the server never takes.
     3) Losing the refit on purchase. The server assigns the ship's uid, so the
        client has to claim the right hull out of the returned roster.
     4) Losing the refit on reload, because state.shipVariants is a client-owned
        slice that Game.migrate validates (and could over-validate away).
     5) The shelf not actually rotating — or rotating per render, which would
        let a player reroll it by switching tabs.

   Run:  node tools/check_ship_variants.js                                      */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const root = path.join(__dirname, "..");
const ctx = { console, JSON, Math, Object, Array, Number, Promise, setTimeout };
ctx.window = ctx;
let NOW = 1_700_000_000_000;
ctx.Date = { now: () => NOW };
vm.createContext(ctx);
const load = f => vm.runInContext(fs.readFileSync(path.join(root, "js", f), "utf8"), ctx, { filename: f });
for (const f of ["store.js", "data.js", "flavor.js", "content.js", "market.js", "items.js",
  "fleet.js", "economy.js", "cloud.js", "bazaar.js"]) load(f);
const { SHIP_VARIANTS, SHIP_CATALOG, ALL_SHIPS, Bazaar, Fleet, Economy, Cloud, Content, Market, BAZAARCFG } = ctx;
Content.snapshotDefaults();
Market.init();
ctx.Rep = { discount: () => 0 };
ctx.Bus = { emit: () => {} };
ctx.Util = { clamp: (n, a, b) => Math.min(b, Math.max(a, n)), pick: a => a[0], credits: n => String(n) };
Economy.refreshNetWorth = () => {};
Economy.checkAchievements = () => {};
Economy.fleetCap = () => 99;
Economy.tier = () => 0;
Economy._syncSoftEconomy = async () => true;

const baseState = () => ({
  credits: 5_000_000, seq: 1, ships: [], items: {}, stats: {}, positions: {}, avgCost: {},
  bazaar: { yard: [], blackboxes: [], blueprints: [] }, bazaarBought: [], shipVariants: {},
  extractors: {}, components: {}, missions: [], reports: [], routes: [], inventory: { capacity: 6 },
  pendingContracts: [], reputation: {}, unlockedSystems: [], mainShip: { type: "pinnace" }, listings: [],
});
ctx.Game = { state: baseState(), timeScale: 1 };

// ---- 1) every refit is a trade-off -----------------------------------------
const known = new Set(ALL_SHIPS.map(s => s.cls));
for (const v of SHIP_VARIANTS) {
  assert.ok(v.id && v.name && v.tag, `variant ${v.id} has id/name/tag`);
  const mods = Object.values(v.mods || {});
  if (v.id === "stock") {
    assert.strictEqual(mods.length, 0, "the stock refit modifies nothing");
    continue;
  }
  assert.ok(mods.some(m => m > 0), `${v.id} gives something`);
  assert.ok(mods.some(m => m < 0), `${v.id} costs something — no strictly-better refit (price is fixed)`);
  for (const c of v.cls || []) assert.ok(known.has(c), `${v.id} targets a real hull class (${c})`);
}
assert.ok(SHIP_VARIANTS.some(v => v.id === "stock"), "a stock refit exists as the baseline");
console.log(`ok: all ${SHIP_VARIANTS.length} refits are trade-offs, none strictly better than stock`);

// ---- 2) the shelf: stock, price, class-appropriate refits -------------------
const sellable = new Map([...SHIP_CATALOG.transport, ...SHIP_CATALOG.escort, ...SHIP_CATALOG.survey]
  .filter(d => !d.craftOnly && d.price > 0).map(d => [d.id, d]));
let seenHulls = new Set(), seenVariants = new Set();
for (let epoch = 0; epoch < 400; epoch++) {
  for (let slot = 0; slot < (BAZAARCFG.yardSlots || 8); slot++) {
    const o = Bazaar.genSeededYardShip(epoch, slot);
    assert.ok(o, `offer generated @${epoch}-${slot}`);
    const def = sellable.get(o.shipType);
    assert.ok(def, `${o.shipType} is a sellable, non-blueprint hull`);
    assert.strictEqual(o.price, def.price,
      `${o.shipType} is offered at the catalog price — app_buy_ship charges that, not the sticker`);
    const v = Fleet.variantDef(o.variantId);
    assert.ok(v, `${o.variantId} is a real refit`);
    assert.ok(!v.cls || v.cls.includes(def.cls), `${v.id} isn't offered on a ${def.cls} hull it wasn't written for`);
    assert.ok(o.name && /^[A-Z]/.test(o.name), "the hull comes pre-named");
    seenHulls.add(o.shipType); seenVariants.add(o.variantId);
  }
}
assert.strictEqual(seenHulls.size, sellable.size, "every sellable hull turns up on the shelf eventually");
assert.strictEqual(seenVariants.size, SHIP_VARIANTS.length, "every refit turns up eventually");
console.log(`ok: the shelf stocks all ${seenHulls.size} hulls × ${seenVariants.size} refits at catalog prices`);

// ---- 2b) it rotates on the clock, and ONLY on the clock ---------------------
const shelfAt = t => { NOW = t; Bazaar.fillYard(); return ctx.Game.state.bazaar.yard.map(o => o.id + ":" + o.shipType + ":" + o.variantId).join("|"); };
const rot = BAZAARCFG.yardRotationMs;
assert.strictEqual(rot, 5 * 60 * 1000, "the shelf turns over every 5 minutes");
const t0 = Math.floor(1_700_000_000_000 / rot) * rot;   // start of a rotation
assert.strictEqual(shelfAt(t0), shelfAt(t0 + rot - 1),
  "the shelf is stable inside a rotation — re-rendering can't reroll it");
assert.notStrictEqual(shelfAt(t0), shelfAt(t0 + rot), "the shelf turns over on the next rotation");
// No slot shows the same hull+refit twice.
NOW = t0;
for (let e = 0; e < 300; e++) {
  NOW = t0 + e * rot;
  Bazaar.fillYard();
  const keys = ctx.Game.state.bazaar.yard.map(o => o.shipType + ":" + o.variantId);
  assert.strictEqual(new Set(keys).size, keys.length, `no duplicate hull+refit on the shelf @${e}`);
}
NOW = t0;
console.log("ok: the shelf rotates every 5 min, is stable in between, and never repeats a ship");

// ---- 3) buying binds the refit to the SERVER's ship uid ---------------------
// Guest path first: the local uid is the real one.
ctx.Game.state = baseState();
Bazaar.fillYard();
let offer = ctx.Game.state.bazaar.yard.find(o => o.variantId !== "stock");
assert.ok(offer, "found a refitted hull on the shelf");
let r = Bazaar.buyShip(offer.shipType, offer);
assert.ok(r.ok && !(r instanceof Promise), "guest buy is synchronous");
let bought = ctx.Game.state.ships[0];
assert.strictEqual(bought.name, offer.name, "the ship keeps the name it was sold under");
assert.strictEqual(Fleet.variantFor(bought).id, offer.variantId, "…and its refit");
assert.ok(!ctx.Game.state.bazaar.yard.some(o => o.id === offer.id), "the hull leaves the shelf");
assert.ok(ctx.Game.state.bazaarBought.includes(offer.id), "…and can't come back this rotation");
console.log("ok: a guest purchase carries the name + refit into the fleet");

// Authoritative path: app_buy_ship replies with a SERVER-assigned uid and the
// optimistic ship is thrown away. This is where the refit used to get lost.
ctx.Game.state = baseState();
Cloud.enabled = true; Cloud._user = { id: "u1" }; Cloud.playersReady = true; Cloud._devLocal = false;
Bazaar.fillYard();
offer = ctx.Game.state.bazaar.yard.find(o => o.variantId !== "stock");
Cloud.rpc = async () => ({ ok: true, credits: 4_000_000,
  ships: [{ uid: "SRV-77", type: offer.shipType, cls: "transport", name: offer.shipType, status: "idle", accessories: [] }] });
(async () => {
  const rr = await Bazaar.buyShip(offer.shipType, offer);
  assert.ok(rr.ok, "authoritative buy succeeded");
  const sh = ctx.Game.state.ships.find(x => x.uid === "SRV-77");
  assert.ok(sh, "the server's ship is the one in the fleet");
  assert.strictEqual(Fleet.variantFor(sh).id, offer.variantId, "the refit is pinned to the SERVER uid");
  assert.strictEqual(sh.name, offer.name, "the yard name is pinned to the SERVER uid");
  // …and survives the server stamping a stub name over it on the next readback.
  sh.name = Fleet.shipDef(sh.type).name;   // what phase-2 SQL stamps on the row
  assert.ok(Fleet.isStubName(sh), "server stub name detected");
  assert.strictEqual(Fleet.nameFromUid(sh.uid, sh.type, false), offer.name,
    "name repair restores the yard name instead of rolling a random one");
  console.log("ok: an authoritative purchase pins name + refit to the server's uid");

  // ---- 4) the refit actually changes the ship's stats ----------------------
  const wide = SHIP_VARIANTS.find(v => v.id === "widebelly");
  ctx.Game.state = baseState();
  ctx.Game.state.ships = [{ uid: "s1", type: "bulk", cls: "transport", status: "idle", accessories: [] }];
  const stock = Fleet.stats(ctx.Game.state.ships[0]);
  Fleet.setVariant("s1", "widebelly", "Iron Widow");
  const refit = Fleet.stats(ctx.Game.state.ships[0]);
  const bulk = SHIP_CATALOG.transport.find(d => d.id === "bulk");
  assert.strictEqual(refit.cargo, Math.round(bulk.cargo * (1 + wide.mods.cargo)), "cargo is up by the refit");
  assert.ok(refit.speed < stock.speed, "…and speed is down");
  assert.strictEqual(Fleet.variantLabel(ctx.Game.state.ships[0]), "Wide-Belly", "the card shows the refit");
  console.log("ok: Fleet.stats applies the refit");

  // Save-boundary validation of state.shipVariants lives in
  // tools/check_save_migrate.js — that harness already traps a Game.state read
  // during migrate, which is the trap the yard-name lookup has to stay out of.

  // ---- 5) selling a hull takes its refit record with it --------------------
  ctx.Game.state.shipVariants.s_gone = { v: "runner", name: "Ghost" };
  Fleet.pruneVariants();
  assert.ok(!ctx.Game.state.shipVariants.s_gone, "a sold hull's refit record is pruned");
  assert.ok(ctx.Game.state.shipVariants.s1, "…and a live hull's is kept");
  console.log("ok: refit records don't outlive their ships");

  // ---- 6) blackboxes + blueprints are on the 24h shelf ---------------------
  const DAY = 24 * 60 * 60 * 1000;
  assert.strictEqual(Bazaar.slowEpochMs(), DAY, "blackboxes/blueprints restock daily");
  const slowAt = t => { NOW = t; Bazaar.fillSlowStock(); const s = ctx.Game.state.bazaar;
    return (s.blackboxes || []).concat(s.blueprints || []).map(o => o.id).join("|"); };
  const day = Math.floor(t0 / DAY) * DAY + 1000;
  assert.strictEqual(slowAt(day), slowAt(day + 60_000 * 30),
    "half an hour later the shelf is unchanged — no reroll by waiting out the board epoch");
  assert.notStrictEqual(slowAt(day), slowAt(day + DAY), "…and it does turn over the next day");
  // A bought slot stays bought for the rest of the day.
  NOW = day;
  Bazaar.fillSlowStock();
  const box = ctx.Game.state.bazaar.blackboxes[0];
  assert.ok(box, "a blackbox is in stock");
  ctx.Game.state.bazaarBought.push(box.id);
  NOW = day + 60_000 * 90;
  Bazaar.fillSlowStock();
  assert.ok(!ctx.Game.state.bazaar.blackboxes.some(o => o.id === box.id),
    "a bought blackbox doesn't restock later the same day");
  console.log("ok: blackbox/blueprint stock is one shelf per day");

  console.log("All ship-variant checks passed.");
})().catch(e => { console.error(e); process.exit(1); });
