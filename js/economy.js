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
  // Phase 1: signed-in + players RPCs live → server fills. Guests / pre-setup stay local.
  authoritative() { return !!(window.Cloud && Cloud.authoritative()); },
  _pending: 0,
  busy() { return this._pending > 0; },

  priceHere(commId) { return Market.systemPrice(commId, this.s().currentSystem); },
  inTransit() { return !!this.s().travel; },

  _snapEconomy() {
    const s = this.s();
    return {
      credits: s.credits,
      positions: JSON.parse(JSON.stringify(s.positions || {})),
      avgCost: JSON.parse(JSON.stringify(s.avgCost || {})),
      stats: { trades: s.stats.trades, biggestTrade: s.stats.biggestTrade },
      currentSystem: s.currentSystem,
      travel: s.travel ? Object.assign({}, s.travel) : null,
      unlockedSystems: (s.unlockedSystems || []).slice(),
      reputation: JSON.parse(JSON.stringify(s.reputation || {})),
    };
  },
  _restoreEconomy(snap) {
    const s = this.s();
    s.credits = snap.credits;
    s.positions = snap.positions;
    s.avgCost = snap.avgCost;
    s.currentSystem = snap.currentSystem;
    s.travel = snap.travel;
    s.unlockedSystems = snap.unlockedSystems;
    s.reputation = snap.reputation;
    s.stats.trades = snap.stats.trades;
    s.stats.biggestTrade = snap.stats.biggestTrade;
  },
  _applyServerSlice(r) {
    const s = this.s();
    if (r.credits != null) s.credits = r.credits;
    if (r.positions) s.positions = r.positions;
    if (r.avgCost) s.avgCost = r.avgCost;
    if (r.stats) {
      if (r.stats.trades != null) s.stats.trades = r.stats.trades;
      if (r.stats.biggestTrade != null) s.stats.biggestTrade = r.stats.biggestTrade;
    }
    if (r.currentSystem) s.currentSystem = r.currentSystem;
    if ("travel" in r || "travelObj" in r) {
      const tr = r.travelObj || r.travel;
      s.travel = tr && typeof tr === "object" ? tr : null;
    }
    if (r.unlockedSystems) s.unlockedSystems = r.unlockedSystems;
  },
  async _withRpc(optimisticFn, rpcFn, failMsg) {
    const snap = this._snapEconomy();
    const local = optimisticFn();
    if (!local || !local.ok) return local;
    this._pending++;
    try {
      const r = await rpcFn();
      if (!r || !r.ok) {
        this._restoreEconomy(snap);
        return { ok: false, msg: (r && (r.error || r.msg)) || failMsg };
      }
      this._applyServerSlice(r);
      // Reconcile fill details for the trade terminal (server is source of truth).
      if (r.fillPrice != null) local.price = r.fillPrice;
      if (r.cost != null) local.cost = r.cost;
      if (r.proceeds != null) local.proceeds = r.proceeds;
      if (r.tax != null) local.tax = r.tax;
      if (r.qty != null) local.qty = r.qty;
      if (r.etaMs != null) local.etaMs = r.etaMs;
      return local;
    } catch (e) {
      console.warn("[Economy] rpc failed:", e);
      this._restoreEconomy(snap);
      return { ok: false, msg: failMsg };
    } finally {
      this._pending = Math.max(0, this._pending - 1);
    }
  },

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

  // ---- market depth (per Baron Tier) -------------------------------------
  // `depth` is the tier's trade cap: it caps a single trade's ACTUAL notional
  // (credits paid / received, INCLUDING price pressure + slippage) AND sets how
  // hard your own trading moves the price. Buying/selling pushes a persistent,
  // decaying pressure into Market so splitting a big order into small ones — or
  // hopping back and forth — closes the gap just the same.
  depth() { return this.tierInfo().cap || 10000; },
  // Depth used ONLY for price impact (how hard your trading moves the local
  // price). Decoupled from the trade cap so we can flatten the price response to
  // order size without also raising the notional a single trade may move.
  impactDepth() { return this.depth() * (window.MARKETCFG ? (MARKETCFG.impactSoftening || 1) : 1); },
  spotHere(commId) { return Market.spot(commId, this.s().currentSystem); },

  // {a,b} such that a buy costs a·q + b·q² and a sell nets a·q − b·q² (gross,
  // pre-tax) at the CURRENT pressure — the true credits moved, not units×spot.
  _quote(commId, side) {
    const cat = (COMMODITIES.find(c => c.id === commId) || {}).cat;
    const spot0 = this.spotHere(commId), p0 = Market.impactAt(commId, this.s().currentSystem);
    const tax = window.Senate ? Senate.tradeTax(cat, side) : 0;
    const base = side === "buy" ? spot0 * (1 + this._spread(cat)) * (1 + tax)
                                : spot0 * (1 - this._spread(cat)) * (1 - tax);
    return { spot0, p0, base, a: base * (1 + p0), b: base * spot0 / (2 * this.impactDepth()) };
  },
  // most units you may BUY without spending more than L credits (cost ≤ L)
  _buyQtyForSpend(commId, L) {
    const { a, b } = this._quote(commId, "buy");
    if (a <= 0 || L <= 0) return 0;
    const q = b > 0 ? (-a + Math.sqrt(a * a + 4 * b * L)) / (2 * b) : L / a;
    return Math.max(0, Math.floor(q));
  },
  // most units you may SELL without taking more than L credits (gross ≤ L).
  // Gross proceeds a·q − b·q² peak at q=a/2b; past that you're just dumping into
  // a crashed (floored) market, so we never allow more than the peak — which also
  // keeps proceeds ≤ its max there. Below the peak, cap where proceeds hit L.
  _sellQtyForTake(commId, L) {
    const { a, b } = this._quote(commId, "sell");
    if (a <= 0 || L <= 0) return 0;
    if (b <= 0) return Math.floor(L / a);
    const qPeak = a / (2 * b);
    const disc = a * a - 4 * b * L;
    const qL = disc > 0 ? (a - Math.sqrt(disc)) / (2 * b) : Infinity;   // ascending-branch crossing of L
    return Math.max(0, Math.floor(Math.min(qPeak, qL)));
  },
  // cap-only limits (the per-trade notional ceiling, ignoring what you can afford/hold)
  buyCapQty(commId) { return this._buyQtyForSpend(commId, this.depth()); },
  sellCapQty(commId) { return this._sellQtyForTake(commId, this.depth()); },

  // effective ceilings the UI clamps to: bounded by BOTH the cap and afford/holdings
  maxBuy(commId) {
    const cat = (COMMODITIES.find(c => c.id === commId) || {}).cat;
    if (window.Senate && Senate.isBanned(commId, cat)) return 0;
    const s = this.s();
    if (this.spotHere(commId) <= 0 || s.credits <= 0) return 0;
    return this._buyQtyForSpend(commId, Math.min(s.credits, this.depth()));
  },
  maxSell(commId) {
    const held = this.s().positions[commId] || 0;
    if (held <= 0 || this.spotHere(commId) <= 0) return 0;
    return Math.min(held, this.sellCapQty(commId));
  },

  // Local (guest) fill — also used as the optimistic preview when authoritative.
  _buyLocal(commId, qty) {
    const s = this.s();
    if (s.travel) return { ok: false, msg: "Can't trade in transit." };
    qty = Math.floor(qty);
    if (qty <= 0) return { ok: false, msg: "Quantity must be positive." };
    const cat = (COMMODITIES.find(c => c.id === commId) || {}).cat;
    if (window.Senate && Senate.isBanned(commId, cat)) return { ok: false, msg: "Prohibited by a senate edict." };
    const capQ = this.buyCapQty(commId);                              // per-trade notional cap (credits paid ≤ depth)
    if (capQ <= 0) return { ok: false, msg: "Beyond this station's depth for your tier." };
    const capped = qty > capQ; if (capped) qty = capQ;
    const now = Date.now(), sys = s.currentSystem;
    const { spot0, p0, base } = this._quote(commId, "buy");
    const dP = spot0 * qty / this.impactDepth();                      // pressure this order adds (gentler than the cap)
    const avg = base * (1 + p0 + dP / 2);                             // average fill over the rising price
    const cost = avg * qty;
    if (cost > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= cost;
    const held = s.positions[commId] || 0, prevCost = s.avgCost[commId] || 0;
    s.positions[commId] = held + qty;
    s.avgCost[commId] = (held * prevCost + cost) / (held + qty);
    Market.addImpact(commId, sys, dP, now);                           // price stays elevated, then decays
    this._afterTrade(commId, "buy", qty, cost, avg);
    return { ok: true, qty, cost, price: avg, capped };
  },

  _sellLocal(commId, qty) {
    const s = this.s();
    if (s.travel) return { ok: false, msg: "Can't trade in transit." };
    const held = s.positions[commId] || 0;
    qty = Math.min(Math.floor(qty), held);
    if (qty <= 0) return { ok: false, msg: "Nothing to sell." };
    const cat = (COMMODITIES.find(c => c.id === commId) || {}).cat;
    if (window.Senate && Senate.isBanned(commId, cat)) return { ok: false, msg: "Prohibited by a senate edict." };
    const capQ = this.sellCapQty(commId);                            // per-trade notional cap (credits taken ≤ depth)
    if (capQ <= 0) return { ok: false, msg: "Beyond this station's depth for your tier." };
    const capped = qty > capQ; if (capped) qty = capQ;
    const now = Date.now(), sys = s.currentSystem;
    const { spot0, p0, base } = this._quote(commId, "sell");
    const dP = spot0 * qty / this.impactDepth();                      // pressure this order removes (gentler than the cap)
    const price = base * Math.max(MARKETCFG.sellFloorFactor, 1 + p0 - dP / 2);   // average fill over the falling price
    const grossRealized = (price - (s.avgCost[commId] || 0)) * qty;
    const tax = grossRealized > 0 ? Math.round(grossRealized * this.baronTax()) : 0;   // Baron Tier earnings tax (on profit)
    const proceeds = price * qty - tax;                                                // keep principal + after-tax profit
    const realized = grossRealized - tax;
    s.credits += proceeds;
    s.positions[commId] = held - qty;
    if (s.positions[commId] <= 0) { s.positions[commId] = 0; s.avgCost[commId] = 0; }
    Market.addImpact(commId, sys, -dP, now);                          // your selling depresses the local price
    this._afterTrade(commId, "sell", qty, proceeds, price, realized);
    return { ok: true, qty, proceeds, price, realized, tax, capped };
  },

  buy(commId, qty) {
    if (!this.authoritative()) return this._buyLocal(commId, qty);
    return this._withRpc(
      () => this._buyLocal(commId, qty),
      () => Cloud.trade("buy", commId, Math.floor(qty)),
      "Couldn't reach the exchange — try again."
    );
  },

  sell(commId, qty) {
    if (!this.authoritative()) return this._sellLocal(commId, qty);
    return this._withRpc(
      () => this._sellLocal(commId, qty),
      () => Cloud.trade("sell", commId, Math.floor(qty)),
      "Couldn't reach the exchange — try again."
    );
  },

  // ----- Baron Tier (prestige "ascension") -----
  tier() { return (this.s().prestige || {}).tier || 0; },
  tierInfo(t = this.tier()) { return BARON_TIERS[Util.clamp(t, 0, BARON_TIERS.length - 1)]; },
  tierTitle() { return this.tierInfo().title; },
  baronTax() { return this.tierInfo().tax; },
  afterTax(amount) { return amount > 0 ? Math.round(amount * (1 - this.baronTax())) : amount; },  // tax positive earnings only
  permitCap() { return this.tierInfo().permits; },
  fleetCap() { return this.tierInfo().fleet; },
  nextTier() { const t = this.tier(); return t + 1 < BARON_TIERS.length ? BARON_TIERS[t + 1] : null; },

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

  _unlockLocal(sysId) {
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
  _dockLocal(sysId) {
    const s = this.s();
    if (!s.unlockedSystems.includes(sysId)) return { ok: false, msg: "System locked." };
    if (s.travel) return { ok: false, msg: "Already in transit." };
    if (sysId === s.currentSystem) return { ok: false, msg: "Already docked here." };
    const etaMs = Fleet.dockTravelMs(s.currentSystem, sysId);
    s.travel = { from: s.currentSystem, to: sysId, departedAt: Date.now(), etaMs };
    Bus.emit("travelStart", { to: sysId, etaMs });
    return { ok: true, travel: true, etaMs };
  },

  unlockSystem(sysId) {
    if (!this.authoritative()) return this._unlockLocal(sysId);
    return this._withRpc(
      () => this._unlockLocal(sysId),
      () => Cloud.unlock(sysId),
      "Couldn't reach the exchange — try again."
    );
  },

  dockAt(sysId) {
    if (!this.authoritative()) return this._dockLocal(sysId);
    return this._withRpc(
      () => this._dockLocal(sysId),
      () => Cloud.dock(sysId),
      "Couldn't reach the exchange — try again."
    );
  },

  checkArrival(now) {
    const s = this.s();
    if (s.travel && now >= s.travel.departedAt + s.travel.etaMs) {
      const to = s.travel.to;
      s.currentSystem = to; s.travel = null;
      const customs = this.customsScan(to);       // gate scan before the exchange opens
      Bus.emit("dock", { sysId: to, arrived: true });
      return { to, customs };
    }
    return null;
  },

  // Customs scan on arrival: if you're carrying contraband, roll a seizure and
  // confiscate a slice of the stack. Odds rise with Senate border edicts and at
  // low-tolerance systems, and fall with Syndicate standing. Returns the
  // seizure event (also emitted on the bus) or null. Reused live + offline.
  customsScan(sysId) {
    const s = this.s();
    const held = s.positions.contraband || 0;
    if (held <= 0) return null;
    const comm = COMMODITIES.find(c => c.id === "contraband"); if (!comm) return null;
    const sys = SYSTEMS.find(x => x.id === sysId);
    const tol = (sys && sys.mods && sys.mods.illicit) || 1;
    const scrutiny = Util.clamp(2 - tol, CUSTOMS.scrutinyClamp[0], CUSTOMS.scrutinyClamp[1]);
    const border = window.Senate ? Senate.smuggleFailAdd() : 0;
    const shield = Math.max(0, Rep.get("syndicate")) / 100 * CUSTOMS.repShield;
    const chance = Util.clamp((CUSTOMS.base + border) * scrutiny - shield, 0, CUSTOMS.cap);
    if (Math.random() >= chance) return null;
    const qty = Math.min(held, Math.max(1, Math.ceil(held * Util.randFloat(CUSTOMS.seize[0], CUSTOMS.seize[1]))));
    const value = Math.round(qty * this.priceHere("contraband"));
    s.positions.contraband = held - qty;
    if (s.positions.contraband <= 0) { s.positions.contraband = 0; s.avgCost.contraband = 0; } // stack cleared → drop its cost basis
    this.refreshNetWorth();
    const ev = { commId: "contraband", name: comm.name, qty, value, sysId, chance };
    Bus.emit("customs", ev);
    return ev;
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
    // value holdings at SPOT (excludes your own price pressure) so a big buy
    // can't self-inflate net worth / peak-net-worth into an early tier unlock
    for (const c of COMMODITIES) { const q = s.positions[c.id] || 0; if (q) nw += q * Market.spot(c.id, s.currentSystem); }
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

  canPrestige() { const n = this.nextTier(); return !!n && this.netWorth() >= n.threshold; },

  // ASCEND a Baron Tier: you KEEP your whole empire — credits, stocks, industries,
  // ships, senator relationships, faction standing. The only changes are a fancier
  // title, a bigger industry-permit + fleet cap, and a steeper tax on all earnings.
  prestige() {
    const s = this.s();
    if (!this.canPrestige()) return { ok: false, msg: "Net worth too low to ascend." };
    const tier = (s.prestige.tier || 0) + 1;
    s.prestige = { tier, multiplier: 1 };          // multiplier kept for save-shape compat (unused)
    s.stats.peakNetWorth = Math.max(s.stats.peakNetWorth || 0, this.netWorth());
    Bus.emit("prestige", { tier });
    this.checkAchievements();
    return { ok: true, tier, title: this.tierTitle() };
  },
};

window.ACHIEVEMENTS = ACHIEVEMENTS;
window.Economy = Economy;
