/* market.js — price simulation. Pure-ish + portable (Phase 2 moves this to the
   server, untouched in spirit). The client renders what this produces.

   Price model per tick:
     anchor   = base × categoryDrift × newsModifier   (structural target)
     reverted = prev + (anchor - prev) × meanReversion (pull toward anchor)
     next     = clamp( reverted × (1 + noise), floor, ceil )
   News raises/lowers the anchor for newsEffectMs, then decays back to 1 so the
   spike is smooth and offline-safe.                                           */

const Market = {
  prices: {},        // id -> current global price
  hist: {},          // id -> [recent prices] for sparklines
  effects: [],       // active galactic news effects: {target, mult, startedAt, durationMs, id}
  localEffects: [],  // active LOCAL events: {systemId, target, mult, startedAt, durationMs, id}
  tradeImpact: {},   // "sysId:commId" -> { p, at }: your persistent, decaying price pressure
  volMult: 1,        // bumped by prestige tier
  histLen: 60,

  byId(id) { return COMMODITIES.find(c => c.id === id); },

  init() {
    this.prices = {};
    this.hist = {};
    this.effects = [];
    this.localEffects = [];
    this.tradeImpact = {};
    for (const c of COMMODITIES) {
      this.prices[c.id] = c.base;
      this.hist[c.id] = [c.base];
    }
  },

  // ---- player price pressure (market depth / anti-arbitrage) --------------
  // Your buying elevates a system's price, selling depresses it; the pressure
  // DECAYS with a half-life so it recovers, but persists long enough that
  // splitting a trade or hopping back and forth can't dodge it.
  _impactKey(commId, sysId) { return sysId + ":" + commId; },
  impactAt(commId, sysId, now = Date.now()) {
    const e = this.tradeImpact[this._impactKey(commId, sysId)];
    if (!e) return 0;
    const decay = Math.pow(0.5, (now - e.at) / MARKETCFG.impactHalfLifeMs);
    return e.p * decay;
  },
  // Add signed pressure (buy > 0, sell < 0). Decays existing pressure to `now`
  // first, then folds in the new push; clamped so a price can't cross zero.
  addImpact(commId, sysId, dP, now = Date.now()) {
    const k = this._impactKey(commId, sysId);
    const p = Util.clamp(this.impactAt(commId, sysId, now) + dP, MARKETCFG.impactFloor, 4);
    this.tradeImpact[k] = { p, at: now };
  },
  // A system's per-category mod, with deviations from 1.0 compressed toward it
  // so cross-station gaps are smaller (the raw arbitrage spread shrinks).
  _mod(cat, systemId) {
    const sys = SYSTEMS.find(s => s.id === systemId);
    const raw = sys ? (sys.mods[cat] ?? 1) : (window.Galaxy ? (Galaxy.modsFor(systemId)[cat] ?? 1) : 1);
    return 1 + (raw - 1) * MARKETCFG.modCompression;
  },
  // Spot price at a system EXCLUDING your own pressure (mods + events only).
  spot(id, systemId, now = Date.now()) {
    const c = this.byId(id);
    return this.prices[id] * this._mod(c.cat, systemId) * this.localMult(c, systemId, now);
  },

  // Slow secular drift per category so sectors rotate in and out of favor.
  categoryDrift(cat, now) {
    const cats = ["mineral", "gas", "agri", "tech", "luxury", "illicit"];
    const phase = (cats.indexOf(cat) / cats.length) * Math.PI * 2;
    const t = (now / CONFIG.driftPeriodMs) * Math.PI * 2;
    return 1 + CONFIG.driftAmp * Math.sin(t + phase);
  },

  // Combined active-news multiplier for one commodity (decays to 1 over life).
  // News only *nudges* price now (scaled by CONFIG.newsImpact) — it can't run it away.
  newsMult(comm, now) {
    let m = 1;
    for (const e of this.effects) {
      if (e.target !== comm.id && e.target !== comm.cat) continue;
      const elapsed = now - e.startedAt;
      if (elapsed >= e.durationMs) continue;
      const remain = 1 - elapsed / e.durationMs;        // 1 → 0 over life
      m *= 1 + (e.mult - 1) * remain * CONFIG.newsImpact;
    }
    return m;
  },

  applyNews(target, mult, durationMs, now, id) {
    this.effects.push({ target, mult, startedAt: now, durationMs, id });
  },

  // A LOCAL event: distorts one system's prices only (see galaxy.js).
  applyLocal(systemId, target, mult, durationMs, now, id) {
    this.localEffects.push({ systemId, target, mult, startedAt: now, durationMs, id });
  },

  // Combined decaying multiplier from local events at a given system+commodity.
  localMult(comm, systemId, now) {
    let m = 1;
    for (const e of this.localEffects) {
      if (e.systemId !== systemId) continue;
      if (e.target !== comm.id && e.target !== comm.cat) continue;
      const elapsed = now - e.startedAt;
      if (elapsed >= e.durationMs) continue;
      m *= 1 + (e.mult - 1) * (1 - elapsed / e.durationMs) * CONFIG.newsImpact;
    }
    return m;
  },

  activeLocal(systemId, now = Date.now()) {
    return this.localEffects.filter(e => e.systemId === systemId && now - e.startedAt < e.durationMs);
  },

  pruneEffects(now) {
    this.effects = this.effects.filter(e => now - e.startedAt < e.durationMs);
    this.localEffects = this.localEffects.filter(e => now - e.startedAt < e.durationMs);
    for (const k in this.tradeImpact) {                         // drop pressure that's decayed to nothing
      const e = this.tradeImpact[k];
      if (Math.abs(e.p) * Math.pow(0.5, (now - e.at) / MARKETCFG.impactHalfLifeMs) < 0.002) delete this.tradeImpact[k];
    }
  },

  // Advance one market tick.
  tick(now) {
    this.pruneEffects(now);
    for (const c of COMMODITIES) {
      // Legislation shifts the whole band, so it's the only sharp price mover.
      const senateFx = window.Senate ? Senate.priceFactor(c.id, c.cat) : 1;
      const legBase = c.base * senateFx;
      const floor = legBase * CONFIG.priceFloorMult, ceil = legBase * CONFIG.priceCeilMult;
      const anchor = legBase * this.categoryDrift(c.cat, now) * this.newsMult(c, now);
      const prev = this.prices[c.id];
      // pull toward the (drift + news) anchor…
      let next = prev + (anchor - prev) * CONFIG.meanReversion;
      // …plus an "other barons arbitrage" pull back toward base once price has run
      // away from the legislated fundamental — this stabilises fast rises/drops.
      const dev = (prev - legBase) / legBase;
      if (Math.abs(dev) > CONFIG.overheatBand) next += (legBase - prev) * CONFIG.overheatPull;
      next *= 1 + Util.gauss(c.vol * CONFIG.volScale * this.volMult);     // small wiggle
      const cap = prev * CONFIG.maxTickMove;
      next = Util.clamp(next, prev - cap, prev + cap);                    // no sudden spikes…
      next = Util.clamp(next, floor, ceil);                              // …but a legislative band shift still snaps sharply
      this.prices[c.id] = next;
      const h = this.hist[c.id];
      h.push(next);
      if (h.length > this.histLen) h.shift();
    }
  },

  // Offline catch-up: simulate forward a bounded number of ticks.
  advance(elapsedMs, endNow) {
    const wanted = Math.floor(elapsedMs / CONFIG.marketTickMs);
    const ticks = Util.clamp(wanted, 0, 600);
    if (ticks === 0) return;
    const startNow = endNow - ticks * CONFIG.marketTickMs;
    for (let i = 1; i <= ticks; i++) this.tick(startNow + i * CONFIG.marketTickMs);
  },

  price(id) { return this.prices[id]; },

  // Price at a given system = global price × that system's category multiplier
  // × any active local-event distortion at that system. Works for curated
  // capitals (SYSTEMS) and generated galaxy systems (Galaxy.modsFor).
  systemPrice(id, systemId, now = Date.now()) {
    return this.spot(id, systemId, now) * (1 + this.impactAt(id, systemId, now));
  },

  history(id) { return this.hist[id] || []; },

  // % change over the recent window (last ~30 ticks).
  changePct(id) {
    const h = this.hist[id];
    if (!h || h.length < 2) return 0;
    const past = h[Math.max(0, h.length - 30)];
    return ((h[h.length - 1] - past) / past) * 100;
  },

  // -1..+1 aggregate sentiment across all commodities (for the sentiment gauge).
  sentiment() {
    let sum = 0, n = 0;
    for (const c of COMMODITIES) {
      const h = this.hist[c.id];
      if (!h || h.length < 2) continue;
      const anchor = c.base * this.categoryDrift(c.cat, Date.now());
      sum += (h[h.length - 1] - anchor) / anchor;
      n++;
    }
    if (!n) return 0;
    return Util.clamp((sum / n) * 4, -1, 1);
  },

  // Snapshot for save (optional — prices are regenerated, but persisting them
  // keeps the chart continuous across reloads).
  serialize() {
    return { prices: this.prices, hist: this.hist, effects: this.effects, localEffects: this.localEffects, tradeImpact: this.tradeImpact };
  },
  hydrate(snap) {
    if (!snap) return;
    if (snap.prices) this.prices = snap.prices;
    if (snap.hist) this.hist = snap.hist;
    if (snap.effects) this.effects = snap.effects;
    if (snap.localEffects) this.localEffects = snap.localEffects;
    if (snap.tradeImpact) this.tradeImpact = snap.tradeImpact;   // persist so a reload can't reset your price pressure
    // Repair any missing commodities (config may have grown since save).
    for (const c of COMMODITIES) {
      if (this.prices[c.id] == null) this.prices[c.id] = c.base;
      if (!this.hist[c.id]) this.hist[c.id] = [this.prices[c.id]];
    }
  },
};

window.Market = Market;
