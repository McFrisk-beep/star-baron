#!/usr/bin/env node
/* check_damage.js — runnable check for the battle-damage / repair system.
   Loads the real game scripts (store, data, fleet, missions) into a bare vm
   context with the neighbouring modules stubbed, then asserts the damage math
   end-to-end with a pinned Math.random. Run:  node tools/check_damage.js     */
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console });
ctx.window = ctx;
for (const f of ["store.js", "data.js", "fleet.js", "missions.js"])
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });

// neighbours the fleet/mission code calls at runtime
ctx.Economy = { afterTax: x => x, refreshNetWorth() {}, checkAchievements() {} };
ctx.Rep = { rewardMult: () => 1, successBonus: () => 0, onContract() {} };
ctx.Items = { gen: () => ({ uid: "it" + Math.random() }) };
ctx.SHIP_NAME_A = ["Test"]; ctx.SHIP_NAME_B = ["Ship"];   // live in flavor.js

const { Fleet, Missions, DMGCFG, SHIP_CATALOG } = ctx;
const freshState = () => ({
  credits: 100000, seq: 1, ships: [], missions: [], reports: [], items: {},
  positions: {}, avgCost: {}, stats: {}, mainShip: { type: SHIP_CATALOG.main[0].id },
});
const mkMission = (st, uids, over) => st.missions.push({
  uid: "m" + (++st.seq), type: "combat", title: "t", shipUids: uids, phases: [],
  totalMs: 1000, startedAt: Date.now() - 5000, successChance: 0.9,
  reward: { credits: 1000 }, impound: false, danger: "high", stakeTier: 0,
  faction: null, resolved: false, ...over,
});
const pinRandom = v => vm.runInContext(`Math.random = () => ${v}`, ctx); // sandbox-only, host Math untouched

// 1) damaged stats: hull scales with (1-dmg); firepower/speed by the penalty; cargo untouched
let st = ctx.Game = { state: freshState() }, s = st.state;
const sh = Fleet.makeShip(SHIP_CATALOG.escort[0].id);
s.ships.push(sh);
const base = Fleet.stats(sh);
sh.dmg = 0.5;
const worn = Fleet.stats(sh);
assert(Math.abs(worn.hull - base.hull * 0.5) <= 1, "hull halves at 50% damage");
assert(Math.abs(worn.firepower - base.firepower * (1 - 0.5 * DMGCFG.statPenalty)) <= 1, "firepower penalised");
assert(Math.abs(worn.speed - base.speed * (1 - 0.5 * DMGCFG.statPenalty)) <= 0.05, "speed penalised");
assert(worn.cargo === base.cargo, "cargo untouched");

// 2) repair: costs credits scaled by damage, restores dmg to 0, idle-only
const price = SHIP_CATALOG.escort[0].price;
assert(Fleet.repairCost(sh) === Math.max(50, Math.round(price * DMGCFG.costRate * 0.5)), "repair cost math");
sh.status = "mission";
assert(!Fleet.repair(sh.uid).ok, "no repairs mid-mission");
sh.status = "idle";
const before = s.credits, r = Fleet.repair(sh.uid);
assert(r.ok && sh.dmg === 0 && s.credits === before - r.cost, "repair pays and heals");
assert(!Fleet.repair(sh.uid).ok, "nothing left to repair");

// 3) combat wipe: rolls of 0 destroy every ship → forced failure, no payout
ctx.Game = { state: (s = freshState()) };
let a = Fleet.makeShip("corvette"), b = Fleet.makeShip("frigate");
s.ships.push(a, b); a.status = b.status = "mission";
mkMission(s, [a.uid, b.uid], {});
pinRandom(0);
let rep = Missions.resolveMatured(Date.now())[0];
assert(rep.wipe && !rep.success && rep.lost.length === 2, "all ships destroyed = mission over");
assert(s.ships.length === 0 && s.credits === 100000, "wrecks removed, no payout");

// 4) failed combat: survivors limp home idle and damaged
ctx.Game = { state: (s = freshState()) };
a = Fleet.makeShip("corvette"); s.ships.push(a); a.status = "mission";
mkMission(s, [a.uid], { successChance: 0.03 });
pinRandom(0.5);   // fails the 3% roll, survives the destroy roll, takes the hit
rep = Missions.resolveMatured(Date.now())[0];
assert(!rep.success && !rep.lost.length && rep.damaged.length === 1, "failure damages the survivor");
assert(a.status === "idle" && a.dmg > 0.3, "limped home battered");

// 5) failed smuggle: impounded (never destroyed), still dinged from the chase
ctx.Game = { state: (s = freshState()) };
a = Fleet.makeShip("corvette"); s.ships.push(a); a.status = "mission";
mkMission(s, [a.uid], { type: "smuggle", impound: true, successChance: 0.03 });
pinRandom(0.5);
rep = Missions.resolveMatured(Date.now())[0];
assert(rep.impounded.length === 1 && !rep.lost.length, "smuggle failure impounds");
assert(a.status === "impounded" && a.retrieveCost > 0 && a.dmg > 0, "seized with chase damage");

// 6) routine courier success: paid, unscathed on a mild roll
ctx.Game = { state: (s = freshState()) };
a = Fleet.makeShip("mule"); s.ships.push(a); a.status = "mission";
mkMission(s, [a.uid], { type: "transport", danger: "safe", successChance: 0.98 });
pinRandom(0.5);   // succeeds, and 0.5 > the 20% graze chance
rep = Missions.resolveMatured(Date.now())[0];
assert(rep.success && s.credits === 101000 && !rep.damaged.length && a.status === "idle" && !a.dmg, "clean courier run");

console.log("check_damage: all assertions passed ✔");
