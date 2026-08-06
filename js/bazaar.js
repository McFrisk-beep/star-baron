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
  // Deterministic pick from a pool — keeps seeded board flavor consistent across
  // clients/reloads (unlike Util.pick, which is random). Use a fresh index `n`.
  _pick(seed, n, arr) { return arr[Math.floor(this._u01(seed, n) * arr.length) % arr.length]; },

  // Hireable escorts. Workshop-only hulls (craftOnly) are never on the roster —
  // the server's merc fixture rolls from the sellable escorts only.
  mercPool() { return SHIP_CATALOG.escort.filter(e => !e.craftOnly); },

  genSeededMerc(epoch, slot) {
    const s = this._seed(["merc", String(epoch), String(slot)]);
    const escorts = this.mercPool();
    const esc = escorts[Math.floor(this._u01(s, 0) * escorts.length) % escorts.length];
    return {
      id: `mc-${epoch}-${slot}`,
      shipType: esc.id,
      // flavor company name (e.g. "Iron Talons") — cosmetic, seeded so it stays stable
      name: `${this._pick(s, 10, MERC_PREFIX)} ${this._pick(s, 11, MERC_UNIT)}`,
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
    // flavor name (e.g. 'Vex Mk.III Shield Cell "Tempest"') — cosmetic, mirrors Items._name
    const mk = ["I", "II", "III", "IV", "V"][Math.floor(this._u01(s, 10) * 5) % 5];
    let nm = `${this._pick(s, 11, ITEM_BRANDS)} Mk.${mk} ${k.label}`;
    if (rarity === "epic") nm += ` "${this._pick(s, 12, ITEM_SUFFIXES)}"`;
    const item = {
      uid: `i${epoch}a${slot}`, kind: kindId, rarity,
      name: nm,
      primary: { stat: k.stat, amount, pct: k.pct, kind: kindId },
      bonus: null,
    };
    item.value = Items.value(item);
    const price = Math.round(item.value * (0.95 + this._u01(s, 3) * 0.30));
    return { id: `ac-${epoch}-${slot}`, item, price };
  },

  // Blackboxes and blueprints run on their OWN, much slower clock (24h by
  // default). They're permanent power — a blueprint unlocks a recipe forever and
  // a blackbox is a stacked timed buff — so churning them on the 60s board epoch
  // meant a player with credits could refresh their way through the whole pool in
  // an afternoon. One day's stock, and a bought slot stays bought (bazaarBought
  // keys off the offer id, which now only changes once a day).
  slowEpochMs() { return BAZAARCFG.slowRotationMs || 24 * 60 * 60 * 1000; },
  slowEpoch(now = Date.now()) { return Math.floor(now / this.slowEpochMs()); },
  // ms until the next blackbox/blueprint restock — shown on the Gear tab.
  slowRestockMs(now = Date.now()) { return (this.slowEpoch(now) + 1) * this.slowEpochMs() - now; },

  // Rare rotating blackbox offers (soft/local — like dossiers; not server ledger).
  genSeededBlackbox(epoch, slot) {
    const s = this._seed(["bb", String(epoch), String(slot)]);
    const effects = typeof BLACKBOX_EFFECTS !== "undefined" ? BLACKBOX_EFFECTS : [];
    if (!effects.length) return null;
    const e = effects[Math.floor(this._u01(s, 0) * effects.length) % effects.length];
    const item = {
      uid: `i${epoch}b${slot}`, kind: "blackbox", rarity: "rare",
      name: `${e.name} Blackbox`, consumable: true, effectId: e.id,
      primary: null, bonus: null, value: Items.blackboxValue(e),
    };
    const price = Math.round(item.value * (1.05 + this._u01(s, 1) * 0.35));
    return { id: `bb-${epoch}-${slot}`, item, price };
  },

  // Rotating blueprint offers (bazaar-source recipes the player doesn't know yet).
  genSeededBlueprint(epoch, slot) {
    const s = this._seed(["bp", String(epoch), String(slot)]);
    const pool = (window.Workshop ? Workshop.dropPool("bazaar") : BLUEPRINTS.filter(b => b.source === "bazaar"));
    if (!pool.length) return null;
    const bp = pool[Math.floor(this._u01(s, 0) * pool.length) % pool.length];
    const price = Math.round(12000 * (0.9 + this._u01(s, 1) * 0.8) * (bp.destroyOnUse ? 4 : 1));
    return { id: `bp-${epoch}-${slot}`, blueprintId: bp.id, name: bp.name, outputType: bp.outputType, price };
  },

  // The day's blackbox + blueprint shelf. Shared by the seeded (signed-in) and
  // local (guest) boards — both are soft/local content, so there's one code path
  // and one clock. Anything already bought this epoch stays off the shelf.
  fillSlowStock(now = Date.now()) {
    const b = this.bz(), bought = this._boughtSet(), epoch = this.slowEpoch(now);
    b.blackboxes = [];
    for (let i = 0; i < (BAZAARCFG.blackboxSlots || 0); i++) {
      const o = this.genSeededBlackbox(epoch, i);
      if (o && !bought.has(o.id)) b.blackboxes.push(o);
    }
    b.blueprints = [];
    for (let i = 0; i < (BAZAARCFG.blueprintSlots || 0); i++) {
      const o = this.genSeededBlueprint(epoch, i);
      if (o && !bought.has(o.id)) b.blueprints.push(o);
    }
  },

  // ---- shipyard shelf -----------------------------------------------------
  // Named, refitted hulls that rotate as a set every BAZAARCFG.yardRotationMs.
  // Seeded off the epoch so every client (and a reload) shows the same shelf.
  //
  // Price is the plain catalog price: app_buy_ship charges from the SQL catalog
  // and knows nothing about refits, so a variant-adjusted sticker would bill the
  // player for credits the server never took. That's also why SHIP_VARIANTS are
  // all trade-offs — see the note there before adding a strictly-better refit.
  yardEpochMs() { return BAZAARCFG.yardRotationMs || 5 * 60 * 1000; },
  yardEpoch(now = Date.now()) { return Math.floor(now / this.yardEpochMs()); },
  yardRestockMs(now = Date.now()) { return (this.yardEpoch(now) + 1) * this.yardEpochMs() - now; },
  // Hulls the yard may stock: everything sellable that isn't blueprint-gated.
  yardPool() {
    return [...SHIP_CATALOG.transport, ...SHIP_CATALOG.escort, ...(SHIP_CATALOG.survey || [])]
      .filter(d => !d.craftOnly && d.price > 0);
  },
  genSeededYardShip(epoch, slot) {
    const s = this._seed(["yard", String(epoch), String(slot)]);
    const pool = this.yardPool();
    if (!pool.length) return null;
    const def = pool[Math.floor(this._u01(s, 0) * pool.length) % pool.length];
    const variants = Fleet.variantsFor(def.cls);
    // An admin can edit SHIP_VARIANTS to empty via the content CMS — fall back to
    // an unrefitted hull rather than putting an undefined refit on the shelf.
    const variant = variants.length
      ? variants[Math.floor(this._u01(s, 1) * variants.length) % variants.length]
      : { id: "stock" };
    return {
      id: `sy-${epoch}-${slot}`,
      shipType: def.id,
      variantId: variant.id,
      // Pre-named so the shelf reads as individual second-hand ships, not a
      // catalog. The name follows the ship into the fleet (Fleet.setVariant).
      name: `${this._pick(s, 10, SHIP_NAME_A)} ${this._pick(s, 11, SHIP_NAME_B)}`,
      price: def.price,
    };
  },
  // The whole shelf, minus anything already bought this rotation. Two slots that
  // roll the same hull AND the same refit are the same ship twice, which just
  // reads as a bug — drop the repeat and let the shelf run a little short.
  fillYard(now = Date.now()) {
    const b = this.bz(), bought = this._boughtSet(), seen = new Set();
    b.yard = [];
    for (let i = 0; i < (BAZAARCFG.yardSlots || 8); i++) {
      const o = this.genSeededYardShip(this.yardEpoch(now), i);
      if (!o || bought.has(o.id)) continue;
      const key = `${o.shipType}:${o.variantId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      b.yard.push(o);
    }
  },

  // Seeded extractor offer — mirrors app.gen_extractor in phase3 SQL.
  genSeededExtractor(epoch, slot) {
    const s = this._seed(["ex", String(epoch), String(slot)]);
    const cats = ["mineral", "gas", "agri", "tech", "luxury", "illicit"];
    // Non-craftOnly pool — must match app.gen_extractor (phase3_pull_prestige.sql).
    const tradeable = COMMODITIES.filter(c => !c.craftOnly);
    const r = this._u01(s, 0);
    let type, scope, price;
    if (r < 0.45) { type = "specialized"; scope = tradeable[Math.floor(this._u01(s, 1) * tradeable.length) % tradeable.length].id; price = EXTRACTORCFG.types.specialized.price; }
    else if (r < 0.80) { type = "semi"; scope = cats[Math.floor(this._u01(s, 1) * 6) % 6]; price = EXTRACTORCFG.types.semi.price; }
    else { type = "jack"; scope = "all"; price = EXTRACTORCFG.types.jack.price; }
    // flavor name (e.g. "Volkov Iron Borer") — cosmetic, mirrors Extractors.name, seeded
    const mfr = this._pick(s, 10, EXTRACTOR_MFR);
    const suf = this._pick(s, 11, EXTRACTOR_SUFFIX[type] || EXTRACTOR_SUFFIX.jack);
    const core = type === "specialized" ? ((COMMODITIES.find(c => c.id === scope) || {}).name || scope)
      : type === "semi" ? (scope[0].toUpperCase() + scope.slice(1))
        : this._pick(s, 12, EXTRACTOR_JACK_CORE);
    const name = `${mfr} ${core} ${suf}`;
    return { id: `ex-${epoch}-${slot}`, ex: { uid: `ex${epoch}x${slot}`, type, scope, name, components: [] }, price };
  },
  // Rotating flagship offers (excludes free starter + currently owned).
  genSeededFlagship(epoch, slot) {
    const s = this._seed(["flag", String(epoch), String(slot)]);
    const owned = this.s().mainShip && this.s().mainShip.type;
    const pool = SHIP_CATALOG.main.filter(d => d.price > 0 && d.id !== owned);
    if (!pool.length) return null;
    // Weight toward mid tiers; legendaries are rare on the board.
    const roll = this._u01(s, 0);
    let rarity = "common";
    if (roll >= 0.45 && roll < 0.75) rarity = "uncommon";
    else if (roll >= 0.75 && roll < 0.92) rarity = "rare";
    else if (roll >= 0.92 && roll < 0.98) rarity = "epic";
    else if (roll >= 0.98) rarity = "legendary";
    let band = pool.filter(d => (d.rarity || "common") === rarity);
    if (!band.length) band = pool;
    const def = band[Math.floor(this._u01(s, 1) * band.length) % band.length];
    const price = Math.round(def.price * (0.95 + this._u01(s, 2) * 0.15));
    return { id: `fg-${epoch}-${slot}`, shipType: def.id, price, rarity: def.rarity || "common" };
  },
  genFlagship() {
    const owned = this.s().mainShip && this.s().mainShip.type;
    const pool = SHIP_CATALOG.main.filter(d => d.price > 0 && d.id !== owned);
    if (!pool.length) return null;
    const def = Util.pick(pool);
    return { id: "fg" + (++this.s().seq), shipType: def.id, price: Math.round(def.price * Util.randFloat(0.95, 1.1)), rarity: def.rarity || "common" };
  },

  // Seeded component offer — mirrors app.gen_component in phase3 SQL.
  genSeededComponent(epoch, slot) {
    const s = this._seed(["cp", String(epoch), String(slot)]);
    const kind = this._u01(s, 0) < 0.5 ? "rate" : "speed";
    const roll = this._u01(s, 1) * 100;
    let rarity;
    if (roll < 50) rarity = "common"; else if (roll < 78) rarity = "uncommon";
    else if (roll < 92) rarity = "rare"; else if (roll < 98) rarity = "epic"; else rarity = "legendary";
    const rar = RARITIES.find(x => x.id === rarity) || RARITIES[0];
    const base = kind === "rate" ? COMPONENTCFG.rateBase : COMPONENTCFG.speedBase;
    const amount = +(base * rar.mult).toFixed(3);
    return {
      id: `cp-${epoch}-${slot}`,
      // flavor name (e.g. "Cygnus Yield Booster") — cosmetic, mirrors Components.gen, seeded
      comp: { uid: `cp${epoch}c${slot}`, kind, rarity, amount, name: `${this._pick(s, 10, EXTRACTOR_MFR)} ${COMPONENTCFG.kinds[kind].label}` },
      price: Math.round(COMPONENTCFG.priceBase * rar.price),
    };
  },

  genSeededContract(epoch, slot, tier = 0) {
    const s = this._seed(["ct", String(epoch), String(slot)]);
    const stake = tier | 0;
    const reqMult = 1 + stake * BAZAARCFG.tierReqMult;
    const stakeMult = 1 + stake * BAZAARCFG.tierStakeMult;
    const factions = Object.keys(FACTIONS);
    // Cosmetic display flavor: real system / commodity / broker names + CONTRACT_TEMPLATES
    // titles+desc, all seeded so they stay stable. Mechanical fields are untouched below.
    const sysList = (window.Galaxy && Galaxy.list) || [];
    const sysName = sysList.length ? this._pick(s, 20, sysList).name : `Sector ${1 + (Math.floor(this._u01(s, 2) * 20) % 20)}`;
    const comm = this._pick(s, 21, COMMODITIES);
    const broker = (window.NPCS && NPCS.length) ? this._pick(s, 22, NPCS).handle : "a broker";
    const flavor = type => (window.CONTRACT_TEMPLATES || []).find(t => t.type === type) || null;
    const fill = (t, cat) => t.replace(/\{SYS\}/g, sysName).replace(/\{COMM\}/g, comm.name)
      .replace(/\{CAT\}/g, cat || comm.cat).replace(/\{NAME\}/g, broker);
    // Offer window matches mercs / app.offer_epoch_ok (current + previous epoch).
    const createdAt = epoch * this.boardEpochMs;
    const expiresAt = (epoch + 2) * this.boardEpochMs;
    if (this._u01(s, 0) < 0.16) {
      const cat = ["mineral", "gas", "agri", "tech", "luxury", "illicit"][Math.floor(this._u01(s, 1) * 6) % 6];
      const ft = flavor("insider");
      return {
        id: `ct-${epoch}-${slot}`, kind: "tip", type: "insider", status: "open",
        title: ft ? fill(this._pick(s, 23, ft.titles), cat) : "Insider whisper",
        desc: ft ? fill(ft.desc, cat) : "Pay for a tip and front-run the newswire.",
        cat,
        sysName,
        faction: factions[Math.floor(this._u01(s, 3) * factions.length) % factions.length],
        cost: 1500 + Math.floor(this._u01(s, 4) * 7501),
        stakeTier: stake,
        createdAt, expiresAt,
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
    const ft = flavor(tpl.type);
    return {
      id: `ct-${epoch}-${slot}`, kind: "job", type: tpl.type, status: "open",
      title: ft ? fill(this._pick(s, 23, ft.titles)) : `${tpl.type} contract #${slot}`,
      desc: ft ? fill(ft.desc) : "A seeded board contract.",
      sysName,
      danger, faction: factions[Math.floor(this._u01(s, 4) * factions.length) % factions.length],
      stakeTier: stake, impound: !!tpl.impound,
      minFirepower: Math.round(fp * reqMult),
      cargoRequired: Math.round(cargo * reqMult),
      durationMs: ri(tpl.dur[0], tpl.dur[1], 7) * 60 * 1000,
      reward: {
        credits: Math.round(ri(tpl.reward[0], tpl.reward[1], 8) * pay * stakeMult / 10) * 10,
        itemChance: tpl.itemChance, stockChance: tpl.stockChance,
      },
      createdAt, expiresAt,
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
    this.fillSlowStock(now);   // blackboxes + blueprints, on the 24h clock
    this.fillYard(now);        // named/refitted hulls, on the 5min clock
    b.contracts = [];
    for (let i = 0; i < BAZAARCFG.contractSlots; i++) {
      const o = this.genSeededContract(epoch, i, tier);
      if (!bought.has(o.id)) b.contracts.push(o);
    }
    b.extractors = [];
    for (let i = 0; i < EXTRACTORCFG.bazaarSlots; i++) {
      const o = this.genSeededExtractor(epoch, i);
      if (!bought.has(o.id)) b.extractors.push(o);
    }
    b.components = [];
    for (let i = 0; i < COMPONENTCFG.bazaarSlots; i++) {
      const o = this.genSeededComponent(epoch, i);
      if (!bought.has(o.id)) b.components.push(o);
    }
    b.flagships = [];
    for (let i = 0; i < (BAZAARCFG.flagshipSlots || 4); i++) {
      const o = this.genSeededFlagship(epoch, i);
      if (o && !bought.has(o.id)) b.flagships.push(o);
    }
    b.dossiers ||= [];
    // Dossiers remain local soft content (Senate flavor, no credit impact).
    while (window.Senate && b.dossiers.length < SENATECFG.dossierSlots) {
      const d = this.genDossier(now); if (!d) break; b.dossiers.push(d);
    }
    this._injectStationContracts(now);
  },

  // Station Contract Office hauls ride the same board (docs/STATIONS.md §11).
  _injectStationContracts(now = Date.now()) {
    if (!window.Stations || !Stations.boardContracts) return;
    const b = this.bz();
    b.contracts ||= [];
    const have = new Set(b.contracts.map(c => c.id));
    for (const c of Stations.boardContracts(now)) {
      if (!have.has(c.id)) b.contracts.push(c);
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
    // With hauling, only gear in the hold or the docked bay is "in inventory".
    if (window.Assets) {
      return Assets.localGear().filter(it => !eq.has(it.uid) && !li.has(it.uid));
    }
    return Object.values(this.s().items).filter(it => !eq.has(it.uid) && !li.has(it.uid));
  },
  inventoryUsed() {
    if (window.Assets) {
      const s = this.s();
      if (s.travel) return Assets.slotsUsed(Assets.hold());
      return Assets.slotsUsed(Assets.bay(s.currentSystem));
    }
    return this.inventoryItems().length;
  },
  capacity() {
    if (window.Assets) {
      const s = this.s();
      return s.travel ? Assets.holdCapacity() : Assets.bayCapacity(s.currentSystem);
    }
    return this.s().inventory.capacity;
  },

  // ---- generators ---------------------------------------------------------
  genMerc(now) {
    const esc = Util.pick(this.mercPool());
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
    b.mercs ||= []; b.contracts ||= []; b.accessories ||= []; b.blackboxes ||= []; b.blueprints ||= [];
    b.extractors ||= []; b.components ||= []; b.flagships ||= [];
    while (b.mercs.length < BAZAARCFG.mercSlots) b.mercs.push(this.genMerc(now));
    while (b.accessories.length < BAZAARCFG.accessorySlots) b.accessories.push(this.genAccessory());
    this.fillSlowStock(now);   // blackboxes + blueprints, same 24h shelf as signed-in play
    this.fillYard(now);        // shipyard shelf, same 5min rotation as signed-in play
    while (b.extractors.length < EXTRACTORCFG.bazaarSlots) b.extractors.push(this.genExtractor());
    while (b.components.length < COMPONENTCFG.bazaarSlots) b.components.push(this.genComponent());
    while (b.flagships.length < (BAZAARCFG.flagshipSlots || 4)) {
      const o = this.genFlagship(); if (!o) break; b.flagships.push(o);
    }
    b.dossiers ||= [];
    while (window.Senate && b.dossiers.length < SENATECFG.dossierSlots) { const d = this.genDossier(now); if (!d) break; b.dossiers.push(d); }
    const openCount = () => b.contracts.filter(c => c.status === "open").length;
    let tries = 0;
    while (openCount() < BAZAARCFG.contractSlots && tries++ < 60) {
      const c = this.genContract(now);
      if (c) b.contracts.push(c);
    }
    this._injectStationContracts(now);
  },

  tick(now = Date.now()) {
    // Phase 3: listing payouts are app_pull. Same softIncomeLocal gate as
    // charters — don't mint local credits while the server ledger owns them.
    if (this.authoritative() && window.Economy && !Economy.softIncomeLocal()) {
      this.fillSeededBoard(now);
      return [];
    }
    if (this.authoritative()) {
      // Phase 3 SQL not live yet — keep listing payouts soft (Phase 2 behaviour).
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
    // NOT blackboxes/blueprints — they're on the 24h shelf now (fillSlowStock),
    // and NPC churn would hand the player a free reroll of the day's stock.
    b.extractors = (b.extractors || []).filter(a => Math.random() > 0.04);
    b.components = (b.components || []).filter(a => Math.random() > 0.05);
    b.flagships = (b.flagships || []).filter(a => Math.random() > 0.08);
    b.dossiers = (b.dossiers || []).filter(d => d.expiresAt > now && !(window.Senate && Senate.revealed(d.senatorId)));
    // contracts: expire, get taken by NPCs, and clear after lingering.
    // Station hauls expire/fill via Stations — don't NPC-snatch them here.
    for (const c of b.contracts) {
      if (c.source === "station") continue;
      if (c.status === "open") {
        if (now > c.expiresAt) c.status = "expired";
        else if (c.kind === "job" && now - c.createdAt > BAZAARCFG.contractNpcTakeMs && Math.random() < 0.04) {
          c.status = "taken_npc"; c.takenAt = now;
        }
      } else if (c.status === "taken_npc" && now - c.takenAt > BAZAARCFG.contractTakenShowMs) {
        c.status = "gone";
      }
    }
    b.contracts = b.contracts.filter(c =>
      c.status === "open" || c.status === "taken_npc" || (c.source === "station" && c.status === "open"));
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
  // `offer` is a shipyard shelf entry (name + refit) when the buy came from the
  // rotating yard; the free starter hull passes none.
  _buyShipLocal(catalogId, offer) {
    const def = Fleet.shipDef(catalogId); const s = this.s();
    if (!def || def.cls === "main") return { ok: false, msg: "Unknown ship." };
    if (def.craftOnly) return { ok: false, msg: "Blueprint-only hull — build it in the Workshop." };
    const cap = window.Economy ? Economy.fleetCap() : 99;
    if ((s.ships || []).length >= cap) return { ok: false, msg: `Fleet at capacity (${cap}) — ascend a Baron Tier to command more.` };
    const price = Math.round(def.price * (1 - Rep.discount()));
    if (price > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= price;
    s.ships.push(Fleet.makeShip(catalogId, offer ? { name: offer.name } : {}));
    Economy.refreshNetWorth(); Economy.checkAchievements();
    Bus.emit("shipBuy", { type: catalogId });
    return { ok: true };
  },
  buyShip(catalogId, offer) {
    if (!this.authoritative()) {
      const before = this._shipUids();
      const r = this._buyShipLocal(catalogId, offer);
      if (r.ok) this._adoptYardShip(catalogId, offer, before);
      return r;
    }
    const before = this._shipUids();
    return Economy._withRpc(
      () => this._buyShipLocal(catalogId, offer),
      () => Cloud.buyShip(catalogId),
      "Couldn't reach the bazaar — try again."
    ).then(r => { if (r && r.ok) this._adoptYardShip(catalogId, offer, before); return r; });
  },

  // Buy a specific hull off the shipyard shelf (the normal path — only the free
  // starter hull is bought by catalog id).
  buyYardShip(offerId) {
    const offer = (this.bz().yard || []).find(o => o.id === offerId);
    if (!offer) return { ok: false, msg: "That ship just sold." };
    return this.buyShip(offer.shipType, offer);
  },

  _shipUids() { return new Set((this.s().ships || []).map(sh => sh.uid)); },
  // Pin the offer's refit + name onto the hull that just landed in the fleet.
  //
  // We can't do this inside _buyShipLocal: when the server owns the fleet, the
  // optimistic ship is thrown away and app_buy_ship's reply supplies the real
  // roster with a SERVER-assigned uid. So diff the roster around the purchase
  // and claim whichever hull of this type is new. If several arrive at once
  // (shouldn't happen — Economy serialises RPCs), take the last, which is the
  // one app_buy_ship appended.
  _adoptYardShip(catalogId, offer, before) {
    if (!offer) return;
    const added = (this.s().ships || []).filter(sh => sh && sh.type === catalogId && !before.has(sh.uid));
    const sh = added[added.length - 1];
    if (!sh) return;
    Fleet.setVariant(sh.uid, offer.variantId, offer.name);
    sh.name = offer.name;
    this.bz().yard = (this.bz().yard || []).filter(o => o.id !== offer.id);
    this._markBought(offer.id);
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
    Fleet.pruneVariants();     // the refit record goes with the hull
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

  _buyMainLocal(catalogId, offerId) {
    const def = SHIP_CATALOG.main.find(x => x.id === catalogId); const s = this.s();
    if (!def) return { ok: false, msg: "Unknown flagship." };
    if (def.id === s.mainShip.type) return { ok: false, msg: "Already your flagship." };
    const offer = offerId && (s.bazaar.flagships || []).find(o => o.id === offerId);
    const sticker = offer ? offer.price : def.price;
    const price = Math.round(sticker * (1 - Rep.discount()));
    if (price > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= price;
    s.mainShip = { type: def.id };
    if (offer) s.bazaar.flagships = (s.bazaar.flagships || []).filter(o => o.id !== offerId);
    // Downsizing never deletes cargo — spill hold overflow into the local bay
    // (overfull bay is allowed; HAULING.md §3).
    if (window.Assets && !s.travel) this._spillHoldToBay(s.currentSystem);
    Economy.refreshNetWorth();
    return { ok: true };
  },
  _spillHoldToBay(systemId) {
    if (!window.Assets || !systemId) return;
    const hold = Assets.hold(), cap = Assets.holdCapacity();
    while (Assets.slotsUsed(hold) > cap) {
      // Prefer moving a commodity block, then gear.
      const ids = Object.keys(hold.blocks).filter(id => (hold.blocks[id] || 0) > 0);
      if (ids.length) {
        const id = ids[0];
        const size = Assets.blockSize(id);
        const qty = Math.min(hold.blocks[id], size);
        Assets.transfer("hold", systemId, "block", id, qty);
        continue;
      }
      if (hold.gear.length) {
        Assets.transfer("hold", systemId, "gear", hold.gear[0], 1);
        continue;
      }
      break;
    }
  },
  buyMain(catalogId, offerId) {
    if (!this.authoritative()) return this._buyMainLocal(catalogId, offerId);
    return Economy._withRpc(
      () => this._buyMainLocal(catalogId, offerId),
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
    if (window.Assets) Assets.parkGear(offer.item.uid, s.currentSystem);
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

  // Soft/local like dossiers — blackboxes aren't on the server ledger yet.
  // Client merge on commit/bootstrap keeps them across cloud sync (see Store.mergeSoftItems).
  buyBlackbox(offerId) {
    const b = this.bz(); const s = this.s();
    const offer = (b.blackboxes || []).find(a => a.id === offerId);
    if (!offer) return { ok: false, msg: "Sold to another buyer." };
    if (this.inventoryUsed() >= this.capacity()) return { ok: false, msg: "Inventory full." };
    const price = Math.round(offer.price * (1 - Rep.discount()));
    if (price > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= price;
    s.items[offer.item.uid] = offer.item;
    if (window.Assets) Assets.parkGear(offer.item.uid, s.currentSystem);
    b.blackboxes = b.blackboxes.filter(a => a.id !== offerId);
    this._markBought(offerId);
    Economy.refreshNetWorth();
    return { ok: true, item: offer.item };
  },

  buyBlueprint(offerId) {
    const b = this.bz(); const s = this.s();
    const offer = (b.blueprints || []).find(a => a.id === offerId);
    if (!offer) return { ok: false, msg: "Sold to another buyer." };
    if (!window.Workshop) return { ok: false, msg: "Workshop unavailable." };
    const price = Math.round(offer.price * (1 - Rep.discount()));
    if (price > s.credits) return { ok: false, msg: "Not enough credits." };
    const r = Workshop.grantBlueprint(offer.blueprintId);
    if (!r.ok) return r;
    s.credits -= price;
    b.blueprints = b.blueprints.filter(a => a.id !== offerId);
    this._markBought(offerId);
    Economy.refreshNetWorth();
    return { ok: true, blueprint: r.blueprint, name: offer.name };
  },

  _buyExtractorLocal(offerId) {
    const b = this.bz(); const s = this.s();
    const offer = (b.extractors || []).find(o => o.id === offerId);
    if (!offer) return { ok: false, msg: "Sold to another buyer." };
    const price = Math.round(offer.price * (1 - Rep.discount()));
    if (price > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= price;
    Extractors.acquire(JSON.parse(JSON.stringify(offer.ex)));
    b.extractors = b.extractors.filter(o => o.id !== offerId);
    if (this.authoritative()) (s.bazaarBought ||= []).push(offerId);
    Economy.refreshNetWorth();
    return { ok: true, ex: offer.ex };
  },
  buyExtractor(offerId) {
    if (!this.authoritative()) return this._buyExtractorLocal(offerId);
    return Economy._withRpc(
      () => this._buyExtractorLocal(offerId),
      () => Cloud.buyExtractor(offerId),
      "Couldn't reach the bazaar — try again."
    );
  },
  _buyComponentLocal(offerId) {
    const b = this.bz(); const s = this.s();
    const offer = (b.components || []).find(o => o.id === offerId);
    if (!offer) return { ok: false, msg: "Sold to another buyer." };
    const price = Math.round(offer.price * (1 - Rep.discount()));
    if (price > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= price;
    Components.acquire(JSON.parse(JSON.stringify(offer.comp)));
    b.components = b.components.filter(o => o.id !== offerId);
    if (this.authoritative()) (s.bazaarBought ||= []).push(offerId);
    Economy.refreshNetWorth();
    return { ok: true, comp: offer.comp };
  },
  buyComponent(offerId) {
    if (!this.authoritative()) return this._buyComponentLocal(offerId);
    return Economy._withRpc(
      () => this._buyComponentLocal(offerId),
      () => Cloud.buyComponent(offerId),
      "Couldn't reach the bazaar — try again."
    );
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
  // Claim a job at Launch time only (View Contract does not reserve it).
  // Accepts a board-open job or a legacy pendingContracts entry.
  async claimForLaunch(contract) {
    const s = this.s();
    const id = contract && contract.id;
    if (!id) return { ok: false, msg: "Invalid contract." };
    const pending = s.pendingContracts || [];
    const held = pending.find(c => c.id === id);
    if (held) return { ok: true, contract: held, fromPending: true };
    if ((contract && contract.source === "station") || (id && String(id).startsWith("sc"))) {
      if (!window.Stations) return { ok: false, msg: "Contract no longer available." };
      const r = await Stations.claimHaulForLaunch(id);
      if (!r.ok) return r;
      const b = this.bz();
      b.contracts = (b.contracts || []).filter(x => x.id !== id);
      return { ok: true, contract: r.contract, fromPending: false };
    }
    const b = this.bz();
    const onBoard = (b.contracts || []).find(x => x.id === id && x.status === "open" && x.kind !== "tip");
    if (!onBoard) return { ok: false, msg: "Contract no longer available." };
    b.contracts = b.contracts.filter(x => x.id !== id);
    this._markBought(id);
    return { ok: true, contract: onBoard, fromPending: false };
  },

  // Tips only from the board button. Jobs are claimed at Launch (claimForLaunch).
  _takeContractLocal(id, now = Date.now()) {
    const b = this.bz();
    const c = b.contracts.find(x => x.id === id && x.status === "open");
    if (!c) return { ok: false, msg: "Contract no longer available." };
    if (c.kind !== "tip") {
      // Jobs stay on the board until Launch — View Contract is preview-only.
      return { ok: true, contract: c, preview: true };
    }
    if (c.cost > this.s().credits) return { ok: false, msg: "Not enough credits." };
    this.s().credits -= c.cost;
    const lead = Util.randInt(CONFIG.omenLeadMinMs, CONFIG.omenLeadMaxMs) / (window.Game.timeScale || 1);
    if (window.Broadcast) Broadcast.scheduleNews(c.cat, lead);
    Feed.emit(`insider tip secured — a ${c.cat} story is brewing out of ${c.sysName} 👀`, { kind: "omen" });
    b.contracts = b.contracts.filter(x => x.id !== id);
    this._markBought(id);
    Economy.refreshNetWorth();
    return { ok: true, tip: true, cat: c.cat };
  },
  takeContract(id, now = Date.now()) {
    if (!this.authoritative()) return this._takeContractLocal(id, now);
    return Economy._withRpc(
      () => this._takeContractLocal(id, now),
      () => Cloud.takeContract(id),
      "Couldn't reach the bazaar — try again."
    );
  },

  // Fee to drop a taken-but-not-launched bazaar job (scales with Baron Tier).
  cancelFee(contract) {
    const reward = (contract && contract.reward && contract.reward.credits) || 0;
    const tier = window.Economy ? Economy.tier() : 0;
    const rate = BAZAARCFG.cancelFeeRate || 0.1;
    const tierM = BAZAARCFG.cancelFeeTierMult || 0.35;
    const min = BAZAARCFG.cancelFeeMin || 250;
    return Math.max(min, Math.round(reward * rate * (1 + tier * tierM)));
  },

  _cancelPendingLocal(id) {
    const s = this.s();
    const list = s.pendingContracts || [];
    const c = list.find(x => x.id === id);
    if (!c) return { ok: false, msg: "Contract not in hand." };
    const fee = this.cancelFee(c);
    if (fee > s.credits) return { ok: false, msg: `Need ${Util.credits(fee)}c to cancel.` };
    s.credits -= fee;
    s.pendingContracts = list.filter(x => x.id !== id);
    Economy.refreshNetWorth();
    return { ok: true, fee, contract: c };
  },
  cancelPending(id) {
    if (!this.authoritative()) return this._cancelPendingLocal(id);
    return Economy._withRpc(
      () => this._cancelPendingLocal(id),
      () => Cloud.cancelPendingContract(id),
      "Couldn't cancel contract — try again."
    );
  },

  // ---- player item sales -------------------------------------------------
  // Listing items for sale was retired; you sell instantly via sellNow. The
  // tick() resolver + cancelListing remain so any listings already saved before
  // the feature was removed still pay out or can be cancelled (no stranded gear).
  _sellNowLocal(itemUid) {
    const it = this.s().items[itemUid]; if (!it) return { ok: false };
    if (this.equippedSet().has(itemUid)) return { ok: false, msg: "Unequip it first." };
    if (window.Assets) {
      const loc = Assets.gearLocation(itemUid);
      if (!loc) return { ok: false, msg: "Item isn't in a bay you can access." };
      const s = this.s();
      if (loc !== "hold" && (s.travel || loc !== s.currentSystem))
        return { ok: false, msg: "Dock where the item is stored to sell it." };
      Assets.withdraw(loc === "hold" ? "hold" : loc, "gear", itemUid);
    }
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
