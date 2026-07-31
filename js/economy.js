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
  authoritative() { return !!(window.Cloud && window.Cloud.authoritative()); },
  _pending: 0,
  _rpcQueue: Promise.resolve(),
  busy() { return this._pending > 0; },

  priceHere(commId) { return Market.systemPrice(commId, this.s().currentSystem); },
  inTransit() { return !!this.s().travel; },

  _snapEconomy() {
    const s = this.s();
    return {
      credits: s.credits,
      positions: JSON.parse(JSON.stringify(s.positions || {})),
      avgCost: JSON.parse(JSON.stringify(s.avgCost || {})),
      stats: {
        trades: s.stats.trades,
        biggestTrade: s.stats.biggestTrade,
        contractsDone: s.stats.contractsDone,
      },
      currentSystem: s.currentSystem,
      travel: s.travel ? Object.assign({}, s.travel) : null,
      unlockedSystems: (s.unlockedSystems || []).slice(),
      reputation: JSON.parse(JSON.stringify(s.reputation || {})),
      // Phase 2: pre-action fleet/board so soft-sync doesn't send optimistic removals
      ships: JSON.parse(JSON.stringify(s.ships || [])),
      mainShip: JSON.parse(JSON.stringify(s.mainShip || {})),
      missions: JSON.parse(JSON.stringify(s.missions || [])),
      reports: JSON.parse(JSON.stringify(s.reports || [])),
      items: JSON.parse(JSON.stringify(s.items || {})),
      inventory: JSON.parse(JSON.stringify(s.inventory || {})),
      bazaar: JSON.parse(JSON.stringify(s.bazaar || {})),
      pendingContracts: JSON.parse(JSON.stringify(s.pendingContracts || [])),
      bazaarBought: (s.bazaarBought || []).slice(),
      // Phase 3: routes / extractors / components so a failed route or bazaar
      // buy rolls back the optimistic mutation.
      routes: JSON.parse(JSON.stringify(s.routes || [])),
      extractors: JSON.parse(JSON.stringify(s.extractors || {})),
      components: JSON.parse(JSON.stringify(s.components || {})),
      seq: s.seq,
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
    if (snap.stats.contractsDone != null) s.stats.contractsDone = snap.stats.contractsDone;
    if (snap.ships) s.ships = snap.ships;
    if (snap.mainShip) s.mainShip = snap.mainShip;
    if (snap.missions) s.missions = snap.missions;
    if (snap.reports) s.reports = snap.reports;
    if (snap.items) s.items = snap.items;
    if (snap.inventory) s.inventory = snap.inventory;
    if (snap.bazaar) s.bazaar = snap.bazaar;
    if (snap.pendingContracts) s.pendingContracts = snap.pendingContracts;
    if (snap.bazaarBought) s.bazaarBought = snap.bazaarBought;
    if (snap.routes) s.routes = snap.routes;
    if (snap.extractors) s.extractors = snap.extractors;
    if (snap.components) s.components = snap.components;
    if (snap.seq != null) s.seq = snap.seq;
  },
  _applyServerSlice(r) {
    const s = this.s();
    const equip = this._snapEquip();
    if (r.credits != null) s.credits = r.credits;
    if (r.positions) s.positions = r.positions;
    if (r.avgCost) s.avgCost = r.avgCost;
    if (r.stats) {
      if (r.stats.trades != null) s.stats.trades = r.stats.trades;
      if (r.stats.biggestTrade != null) s.stats.biggestTrade = r.stats.biggestTrade;
      if (r.stats.contractsDone != null) s.stats.contractsDone = r.stats.contractsDone;
    }
    if (r.currentSystem) s.currentSystem = r.currentSystem;
    if ("travel" in r || "travelObj" in r) {
      const tr = r.travelObj || r.travel;
      s.travel = tr && typeof tr === "object" ? tr : null;
    }
    if (r.unlockedSystems) s.unlockedSystems = r.unlockedSystems;
    if (r.ships) s.ships = r.ships;
    if (r.mainShip) s.mainShip = r.mainShip;
    if (r.missions) s.missions = r.missions;
    if (r.reports) s.reports = r.reports;
    if (r.items) s.items = r.items;
    if (r.inventory) s.inventory = r.inventory;
    if (r.bazaar) s.bazaar = r.bazaar;
    if (r.pendingContracts) s.pendingContracts = r.pendingContracts;
    if (r.bazaarBought) s.bazaarBought = r.bazaarBought;
    if (r.seq != null) s.seq = r.seq;
    if (r.reputation) s.reputation = r.reputation;
    // Phase 3
    if (r.prestige) s.prestige = r.prestige;
    if (r.routes) s.routes = r.routes;
    if (r.industries) s.industries = r.industries;
    if (r.expeditions) s.expeditions = r.expeditions;
    if (r.surveyed) s.surveyed = r.surveyed;
    if (r.listings) s.listings = r.listings;
    if (r.extractors) s.extractors = r.extractors;
    if (r.components) s.components = r.components;
    if (r.lastSeenAt != null) s.lastSeenAt = r.lastSeenAt;
    if (r.stats && r.stats.peakNetWorth != null) s.stats.peakNetWorth = r.stats.peakNetWorth;
    this.repairCosmeticNames();
    this._restoreEquip(equip);
  },

  // Phase-2/3 SQL used to stamp stub names ("Battleship", "Shield uncommon").
  // Rebuild cosmetic flavor names in-memory whenever a server slice lands.
  repairCosmeticNames(state) {
    const s = state || this.s(); if (!s) return;
    if (window.Fleet) for (const sh of s.ships || []) {
      if (Fleet.isStubName(sh)) sh.name = Fleet.nameFromUid(sh.uid, sh.type, sh.mercenary);
    }
    if (window.Items) for (const it of Object.values(s.items || {})) {
      if (Items.isStubName(it)) it.name = Items.nameFromUid(it);
    }
    if (window.Extractors) for (const ex of Object.values(s.extractors || {})) {
      if (Extractors.isStubName(ex)) ex.name = Extractors.nameFromUid(ex);
    }
    if (window.Components) for (const c of Object.values(s.components || {})) {
      if (Components.isStubName(c)) c.name = Components.nameFromUid(c);
    }
  },

  // Ship accessories and extractor component-fitment are equipped CLIENT-SIDE
  // (no RPC), so app_commit forces server->ships / echoes fitment back empty and
  // reverts the equip. Snapshot the live fitment before a server slice clobbers
  // s.ships / s.extractors, then re-apply it wherever the slice cleared it. A
  // real server value wins — we only fill an emptied slot.
  //
  // NOTE: this is an in-memory patch only — it cannot survive a reload, because
  // Store.load() takes the authoritative app_bootstrap row. The actual fix is
  // server-side (docs/sql/equip_persist.sql makes app_commit persist the fitment
  // via app._merge_ships); this stays as the fallback for projects that haven't
  // pasted that file yet. Don't drop the SQL merge assuming this covers it.
  _snapEquip() {
    const s = this.s(), out = { acc: {}, comp: {} };
    for (const sh of s.ships || []) if (sh && sh.uid && Array.isArray(sh.accessories) && sh.accessories.length) out.acc[sh.uid] = sh.accessories.slice();
    const ex = s.extractors || {};
    for (const k in ex) { const e = ex[k]; if (e && Array.isArray(e.components) && e.components.length) out.comp[(e.uid) || k] = e.components.slice(); }
    return out;
  },
  _restoreEquip(snap) {
    if (!snap) return;
    const s = this.s();
    for (const sh of s.ships || []) {
      const kept = sh && snap.acc[sh.uid];
      if (kept && !(Array.isArray(sh.accessories) && sh.accessories.length)) sh.accessories = kept;
    }
    const ex = s.extractors || {};
    for (const k in ex) {
      const e = ex[k], kept = e && snap.comp[(e.uid) || k];
      if (kept && !(Array.isArray(e.components) && e.components.length)) e.components = kept;
    }
  },

  // Pull protected fields from an app_commit / app_pull response into live state.
  applyCommitState(st) {
    if (!st || typeof st !== "object") return;
    const s = this.s();
    const equip = this._snapEquip();
    if (st.currentSystem) s.currentSystem = st.currentSystem;
    s.travel = st.travel && typeof st.travel === "object" ? st.travel : null;
    if (st.unlockedSystems) s.unlockedSystems = st.unlockedSystems;
    if (st.ships) s.ships = st.ships;
    if (st.mainShip) s.mainShip = st.mainShip;
    if (st.missions) s.missions = st.missions;
    if (st.items) s.items = st.items;
    if (st.inventory) s.inventory = st.inventory;
    if (st.reports) s.reports = st.reports;
    if (st.pendingContracts) s.pendingContracts = st.pendingContracts;
    if (st.bazaarBought) s.bazaarBought = st.bazaarBought;
    if (st.reputation) s.reputation = st.reputation;
    if (st.seq != null) s.seq = st.seq;
    // Phase 3 protected economy
    if (st.credits != null) s.credits = st.credits;
    if (st.positions) s.positions = st.positions;
    if (st.avgCost) s.avgCost = st.avgCost;
    if (st.prestige) s.prestige = st.prestige;
    if (st.routes) s.routes = st.routes;
    if (st.industries) s.industries = st.industries;
    if (st.expeditions) s.expeditions = st.expeditions;
    if (st.surveyed) s.surveyed = st.surveyed;
    if (st.listings) s.listings = st.listings;
    if (st.extractors) s.extractors = st.extractors;
    if (st.components) s.components = st.components;
    if (st.lastSeenAt != null) s.lastSeenAt = st.lastSeenAt;
    if (st.stats) {
      if (st.stats.peakNetWorth != null) s.stats.peakNetWorth = st.stats.peakNetWorth;
      if (st.stats.trades != null) s.stats.trades = st.stats.trades;
      if (st.stats.biggestTrade != null) s.stats.biggestTrade = st.stats.biggestTrade;
      if (st.stats.contractsDone != null) s.stats.contractsDone = st.stats.contractsDone;
    }
    this.repairCosmeticNames();
    this._restoreEquip(equip);
  },

  // Snapshot non-stub cosmetic names before a server slice clobbers them.
  _snapCosmeticNames() {
    const s = this.s(), out = { ships: {}, items: {}, extractors: {}, components: {} };
    if (window.Fleet) for (const sh of s.ships || []) if (!Fleet.isStubName(sh)) out.ships[sh.uid] = sh.name;
    if (window.Items) for (const it of Object.values(s.items || {})) if (!Items.isStubName(it)) out.items[it.uid] = it.name;
    if (window.Extractors) for (const ex of Object.values(s.extractors || {})) if (!Extractors.isStubName(ex)) out.extractors[ex.uid] = ex.name;
    if (window.Components) for (const c of Object.values(s.components || {})) if (!Components.isStubName(c)) out.components[c.uid] = c.name;
    return out;
  },
  // Names as the RPC returned them (before repairCosmeticNames rewrites stubs).
  _snapServerCosmeticNames(r) {
    const out = { ships: {}, items: {}, extractors: {}, components: {} };
    if (!r) return out;
    if (r.ships) for (const sh of r.ships) out.ships[sh.uid] = sh.name;
    if (r.items) for (const it of Object.values(r.items)) if (it && it.uid) out.items[it.uid] = it.name;
    if (r.extractors) for (const ex of Object.values(r.extractors)) if (ex && ex.uid) out.extractors[ex.uid] = ex.name;
    if (r.components) for (const c of Object.values(r.components)) if (c && c.uid) out.components[c.uid] = c.name;
    return out;
  },
  // Re-apply client flavor ONLY when the server sent a stub (or omitted the
  // name). A real server name wins — otherwise a bought ship keeps the
  // optimistic makeShip name this session and flips on the next reload/pull.
  _restoreCosmeticNames(clientSnap, serverSnap) {
    if (!clientSnap) return;
    const s = this.s();
    const srv = serverSnap || {};
    if (window.Fleet) for (const sh of s.ships || []) {
      const kept = clientSnap.ships[sh.uid]; if (!kept) continue;
      const serverName = srv.ships ? srv.ships[sh.uid] : undefined;
      if (serverName != null && !Fleet.isStubName({ type: sh.type, name: serverName, mercenary: sh.mercenary })) continue;
      sh.name = kept;
    }
    if (window.Items) for (const it of Object.values(s.items || {})) {
      const kept = clientSnap.items[it.uid]; if (!kept) continue;
      const serverName = srv.items ? srv.items[it.uid] : undefined;
      if (serverName != null && !Items.isStubName({ kind: it.kind, rarity: it.rarity, name: serverName })) continue;
      it.name = kept;
    }
    if (window.Extractors) for (const ex of Object.values(s.extractors || {})) {
      const kept = clientSnap.extractors[ex.uid]; if (!kept) continue;
      const serverName = srv.extractors ? srv.extractors[ex.uid] : undefined;
      if (serverName != null && !Extractors.isStubName({ type: ex.type, scope: ex.scope, name: serverName })) continue;
      ex.name = kept;
    }
    if (window.Components) for (const c of Object.values(s.components || {})) {
      const kept = clientSnap.components[c.uid]; if (!kept) continue;
      const serverName = srv.components ? srv.components[c.uid] : undefined;
      if (serverName != null && !Components.isStubName({ kind: c.kind, name: serverName })) continue;
      c.name = kept;
    }
  },

  // Apply an app_pull result (same slice as RPCs + optional away recap).
  applyPull(r) {
    if (!r || !r.ok) return null;
    this._applyServerSlice(r);
    this.refreshNetWorth();
    return r.away || null;
  },
  // Push pre-action client income + board to players.state.
  // Uses SNAPSHOT fields so we don't double-apply the optimistic mutation
  // (and so bazaar offers still exist for purchase RPCs).
  async _syncSoftEconomy(snap) {
    if (!this.authoritative()) return true;
    try {
      const payload = Object.assign({}, this.s(), {
        credits: snap.credits,
        positions: snap.positions,
        avgCost: snap.avgCost,
        ships: snap.ships,
        mainShip: snap.mainShip,
        missions: snap.missions,
        reports: snap.reports,
        items: snap.items,
        inventory: snap.inventory,
        bazaar: snap.bazaar,
        pendingContracts: snap.pendingContracts,
        bazaarBought: snap.bazaarBought,
        seq: snap.seq,
        stats: Object.assign({}, this.s().stats, {
          trades: snap.stats.trades,
          biggestTrade: snap.stats.biggestTrade,
          contractsDone: snap.stats.contractsDone,
        }),
      });
      const r = await Cloud.commit(payload);
      if (r && r.ok === false) return false;
      // Don't apply fleet/board from commit here — optimistic mutation is live
      // and Phase 2 commit echoes pre-action ships. Topology only.
      if (r && r.state) {
        const st = r.state, s = this.s();
        if (st.currentSystem) s.currentSystem = st.currentSystem;
        s.travel = st.travel && typeof st.travel === "object" ? st.travel : null;
        if (st.unlockedSystems) s.unlockedSystems = st.unlockedSystems;
      }
      return true;
    } catch (e) {
      console.warn("[Economy] soft sync failed:", e);
      return false;
    }
  },

  async _withRpc(optimisticFn, rpcFn, failMsg) {
    // Serialize authoritative actions so parallel order fills / clicks can't
    // interleave snapshot → commit → trade.
    const run = async () => {
      const snap = this._snapEconomy();
      const local = optimisticFn();
      if (!local || !local.ok) return local;
      this._pending++;
      try {
        if (!(await this._syncSoftEconomy(snap))) {
          this._restoreEconomy(snap);
          return { ok: false, msg: failMsg };
        }
        const r = await rpcFn();
        if (!r || !r.ok) {
          this._restoreEconomy(snap);
          return { ok: false, msg: (r && (r.error || r.msg)) || failMsg };
        }
        // Keep optimistic flavor names (board / makeShip) only when the server
        // returned a stub — a real server name is authoritative across reloads.
        const names = this._snapCosmeticNames();
        const serverNames = this._snapServerCosmeticNames(r);
        this._applyServerSlice(r);
        this._restoreCosmeticNames(names, serverNames);
        if (r.fillPrice != null) local.price = r.fillPrice;
        if (r.cost != null) local.cost = r.cost;
        if (r.proceeds != null) local.proceeds = r.proceeds;
        if (r.tax != null) local.tax = r.tax;
        if (r.qty != null) local.qty = r.qty;
        if (r.etaMs != null) local.etaMs = r.etaMs;
        if (r.creditsGained != null) local.credits = r.creditsGained;
        if (r.contract != null) local.contract = r.contract;
        if (r.tip != null) local.tip = r.tip;
        if (r.item != null) local.item = r.item;
        if (r.mission != null) local.mission = r.mission;
        if (r.fee != null) local.fee = r.fee;
        if (r.repHit != null) local.repHit = r.repHit;
        if (r.cat != null) local.cat = r.cat;
        if (r.resolved != null) local.resolved = r.resolved;
        return local;
      } catch (e) {
        if (typeof Cloud._isMissingRpc === "function" && Cloud._isMissingRpc(e)) {
          // Phase 2 SQL not pasted yet — keep optimistic local mutation.
          console.warn("[Economy] RPC missing — local fallback:", e);
          return local;
        }
        console.warn("[Economy] rpc failed:", e);
        this._restoreEconomy(snap);
        return { ok: false, msg: failMsg };
      } finally {
        this._pending = Math.max(0, this._pending - 1);
      }
    };
    const p = this._rpcQueue.then(run, run);
    this._rpcQueue = p.catch(() => {});
    return p;
  },

  // Authoritative call without optimistic mutation (mission resolve).
  async _rpcOnly(rpcFn, failMsg) {
    const run = async () => {
      const snap = this._snapEconomy();
      this._pending++;
      try {
        if (!(await this._syncSoftEconomy(snap))) {
          return { ok: false, msg: failMsg };
        }
        const r = await rpcFn();
        if (!r || !r.ok) {
          return { ok: false, msg: (r && (r.error || r.msg)) || failMsg };
        }
        this._applyServerSlice(r);
        return r;
      } catch (e) {
        if (typeof Cloud._isMissingRpc === "function" && Cloud._isMissingRpc(e)) {
          console.warn("[Economy] RPC missing — caller should local-fallback:", e);
          return { ok: false, missing: true, msg: failMsg };
        }
        console.warn("[Economy] rpc failed:", e);
        return { ok: false, msg: failMsg };
      } finally {
        this._pending = Math.max(0, this._pending - 1);
      }
    };
    const p = this._rpcQueue.then(run, run);
    this._rpcQueue = p.catch(() => {});
    return p;
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
    if (window.Market && !Market.stocks(commId, s.currentSystem)) return 0;
    if (this.spotHere(commId) <= 0 || s.credits <= 0) return 0;
    return this._buyQtyForSpend(commId, Math.min(s.credits, this.depth()));
  },
  maxSell(commId) {
    const cat = (COMMODITIES.find(c => c.id === commId) || {}).cat;
    if (window.Senate && Senate.isBanned(commId, cat)) return 0;
    const held = this.s().positions[commId] || 0;
    if (held <= 0 || this.spotHere(commId) <= 0) return 0;
    return Math.min(held, this.sellCapQty(commId));
  },
  // Named ban toast / trade failure: "Foodstuffs has been banned due to Foodstuffs Prohibition."
  banMsg(commId) {
    const cat = (COMMODITIES.find(c => c.id === commId) || {}).cat;
    if (window.Senate) {
      const info = Senate.banInfo(commId, cat);
      if (info) return `${info.name} has been banned due to ${info.title}.`;
    }
    return "Prohibited by a senate edict.";
  },
  // Clean list of earnings-tax components (tier + any Windfall Levy that applies).
  baronTaxLines() {
    const lines = [];
    const info = this.tierInfo();
    if (info.tax > 0) lines.push({ title: `${info.title} tier tax`, rate: info.tax, kind: "tier" });
    if (window.Senate && Senate.windfallSurtax() > 0) {
      const top = SENATECFG.windfallTopN || 3;
      const ranked = (window.Barons && Barons.rank() != null)
        ? Barons.rank() <= top
        : (window.Rivals && Rivals.rank() <= top);
      if (ranked) for (const w of Senate.windfallLines()) lines.push({ title: w.title, rate: w.rate, kind: "windfall" });
    }
    return lines;
  },
  // Attach named edict lines so the trade terminal can list them (rates only —
  // tariff/price are already baked into the fill; sell tax credits stay on `tax`).
  _edictReceipt(commId, cat) {
    if (!window.Senate) return { duties: [], marketEdicts: [] };
    return { duties: Senate.tariffLines(cat), marketEdicts: Senate.priceEdictLines(commId, cat) };
  },

  // Local (guest) fill — also used as the optimistic preview when authoritative.
  _buyLocal(commId, qty) {
    const s = this.s();
    if (s.travel) return { ok: false, msg: "Can't trade in transit." };
    qty = Math.floor(qty);
    if (qty <= 0) return { ok: false, msg: "Quantity must be positive." };
    const cat = (COMMODITIES.find(c => c.id === commId) || {}).cat;
    if (window.Senate && Senate.isBanned(commId, cat)) return { ok: false, msg: this.banMsg(commId) };
    if (window.Market && !Market.stocks(commId, s.currentSystem)) {
      return { ok: false, msg: "This station doesn't stock that commodity." };
    }
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
    return Object.assign({ ok: true, qty, cost, price: avg, capped }, this._edictReceipt(commId, cat));
  },

  _sellLocal(commId, qty) {
    const s = this.s();
    if (s.travel) return { ok: false, msg: "Can't trade in transit." };
    const held = s.positions[commId] || 0;
    qty = Math.min(Math.floor(qty), held);
    if (qty <= 0) return { ok: false, msg: "Nothing to sell." };
    const cat = (COMMODITIES.find(c => c.id === commId) || {}).cat;
    if (window.Senate && Senate.isBanned(commId, cat)) return { ok: false, msg: this.banMsg(commId) };
    const capQ = this.sellCapQty(commId);                            // per-trade notional cap (credits taken ≤ depth)
    if (capQ <= 0) return { ok: false, msg: "Beyond this station's depth for your tier." };
    const capped = qty > capQ; if (capped) qty = capQ;
    const now = Date.now(), sys = s.currentSystem;
    const { spot0, p0, base } = this._quote(commId, "sell");
    const dP = spot0 * qty / this.impactDepth();                      // pressure this order removes (gentler than the cap)
    const price = base * Math.max(MARKETCFG.sellFloorFactor, 1 + p0 - dP / 2);   // average fill over the falling price
    const grossRealized = (price - (s.avgCost[commId] || 0)) * qty;
    const taxLines = this.baronTaxLines();
    const tax = grossRealized > 0 ? Math.round(grossRealized * this.baronTax()) : 0;   // Baron Tier earnings tax (on profit)
    const proceeds = price * qty - tax;                                                // keep principal + after-tax profit
    const realized = grossRealized - tax;
    s.credits += proceeds;
    s.positions[commId] = held - qty;
    if (s.positions[commId] <= 0) { s.positions[commId] = 0; s.avgCost[commId] = 0; }
    Market.addImpact(commId, sys, -dP, now);                          // your selling depresses the local price
    this._afterTrade(commId, "sell", qty, proceeds, price, realized);
    return Object.assign({ ok: true, qty, proceeds, price, realized, tax, taxLines, capped }, this._edictReceipt(commId, cat));
  },

  buy(commId, qty) {
    if (!this.authoritative()) return this._buyLocal(commId, qty);
    return this._withRpc(
      () => this._buyLocal(commId, qty),
      () => Cloud.trade("buy", commId, Math.floor(qty)),
      "Couldn't reach the exchange — try again."
    );
  },

  async sell(commId, qty) {
    if (!this.authoritative()) return this._sellLocal(commId, qty);
    const want = Math.floor(qty);
    const r = await this._withRpc(
      () => this._sellLocal(commId, want),
      () => Cloud.trade("sell", commId, want),
      "Couldn't reach the exchange — try again."
    );
    // Ghost stock: client shows industry/mission units that never landed on the
    // server ledger (local soft income while app_commit protects positions).
    // Resync from app_pull, then retry once — or clear the unsellable ghost.
    if (r && !r.ok && /nothing to sell/i.test(r.msg || "") && (this.s().positions[commId] || 0) > 0) {
      if (window.Game && Cloud.pullReady) {
        try { await Game.pullCatchUp(); } catch (e) { /* keep going */ }
        const held = this.s().positions[commId] || 0;
        if (held > 0) {
          return this._withRpc(
            () => this._sellLocal(commId, Math.min(want, held)),
            () => Cloud.trade("sell", commId, Math.min(want, held)),
            "Couldn't reach the exchange — try again."
          );
        }
      }
      // Drop the ghost so Held matches what the exchange will actually sell.
      this.s().positions[commId] = 0;
      this.s().avgCost[commId] = 0;
      this.refreshNetWorth();
      return { ok: false, msg: "Nothing to sell — that stock wasn't on the exchange ledger (cleared). New industry batches sync automatically." };
    }
    return r;
  },

  // ----- Baron Tier (prestige "ascension") -----
  tier() { return (this.s().prestige || {}).tier || 0; },
  tierInfo(t = this.tier()) { return BARON_TIERS[Util.clamp(t, 0, BARON_TIERS.length - 1)]; },
  tierTitle() { return this.tierInfo().title; },
  // Baron Tier earnings tax, plus a Senate "windfall levy" surtax that only bites
  // barons ranked in the top N of the leaderboard — being #1 paints a target.
  baronTax() {
    let tax = this.tierInfo().tax;
    if (window.Senate && Senate.windfallSurtax() > 0) {
      const top = SENATECFG.windfallTopN || 3;
      const ranked = (window.Barons && Barons.rank() != null)
        ? Barons.rank() <= top
        : (window.Rivals && Rivals.rank() <= top);
      if (ranked) tax += Senate.windfallSurtax();
    }
    return Util.clamp(tax, 0, 0.95);
  },
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

  // Customs scan on arrival: if you're carrying any illicit goods, roll a
  // seizure and confiscate a slice of one stack. Odds rise with Senate border
  // edicts and at low-tolerance systems, and fall with Syndicate standing.
  // Returns the seizure event (also emitted on the bus) or null. Reused live + offline.
  customsScan(sysId) {
    const s = this.s();
    const illicit = COMMODITIES.filter(c => c.cat === "illicit" && (s.positions[c.id] || 0) > 0);
    if (!illicit.length) return null;
    const comm = Util.pick(illicit);
    const held = s.positions[comm.id] || 0;
    const sys = SYSTEMS.find(x => x.id === sysId);
    const tol = (sys && sys.mods && sys.mods.illicit) || 1;
    const scrutiny = Util.clamp(2 - tol, CUSTOMS.scrutinyClamp[0], CUSTOMS.scrutinyClamp[1]);
    const border = window.Senate ? Senate.smuggleFailAdd() : 0;
    const shield = Math.max(0, Rep.get("syndicate")) / 100 * CUSTOMS.repShield;
    let chance = Util.clamp((CUSTOMS.base + border) * scrutiny - shield, 0, CUSTOMS.cap);
    if (window.Boosts) chance = Util.clamp(chance * (1 + Boosts.mag("customsSeize")), 0, CUSTOMS.cap);
    if (Math.random() >= chance) return null;
    const qty = Math.min(held, Math.max(1, Math.ceil(held * Util.randFloat(CUSTOMS.seize[0], CUSTOMS.seize[1]))));
    const value = Math.round(qty * this.priceHere(comm.id));
    s.positions[comm.id] = held - qty;
    if (s.positions[comm.id] <= 0) { s.positions[comm.id] = 0; s.avgCost[comm.id] = 0; }
    this.refreshNetWorth();
    const ev = { commId: comm.id, name: comm.name, qty, value, sysId, chance };
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
  _prestigeLocal() {
    const s = this.s();
    if (!this.canPrestige()) return { ok: false, msg: "Net worth too low to ascend." };
    const tier = (s.prestige.tier || 0) + 1;
    s.prestige = { tier, multiplier: 1 };          // multiplier kept for save-shape compat (unused)
    s.stats.peakNetWorth = Math.max(s.stats.peakNetWorth || 0, this.netWorth());
    Bus.emit("prestige", { tier });
    this.checkAchievements();
    return { ok: true, tier, title: this.tierTitle() };
  },
  prestige() {
    if (!this.authoritative()) return this._prestigeLocal();
    return this._withRpc(
      () => this._prestigeLocal(),
      () => Cloud.prestige(),
      "Couldn't reach the exchange — try again."
    ).then(r => {
      if (r && r.ok) {
        // Server may return title/tier; keep local emit from optimistic path.
        if (r.tier != null) r.title = r.title || this.tierTitle();
      }
      return r;
    });
  },
};

window.ACHIEVEMENTS = ACHIEVEMENTS;
window.Economy = Economy;
