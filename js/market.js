/* market.js — deterministic price function (Phase 0).
   O(1) in time t: client and (soon) server compute the same number from the
   shared formula in docs/SERVER_AUTHORITATIVE_DESIGN.md §4.

   price_global(c, t) =
     clamp( c.base × drift(c.cat,t) × (1 + c.vol × VOL_GAIN × osc(c,t))
            × event_mult(c,t),
            c.base×FLOOR, c.base×CEIL )

   price_system(c, system, t) = price_global × mod(system,cat) × local_event_mult

   The 2s tick just recomputes; sparklines sample the function. Client-only
   overlays (Broadcast/Wars/Galaxy applyNews·applyLocal, Senate, trade impact)
   still multiply on top for today's UX — Phase 1+ moves authority server-side. */

const Market = {
  prices: {},        // id -> current displayed global price
  hist: {},          // id -> [recent prices] for sparklines
  effects: [],       // active galactic news overlays: {target, mult, startedAt, durationMs, id}
  localEffects: [],  // active LOCAL overlays: {systemId, target, mult, startedAt, durationMs, id}
  tradeImpact: {},   // "sysId:commId" -> { p, at }: your persistent, decaying price pressure
  volMult: 1,        // reserved (prestige used to crank this; kept at 1)
  histLen: 60,
  _oscCache: {},     // id -> [{A,P,θ}×3]

  byId(id) { return COMMODITIES.find(c => c.id === id); },

  // Tradeable pool (excludes craftOnly exotics that never hit the Exchange).
  tradeable() { return COMMODITIES.filter(c => !c.craftOnly); },

  // Sector specialty for a system id (capital or generated). Illicit has no
  // dedicated specialty sector — it rides with Sable Sprawl (luxury).
  _specialty(systemId) {
    if (window.Galaxy) {
      const sys = Galaxy.get(systemId);
      if (sys) {
        const sec = Galaxy.sector(sys.sectorId);
        return sec ? sec.specialty : null;
      }
    }
    const sec = (typeof SECTORS !== "undefined" ? SECTORS : []).find(s => s.capital === systemId);
    return sec ? sec.specialty : null;
  },
  _specialtyCat(cat) { return cat === "illicit" ? "luxury" : cat; },

  // Rare goods: specialty-capital always; ~55% also Navos (seeded per commodity).
  _rareHosts(c) {
    const cat = this._specialtyCat(c.cat);
    const sec = (typeof SECTORS !== "undefined" ? SECTORS : []).find(s => s.specialty === cat);
    const hosts = sec ? [sec.capital] : ["navos"];
    const s = this._seed([c.id, "rareHost2"]);
    if (this._u01(s, 0) < 0.55 && !hosts.includes("navos")) hosts.push("navos");
    return hosts;
  },

  // Whether a commodity appears on this system's Exchange (CRAFTING_AND_MATERIALS §1.2).
  stocks(commId, systemId) {
    const c = this.byId(commId);
    if (!c) return false;
    if (c.craftOnly || c.rarity === "exotic") return false;
    const rarity = c.rarity || "common";
    if (rarity === "common") return true;
    const isHome = systemId === "navos" || !!(SYSTEMS.find(s => s.id === systemId)?.home);
    const specialty = this._specialty(systemId);
    const want = this._specialtyCat(c.cat);
    if (rarity === "uncommon") return isHome || specialty === want;
    if (rarity === "rare") return this._rareHosts(c).includes(systemId);
    return false;
  },

  init() {
    this.prices = {};
    this.hist = {};
    this.effects = [];
    this.localEffects = [];
    this.tradeImpact = {};
    this._oscCache = {};
    const now = Date.now();
    for (const c of COMMODITIES) {
      this.prices[c.id] = this.displayGlobal(c, now);
      this.hist[c.id] = this._sampleHist(c.id, now);
    }
  },

  // ---- hashing / RNG (must match SQL bit-for-bit in spirit; see parity test) -
  // FNV-1a 32-bit over UTF-16 code units (JS string chars) — SQL mirrors this.
  _fnv1a(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  },
  _seed(parts) { return this._fnv1a([MARKETCFG.seed, ...parts].join("|")); },
  // mulberry32 → [0,1). Advance state by n steps for the n-th draw.
  _u01(seed, n = 0) {
    let a = seed >>> 0;
    let r = 0;
    for (let i = 0; i <= n; i++) {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
      t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
      r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return r;
  },

  // Three fixed oscillators per commodity, derived from the seed.
  _oscillators(commId) {
    let cached = this._oscCache[commId];
    if (cached) return cached;
    const raw = [], periods = [], thetas = [];
    for (let i = 0; i < 3; i++) {
      const s = this._seed([commId, "osc", String(i)]);
      raw.push(0.35 + this._u01(s, 0) * 0.65);
      const lo = MARKETCFG.oscPeriodMinMs[i], hi = MARKETCFG.oscPeriodMaxMs[i];
      periods.push(lo + this._u01(s, 1) * (hi - lo));
      thetas.push(this._u01(s, 2) * Math.PI * 2);
    }
    const norm = Math.hypot(raw[0], raw[1], raw[2]) || 1;
    cached = raw.map((a, i) => ({ A: a / norm, P: periods[i], th: thetas[i] }));
    this._oscCache[commId] = cached;
    return cached;
  },

  _osc(commId, t) {
    let sum = 0;
    for (const o of this._oscillators(commId)) {
      sum += o.A * Math.sin((Math.PI * 2 * t) / o.P + o.th);
    }
    return sum;   // |sum| ≲ 1 after A-normalization
  },

  // Slow secular drift per category so sectors rotate in and out of favor.
  categoryDrift(cat, now) {
    const cats = ["mineral", "gas", "agri", "tech", "luxury", "illicit"];
    const phase = (cats.indexOf(cat) / cats.length) * Math.PI * 2;
    const t = (now / CONFIG.driftPeriodMs) * Math.PI * 2;
    return 1 + CONFIG.driftAmp * Math.sin(t + phase);
  },

  // ---- seeded event schedules (pure; identical on server) -----------------
  // Slot s starts at s*period. We look back a few slots so long-duration events
  // still cover `t` after their slot has rolled over.
  _eventSlot(slot, kind) {
    const s = this._seed([kind, "slot", String(slot)]);
    const cats = ["mineral", "gas", "agri", "tech", "luxury", "illicit"];
    // ~70% category-wide, ~30% single commodity — keeps the tape alive without chaos.
    const pickCat = this._u01(s, 0) < 0.7;
    const tradeable = this.tradeable();
    const target = pickCat
      ? cats[Math.floor(this._u01(s, 1) * cats.length) % cats.length]
      : tradeable[Math.floor(this._u01(s, 1) * tradeable.length) % tradeable.length].id;
    // mult in [0.55, 0.85] ∪ [1.15, 1.70]
    const up = this._u01(s, 2) < 0.55;
    const mult = up ? 1.15 + this._u01(s, 3) * 0.55 : 0.55 + this._u01(s, 3) * 0.30;
    return { target, mult };
  },

  _scheduleMult(comm, t, periodMs, durationMs, kind, systemId = null) {
    let m = 1;
    const slot = Math.floor(t / periodMs);
    const lookback = Math.ceil(durationMs / periodMs) + 1;
    for (let s = slot - lookback; s <= slot; s++) {
      if (s < 0) continue;
      const ev = systemId == null ? this._eventSlot(s, kind) : this._eventSlotLocal(s, systemId);
      const start = s * periodMs;
      if (t < start || t >= start + durationMs) continue;
      if (ev.target !== comm.id && ev.target !== comm.cat) continue;
      // Smooth sin envelope (0→1→0) so slot edges don't step the price.
      const envelope = Math.sin(((t - start) / durationMs) * Math.PI);
      m *= 1 + (ev.mult - 1) * envelope * CONFIG.newsImpact;
    }
    return m;
  },

  _eventSlotLocal(slot, systemId) {
    const s = this._seed(["local", systemId, "slot", String(slot)]);
    const cats = ["mineral", "gas", "agri", "tech", "luxury", "illicit"];
    const pickCat = this._u01(s, 0) < 0.6;
    const tradeable = this.tradeable();
    const target = pickCat
      ? cats[Math.floor(this._u01(s, 1) * cats.length) % cats.length]
      : tradeable[Math.floor(this._u01(s, 1) * tradeable.length) % tradeable.length].id;
    const up = this._u01(s, 2) < 0.5;
    const mult = up ? 1.2 + this._u01(s, 3) * 0.5 : 0.5 + this._u01(s, 3) * 0.35;
    return { target, mult };
  },

  eventMult(comm, t) {
    return this._scheduleMult(comm, t, MARKETCFG.eventPeriodMs, MARKETCFG.eventDurationMs, "galactic");
  },
  localEventMult(comm, systemId, t) {
    return this._scheduleMult(comm, t, MARKETCFG.localEventPeriodMs, MARKETCFG.localEventDurationMs, "local", systemId);
  },

  // ---- pure formula (SQL contract; no senate / client overlays) -----------
  // baseOverride lets the live path re-band around a legislated base.
  formulaGlobal(commOrId, t, baseOverride = null) {
    const c = typeof commOrId === "string" ? this.byId(commOrId) : commOrId;
    const base = baseOverride == null ? c.base : baseOverride;
    const drift = this.categoryDrift(c.cat, t);
    const osc = this._osc(c.id, t);
    const vol = c.vol * MARKETCFG.volGain * (this.volMult || 1);
    let price = base * drift * (1 + vol * osc) * this.eventMult(c, t);
    const floor = base * CONFIG.priceFloorMult, ceil = base * CONFIG.priceCeilMult;
    return Util.clamp(price, floor, ceil);
  },

  formulaSystem(commOrId, systemId, t) {
    const c = typeof commOrId === "string" ? this.byId(commOrId) : commOrId;
    return this.formulaGlobal(c, t) * this._mod(c.cat, systemId) * this.localEventMult(c, systemId, t);
  },

  // Live display price: formula + senate band + client news overlays.
  displayGlobal(c, t) {
    const senateFx = window.Senate ? Senate.priceFactor(c.id, c.cat) : 1;
    return this.formulaGlobal(c, t, c.base * senateFx) * this.newsMult(c, t);
  },

  // ---- player price pressure (market depth / anti-arbitrage) --------------
  _impactKey(commId, sysId) { return sysId + ":" + commId; },
  impactAt(commId, sysId, now = Date.now()) {
    const e = this.tradeImpact[this._impactKey(commId, sysId)];
    if (!e) return 0;
    const decay = Math.pow(0.5, (now - e.at) / MARKETCFG.impactHalfLifeMs);
    return e.p * decay;
  },
  addImpact(commId, sysId, dP, now = Date.now()) {
    const k = this._impactKey(commId, sysId);
    const p = Util.clamp(this.impactAt(commId, sysId, now) + dP, MARKETCFG.impactFloor, 4);
    this.tradeImpact[k] = { p, at: now };
  },
  _mod(cat, systemId) {
    const sys = SYSTEMS.find(s => s.id === systemId);
    const raw = sys ? (sys.mods[cat] ?? 1) : (window.Galaxy ? (Galaxy.modsFor(systemId)[cat] ?? 1) : 1);
    return 1 + (raw - 1) * MARKETCFG.modCompression;
  },
  // Spot at a system EXCLUDING your own pressure (mods + seeded local + overlays).
  spot(id, systemId, now = Date.now()) {
    const c = this.byId(id);
    let p = this.prices[id] * this._mod(c.cat, systemId)
      * this.localEventMult(c, systemId, now) * this.localMult(c, systemId, now);
    // Rare scarcity: when a rare good is stocked here, buy/sell marks higher.
    if ((c.rarity || "common") === "rare" && this.stocks(id, systemId)) {
      p *= (MARKETCFG.rareStockPremium || 1.35);
    }
    return p;
  },

  // Combined active-news multiplier for one commodity (decays to 1 over life).
  // Client overlay from Broadcast/Wars/WorldFeed — not part of the SQL contract.
  newsMult(comm, now) {
    let m = 1;
    for (const e of this.effects) {
      if (e.target !== comm.id && e.target !== comm.cat) continue;
      const elapsed = now - e.startedAt;
      if (elapsed >= e.durationMs) continue;
      const remain = 1 - elapsed / e.durationMs;
      m *= 1 + (e.mult - 1) * remain * CONFIG.newsImpact;
    }
    return m;
  },

  applyNews(target, mult, durationMs, now, id) {
    this.effects.push({ target, mult, startedAt: now, durationMs, id });
  },

  applyLocal(systemId, target, mult, durationMs, now, id) {
    this.localEffects.push({ systemId, target, mult, startedAt: now, durationMs, id });
  },

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
    for (const k in this.tradeImpact) {
      const e = this.tradeImpact[k];
      if (Math.abs(e.p) * Math.pow(0.5, (now - e.at) / MARKETCFG.impactHalfLifeMs) < 0.002) delete this.tradeImpact[k];
    }
  },

  _sampleHist(id, now) {
    const c = this.byId(id);
    const h = [];
    for (let i = this.histLen - 1; i >= 0; i--) {
      h.push(this.displayGlobal(c, now - i * CONFIG.marketTickMs));
    }
    return h;
  },

  // Recompute every commodity from the clock (no accumulated random walk).
  tick(now) {
    this.pruneEffects(now);
    for (const c of COMMODITIES) {
      const next = this.displayGlobal(c, now);
      this.prices[c.id] = next;
      const h = this.hist[c.id] || (this.hist[c.id] = []);
      h.push(next);
      if (h.length > this.histLen) h.shift();
    }
  },

  // Offline catch-up: prices are a pure function of time, so one recompute +
  // hist resample replaces the old N-tick random-walk simulation.
  advance(elapsedMs, endNow) {
    if (elapsedMs < CONFIG.marketTickMs) return;
    this.pruneEffects(endNow);
    for (const c of COMMODITIES) {
      this.prices[c.id] = this.displayGlobal(c, endNow);
      this.hist[c.id] = this._sampleHist(c.id, endNow);
    }
  },

  price(id) { return this.prices[id]; },

  systemPrice(id, systemId, now = Date.now()) {
    return this.spot(id, systemId, now) * (1 + this.impactAt(id, systemId, now));
  },

  // Route pricing skips the rare-stock exchange premium — routes abstract capital
  // and that premium was zeroing spreads (Start disabled) on many rare goods.
  routePrice(id, systemId, now = Date.now()) {
    const c = this.byId(id); if (!c) return 0;
    const p = this.prices[id] * this._mod(c.cat, systemId)
      * this.localEventMult(c, systemId, now) * this.localMult(c, systemId, now);
    return p * (1 + this.impactAt(id, systemId, now));
  },

  history(id) { return this.hist[id] || []; },

  changePct(id) {
    const h = this.hist[id];
    if (!h || h.length < 2) return 0;
    const past = h[Math.max(0, h.length - 30)];
    return ((h[h.length - 1] - past) / past) * 100;
  },

  sentiment() {
    let sum = 0, n = 0;
    const now = Date.now();
    for (const c of COMMODITIES) {
      const h = this.hist[c.id];
      if (!h || h.length < 2) continue;
      const anchor = c.base * this.categoryDrift(c.cat, now);
      sum += (h[h.length - 1] - anchor) / anchor;
      n++;
    }
    if (!n) return 0;
    return Util.clamp((sum / n) * 4, -1, 1);
  },

  serialize() {
    return { prices: this.prices, hist: this.hist, effects: this.effects, localEffects: this.localEffects, tradeImpact: this.tradeImpact };
  },
  hydrate(snap) {
    if (!snap) return;
    // Prices/hist are recomputed from the clock; keep overlays + trade pressure.
    if (snap.effects) this.effects = snap.effects;
    if (snap.localEffects) this.localEffects = snap.localEffects;
    if (snap.tradeImpact) this.tradeImpact = snap.tradeImpact;
    const now = Date.now();
    for (const c of COMMODITIES) {
      this.prices[c.id] = this.displayGlobal(c, now);
      this.hist[c.id] = this._sampleHist(c.id, now);
    }
  },
};

window.Market = Market;
