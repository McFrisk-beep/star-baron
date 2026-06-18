/* economy.js — credits, exchange positions, docking, achievements, prestige.
   Ship/item purchases live in bazaar.js; this owns the credit balance, the
   commodity exchange, sector travel, net worth, and the prestige reset.        */

const ACHIEVEMENTS = [
  { id: "first_trade",    name: "First Blood",     desc: "Make your first trade.",
    test: s => s.stats.trades >= 1 },
  { id: "first_contract", name: "Open for Business",desc: "Complete a contract.",
    test: s => (s.stats.contractsDone || 0) >= 1 },
  { id: "first_100k",     name: "Six Figures",     desc: "Reach 100K net worth.",
    test: s => s.stats.peakNetWorth >= 100000 },
  { id: "first_million",  name: "First Million",    desc: "Reach 1M net worth.",
    test: s => s.stats.peakNetWorth >= 1000000 },
  { id: "fleet_three",    name: "A Real Fleet",    desc: "Own three ships.",
    test: s => s.ships.length >= 3 },
  { id: "warlord",        name: "Warlord",         desc: "Own an escort warship.",
    test: s => s.ships.some(sh => sh.cls === "escort") },
  { id: "explorer",       name: "Trailblazer",     desc: "Unlock a gated system.",
    test: s => s.unlockedSystems.length > 3 },
  { id: "collector",      name: "Collector",       desc: "Own a legendary accessory.",
    test: s => Object.values(s.items).some(it => it.rarity === "legendary") },
  { id: "smuggler",       name: "Risky Business",  desc: "Hold contraband.",
    test: s => (s.positions.contraband || 0) > 0 },
  { id: "whale",          name: "Whale",           desc: "Make a single trade worth 50K+.",
    test: s => s.stats.biggestTrade >= 50000 },
  { id: "prestige_one",   name: "Sold the Empire", desc: "Prestige for the first time.",
    test: s => s.prestige.tier >= 1 },
];

const Economy = {
  s() { return window.Game.state; },

  priceHere(commId) { return Market.systemPrice(commId, this.s().currentSystem); },
  inTransit() { return !!this.s().travel; },

  // effective half-spread for a category: base spread tightened by reputation, but
  // never to zero — so buy price stays above sell price and round-trips can't profit.
  _spread(cat) { return Math.max(REP.minSpread, REP.spread - Rep.edgeForCategory(cat)); },
  buyPrice(commId) {
    const cat = (COMMODITIES.find(c => c.id === commId) || {}).cat;
    return this.priceHere(commId) * (1 + this._spread(cat)) * (1 + (window.Senate ? Senate.tradeTax(cat, "buy") : 0));
  },
  sellPrice(commId) {
    const cat = (COMMODITIES.find(c => c.id === commId) || {}).cat;
    return this.priceHere(commId) * (1 - this._spread(cat)) * (1 - (window.Senate ? Senate.tradeTax(cat, "sell") : 0));
  },

  maxBuy(commId) {
    const cat = (COMMODITIES.find(c => c.id === commId) || {}).cat;
    if (window.Senate && Senate.isBanned(commId, cat)) return 0;
    const p = this.buyPrice(commId);
    return p > 0 ? Math.floor(this.s().credits / p) : 0;
  },

  buy(commId, qty) {
    const s = this.s();
    if (s.travel) return { ok: false, msg: "Can't trade in transit." };
    qty = Math.floor(qty);
    if (qty <= 0) return { ok: false, msg: "Quantity must be positive." };
    const cat = (COMMODITIES.find(c => c.id === commId) || {}).cat;
    if (window.Senate && Senate.isBanned(commId, cat)) return { ok: false, msg: "Prohibited by a senate edict." };
    const price = this.buyPrice(commId);
    const cost = price * qty;
    if (cost > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= cost;
    const held = s.positions[commId] || 0, prevCost = s.avgCost[commId] || 0;
    s.positions[commId] = held + qty;
    s.avgCost[commId] = (held * prevCost + cost) / (held + qty);
    this._afterTrade(commId, "buy", qty, cost, price);
    return { ok: true, qty, cost, price };
  },

  sell(commId, qty) {
    const s = this.s();
    if (s.travel) return { ok: false, msg: "Can't trade in transit." };
    const held = s.positions[commId] || 0;
    qty = Math.min(Math.floor(qty), held);
    if (qty <= 0) return { ok: false, msg: "Nothing to sell." };
    const cat = (COMMODITIES.find(c => c.id === commId) || {}).cat;
    if (window.Senate && Senate.isBanned(commId, cat)) return { ok: false, msg: "Prohibited by a senate edict." };
    const price = this.sellPrice(commId);
    const proceeds = price * qty;
    const realized = (price - (s.avgCost[commId] || 0)) * qty;
    s.credits += proceeds;
    s.positions[commId] = held - qty;
    if (s.positions[commId] <= 0) { s.positions[commId] = 0; s.avgCost[commId] = 0; }
    this._afterTrade(commId, "sell", qty, proceeds, price, realized);
    return { ok: true, qty, proceeds, price, realized };
  },

  _afterTrade(commId, side, qty, value, price, realized = 0) {
    const s = this.s();
    s.stats.trades += 1;
    s.stats.biggestTrade = Math.max(s.stats.biggestTrade || 0, value);
    const cat = (COMMODITIES.find(c => c.id === commId) || {}).cat;
    Rep.onTrade(cat, value, side);
    this.refreshNetWorth();
    Bus.emit("trade", { commId, side, qty, value, price, realized });
    this.checkAchievements();
  },

  unlockSystem(sysId) {
    const s = this.s();
    if (s.unlockedSystems.includes(sysId)) return { ok: false, msg: "Already unlocked." };
    const sys = SYSTEMS.find(x => x.id === sysId);
    if (!sys) return { ok: false, msg: "Unknown system." };
    if (sys.unlock > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= sys.unlock;
    s.unlockedSystems.push(sysId);
    this.refreshNetWorth();
    Bus.emit("unlock", { sysId });
    this.checkAchievements();
    return { ok: true };
  },

  // Docking now takes time: it starts a transit driven by the main ship's speed.
  dockAt(sysId) {
    const s = this.s();
    if (!s.unlockedSystems.includes(sysId)) return { ok: false, msg: "System locked." };
    if (s.travel) return { ok: false, msg: "Already in transit." };
    if (sysId === s.currentSystem) return { ok: false, msg: "Already docked here." };
    const etaMs = Fleet.dockTravelMs(s.currentSystem, sysId);
    s.travel = { from: s.currentSystem, to: sysId, departedAt: Date.now(), etaMs };
    Bus.emit("travelStart", { to: sysId, etaMs });
    return { ok: true, travel: true, etaMs };
  },

  checkArrival(now) {
    const s = this.s();
    if (s.travel && now >= s.travel.departedAt + s.travel.etaMs) {
      const to = s.travel.to;
      s.currentSystem = to; s.travel = null;
      Bus.emit("dock", { sysId: to, arrived: true });
      return to;
    }
    return null;
  },
  travelProgress() {
    const t = this.s().travel; if (!t) return 1;
    return Util.clamp((Date.now() - t.departedAt) / t.etaMs, 0, 1);
  },
  travelRemaining() {
    const t = this.s().travel; if (!t) return 0;
    return Math.max(0, t.departedAt + t.etaMs - Date.now());
  },

  netWorth() {
    const s = this.s();
    let nw = s.credits;
    for (const c of COMMODITIES) { const q = s.positions[c.id] || 0; if (q) nw += q * this.priceHere(c.id); }
    nw += Fleet.fleetValue();
    nw += Bazaar.itemsValue();
    return nw;
  },

  refreshNetWorth() {
    const s = this.s();
    const nw = this.netWorth();
    s.stats.peakNetWorth = Math.max(s.stats.peakNetWorth || 0, nw);
    return nw;
  },

  checkAchievements() {
    const s = this.s();
    for (const a of ACHIEVEMENTS) {
      if (!s.achievements.includes(a.id) && a.test(s)) { s.achievements.push(a.id); Bus.emit("achievement", a); }
    }
  },

  canPrestige() { return this.netWorth() >= PRESTIGE.threshold; },

  prestige() {
    const s = this.s();
    if (!this.canPrestige()) return { ok: false, msg: "Net worth too low." };
    const tier = s.prestige.tier + 1;
    const multiplier = 1 + tier * PRESTIGE.bonusPerTier;
    s.prestige = { tier, multiplier };
    s.credits = Math.round(CONFIG.startingCredits * multiplier);
    s.positions = {}; s.avgCost = {};
    s.ships = []; s.mainShip = { type: "pinnace" };
    s.missions = []; s.reports = []; s.listings = []; s.orders = []; s.routes = []; s.industries = []; s.extractors = {}; s.components = {}; s.items = {};
    s.inventory = { capacity: 6, upgrades: 0 };
    s.bazaar = { mercs: [], contracts: [], accessories: [], extractors: [], components: [] };
    s.reputation = Object.fromEntries(Object.keys(FACTIONS).map(f => [f, 0]));
    // politics reset with the empire — but keep dossier knowledge you paid for
    if (window.Senate) {
      const keep = {}, old = (s.senate && s.senate.reps) || {};
      for (const id in old) if (old[id].revealed) keep[id] = { revealed: true, rel: 0, scandal: 0 };
      s.senate = Object.assign(Senate.defaultState(), { reps: keep });
      Senate._bumpRev();
    }
    s.travel = null;
    s.currentSystem = "navos";
    s.unlockedSystems = SYSTEMS.filter(x => x.unlock === 0).map(x => x.id);
    s.stats.peakNetWorth = this.netWorth();
    Market.volMult = 1 + tier * PRESTIGE.volPerTier;
    Market.init();
    Bazaar.ensure();
    Bus.emit("prestige", { tier, multiplier });
    this.checkAchievements();
    return { ok: true, tier, multiplier };
  },
};

window.ACHIEVEMENTS = ACHIEVEMENTS;
window.Economy = Economy;
