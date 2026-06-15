/* reputation.js — standing with the four factions. Earned from contracts and
   (lightly) from trading their domain commodities; spent as exchange price
   edges, bazaar discounts, contract reward bonuses, and as a gate on the top
   jobs. Helping a faction annoys its rival.                                    */

const Rep = {
  s() { return window.Game.state; },
  ids() { return Object.keys(FACTIONS); },

  get(f) { const r = this.s().reputation; return (r && r[f]) || 0; },
  tier(v) { let t = REP.tiers[0]; for (const x of REP.tiers) if (v >= x.at) t = x; return t; },
  tierOf(f) { return this.tier(this.get(f)); },
  tierIndex(id) { return REP.tiers.findIndex(t => t.id === id); },

  change(f, delta) {
    const s = this.s();
    if (!s.reputation) s.reputation = {};
    const before = this.tier(s.reputation[f] || 0).id;
    s.reputation[f] = Util.clamp((s.reputation[f] || 0) + delta, REP.min, REP.max);
    const after = this.tier(s.reputation[f]).id;
    if (after !== before) Bus.emit("rep", { faction: f, tier: after, up: this.tierIndex(after) > this.tierIndex(before) });
  },

  factionForCategory(cat) { return CATEGORY_FACTION[cat] || "free_trade"; },

  // exchange execution edge for a commodity (friendly → better deals)
  edge(f) { return this.get(f) / 100 * REP.maxEdge; },
  edgeForCategory(cat) { return this.edge(this.factionForCategory(cat)); },

  best() { let b = this.ids()[0], v = -1e9; for (const f of this.ids()) { const r = this.get(f); if (r > v) { v = r; b = f; } } return { faction: b, rep: v }; },
  discount() { return Math.max(0, this.best().rep) / 100 * REP.discountMax; },
  rewardMult(f) { return 1 + Math.max(0, this.get(f)) / 100 * REP.rewardMaxBonus; },
  successBonus(f) { return this.get(f) / 100 * 0.1; },

  // who sponsors a contract of this type/category
  sponsor(type, cat) {
    if (type === "smuggle" || type === "assassinate") return "syndicate";
    if (type === "combat" || type === "escort") return "free_trade";
    return this.factionForCategory(cat);
  },
  // is this job gated behind being Friendly with its sponsor?
  gated(type, danger) { return type === "assassinate" || danger === "extreme"; },
  meetsGate(faction) { return this.tierIndex(this.tierOf(faction).id) >= this.tierIndex(REP.gateTier); },

  // standing changes from a completed contract
  onContract(faction, type, danger) {
    const gain = { safe: 3, low: 5, moderate: 7, high: 10, extreme: 13 }[danger] || 5;
    this.change(faction, gain);
    const rival = FACTIONS[faction] && FACTIONS[faction].rival;
    if (rival) this.change(rival, -Math.round(gain * 0.5));
    if (type === "smuggle" || type === "assassinate") this.change("free_trade", -2);
  },

  // light standing nudge from large trades in a faction's domain
  onTrade(cat, value, side) {
    if (value < 4000) return;
    this.change(this.factionForCategory(cat), side === "sell" ? 0.5 : 0.3);
  },
};

window.Rep = Rep;
