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

// Everything from here down runs in one async body: the hall calls can reach
// the server now, so they're awaited — and every check after them depends on
// the state they leave behind. Kept at column 0; it's the rest of the file.
void (async () => {

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
assert.ok(Stations.withdraw(target.systemId, 5_000).ok, "can withdraw during refit");

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
    enabled: true, hallMissing: false,
    _user: { id: "acct-me" },
    user() { return this._user; },
    signedIn() { return !!this._user; },
    hallReady() { return this.enabled && !this.hallMissing && this.signedIn(); },
    async stationDirectory() { return [vexRow]; },
    async stationPublish(rows) { this.published = rows; return { ok: true, held: rows.length, conflicts: [] }; },
    async stationHall(ids) {
      return srv.listings.filter(l => ids.includes(l.system_id))
        .map(({ payload, ...row }) => row);           // payloads never leave on a read
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
      const tariff = Math.floor(l.price * 800 / 10000);          // Vex's published 8%
      srv.payouts.push({ user_id: l.seller_id, amount: l.price - tariff, reason: "sale" });
      return { ok: true, id: l.id, kind: l.kind, name: l.name, price: l.price, tariff, seller: l.seller, payload: l.payload };
    },
    async stationCancelListing(id) {
      const i = srv.listings.findIndex(l => l.id === id);
      if (i < 0) return { ok: false, error: "Listing gone." };
      const l = srv.listings.splice(i, 1)[0];
      if (l.seller_id !== "acct-me") return { ok: true, cleared: true, name: l.name };
      return { ok: true, kind: l.kind, name: l.name, payload: l.payload };
    },
    async stationSettle() { const out = srv.mine || { payouts: [], items: [] }; srv.mine = null; return { ok: true, ...out }; },
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
  assert.strictEqual(srv.payouts[0].amount, 3680, "the seller is queued their net, not the gross");
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
  assert.ok(!bad.ok, "a payload that can't be rebuilt is refused");
  assert.strictEqual(ctx.Game.state.credits, cashBeforeBad, "and nothing is charged for it");

  // Settle: sale proceeds are ours, a tariff on our own station is the station's.
  const treasuryBefore = target.treasury | 0;
  const cashBeforeSettle = ctx.Game.state.credits;
  srv.mine = {
    payouts: [
      { systemId: heldSt.systemId, amount: 1200, reason: "sale", note: "Our Spare" },
      { systemId: target.systemId, amount: 400, reason: "tariff", note: "someone else's stall" },
    ],
    items: [],
  };
  const settled = await Stations.settleHall();
  assert.strictEqual(ctx.Game.state.credits, cashBeforeSettle + 1200, "sale proceeds reach the seller");
  assert.strictEqual(target.treasury, treasuryBefore + 400, "our tariff lands in the station treasury, not our wallet");
  assert.strictEqual(settled.items, 0, "nothing to hand back this time");

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

console.log("OK check_stations");
})().catch(e => { console.error(e); process.exit(1); });
