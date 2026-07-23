/* bazaar.js — the marketplace. Buy ships (transports + permanent escorts) and
   flagships, hire time-limited mercenaries, take contracts (jobs + insider
   tips), and trade procedurally-generated accessories. Listings live and churn:
   contracts expire or get taken by NPCs; accessories get bought out from under
   you; and items you list sell to NPCs after a hidden delay.                   */

const Bazaar = {
  s() { return window.Game.state; },
  bz() { return this.s().bazaar; },
  // Phase 2: signed-in + players RPCs → purchase/sell via app_* .
  authoritative() { return !!(window.Economy && Economy.authoritative()); },

  // Seeded board epoch — must match app.board_epoch (60s) in phase2 SQL.
  boardEpochMs: 60_000,
  boardEpoch(now = Date.now()) { return Math.floor(now / this.boardEpochMs); },
  _boughtSet() { return new Set(this.s().bazaarBought || []); },
  _seed(parts) { return Market._seed(["bazaar", ...parts]); },
  _u01(seed, n) { return Market._u01(seed, n); },

  genSeededMerc(epoch, slot) {
    const s = this._seed(["merc", String(epoch), String(slot)]);
    const escorts = SHIP_CATALOG.escort;
    const esc = escorts[Math.floor(this._u01(s, 0) * escorts.length) % escorts.length];
    return {
      id: `mc-${epoch}-${slot}`,
      shipType: esc.id,
      name: `${esc.name || esc.id} Merc ${slot}`,
      firepower: esc.firepower, hull: esc.hull,
      serviceMs: (15 + Math.floor(this._u01(s, 1) * 26)) * 60 * 1000,
      hireCost: Math.round(esc.price * 0.2 + esc.firepower * 55),
      availUntil: (epoch + 2) * this.boardEpochMs,
    };
  },

  genSeededAccessory(epoch, slot) {
    const s = this._seed(["acc", String(epoch), String(slot)]);
    const kinds = Object.keys(ACCESSORY_KINDS);
    const ki = Math.floor(this._u01(s, 0) * kinds.length) % kinds.length;
    const kindId = kinds[ki];
    const k = ACCESSORY_KINDS[kindId];
    const roll = this._u01(s, 1);
    let rarity = "common", mult = 1.0;
    if (roll >= 0.50 && roll < 0.78) { rarity = "uncommon"; mult = 1.5; }
    else if (roll >= 0.78 && roll < 0.92) { rarity = "rare"; mult = 2.3; }
    else if (roll >= 0.92) { rarity = "epic"; mult = 3.4; }
    let amount = k.base * mult * (0.8 + this._u01(s, 2) * 0.5);
    amount = k.pct ? +amount.toFixed(3) : Math.round(amount);
    const item = {
      uid: `i${epoch}a${slot}`, kind: kindId, rarity,
      name: `${k.label} ${rarity}`,
      primary: { stat: k.stat, amount, pct: k.pct, kind: kindId },
      bonus: null,
    };
    item.value = Items.value(item);
    const price = Math.round(item.value * (0.95 + this._u01(s, 3) * 0.30));
    return { id: `ac-${epoch}-${slot}`, item, price };
  },

  genSeededContract(epoch, slot, tier = 0) {
    const s = this._seed(["ct", String(epoch), String(slot)]);
    const stake = tier | 0;
    const reqMult = 1 + stake * BAZAARCFG.tierReqMult;
    const stakeMult = 1 + stake * BAZAARCFG.tierStakeMult;
    const factions = Object.keys(FACTIONS);
    if (this._u01(s, 0) < 0.16) {
      return {
        id: `ct-${epoch}-${slot}`, kind: "tip", type: "insider", status: "open",
        title: "Insider whisper", desc: "Pay for a tip and front-run the newswire.",
        cat: ["mineral", "gas", "agri", "tech", "luxury", "illicit"][Math.floor(this._u01(s, 1) * 6) % 6],
        sysName: `Sector ${1 + (Math.floor(this._u01(s, 2) * 20) % 20)}`,
        faction: factions[Math.floor(this._u01(s, 3) * factions.length) % factions.length],
        cost: 1500 + Math.floor(this._u01(s, 4) * 7501),
        stakeTier: stake,
      };
    }
    const tpls = [
      { type: "transport", dangers: ["safe", "low"], cargo: [8, 60], fp: [0, 0], dur: [3, 8], reward: [600, 2200], itemChance: 0.1, stockChance: 0.28 },
      { type: "escort", dangers: ["low", "moderate"], cargo: [0, 0], fp: [40, 150], dur: [4, 9], reward: [1800, 5000], itemChance: 0.3, stockChance: 0.1 },
      { type: "combat", dangers: ["moderate", "high"], cargo: [0, 0], fp: [90, 320], dur: [5, 10], reward: [4000, 11000], itemChance: 0.5, stockChance: 0.1 },
      { type: "smuggle", dangers: ["moderate", "high", "extreme"], cargo: [10, 45], fp: [20, 120], dur: [5, 12], reward: [5000, 14000], itemChance: 0.45, stockChance: 0.1, impound: true },
      { type: "assassinate", dangers: ["high", "extreme"], cargo: [0, 0], fp: [150, 520], dur: [6, 12], reward: [9000, 24000], itemChance: 0.7, stockChance: 0 },
    ];
    const tpl = tpls[Math.floor(this._u01(s, 1) * tpls.length) % tpls.length];
    const danger = tpl.dangers[Math.floor(this._u01(s, 2) * tpl.dangers.length) % tpl.dangers.length];
    const pay = (DANGER.find(d => d.id === danger) || { pay: 1 }).pay;
    const ri = (lo, hi, n) => lo + Math.floor(this._u01(s, n) * (hi - lo + 1));
    const fp = tpl.fp[1] > 0 ? ri(tpl.fp[0], tpl.fp[1], 5) : 0;
    const cargo = tpl.cargo[1] > 0 ? ri(tpl.cargo[0], tpl.cargo[1], 6) : 0;
    return {
      id: `ct-${epoch}-${slot}`, kind: "job", type: tpl.type, status: "open",
      title: `${tpl.type} contract #${slot}`,
      desc: "A seeded board contract.",
      sysName: `Sector ${1 + (Math.floor(this._u01(s, 3) * 20) % 20)}`,
      danger, faction: factions[Math.floor(this._u01(s, 4) * factions.length) % factions.length],
      stakeTier: stake, impound: !!tpl.impound,
      minFirepower: Math.round(fp * reqMult),
      cargoRequired: Math.round(cargo * reqMult),
      durationMs: ri(tpl.dur[0], tpl.dur[1], 7) * 60 * 1000,
      reward: {
        credits: Math.round(ri(tpl.reward[0], tpl.reward[1], 8) * pay * stakeMult / 10) * 10,
        itemChance: tpl.itemChance, stockChance: tpl.stockChance,
      },
    };
  },

  // Authoritative display board: recompute from seed, filter claimed offers.
  fillSeededBoard(now = Date.now()) {
    const b = this.bz();
    const epoch = this.boardEpoch(now);
    const bought = this._boughtSet();
    const tier = window.Economy ? Economy.tier() : 0;
    b.mercs = [];
    for (let i = 0; i < BAZAARCFG.mercSlots; i++) {
      const o = this.genSeededMerc(epoch, i);
      if (!bought.has(o.id)) b.mercs.push(o);
    }
    b.accessories = [];
    for (let i = 0; i < BAZAARCFG.accessorySlots; i++) {
      const o = this.genSeededAccessory(epoch, i);
      if (!bought.has(o.id)) b.accessories.push(o);
    }
    b.contracts = [];
    for (let i = 0; i < BAZAARCFG.contractSlots; i++) {
      const o = this.genSeededContract(epoch, i, tier);
      if (!bought.has(o.id)) b.contracts.push(o);
    }
    b.extractors ||= []; b.components ||= []; b.dossiers ||= [];
    // Extractors/components/dossiers remain local soft content until a later phase.
    while (b.extractors.length < EXTRACTORCFG.bazaarSlots) b.extractors.push(this.genExtractor());
    while (b.components.length < COMPONENTCFG.bazaarSlots) b.components.push(this.genComponent());
    while (window.Senate && b.dossiers.length < SENATECFG.dossierSlots) {
      const d = this.genDossier(now); if (!d) break; b.dossiers.push(d);
    }
  },

  // ---- inventory helpers --------------------------------------------------
  equippedSet() {
    const set = new Set();
    for (const sh of this.s().ships) for (const u of sh.accessories || []) set.add(u);
    return set;
  },
  listedSet() { return new Set(this.s().listings.map(l => l.itemUid)); },
  inventoryItems() {
    const eq = this.equippedSet(), li = this.listedSet();
    return Object.values(this.s().items).filter(it => !eq.has(it.uid) && !li.has(it.uid));
  },
  inventoryUsed() { return this.inventoryItems().length; },
  capacity() { return this.s().inventory.capacity; },

  // ---- generators ---------------------------------------------------------
  genMerc(now) {
    const esc = Util.pick(SHIP_CATALOG.escort);
    return {
      id: "mc" + (++this.s().seq), shipType: esc.id,
      name: `${Util.pick(MERC_PREFIX)} ${Util.pick(MERC_UNIT)}`,
      firepower: esc.firepower, hull: esc.hull,
      serviceMs: Util.randInt(15, 40) * 60 * 1000,
      hireCost: Math.round(esc.price * 0.2 + esc.firepower * 55),
      availUntil: now + Util.randInt(BAZAARCFG.mercTickMs, BAZAARCFG.mercTickMs * 3),
    };
  },

  genAccessory() {
    const item = Items.gen({ bias: Math.random() < 0.15 ? 0.4 : 0 });
    return { id: "ac" + (++this.s().seq), item, price: Math.round(item.value * Util.randFloat(0.95, 1.25)) };
  },

  genExtractor() {
    const ex = Extractors.gen();
    return { id: "exo" + (++this.s().seq), ex, price: Extractors.price(ex) };
  },
  genComponent() {
    const c = Components.gen();
    return { id: "cpo" + (++this.s().seq), comp: c, price: Components.price(c) };
  },

  // A "dossier" on a senator whose stances are still hidden — buy it to unlock
  // their positions + voting record in the Senate roster.
  genDossier(now) {
    if (!window.Senate) return null;
    const candidates = Senate.roster().filter(sn => !Senate.revealed(sn.id));
    if (!candidates.length) return null;
    const sn = Util.pick(candidates);
    return { id: "dos" + (++this.s().seq), senatorId: sn.id, name: sn.name, title: sn.title,
      bloc: Senate.blocNow(sn), systemName: sn.systemName,
      price: Util.randInt(SENATECFG.dossierMinPrice, SENATECFG.dossierMaxPrice) + sn.weight * 600,
      expiresAt: now + BAZAARCFG.contractExpiryMs * 2 };
  },

  genContract(now) {
    const tpl = Util.pick(CONTRACT_TEMPLATES);
    const sys = Util.pick(Galaxy.list);
    const comm = Util.pick(COMMODITIES);
    const fill = t => t.replace(/\{SYS\}/g, sys.name).replace(/\{COMM\}/g, comm.name)
      .replace(/\{CAT\}/g, comm.cat).replace(/\{NAME\}/g, Util.pick(NPCS).handle);
    const base = { id: "ct" + (++this.s().seq), kind: tpl.kind, type: tpl.type,
      title: fill(Util.pick(tpl.titles)), desc: fill(tpl.desc), sysName: sys.name,
      createdAt: now, expiresAt: now + BAZAARCFG.contractExpiryMs, status: "open" };
    if (tpl.kind === "tip") {
      base.cat = comm.cat;
      base.faction = Rep.factionForCategory(comm.cat);
      base.cost = Util.randInt(tpl.cost[0], tpl.cost[1]);
      return base;
    }
    const danger = Util.pick(tpl.danger);
    base.faction = Rep.sponsor(tpl.type, comm.cat);
    // top-tier jobs require you to be Friendly with the sponsor first
    if (Rep.gated(tpl.type, danger) && !Rep.meetsGate(base.faction)) return null;
    const pay = (DANGER.find(d => d.id === danger) || { pay: 1 }).pay;
    base.danger = danger;
    // higher Baron Tiers raise the stakes: bigger pay + steeper requirements + bigger risk
    const stakeTier = window.Economy ? Economy.tier() : 0;
    base.stakeTier = stakeTier;
    const reqMult = 1 + stakeTier * BAZAARCFG.tierReqMult, stakeMult = 1 + stakeTier * BAZAARCFG.tierStakeMult;
    base.minFirepower = Math.round((tpl.fp ? Util.randInt(tpl.fp[0], tpl.fp[1]) : 0) * reqMult);
    base.cargoRequired = Math.round(((tpl.cargo && tpl.cargo !== 0) ? Util.randInt(tpl.cargo[0], tpl.cargo[1]) : 0) * reqMult);
    base.durationMs = Util.randInt(tpl.dur[0], tpl.dur[1]) * 60 * 1000;
    base.impound = !!tpl.impound;
    base.reward = {
      credits: Math.round(Util.randInt(tpl.reward.credits[0], tpl.reward.credits[1]) * pay * stakeMult / 10) * 10,
      itemChance: tpl.reward.itemChance || 0,
      stockChance: tpl.reward.stockChance || 0,
    };
    // contracts raised while their sponsor is at war pay a "war effort" bonus
    if (window.Wars && Wars.atWar(base.faction, now)) {
      base.warEffort = true;
      base.reward.credits = Math.round(base.reward.credits * (1 + WARCFG.contractBonus));
    }
    return base;
  },

  // ---- lifecycle ----------------------------------------------------------
  ensure(now = Date.now()) {
    if (this.authoritative()) { this.fillSeededBoard(now); return; }
    const b = this.bz();
    b.mercs ||= []; b.contracts ||= []; b.accessories ||= []; b.extractors ||= []; b.components ||= [];
    while (b.mercs.length < BAZAARCFG.mercSlots) b.mercs.push(this.genMerc(now));
    while (b.accessories.length < BAZAARCFG.accessorySlots) b.accessories.push(this.genAccessory());
    while (b.extractors.length < EXTRACTORCFG.bazaarSlots) b.extractors.push(this.genExtractor());
    while (b.components.length < COMPONENTCFG.bazaarSlots) b.components.push(this.genComponent());
    b.dossiers ||= [];
    while (window.Senate && b.dossiers.length < SENATECFG.dossierSlots) { const d = this.genDossier(now); if (!d) break; b.dossiers.push(d); }
    const openCount = () => b.contracts.filter(c => c.status === "open").length;
    let tries = 0;
    while (openCount() < BAZAARCFG.contractSlots && tries++ < 60) {
      const c = this.genContract(now);
      if (c) b.contracts.push(c);
    }
  },

  tick(now = Date.now()) {
    if (this.authoritative()) {
      // Seeded board: just refresh epoch + listing payouts (listings still soft).
      const sold = [];
      this.s().listings = this.s().listings.filter(l => {
        if (now >= l.sellAt) {
          const it = this.s().items[l.itemUid];
          if (it) { this.s().credits += l.listPrice; sold.push({ name: it.name, price: l.listPrice }); delete this.s().items[l.itemUid]; }
          return false;
        }
        return true;
      });
      this.fillSeededBoard(now);
      if (sold.length) { Economy.refreshNetWorth(); for (const sl of sold) Bus.emit("listingSold", sl); }
      return sold;
    }
    const b = this.bz();
    // mercs expire from the board
    b.mercs = b.mercs.filter(m => m.availUntil > now);
    // accessories + extractors occasionally get bought by NPCs
    b.accessories = b.accessories.filter(a => Math.random() > 0.06);
    b.extractors = (b.extractors || []).filter(a => Math.random() > 0.04);
    b.components = (b.components || []).filter(a => Math.random() > 0.05);
    b.dossiers = (b.dossiers || []).filter(d => d.expiresAt > now && !(window.Senate && Senate.revealed(d.senatorId)));
    // contracts: expire, get taken by NPCs, and clear after lingering
    for (const c of b.contracts) {
      if (c.status === "open") {
        if (now > c.expiresAt) c.status = "expired";
        else if (c.kind === "job" && now - c.createdAt > BAZAARCFG.contractNpcTakeMs && Math.random() < 0.04) {
          c.status = "taken_npc"; c.takenAt = now;
        }
      } else if (c.status === "taken_npc" && now - c.takenAt > BAZAARCFG.contractTakenShowMs) {
        c.status = "gone";
      }
    }
    b.contracts = b.contracts.filter(c => c.status === "open" || c.status === "taken_npc");
    // your market listings sell to NPCs after the hidden delay
    const sold = [];
    this.s().listings = this.s().listings.filter(l => {
      if (now >= l.sellAt) {
        const it = this.s().items[l.itemUid];
        if (it) { this.s().credits += l.listPrice; sold.push({ name: it.name, price: l.listPrice }); delete this.s().items[l.itemUid]; }
        return false;
      }
      return true;
    });
    this.ensure(now);
    if (sold.length) { Economy.refreshNetWorth(); for (const sl of sold) Bus.emit("listingSold", sl); }
    return sold;
  },

  // ---- purchases ----------------------------------------------------------
  _buyShipLocal(catalogId) {
    const def = Fleet.shipDef(catalogId); const s = this.s();
    if (!def || def.cls === "main") return { ok: false, msg: "Unknown ship." };
    const cap = window.Economy ? Economy.fleetCap() : 99;
    if ((s.ships || []).length >= cap) return { ok: false, msg: `Fleet at capacity (${cap}) — ascend a Baron Tier to command more.` };
    const price = Math.round(def.price * (1 - Rep.discount()));
    if (price > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= price;
    s.ships.push(Fleet.makeShip(catalogId));
    Economy.refreshNetWorth(); Economy.checkAchievements();
    Bus.emit("shipBuy", { type: catalogId });
    return { ok: true };
  },
  buyShip(catalogId) {
    if (!this.authoritative()) return this._buyShipLocal(catalogId);
    return Economy._withRpc(
      () => this._buyShipLocal(catalogId),
      () => Cloud.buyShip(catalogId),
      "Couldn't reach the bazaar — try again."
    );
  },

  // Resale value of an owned ship: a fraction of its catalog price (the free
  // starter hull is 0) plus the resale value of everything bolted to it — the
  // gear is sold along with the hull.
  shipSaleValue(sh) {
    if (!sh) return 0;
    const def = Fleet.shipDef(sh.type);
    const hull = Math.max(0, (def?.price || 0) * BAZAARCFG.shipResaleMult - Fleet.repairCost(sh)); // buyers dock the repair bill
    const gear = (sh.accessories || []).reduce((n, uid) => {
      const it = this.s().items[uid]; return n + (it ? it.value * BAZAARCFG.itemResaleMult : 0);
    }, 0);
    return Math.round(hull + gear);
  },
  _sellShipLocal(uid) {
    const s = this.s();
    const sh = Fleet.ship(uid);
    if (!sh) return { ok: false, msg: "Ship not found." };
    if (sh.mercenary) return { ok: false, msg: "Mercenaries are rented, not owned." };
    if (sh.status !== "idle") return { ok: false, msg: "Ship is busy — recall it first." };
    const credits = this.shipSaleValue(sh);
    const soldGear = (sh.accessories || []).length;
    for (const itemUid of sh.accessories || []) delete s.items[itemUid];  // installed gear goes with the ship
    s.ships = s.ships.filter(x => x.uid !== uid);
    s.credits += credits;
    Economy.refreshNetWorth();
    return { ok: true, credits, soldGear };
  },
  sellShip(uid) {
    if (!this.authoritative()) return this._sellShipLocal(uid);
    return Economy._withRpc(
      () => this._sellShipLocal(uid),
      () => Cloud.sellShip(uid),
      "Couldn't reach the bazaar — try again."
    );
  },

  _buyMainLocal(catalogId) {
    const def = SHIP_CATALOG.main.find(x => x.id === catalogId); const s = this.s();
    if (!def) return { ok: false, msg: "Unknown flagship." };
    if (def.id === s.mainShip.type) return { ok: false, msg: "Already your flagship." };
    const price = Math.round(def.price * (1 - Rep.discount()));
    if (price > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= price;
    s.mainShip = { type: def.id };
    Economy.refreshNetWorth();
    return { ok: true };
  },
  buyMain(catalogId) {
    if (!this.authoritative()) return this._buyMainLocal(catalogId);
    return Economy._withRpc(
      () => this._buyMainLocal(catalogId),
      () => Cloud.buyMain(catalogId),
      "Couldn't reach the bazaar — try again."
    );
  },

  _markBought(id) {
    const s = this.s();
    s.bazaarBought = s.bazaarBought || [];
    if (id && !s.bazaarBought.includes(id)) s.bazaarBought.push(id);
  },

  _hireMercLocal(offerId, now = Date.now()) {
    const b = this.bz(); const s = this.s();
    const offer = b.mercs.find(m => m.id === offerId);
    if (!offer) return { ok: false, msg: "Offer gone." };
    const cap = window.Economy ? Economy.fleetCap() : 99;
    if ((s.ships || []).length >= cap) return { ok: false, msg: `Fleet at capacity (${cap}) — ascend a Baron Tier to command more.` };
    if (offer.hireCost > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= offer.hireCost;
    s.ships.push(Fleet.makeShip(offer.shipType, { mercenary: true, expiresAt: now + offer.serviceMs,
      name: offer.name }));
    b.mercs = b.mercs.filter(m => m.id !== offerId);
    this._markBought(offerId);
    Economy.refreshNetWorth();
    Bus.emit("shipBuy", { type: offer.shipType });
    return { ok: true };
  },
  hireMerc(offerId, now = Date.now()) {
    if (!this.authoritative()) return this._hireMercLocal(offerId, now);
    return Economy._withRpc(
      () => this._hireMercLocal(offerId, now),
      () => Cloud.buyMerc(offerId),
      "Couldn't reach the bazaar — try again."
    );
  },

  _buyAccessoryLocal(offerId) {
    const b = this.bz(); const s = this.s();
    const offer = b.accessories.find(a => a.id === offerId);
    if (!offer) return { ok: false, msg: "Sold to another buyer." };
    if (this.inventoryUsed() >= this.capacity()) return { ok: false, msg: "Inventory full." };
    const price = Math.round(offer.price * (1 - Rep.discount()));
    if (price > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= price;
    s.items[offer.item.uid] = offer.item;
    b.accessories = b.accessories.filter(a => a.id !== offerId);
    this._markBought(offerId);
    Economy.refreshNetWorth();
    return { ok: true, item: offer.item };
  },
  buyAccessory(offerId) {
    if (!this.authoritative()) return this._buyAccessoryLocal(offerId);
    return Economy._withRpc(
      () => this._buyAccessoryLocal(offerId),
      () => Cloud.buyAccessory(offerId),
      "Couldn't reach the bazaar — try again."
    );
  },

  buyExtractor(offerId) {
    const b = this.bz(); const s = this.s();
    const offer = (b.extractors || []).find(o => o.id === offerId);
    if (!offer) return { ok: false, msg: "Sold to another buyer." };
    const price = Math.round(offer.price * (1 - Rep.discount()));
    if (price > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= price;
    Extractors.acquire(offer.ex);
    b.extractors = b.extractors.filter(o => o.id !== offerId);
    Economy.refreshNetWorth();
    return { ok: true, ex: offer.ex };
  },
  buyComponent(offerId) {
    const b = this.bz(); const s = this.s();
    const offer = (b.components || []).find(o => o.id === offerId);
    if (!offer) return { ok: false, msg: "Sold to another buyer." };
    const price = Math.round(offer.price * (1 - Rep.discount()));
    if (price > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= price;
    Components.acquire(offer.comp);
    b.components = b.components.filter(o => o.id !== offerId);
    Economy.refreshNetWorth();
    return { ok: true, comp: offer.comp };
  },

  buyDossier(offerId) {
    const b = this.bz(), s = this.s();
    const offer = (b.dossiers || []).find(d => d.id === offerId);
    if (!offer || !window.Senate) return { ok: false, msg: "Dossier withdrawn." };
    if (Senate.revealed(offer.senatorId)) { b.dossiers = b.dossiers.filter(d => d.id !== offerId); return { ok: false, msg: "Already on file." }; }
    const price = Math.round(offer.price * (1 - Rep.discount()));
    if (price > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= price;
    Senate.reveal(offer.senatorId);
    b.dossiers = b.dossiers.filter(d => d.id !== offerId);
    Economy.refreshNetWorth();
    return { ok: true, name: offer.name };
  },

  upgradeInventoryCost() {
    const lvl = this.s().inventory.upgrades || 0;
    return Math.round(BAZAARCFG.inventoryUpgradeBase * Math.pow(1.8, lvl));
  },
  _buyInventoryUpgradeLocal() {
    const s = this.s(); const cost = this.upgradeInventoryCost();
    if (cost > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= cost;
    s.inventory.upgrades = (s.inventory.upgrades || 0) + 1;
    s.inventory.capacity += BAZAARCFG.inventoryUpgradeStep;
    Economy.refreshNetWorth();
    return { ok: true };
  },
  buyInventoryUpgrade() {
    if (!this.authoritative()) return this._buyInventoryUpgradeLocal();
    return Economy._withRpc(
      () => this._buyInventoryUpgradeLocal(),
      () => Cloud.upgradeInventory(),
      "Couldn't reach the bazaar — try again."
    );
  },

  // ---- contracts ----------------------------------------------------------
  _takeContractLocal(id, now = Date.now()) {
    const b = this.bz();
    const c = b.contracts.find(x => x.id === id && x.status === "open");
    if (!c) return { ok: false, msg: "Contract no longer available." };
    if (c.kind === "tip") {
      if (c.cost > this.s().credits) return { ok: false, msg: "Not enough credits." };
      this.s().credits -= c.cost;
      const lead = Util.randInt(CONFIG.omenLeadMinMs, CONFIG.omenLeadMaxMs) / (window.Game.timeScale || 1);
      if (window.Broadcast) Broadcast.scheduleNews(c.cat, lead);
      Feed.emit(`insider tip secured — a ${c.cat} story is brewing out of ${c.sysName} 👀`, { kind: "omen" });
      b.contracts = b.contracts.filter(x => x.id !== id);
      this._markBought(id);
      Economy.refreshNetWorth();
      return { ok: true, tip: true, cat: c.cat };
    }
    // job: remove from board; auth path also parks it in pendingContracts
    b.contracts = b.contracts.filter(x => x.id !== id);
    this._markBought(id);
    const s = this.s();
    s.pendingContracts = s.pendingContracts || [];
    if (!s.pendingContracts.some(x => x.id === id)) s.pendingContracts.push(c);
    return { ok: true, contract: c };
  },
  takeContract(id, now = Date.now()) {
    if (!this.authoritative()) return this._takeContractLocal(id, now);
    return Economy._withRpc(
      () => this._takeContractLocal(id, now),
      () => Cloud.takeContract(id),
      "Couldn't reach the bazaar — try again."
    );
  },

  // ---- player item sales -------------------------------------------------
  // Listing items for sale was retired; you sell instantly via sellNow. The
  // tick() resolver + cancelListing remain so any listings already saved before
  // the feature was removed still pay out or can be cancelled (no stranded gear).
  _sellNowLocal(itemUid) {
    const it = this.s().items[itemUid]; if (!it) return { ok: false };
    if (this.equippedSet().has(itemUid)) return { ok: false, msg: "Unequip it first." };
    const credits = Math.round(it.value * BAZAARCFG.itemResaleMult);
    this.s().credits += credits; delete this.s().items[itemUid];
    Economy.refreshNetWorth();
    return { ok: true, credits };
  },
  sellNow(itemUid) {
    if (!this.authoritative()) return this._sellNowLocal(itemUid);
    return Economy._withRpc(
      () => this._sellNowLocal(itemUid),
      () => Cloud.sellItem(itemUid),
      "Couldn't reach the bazaar — try again."
    );
  },
  cancelListing(itemUid) {
    this.s().listings = this.s().listings.filter(l => l.itemUid !== itemUid);
    return { ok: true };
  },

  // total value of all owned items (for net worth)
  itemsValue() { return Object.values(this.s().items).reduce((n, it) => n + (it.value || 0), 0); },
};

window.Bazaar = Bazaar;
