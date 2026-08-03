/* stations.js — claimable space stations + auctions + production (docs/STATIONS.md).
   Guest / single-player first: all 78 non-capital stations exist as NPC entities,
   feed sector stock, and can be auctioned / owned locally. Server RPCs later.   */

const Stations = {
  byId: {},           // systemId -> station
  auctions: {},       // systemId -> auction
  access: {},         // systemId -> { playerId -> role }
  ledger: {},         // systemId -> [{at, kind, amount, note}]
  lastWarn: {},       // systemId -> stage string (comms dedupe)

  playerId() {
    if (window.Cloud && Cloud.signedIn && Cloud.signedIn() && Cloud.user) {
      return Cloud.user.id || Cloud.user.email || "player";
    }
    return "player";
  },

  tierOf(stationName) {
    if (!stationName) return "Berth";
    const parts = String(stationName).split(/\s+/);
    const suf = parts[parts.length - 1];
    return STATION_TIERS[suf] ? suf : "Berth";
  },

  tierInfo(tier) { return STATION_TIERS[tier] || STATION_TIERS.Berth; },

  // ---- build / ensure ----------------------------------------------------
  ensure() {
    if (!window.Galaxy || !Galaxy.list || !Galaxy.list.length) return;
    for (const sys of Galaxy.list) {
      if (sys.capital) continue; // capitals are not claimable stations
      if (this.byId[sys.id]) {
        // Keep name in sync if galaxy rebuild renamed (shouldn't, seed-stable).
        this.byId[sys.id].name = sys.stationName;
        this.byId[sys.id].tier = this.tierOf(sys.stationName);
        continue;
      }
      this.byId[sys.id] = this._fresh(sys);
    }
  },

  _fresh(sys) {
    const tier = this.tierOf(sys.stationName);
    return {
      systemId: sys.id,
      sectorId: sys.sectorId,
      name: sys.stationName,
      tier,
      ownerId: null,
      status: "npc",            // npc | owned | refit | cooldown
      modules: {},              // id -> level (1-based)
      reactorLevel: 0,
      treasury: 0,
      standing: STATIONCFG.standingStart,
      leaseTaxBps: 1000,
      saleTariffBps: 500,
      scrutiny: 10,             // 0–100 public
      hold: {},                 // owner production awaiting haul
      prodComm: null,           // assigned Production Hub commodity
      bays: [],                 // [{lesseeId, extractorId}]
      upkeepPaidThrough: 0,
      cooldownUntil: 0,
      refitUntil: 0,
      delivered: 0,             // units delivered this cycle (standing)
      expected: 0,
    };
  },

  get(systemId) { return this.byId[systemId] || null; },
  list() { return Object.values(this.byId); },
  claimable() { return this.list().filter(st => st.status === "npc" || st.status === "cooldown"); },
  ownedBy(pid = this.playerId()) { return this.list().filter(st => st.ownerId === pid && st.status === "owned"); },
  ownedCount(pid = this.playerId()) { return this.ownedBy(pid).length; },

  ownerCap(tierIdx) {
    if (Array.isArray(STATIONCFG.ownerCap)) {
      return STATIONCFG.ownerCap[Util.clamp(tierIdx | 0, 0, STATIONCFG.ownerCap.length - 1)] || 1;
    }
    const info = window.Economy ? Economy.tierInfo(tierIdx) : null;
    return (info && info.stations) || 1;
  },

  // ---- power / modules ---------------------------------------------------
  basePower(st) { return this.tierInfo(st.tier).power; },
  reactorPower(st) {
    const lvl = st.reactorLevel | 0;
    if (lvl <= 0) return 0;
    const row = STATIONCFG.reactor[lvl - 1];
    return row ? row.power : 0;
  },
  powerBudget(st) { return this.basePower(st) + this.reactorPower(st); },
  powerUsed(st) {
    let used = 0;
    for (const [id, lvl] of Object.entries(st.modules || {})) {
      if (id === "reactor") continue;
      const def = STATION_MODULES[id];
      if (!def || !lvl) continue;
      const p = def.power[lvl - 1];
      if (p) used += p;
    }
    return used;
  },
  powerFree(st) { return this.powerBudget(st) - this.powerUsed(st); },

  moduleValue(st) {
    let v = 0;
    for (const [id, lvl] of Object.entries(st.modules || {})) {
      const def = STATION_MODULES[id];
      if (!def) continue;
      for (let i = 0; i < lvl; i++) v += def.cost[i] || 0;
    }
    for (let i = 0; i < (st.reactorLevel | 0); i++) {
      const def = STATION_MODULES.reactor;
      v += (def.cost[i] || 0);
    }
    return v;
  },

  upkeepPerCycle(st) {
    let u = this.tierInfo(st.tier).upkeep;
    const rl = st.reactorLevel | 0;
    if (rl > 0) {
      const row = STATIONCFG.reactor[rl - 1];
      if (row) u += row.upkeep;
    }
    const hub = st.modules.production_hub | 0;
    if (hub > 0) {
      const row = STATIONCFG.prodHub[hub - 1];
      if (row) u += row.upkeep;
    }
    const ws = st.modules.workshop_annex | 0;
    if (ws > 0) {
      const row = STATIONCFG.workshop[ws - 1];
      if (row) u += row.upkeep;
    }
    return u;
  },

  canInstall(st, moduleId) {
    const def = STATION_MODULES[moduleId];
    if (!def) return { ok: false, msg: "Unknown module." };
    if (st.status === "refit") return { ok: false, msg: "Station is in refit." };
    if (st.status !== "owned") return { ok: false, msg: "You don't own this station." };
    if (st.ownerId !== this.playerId()) return { ok: false, msg: "Not your station." };

    const cur = moduleId === "reactor" ? (st.reactorLevel | 0) : (st.modules[moduleId] | 0);
    if (cur >= def.max) return { ok: false, msg: "Already at max level." };
    const next = cur + 1;
    const needPower = def.power[next - 1] || 0;
    // Reactor adds budget; other modules spend it. Check after hypothetical reactor bump.
    let budget = this.powerBudget(st);
    let used = this.powerUsed(st);
    if (moduleId === "reactor") budget += (STATIONCFG.reactor[next - 1] || {}).power || 0;
    else used += needPower;
    if (used > budget) return { ok: false, msg: `Needs ${needPower} power (${budget - this.powerUsed(st)} free).` };

    if (def.conflicts) {
      for (const c of def.conflicts) {
        if ((st.modules[c] | 0) > 0) return { ok: false, msg: `Conflicts with ${STATION_MODULES[c].name}.` };
      }
    }
    if (def.requires) {
      for (const [req, min] of Object.entries(def.requires)) {
        if ((st.modules[req] | 0) < min) return { ok: false, msg: `Requires ${STATION_MODULES[req].name} ${"I".repeat(min)}.` };
      }
    }
    // Faction locks (soft check — Rep may be missing in harness).
    if (moduleId === "customs_house" && window.Rep) {
      const ok = ["mining_combine", "free_trade", "agri_collective"].some(f => Rep.get(f) >= 0);
      if (!ok) return { ok: false, msg: "Needs Neutral+ with a lawful faction." };
    }
    if (moduleId === "black_market" && window.Rep) {
      if (Rep.get("syndicate") < 25) return { ok: false, msg: "Needs Syndicate ≥ Friendly." };
    }
    const cost = def.cost[next - 1] || 0;
    const s = window.Game && Game.state;
    if (s && s.credits < cost) return { ok: false, msg: "Not enough credits." };
    return { ok: true, cost, next };
  },

  install(systemId, moduleId) {
    const st = this.get(systemId);
    if (!st) return { ok: false, msg: "No station." };
    const check = this.canInstall(st, moduleId);
    if (!check.ok) return check;
    const s = Game.state;
    s.credits -= check.cost;
    if (moduleId === "reactor") st.reactorLevel = check.next;
    else st.modules[moduleId] = check.next;
    this._ledger(st, -check.cost, "install", `${STATION_MODULES[moduleId].name} ${"I".repeat(check.next)}`);
    if (window.Game) Game.requestSave();
    return { ok: true, level: check.next, cost: check.cost };
  },

  uninstall(systemId, moduleId) {
    const st = this.get(systemId);
    if (!st) return { ok: false, msg: "No station." };
    if (st.ownerId !== this.playerId() || st.status !== "owned") return { ok: false, msg: "Not your station." };
    const cur = moduleId === "reactor" ? (st.reactorLevel | 0) : (st.modules[moduleId] | 0);
    if (cur <= 0) return { ok: false, msg: "Not installed." };
    const def = STATION_MODULES[moduleId];
    let refund = 0;
    for (let i = 0; i < cur; i++) refund += Math.floor((def.cost[i] || 0) * 0.5);
    if (moduleId === "reactor") st.reactorLevel = 0;
    else delete st.modules[moduleId];
    // Drop dependent modules (Refinery needs Prod Hub ≥ II).
    if (moduleId === "production_hub" && (st.modules.production_hub | 0) < 2) delete st.modules.refinery;
    Game.state.credits += refund;
    st.status = "refit";
    st.refitUntil = Date.now() + STATIONCFG.refitMs;
    this._ledger(st, refund, "uninstall", `${def.name} refund`);
    if (window.Game) Game.requestSave();
    return { ok: true, refund };
  },

  // ---- Production Hub ----------------------------------------------------
  setProduction(systemId, commId) {
    const st = this.get(systemId);
    if (!st || st.ownerId !== this.playerId() || st.status !== "owned")
      return { ok: false, msg: "Not your station." };
    if (!(st.modules.production_hub | 0)) return { ok: false, msg: "Install a Production Hub first." };
    const sys = Galaxy.get(systemId);
    if (!sys) return { ok: false, msg: "Unknown system." };
    const c = COMMODITIES.find(x => x.id === commId);
    if (!c || c.craftOnly || c.rarity === "exotic") return { ok: false, msg: "Can't produce that." };
    // System supports any cat where mods[cat] < 1.0
    if ((sys.mods[c.cat] ?? 1) >= 1.0) return { ok: false, msg: "This system doesn't produce that category." };
    st.prodComm = commId;
    st.status = "refit";
    st.refitUntil = Date.now() + Math.floor(STATIONCFG.refitMs / 2); // retooling < full refit
    if (window.Game) Game.requestSave();
    return { ok: true };
  },

  setLeaseTax(systemId, bps) {
    const st = this.get(systemId);
    if (!st || st.ownerId !== this.playerId()) return { ok: false, msg: "Not your station." };
    st.leaseTaxBps = Util.clamp(Math.round(+bps || 0), 0, 4000);
    if (window.Game) Game.requestSave();
    return { ok: true, leaseTaxBps: st.leaseTaxBps };
  },

  setSaleTariff(systemId, bps) {
    const st = this.get(systemId);
    if (!st || st.ownerId !== this.playerId()) return { ok: false, msg: "Not your station." };
    st.saleTariffBps = Util.clamp(Math.round(+bps || 0), 0, 1500);
    if (window.Game) Game.requestSave();
    return { ok: true, saleTariffBps: st.saleTariffBps };
  },

  setScrutiny(systemId, pct) {
    const st = this.get(systemId);
    if (!st || st.ownerId !== this.playerId()) return { ok: false, msg: "Not your station." };
    if (!(st.modules.customs_house | 0)) return { ok: false, msg: "Needs a Customs House." };
    st.scrutiny = Util.clamp(Math.round(+pct || 0), 0, 100);
    if (window.Game) Game.requestSave();
    return { ok: true, scrutiny: st.scrutiny };
  },

  produceable(systemId) {
    const sys = Galaxy.get(systemId);
    if (!sys) return [];
    return COMMODITIES.filter(c => !c.craftOnly && c.rarity !== "exotic" && (sys.mods[c.cat] ?? 1) < 1.0);
  },

  // Owner Production Hub output → station hold (must haul to capital).
  _playerProduce(st, hourIndex) {
    if (st.status !== "owned" && st.status !== "refit") return 0;
    if (st.status === "refit") return 0;
    const hub = st.modules.production_hub | 0;
    if (!hub || !st.prodComm) return 0;
    const row = STATIONCFG.prodHub[hub - 1];
    if (!row) return 0;
    let yield_ = row.yield;
    // Soft extractor bonus if the owner parked one (reuse Extractors when present).
    if (window.Extractors && window.Game) {
      // ponytail: no bay→extractor wiring yet; flat +10% if any extractor owned
      if (Object.keys(Game.state.extractors || {}).length) yield_ = Math.round(yield_ * 1.1);
    }
    st.hold[st.prodComm] = (st.hold[st.prodComm] | 0) + yield_;
    st.expected = Math.round(STATIONCFG.expectedDeliveryBase * hub * (1 + this.tierInfo(st.tier).rank * 0.15));
    return yield_;
  },

  // Haul station hold → sell on the sector capital exchange (owner action).
  deliverToExchange(systemId, commId, qty) {
    const st = this.get(systemId);
    if (!st || st.ownerId !== this.playerId()) return { ok: false, msg: "Not your station." };
    const s = Game.state;
    if (s.travel) return { ok: false, msg: "Can't deliver in transit." };
    const sec = Galaxy.sector(st.sectorId);
    if (!sec || s.currentSystem !== sec.capital) {
      const cap = sec && Galaxy.get(sec.capital);
      return { ok: false, msg: `Dock at ${cap ? cap.name : "the capital"} to deliver.` };
    }
    qty = Math.min(Math.floor(qty), st.hold[commId] | 0);
    if (qty <= 0) return { ok: false, msg: "Nothing to deliver." };
    const price = Economy.sellPrice(commId);
    const proceeds = price * qty;
    st.hold[commId] -= qty;
    s.credits += proceeds;
    Stock.put(st.sectorId, commId, qty);
    st.delivered = (st.delivered | 0) + qty;
    this._ledger(st, proceeds, "delivery", `${qty}× ${commId}`);
    Bus.emit("trade", { side: "sell", commId, qty, price });
    if (window.Game) Game.requestSave();
    return { ok: true, qty, proceeds, price };
  },
  // Alias used by UI / harness.
  deliver(systemId, commId, qty) { return this.deliverToExchange(systemId, commId, qty); },

  withdraw(systemId, amount) {
    const st = this.get(systemId);
    if (!st || st.ownerId !== this.playerId()) return { ok: false, msg: "Not your station." };
    amount = Math.floor(+amount || 0);
    if (amount <= 0 || amount > st.treasury) return { ok: false, msg: "Invalid amount." };
    st.treasury -= amount;
    Game.state.credits += amount;
    this._ledger(st, -amount, "withdraw", "treasury");
    if (window.Game) Game.requestSave();
    return { ok: true, amount };
  },

  // ---- Auctions ----------------------------------------------------------
  openingBid(st) {
    const rank = this.tierInfo(st.tier).rank;
    const raw = STATIONCFG.openingBase + rank * STATIONCFG.openingPerTier
      + this.moduleValue(st) * STATIONCFG.moduleValueFrac;
    return Math.max(STATIONCFG.minBidIncrement, Math.round(raw / 50000) * 50000);
  },

  getAuction(systemId) { return this.auctions[systemId] || null; },

  openAuction(systemId, bid) {
    const st = this.get(systemId);
    if (!st) return { ok: false, msg: "No station." };
    if (st.status === "owned") return { ok: false, msg: "Already owned." };
    if (st.status === "cooldown" && Date.now() < st.cooldownUntil)
      return { ok: false, msg: "Station is cooling down after a revolt." };
    if (this.auctions[systemId] && this.auctions[systemId].status === "open")
      return { ok: false, msg: "Auction already open." };
    const pid = this.playerId();
    const tier = window.Economy ? Economy.tier() : 0;
    if (this.ownedCount(pid) >= this.ownerCap(tier))
      return { ok: false, msg: "Station ownership cap reached for your tier." };
    const min = this.openingBid(st);
    bid = Math.floor(+bid || min);
    if (bid < min) return { ok: false, msg: `Opening bid is ${Util.credits(min)}.` };
    const s = Game.state;
    const escrowed = this.escrowTotal(pid);
    if (s.credits - escrowed < bid) return { ok: false, msg: "Not enough free credits (escrow counts)." };
    // Escrow: deduct immediately.
    s.credits -= bid;
    const now = Date.now();
    // Dev fast-news shortens the 72h window so auctions are testable in-session.
    const dur = (CONFIG.fastNews ? 2 * 60 * 1000 : STATIONCFG.auctionHours * 3600 * 1000);
    this.auctions[systemId] = {
      systemId,
      status: "open",
      opensAt: now,
      closesAt: now + dur,
      highBid: bid,
      highBidder: pid,
      bids: [{ playerId: pid, amount: bid, at: now }],
    };
    if (st.status === "cooldown") st.status = "npc";
    if (window.Game) Game.requestSave();
    if (window.UI && UI.toast) UI.toast(`Auction opened on ${st.name} at ${Util.credits(bid)}.`, "ok");
    return { ok: true, auction: this.auctions[systemId] };
  },

  bid(systemId, amount) {
    const auc = this.auctions[systemId];
    if (!auc || auc.status !== "open") return { ok: false, msg: "No open auction." };
    const st = this.get(systemId);
    const pid = this.playerId();
    const tier = window.Economy ? Economy.tier() : 0;
    // Cap check (also re-checked at close).
    if (this.ownedCount(pid) >= this.ownerCap(tier) && auc.highBidder !== pid)
      return { ok: false, msg: "Station ownership cap reached for your tier." };
    amount = Math.floor(+amount || 0);
    const min = auc.highBid + STATIONCFG.minBidIncrement;
    if (amount < min) return { ok: false, msg: `Bid at least ${Util.credits(min)}.` };
    const s = Game.state;
    // If we're already high bidder, only need the delta escrowed.
    let need = amount;
    if (auc.highBidder === pid) need = amount - auc.highBid;
    const escrowed = this.escrowTotal(pid) - (auc.highBidder === pid ? auc.highBid : 0);
    if (s.credits - escrowed < need) return { ok: false, msg: "Not enough free credits." };

    // Refund previous high bidder (if other player — guest single-player: usually us or NPC).
    if (auc.highBidder && auc.highBidder !== pid) {
      // Guest mode: only one real player; treat other bidders as NPC (credits burned/sunk).
      // If somehow same save: refund into credits when highBidder === "player" handled below.
      if (auc.highBidder === "player" || auc.highBidder === this.playerId()) {
        s.credits += auc.highBid;
      }
    } else if (auc.highBidder === pid) {
      // Raising own bid: pay the delta only (need already computed).
    }

    if (auc.highBidder === pid) {
      s.credits -= need;
    } else {
      s.credits -= amount;
    }

    const now = Date.now();
    auc.highBid = amount;
    auc.highBidder = pid;
    auc.bids.push({ playerId: pid, amount, at: now });
    // Anti-snipe
    if (auc.closesAt - now < STATIONCFG.antiSnipeMs) {
      auc.closesAt = now + STATIONCFG.antiSnipeMs;
    }
    if (window.Game) Game.requestSave();
    return { ok: true, auction: auc };
  },

  escrowTotal(pid = this.playerId()) {
    let n = 0;
    for (const auc of Object.values(this.auctions)) {
      if (auc.status === "open" && auc.highBidder === pid) n += auc.highBid;
    }
    return n;
  },

  // Credits currently locked in bids — counted in net worth.
  escrowForNetWorth(pid = this.playerId()) { return this.escrowTotal(pid); },

  _closeAuction(systemId, now = Date.now()) {
    const auc = this.auctions[systemId];
    if (!auc || auc.status !== "open") return;
    if (now < auc.closesAt) return;
    const st = this.get(systemId);
    const winner = auc.highBidder;
    const tier = window.Economy ? Economy.tier() : 0;
    // Cap re-check at close — forfeit to next eligible (guest: just forfeit to NPC).
    if (winner === this.playerId() && this.ownedCount(winner) >= this.ownerCap(tier)) {
      Game.state.credits += auc.highBid; // refund
      auc.status = "forfeit";
      return;
    }
    if (winner === this.playerId()) {
      st.ownerId = winner;
      st.status = "owned";
      st.standing = STATIONCFG.standingStart;
      st.delivered = 0;
      // Winning credits sunk to controlling faction (credit sink — keep it).
      this._ledger(st, auc.highBid, "auction_win", "paid to controlling faction");
      auc.status = "closed";
      if (window.UI && UI.toast) UI.toast(`You won ${st.name} for ${Util.credits(auc.highBid)}.`, "ok");
      if (window.Story && Story.inbox) {
        // Soft comms notice without depending on Story internals.
      }
    } else {
      // NPC / unknown winner — refund local player if they were outbid already (already refunded).
      auc.status = "closed";
      st.status = "npc";
      st.ownerId = null;
    }
  },

  // ---- NPC production baskets → sector stock -----------------------------
  // Categories where system mod < 1.0 are producers. Reroll 2–3 commodities hourly.
  _npcBasket(st, hourIndex) {
    const sys = Galaxy.get(st.systemId);
    if (!sys) return [];
    let cats = Object.keys(sys.mods || {}).filter(c => (sys.mods[c] ?? 1) < 1.0);
    if (!cats.length) {
      const spec = Stock.specialty(st.sectorId);
      if (spec) cats = [spec];
    }
    // Prefer understocked commodities in the producing cats so NPC supply
    // hunts shortages instead of stacking already-full specialty shelves.
    let pool = COMMODITIES.filter(c => !c.craftOnly && c.rarity !== "exotic" && cats.includes(c.cat));
    if (!pool.length) {
      // Last resort: anything the sector is short on.
      pool = COMMODITIES.filter(c => !c.craftOnly && c.rarity !== "exotic" && Stock.ratio(st.sectorId, c.id) < 0.5);
    }
    if (!pool.length) return [];
    pool = pool.slice().sort((a, b) => Stock.ratio(st.sectorId, a.id) - Stock.ratio(st.sectorId, b.id));
    const s = Market._seed([st.systemId, "basket", String(hourIndex)]);
    const n = 2 + (Market._u01(s, 0) < 0.45 ? 1 : 0);
    // Bias toward the scarcest half of the pool, with a little seed jitter.
    const picks = [];
    const used = new Set();
    const focus = pool.slice(0, Math.max(n, Math.ceil(pool.length * 0.6)));
    for (let i = 0; i < n && picks.length < focus.length; i++) {
      const idx = Math.floor(Market._u01(s, i + 1) * focus.length) % focus.length;
      const c = focus[idx];
      if (used.has(c.id)) continue;
      used.add(c.id);
      picks.push(c);
    }
    if (!picks.length) picks.push(pool[0]);
    return picks;
  },

  npcProduceHour(hourIndex) {
    let produced = 0;
    for (const st of this.list()) {
      if (st.status === "owned" || st.status === "refit") {
        // Player hubs don't feed sector stock directly.
        this._playerProduce(st, hourIndex);
        continue;
      }
      if (st.status === "cooldown") continue;
      const basket = this._npcBasket(st, hourIndex);
      for (const c of basket) {
        const rarity = c.rarity || "common";
        const base = STOCKCFG.npcUnits[rarity] || 0;
        const mult = Stock.npcOutputMult(st.sectorId, c.id);
        // Cheaper mods → slightly higher output.
        const sys = Galaxy.get(st.systemId);
        const mod = sys ? (sys.mods[c.cat] ?? 1) : 1;
        const cheapBonus = mod < 1 ? (1 + (1 - mod)) : 1;
        const out = Math.max(1, Math.round(base * mult * cheapBonus));
        Stock.put(st.sectorId, c.id, out);
        produced += out;
      }
    }
    return produced;
  },

  // ---- Standing / revolt (after stock hour) ------------------------------
  afterStockHour(hourIndex) {
    const now = Date.now();
    // Resolve due auctions first.
    for (const id of Object.keys(this.auctions)) this._closeAuction(id, now);

    for (const st of this.list()) {
      // Clear finished refits / cooldowns.
      if (st.status === "refit" && now >= st.refitUntil) st.status = st.ownerId ? "owned" : "npc";
      if (st.status === "cooldown" && now >= st.cooldownUntil) st.status = "npc";

      if (st.status !== "owned") continue;

      // Suspend standing decay during declared refit (open question → yes).
      if (st.status === "refit") { st.delivered = 0; continue; }

      let standing = st.standing;
      const expected = st.expected || STATIONCFG.expectedDeliveryBase;
      const del = st.delivered | 0;
      if (del >= expected) standing += 4;
      else if (del > 0) standing += 1;
      else standing -= 5;

      const hub = st.modules.production_hub | 0;
      if (!hub || !st.prodComm) standing -= 3;
      if ((st.leaseTaxBps | 0) > STATIONCFG.fairLeaseTaxBps) standing -= 2;

      // Upkeep: pull from treasury, then owner credits; unpaid hurts standing.
      const upkeep = this.upkeepPerCycle(st);
      if (st.treasury >= upkeep) {
        st.treasury -= upkeep;
        this._ledger(st, -upkeep, "upkeep", "treasury");
      } else if (st.ownerId === this.playerId() && Game.state.credits >= upkeep) {
        Game.state.credits -= upkeep;
        this._ledger(st, -upkeep, "upkeep", "owner");
      } else {
        standing -= 6;
        this._ledger(st, 0, "upkeep_missed", String(upkeep));
      }

      st.standing = Util.clamp(standing, 0, 100);
      st.delivered = 0;

      const sentiment = (window.Stock && Stock.sentiment[st.sectorId]) || STATIONCFG.sentimentStart;
      this._warnStages(st, sentiment);
      this._maybeRevolt(st, sentiment, hourIndex);
    }
  },

  _warnStages(st, sentiment) {
    let stage = null;
    if (st.standing < 20) stage = "strike";
    else if (st.standing < 35 && sentiment < 40) stage = "protests";
    else if (st.standing < 45) stage = "unrest";
    if (!stage || this.lastWarn[st.systemId] === stage) return;
    this.lastWarn[st.systemId] = stage;
    const msg = {
      unrest: `Unrest at ${st.name}: standing is slipping. Deliver goods to the capital.`,
      protests: `Protests at ${st.name}: revolt rolls have begun.`,
      strike: `General strike at ${st.name}: production halved, revolt risk doubled.`,
    }[stage];
    if (window.UI && UI.toast) UI.toast(msg, "warn", 8000);
    if (window.Bus) Bus.emit("news", { text: msg, kind: "station" });
  },

  _maybeRevolt(st, sentiment, hourIndex) {
    if (sentiment >= STATIONCFG.revoltSentiment || st.standing >= STATIONCFG.revoltStanding) return;
    let chance = (1 - sentiment / 100) * (1 - st.standing / 100) * STATIONCFG.revoltRate;
    if (st.standing < 20) chance *= 2;
    chance = Util.clamp(chance, 0, 0.35);
    const s = Market._seed([st.systemId, "revolt", String(hourIndex)]);
    if (Market._u01(s, 0) > chance) return;
    // Revolt!
    st.ownerId = null;
    st.status = "cooldown";
    st.cooldownUntil = Date.now() + STATIONCFG.cooldownMs;
    st.treasury = 0; // forfeited to faction
    st.hold = {};    // ponytail: docked lessee goods should return; guest has none yet
    st.standing = STATIONCFG.standingStart;
    st.prodComm = null;
    // Modules persist — including reactor.
    delete this.auctions[st.systemId];
    this.lastWarn[st.systemId] = "revolt";
    if (window.UI && UI.toast) UI.toast(`Revolt! You lost ${st.name}. Modules remain for the next owner.`, "bad", 10000);
  },

  // ---- Workshop Annex discount (option 3: stochastic per unit) -----------
  workshopMatChance(systemId) {
    const st = this.get(systemId);
    if (!st || !(st.modules.workshop_annex | 0)) return 0;
    if (st.status === "refit") return 0;
    const row = STATIONCFG.workshop[(st.modules.workshop_annex) - 1];
    return row ? row.mat : 0;
  },
  workshopTimeFactor(systemId) {
    const st = this.get(systemId);
    if (!st || !(st.modules.workshop_annex | 0)) return 1;
    if (st.status === "refit") return 1;
    const row = STATIONCFG.workshop[(st.modules.workshop_annex) - 1];
    return row ? (1 - row.time) : 1;
  },

  // Customs scrutiny override for a system (null = baseline).
  scrutinyFor(systemId) {
    const st = this.get(systemId);
    if (!st) return null;
    if (st.modules.free_port) return Math.max(0, (CUSTOMS.base || 0.1) * 0.35);
    if (st.modules.customs_house) return Util.clamp((st.scrutiny | 0) / 100, 0, CUSTOMS.cap || 0.85);
    return null;
  },

  // ---- tick (auctions; stock hour is driven by Stock.tick) ---------------
  tick(now = Date.now()) {
    this.ensure();
    for (const id of Object.keys(this.auctions)) this._closeAuction(id, now);
    for (const st of this.list()) {
      if (st.status === "refit" && now >= st.refitUntil) st.status = st.ownerId ? "owned" : "npc";
      if (st.status === "cooldown" && now >= st.cooldownUntil) st.status = "npc";
    }
  },

  _ledger(st, amount, kind, note) {
    const id = st.systemId;
    if (!this.ledger[id]) this.ledger[id] = [];
    this.ledger[id].unshift({ at: Date.now(), kind, amount, note: note || "" });
    if (this.ledger[id].length > 40) this.ledger[id].length = 40;
  },

  serialize() {
    return {
      byId: this.byId,
      auctions: this.auctions,
      access: this.access,
      ledger: this.ledger,
      lastWarn: this.lastWarn,
    };
  },

  hydrate(snap) {
    if (!snap || typeof snap !== "object") { this.ensure(); return; }
    this.byId = (snap.byId && typeof snap.byId === "object") ? snap.byId : {};
    this.auctions = (snap.auctions && typeof snap.auctions === "object") ? snap.auctions : {};
    this.access = (snap.access && typeof snap.access === "object") ? snap.access : {};
    this.ledger = (snap.ledger && typeof snap.ledger === "object") ? snap.ledger : {};
    this.lastWarn = (snap.lastWarn && typeof snap.lastWarn === "object") ? snap.lastWarn : {};
    // Coerce each station at the trust boundary.
    for (const [id, st] of Object.entries(this.byId)) {
      if (!st || typeof st !== "object") { delete this.byId[id]; continue; }
      st.systemId = id;
      st.modules = (st.modules && typeof st.modules === "object") ? st.modules : {};
      st.hold = (st.hold && typeof st.hold === "object") ? st.hold : {};
      st.reactorLevel = Util.clamp(st.reactorLevel | 0, 0, 5);
      st.standing = Util.clamp(+st.standing || STATIONCFG.standingStart, 0, 100);
      st.treasury = Math.max(0, Math.floor(+st.treasury || 0));
      st.leaseTaxBps = Util.clamp(st.leaseTaxBps | 0, 0, 4000);
      st.saleTariffBps = Util.clamp(st.saleTariffBps | 0, 0, 1500);
      st.scrutiny = Util.clamp(st.scrutiny | 0, 0, 100);
      if (!["npc", "owned", "refit", "cooldown"].includes(st.status)) st.status = st.ownerId ? "owned" : "npc";
    }
    this.ensure();
  },
};

window.Stations = Stations;
