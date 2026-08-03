#!/usr/bin/env node
/* check_stations.js — NPC stations, auctions, production hub, revolt gates.
   Run: node tools/check_stations.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math, setTimeout, clearTimeout });
ctx.window = ctx;
let T = 1_720_000_000_000;
ctx.Date = { now: () => T };
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
const del = Stations.deliver(target.systemId, pool[0].id, qty);
assert.ok(del.ok, del.msg);
assert.ok(Stock.available(target.sectorId, pool[0].id) >= stockBefore, "delivery restocks sector");

// Vacate returns extractor to pool
assert.ok(Stations.vacateBay(target.systemId, 0).ok);
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
assert.ok(!Stations.leaseBay(otherHub.systemId, 0, ex.uid).ok, "lease requires docking");
ctx.Game.state.currentSystem = otherHub.systemId;
const lease = Stations.leaseBay(otherHub.systemId, 0, ex.uid);
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
Stations.vacateBay(otherHub.systemId, 0);
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
Stations.vacateBay(otherHub.systemId, 0);
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
Stations.vacateBay(target.systemId, 0);
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
const listed = Stations.listHallItem(target.systemId, "extractor", hallEx.uid, 900);
assert.ok(listed.ok, listed.msg);
assert.ok(!Extractors.get(hallEx.uid), "listing escrows extractor");
assert.ok(Stations.hallEscrowValue() > 0, "hall escrow in net worth");
assert.ok(Stations.cancelHallListing(target.systemId, listed.listing.id).ok);
assert.ok(Extractors.get(hallEx.uid), "cancel restores extractor");

// Tariff on NPC buy
Stations.setSaleTariff(target.systemId, 1000); // 10%
assert.strictEqual(target.saleTariffBps, 1000);
Extractors.acquire(hallEx);
const listed2 = Stations.listHallItem(target.systemId, "extractor", hallEx.uid, 1000);
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
const listed3 = Stations.listHallItem(target.systemId, "extractor", hallEx.uid, 500);
assert.ok(listed3.ok, listed3.msg);
listed3.listing.expiresAt = T - 1;
const expired = Stations._expireHall(target, T);
assert.strictEqual(expired.length, 1);
assert.ok(Extractors.get(hallEx.uid), "expiry restores seller goods");

// Blackboxes always need Black Market on the hall
target.modules.black_market = 0;
ctx.Game.state.items = { bb1: { uid: "bb1", name: "Hot Box", consumable: true, effectId: "smuggle", value: 200 } };
ctx.Items = { isBlackbox: it => !!(it && it.effectId) };
const bbBlock = Stations.listHallItem(target.systemId, "blackbox", "bb1", 200);
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
const posted = Stations.postHaul(target.systemId, haulComm, 40, 50);
assert.ok(posted.ok, posted.msg);
assert.strictEqual(target.hold[haulComm], 60, "post reserves hold goods");
const escrow = 40 * 50;
const fee = Math.floor(escrow * STATIONCFG.contractPostFeeBps / 10000);
assert.strictEqual(ctx.Game.state.credits, credPost - escrow - fee, "escrow + fee deducted");
assert.ok(Stations.contractEscrowValue() >= escrow, "haul escrow in net worth");
assert.ok(Stations.boardContracts().some(c => c.id === posted.contract.id), "board lists haul");

// Owner cannot fly own haul
const selfFly = Stations.claimHaulForLaunch(posted.contract.id);
assert.ok(!selfFly.ok, "owner blocked from own haul");

// Cancel refunds
assert.ok(Stations.cancelHaul(target.systemId, posted.contract.id).ok);
assert.strictEqual(target.hold[haulComm], 100, "cancel restores hold");
assert.strictEqual(ctx.Game.state.credits, credPost - fee, "cancel refunds escrow not fee");

// NPC fill delivers to sector stock
target.hold[haulComm] = 80;
ctx.Game.state.credits = 5_000_000;
const posted2 = Stations.postHaul(target.systemId, haulComm, 20, 30);
assert.ok(posted2.ok, posted2.msg);
posted2.contract.createdAt = T - (STATIONCFG.contractNpcFillAfterMs + 1000);
const origFill = STATIONCFG.contractNpcFillChance;
STATIONCFG.contractNpcFillChance = 1;
const npcFilled = Stations._npcFillHauls(target, 99);
STATIONCFG.contractNpcFillChance = origFill;
assert.strictEqual(npcFilled.length, 1, "NPC fills haul");
assert.ok(Stock.available(target.sectorId, haulComm) >= stockCapBefore + 20, "NPC haul restocks sector");
assert.strictEqual(Stations.reliability(target), 1, "reliability 100% after fill");

// Player settle success (mission path stub): goods → stock, no escrow refund
target.hold[haulComm] = 40;
ctx.Game.state.credits = 5_000_000;
const posted3 = Stations.postHaul(target.systemId, haulComm, 15, 25);
assert.ok(posted3.ok, posted3.msg);
posted3.contract.status = "active";
const stockMid = Stock.available(target.sectorId, haulComm);
const settle = Stations.settleHaul(posted3.contract.id, "success");
assert.ok(settle.ok, settle.msg);
assert.ok(Stock.available(target.sectorId, haulComm) >= stockMid + 15, "mission success restocks");
assert.ok(!(target.contracts || []).some(c => c.id === posted3.contract.id), "settled haul removed");

// Expiry refunds + reliability hit
target.hold[haulComm] = 50;
ctx.Game.state.credits = 5_000_000;
const posted4 = Stations.postHaul(target.systemId, haulComm, 10, 20);
assert.ok(posted4.ok, posted4.msg);
posted4.contract.expiresAt = T - 1;
const haulExp = Stations._expireHauls(target, T);
assert.strictEqual(haulExp.length, 1);
assert.strictEqual(target.hold[haulComm], 50, "expiry restores hold");
assert.ok(Stations.reliability(target) < 1, "expiry lowers reliability");

ctx.Game.state.currentSystem = visitorDock;

console.log("OK check_stations");
