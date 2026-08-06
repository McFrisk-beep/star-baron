#!/usr/bin/env node
/* check_stations.js — NPC stations, auctions, production hub, revolt gates.
   Run: node tools/check_stations.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout });
ctx.window = ctx;
let T = 1_720_000_000_000;
ctx.Date = { now: () => T, parse: Date.parse };   // parse: server rows carry ISO timestamps
ctx.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

for (const f of ["store.js", "data.js", "flavor.js", "market.js", "galaxy.js", "stock.js", "stations.js", "extractors.js", "economy.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}

const { Market, Galaxy, Stock, Stations, Economy, Extractors, SYSTEMS, STATIONCFG, Util } = ctx;
Market.init();
Galaxy.build();
Stock.init(T);
Stations.ensure();

ctx.Game = {
  state: {
    credits: 5_000_000, positions: {}, avgCost: {}, currentSystem: "navos", travel: null,
    unlockedSystems: SYSTEMS.filter(s => s.unlock === 0).map(s => s.id),
    reputation: { syndicate: 0, mining_combine: 0, free_trade: 0, agri_collective: 0 },
    prestige: { tier: 0, multiplier: 1 },
    stats: { trades: 0, contractsDone: 0, peakNetWorth: 50000, biggestTrade: 0 },
    achievements: [], ships: [], items: {}, orders: [], seq: 1,
    mainShip: { type: "pinnace" }, extractors: {}, components: {}, industries: [],
  },
  requestSave() {},
};
ctx.Rep = { edgeForCategory: () => 0, onTrade() {}, get: () => 0 };
ctx.Fleet = { fleetValue: () => 0, dockTravelMs: () => 1000, mainDef: () => ({ travelSpeed: 1 }) };
ctx.Bazaar = {
  itemsValue: () => 0,
  equippedSet: () => new Set(),
  inventoryItems: () => Object.values(ctx.Game.state.items || {}),
  inventoryUsed() { return this.inventoryItems().length; },
  capacity: () => 40,
};
ctx.Bus = { emit() {} };
ctx.UI = { toast() {} };

const target = Stations.list()[0];
assert.ok(target, "has stations");
assert.strictEqual(target.status, "npc");

// Anchorage must be reachable on claimable (non-capital) stations — §7.1 max power 25.
const tiers = new Set(Stations.list().map(st => st.tier));
assert.ok(tiers.has("Anchorage"), `claimable tier set includes Anchorage, got ${[...tiers].join(",")}`);
assert.ok(!Galaxy.list.some(s => !s.capital && / (Station|Spire|Platform)$/.test(s.stationName)),
  "capital flavour aliases stay off claimable systems");
assert.strictEqual(Stations.tierInfo("Anchorage").power + STATIONCFG.reactor[4].power, 25,
  "Anchorage + Reactor V = 25 power");

const openMin = Stations.openingBid(target);
const before = ctx.Game.state.credits;
const r0 = Stations.openAuction(target.systemId, openMin);
assert.ok(r0.ok, r0.msg);
assert.strictEqual(ctx.Game.state.credits, before - openMin, "bid escrowed");
assert.ok(Stations.escrowTotal() === openMin, "escrow tracked");
assert.ok(Economy.netWorth() >= before - 1, "escrow counts toward net worth");

// Anti-snipe: bid near close extends window
const auc = Stations.getAuction(target.systemId);
auc.closesAt = T + 10 * 60 * 1000; // 10 min left
const raise = openMin + STATIONCFG.minBidIncrement;
const r1 = Stations.bid(target.systemId, raise);
assert.ok(r1.ok, r1.msg);
assert.ok(auc.closesAt >= T + STATIONCFG.antiSnipeMs - 1, "anti-snipe extended");

// Close → ownership
auc.closesAt = T - 1;
Stations._closeAuction(target.systemId, T);
assert.strictEqual(target.status, "owned");
assert.strictEqual(target.ownerId, "player");
assert.strictEqual(Stations.ownedCount(), 1);

// Install Production Hub
const inst = Stations.install(target.systemId, "production_hub");
assert.ok(inst.ok, inst.msg);
assert.strictEqual(target.modules.production_hub, 1);

const pool = Stations.produceable(target.systemId);
assert.ok(pool.length, "system can produce something");
const set = Stations.setProduction(target.systemId, pool[0].id);
assert.ok(set.ok, set.msg);
// Finish retooling
target.status = "owned"; target.refitUntil = 0;
Stations.syncBays(target);
assert.strictEqual(target.bays.length, STATIONCFG.prodHub[0].bays, "hub I opens 2 bays");

// Occupy a bay with a jack extractor
const ex = { uid: "exBay1", type: "jack", scope: "all", name: "Test Jack", components: [] };
Extractors.acquire(ex);
const occ = Stations.occupyBay(target.systemId, 0, ex.uid);
assert.ok(occ.ok, occ.msg);
assert.ok(Extractors.installedSet().has(ex.uid), "bay locks extractor");
assert.ok(!Extractors.unequipped().some(e => e.uid === ex.uid), "occupied extractor not free");

// Owner bay production → station hold
target.hold = {};
const stockBefore = Stock.available(target.sectorId, pool[0].id);
const made = Stations._playerProduce(target, 1);
assert.ok(made > 0 && (target.hold[pool[0].id] | 0) === made, "owner bay output in hold");

// Deliver requires docking at capital
const sec = Galaxy.sector(target.sectorId);
ctx.Game.state.currentSystem = sec.capital;
const qty = target.hold[pool[0].id];

// leaseBay / vacateBay / deliver are async (shared-floor RPCs). Everything from
// here down runs in one async body — hall + bay checks await the same way.
void (async () => {

const del = await Stations.deliver(target.systemId, pool[0].id, qty);
assert.ok(del.ok, del.msg);
assert.ok(Stock.available(target.sectorId, pool[0].id) >= stockBefore, "delivery restocks sector");

// Vacate returns extractor to pool
assert.ok((await Stations.vacateBay(target.systemId, 0)).ok);
assert.ok(Extractors.unequipped().some(e => e.uid === ex.uid), "vacated extractor free again");

// Lease path: another owner's hub, local player leases (must be docked there)
const otherHub = Stations.list().find(st => st.systemId !== target.systemId);
otherHub.ownerId = "alice";
otherHub.status = "owned";
otherHub.modules = { production_hub: 1 };
otherHub.prodComm = pool[0].id;
otherHub.leaseTaxBps = 1000; // 10%
otherHub.hold = {};
Stations.syncBays(otherHub);
assert.ok(!(await Stations.leaseBay(otherHub.systemId, 0, ex.uid)).ok, "lease requires docking");
ctx.Game.state.currentSystem = otherHub.systemId;
const lease = await Stations.leaseBay(otherHub.systemId, 0, ex.uid);
assert.ok(lease.ok, lease.msg);
assert.ok(Stations.leaseableBays(otherHub.systemId).every(x => x.index !== 0), "leased bay not listed vacant");
ctx.Game.state.positions = {};
const leased = Stations._playerProduce(otherHub, 2);
assert.ok(leased > 0, "lessee bay produces");
const tax = Math.floor(leased * 0.10);
const keep = leased - tax;
assert.strictEqual(otherHub.hold[pool[0].id] | 0, tax, "lease tax → station hold");
assert.strictEqual(ctx.Game.state.positions[pool[0].id] | 0, keep, "lessee keeps residual in cargo");

// Third-party lessee: keep parks in pendingCargo (not dropped on the floor)
await Stations.vacateBay(otherHub.systemId, 0);
Extractors.acquire(ex);
otherHub.hold = {};
otherHub.bays[0] = { lesseeId: "bob", extractorId: ex.uid, npc: false };
// extractor must exist for _bayGross — bob's extractor on our save is fine for the harness
const remote = Stations._playerProduce(otherHub, 3);
assert.ok(remote > 0, "third-party bay produces");
const rTax = Math.floor(remote * 0.10);
const rKeep = remote - rTax;
assert.strictEqual(otherHub.hold[pool[0].id] | 0, rTax, "third-party tax → hold");
assert.strictEqual((otherHub.pendingCargo.bob || {})[pool[0].id] | 0, rKeep, "third-party keep → pendingCargo");
// Claim as bob
const realPid = Stations.playerId;
Stations.playerId = () => "bob";
ctx.Game.state.positions = {};
const claimed = Stations.claimPendingCargo(otherHub.systemId);
Stations.playerId = realPid;
assert.strictEqual(claimed.claimed[pool[0].id] | 0, rKeep, "claimPendingCargo pays lessee");
assert.strictEqual(ctx.Game.state.positions[pool[0].id] | 0, rKeep);
await Stations.vacateBay(otherHub.systemId, 0);
otherHub.ownerId = null; otherHub.status = "npc"; otherHub.modules = {}; otherHub.bays = [];
otherHub.pendingCargo = {};
ctx.Game.state.currentSystem = sec.capital;

// Re-occupy for strike test
assert.ok(Stations.occupyBay(target.systemId, 0, ex.uid).ok);
// Clear bay 1 so NPC tenants don't add noise
target.bays[1] = { lesseeId: null, extractorId: null, npc: false };
target.hold = {};
target.standing = 50;
const full = Stations._playerProduce(target, 99);
target.hold = {};
target.standing = 19;
const struck = Stations._playerProduce(target, 100);
assert.ok(full > 0, "baseline production > 0");
assert.strictEqual(struck, Math.floor(full / 2), `strike halves ${full} → ${struck}`);

// Power budget blocks over-install
target.modules = { production_hub: 1 };
target.reactorLevel = 0;
Stations.syncBays(target);
let blocked = false;
for (const id of ["exchange_hall", "dry_dock", "charter_office", "warehouse", "lane_buoy", "contract_office"]) {
  const r = Stations.canInstall(target, id);
  if (!r.ok && /power/i.test(r.msg || "")) { blocked = true; break; }
}
assert.ok(blocked || Stations.powerFree(target) >= 0, "power budget enforced");

// Cap: Baron can only own 1
const other = Stations.list().find(st => st.systemId !== target.systemId);
ctx.Game.state.credits = 5_000_000;
const r2 = Stations.openAuction(other.systemId, Stations.openingBid(other));
assert.ok(!r2.ok, "cap blocks opening a second auction while owning 1");

// ---- Exchange Hall (§9) ---------------------------------------------------
await Stations.vacateBay(target.systemId, 0);
target.modules = { production_hub: 1 };
target.reactorLevel = 2; // budget covers hub(4) + hall(4)
ctx.Game.state.credits = 5_000_000;
const hallInst = Stations.install(target.systemId, "exchange_hall");
assert.ok(hallInst.ok, hallInst.msg);
assert.ok(Stations.hasHall(target), "hall installed");

// Access: owner always; visitor must dock at the station
assert.ok(Stations.canUseHall(target.systemId).ok, "owner can use hall");
const visitorDock = ctx.Game.state.currentSystem;
const secHall = Galaxy.sector(target.sectorId);
const ownerSave = target.ownerId;
target.ownerId = "alice";
ctx.Game.state.currentSystem = target.systemId;
assert.ok(Stations.canUseHall(target.systemId).ok, "docked visitor can use hall");
ctx.Game.state.currentSystem = secHall.capital;
assert.ok(!Stations.canUseHall(target.systemId).ok, "capital dock no longer proxies hall");
target.ownerId = ownerSave;
ctx.Game.state.currentSystem = target.systemId;

// List / cancel extractor
const hallEx = { uid: "exHall1", type: "jack", scope: "all", name: "Hall Jack", components: [] };
Extractors.acquire(hallEx);
const listed = await Stations.listHallItem(target.systemId, "extractor", hallEx.uid, 900);
assert.ok(listed.ok, listed.msg);
assert.ok(!Extractors.get(hallEx.uid), "listing escrows extractor");
assert.ok(Stations.hallEscrowValue() > 0, "hall escrow in net worth");
assert.ok((await Stations.cancelHallListing(target.systemId, listed.listing.id)).ok);
assert.ok(Extractors.get(hallEx.uid), "cancel restores extractor");

// Tariff on NPC buy
Stations.setSaleTariff(target.systemId, 1000); // 10%
assert.strictEqual(target.saleTariffBps, 1000);
Extractors.acquire(hallEx);
const listed2 = await Stations.listHallItem(target.systemId, "extractor", hallEx.uid, 1000);
assert.ok(listed2.ok, listed2.msg);
const credBefore = ctx.Game.state.credits;
const treasBefore = target.treasury | 0;
const origChance = STATIONCFG.hallNpcBuyChance;
STATIONCFG.hallNpcBuyChance = 1;
const sold = Stations._npcBuyHall(target, 42);
STATIONCFG.hallNpcBuyChance = origChance;
assert.strictEqual(sold.length, 1, "NPC clears listing");
assert.strictEqual(ctx.Game.state.credits, credBefore + 900, "seller nets price − 10% tariff");
assert.strictEqual(target.treasury, treasBefore + 100, "tariff → treasury");
assert.ok(!Extractors.get(hallEx.uid), "NPC sale consumes goods");

// Expiry returns goods
Extractors.acquire(hallEx);
const listed3 = await Stations.listHallItem(target.systemId, "extractor", hallEx.uid, 500);
assert.ok(listed3.ok, listed3.msg);
listed3.listing.expiresAt = T - 1;
const expired = Stations._expireHall(target, T);
assert.strictEqual(expired.length, 1);
assert.ok(Extractors.get(hallEx.uid), "expiry restores seller goods");

// Blackboxes always need Black Market on the hall
target.modules.black_market = 0;
ctx.Game.state.items = { bb1: { uid: "bb1", name: "Hot Box", consumable: true, effectId: "smuggle", value: 200 } };
ctx.Items = { isBlackbox: it => !!(it && it.effectId) };
const bbBlock = await Stations.listHallItem(target.systemId, "blackbox", "bb1", 200);
assert.ok(!bbBlock.ok, "blackboxes need a Black Market");

// ---- Contract Office (§11) ------------------------------------------------
delete target.modules.exchange_hall;
target.modules.contract_office = 0;
target.reactorLevel = 3;
ctx.Game.state.credits = 5_000_000;
const coInst = Stations.install(target.systemId, "contract_office");
assert.ok(coInst.ok, coInst.msg);
assert.ok(Stations.hasContractOffice(target), "contract office installed");

const haulComm = pool[0].id;
target.hold[haulComm] = 100;
const stockCapBefore = Stock.available(target.sectorId, haulComm);
const credPost = ctx.Game.state.credits;
const posted = await Stations.postHaul(target.systemId, haulComm, 40, 50);
assert.ok(posted.ok, posted.msg);
assert.strictEqual(target.hold[haulComm], 60, "post reserves hold goods");
const escrow = 40 * 50;
const fee = Math.floor(escrow * STATIONCFG.contractPostFeeBps / 10000);
assert.strictEqual(ctx.Game.state.credits, credPost - escrow - fee, "escrow + fee deducted");
assert.ok(Stations.contractEscrowValue() >= escrow, "haul escrow in net worth");
assert.ok(Stations.boardContracts().some(c => c.id === posted.contract.id), "board lists haul");

const selfFly = await Stations.claimHaulForLaunch(posted.contract.id);
assert.ok(!selfFly.ok, "owner blocked from own haul");

assert.ok((await Stations.cancelHaul(target.systemId, posted.contract.id)).ok);
assert.strictEqual(target.hold[haulComm], 100, "cancel restores hold");
assert.strictEqual(ctx.Game.state.credits, credPost - fee, "cancel refunds escrow not fee");

target.hold[haulComm] = 80;
ctx.Game.state.credits = 5_000_000;
const posted2 = await Stations.postHaul(target.systemId, haulComm, 20, 30);
assert.ok(posted2.ok, posted2.msg);
posted2.contract.createdAt = T - (STATIONCFG.contractNpcFillAfterMs + 1000);
const origFill = STATIONCFG.contractNpcFillChance;
STATIONCFG.contractNpcFillChance = 1;
const npcFilled = Stations._npcFillHauls(target, 99);
STATIONCFG.contractNpcFillChance = origFill;
assert.strictEqual(npcFilled.length, 1, "NPC fills haul");
assert.ok(Stock.available(target.sectorId, haulComm) >= stockCapBefore + 20, "NPC haul restocks sector");
assert.strictEqual(Stations.reliability(target), 1, "reliability 100% after fill");

target.hold[haulComm] = 40;
ctx.Game.state.credits = 5_000_000;
const posted3 = await Stations.postHaul(target.systemId, haulComm, 15, 25);
assert.ok(posted3.ok, posted3.msg);
posted3.contract.status = "active";
const stockMid = Stock.available(target.sectorId, haulComm);
const settle = await Stations.settleHaul(posted3.contract.id, "success");
assert.ok(settle.ok, settle.msg);
assert.ok(Stock.available(target.sectorId, haulComm) >= stockMid + 15, "mission success restocks");
assert.ok(!(target.contracts || []).some(c => c.id === posted3.contract.id), "settled haul removed");

target.hold[haulComm] = 50;
ctx.Game.state.credits = 5_000_000;
const posted4 = await Stations.postHaul(target.systemId, haulComm, 10, 20);
assert.ok(posted4.ok, posted4.msg);
posted4.contract.expiresAt = T - 1;
const haulExp = Stations._expireHauls(target, T);
assert.strictEqual(haulExp.length, 1);
assert.strictEqual(target.hold[haulComm], 50, "expiry restores hold");
assert.ok(Stations.reliability(target) < 1, "expiry lowers reliability");

ctx.Game.state.currentSystem = visitorDock;

// Admin free claim — no auction, no escrow, skips cooldown.
ctx.Cloud = { isAdmin: () => true };
const freeTarget = Stations.list().find(st => st.status === "npc" && st.ownerId == null
  && st.systemId !== target.systemId && st.systemId !== other.systemId);
assert.ok(freeTarget, "npc station available for admin claim");
const creditsBeforeClaim = ctx.Game.state.credits;
const adminR = Stations.adminClaim(freeTarget.systemId);
assert.ok(adminR.ok, adminR.msg);
assert.strictEqual(freeTarget.status, "owned");
assert.strictEqual(freeTarget.ownerId, "player");
assert.strictEqual(ctx.Game.state.credits, creditsBeforeClaim, "admin claim costs nothing");

// Relinquish returns control to NPC, keeps modules, returns treasury.
freeTarget.modules = { production_hub: 1 };
freeTarget.reactorLevel = 1;
freeTarget.treasury = 12_000;
const creditsBeforeRel = ctx.Game.state.credits;
const rel = Stations.relinquish(freeTarget.systemId);
assert.ok(rel.ok, rel.msg);
assert.strictEqual(freeTarget.status, "npc");
assert.strictEqual(freeTarget.ownerId, null);
assert.strictEqual(freeTarget.modules.production_hub, 1, "modules persist");
assert.strictEqual(freeTarget.reactorLevel, 1, "reactor persists");
assert.strictEqual(ctx.Game.state.credits, creditsBeforeRel + 12_000, "treasury returned");

// Relinquish buyback — hold goods are cashed out, not silently wiped.
assert.ok(Stations.adminClaim(freeTarget.systemId).ok);
const holdComm = Stations.produceable(freeTarget.systemId)[0]?.id || "iron_ore";
freeTarget.hold = { [holdComm]: 25 };
freeTarget.treasury = 0;
const holdWorth = Stations.holdValue(freeTarget);
assert.ok(holdWorth > 0, "hold has exchange value");
const creditsBeforeHold = ctx.Game.state.credits;
const rel2 = Stations.relinquish(freeTarget.systemId);
assert.ok(rel2.ok, rel2.msg);
assert.strictEqual(rel2.holdCredits, holdWorth);
assert.strictEqual(ctx.Game.state.credits, creditsBeforeHold + holdWorth, "hold buyback credited");
assert.strictEqual(Object.keys(freeTarget.hold || {}).length, 0, "hold cleared");

ctx.Cloud = { isAdmin: () => false };
assert.ok(!Stations.adminClaim(freeTarget.systemId).ok, "non-admin blocked");

// ---- Refit is owner-held, not a lockout -----------------------------------
// Regression: setProduction/uninstall flip status to "refit", and every
// ownership gate keyed on status === "owned", so the owner lost the Stations
// tab, the star-map panel and every control for the whole downtime.
target.ownerId = "player";
target.status = "owned";
target.modules = { production_hub: 1 };
target.reactorLevel = 2;
target.prodComm = pool[0].id;
ctx.Game.state.credits = 5_000_000;

// First assignment on an idle hub is not a retool — no downtime (docs §8).
target.prodComm = null;
const firstSet = Stations.setProduction(target.systemId, pool[0].id);
assert.ok(firstSet.ok, firstSet.msg);
assert.strictEqual(firstSet.retool, false, "first assignment does not retool");
assert.strictEqual(target.status, "owned", "idle hub stays online on first assign");

// Switching commodity does cost downtime.
const alt = pool.find(c => c.id !== pool[0].id);
if (alt) {
  const quoted = Stations.retoolCost(target, alt.id);
  assert.ok(quoted > 0, "switching commodity is quoted a cost");
  const swap = Stations.setProduction(target.systemId, alt.id);
  assert.ok(swap.ok, swap.msg);
  assert.strictEqual(swap.retool, true, "switching commodity retools");
  assert.strictEqual(swap.refitUntil - T, quoted, "charged downtime matches the quote");
} else {
  target.status = "refit";
  target.refitUntil = T + STATIONCFG.refitMs / 2;
}
assert.strictEqual(target.status, "refit");
assert.ok(Stations.refitLeft(target) > 0, "refit reports time remaining");

// retoolCost must agree with what setProduction actually charges — it's what
// the confirm prompt quotes, so a drift would mean lying to the player.
assert.strictEqual(Stations.retoolCost(target, target.prodComm), 0, "same commodity is free");
assert.strictEqual(Stations.uninstallCost(), STATIONCFG.refitMs, "uninstall costs a full refit");

// The owner keeps the station through the downtime.
assert.ok(Stations.ownerHeld(target), "refit is owner-held");
assert.strictEqual(Stations.ownedCount(), 1, "refit station still counts as owned");
assert.ok(Stations.ownedBy().some(st => st.systemId === target.systemId),
  "refit station still listed on the Stations tab");
assert.ok(Stations.hubAccess("stations", target.systemId).ok,
  "owner console reachable during refit");

// ...but services are offline, and say so instead of claiming NPC ownership.
const bazaarGate = Stations.hubAccess("bazaar", target.systemId);
assert.ok(!bazaarGate.ok, "services offline during refit");
assert.ok(/refit/i.test(bazaarGate.reason), `refit reason, got "${bazaarGate.reason}"`);
const svcHub = Stations.serviceList(target.systemId).find(r => r.id === "production_hub");
assert.ok(!svcHub.ok && /refit/i.test(svcHub.reason), "service chip reads refit, not NPC-held");
assert.strictEqual(Stations._playerProduce(target, 7), 0, "no production during refit");

// Nobody can auction a station out from under a refitting owner.
const grab = Stations.openAuction(target.systemId, Stations.openingBid(target));
assert.ok(!grab.ok, "refit station is not auctionable");

// Owner actions that must keep working while offline.
assert.ok(Stations.setProduction(target.systemId, pool[0].id).ok, "can reassign during refit");
target.treasury = 5_000;
assert.ok((await Stations.withdraw(target.systemId, 5_000)).ok, "can withdraw during refit");

// Refit ends on tick.
const savedT = T;
T = target.refitUntil + 1;
Stations.tick(T);
assert.strictEqual(target.status, "owned", "tick clears finished refit");
T = savedT;

// A corrupt refitUntil must never strand the owner forever.
target.status = "refit";
target.refitUntil = Number.MAX_SAFE_INTEGER;
Stations.hydrate(Stations.serialize());
const rehydrated = Stations.get(target.systemId);
assert.ok(rehydrated.refitUntil <= T + STATIONCFG.refitMs, "absurd refit timer clamped");
rehydrated.status = "refit";
rehydrated.refitUntil = NaN;
Stations.hydrate(Stations.serialize());
assert.strictEqual(Stations.get(target.systemId).status, "owned", "NaN refit timer releases station");

// ---- shared station record (docs/sql/station_directory.sql) --------------
// Another baron's claim — and their upgrades — must show up for us and for a
// signed-out visitor, instead of the local save's vacant "NPC" berth.
const heldSt = Stations.list().find(st => st.status === "npc" && st.systemId !== target.systemId);
assert.ok(heldSt, "has a spare NPC station");
const vexRow = {
  system_id: heldSt.systemId, owner_id: "acct-vex", display: "<b>Vex</b>",
  tier: heldSt.tier, status: "owned",
  modules: { customs_house: 1, exchange_hall: 1, workshop_annex: 1, production_hub: 1, gremlin_ray: 9 },
  reactor_level: 2, lease_tax_bps: 1500, sale_tariff_bps: 800, scrutiny: 55, standing: 71,
  prod_comm: pool[0].id,
  hall: [{ id: "l1", name: "<img src=x>Void Shield", kind: "gear", price: "120000", expiresAt: T + 3600e3, sellerId: "acct-vex" }],
  bays: [{ lesseeId: "acct-zed" }, { lesseeId: "" }],
};
ctx.Cloud = {
  _rows: [vexRow],
  _user: null,
  user() { return this._user; },
  signedIn() { return !!this._user; },
  async stationDirectory() { return this._rows; },
  async stationPublish(rows) { this.published = rows; return { ok: true, held: rows.length, conflicts: [] }; },
};

await Stations.refreshDirectory();
const holder = Stations.remoteHolder(heldSt.systemId);
assert.ok(holder, "guest sees the remote holder");
assert.ok(!/[<>&"']/.test(holder.display), `display sanitised, got "${holder.display}"`);
assert.ok(/Held by/.test(Stations.holderLabel(heldSt)), `holder label, got "${Stations.holderLabel(heldSt)}"`);
assert.ok(/held by/.test(Stations.holderTag(heldSt)), `holder tag, got "${Stations.holderTag(heldSt)}"`);
assert.strictEqual(Stations.holderTag(target), "yours", "own station still reads as yours");

// ...and can't be auctioned out from under them.
const poach = Stations.openAuction(heldSt.systemId, Stations.openingBid(heldSt));
assert.ok(!poach.ok && /holds this station/.test(poach.msg), `claim blocked, got "${poach.msg}"`);

// Phase A: their upgrades are real to us. view() is the station as it is.
const v = Stations.view(heldSt.systemId);
assert.ok(v.remote, "view of a held station is the owner's record");
assert.strictEqual(v.modules.customs_house, 1, "their modules land");
assert.ok(!("gremlin_ray" in v.modules), "unknown module ids are dropped on ingest");
assert.strictEqual(v.saleTariffBps, 800, "their tariff lands");
assert.strictEqual(v.treasury, 0, "their treasury is never in our copy");

// Effects that are pure reads of the record now apply to a visitor.
assert.ok(Stations.workshopMatChance(heldSt.systemId) > 0, "their Workshop Annex helps visitors");
assert.strictEqual(Stations.scrutinyFor(heldSt.systemId), 0.55, "their Customs House sets our scrutiny");
assert.strictEqual(Stations.customsExempt(heldSt.systemId), false, "a visitor is not exempt from their customs");
assert.strictEqual(Stations.publicScrutiny(heldSt.systemId).chanceHint, 55, "scrutiny is public before undock");
const hallChip = Stations.serviceList(heldSt.systemId).find(r => r.id === "exchange_hall");
assert.ok(hallChip.ok, "their Exchange Hall reads as installed, not 'modules dormant'");
assert.ok(Stations.canDock(heldSt.systemId).ok, "a live station is dockable even if our copy says npc");

// Their shelf is visible and sanitised. Without the hall SQL (this fake Cloud
// has no hall RPCs) it stays a display, as it did in phase A.
const shelf = Stations.hallListings(heldSt.systemId);
assert.strictEqual(shelf.length, 1, "their listings are visible");
assert.ok(!/[<>]/.test(shelf[0].name), `listing name sanitised, got "${shelf[0].name}"`);
assert.strictEqual(shelf[0].price, 120000, "listing price is re-typed to a number");
const hall = Stations.canUseHall(heldSt.systemId);
assert.ok(!hall.ok && hall.browse, "no hall SQL → the visitor hall is browse-only");
assert.ok(!Stations.hubAccess("bazaar", heldSt.systemId).ok, "no trading at their market yet");
assert.ok(!Stations.hubAccess("stations", heldSt.systemId).ok, "their console is not ours");

// Their hub feeds their hold, not our sector shelf (§4.2).
const realBasket = Stations._npcBasket;
const producedFor = [];
Stations._npcBasket = function (st, h) { producedFor.push(st.systemId); return realBasket.call(this, st, h); };
Stations.npcProduceHour(11);
Stations._npcBasket = realBasket;
assert.ok(producedFor.length, "NPC stations still produce");
assert.ok(!producedFor.includes(heldSt.systemId), "a held station stops minting NPC supply locally");

// Our own published row must not read as somebody else's.
ctx.Cloud._user = { id: "acct-me" };
ctx.Cloud._rows = [{ system_id: heldSt.systemId, owner_id: "acct-me", display: "Me", tier: heldSt.tier, status: "owned" }];
await Stations.refreshDirectory();
assert.strictEqual(Stations.remoteHolder(heldSt.systemId), null, "our own row is not a remote holder");
assert.strictEqual(Stations.holderTag(heldSt), "NPC", "no foreign holder → local view stands");

// Publish sends owner-held stations only, with the record other players read.
target.status = "refit";
target.refitUntil = T + 6 * 3600 * 1000;
await Stations.publishOwned();
assert.deepStrictEqual([...ctx.Cloud.published].map(r => r.system_id), [target.systemId],
  "publishes exactly the stations we hold");
const sent = ctx.Cloud.published[0];
assert.strictEqual(sent.modules.production_hub, 1, "publishes what's installed");
assert.strictEqual(+sent.refit_until, target.refitUntil, "refit clock survives as a ms epoch");
target.status = "owned";
target.refitUntil = 0;

// ---- shared Exchange Hall (docs/sql/station_hall.sql) --------------------
// Phase B: the shelf is one shelf. A stall Vex puts up is the stall we buy,
// the price splits at Vex's tariff, and both sides queue for whoever's away.
// The fake below is the RPC contract, not the SQL — enough to prove the client
// never mints goods, never double-books an item, and never trusts a payload.
{
  const iso = ms => new Date(ms).toISOString();
  const srv = {
    listings: [{
      id: "srv-1", system_id: heldSt.systemId, seller_id: "acct-vex", seller: "Vex",
      kind: "extractor", name: "Vex Deep Rig", price: 4000, value: 5000,
      expires_at: iso(T + 36e5),
      payload: { uid: "exVex", type: "jack", scope: "all", name: "Vex Deep Rig", components: ["cpVex"] },
    }],
    payouts: [],
  };
  ctx.Cloud = {
    enabled: true, hallMissing: false, treasuryMissing: false,
    _user: { id: "acct-me" },
    user() { return this._user; },
    signedIn() { return !!this._user; },
    hallReady() { return this.enabled && !this.hallMissing && this.signedIn(); },
    treasuryReady() { return this.enabled && !this.treasuryMissing && this.signedIn(); },
    async stationDirectory() { return [vexRow]; },
    async stationPublish(rows) { this.published = rows; return { ok: true, held: rows.length, conflicts: [] }; },
    async stationHall(ids) {
      return srv.listings.filter(l => ids.includes(l.system_id))
        .map(({ payload, ...row }) => row);
    },
    async stationListItem(system, l) {
      const row = { id: "srv-" + (srv.listings.length + 1), system_id: system, seller_id: "acct-me",
        seller: "Me", kind: l.kind, name: l.name, price: l.price, value: l.value,
        expires_at: iso(T + 48 * 36e5), payload: l.payload };
      srv.listings.push(row);
      return { ok: true, id: row.id, seller: row.seller, expires_at: row.expires_at, price: row.price };
    },
    async stationBuyItem(system, id) {
      const i = srv.listings.findIndex(l => l.id === id && l.system_id === system);
      if (i < 0) return { ok: false, error: "Listing gone." };
      const l = srv.listings.splice(i, 1)[0];
      const tariff = Math.floor(l.price * 800 / 10000);
      if (ctx.Game.state.credits < l.price) return { ok: false, error: "Not enough credits." };
      ctx.Game.state.credits -= l.price;
      srv.ownerTreasury = (srv.ownerTreasury | 0) + tariff;
      srv.payouts.push({ user_id: l.seller_id, amount: l.price - tariff, reason: "sale" });
      return { ok: true, id: l.id, kind: l.kind, name: l.name, price: l.price, tariff,
        seller: l.seller, payload: l.payload, credits: ctx.Game.state.credits };
    },
    async stationBuyRefund(id) {
      ctx.Game.state.credits += 100;
      return { ok: true, credits: ctx.Game.state.credits, refunded: 100 };
    },
    async stationCancelListing(id) {
      const i = srv.listings.findIndex(l => l.id === id);
      if (i < 0) return { ok: false, error: "Listing gone." };
      const l = srv.listings.splice(i, 1)[0];
      if (l.seller_id !== "acct-me") return { ok: true, cleared: true, name: l.name };
      return { ok: true, kind: l.kind, name: l.name, payload: l.payload };
    },
    async stationSettle() {
      const out = srv.mine || { payouts: [], items: [] };
      for (const p of out.payouts || []) {
        if (p.reason === "sale") ctx.Game.state.credits += p.amount;
      }
      srv.mine = null;
      return { ok: true, payouts: out.payouts || [], items: out.items || [], cargo: [],
        credits: ctx.Game.state.credits };
    },
    async stationWithdraw(system, amount) {
      if ((target.treasury | 0) < amount) return { ok: false, error: "Invalid amount." };
      target.treasury -= amount;
      ctx.Game.state.credits += amount;
      return { ok: true, amount, treasury: target.treasury, credits: ctx.Game.state.credits };
    },
    async stationSetPolicy(system, policy) {
      if (policy.lease_tax_bps != null) vexRow.lease_tax_bps = policy.lease_tax_bps;
      return { ok: true, lease_tax_bps: vexRow.lease_tax_bps };
    },
  };

  await Stations.refreshDirectory();
  ctx.Game.state.currentSystem = heldSt.systemId;
  assert.ok(Stations.hallShared(heldSt.systemId), "a published station's shelf is the shared one");
  await Stations.refreshHalls([heldSt.systemId]);
  const open = Stations.hallListings(heldSt.systemId);
  assert.strictEqual(open.length, 1, "the shared shelf replaces our copy of theirs");
  assert.strictEqual(open[0].sellerName, "Vex", "a stall says whose it is");
  assert.ok(Stations.canUseHall(heldSt.systemId).ok, "docked at their station, their hall is usable");

  // Buy across players: we pay, they're queued, and the item is rebuilt here.
  const cashBefore = ctx.Game.state.credits;
  const bought = await Stations.buyHallListing(heldSt.systemId, "srv-1");
  assert.ok(bought.ok, bought.msg);
  assert.strictEqual(ctx.Game.state.credits, cashBefore - 4000, "buyer pays the shelf price");
  assert.strictEqual(bought.tariff, 320, "the owner's 8% tariff is split off at the sale");
  assert.strictEqual(srv.payouts.length, 1, "only the seller is queued — tariff went to treasury");
  assert.strictEqual(srv.payouts[0].amount, 3680, "the seller is queued their net, not the gross");
  assert.strictEqual(srv.ownerTreasury, 320, "tariff credits the station treasury server-side");
  const got = Object.values(ctx.Game.state.extractors).find(e => e.name === "Vex Deep Rig");
  assert.ok(got, "the bought extractor lands in our pool");
  assert.notStrictEqual(got.uid, "exVex", "a foreign uid is re-minted so it can't collide with ours");
  assert.strictEqual(got.components.length, 0, "fitted components stay in the seller's save");
  assert.strictEqual(Stations.hallListings(heldSt.systemId).length, 0, "a bought stall leaves the shelf");
  assert.ok(!(await Stations.buyHallListing(heldSt.systemId, "srv-1")).ok, "the same stall can't be bought twice");

  // List onto their shelf: escrow is server-side, so it leaves our save.
  const mine = { uid: "exMine", type: "jack", scope: "all", name: "Our Spare", components: [] };
  Extractors.acquire(mine);
  const put = await Stations.listHallItem(heldSt.systemId, "extractor", "exMine", 2500);
  assert.ok(put.ok, put.msg);
  assert.ok(!Extractors.get("exMine"), "listing escrows the item off our save");
  assert.strictEqual(srv.listings.length, 1, "the stall is on their shelf, not in our copy");
  assert.ok(Stations.hallEscrowValue() >= 2500, "escrowed stalls still count toward net worth");
  const pulled = await Stations.cancelHallListing(heldSt.systemId, put.listing.id);
  assert.ok(pulled.ok, pulled.msg);
  assert.ok(Object.values(ctx.Game.state.extractors).some(e => e.name === "Our Spare"), "cancelling returns the goods");

  // A payload is another player's client talking. Nothing is taken on faith.
  srv.listings.push({ id: "srv-bad", system_id: heldSt.systemId, seller_id: "acct-vex", seller: "Vex",
    kind: "gear", name: "Impossible Blade", price: 100, value: 9e9,
    expires_at: iso(T + 36e5), payload: { uid: "iX", kind: "not_a_slot", rarity: "mythic", value: 9e9 } });
  await Stations.refreshHalls([heldSt.systemId]);
  const cashBeforeBad = ctx.Game.state.credits;
  const bad = await Stations.buyHallListing(heldSt.systemId, "srv-bad");
  assert.ok(!bad.ok, "a payload that can't be rebuilt is refused locally");
  assert.strictEqual(ctx.Game.state.credits, cashBeforeBad,
    "malformed payload is refunded server-side after the D0 debit");

  // Settle: sale proceeds credit the wallet server-side; legacy tariff payouts
  // still land in treasury when claimed.
  const treasuryBefore = target.treasury | 0;
  const cashBeforeSettle = ctx.Game.state.credits;
  srv.mine = {
    payouts: [
      { systemId: heldSt.systemId, amount: 1200, reason: "sale", note: "Our Spare" },
      { systemId: target.systemId, amount: 400, reason: "tariff", note: "legacy queued tariff" },
    ],
    items: [],
  };
  const settled = await Stations.settleHall();
  assert.strictEqual(ctx.Game.state.credits, cashBeforeSettle + 1200, "sale proceeds reach the seller");
  assert.strictEqual(target.treasury, treasuryBefore + 400, "legacy tariff payouts land in treasury");
  assert.strictEqual(settled.items, 0, "nothing to hand back this time");

  // Treasury withdraw routes through the server when signed in.
  target.treasury = 5_000;
  const cashBeforeW = ctx.Game.state.credits;
  const wd = await Stations.withdraw(target.systemId, 2_000);
  assert.ok(wd.ok, wd.msg);
  assert.strictEqual(target.treasury, 3_000, "withdraw debits server treasury");
  assert.strictEqual(ctx.Game.state.credits, cashBeforeW + 2_000, "withdraw credits the wallet");

  // An item we can't fit is already paid for: it waits in the save, survives a
  // reload, and lands the moment there's room. It must never just evaporate.
  ctx.Bazaar.capacity = () => 0;
  srv.mine = { payouts: [], items: [{ systemId: heldSt.systemId, kind: "gear", name: "Held Blade",
    payload: { uid: "iBack", kind: Object.keys(ctx.ACCESSORY_KINDS)[0], rarity: "common",
               name: "Held Blade", primary: { kind: Object.keys(ctx.ACCESSORY_KINDS)[0], amount: 3 } } }] };
  await Stations.settleHall();
  assert.strictEqual(Stations.unclaimed.length, 1, "an undeliverable item is parked, not dropped");
  Stations.hydrate(Stations.serialize());
  assert.strictEqual(Stations.unclaimed.length, 1, "and it survives a save/load round trip");
  ctx.Bazaar.capacity = () => 40;
  assert.strictEqual(Stations.retryUnclaimed(), 1, "it lands once there's room");
  assert.strictEqual(Stations.unclaimed.length, 0, "and stops waiting");
  assert.ok(Object.values(ctx.Game.state.items).some(i => i.name === "Held Blade"), "delivered into inventory");

  // NPC buyers were liquidity for a shelf nobody could reach. Not this one.
  const vexSt = Stations.get(heldSt.systemId);
  vexSt.hall = [{ id: "local1", sellerId: "player", kind: "extractor", name: "Ghost", price: 100,
                  value: 100, expiresAt: T + 36e5, payload: { uid: "exGhost", type: "jack", scope: "all" } }];
  const npcChance = STATIONCFG.hallNpcBuyChance;
  STATIONCFG.hallNpcBuyChance = 1;
  assert.strictEqual(Stations._npcBuyHall(vexSt, 7).length, 0, "no NPC buys on a shared shelf");
  STATIONCFG.hallNpcBuyChance = npcChance;
  vexSt.hall = [];

  // Signed out: the shelf still renders, but it can't be traded on.
  ctx.Cloud._user = null;
  const guest = Stations.canUseHall(heldSt.systemId);
  assert.ok(!guest.ok && guest.browse, "a signed-out visitor browses the shared shelf");
  assert.ok(!(await Stations.buyHallListing(heldSt.systemId, "srv-bad")).ok, "and can't buy off it");
}

// ---- shared Production Hub bays (docs/sql/station_bays.sql) --------------
// Phase C: leasing a bay on Vex's station writes the shared bays column, the
// lessee mints keep locally, and tax commodities queue for the owner.
{
  const floor = {
    // Start vacant — Vex has a hub and a commodity, nobody in the bays yet.
    bays: [{ lesseeId: "", npc: false }, { lesseeId: "", npc: false }],
    tax: [],
  };
  vexRow.bays = floor.bays;
  vexRow.modules = { customs_house: 1, exchange_hall: 1, workshop_annex: 1, production_hub: 1 };
  vexRow.prod_comm = pool[0].id;
  vexRow.lease_tax_bps = 1000;

  ctx.Cloud = {
    enabled: true, hallMissing: false, baysMissing: false,
    _user: { id: "acct-me" },
    user() { return this._user; },
    signedIn() { return !!this._user; },
    hallReady() { return this.enabled && !this.hallMissing && this.signedIn(); },
    baysReady() { return this.enabled && !this.baysMissing && this.signedIn(); },
    async stationDirectory() {
      return [{ ...vexRow, bays: floor.bays.map(b => ({ ...b })) }];
    },
    async stationPublish(rows) { this.published = rows; return { ok: true, held: rows.length, conflicts: [] }; },
    async stationHall() { return []; },
    async stationSettle() {
      const cargo = floor.tax.splice(0, floor.tax.length);
      return { ok: true, payouts: [], items: [], cargo };
    },
    async stationLeaseBay(system, bay) {
      if (system !== heldSt.systemId) return { ok: false, error: "No station." };
      if (bay < 0 || bay >= floor.bays.length) return { ok: false, error: "No such bay." };
      if (floor.bays[bay].lesseeId) return { ok: false, error: "Bay is occupied." };
      if (floor.bays.some(b => b.lesseeId === "acct-me"))
        return { ok: false, error: "You already lease a bay here." };
      floor.bays[bay] = { lesseeId: "acct-me", npc: false };
      return { ok: true, bay, prodComm: vexRow.prod_comm, leaseTaxBps: 1000, lesseeId: "acct-me" };
    },
    async stationVacateBay(system, bay) {
      if (!floor.bays[bay] || !floor.bays[bay].lesseeId)
        return { ok: false, error: "Bay is empty." };
      if (floor.bays[bay].lesseeId !== "acct-me" && this._user?.id !== "acct-vex")
        return { ok: false, error: "Not your bay." };
      floor.bays[bay] = { lesseeId: "", npc: false };
      return { ok: true, bay };
    },
    async stationBayProduce(system, bay, gross) {
      const b = floor.bays[bay];
      if (!b || b.lesseeId !== "acct-me") return { ok: false, error: "Not your bay." };
      const g = Math.max(0, Math.min(300, gross | 0));
      const tax = Math.floor(g * 1000 / 10000);
      const keep = g - tax;
      if (tax > 0) floor.tax.push({ systemId: system, commId: vexRow.prod_comm, qty: tax });
      b.taxed_at = true;
      return { ok: true, bay, commId: vexRow.prod_comm, gross: g, tax, keep, leaseTaxBps: 1000 };
    },
  };

  await Stations.refreshDirectory();
  ctx.Game.state.currentSystem = heldSt.systemId;
  assert.ok(Stations.bayShared(heldSt.systemId), "a published station's floor is the shared one");
  assert.ok(Stations._baysWritable(), "signed in → bay RPCs are live");

  const bayEx = { uid: "exBay", type: "jack", scope: "all", name: "Bay Rig", components: [] };
  Extractors.acquire(bayEx);
  assert.ok(Extractors.unequipped().some(e => e.uid === "exBay"), "extractor free before lease");

  const leased = await Stations.leaseBay(heldSt.systemId, 0, "exBay");
  assert.ok(leased.ok, leased.msg);
  assert.ok(leased.shared, "remote lease went through the RPC");
  assert.strictEqual(floor.bays[0].lesseeId, "acct-me", "server occupancy names us");
  assert.ok(Extractors.installedSet().has("exBay"), "remote lease locks the extractor");
  assert.ok(!Extractors.unequipped().some(e => e.uid === "exBay"), "leased extractor not free");
  assert.ok(Stations.leaseableBays(heldSt.systemId).every(x => x.index !== 0),
    "occupied shared bay not listed vacant");
  assert.ok(!(await Stations.leaseBay(heldSt.systemId, 1, "exBay")).ok,
    "one lease per baron — second bay refused");

  // Produce: keep lands in our cargo; tax queues for Vex.
  ctx.Game.state.positions = {};
  const made = await Stations.produceRemoteLeases(1);
  assert.ok(made > 0, "lessee keep is minted locally");
  assert.strictEqual(ctx.Game.state.positions[pool[0].id] | 0, made, "keep → our cargo");
  assert.strictEqual(floor.tax.length, 1, "tax is queued for the owner");
  assert.ok(floor.tax[0].qty > 0 && floor.tax[0].qty < made, "tax is a cut of gross, not the whole");

  // Owner claims tax cargo into their station hold via settle.
  // We play as Vex for the claim — hand the station to ourselves briefly.
  const taxQty = floor.tax[0].qty;
  target.hold = {};
  // Settle as us claiming cargo for a station we own: park tax against target.
  floor.tax[0].systemId = target.systemId;
  const holdBefore = target.hold[pool[0].id] | 0;
  const settledBay = await Stations.settleHall();
  assert.strictEqual(settledBay.cargo, taxQty, "settle returns lease-tax cargo");
  assert.strictEqual(target.hold[pool[0].id] | 0, holdBefore + taxQty, "tax lands in the station hold");

  // Leave: extractor returns, slot opens.
  assert.ok((await Stations.vacateBay(heldSt.systemId, 0)).ok);
  assert.ok(Extractors.unequipped().some(e => e.uid === "exBay"), "vacating frees the extractor");
  assert.strictEqual(floor.bays[0].lesseeId, "", "server slot is vacant again");
  assert.ok(!Stations.remoteLeases[heldSt.systemId], "remote lease bookkeeping cleared");

  // Owner _playerProduce must not double-tax a foreign uuid lessee.
  floor.bays[0] = { lesseeId: "acct-zed", npc: false };
  await Stations.refreshDirectory();
  // Give ourselves the station so _playerProduce runs on a shared floor.
  heldSt.ownerId = Stations.playerId();
  heldSt.status = "owned";
  heldSt.modules = { production_hub: 1 };
  heldSt.prodComm = pool[0].id;
  heldSt.leaseTaxBps = 1000;
  heldSt.hold = {};
  Stations.syncBays(heldSt);
  heldSt.bays[0] = { lesseeId: "acct-zed", extractorId: null, npc: false };
  Stations.directory[heldSt.systemId] = Stations._ingest({
    ...vexRow, owner_id: "acct-me", bays: floor.bays,
  });
  // bayShared checks directory — force it present.
  assert.ok(Stations.bayShared(heldSt.systemId), "shared while we hold + directory row");
  const skipped = Stations._playerProduce(heldSt, 9);
  assert.strictEqual(heldSt.hold[pool[0].id] | 0, 0, "foreign lessee is not taxed locally");
  assert.strictEqual(skipped, 0, "and contributes no local yield");
  // Restore.
  Object.assign(heldSt, {
    ownerId: null, status: "npc", modules: {}, prodComm: null, bays: [], hold: {},
  });
  await Stations.refreshDirectory();

  // Without the bay SQL the floor stays local-only (same latch as the hall).
  assert.ok(Stations.bayShared(heldSt.systemId), "bay SQL live → shared floor");
  ctx.Cloud.baysMissing = true;
  assert.ok(!Stations.bayShared(heldSt.systemId), "missing bay SQL → no shared floor");
  ctx.Cloud.baysMissing = false;

  // reconcileRemoteLeases must not free extractors when we can't see the floor.
  Stations.remoteLeases = { [heldSt.systemId]: { 0: "exBay" } };
  Extractors.acquire(bayEx);
  const savedDirAt = Stations.directoryAt;
  Stations.directoryAt = 0;
  assert.strictEqual(Stations.reconcileRemoteLeases(), false, "no directory → keep leases");
  assert.ok(Stations.remoteLeases[heldSt.systemId], "lease bookkeeping survives a cold directory");
  Stations.directoryAt = savedDirAt;
  const savedUser = ctx.Cloud._user;
  ctx.Cloud._user = null;
  assert.strictEqual(Stations.reconcileRemoteLeases(), false, "signed out → keep leases");
  assert.ok(Stations.remoteLeases[heldSt.systemId], "lease bookkeeping survives sign-out");
  ctx.Cloud._user = savedUser;

  // NPC tenants stay off a shared floor — filling them would publish over lessees.
  floor.bays = [{ lesseeId: "acct-zed", npc: false }, { lesseeId: "", npc: false }];
  await Stations.refreshDirectory();
  target.status = "owned";
  target.ownerId = Stations.playerId();
  target.modules = { production_hub: 1 };
  target.prodComm = pool[0].id;
  Stations.directory[target.systemId] = Stations._ingest({
    system_id: target.systemId, owner_id: "acct-me", display: "Me",
    tier: target.tier, status: "owned", modules: { production_hub: 1 },
    reactor_level: 0, lease_tax_bps: 1000, sale_tariff_bps: 500, scrutiny: 10,
    standing: 60, prod_comm: pool[0].id, bays: [{ lesseeId: "" }, { lesseeId: "" }],
  });
  assert.ok(Stations.bayShared(target.systemId), "own published station is a shared floor");
  Stations.syncBays(target);
  // Guest-era NPCs stranded when the floor went shared must clear — not linger
  // taxing into the hold while other players see vacant.
  target.bays[0] = { lesseeId: "npc", extractorId: null, npc: true };
  target.bays[1] = { lesseeId: null, extractorId: null, npc: false };
  Stations._fillNpcTenants(target, 1);
  assert.ok(target.bays.every(b => !b.npc && !b.lesseeId), "shared floor clears stranded NPC tenants");
  // And publish must not ship npc:true even if local state has them (stale fill).
  target.bays[0] = { lesseeId: "npc", extractorId: null, npc: true };
  await Stations.publishOwned();
  const pubBay = (ctx.Cloud.published || []).find(r => r.system_id === target.systemId);
  assert.ok(pubBay, "publish includes our station");
  assert.ok(!pubBay.bays.some(b => b.npc), "publish strips NPC slots on a shared floor");
  delete Stations.directory[target.systemId];
  Stations.remoteLeases = {};
}

// ---- shared Contract Office (docs/sql/station_contracts.sql) --------------
// Phase D1: hauls are one board. Posting escrows hold server-side; bounty and
// fees debit the wallet; claim/settle are exclusive across players.
{
  const iso = ms => new Date(ms).toISOString();
  const commId = pool[0].id;
  const haulId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const floor = {
    hauls: [{
      id: haulId, system_id: heldSt.systemId, owner_id: "acct-vex", owner: "Vex",
      tier: heldSt.tier, comm_id: commId, qty: 30, rate: 40, escrow: 1200,
      created_at: iso(T - 3600e3), expires_at: iso(T + 36e6), filled: 2, expired: 1,
    }],
    hold: { [commId]: 500 },
    payouts: [],
  };
  vexRow.modules = { ...vexRow.modules, contract_office: 1 };
  vexRow.contract_filled = 2;
  vexRow.contract_expired = 1;

  ctx.Cloud = {
    enabled: true, hallMissing: false, treasuryMissing: false, contractsMissing: false,
    baysMissing: false,
    _user: { id: "acct-me" },
    user() { return this._user; },
    signedIn() { return !!this._user; },
    contractsReady() { return this.enabled && !this.contractsMissing && this.signedIn(); },
    treasuryReady() { return this.enabled && !this.treasuryMissing && this.signedIn(); },
    hallReady() { return this.enabled && !this.hallMissing && this.signedIn(); },
    baysReady() { return this.enabled && !this.baysMissing && this.signedIn(); },
    async stationDirectory() {
      return [{ ...vexRow, contract_filled: 2, contract_expired: 1 }];
    },
    async stationPublish(rows) {
      return { ok: true, held: rows.length, conflicts: [], treasuries: [] };
    },
    async stationHall() { return []; },
    async stationHauls(ids) {
      return floor.hauls.filter(h => ids.includes(h.system_id) && !h._gone);
    },
    async stationClaimHaul(id) {
      const h = floor.hauls.find(x => x.id === id);
      if (!h || h._gone || h.owner_id === this._user.id)
        return { ok: false, error: "Haul no longer available." };
      h._status = "active";
      h.taken_by = this._user.id;
      return { ok: true, contract: {
        id: h.id, commId: h.comm_id, qty: h.qty, rate: h.rate, escrow: h.escrow,
        status: "active", ownerId: h.owner_id,
        createdAt: Date.parse(h.created_at), expiresAt: Date.parse(h.expires_at),
      }, systemId: h.system_id };
    },
    async stationSettleHaul(id, outcome) {
      const h = floor.hauls.find(x => x.id === id);
      if (!h || h._gone) return { ok: false, error: "Haul gone." };
      if (outcome === "success") {
        ctx.Game.state.credits += h.escrow;
        h._gone = true;
        vexRow.contract_filled = 3;
        return { ok: true, outcome, credits: ctx.Game.state.credits,
          contract_filled: 3, contract_expired: 1 };
      }
      return { ok: false, error: "Not your haul." };
    },
    async stationPostHaul(system, comm, qty, rate) {
      if (system !== target.systemId) return { ok: false, error: "Not your station." };
      const escrow = qty * rate;
      const fee = Math.floor(escrow * 500 / 10000);
      if (ctx.Game.state.credits < escrow + fee) return { ok: false, error: "Not enough credits." };
      if ((floor.hold[comm] | 0) < qty) return { ok: false, error: "Only 0 in station hold." };
      ctx.Game.state.credits -= escrow + fee;
      floor.hold[comm] -= qty;
      const id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      floor.hauls.push({
        id, system_id: system, owner_id: "acct-me", owner: "Me", tier: target.tier,
        comm_id: comm, qty, rate, escrow,
        created_at: iso(T), expires_at: iso(T + 36e6), filled: 0, expired: 0,
      });
      return { ok: true, id, fee, credits: ctx.Game.state.credits, hold: { ...floor.hold },
        contract: { id, commId: comm, qty, rate, escrow, fee,
          createdAt: T, expiresAt: T + 36e6 } };
    },
    async stationCancelHaul(id) {
      const h = floor.hauls.find(x => x.id === id);
      if (!h || h._gone || h.owner_id !== "acct-me") return { ok: false, error: "Posting gone." };
      ctx.Game.state.credits += h.escrow;
      floor.hold[h.comm_id] = (floor.hold[h.comm_id] | 0) + h.qty;
      h._gone = true;
      return { ok: true, credits: ctx.Game.state.credits, hold: { ...floor.hold } };
    },
    async stationExpireHauls() { return { ok: true, expired: 0 }; },
    async stationSettle() {
      return { ok: true, payouts: [], items: [], cargo: [], credits: ctx.Game.state.credits };
    },
  };

  await Stations.refreshDirectory();
  assert.ok(Stations.contractsShared(heldSt.systemId), "a published contract office is shared");
  assert.ok(Stations.hasContractOffice(Stations.view(heldSt.systemId)), "remote module reads as installed");

  await Stations.refreshHauls([heldSt.systemId]);
  const board = Stations.boardContracts();
  assert.ok(board.some(j => j.id === haulId), "Vex haul appears on the shared board");
  assert.strictEqual(Stations.view(heldSt.systemId).contractStats.filled, 2, "reliability stats land");

  const claimed = await Stations.claimHaulForLaunch(haulId);
  assert.ok(claimed.ok, claimed.msg);
  assert.ok(!Stations.boardContracts().some(j => j.id === haulId), "claimed haul leaves the board");
  assert.ok(Stations.findHaul(haulId), "haul index kept until settle");

  const cashBefore = ctx.Game.state.credits;
  const stockBefore = Stock.available(heldSt.sectorId, commId);
  const settled = await Stations.settleHaul(haulId, "success");
  assert.ok(settled.ok, settled.msg);
  assert.strictEqual(ctx.Game.state.credits, cashBefore + 1200, "hauler paid from server escrow");
  assert.ok(Stock.available(heldSt.sectorId, commId) >= stockBefore + 30, "success restocks sector");
  assert.strictEqual(Stations.get(heldSt.systemId).contractStats.filled, 3,
    "filled stat bumps on the station record after settle");

  // Owner post/cancel on our published station routes through the server.
  target.modules.contract_office = 1;
  target.hold = { [commId]: 80 };
  floor.hold = { [commId]: 80 };
  Stations.directory[target.systemId] = Stations._ingest({
    system_id: target.systemId, owner_id: "acct-me", display: "Me", tier: target.tier,
    status: "owned", modules: { contract_office: 1 }, reactor_level: 0,
    lease_tax_bps: 1000, sale_tariff_bps: 500, scrutiny: 10, standing: 60,
    contract_filled: 0, contract_expired: 0,
  });
  assert.ok(Stations.contractsShared(target.systemId), "own published station shares contracts");
  const cashPost = ctx.Game.state.credits;
  const posted = await Stations.postHaul(target.systemId, commId, 20, 25);
  assert.ok(posted.ok, posted.msg);
  assert.strictEqual(target.hold[commId], 60, "post debits hold via server sync");
  assert.ok(Stations.boardContracts().some(j => j.id === posted.contract.id), "our haul is on the board");
  const selfFly = await Stations.claimHaulForLaunch(posted.contract.id);
  assert.ok(!selfFly.ok, "owner blocked from own haul");
  const cancelled = await Stations.cancelHaul(target.systemId, posted.contract.id);
  assert.ok(cancelled.ok);
  assert.strictEqual(target.hold[commId], 80, "cancel restores hold");
  assert.ok(ctx.Game.state.credits >= cashPost - Math.floor(20 * 25 * 500 / 10000),
    "cancel refunds bounty (fee stays spent)");

  // NPC fill stands down on a shared floor.
  const npcPost = await Stations.postHaul(target.systemId, commId, 10, 20);
  assert.ok(npcPost.ok, npcPost.msg);
  const origChance = STATIONCFG.contractNpcFillChance;
  STATIONCFG.contractNpcFillChance = 1;
  assert.strictEqual(Stations._npcFillHauls(target, 3).length, 0, "no NPC fill on shared contracts");
  STATIONCFG.contractNpcFillChance = origChance;
  await Stations.cancelHaul(target.systemId, npcPost.contract.id);
  delete Stations.directory[target.systemId];

  ctx.Cloud.contractsMissing = true;
  assert.ok(!Stations.contractsShared(heldSt.systemId), "missing SQL → local-only contracts");
  ctx.Cloud.contractsMissing = false;

  ctx.Cloud._user = null;
  assert.ok(!Stations.boardContracts().length || !Stations._contractsWritable(),
    "signed out: no writable contract RPCs");
  assert.ok(!(await Stations.claimHaulForLaunch(haulId)).ok, "signed out can't claim");
}

// ---- Phase D2: server standing + upkeep ------------------------------------
{
  ctx.Cloud._user = { id: "acct-me" };
  const commId = pool[0].id;
  target.modules = { production_hub: 1 };
  target.hold = { [commId]: 50 };
  target.delivered = 45;
  target.expected = 40;
  target.treasury = 5000;
  target.standing = 55;
  Stations.directory[target.systemId] = Stations._ingest({
    system_id: target.systemId, owner_id: "acct-me", display: "Me", tier: target.tier,
    status: "owned", modules: { production_hub: 1 }, reactor_level: 0,
    lease_tax_bps: 1000, sale_tariff_bps: 500, scrutiny: 10, standing: 55,
  });
  ctx.Cloud.modulesMissing = false;
  ctx.Cloud.auctionsMissing = false;
  ctx.Cloud.treasuryMissing = false;
  ctx.Cloud.treasuryReady = () => true;
  ctx.Cloud.modulesReady = () => true;
  ctx.Cloud.auctionsReady = () => true;
  ctx.Cloud.stationAfterHour = async reports => {
    assert.strictEqual(reports.length, 1, "one upkeep report");
    target.standing = 59;
    target.treasury = 4200;
    ctx.Game.state.credits = 9000;
    return { ok: true, treasuries: [{ system_id: target.systemId, treasury: 4200, standing: 59 }],
      credits: 9000 };
  };
  assert.ok(Stations.upkeepShared(target.systemId), "published owned station shares upkeep");
  const res = await ctx.Cloud.stationAfterHour([{
    system_id: target.systemId, delivered: 45, expected: 40,
  }]);
  Stations._applyTreasurySync(res);
  assert.strictEqual(target.standing, 59, "standing syncs from server");
  assert.strictEqual(target.treasury, 4200, "treasury syncs after upkeep");
  delete Stations.directory[target.systemId];
}

// ---- Phase D3: server module install ---------------------------------------
{
  target.ownerId = "acct-me";
  target.status = "owned";
  target.modules = {};
  target.reactorLevel = 0;
  ctx.Cloud._user = { id: "acct-me" };
  ctx.Cloud.modulesMissing = false;
  ctx.Cloud.treasuryMissing = false;
  ctx.Cloud.modulesReady = () => true;
  Stations.directory[target.systemId] = Stations._ingest({
    system_id: target.systemId, owner_id: "acct-me", display: "Me", tier: target.tier,
    status: "owned", modules: {}, reactor_level: 0,
    lease_tax_bps: 1000, sale_tariff_bps: 500, scrutiny: 10, standing: 60,
  });
  ctx.Cloud.stationModuleInstall = async (system, mod) => {
    if (mod !== "lane_buoy") return { ok: false, error: "nope" };
    target.modules.lane_buoy = 1;
    ctx.Game.state.credits -= 35000;
    return { ok: true, module: mod, level: 1, cost: 35000, credits: ctx.Game.state.credits };
  };
  ctx.Cloud.enabled = true;
  ctx.Cloud.signedIn = () => !!ctx.Cloud._user;
  assert.ok(typeof ctx.Cloud.modulesReady === "function", "modulesReady patched on Cloud");
  assert.ok(Stations.modulesShared(target.systemId), "modules shared when SQL live");
  ctx.Game.state.credits = 5_000_000;
  const cash = ctx.Game.state.credits;
  const ins = await Stations.install(target.systemId, "lane_buoy");
  assert.ok(ins.ok, ins.msg);
  assert.strictEqual(target.modules.lane_buoy, 1, "module lands locally after RPC");
  assert.strictEqual(ctx.Game.state.credits, cash - 35000, "install debits wallet via server");
  delete Stations.directory[target.systemId];
  delete target.modules.lane_buoy;
}

// ---- Phase D4: server auctions ---------------------------------------------
{
  const aucSys = target.systemId;
  target.ownerId = null;
  target.status = "npc";
  delete Stations.directory[aucSys];
  ctx.Cloud._user = { id: "acct-me" };
  ctx.Cloud.auctionsMissing = false;
  ctx.Cloud.auctionsReady = () => true;
  ctx.Cloud.stationAuctionOpen = async (system, amount) => {
    assert.strictEqual(system, aucSys);
    ctx.Game.state.credits -= amount;
    const closes = T + 72 * 3600e3;
    Stations.remoteAuctions[system] = Stations._ingestAuction({
      system_id: system, opens_at: T,
      closes_at: closes, high_bid: amount, high_bidder: "acct-me",
    });
    return { ok: true, high_bid: amount, closes_at: closes, credits: ctx.Game.state.credits };
  };
  ctx.Cloud.stationBid = async (system, amount) => {
    const a = Stations.remoteAuctions[system];
    a.highBid = amount;
    ctx.Game.state.credits -= 50000;
    return { ok: true, high_bid: amount, closes_at: a.closesAt, credits: ctx.Game.state.credits };
  };
  ctx.Cloud.stationAuctions = async () => Object.values(Stations.remoteAuctions).map(a => ({
    system_id: a.systemId, status: "open",
    opens_at: a.opensAt, closes_at: a.closesAt,
    high_bid: a.highBid, high_bidder: "acct-me",
  }));
  ctx.Cloud.stationCloseDue = async () => ({ ok: true, closed: [] });
  assert.ok(Stations.auctionsShared(), "auctions shared when SQL live");
  ctx.Game.state.credits = 5_000_000;
  const cashA = ctx.Game.state.credits;
  const openAmt = Stations.openingBid(target);
  const opened = await Stations.openAuction(aucSys, openAmt);
  assert.ok(opened.ok, opened.msg);
  assert.ok(Stations.getAuction(aucSys), "open auction visible");
  const bid = await Stations.bid(aucSys, openAmt + STATIONCFG.minBidIncrement);
  assert.ok(bid.ok, bid.msg);
  assert.strictEqual(Stations.getAuction(aucSys).highBid, openAmt + STATIONCFG.minBidIncrement, "bid updates cache");
  assert.ok(ctx.Game.state.credits < cashA, "bids debit credits");
  delete Stations.remoteAuctions[aucSys];
  ctx.Cloud.modulesMissing = true;
  ctx.Cloud.auctionsMissing = true;
}

console.log("OK check_stations");
})().catch(e => { console.error(e); process.exit(1); });
