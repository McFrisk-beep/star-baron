/* check_edict_experience.js — active edicts surface named attribution on
   trade / ban / industry / travel helpers. Loads real senate + economy into a
   shared vm with light stubs. No browser. */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const root = path.join(__dirname, "..");
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };

const ctx = { console, Math, Date, JSON, Object, Array, Number, String, isNaN, parseInt, parseFloat };
ctx.window = ctx;
ctx.matchMedia = () => ({ matches: false });
ctx.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
vm.createContext(ctx);
const load = f => vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx);
load("js/store.js");
load("js/data.js");
load("js/flavor.js");

const now = Date.now();
ctx.Game = { timeScale: 1, requestSave() {}, state: {
  credits: 5_000_000, prestige: { tier: 4 }, positions: { foodstuffs: 100, hydrogen: 0 },
  avgCost: { foodstuffs: 40 }, currentSystem: "navos", unlockedSystems: ["navos", "korrin"],
  ships: [{ uid: "s1", type: "mule", cls: "transport", name: "Old Faithful", status: "idle", accessories: [] }],
  mainShip: { type: "pinnace" },
  senate: { bills: [], nextVoteAt: 0, reps: {}, pending: null, cycle: 0, billSeq: 0, lastBillId: null, shared: false },
  industries: [], stats: { trades: 0, biggestTrade: 0 },
} };
ctx.Economy = null;
ctx.Rivals = { rank() { return 1; } };
ctx.Rep = { edgeForCategory() { return 0; }, onTrade() {}, get() { return 0; } };
ctx.Market = {
  spot() { return 50; }, impactAt() { return 0; }, addImpact() {},
  systemPrice() { return 50; }, activeLocal() { return []; },
};
ctx.Wars = { active() { return null; } };
ctx.Galaxy = { get() { return null; }, list: [] };
load("js/senate.js");
load("js/economy.js");
// fleet needs SYSTEMS — already in data.js; stub minimal Fleet for dock note
ctx.Fleet = {
  mainDef() { return { travelSpeed: 1 }; },
  fleetValue() { return 0; },
  mainBonus() { return 0; },
  dockTravelMs(fromId, toId) {
    const a = ctx.SYSTEMS.find(s => s.id === fromId), b = ctx.SYSTEMS.find(s => s.id === toId);
    const dist = Math.max(1, Math.abs((a?.distance ?? 0) - (b?.distance ?? 0)));
    const speed = 1 * (ctx.Senate ? ctx.Senate.travelSpeedMult() : 1);
    return (dist * 12 * 1000) / speed;
  },
  ship() { return null; },
};
ctx.Bus = ctx.Bus || { emit() {}, on() {} };

const Senate = ctx.Senate, Economy = ctx.Economy, SENATECFG = ctx.SENATECFG;
// Avoid achievement / net-worth side paths that need the full game graph.
Economy.refreshNetWorth = () => {};
Economy.checkAchievements = () => {};
const sen = Senate.sen();
sen.bills = [
  { id: "e1", status: "passed", type: "ban", title: "Foodstuffs Prohibition",
    effect: { type: "ban", commId: "foodstuffs" }, endsAt: now + 1e9 },
  { id: "e2", status: "passed", type: "tariff", title: "Gas Tariff",
    effect: { type: "tariff", cat: "gas", tax: 0.1 }, endsAt: now + 1e9 },
  { id: "e3", status: "passed", type: "subsidy", title: "Gas Subsidy",
    effect: { type: "subsidy", cat: "gas", mult: 1.09 }, endsAt: now + 1e9 },
  { id: "e4", status: "passed", type: "industryTax", title: "Industrial Levy: Agri-Collective",
    effect: { type: "industryTax", faction: "agri_collective", add: 0.06 }, endsAt: now + 1e9 },
  { id: "e5", status: "passed", type: "warpGate", title: "Warp-Lane Standardization",
    effect: { type: "warpGate", add: 0.015 }, endsAt: now + 1e9 },
  { id: "e6", status: "passed", type: "windfall", title: "Windfall Levy",
    effect: { type: "windfall", add: 0.06 }, endsAt: now + 1e9 },
  { id: "e7", status: "passed", type: "shipBan", title: "Transport Restriction Act",
    effect: { type: "shipBan", cls: "transport" }, endsAt: now + 1e9 },
];
Senate._bumpRev();

const ban = Senate.banInfo("foodstuffs", "agri");
assert(ban && /Foodstuffs Prohibition/.test(ban.title), "banInfo names the prohibition bill");
assert(/Foodstuffs has been banned due to Foodstuffs Prohibition/.test(Economy.banMsg("foodstuffs")), "banMsg names resource + bill");

assert(Economy.maxBuy("foodstuffs") === 0 && Economy.maxSell("foodstuffs") === 0, "banned commodity blocks buy and sell caps");
const sellFail = Economy._sellLocal("foodstuffs", 10);
assert(!sellFail.ok && /banned due to/i.test(sellFail.msg), "sell fails with named ban");

const duties = Senate.tariffLines("gas");
assert(duties.length === 1 && duties[0].title === "Gas Tariff", "tariffLines names Gas Tariff");
const market = Senate.priceEdictLines("hydrogen", "gas");
assert(market.some(m => m.title === "Gas Subsidy"), "priceEdictLines names Gas Subsidy");

const ind = Senate.industryTaxLines("agri_collective");
assert(ind.some(l => /Industrial Levy/.test(l.title) && l.rate === 0.06), "industryTaxLines names the levy");

assert(Senate.shipBanInfo("transport").title === "Transport Restriction Act", "shipBanInfo names restriction act");

const taxLines = Economy.baronTaxLines();
assert(taxLines.some(l => /Plutocrat/.test(l.title)), "baronTaxLines includes tier tax");
assert(taxLines.some(l => l.title === "Windfall Levy"), "baronTaxLines includes Windfall Levy for top-ranked baron");

const eta = ctx.Fleet.dockTravelMs("navos", "korrin");
const note = Senate.travelEdictNote(eta);
assert(/Warp-Lane Standardization/.test(note) && /due to/.test(note), "travelEdictNote attributes saved time to warp bill: " + note);

// Buy of a non-banned gas good should carry duty + market edict receipts
ctx.Game.state.credits = 5_000_000;
const buy = Economy._buyLocal("hydrogen", 5);
assert(buy.ok && buy.duties.some(d => d.title === "Gas Tariff"), "buy receipt lists Gas Tariff");
assert(buy.marketEdicts.some(m => m.title === "Gas Subsidy"), "buy receipt lists Gas Subsidy");

console.log("All edict-experience checks passed.");
