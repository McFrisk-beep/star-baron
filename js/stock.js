/* stock.js — finite per-sector commodity stock (docs/STATIONS.md §2–4).
   Price scarcity rides on top of Market.anchor; buy/sell mutate units.
   Hourly tick: consumption → NPC production (+ elastic backstop) → trickle.
   Guests tick locally; signed-in Phase 4 uses app_trade / app_sector_stock.   */

const Stock = {
  units: {},          // sectorId -> { commId -> units }
  shortfall: {},      // sectorId -> { commId -> unmet demand last hour }
  sentiment: {},      // sectorId -> 0..100
  lastTickAt: 0,
  _baselines: {},     // sectorId -> { commId -> baseline } (cached)

  // Phase 4: server owns the shelf only after app_sector_stock has succeeded
  // this session (signed-in without the SQL paste keeps the local tick).
  _serverShelf: false,
  markServerShelf(on) { this._serverShelf = !!on; },
  authoritative() { return !!(this._serverShelf && window.Economy && Economy.authoritative()); },

  tradeable() { return COMMODITIES.filter(c => !c.craftOnly && c.rarity !== "exotic"); },

  sectorIds() {
    if (window.Galaxy && Galaxy.sectors && Galaxy.sectors.length)
      return Galaxy.sectors.map(s => s.id);
    return (typeof SECTORS !== "undefined" ? SECTORS : []).map(s => s.id);
  },

  sectorOf(systemId) {
    if (window.Galaxy) {
      const sys = Galaxy.get(systemId);
      if (sys) return sys.sectorId;
    }
    const sec = (typeof SECTORS !== "undefined" ? SECTORS : []).find(s => s.capital === systemId);
    return sec ? sec.id : null;
  },

  specialty(sectorId) {
    const sec = window.Galaxy ? Galaxy.sector(sectorId)
      : (typeof SECTORS !== "undefined" ? SECTORS : []).find(s => s.id === sectorId);
    return sec ? sec.specialty : null;
  },

  baseline(sectorId, commId) {
    const bag = this._baselines[sectorId] || (this._baselines[sectorId] = {});
    if (bag[commId] != null) return bag[commId];
    const c = COMMODITIES.find(x => x.id === commId);
    if (!c || c.craftOnly || c.rarity === "exotic") return bag[commId] = 0;
    const rarity = c.rarity || "common";
    let base = STOCKCFG.baseline[rarity] || 0;
    const spec = this.specialty(sectorId);
    const want = c.cat === "illicit" ? "luxury" : c.cat;
    if (spec) base = Math.round(base * (spec === want ? STOCKCFG.specialtyMult : STOCKCFG.offSpecialtyMult));
    return bag[commId] = base;
  },

  available(sectorId, commId) {
    const u = this.units[sectorId];
    return u ? (u[commId] | 0) : 0;
  },

  // Available at the exchange for a docked system (capital → its sector).
  availableHere(systemId, commId) {
    const sid = this.sectorOf(systemId);
    return sid ? this.available(sid, commId) : 0;
  },

  ratio(sectorId, commId) {
    const base = this.baseline(sectorId, commId);
    if (base <= 0) return 1;
    return this.available(sectorId, commId) / base;
  },

  scarcityMult(sectorId, commId) {
    const r = Math.max(this.ratio(sectorId, commId), 0.02);
    const raw = Math.pow(1 / r, STOCKCFG.elasticity);
    return Util.clamp(raw, STOCKCFG.minMult, STOCKCFG.maxMult);
  },

  scarcityMultForSystem(systemId, commId) {
    const sid = this.sectorOf(systemId);
    return sid ? this.scarcityMult(sid, commId) : 1;
  },

  take(sectorId, commId, qty) {
    qty = Math.floor(qty);
    if (qty <= 0) return 0;
    const have = this.available(sectorId, commId);
    const n = Math.min(have, qty);
    if (!this.units[sectorId]) this.units[sectorId] = {};
    this.units[sectorId][commId] = have - n;
    return n;
  },

  put(sectorId, commId, qty) {
    qty = Math.floor(qty);
    if (qty <= 0) return 0;
    if (!this.units[sectorId]) this.units[sectorId] = {};
    // Soft glut cap — NPC supply alone must not unbounded-fill the shelf.
    const cap = Math.floor(this.baseline(sectorId, commId) * (STOCKCFG.glutCapMult || 3)) || Infinity;
    const have = this.units[sectorId][commId] | 0;
    const room = Math.max(0, cap - have);
    qty = Math.min(qty, room);
    if (!qty) return 0;
    this.units[sectorId][commId] = have + qty;
    return qty;
  },

  takeHere(systemId, commId, qty) {
    const sid = this.sectorOf(systemId);
    return sid ? this.take(sid, commId, qty) : 0;
  },

  putHere(systemId, commId, qty) {
    const sid = this.sectorOf(systemId);
    return sid ? this.put(sid, commId, qty) : 0;
  },

  // Consumption demand for one commodity in one sector this hour.
  demand(sectorId, commId, hourIndex) {
    const c = COMMODITIES.find(x => x.id === commId);
    if (!c || c.craftOnly || c.rarity === "exotic") return 0;
    const rarity = c.rarity || "common";
    const base = CONSUMPTION.defaultByRarity[rarity] || 0;
    const pop = (CONSUMPTION.sectorPop && CONSUMPTION.sectorPop[sectorId]) || 1;
    const catMap = (CONSUMPTION.catSectorMult && CONSUMPTION.catSectorMult[c.cat]) || { _: 1 };
    const catMult = catMap[sectorId] != null ? catMap[sectorId] : (catMap._ != null ? catMap._ : 1);
    // Deterministic seasonal noise from hour + sector + commodity.
    const s = Market._seed([sectorId, commId, "season", String(hourIndex | 0)]);
    const noise = (Market._u01(s, 0) * 2 - 1) * STOCKCFG.seasonalAmp;
    return Math.max(0, base * pop * catMult * (1 + noise));
  },

  npcOutputMult(sectorId, commId) {
    const r = Math.min(this.ratio(sectorId, commId), 1);
    return Util.clamp(1 + (1 - r) * STOCKCFG.npcOutputBoost, 1, STOCKCFG.npcOutputMultMax);
  },

  init(now = Date.now()) {
    this.units = {};
    this.shortfall = {};
    this.sentiment = {};
    this._baselines = {};
    this.lastTickAt = now;
    for (const sid of this.sectorIds()) {
      this.units[sid] = {};
      this.shortfall[sid] = {};
      this.sentiment[sid] = STOCKCFG.sentimentStart != null ? STOCKCFG.sentimentStart : STATIONCFG.sentimentStart;
      for (const c of this.tradeable()) {
        this.units[sid][c.id] = this.baseline(sid, c.id);
      }
    }
  },

  // One hourly cycle. Returns a tiny summary for the sim harness.
  // When the shelf is server-owned, skip local consume/produce/trickle/sentiment
  // mutations — but still run Stations.afterStockHour (and owned-hub produce).
  // opts.stationRemote === false: local station hour only (no RPC chain).
  tickHour(hourIndex, opts) {
    const summary = { consumed: 0, produced: 0, shortfall: 0 };
    const shelfLocal = !this.authoritative();
    const ids = this.sectorIds();
    const tradeable = this.tradeable();

    if (shelfLocal) {
      // 1) Consumption
      for (const sid of ids) {
        if (!this.shortfall[sid]) this.shortfall[sid] = {};
        for (const c of tradeable) {
          const want = Math.floor(this.demand(sid, c.id, hourIndex));
          const have = this.available(sid, c.id);
          const took = Math.min(have, want);
          if (took) this.take(sid, c.id, took);
          // Only whole unmet units count — fractional demand is noise, not famine.
          this.shortfall[sid][c.id] = Math.max(0, want - took);
          summary.consumed += took;
          summary.shortfall += this.shortfall[sid][c.id];
        }
      }
    }

    // 2) NPC station production → sector stock (Stations drives baskets).
    // Authoritative shelf: npcProduceHour still runs owned-hub / lease logic
    // but must not Stock.put (see Stations.npcProduceHour).
    if (window.Stations && Stations.npcProduceHour) {
      summary.produced += Stations.npcProduceHour(hourIndex);
    } else if (shelfLocal) {
      // Fallback when Stations isn't loaded (harness): one virtual producer per sector.
      for (const sid of ids) {
        for (const c of tradeable) {
          const rarity = c.rarity || "common";
          const base = STOCKCFG.npcUnits[rarity] || 0;
          const nStations = 12;
          const out = Math.round(base * nStations * this.npcOutputMult(sid, c.id) * 0.15);
          if (out > 0) { this.put(sid, c.id, out); summary.produced += out; }
        }
      }
    }

    if (shelfLocal) {
      // 3) Inter-sector trickle into empty/critical bins from surplus sectors
      for (const sid of ids) {
        for (const c of tradeable) {
          if (this.ratio(sid, c.id) >= 0.15) continue;
          for (const src of ids) {
            if (src === sid) continue;
            const have = this.available(src, c.id);
            const base = this.baseline(src, c.id);
            if (have <= base * 1.05) continue; // only skim surplus
            const gift = Math.max(1, Math.floor((have - base) * STOCKCFG.trickleFrac));
            const took = this.take(src, c.id, gift);
            if (took) this.put(sid, c.id, took);
          }
        }
      }

      // 4) Sector sentiment (docs/STATIONS.md §6.1)
      for (const sid of ids) {
        let sent = this.sentiment[sid];
        if (sent == null) sent = STATIONCFG.sentimentStart;
        for (const c of tradeable) {
          const sf = (this.shortfall[sid] && this.shortfall[sid][c.id]) || 0;
          const r = this.ratio(sid, c.id);
          if (sf > 0) sent -= 3.0;
          else if (r < 0.10) sent -= 1.5;
          else if (r < 0.25) sent -= 0.5;
          else if (r >= 0.60) sent += 0.75;
        }
        // Sentiment deltas above fire per commodity — scale down so ~40 goods don't
        // pin the meter every hour. Ponytail: one global dampener; revisit if the
        // commodity count shrinks to a curated "staples" basket.
        const n = tradeable.length || 1;
        const rawDelta = sent - (this.sentiment[sid] ?? STATIONCFG.sentimentStart);
        const damped = (this.sentiment[sid] ?? STATIONCFG.sentimentStart) + rawDelta / n;
        this.sentiment[sid] = Util.clamp(damped, 0, 100);
      }
    }

    // opts.stationRemote: false skips the RPC chain (upkeep/settle/produce) so a
    // multi-hour catch-up doesn't thundering-herd the server — only the final
    // hour of a burst should pass true (default).
    if (window.Stations && Stations.afterStockHour) {
      const remote = !(opts && opts.stationRemote === false);
      Stations.afterStockHour(hourIndex, { remote });
    }
    return summary;
  },

  // Apply a server shelf snapshot (app_sector_stock) or a single trade delta.
  applyServerUnits(unitsBySector, lastTickAt) {
    if (!unitsBySector || typeof unitsBySector !== "object") return;
    for (const [sid, bag] of Object.entries(unitsBySector)) {
      if (!bag || typeof bag !== "object") continue;
      if (!this.units[sid]) this.units[sid] = {};
      for (const [cid, u] of Object.entries(bag)) {
        if (Number.isFinite(+u) && +u >= 0) this.units[sid][cid] = Math.floor(+u);
      }
    }
    if (Number.isFinite(+lastTickAt)) this.lastTickAt = +lastTickAt;
  },

  applyTradeDelta(sectorId, commId, units) {
    if (!sectorId || !commId || !Number.isFinite(+units)) return;
    if (!this.units[sectorId]) this.units[sectorId] = {};
    this.units[sectorId][commId] = Math.max(0, Math.floor(+units));
  },

  // Advance any due hourly ticks (live loop + offline catch-up).
  // Signed-in Phase 4: server cron owns the *shelf*, but Stations.afterStockHour
  // (hall expire, upkeep RPC, remote leases, settle) still rides this watermark.
  // Multi-hour catch-up runs local station logic every hour, but only the final
  // hour fires the remote RPC chain (avoids a ~48× boot thundering herd).
  // Watermark advances per successful hour so a throw mid-catch-up retries the rest.
  tick(now = Date.now()) {
    if (!this.lastTickAt) this.lastTickAt = now;
    const ms = STOCKCFG.tickMs || 3600000;
    let n = 0;
    // Cap catch-up so a 7-day offline doesn't spin 168 ticks synchronously forever.
    const maxHours = 48;
    let cursor = this.lastTickAt;
    const hours = [];
    while (now - cursor >= ms && n < maxHours) {
      cursor += ms;
      hours.push(Math.floor(cursor / ms));
      n++;
    }
    let jumpTo = null;
    if (now - cursor >= ms) jumpTo = now - (now % ms);
    for (let i = 0; i < hours.length; i++) {
      this.tickHour(hours[i], { stationRemote: i === hours.length - 1 });
      this.lastTickAt += ms;
    }
    if (jumpTo != null) this.lastTickAt = jumpTo;
    return n;
  },

  advance(elapsedMs, endNow) {
    if (elapsedMs < (STOCKCFG.tickMs || 3600000)) {
      // Still allow a single catch-up if the watermark is stale.
      return this.tick(endNow);
    }
    return this.tick(endNow);
  },

  // Aggregate health for the sim harness / admin.
  health() {
    const out = {};
    for (const sid of this.sectorIds()) {
      let sumR = 0, n = 0, empty = 0;
      for (const c of this.tradeable()) {
        const r = this.ratio(sid, c.id);
        sumR += r; n++;
        if (this.available(sid, c.id) <= 0) empty++;
      }
      out[sid] = {
        avgRatio: n ? sumR / n : 1,
        empty,
        sentiment: this.sentiment[sid] ?? STATIONCFG.sentimentStart,
      };
    }
    return out;
  },

  serialize() {
    return {
      units: this.units,
      shortfall: this.shortfall,
      sentiment: this.sentiment,
      lastTickAt: this.lastTickAt,
    };
  },

  hydrate(snap) {
    if (!snap || typeof snap !== "object") return;
    // Trust-boundary: coerce shapes; refill any missing sector/commodity from baseline.
    this.units = (snap.units && typeof snap.units === "object") ? snap.units : {};
    this.shortfall = (snap.shortfall && typeof snap.shortfall === "object") ? snap.shortfall : {};
    this.sentiment = (snap.sentiment && typeof snap.sentiment === "object") ? snap.sentiment : {};
    this.lastTickAt = Number.isFinite(+snap.lastTickAt) ? +snap.lastTickAt : Date.now();
    this._baselines = {};
    for (const sid of this.sectorIds()) {
      if (!this.units[sid] || typeof this.units[sid] !== "object") this.units[sid] = {};
      if (!this.shortfall[sid] || typeof this.shortfall[sid] !== "object") this.shortfall[sid] = {};
      if (!Number.isFinite(+this.sentiment[sid])) this.sentiment[sid] = STATIONCFG.sentimentStart;
      this.sentiment[sid] = Util.clamp(+this.sentiment[sid], 0, 100);
      for (const c of this.tradeable()) {
        const v = this.units[sid][c.id];
        if (!Number.isFinite(+v) || +v < 0) this.units[sid][c.id] = this.baseline(sid, c.id);
        else this.units[sid][c.id] = Math.floor(+v);
      }
    }
  },
};

window.Stock = Stock;
