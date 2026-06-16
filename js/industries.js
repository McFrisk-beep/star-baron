/* industries.js — offworld manufacturing. Build a factory/mine/farm on a
   star-map planet and it slowly produces that planet's commodity into your
   tradeable stock (state.positions), running while you're away. Licensing is
   gated by your standing with the commodity's controlling faction (blocked if
   you're disliked enough); production halts during local disruptions (a strike)
   and faction-war slumps, and doubles when its category is a war's hot side.

   Reuses CATEGORY_FACTION + Rep (license), Market.activeLocal + Wars (events),
   and the exchange positions as the output sink.                              */

const Industries = {
  s() { return window.Game.state; },
  list() { return this.s().industries || (this.s().industries = []); },
  idFor(systemId, idx) { return systemId + "#" + idx; },
  at(systemId, idx) { return this.list().find(i => i.id === this.idFor(systemId, idx)); },

  controllingFaction(cat) { return CATEGORY_FACTION[cat] || "free_trade"; },
  licensed(cat) {
    const f = this.controllingFaction(cat);
    return Rep.tierIndex(Rep.tierOf(f).id) >= Rep.tierIndex(INDUSTRYCFG.licenseMinTier);
  },
  startupCost(planet) {
    const comm = COMMODITIES.find(c => c.id === planet.commodity) || COMMODITIES[0];
    const disc = Math.max(0, Rep.get(this.controllingFaction(planet.cat))) / 100 * INDUSTRYCFG.repDiscountMax;
    return Math.round(comm.base * INDUSTRYCFG.startupMult * (1 - disc));
  },

  canBuild(sys, idx) {
    const planet = sys && sys.planets[idx];
    if (!planet) return { ok: false, msg: "No planet." };
    if (this.at(sys.id, idx)) return { ok: false, msg: "Already operating here." };
    if (this.list().length >= INDUSTRYCFG.maxPerPlayer) return { ok: false, msg: `Licence cap reached (${INDUSTRYCFG.maxPerPlayer}).` };
    if (!this.licensed(planet.cat)) return { ok: false, msg: `${FACTIONS[this.controllingFaction(planet.cat)].name} won't licence you at your standing.` };
    return { ok: true };
  },

  build(systemId, idx, now = Date.now()) {
    const sys = Galaxy.get(systemId); if (!sys) return { ok: false, msg: "Unknown system." };
    const chk = this.canBuild(sys, idx); if (!chk.ok) return chk;
    const planet = sys.planets[idx];
    const cost = this.startupCost(planet);
    if (cost > this.s().credits) return { ok: false, msg: "Not enough credits." };
    this.s().credits -= cost;
    this.list().push({ id: this.idFor(systemId, idx), systemId, planetIdx: idx,
      commodity: planet.commodity, cat: planet.cat, nextAt: now + INDUSTRYCFG.cycleMs });
    Economy.refreshNetWorth();
    return { ok: true, cost };
  },
  demolish(id) { this.s().industries = this.list().filter(i => i.id !== id); return { ok: true }; },

  // Production multiplier: 0 = halted (local strike/disruption or war slump),
  // INDUSTRYCFG.warBoost = boom (its category is a war's spiking side), else 1.
  prodMult(ind, now = Date.now()) {
    if (Market.activeLocal(ind.systemId, now).length) return 0;
    const w = window.Wars && Wars.active(now);
    if (w) { if (ind.cat === w.catB) return 0; if (ind.cat === w.catA) return INDUSTRYCFG.warBoost; }
    return 1;
  },
  status(ind, now = Date.now()) {
    if (Market.activeLocal(ind.systemId, now).length) return "struck";
    const w = window.Wars && Wars.active(now);
    if (w && ind.cat === w.catB) return "disrupted";
    if (w && ind.cat === w.catA) return "boom";
    return "running";
  },

  // Bank produced batches up to `now` into tradeable stock. Free goods, so the
  // commodity's average cost is blended down (selling them reads as profit).
  resolve(now = Date.now()) {
    const s = this.s(); const made = [];
    for (const ind of this.list()) {
      if (now < ind.nextAt) continue;
      const mult = this.prodMult(ind, now);
      if (mult <= 0) { ind.nextAt = now + INDUSTRYCFG.cycleMs; continue; }     // halted batch — skip, reschedule
      const cycles = Math.min(Math.floor((now - ind.nextAt) / INDUSTRYCFG.cycleMs) + 1, INDUSTRYCFG.maxCyclesPerResolve);
      const qty = Math.round(cycles * INDUSTRYCFG.outputPerCycle * mult);
      if (qty > 0) {
        const held = s.positions[ind.commodity] || 0, prevCost = s.avgCost[ind.commodity] || 0;
        s.positions[ind.commodity] = held + qty;
        s.avgCost[ind.commodity] = (held + qty) > 0 ? (held * prevCost) / (held + qty) : 0;
        made.push({ commodity: ind.commodity, qty });
      }
      ind.nextAt = now + INDUSTRYCFG.cycleMs;
    }
    if (made.length) { Economy.refreshNetWorth(); Economy.checkAchievements(); }
    return made;
  },
};

window.Industries = Industries;
