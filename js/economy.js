/* economy.js — credits, positions, purchases, unlocks, achievements, prestige.
   All mutations go through here and touch Game.state. Emits Bus events so the
   feed/UI can react.                                                          */

const ACHIEVEMENTS = [
  { id: "first_trade",  name: "First Blood",        desc: "Make your first trade.",
    test: s => s.stats.trades >= 1 },
  { id: "first_run",    name: "Cargo Cult",         desc: "Complete a cargo run.",
    test: s => s.stats.runs >= 1 },
  { id: "first_100k",   name: "Six Figures",        desc: "Reach 100K net worth.",
    test: s => s.stats.peakNetWorth >= 100000 },
  { id: "first_million",name: "First Million",       desc: "Reach 1M net worth.",
    test: s => s.stats.peakNetWorth >= 1000000 },
  { id: "fleet_three",  name: "A Real Fleet",       desc: "Own three ships.",
    test: s => s.ships.length >= 3 },
  { id: "explorer",     name: "Trailblazer",        desc: "Unlock a gated system.",
    test: s => s.unlockedSystems.length > 3 },
  { id: "smuggler",     name: "Risky Business",     desc: "Hold contraband.",
    test: s => (s.positions.contraband || 0) > 0 },
  { id: "whale",        name: "Whale",              desc: "Make a single trade worth 50K+.",
    test: s => s.stats.biggestTrade >= 50000 },
  { id: "prestige_one", name: "Sold the Empire",    desc: "Prestige for the first time.",
    test: s => s.prestige.tier >= 1 },
];

const Economy = {
  s() { return window.Game.state; },

  priceHere(commId) {
    return Market.systemPrice(commId, this.s().currentSystem);
  },

  maxBuy(commId) {
    const p = this.priceHere(commId);
    return p > 0 ? Math.floor(this.s().credits / p) : 0;
  },

  buy(commId, qty) {
    const s = this.s();
    qty = Math.floor(qty);
    if (qty <= 0) return { ok: false, msg: "Quantity must be positive." };
    const price = this.priceHere(commId);
    const cost = price * qty;
    if (cost > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= cost;
    const held = s.positions[commId] || 0;
    const prevCost = s.avgCost[commId] || 0;
    s.positions[commId] = held + qty;
    s.avgCost[commId] = (held * prevCost + cost) / (held + qty);
    this._afterTrade(commId, "buy", qty, cost, price);
    return { ok: true, qty, cost, price };
  },

  sell(commId, qty) {
    const s = this.s();
    const held = s.positions[commId] || 0;
    qty = Math.min(Math.floor(qty), held);
    if (qty <= 0) return { ok: false, msg: "Nothing to sell." };
    const price = this.priceHere(commId);
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
    this.refreshNetWorth();
    Bus.emit("trade", { commId, side, qty, value, price, realized });
    this.checkAchievements();
  },

  buyShip(typeId) {
    const s = this.s();
    const t = SHIP_TYPES.find(x => x.id === typeId);
    if (!t) return { ok: false, msg: "Unknown ship." };
    if (t.price > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= t.price;
    s.ships.push({ uid: "s" + (++s.seq), type: t.id, status: "idle" });
    this.refreshNetWorth();
    Bus.emit("shipBuy", { type: t.id });
    this.checkAchievements();
    return { ok: true };
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

  dockAt(sysId) {
    const s = this.s();
    if (!s.unlockedSystems.includes(sysId)) return { ok: false };
    s.currentSystem = sysId;
    Bus.emit("dock", { sysId });
    return { ok: true };
  },

  // Net worth = cash + held positions (valued here) + fleet value + cargo afloat.
  netWorth() {
    const s = this.s();
    let nw = s.credits;
    for (const c of COMMODITIES) {
      const q = s.positions[c.id] || 0;
      if (q) nw += q * this.priceHere(c.id);
    }
    for (const ship of s.ships) {
      const t = SHIP_TYPES.find(x => x.id === ship.type);
      if (t) nw += t.price;
      if (ship.cargo) nw += ship.cargo.qty * ship.cargo.buyPrice;
    }
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
      if (!s.achievements.includes(a.id) && a.test(s)) {
        s.achievements.push(a.id);
        Bus.emit("achievement", a);
      }
    }
  },

  canPrestige() { return this.netWorth() >= PRESTIGE.threshold; },

  prestige() {
    const s = this.s();
    if (!this.canPrestige()) return { ok: false, msg: "Net worth too low." };
    const tier = s.prestige.tier + 1;
    const multiplier = 1 + tier * PRESTIGE.bonusPerTier;
    // Keep prestige + achievements + lifetime stats; reset the run.
    s.prestige = { tier, multiplier };
    s.credits = Math.round(CONFIG.startingCredits * multiplier);
    s.positions = {};
    s.avgCost = {};
    s.ships = [{ uid: "s1", type: "shuttle", status: "idle" }];
    s.seq = 1;
    s.currentSystem = "navos";
    s.unlockedSystems = SYSTEMS.filter(x => x.unlock === 0).map(x => x.id);
    s.stats.peakNetWorth = this.netWorth();
    Market.volMult = 1 + tier * PRESTIGE.volPerTier;
    Market.init();
    Bus.emit("prestige", { tier, multiplier });
    this.checkAchievements();
    return { ok: true, tier, multiplier };
  },
};

window.ACHIEVEMENTS = ACHIEVEMENTS;
window.Economy = Economy;
