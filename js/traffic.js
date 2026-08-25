/* traffic.js — visible NPC cargo traffic (docs/STATIONS.md supply, made flesh).

   Pure VIEW of the clock, exactly like voyage.js: nothing persisted, nothing
   ticked. The stock itself lands in the hourly Stock/Stations tick; these are
   the ships that story tells — and the future targets for piracy.

   • Freighters: one named hauler per NPC-run station, looping station ↔ sector
     capital every stock hour. Its manifest is the same ≤3-commodity basket
     Stations.npcProduceHour delivers to the sector shelf.
   • Traders: small seeded cargo ships hopping between in-sector systems. When
     any shelf in a sector falls under STOCKCFG.npcSurgeRatio, extra relief
     traders run in from a neighbouring sector capital — the visible face of
     the npcSurgeMult supply surge.

   • Raided hauls: a run in or out of a system with a pirate den can be taken
     (raiders.js, §4). The hauler still limps to its destination — hull kept,
     hold empty — which is the same rule that protects a player's miner. It is
     deliberately shelf-neutral: suppressing NPC supply is the den's own job in
     §7.1, and doing it here would drain stock.js twice for one den.

   Consumers: Voyages.markers() (galaxy view) and Voyages.inSystem() (system
   view) concat Traffic.flights(now); starmap draws them like any voyage.     */

const Traffic = {
  _names: {},        // key -> flavor ship name (derived, session cache)
  _manifests: {},    // systemId -> { hourIndex, ids } (reuses the hourly basket)

  _ready() {
    return !!(window.Galaxy && Galaxy.list && Galaxy.list.length
      && window.Lanes && window.Voyages && window.Stations && window.Stock);
  },

  _name(key) {
    let n = this._names[key];
    if (!n) {
      const s = Market._seed(["traffic", key]);
      const a = SHIP_NAME_A[Math.floor(Market._u01(s, 0) * SHIP_NAME_A.length) % SHIP_NAME_A.length];
      const b = SHIP_NAME_B[Math.floor(Market._u01(s, 1) * SHIP_NAME_B.length) % SHIP_NAME_B.length];
      n = this._names[key] = `${a} ${b}`;
    }
    return n;
  },

  // The ≤3 commodities this station's freighter is hauling this hour — the
  // very basket npcProduceHour puts on the shelf. Cached per hour (the basket
  // sorts the pool; don't re-sort per animation frame).
  manifest(st, now) {
    const hourIndex = Math.floor(now / (STOCKCFG.tickMs || 3600000));
    let m = this._manifests[st.systemId];
    if (!m || m.hourIndex !== hourIndex) {
      const basket = (Stations._npcBasket(st, hourIndex) || []).slice(0, TRAFFICCFG.manifestSize);
      m = this._manifests[st.systemId] = { hourIndex, ids: basket.map(c => c.id) };
    }
    return m.ids;
  },

  // One delivery loop per station per hour, seeded phase so arrivals spread
  // across the hour: fly out → dock at the capital (drop cargo) → fly home.
  freighters(now) {
    const out = [];
    const P = TRAFFICCFG.freighterPeriodMs;
    const legFrac = TRAFFICCFG.freighterLegFrac;
    for (const st of Stations.list()) {
      if (st.status === "owned" || st.status === "refit" || st.status === "cooldown") continue;
      if (Stations.isRemote && Stations.isRemote(st.systemId)) continue;
      const sec = Galaxy.sector(st.sectorId);
      if (!sec || sec.capital === st.systemId) continue;
      const phase = Market._u01(Market._seed(["traffic", "phase", st.systemId]), 0);
      const tau = ((now + phase * P) % P) / P;
      let plan = null;
      if (tau < legFrac) {
        plan = Voyages.plan(st.systemId, sec.capital, now - tau * P, legFrac * P);
      } else if (tau >= 0.5 && tau < 0.5 + legFrac) {
        plan = Voyages.plan(sec.capital, st.systemId, now - (tau - 0.5) * P, legFrac * P);
      }
      if (!plan) continue;             // docked, or no lane route
      const at = Voyages.pos(plan, now);
      if (!at) continue;
      const id = "npc:f:" + st.systemId;
      // Same phased loop index tau rides, so a run keeps one status end to end.
      const robbed = this._robbed(id, Math.floor((now + phase * P) / P), st.systemId, sec.capital);
      out.push({
        id, kind: "freighter", npc: true, raided: robbed,
        name: this._name("f:" + st.systemId),
        label: this._name("f:" + st.systemId),
        sprite: "ship:freighter", manifest: robbed ? [] : this.manifest(st, now),
        plan, at,
      });
    }
    return out;
  },

  // True while any shelf in the sector sits under the surge ratio.
  _surging(sectorId) {
    for (const c of Stock.tradeable()) {
      if (Stock.ratio(sectorId, c.id) < (STOCKCFG.npcSurgeRatio || 0)) return true;
    }
    return false;
  },

  // Small cargo ships hopping between systems, seeded per loop so every client
  // draws the same hop. Relief traders (the surge extras) run neighbouring
  // capital → this sector's capital, hauling the scarcest goods.
  traders(now) {
    const out = [];
    const ring = window.Lanes ? Lanes.ringOrder() : [];
    for (const sec of Galaxy.sectors) {
      const surge = this._surging(sec.id);
      const n = TRAFFICCFG.tradersPerSector + (surge ? TRAFFICCFG.tradersSurge : 0);
      for (let i = 0; i < n; i++) {
        const relief = i >= TRAFFICCFG.tradersPerSector;
        const sSlot = Market._seed(["traffic", "trader", sec.id, String(i)]);
        const loopMs = TRAFFICCFG.traderLoopMinMs
          + Market._u01(sSlot, 0) * (TRAFFICCFG.traderLoopMaxMs - TRAFFICCFG.traderLoopMinMs);
        const k = Math.floor(now / loopMs);
        const s = Market._seed(["traffic", "hop", sec.id, String(i), String(k)]);
        let from, to;
        if (relief) {
          // In from a ring neighbour's capital, straight to the hungry exchange.
          const at = ring.indexOf(sec.id);
          const nb = ring[(at + (Market._u01(s, 0) < 0.5 ? 1 : ring.length - 1)) % ring.length];
          const nbSec = Galaxy.sectors.find(x => x.id === nb);
          from = nbSec ? nbSec.capital : sec.capital;
          to = sec.capital;
        } else {
          const ids = sec.systems;
          from = ids[Math.floor(Market._u01(s, 0) * ids.length) % ids.length];
          to = ids[Math.floor(Market._u01(s, 1) * ids.length) % ids.length];
          if (to === from) to = sec.capital !== from ? sec.capital : ids[(ids.indexOf(from) + 1) % ids.length];
        }
        if (from === to) continue;
        const flyMs = loopMs * TRAFFICCFG.traderFlyFrac;
        const plan = Voyages.plan(from, to, k * loopMs, flyMs);
        if (!plan) continue;
        const at = Voyages.pos(plan, now);
        if (!at || at.p >= 1) continue;      // dwell tail of the loop — parked
        const id = `npc:t:${sec.id}:${i}`;
        const robbed = this._robbed(id, k, from, to);
        out.push({
          id, kind: "trader", npc: true, relief, raided: robbed,
          name: this._name(`t:${sec.id}:${i}`),
          sprite: "ship:shuttle", manifest: robbed ? [] : this._traderManifest(sec.id, i, k),
          plan, at,
        });
      }
    }
    return out;
  },

  // Traders haul whatever the sector is eating: the 3 scarcest shelves.
  // ponytail: sorts ~41 ratios once per trader hop; cached per slot until the
  // next loop starts, so animation frames pay a lookup.
  _tm: {},           // "sectorId:i" -> { k, ids }
  _traderManifest(sectorId, i, k) {
    const key = sectorId + ":" + i;
    let m = this._tm[key];
    if (!m || m.k !== k) {
      const ids = Stock.tradeable()
        .map(c => ({ id: c.id, r: Stock.ratio(sectorId, c.id) }))
        .sort((a, b) => a.r - b.r)
        .slice(0, TRAFFICCFG.manifestSize)
        .map(x => x.id);
      m = this._tm[key] = { k, ids };
    }
    return m.ids;
  },

  // Corsairs out of a den take this run's manifest (raiders.js §4). Pure
  // function of the flight and its loop index — no storage, same for everyone.
  _robbed(id, loopIndex, fromSys, toSys) {
    return !!(window.Raiders && Raiders.tookManifest(id, loopIndex, fromSys, toSys));
  },

  // Everything currently flying. Never throws — a render layer must not take
  // the map down with it.
  flights(now = Date.now()) {
    if (!this._ready()) return [];
    try {
      return this.freighters(now).concat(this.traders(now));
    } catch (e) {
      console.warn("Traffic.flights failed", e);
      return [];
    }
  },
};

window.Traffic = Traffic;
