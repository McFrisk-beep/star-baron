/* industries.js — offworld manufacturing. Buy a permit on a star-map planet,
   then install an EXTRACTOR (bought in the Bazaar) and pick what it produces
   (within the extractor's scope). It then drops slow, taxed ~12h batches of that
   commodity into your tradeable stock (state.positions) while you're away.

   Output = baseYield × planet SUITABILITY (type × the chosen commodity's
   category) × the extractor's yield tier, ×0 on a local strike / war slump, ×2
   on a war boom. Tax: tax = ceil(gross × rate), net = max(1, gross − tax).
   Navos (core sector) is neutral — free permits, low flat tax. Elsewhere the
   commodity's controlling faction owns the planet: standing gates the permit and
   sets permit price + tax; negative standing raises tax; at/below −40 they seize
   the works. Components slot into the extractor next to tune rate/time.          */

const Industries = {
  s() { return window.Game.state; },
  list() { return this.s().industries || (this.s().industries = []); },
  idFor(systemId, idx) { return systemId + "#" + idx; },
  at(systemId, idx) { return this.list().find(i => i.id === this.idFor(systemId, idx)); },
  byId(id) { return this.list().find(i => i.id === id); },

  isNeutral(sys) { return !!sys && sys.sectorId === "core"; },                       // Navos's home turf
  planetFaction(sys, planet) { return this.isNeutral(sys) ? null : (CATEGORY_FACTION[planet.cat] || "free_trade"); },
  suitabilityFor(planetType, commId) {
    const cat = (COMMODITIES.find(c => c.id === commId) || {}).cat;
    return (PLANET_SUITABILITY[planetType] || {})[cat] ?? 1;
  },
  // effective batch cycle (base × the extractor's speed-component bonus)
  cycleMsFor(ind) {
    const ex = Extractors.get(ind.extractorUid);
    return INDUSTRYCFG.cycleMs * (ex ? Extractors.bonuses(ex).cycle : 1);
  },
  permitCost(sys, planet) {
    if (this.isNeutral(sys)) return 0;
    const rep = Math.max(0, Rep.get(this.planetFaction(sys, planet)));
    return Math.round(INDUSTRYCFG.permitBase * (1 - rep / 100 * INDUSTRYCFG.permitRepDiscount));
  },
  taxRate(sys, planet) {
    if (this.isNeutral(sys)) return INDUSTRYCFG.neutralTax;
    const rep = Rep.get(this.planetFaction(sys, planet));
    let r = INDUSTRYCFG.factionBaseTax;
    if (rep >= 0) r *= (1 - rep / 100 * INDUSTRYCFG.taxRepRelief);
    else r *= (1 + Math.min(1, (-rep) / Math.abs(INDUSTRYCFG.destroyRep)) * INDUSTRYCFG.taxNegPenalty);
    return Util.clamp(r, 0.02, 0.6);
  },

  canBuild(sys, idx) {
    const planet = sys && sys.planets[idx];
    if (!planet) return { ok: false, msg: "No planet." };
    if (this.at(sys.id, idx)) return { ok: false, msg: "You already hold a permit here." };
    if (this.list().length >= INDUSTRYCFG.maxPerPlayer) return { ok: false, msg: `Permit cap reached (${INDUSTRYCFG.maxPerPlayer}).` };
    const fac = this.planetFaction(sys, planet);
    if (fac && Rep.get(fac) < INDUSTRYCFG.permitMinRep) return { ok: false, msg: `${FACTIONS[fac].name} won't sell you a permit at your standing.` };
    return { ok: true };
  },
  build(systemId, idx, now = Date.now()) {
    const sys = Galaxy.get(systemId); if (!sys) return { ok: false, msg: "Unknown system." };
    const chk = this.canBuild(sys, idx); if (!chk.ok) return chk;
    const cost = this.permitCost(sys, sys.planets[idx]);
    if (cost > this.s().credits) return { ok: false, msg: "Not enough credits for the permit." };
    this.s().credits -= cost;
    this.list().push({ id: this.idFor(systemId, idx), systemId, planetIdx: idx, extractorUid: null, commodity: null, cat: null, nextAt: null });
    Economy.refreshNetWorth();
    return { ok: true, cost };
  },
  demolish(id) { this.s().industries = this.list().filter(i => i.id !== id); return { ok: true }; },

  installExtractor(industryId, extractorUid, commodity, now = Date.now()) {
    const ind = this.byId(industryId); if (!ind) return { ok: false, msg: "No permit." };
    const ex = Extractors.get(extractorUid); if (!ex) return { ok: false, msg: "Extractor not found." };
    if (Extractors.installedSet().has(extractorUid)) return { ok: false, msg: "That extractor is already installed elsewhere." };
    commodity = commodity || Extractors.targets(ex)[0];
    if (!Extractors.canProduce(ex, commodity)) return { ok: false, msg: "This extractor can't produce that." };
    ind.extractorUid = extractorUid; ind.commodity = commodity;
    ind.cat = (COMMODITIES.find(c => c.id === commodity) || {}).cat || null;
    ind.nextAt = now + this.cycleMsFor(ind);
    return { ok: true };
  },
  removeExtractor(industryId) {
    const ind = this.byId(industryId); if (!ind) return { ok: false };
    ind.extractorUid = null; ind.commodity = null; ind.cat = null; ind.nextAt = null;
    return { ok: true };
  },

  prodMult(ind, now = Date.now()) {
    if (Market.activeLocal(ind.systemId, now).length) return 0;
    const w = window.Wars && Wars.active(now);
    if (w && ind.cat) { if (ind.cat === w.catB) return 0; if (ind.cat === w.catA) return INDUSTRYCFG.warBoost; }
    return 1;
  },
  status(ind, now = Date.now()) {
    if (!ind.extractorUid) return "idle";
    if (Market.activeLocal(ind.systemId, now).length) return "struck";
    const w = window.Wars && Wars.active(now);
    if (w && ind.cat === w.catB) return "disrupted";
    if (w && ind.cat === w.catA) return "boom";
    const sys = Galaxy.get(ind.systemId), planet = sys && sys.planets[ind.planetIdx];
    const fac = planet ? this.planetFaction(sys, planet) : null;
    if (fac) { const rep = Rep.get(fac); if (rep <= INDUSTRYCFG.atRiskRep) return "at risk"; if (rep < 0) return "taxed"; }
    return "running";
  },
  // One batch's economics at a production multiplier (1 = nominal). Single source
  // of truth for the yield/tax/cycle math shared by batch() (display) and
  // resolve() (production) — so the two can never drift apart.
  _yield(sys, planet, ex, commodity, mult = 1) {
    const bon = Extractors.bonuses(ex);
    const suit = this.suitabilityFor(planet.type, commodity);
    const gross = Math.round(INDUSTRYCFG.baseYield * suit * Extractors.yieldMult(ex) * bon.rate * mult);
    const rate = this.taxRate(sys, planet);
    return { gross, rate, suit, net: gross > 0 ? Math.max(1, gross - Math.ceil(gross * rate)) : 0, cycleMs: INDUSTRYCFG.cycleMs * bon.cycle };
  },
  // Nominal per-12h economics (running, pre strike/war) for display.
  batch(ind) {
    const sys = Galaxy.get(ind.systemId), planet = sys && sys.planets[ind.planetIdx];
    const ex = Extractors.get(ind.extractorUid);
    if (!planet || !ex || !ind.commodity) return { gross: 0, rate: 0, tax: 0, net: 0, suit: 1, cycleMs: INDUSTRYCFG.cycleMs };
    const y = this._yield(sys, planet, ex, ind.commodity);
    return { ...y, tax: Math.ceil(y.gross * y.rate) };
  },

  resolve(now = Date.now()) {
    const s = this.s(); const made = [], lost = [];
    for (const ind of this.list()) {
      const sys = Galaxy.get(ind.systemId), planet = sys && sys.planets[ind.planetIdx];
      const fac = planet ? this.planetFaction(sys, planet) : null;
      if (fac && Rep.get(fac) <= INDUSTRYCFG.destroyRep) { ind._dead = true; lost.push({ name: planet ? planet.name : ind.systemId, faction: fac }); continue; }
      if (!planet || !ind.extractorUid || !ind.commodity || now < ind.nextAt) continue;
      const ex = Extractors.get(ind.extractorUid); if (!ex) continue;
      const mult = this.prodMult(ind, now);
      const y = this._yield(sys, planet, ex, ind.commodity, mult);
      if (mult <= 0) { ind.nextAt = now + y.cycleMs; continue; }
      const cycles = Math.min(Math.floor((now - ind.nextAt) / y.cycleMs) + 1, INDUSTRYCFG.maxCyclesPerResolve);
      const qty = y.net * cycles;
      if (qty > 0) {
        const held = s.positions[ind.commodity] || 0, prev = s.avgCost[ind.commodity] || 0;
        s.positions[ind.commodity] = held + qty;
        s.avgCost[ind.commodity] = (held + qty) > 0 ? (held * prev) / (held + qty) : 0;
        made.push({ commodity: ind.commodity, qty });
      }
      ind.nextAt = now + y.cycleMs;
    }
    if (lost.length) this.s().industries = this.list().filter(i => !i._dead);
    for (const l of lost) Bus.emit("industryLost", l);
    if (made.length) { Economy.refreshNetWorth(); Economy.checkAchievements(); }
    return made;
  },
};

window.Industries = Industries;
