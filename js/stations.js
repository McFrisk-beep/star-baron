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
      hall: [],                 // Exchange Hall listings
      contracts: [],            // Contract Office haul posts
      contractStats: { filled: 0, expired: 0 },
      impoundHold: {},          // Customs House seized cargo { commId: qty }
      impoundClaims: [],        // [{id, commId, qty, value, fromId, ransom}]
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

  // "refit" is an owner-held *offline* state: services and production stop, but
  // the owner keeps the station and its console. Only npc/cooldown are ownerless.
  ownerHeld(st) { return !!st && (st.status === "owned" || st.status === "refit"); },
  refitLeft(st) {
    return st && st.status === "refit" ? Math.max(0, (+st.refitUntil || 0) - Date.now()) : 0;
  },

  // Downtime a *pending* change would cost, in ms (0 = none). One place for the
  // rule so the confirm prompt and the change itself can never disagree.
  retoolCost(st, commId) {
    return st && st.prodComm && st.prodComm !== commId ? Math.floor(STATIONCFG.refitMs / 2) : 0;
  },
  uninstallCost() { return STATIONCFG.refitMs; },

  ownedBy(pid = this.playerId()) { return this.list().filter(st => st.ownerId === pid && this.ownerHeld(st)); },
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
    if (moduleId === "production_hub") this.syncBays(st);
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
    if (moduleId === "production_hub") {
      delete st.modules.refinery;
      this.syncBays(st); // releases extractors as bay count → 0
      st.prodComm = null;
    } else if ((st.modules.production_hub | 0) < 2) {
      delete st.modules.refinery;
    }
    if (moduleId === "exchange_hall") {
      for (const l of st.hall || []) this._restoreListable(l, l.sellerId);
      st.hall = [];
    }
    if (moduleId === "contract_office") {
      for (const c of (st.contracts || []).filter(x => x.status === "open")) this._refundHaul(st, c);
      st.contracts = (st.contracts || []).filter(x => x.status === "active");
    }
    if (moduleId === "customs_house") {
      st.impoundHold = {};
      st.impoundClaims = [];
    }
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
    if (!st || st.ownerId !== this.playerId() || !this.ownerHeld(st))
      return { ok: false, msg: "Not your station." };
    if (!(st.modules.production_hub | 0)) return { ok: false, msg: "Install a Production Hub first." };
    const sys = Galaxy.get(systemId);
    if (!sys) return { ok: false, msg: "Unknown system." };
    const c = COMMODITIES.find(x => x.id === commId);
    if (!c || c.craftOnly || c.rarity === "exotic") return { ok: false, msg: "Can't produce that." };
    // System supports any cat where mods[cat] < 1.0
    if ((sys.mods[c.cat] ?? 1) >= 1.0) return { ok: false, msg: "This system doesn't produce that category." };
    // docs/STATIONS.md §8: changing the commodity costs retooling downtime.
    // An idle hub has nothing to retool from, so first assignment starts clean.
    const cost = this.retoolCost(st, commId);
    const retool = cost > 0;
    st.prodComm = commId;
    if (retool) {
      st.status = "refit";
      st.refitUntil = Date.now() + cost; // retooling < full refit
    }
    if (window.Game) Game.requestSave();
    return { ok: true, retool, refitUntil: retool ? st.refitUntil : 0 };
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

  // ---- Access / docking (docs/STATIONS.md §12–13) -------------------------
  roleOf(systemId, pid = this.playerId()) {
    const st = this.get(systemId);
    if (!st) return "guest";
    if (st.ownerId === pid) return "owner";
    const map = this.access[systemId] || {};
    const r = map[pid];
    if (r === "partner" || r === "allied" || r === "barred") return r;
    return "guest";
  },

  setRole(systemId, pid, role) {
    const st = this.get(systemId);
    if (!st || st.ownerId !== this.playerId()) return { ok: false, msg: "Not your station." };
    pid = String(pid || "").trim();
    if (!pid || pid === this.playerId()) return { ok: false, msg: "Invalid player." };
    if (!["allied", "guest", "barred", "partner"].includes(role))
      return { ok: false, msg: "Unknown role." };
    if (!this.access[systemId]) this.access[systemId] = {};
    if (role === "guest") delete this.access[systemId][pid];
    else this.access[systemId][pid] = role;
    if (window.Game) Game.requestSave();
    return { ok: true, role };
  },

  canDock(systemId) {
    const st = this.get(systemId);
    if (!st) return { ok: false, msg: "No station here." };
    if (this.roleOf(systemId) === "barred") return { ok: false, msg: "Docking denied — you are barred." };
    if (st.status === "cooldown") return { ok: false, msg: "Station is offline after a revolt." };
    return { ok: true, st };
  },

  // True when sysId is a sector capital (full hub services).
  isCapital(systemId) {
    if (!systemId) return false;
    const g = window.Galaxy && Galaxy.get(systemId);
    if (g) return !!g.capital;
    return !!(typeof SYSTEMS !== "undefined" && SYSTEMS.some(s => s.id === systemId));
  },

  // Hub / nav availability at the player's current dock.
  // Capitals: full services. Claimable stations: gate on ownership + modules.
  // Modules persist through revolt but stay dormant while status is npc.
  hubAccess(page, systemId) {
    const s = window.Game && Game.state;
    const sysId = systemId || (s && s.currentSystem);
    if (!sysId || !page) return { ok: true };
    // Always-on: navigation, personal fleet, galactic meta.
    if (/^(starmap|systems|barons|comms|ach|hub|senate|fleet|assets)$/.test(page)) return { ok: true };

    if (this.isCapital(sysId)) {
      if (page === "stations") {
        return this.ownedCount() > 0
          ? { ok: true }
          : { ok: false, reason: "You don't own a station yet" };
      }
      return { ok: true };
    }

    const st = this.get(sysId);
    if (!st) return { ok: false, reason: "No station services here" };
    const owned = this.ownerHeld(st);
    const mine = owned && st.ownerId === this.playerId();
    const mod = id => (st.modules && st.modules[id]) | 0;

    // The owner's console stays reachable through a refit — that's where the
    // countdown lives, and where they cancel/reassign what caused it.
    if (page === "stations") return mine ? { ok: true } : { ok: false, reason: owned ? "Not your station" : "Station is NPC-held" };
    if (st.status === "refit") {
      return { ok: false, reason: `Refit in progress — back online in ${Util.duration(this.refitLeft(st))}` };
    }

    if (!owned) {
      const npcReason = {
        exchange: "Commodity exchange is at sector capitals",
        bazaar: "No station market while NPC-held",
        industries: "Foundries run from capital hubs",
        workshop: "Modules dormant while NPC-held",
        stations: "Station is NPC-held",
      };
      return { ok: false, reason: npcReason[page] || "Unavailable at this dock" };
    }

    switch (page) {
      case "exchange":
        return { ok: false, reason: "Commodity exchange is at sector capitals" };
      case "bazaar":
        if (mod("charter_office") || mod("contract_office") || mod("black_market") || mod("exchange_hall"))
          return { ok: true };
        return { ok: false, reason: "Needs Exchange Hall, Charter, or Contract Office" };
      case "industries":
        return { ok: false, reason: "Foundries run from capital hubs" };
      case "workshop":
        if (mod("workshop_annex") && mine) return { ok: true };
        if (mod("workshop_annex")) return { ok: false, reason: "Owner's Workshop Annex only" };
        return { ok: false, reason: "No Workshop Annex installed" };
      default:
        return { ok: true };
    }
  },

  // Compact services strip for Star Map / System Hubs (module presence).
  serviceList(systemId) {
    if (this.isCapital(systemId)) {
      return [
        { id: "exchange", label: "Commodity Exchange", ok: true },
        { id: "bazaar", label: "Bazaar", ok: true },
        { id: "workshop", label: "Workshop", ok: true },
        { id: "fleet", label: "Fleet Bay", ok: true },
      ];
    }
    const st = this.get(systemId);
    if (!st) return [];
    const refit = st.status === "refit";
    const owned = this.ownerHeld(st);
    const mod = id => (st.modules && st.modules[id]) | 0;
    const row = (id, label, need) => {
      if (!owned) return { id, label, ok: false, reason: "NPC-held — modules dormant" };
      if (need && !mod(need)) return { id, label, ok: false, reason: "Not installed" };
      if (refit) return { id, label, ok: false, reason: `Refit — back online in ${Util.duration(this.refitLeft(st))}` };
      return { id, label, ok: true };
    };
    return [
      { id: "exchange", label: "Commodity Exchange", ok: false, reason: "Capitals only" },
      row("exchange_hall", "Exchange Hall", "exchange_hall"),
      row("production_hub", "Production Hub", "production_hub"),
      row("workshop_annex", "Workshop Annex", "workshop_annex"),
      row("contract_office", "Contract Office", "contract_office"),
      row("charter_office", "Charter Office", "charter_office"),
      row("dry_dock", "Dry Dock", "dry_dock"),
      row("customs_house", "Customs House", "customs_house"),
      row("free_port", "Free Port", "free_port"),
      row("black_market", "Black Market", "black_market"),
      row("warehouse", "Warehouse", "warehouse"),
      row("survey_relay", "Survey Relay", "survey_relay"),
      row("lane_buoy", "Lane Buoy", "lane_buoy"),
    ];
  },

  customsExempt(systemId, pid = this.playerId()) {
    const st = this.get(systemId);
    if (!st || !(st.modules.customs_house | 0)) return false;
    const role = this.roleOf(systemId, pid);
    return role === "owner" || role === "partner" || role === "allied";
  },

  // Public scrutiny readout shown before undock (never hidden).
  publicScrutiny(systemId) {
    const st = this.get(systemId);
    if (!st) return null;
    if (st.modules.free_port | 0) {
      const pct = Math.round((CUSTOMS.base || 0.1) * (STATIONCFG.freePortScrutinyMult || 0.35) * 100);
      return { pct, label: "Free Port", flag: "open", chanceHint: pct };
    }
    if (st.modules.customs_house | 0) {
      const pct = Util.clamp(st.scrutiny | 0, 0, Math.round((CUSTOMS.cap || 0.85) * 100));
      return { pct, label: "Clean", flag: "clean", chanceHint: pct };
    }
    return { pct: null, label: "Open dock", flag: "neutral", chanceHint: null };
  },

  // ---- Exchange Hall (docs/STATIONS.md §9) --------------------------------
  hasHall(st) {
    return !!(st && (st.modules.exchange_hall | 0) && st.status === "owned");
  },

  // Visitors must be docked at the station (non-capital docking is live).
  canUseHall(systemId) {
    const st = this.get(systemId);
    if (st && st.status === "refit" && (st.modules.exchange_hall | 0))
      return { ok: false, msg: `Station is in refit — ${Util.duration(this.refitLeft(st))} left.` };
    if (!this.hasHall(st)) return { ok: false, msg: "No Exchange Hall here." };
    const s = window.Game && Game.state;
    if (!s || s.travel) return { ok: false, msg: "Can't trade in transit." };
    if (st.ownerId === this.playerId()) return { ok: true, st };
    if (s.currentSystem === systemId) return { ok: true, st };
    return { ok: false, msg: "Dock at this station to use the Exchange Hall." };
  },

  hallListings(systemId) {
    const st = this.get(systemId);
    return (st && Array.isArray(st.hall)) ? st.hall : [];
  },

  _listingValue(listing) {
    if (!listing) return 0;
    if (listing.value != null) return +listing.value || 0;
    const p = listing.payload;
    if (!p) return 0;
    if (p.value != null) return +p.value || 0;
    if (listing.kind === "ship" && window.Fleet) {
      const def = Fleet.shipDef(p.type); return def ? def.price : 0;
    }
    if (listing.kind === "extractor" && window.Extractors) return Extractors.price(p) || 0;
    if (listing.kind === "component" && window.Components) return Components.price(p);
    return 0;
  },

  // Escrowed hall goods still count toward net worth (like auction bids).
  hallEscrowValue(pid = this.playerId()) {
    let n = 0;
    for (const st of this.list()) {
      for (const l of st.hall || []) if (l.sellerId === pid) n += this._listingValue(l);
    }
    return n;
  },

  contractEscrowValue(pid = this.playerId()) {
    let n = 0;
    for (const st of this.list()) {
      if (st.ownerId !== pid) continue;
      for (const c of st.contracts || []) {
        if (c.status === "open" || c.status === "active") n += c.escrow | 0;
      }
    }
    return n;
  },

  escrowForNetWorth(pid = this.playerId()) {
    return this.escrowTotal(pid) + this.hallEscrowValue(pid) + this.contractEscrowValue(pid);
  },

  _takeListable(kind, ref) {
    const s = Game.state;
    if (kind === "gear" || kind === "blackbox") {
      const it = s.items[ref]; if (!it) return { ok: false, msg: "Item not found." };
      if (window.Bazaar && Bazaar.equippedSet().has(ref)) return { ok: false, msg: "Unequip it first." };
      if (kind === "blackbox" && !(window.Items && Items.isBlackbox(it))) return { ok: false, msg: "Not a blackbox." };
      if (kind === "gear" && window.Items && Items.isBlackbox(it)) return { ok: false, msg: "List blackboxes as blackbox." };
      delete s.items[ref];
      return { ok: true, name: it.name, value: it.value || 0, payload: it };
    }
    if (kind === "extractor") {
      const ex = window.Extractors && Extractors.get(ref);
      if (!ex) return { ok: false, msg: "Extractor not found." };
      if (Extractors.installedSet().has(ref)) return { ok: false, msg: "Uninstall the extractor first." };
      const payload = JSON.parse(JSON.stringify(ex));
      delete Extractors.pool()[ref];
      return { ok: true, name: payload.name, value: Extractors.price(payload) || 0, payload };
    }
    if (kind === "component") {
      const c = window.Components && Components.get(ref);
      if (!c) return { ok: false, msg: "Component not found." };
      if (Components.installedSet().has(ref)) return { ok: false, msg: "Detach the component first." };
      const payload = JSON.parse(JSON.stringify(c));
      delete Components.pool()[ref];
      return { ok: true, name: payload.name || Components.nameFromUid(payload), value: Components.price(payload), payload };
    }
    if (kind === "ship") {
      const sh = (s.ships || []).find(x => x.uid === ref);
      if (!sh) return { ok: false, msg: "Ship not found." };
      if (sh.status !== "idle") return { ok: false, msg: "Ship must be idle." };
      if (sh.mercenary) return { ok: false, msg: "Can't list a mercenary." };
      const payload = JSON.parse(JSON.stringify(sh));
      s.ships = s.ships.filter(x => x.uid !== ref);
      const def = window.Fleet && Fleet.shipDef(payload.type);
      return { ok: true, name: payload.name || payload.type, value: def ? def.price : 0, payload };
    }
    if (kind === "blueprint") {
      const recipes = s.knownRecipes || [];
      if (!recipes.includes(ref)) return { ok: false, msg: "Blueprint not unlocked." };
      const recipe = (typeof RECIPES !== "undefined" ? RECIPES : []).find(r => r.id === ref);
      if (!recipe) return { ok: false, msg: "Unknown recipe." };
      s.knownRecipes = recipes.filter(id => id !== ref);
      return { ok: true, name: `${recipe.name} Blueprint`, value: 8000, payload: { recipeId: ref } };
    }
    return { ok: false, msg: "Unsupported listing type." };
  },

  _restoreListable(listing, toPid) {
    if (!listing || !listing.payload) return;
    // Guest: only the local player has inventory to restore into.
    if (toPid && toPid !== this.playerId()) return;
    const s = Game.state;
    const p = listing.payload;
    if (listing.kind === "gear" || listing.kind === "blackbox") {
      s.items[p.uid] = p;
    } else if (listing.kind === "extractor" && window.Extractors) {
      Extractors.pool()[p.uid] = p;
    } else if (listing.kind === "component" && window.Components) {
      Components.pool()[p.uid] = p;
    } else if (listing.kind === "ship") {
      s.ships = s.ships || [];
      if (!s.ships.some(x => x.uid === p.uid)) s.ships.push(p);
    } else if (listing.kind === "blueprint") {
      s.knownRecipes = s.knownRecipes || [];
      if (p.recipeId && !s.knownRecipes.includes(p.recipeId)) s.knownRecipes.push(p.recipeId);
    }
  },

  _deliverListable(listing, buyerPid) {
    if (!listing || !listing.payload) return { ok: false, msg: "Empty listing." };
    if (buyerPid !== this.playerId()) return { ok: false, msg: "Buyer unavailable." };
    const s = Game.state;
    const p = listing.payload;
    if (listing.kind === "gear" || listing.kind === "blackbox") {
      if (window.Bazaar && Bazaar.inventoryUsed() >= Bazaar.capacity())
        return { ok: false, msg: "Inventory full." };
      s.items[p.uid] = p;
      return { ok: true };
    }
    if (listing.kind === "extractor" && window.Extractors) {
      Extractors.pool()[p.uid] = p;
      return { ok: true };
    }
    if (listing.kind === "component" && window.Components) {
      Components.pool()[p.uid] = p;
      return { ok: true };
    }
    if (listing.kind === "ship") {
      const cap = window.Economy ? Economy.fleetCap() : 99;
      if ((s.ships || []).length >= cap) return { ok: false, msg: "Fleet at capacity." };
      s.ships = s.ships || [];
      s.ships.push(p);
      return { ok: true };
    }
    if (listing.kind === "blueprint") {
      s.knownRecipes = s.knownRecipes || [];
      if (p.recipeId && !s.knownRecipes.includes(p.recipeId)) s.knownRecipes.push(p.recipeId);
      return { ok: true };
    }
    return { ok: false, msg: "Unsupported listing type." };
  },

  listHallItem(systemId, kind, ref, price) {
    const access = this.canUseHall(systemId);
    if (!access.ok) return access;
    const st = access.st;
    // Black Market unlocks illicit-adjacent goods on the hall.
    if (kind === "blackbox" && !(st.modules.black_market | 0))
      return { ok: false, msg: "Blackboxes need a Black Market." };
    price = Math.floor(+price || 0);
    if (price < (STATIONCFG.hallMinPrice || 50)) return { ok: false, msg: `Price at least ${STATIONCFG.hallMinPrice}c.` };
    const taken = this._takeListable(kind, ref);
    if (!taken.ok) return taken;
    if (!Array.isArray(st.hall)) st.hall = [];
    const now = Date.now();
    const listing = {
      id: "hl" + (++Game.state.seq),
      sellerId: this.playerId(),
      kind,
      name: taken.name,
      price,
      value: taken.value,
      payload: taken.payload,
      listedAt: now,
      expiresAt: now + (STATIONCFG.hallListMs || 48 * 3600 * 1000),
    };
    st.hall.push(listing);
    this._ledger(st, 0, "hall_list", `${listing.name} @ ${price}`);
    if (window.Game) Game.requestSave();
    return { ok: true, listing };
  },

  cancelHallListing(systemId, listingId) {
    const st = this.get(systemId);
    if (!st || !Array.isArray(st.hall)) return { ok: false, msg: "No listing." };
    const idx = st.hall.findIndex(l => l.id === listingId);
    if (idx < 0) return { ok: false, msg: "Listing gone." };
    const listing = st.hall[idx];
    if (listing.sellerId !== this.playerId() && st.ownerId !== this.playerId())
      return { ok: false, msg: "Not your listing." };
    st.hall.splice(idx, 1);
    this._restoreListable(listing, listing.sellerId);
    if (window.Game) Game.requestSave();
    return { ok: true };
  },

  buyHallListing(systemId, listingId) {
    const access = this.canUseHall(systemId);
    if (!access.ok) return access;
    const st = access.st;
    const idx = (st.hall || []).findIndex(l => l.id === listingId);
    if (idx < 0) return { ok: false, msg: "Listing gone." };
    const listing = st.hall[idx];
    const pid = this.playerId();
    if (listing.sellerId === pid) return { ok: false, msg: "That's your listing." };
    const s = Game.state;
    if (s.credits < listing.price) return { ok: false, msg: "Not enough credits." };
    s.credits -= listing.price;
    const delivered = this._deliverListable(listing, pid);
    if (!delivered.ok) {
      s.credits += listing.price;
      return delivered;
    }
    const tariff = Math.floor(listing.price * Util.clamp(st.saleTariffBps | 0, 0, 1500) / 10000);
    const sellerGets = listing.price - tariff;
    if (tariff > 0) {
      st.treasury += tariff;
      this._ledger(st, tariff, "hall_tariff", listing.name);
    }
    // Seller proceeds: mailbox until claimed (server authority will settle live).
    st.pendingPayouts = st.pendingPayouts || {};
    st.pendingPayouts[listing.sellerId] = (st.pendingPayouts[listing.sellerId] | 0) + sellerGets;
    this.claimHallPayouts();
    st.hall.splice(idx, 1);
    if (window.Economy) Economy.refreshNetWorth();
    if (window.Game) Game.requestSave();
    return { ok: true, listing, tariff, paid: listing.price };
  },

  // Claim any pending sale proceeds (multiplayer / identity handoff).
  claimHallPayouts() {
    const stList = this.list();
    const pid = this.playerId();
    let got = 0;
    for (const st of stList) {
      if (!st.pendingPayouts || !st.pendingPayouts[pid]) continue;
      const n = st.pendingPayouts[pid] | 0;
      if (n <= 0) continue;
      Game.state.credits += n;
      got += n;
      delete st.pendingPayouts[pid];
      this._ledger(st, n, "hall_payout", "sale proceeds");
    }
    if (got && window.Game) Game.requestSave();
    return { ok: true, amount: got };
  },

  _expireHall(st, now = Date.now()) {
    if (!Array.isArray(st.hall) || !st.hall.length) return [];
    const kept = [], returned = [];
    for (const l of st.hall) {
      if (now >= l.expiresAt) {
        this._restoreListable(l, l.sellerId);
        returned.push(l);
      } else kept.push(l);
    }
    st.hall = kept;
    return returned;
  },

  _npcBuyHall(st, hourIndex) {
    if (!Array.isArray(st.hall) || !st.hall.length) return [];
    const sold = [];
    const chance = STATIONCFG.hallNpcBuyChance || 0.12;
    const keep = [];
    for (let i = 0; i < st.hall.length; i++) {
      const l = st.hall[i];
      const s = Market._seed([st.systemId, "hall", l.id, String(hourIndex)]);
      if (Market._u01(s, 0) >= chance) { keep.push(l); continue; }
      const tariff = Math.floor(l.price * Util.clamp(st.saleTariffBps | 0, 0, 1500) / 10000);
      const sellerGets = l.price - tariff;
      if (l.sellerId === this.playerId()) Game.state.credits += sellerGets;
      else {
        st.pendingPayouts = st.pendingPayouts || {};
        st.pendingPayouts[l.sellerId] = (st.pendingPayouts[l.sellerId] | 0) + sellerGets;
      }
      if (tariff > 0) { st.treasury += tariff; this._ledger(st, tariff, "hall_tariff", `NPC · ${l.name}`); }
      sold.push(l);
      if (window.Bus) Bus.emit("listingSold", { name: l.name, price: l.price, hall: true });
    }
    st.hall = keep;
    return sold;
  },

  // ---- Contract Office (docs/STATIONS.md §11) -----------------------------
  hasContractOffice(st) {
    return !!(st && (st.modules.contract_office | 0) && st.status === "owned");
  },

  ownerHandle(st) {
    if (st && st.ownerId && st.ownerId !== "player" && st.ownerId !== this.playerId())
      return String(st.ownerId).slice(0, 16);
    if (window.Cloud && Cloud.signedIn && Cloud.signedIn() && Cloud.user) {
      const u = Cloud.user.user_metadata && Cloud.user.user_metadata.username;
      if (u) return u;
    }
    return "Baron";
  },

  reliability(st) {
    const stats = (st && st.contractStats) || { filled: 0, expired: 0 };
    const tot = (stats.filled | 0) + (stats.expired | 0);
    if (!tot) return null;
    return (stats.filled | 0) / tot;
  },

  findHaul(contractId) {
    for (const st of this.list()) {
      const c = (st.contracts || []).find(x => x.id === contractId);
      if (c) return { st, contract: c };
    }
    return null;
  },

  _toBoardJob(st, c) {
    const comm = COMMODITIES.find(x => x.id === c.commId);
    const sec = Galaxy.sector(st.sectorId);
    const cap = sec && Galaxy.get(sec.capital);
    const handle = this.ownerHandle(st);
    const rel = this.reliability(st);
    const relTxt = rel == null ? "unrated" : `${Math.round(rel * 100)}% reliable`;
    return {
      id: c.id,
      kind: "job",
      type: "transport",
      source: "station",
      stationId: st.systemId,
      stationName: st.name,
      ownerId: st.ownerId,
      ownerHandle: handle,
      commId: c.commId,
      qty: c.qty,
      rate: c.rate,
      escrow: c.escrow,
      title: `Haul ${c.qty} ${comm ? comm.name : c.commId}`,
      desc: `From ${st.name} → ${cap ? cap.name : "sector capital"}. ${c.rate}c/u escrowed. Posted by ${handle} · ${relTxt}.`,
      sysName: cap ? cap.name : st.name,
      destSysId: sec ? sec.capital : null,
      danger: "low",
      faction: (comm && CATEGORY_FACTION[comm.cat]) || null,
      stakeTier: 0,
      minFirepower: Math.max(4, Math.round(c.qty / 40)),
      cargoRequired: c.qty,
      durationMs: (STATIONCFG.contractDurBaseMs || 25 * 60 * 1000)
        + c.qty * (STATIONCFG.contractDurPerUnitMs || 8000),
      impound: false,
      reward: { credits: c.escrow, itemChance: 0, stockChance: 0 },
      createdAt: c.createdAt,
      expiresAt: c.expiresAt,
      status: "open",
    };
  },

  boardContracts(now = Date.now()) {
    const out = [];
    for (const st of this.list()) {
      if (!this.hasContractOffice(st)) continue;
      for (const c of st.contracts || []) {
        if (c.status !== "open") continue;
        if (now >= c.expiresAt) continue;
        out.push(this._toBoardJob(st, c));
      }
    }
    return out;
  },

  postHaul(systemId, commId, qty, rate) {
    const st = this.get(systemId);
    if (!st || st.ownerId !== this.playerId() || !this.ownerHeld(st))
      return { ok: false, msg: "Not your station." };
    if (st.status === "refit")
      return { ok: false, msg: `Station is in refit — ${Util.duration(this.refitLeft(st))} left.` };
    if (!this.hasContractOffice(st)) return { ok: false, msg: "Install a Contract Office first." };
    const comm = COMMODITIES.find(c => c.id === commId);
    if (!comm || comm.craftOnly) return { ok: false, msg: "Unknown commodity." };
    qty = Math.floor(+qty || 0);
    rate = Math.floor(+rate || 0);
    if (qty < 1) return { ok: false, msg: "Need at least 1 unit." };
    if (rate < (STATIONCFG.contractMinRate || 5))
      return { ok: false, msg: `Rate at least ${STATIONCFG.contractMinRate}c/unit.` };
    const have = st.hold[commId] | 0;
    if (qty > have) return { ok: false, msg: `Only ${have} in station hold.` };
    const escrow = qty * rate;
    const fee = Math.floor(escrow * Util.clamp(STATIONCFG.contractPostFeeBps | 0, 0, 2000) / 10000);
    const s = Game.state;
    if (s.credits < escrow + fee) return { ok: false, msg: `Need ${Util.credits(escrow + fee)} (bounty + ${fee}c fee).` };
    st.hold[commId] = have - qty;
    s.credits -= escrow + fee;
    if (!Array.isArray(st.contracts)) st.contracts = [];
    const now = Date.now();
    const contract = {
      id: "sc" + (++s.seq),
      commId, qty, rate, escrow, fee,
      ownerId: this.playerId(), // station owner at post — survives revolt for refunds
      status: "open",
      createdAt: now,
      expiresAt: now + (STATIONCFG.contractListMs || 36 * 3600 * 1000),
    };
    st.contracts.push(contract);
    st.contractStats = st.contractStats || { filled: 0, expired: 0 };
    this._ledger(st, -escrow, "haul_post", `${qty}× ${commId} @ ${rate}`);
    if (fee > 0) this._ledger(st, -fee, "haul_fee", "faction posting fee");
    if (window.Game) Game.requestSave();
    return { ok: true, contract, fee };
  },

  cancelHaul(systemId, contractId) {
    const st = this.get(systemId);
    if (!st || st.ownerId !== this.playerId()) return { ok: false, msg: "Not your station." };
    const idx = (st.contracts || []).findIndex(c => c.id === contractId);
    if (idx < 0) return { ok: false, msg: "Posting gone." };
    const c = st.contracts[idx];
    if (c.status !== "open") return { ok: false, msg: "Already in flight." };
    st.contracts.splice(idx, 1);
    this._refundHaul(st, c);
    if (window.Game) Game.requestSave();
    return { ok: true };
  },

  _refundHaul(st, c) {
    if (!c) return;
    st.hold[c.commId] = (st.hold[c.commId] | 0) + (c.qty | 0);
    const payTo = c.ownerId || st.ownerId;
    if (payTo === this.playerId()) Game.state.credits += c.escrow | 0;
    else if (payTo) {
      st.pendingPayouts = st.pendingPayouts || {};
      st.pendingPayouts[payTo] = (st.pendingPayouts[payTo] | 0) + (c.escrow | 0);
    }
    // ponytail: if payTo is missing (legacy save), escrow is burned — better than pendingPayouts[null]
    this._ledger(st, c.escrow | 0, "haul_refund", c.id);
  },

  claimHaulForLaunch(contractId) {
    const found = this.findHaul(contractId);
    if (!found || found.contract.status !== "open")
      return { ok: false, msg: "Haul no longer available." };
    const { st, contract } = found;
    if (!this.hasContractOffice(st) && st.status !== "owned")
      return { ok: false, msg: "Haul no longer available." };
    if (st.ownerId === this.playerId())
      return { ok: false, msg: "Can't fly your own station haul." };
    contract.status = "active";
    contract.takenAt = Date.now();
    contract.takenBy = this.playerId();
    const job = this._toBoardJob(st, contract);
    job.status = "taken";
    if (window.Game) Game.requestSave();
    return { ok: true, contract: job };
  },

  // Mission success / fail / abandon → deliver goods or refund bounty.
  settleHaul(contractId, outcome) {
    const found = this.findHaul(contractId);
    if (!found) return { ok: false, msg: "Haul gone." };
    const { st, contract } = found;
    if (contract.status !== "active" && contract.status !== "open") return { ok: false, msg: "Already settled." };
    st.contractStats = st.contractStats || { filled: 0, expired: 0 };
    const idx = st.contracts.indexOf(contract);
    if (outcome === "success") {
      Stock.put(st.sectorId, contract.commId, contract.qty);
      st.delivered = (st.delivered | 0) + (contract.qty | 0);
      st.contractStats.filled = (st.contractStats.filled | 0) + 1;
      this._ledger(st, 0, "haul_filled", `${contract.qty}× ${contract.commId}`);
      // Escrow already paid to hauler via Missions reward.
    } else if (outcome === "fail" || outcome === "abandon") {
      this._refundHaul(st, contract);
    } else if (outcome === "expire") {
      this._refundHaul(st, contract);
      st.contractStats.expired = (st.contractStats.expired | 0) + 1;
    }
    if (idx >= 0) st.contracts.splice(idx, 1);
    if (window.Economy) Economy.refreshNetWorth();
    if (window.Game) Game.requestSave();
    return { ok: true };
  },

  _expireHauls(st, now = Date.now()) {
    if (!Array.isArray(st.contracts) || !st.contracts.length) return [];
    const kept = [], expired = [];
    for (const c of st.contracts) {
      if (c.status === "open" && now >= c.expiresAt) {
        this._refundHaul(st, c);
        st.contractStats = st.contractStats || { filled: 0, expired: 0 };
        st.contractStats.expired = (st.contractStats.expired | 0) + 1;
        expired.push(c);
      } else kept.push(c);
    }
    st.contracts = kept;
    return expired;
  },

  _npcFillHauls(st, hourIndex) {
    if (!Array.isArray(st.contracts) || !st.contracts.length) return [];
    const chance = STATIONCFG.contractNpcFillChance || 0.08;
    const after = STATIONCFG.contractNpcFillAfterMs || 4 * 3600 * 1000;
    const now = Date.now();
    const kept = [], filled = [];
    for (let i = 0; i < st.contracts.length; i++) {
      const c = st.contracts[i];
      if (c.status !== "open" || now - c.createdAt < after) { kept.push(c); continue; }
      const s = Market._seed([st.systemId, "haul", c.id, String(hourIndex)]);
      if (Market._u01(s, 0) >= chance) { kept.push(c); continue; }
      Stock.put(st.sectorId, c.commId, c.qty);
      st.delivered = (st.delivered | 0) + (c.qty | 0);
      st.contractStats = st.contractStats || { filled: 0, expired: 0 };
      st.contractStats.filled = (st.contractStats.filled | 0) + 1;
      this._ledger(st, 0, "haul_npc", `${c.qty}× ${c.commId}`);
      // Escrow consumed by NPC hauler (leaves the economy).
      filled.push(c);
    }
    st.contracts = kept;
    return filled;
  },

  setScrutiny(systemId, pct) {
    const st = this.get(systemId);
    if (!st || st.ownerId !== this.playerId()) return { ok: false, msg: "Not your station." };
    if (!(st.modules.customs_house | 0)) return { ok: false, msg: "Needs a Customs House." };
    const capPct = Math.round((CUSTOMS.cap || 0.85) * 100);
    st.scrutiny = Util.clamp(Math.round(+pct || 0), 0, capPct);
    if (window.Game) Game.requestSave();
    return { ok: true, scrutiny: st.scrutiny };
  },

  produceable(systemId) {
    const sys = Galaxy.get(systemId);
    if (!sys) return [];
    return COMMODITIES.filter(c => !c.craftOnly && c.rarity !== "exotic" && (sys.mods[c.cat] ?? 1) < 1.0);
  },

  // ---- Production Hub bays (docs/STATIONS.md §8) --------------------------
  bayCount(st) {
    const hub = st.modules.production_hub | 0;
    if (!hub) return 0;
    const row = STATIONCFG.prodHub[hub - 1];
    return row ? row.bays : 0;
  },

  syncBays(st) {
    const n = this.bayCount(st);
    if (!Array.isArray(st.bays)) st.bays = [];
    // Coerce / drop junk
    st.bays = st.bays.filter(b => b && typeof b === "object").map(b => ({
      lesseeId: b.lesseeId || null,
      extractorId: b.extractorId || null,
      npc: !!b.npc,
    }));
    while (st.bays.length < n) st.bays.push({ lesseeId: null, extractorId: null, npc: false });
    while (st.bays.length > n) this._clearBay(st, st.bays.pop());
    return st.bays;
  },

  _clearBay(st, bay) {
    if (!bay) return;
    // Player extractors stay in the pool; clearing just frees the install slot.
    bay.lesseeId = null;
    bay.extractorId = null;
    bay.npc = false;
  },

  staffedBays(st) {
    this.syncBays(st);
    return (st.bays || []).filter(b => b.lesseeId);
  },

  // Owner parks an extractor in a bay (occupies it; output → station hold).
  occupyBay(systemId, bayIndex, extractorUid) {
    const st = this.get(systemId);
    if (!st || st.ownerId !== this.playerId() || !this.ownerHeld(st))
      return { ok: false, msg: "Not your station." };
    // Staffing during a refit is allowed — output is gated in _playerProduce,
    // so the owner can have the line ready for the moment it comes back up.
    if (!(st.modules.production_hub | 0) || !st.prodComm)
      return { ok: false, msg: "Assign a Production Hub commodity first." };
    this.syncBays(st);
    const bay = st.bays[bayIndex];
    if (!bay) return { ok: false, msg: "No such bay." };
    if (bay.lesseeId) return { ok: false, msg: "Bay is occupied." };
    const ex = window.Extractors && Extractors.get(extractorUid);
    if (!ex) return { ok: false, msg: "Extractor not found." };
    if (Extractors.installedSet().has(extractorUid))
      return { ok: false, msg: "That extractor is already installed elsewhere." };
    if (!Extractors.canProduce(ex, st.prodComm))
      return { ok: false, msg: "This extractor can't produce the hub commodity." };
    bay.lesseeId = this.playerId();
    bay.extractorId = extractorUid;
    bay.npc = false;
    if (window.Game) Game.requestSave();
    return { ok: true, bay };
  },

  // Non-owner leases a vacant bay with their extractor (output → their cargo, tax to owner).
  leaseBay(systemId, bayIndex, extractorUid) {
    const st = this.get(systemId);
    if (!st || st.status !== "owned") return { ok: false, msg: "Station isn't leasing." };
    const pid = this.playerId();
    if (st.ownerId === pid) return { ok: false, msg: "You own this station — occupy a bay instead." };
    if (!(st.modules.production_hub | 0) || !st.prodComm)
      return { ok: false, msg: "No Production Hub commodity assigned." };
    const s = window.Game && Game.state;
    if (!s || s.travel) return { ok: false, msg: "Can't lease in transit." };
    if (s.currentSystem !== systemId) return { ok: false, msg: "Dock at this station to lease a bay." };
    this.syncBays(st);
    const bay = st.bays[bayIndex];
    if (!bay) return { ok: false, msg: "No such bay." };
    if (bay.lesseeId) return { ok: false, msg: "Bay is occupied." };
    const ex = window.Extractors && Extractors.get(extractorUid);
    if (!ex) return { ok: false, msg: "Extractor not found." };
    if (Extractors.installedSet().has(extractorUid))
      return { ok: false, msg: "That extractor is already installed elsewhere." };
    if (!Extractors.canProduce(ex, st.prodComm))
      return { ok: false, msg: "This extractor can't produce the hub commodity." };
    bay.lesseeId = pid;
    bay.extractorId = extractorUid;
    bay.npc = false;
    if (window.Game) Game.requestSave();
    return { ok: true, bay };
  },

  // Vacant leaseable bays at a station (visitor UI).
  leaseableBays(systemId) {
    const st = this.get(systemId);
    if (!st || st.status !== "owned" || !(st.modules.production_hub | 0) || !st.prodComm) return [];
    this.syncBays(st);
    return (st.bays || []).map((b, i) => ({ index: i, bay: b }))
      .filter(x => !x.bay.lesseeId);
  },

  // Credit leased keep-cargo parked while the lessee was offline / remote.
  claimPendingCargo(systemId) {
    const st = this.get(systemId);
    if (!st || !st.pendingCargo) return { ok: true, claimed: {} };
    const pid = this.playerId();
    const bag = st.pendingCargo[pid];
    if (!bag || typeof bag !== "object") return { ok: true, claimed: {} };
    const s = Game.state;
    const claimed = {};
    for (const [commId, qty] of Object.entries(bag)) {
      const n = Math.floor(+qty || 0);
      if (n <= 0) continue;
      const held = s.positions[commId] || 0;
      s.positions[commId] = held + n;
      s.avgCost[commId] = held > 0 ? ((s.avgCost[commId] || 0) * held) / (held + n) : 0;
      if (window.Assets) Assets.parkBlocks(systemId, commId, n);
      claimed[commId] = n;
    }
    delete st.pendingCargo[pid];
    if (window.Game) Game.requestSave();
    return { ok: true, claimed };
  },

  vacateBay(systemId, bayIndex) {
    const st = this.get(systemId);
    if (!st) return { ok: false, msg: "No station." };
    this.syncBays(st);
    const bay = st.bays[bayIndex];
    if (!bay || !bay.lesseeId) return { ok: false, msg: "Bay is empty." };
    const pid = this.playerId();
    // Owner can evict anyone; lessee can leave their own bay.
    if (st.ownerId !== pid && bay.lesseeId !== pid)
      return { ok: false, msg: "Not your bay." };
    this._clearBay(st, bay);
    if (window.Game) Game.requestSave();
    return { ok: true };
  },

  // Soft NPC tenants for vacant bays — keeps lease tax meaningful in guest mode.
  _fillNpcTenants(st, hourIndex) {
    this.syncBays(st);
    if (!st.prodComm || st.status !== "owned") return;
    const taxFrac = Util.clamp((st.leaseTaxBps | 0) / 4000, 0, 1);
    const fillChance = Util.clamp((STATIONCFG.npcLeaseChanceMax || 0.5) * (1 - taxFrac), 0.02, 0.5);
    const leaveChance = taxFrac * (STATIONCFG.npcLeaseLeaveMult || 0.35);
    for (let i = 0; i < st.bays.length; i++) {
      const bay = st.bays[i];
      const s = Market._seed([st.systemId, "lease", String(i), String(hourIndex)]);
      if (bay.lesseeId && bay.npc) {
        if (Market._u01(s, 0) < leaveChance) this._clearBay(st, bay);
        continue;
      }
      if (bay.lesseeId) continue;
      if (Market._u01(s, 1) < fillChance) {
        bay.lesseeId = "npc";
        bay.extractorId = null; // virtual jack-of-all-trades
        bay.npc = true;
      }
    }
  },

  _bayGross(st, bay) {
    const hub = st.modules.production_hub | 0;
    const row = STATIONCFG.prodHub[hub - 1];
    if (!row || !st.prodComm) return 0;
    const perBay = row.yield / row.bays;
    let ex = null;
    if (bay.extractorId && window.Extractors) ex = Extractors.get(bay.extractorId);
    // NPC tenants run a virtual jack.
    if (!ex && bay.npc) ex = { type: "jack", scope: "all", components: [] };
    if (!ex) return 0;
    if (window.Extractors && !Extractors.canProduce(ex, st.prodComm) && !bay.npc) return 0;
    const yMult = window.Extractors ? Extractors.yieldMult(ex) : 1;
    const bon = window.Extractors ? Extractors.bonuses(ex) : { rate: 1 };
    let gross = Math.round(perBay * yMult * bon.rate);
    if ((st.standing | 0) < 20) gross = Math.floor(gross / 2); // general strike
    return Math.max(0, gross);
  },

  // Owner + lessee bay production for one hour.
  _playerProduce(st, hourIndex) {
    if (st.status === "refit") return 0;
    if (st.status !== "owned") return 0;
    const hub = st.modules.production_hub | 0;
    if (!hub || !st.prodComm) return 0;
    this.syncBays(st);
    const taxBps = Util.clamp(st.leaseTaxBps | 0, 0, 4000);
    let total = 0;
    let ownerStaffed = 0;
    const pid = this.playerId();
    for (const bay of st.bays) {
      if (!bay.lesseeId) continue;
      const gross = this._bayGross(st, bay);
      if (gross <= 0) continue;
      total += gross;
      const isOwner = bay.lesseeId === st.ownerId && !bay.npc;
      if (isOwner) {
        ownerStaffed++;
        st.hold[st.prodComm] = (st.hold[st.prodComm] | 0) + gross;
        continue;
      }
      const taxQty = Math.floor(gross * taxBps / 10000);
      const keep = gross - taxQty;
      if (taxQty > 0) st.hold[st.prodComm] = (st.hold[st.prodComm] | 0) + taxQty;
      if (keep <= 0) continue;
      if (bay.npc) continue; // NPC keeps residual off-map
      if (bay.lesseeId === pid && window.Game) {
        const s = Game.state;
        const held = s.positions[st.prodComm] || 0;
        s.positions[st.prodComm] = held + keep;
        // Soft income at zero cost basis (same as industry minting).
        s.avgCost[st.prodComm] = held > 0 ? ((s.avgCost[st.prodComm] || 0) * held) / (held + keep) : 0;
        if (window.Assets) Assets.parkBlocks(st.systemId, st.prodComm, keep);
      } else {
        // Remote / third-party lessee — park keep until they claim.
        if (!st.pendingCargo || typeof st.pendingCargo !== "object") st.pendingCargo = {};
        const bag = st.pendingCargo[bay.lesseeId] || (st.pendingCargo[bay.lesseeId] = {});
        bag[st.prodComm] = (bag[st.prodComm] | 0) + keep;
      }
    }
    // Expected deliveries scale with hub level and how many owner bays are staffed.
    const staffFactor = Math.max(0.35, ownerStaffed / Math.max(1, st.bays.length));
    st.expected = Math.round(STATIONCFG.expectedDeliveryBase * hub
      * (1 + this.tierInfo(st.tier).rank * 0.15) * staffFactor);
    return total;
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
    if (this.ownerHeld(st)) return { ok: false, msg: "Already owned." };
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

  _isAdmin() { return !!(window.Cloud && Cloud.isAdmin && Cloud.isAdmin()); },

  // Cancel an open auction and refund the local player's escrowed high bid.
  _cancelAuction(systemId) {
    const auc = this.auctions[systemId];
    if (!auc || auc.status !== "open") return;
    const pid = this.playerId();
    if (auc.highBidder === pid || auc.highBidder === "player") {
      Game.state.credits += auc.highBid | 0;
    }
    auc.status = "cancelled";
    delete this.auctions[systemId];
  },

  // Admin: take a claimable station immediately — no bid, no 72h wait, no cap.
  // ponytail: client-gated like the rest of Stations until Phase 4; add
  // app_station_admin_claim (role-checked) before cloud-authoritative ownership.
  adminClaim(systemId) {
    if (!this._isAdmin()) return { ok: false, msg: "Admins only." };
    const st = this.get(systemId);
    if (!st) return { ok: false, msg: "No station." };
    if (st.status === "owned" && st.ownerId === this.playerId())
      return { ok: false, msg: "You already own this station." };
    if (st.status === "owned" && st.ownerId && st.ownerId !== this.playerId())
      return { ok: false, msg: "Already owned — relinquish first." };
    this._cancelAuction(systemId);
    const pid = this.playerId();
    st.ownerId = pid;
    st.status = "owned";
    st.standing = STATIONCFG.standingStart;
    st.delivered = 0;
    st.cooldownUntil = 0;
    if (window.Game) Game.requestSave();
    return { ok: true, st };
  },

  // Exchange-style value of goods sitting in the station hold (for buyback).
  holdValue(st) {
    let n = 0;
    for (const [commId, qty] of Object.entries((st && st.hold) || {})) {
      const q = qty | 0;
      if (q <= 0) continue;
      const price = (window.Economy && Economy.sellPrice)
        ? Economy.sellPrice(commId)
        : (window.Market ? Market.price(commId) : 0);
      n += Math.round((+price || 0) * q);
    }
    return n;
  },

  // Owner walks away. Modules persist; no cooldown. Treasury + hold buyback return.
  // ponytail: local until app_station_relinquish lands with the station RPC set.
  relinquish(systemId) {
    const st = this.get(systemId);
    if (!st) return { ok: false, msg: "No station." };
    const pid = this.playerId();
    const mine = st.ownerId === pid && this.ownerHeld(st);
    if (!mine) return { ok: false, msg: "Not your station." };
    const treasury = st.treasury | 0;
    const holdCredits = this.holdValue(st);
    if (treasury > 0) {
      Game.state.credits += treasury;
      this._ledger(st, -treasury, "relinquish", "treasury returned");
      st.treasury = 0;
    }
    if (holdCredits > 0) {
      Game.state.credits += holdCredits;
      this._ledger(st, holdCredits, "relinquish_hold", "hold buyback");
    }
    for (const c of (st.contracts || []).filter(x => x.status === "open")) this._refundHaul(st, c);
    st.contracts = (st.contracts || []).filter(x => x.status === "active");
    for (const l of st.hall || []) this._restoreListable(l, l.sellerId);
    st.hall = [];
    this.syncBays(st);
    for (const bay of st.bays || []) this._clearBay(st, bay);
    st.ownerId = null;
    st.status = "npc";
    st.cooldownUntil = 0;
    st.hold = {};
    st.standing = STATIONCFG.standingStart;
    st.prodComm = null;
    st.impoundHold = {};
    st.impoundClaims = [];
    st.delivered = 0;
    delete this.access[st.systemId];
    this._cancelAuction(systemId);
    if (window.Game) Game.requestSave();
    return { ok: true, st, treasury, holdCredits };
  },

  // Credits currently locked in bids — counted in net worth.
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
        if (st.status === "owned") this._fillNpcTenants(st, hourIndex);
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

      // Exchange Hall: expiry + guest NPC buyers (liquidity until real P2P).
      if (this.hasHall(st)) {
        this._expireHall(st, now);
        const sold = this._npcBuyHall(st, hourIndex);
        if (sold.length && window.Economy) Economy.refreshNetWorth();
      }

      // Contract Office: expire open hauls + slow NPC fill.
      if (this.hasContractOffice(st) || (st.contracts || []).length) {
        this._expireHauls(st, now);
        if (this.hasContractOffice(st)) this._npcFillHauls(st, hourIndex);
      }

      // Standing decay and upkeep are both suspended during a declared refit
      // (docs open question → yes): the station is offline by the owner's choice.
      if (st.status !== "owned") { if (st.status === "refit") st.delivered = 0; continue; }

      let standing = st.standing;
      const expected = st.expected || STATIONCFG.expectedDeliveryBase;
      const del = st.delivered | 0;
      if (del >= expected) standing += 4;
      else if (del > 0) standing += 1;
      else standing -= 5;

      const hub = st.modules.production_hub | 0;
      this.syncBays(st);
      const staffed = (st.bays || []).filter(b => b.lesseeId && !b.npc && b.lesseeId === st.ownerId).length;
      if (!hub || !st.prodComm || !staffed) standing -= 3; // idle / unstaffed hub
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

      // Customs / Free Port policy forks (docs/STATIONS.md §12).
      if (st.modules.customs_house | 0) {
        const sub = STATIONCFG.customsSubsidy | 0;
        if (sub > 0) { st.treasury += sub; this._ledger(st, sub, "enforcement", "lawful subsidy"); }
        standing += STATIONCFG.customsStandingTick || 1;
        if (st.ownerId === this.playerId() && window.Rep) {
          Rep.change("free_trade", 0.4);
          Rep.change("mining_combine", 0.2);
          Rep.change("syndicate", -0.8);
        }
      } else if (st.modules.free_port | 0) {
        standing += STATIONCFG.freePortStandingTick || -1;
        if (st.ownerId === this.playerId() && window.Rep) {
          Rep.change("syndicate", 0.6);
          Rep.change("free_trade", -0.4);
        }
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
    // Revolt! Refund open-haul escrow to the owner before wiping identity/hold.
    // Goods reserved in the post return to hold briefly, then the hold is seized.
    for (const c of (st.contracts || []).filter(x => x.status === "open")) this._refundHaul(st, c);
    st.contracts = (st.contracts || []).filter(x => x.status === "active");
    st.ownerId = null;
    st.status = "cooldown";
    st.cooldownUntil = Date.now() + STATIONCFG.cooldownMs;
    st.treasury = 0; // forfeited to faction
    st.hold = {};
    st.standing = STATIONCFG.standingStart;
    st.prodComm = null;
    // Clear bays — player extractors return to storage (not seized).
    this.syncBays(st);
    for (const bay of st.bays || []) this._clearBay(st, bay);
    // Hall listings return to sellers (not seized with the landlord).
    for (const l of st.hall || []) this._restoreListable(l, l.sellerId);
    st.hall = [];
    st.impoundHold = {};
    st.impoundClaims = [];
    delete this.access[st.systemId];
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

  // Customs scrutiny override for a system (null = baseline capital formula).
  scrutinyFor(systemId) {
    const st = this.get(systemId);
    if (!st) return null;
    if (st.modules.free_port)
      return Math.max(0, (CUSTOMS.base || 0.1) * (STATIONCFG.freePortScrutinyMult || 0.35));
    if (st.modules.customs_house) return Util.clamp((st.scrutiny | 0) / 100, 0, CUSTOMS.cap || 0.85);
    return null;
  },

  // ---- Customs impound / ransom (docs/STATIONS.md §12) --------------------
  impoundCargo(systemId, commId, qty, value, fromId) {
    const st = this.get(systemId);
    if (!st || !(st.modules.customs_house | 0)) return { ok: false, msg: "No Customs House." };
    qty = Math.max(1, Math.floor(+qty || 0));
    if (!st.impoundHold || typeof st.impoundHold !== "object") st.impoundHold = {};
    if (!Array.isArray(st.impoundClaims)) st.impoundClaims = [];
    st.impoundHold[commId] = (st.impoundHold[commId] | 0) + qty;
    const ransom = Math.max(1, Math.round((value || 0) * (STATIONCFG.ransomMult || 1.25)));
    const claimId = "ic" + (++Game.state.seq);
    st.impoundClaims.push({
      id: claimId, commId, qty, value: value | 0, ransom,
      fromId: fromId || null, at: Date.now(),
    });
    this._ledger(st, 0, "impound", `${qty}× ${commId}`);
    if (window.Game) Game.requestSave();
    return { ok: true, claimId, ransom };
  },

  sellImpound(systemId, commId, qty) {
    const st = this.get(systemId);
    if (!st || st.ownerId !== this.playerId()) return { ok: false, msg: "Not your station." };
    const s = Game.state;
    if (s.travel) return { ok: false, msg: "Can't sell in transit." };
    const sec = Galaxy.sector(st.sectorId);
    if (!sec || s.currentSystem !== sec.capital) {
      const cap = sec && Galaxy.get(sec.capital);
      return { ok: false, msg: `Dock at ${cap ? cap.name : "the capital"} to fence impound.` };
    }
    qty = Math.min(Math.floor(+qty || 0), st.impoundHold[commId] | 0);
    if (qty <= 0) return { ok: false, msg: "Nothing in impound." };
    const price = Economy.sellPrice(commId);
    const proceeds = Math.round(price * qty);
    st.impoundHold[commId] -= qty;
    this._trimImpoundClaims(st, commId, qty);
    st.treasury += proceeds;
    Stock.put(st.sectorId, commId, qty);
    this._ledger(st, proceeds, "impound_sale", `${qty}× ${commId}`);
    // Lawful fork: enforcement sales please Free Trade, annoy Syndicate.
    if (window.Rep && st.ownerId === this.playerId()) {
      Rep.change("free_trade", 1);
      Rep.change("syndicate", -2);
    }
    if (window.Game) Game.requestSave();
    return { ok: true, qty, proceeds };
  },

  _trimImpoundClaims(st, commId, qty) {
    let left = qty;
    st.impoundClaims = (st.impoundClaims || []).filter(c => {
      if (c.commId !== commId || left <= 0) return true;
      if (c.qty <= left) { left -= c.qty; return false; }
      c.qty -= left; c.ransom = Math.max(1, Math.round(c.ransom * (c.qty / (c.qty + left))));
      left = 0;
      return true;
    });
  },

  payRansom(systemId, claimId) {
    const st = this.get(systemId);
    if (!st) return { ok: false, msg: "No station." };
    const s = Game.state;
    if (s.currentSystem !== systemId) return { ok: false, msg: "Dock at the station to pay ransom." };
    const idx = (st.impoundClaims || []).findIndex(c => c.id === claimId);
    if (idx < 0) return { ok: false, msg: "Claim gone." };
    const c = st.impoundClaims[idx];
    if (c.fromId && c.fromId !== this.playerId()) return { ok: false, msg: "Not your seizure." };
    if (s.credits < c.ransom) return { ok: false, msg: "Not enough credits." };
    const have = st.impoundHold[c.commId] | 0;
    if (have < c.qty) return { ok: false, msg: "Goods already sold." };
    s.credits -= c.ransom;
    st.treasury += c.ransom;
    st.impoundHold[c.commId] = have - c.qty;
    s.positions[c.commId] = (s.positions[c.commId] | 0) + c.qty;
    if (window.Assets) Assets.parkBlocks(systemId, c.commId, c.qty);
    st.impoundClaims.splice(idx, 1);
    this._ledger(st, c.ransom, "ransom", `${c.qty}× ${c.commId}`);
    // Paying a bribe helps Syndicate; owner taking it costs lawful standing.
    if (window.Rep) {
      Rep.change("syndicate", 2);
      Rep.change("free_trade", -1);
      if (st.ownerId === this.playerId()) Rep.change("syndicate", 1);
    }
    if (window.Game) Game.requestSave();
    return { ok: true, qty: c.qty, paid: c.ransom, commId: c.commId };
  },

  // Owner releases a claim back for free (or burns it).
  dropImpoundClaim(systemId, claimId) {
    const st = this.get(systemId);
    if (!st || st.ownerId !== this.playerId()) return { ok: false, msg: "Not your station." };
    const idx = (st.impoundClaims || []).findIndex(c => c.id === claimId);
    if (idx < 0) return { ok: false, msg: "Claim gone." };
    const c = st.impoundClaims[idx];
    st.impoundClaims.splice(idx, 1);
    st.impoundHold[c.commId] = Math.max(0, (st.impoundHold[c.commId] | 0) - c.qty);
    if (window.Game) Game.requestSave();
    return { ok: true };
  },

  // ---- tick (auctions; stock hour is driven by Stock.tick) ---------------
  tick(now = Date.now()) {
    this.ensure();
    for (const id of Object.keys(this.auctions)) this._closeAuction(id, now);
    for (const st of this.list()) {
      if (st.status === "refit" && now >= st.refitUntil) st.status = st.ownerId ? "owned" : "npc";
      if (st.status === "cooldown" && now >= st.cooldownUntil) st.status = "npc";
      if (st.hall && st.hall.length) this._expireHall(st, now);
    }
    this.claimHallPayouts();
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
      st.bays = Array.isArray(st.bays) ? st.bays : [];
      st.hall = Array.isArray(st.hall) ? st.hall : [];
      st.contracts = Array.isArray(st.contracts) ? st.contracts.filter(c => c && c.id && c.commId) : [];
      for (const c of st.contracts) {
        c.qty = Math.max(0, Math.floor(+c.qty || 0));
        c.rate = Math.max(0, Math.floor(+c.rate || 0));
        c.escrow = Math.max(0, Math.floor(+c.escrow || c.qty * c.rate));
        if (!["open", "active"].includes(c.status)) c.status = "open";
      }
      st.contractStats = (st.contractStats && typeof st.contractStats === "object")
        ? { filled: Math.max(0, st.contractStats.filled | 0), expired: Math.max(0, st.contractStats.expired | 0) }
        : { filled: 0, expired: 0 };
      st.impoundHold = (st.impoundHold && typeof st.impoundHold === "object") ? st.impoundHold : {};
      st.impoundClaims = Array.isArray(st.impoundClaims)
        ? st.impoundClaims.filter(c => c && c.id && c.commId && (c.qty | 0) > 0)
        : [];
      st.pendingCargo = (st.pendingCargo && typeof st.pendingCargo === "object") ? st.pendingCargo : {};
      st.pendingPayouts = (st.pendingPayouts && typeof st.pendingPayouts === "object") ? st.pendingPayouts : {};
      st.reactorLevel = Util.clamp(st.reactorLevel | 0, 0, 5);
      this.syncBays(st);
      st.standing = Util.clamp(+st.standing || STATIONCFG.standingStart, 0, 100);
      st.treasury = Math.max(0, Math.floor(+st.treasury || 0));
      st.leaseTaxBps = Util.clamp(st.leaseTaxBps | 0, 0, 4000);
      st.saleTariffBps = Util.clamp(st.saleTariffBps | 0, 0, 1500);
      st.scrutiny = Util.clamp(st.scrutiny | 0, 0, 100);
      if (!["npc", "owned", "refit", "cooldown"].includes(st.status)) st.status = st.ownerId ? "owned" : "npc";
      // Timers are the only thing standing between an owner and their station —
      // a NaN or a far-future value from a corrupt save must never strand them.
      const now = Date.now();
      st.refitUntil = Math.min(Math.max(0, +st.refitUntil || 0), now + STATIONCFG.refitMs);
      st.cooldownUntil = Math.min(Math.max(0, +st.cooldownUntil || 0), now + STATIONCFG.cooldownMs);
      if (st.status === "refit" && now >= st.refitUntil) st.status = st.ownerId ? "owned" : "npc";
      if (st.status === "cooldown" && now >= st.cooldownUntil) st.status = "npc";
    }
    this.ensure();
  },
};

window.Stations = Stations;
