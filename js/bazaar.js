/* bazaar.js — the marketplace. Buy ships (transports + permanent escorts) and
   flagships, hire time-limited mercenaries, take contracts (jobs + insider
   tips), and trade procedurally-generated accessories. Listings live and churn:
   contracts expire or get taken by NPCs; accessories get bought out from under
   you; and items you list sell to NPCs after a hidden delay.                   */

const Bazaar = {
  s() { return window.Game.state; },
  bz() { return this.s().bazaar; },

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
      base.cost = Util.randInt(tpl.cost[0], tpl.cost[1]);
      return base;
    }
    const danger = Util.pick(tpl.danger);
    const pay = (DANGER.find(d => d.id === danger) || { pay: 1 }).pay;
    base.danger = danger;
    base.minFirepower = tpl.fp ? Util.randInt(tpl.fp[0], tpl.fp[1]) : 0;
    base.cargoRequired = (tpl.cargo && tpl.cargo !== 0) ? Util.randInt(tpl.cargo[0], tpl.cargo[1]) : 0;
    base.durationMs = Util.randInt(tpl.dur[0], tpl.dur[1]) * 60 * 1000;
    base.impound = !!tpl.impound;
    base.reward = {
      credits: Math.round(Util.randInt(tpl.reward.credits[0], tpl.reward.credits[1]) * pay / 10) * 10,
      itemChance: tpl.reward.itemChance || 0,
      stockChance: tpl.reward.stockChance || 0,
    };
    return base;
  },

  // ---- lifecycle ----------------------------------------------------------
  ensure(now = Date.now()) {
    const b = this.bz();
    b.mercs ||= []; b.contracts ||= []; b.accessories ||= [];
    while (b.mercs.length < BAZAARCFG.mercSlots) b.mercs.push(this.genMerc(now));
    while (b.accessories.length < BAZAARCFG.accessorySlots) b.accessories.push(this.genAccessory());
    const openCount = () => b.contracts.filter(c => c.status === "open").length;
    while (openCount() < BAZAARCFG.contractSlots) b.contracts.push(this.genContract(now));
  },

  tick(now = Date.now()) {
    const b = this.bz();
    // mercs expire from the board
    b.mercs = b.mercs.filter(m => m.availUntil > now);
    // accessories occasionally get bought by NPCs
    b.accessories = b.accessories.filter(a => Math.random() > 0.06);
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
  buyShip(catalogId) {
    const def = Fleet.shipDef(catalogId); const s = this.s();
    if (!def || def.cls === "main") return { ok: false, msg: "Unknown ship." };
    if (def.price > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= def.price;
    s.ships.push(Fleet.makeShip(catalogId));
    Economy.refreshNetWorth(); Economy.checkAchievements();
    Bus.emit("shipBuy", { type: catalogId });
    return { ok: true };
  },

  buyMain(catalogId) {
    const def = SHIP_CATALOG.main.find(x => x.id === catalogId); const s = this.s();
    if (!def) return { ok: false, msg: "Unknown flagship." };
    if (def.id === s.mainShip.type) return { ok: false, msg: "Already your flagship." };
    if (def.price > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= def.price;
    s.mainShip = { type: def.id };
    Economy.refreshNetWorth();
    return { ok: true };
  },

  hireMerc(offerId, now = Date.now()) {
    const b = this.bz(); const s = this.s();
    const offer = b.mercs.find(m => m.id === offerId);
    if (!offer) return { ok: false, msg: "Offer gone." };
    if (offer.hireCost > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= offer.hireCost;
    s.ships.push(Fleet.makeShip(offer.shipType, { mercenary: true, expiresAt: now + offer.serviceMs,
      name: offer.name }));
    b.mercs = b.mercs.filter(m => m.id !== offerId);
    Economy.refreshNetWorth();
    Bus.emit("shipBuy", { type: offer.shipType });
    return { ok: true };
  },

  buyAccessory(offerId) {
    const b = this.bz(); const s = this.s();
    const offer = b.accessories.find(a => a.id === offerId);
    if (!offer) return { ok: false, msg: "Sold to another buyer." };
    if (this.inventoryUsed() >= this.capacity()) return { ok: false, msg: "Inventory full." };
    if (offer.price > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= offer.price;
    s.items[offer.item.uid] = offer.item;
    b.accessories = b.accessories.filter(a => a.id !== offerId);
    Economy.refreshNetWorth();
    return { ok: true, item: offer.item };
  },

  upgradeInventoryCost() {
    const lvl = this.s().inventory.upgrades || 0;
    return Math.round(BAZAARCFG.inventoryUpgradeBase * Math.pow(1.8, lvl));
  },
  buyInventoryUpgrade() {
    const s = this.s(); const cost = this.upgradeInventoryCost();
    if (cost > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= cost;
    s.inventory.upgrades = (s.inventory.upgrades || 0) + 1;
    s.inventory.capacity += BAZAARCFG.inventoryUpgradeStep;
    Economy.refreshNetWorth();
    return { ok: true };
  },

  // ---- contracts ----------------------------------------------------------
  takeContract(id, now = Date.now()) {
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
      Economy.refreshNetWorth();
      return { ok: true, tip: true };
    }
    // job: remove from board and hand back to the UI for ship selection
    b.contracts = b.contracts.filter(x => x.id !== id);
    return { ok: true, contract: c };
  },

  // ---- player item listings ----------------------------------------------
  sellNow(itemUid) {
    const it = this.s().items[itemUid]; if (!it) return { ok: false };
    if (this.equippedSet().has(itemUid)) return { ok: false, msg: "Unequip it first." };
    const credits = Math.round(it.value * 0.55);
    this.s().credits += credits; delete this.s().items[itemUid];
    Economy.refreshNetWorth();
    return { ok: true, credits };
  },
  list(itemUid, now = Date.now()) {
    const it = this.s().items[itemUid]; if (!it) return { ok: false };
    if (this.equippedSet().has(itemUid)) return { ok: false, msg: "Unequip it first." };
    if (this.listedSet().has(itemUid)) return { ok: false, msg: "Already listed." };
    const listPrice = Math.round(it.value * Util.randFloat(1.1, 1.45));
    const sellAt = now + Util.randInt(BAZAARCFG.listingMinMs, BAZAARCFG.listingMaxMs);
    this.s().listings.push({ itemUid, listPrice, sellAt });
    return { ok: true, listPrice };
  },
  cancelListing(itemUid) {
    this.s().listings = this.s().listings.filter(l => l.itemUid !== itemUid);
    return { ok: true };
  },

  // total value of all owned items (for net worth)
  itemsValue() { return Object.values(this.s().items).reduce((n, it) => n + (it.value || 0), 0); },
};

window.Bazaar = Bazaar;
