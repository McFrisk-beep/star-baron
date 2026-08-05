/* main.js — bootstrap + game loop + wiring. Owns the single in-memory `state`
   and drives the schedulers. All persistence goes through Store.              */

const Game = {
  state: null,
  timeScale: 1,
  _saveTimer: null,
  _audioCtx: null,
  _moveAt: {},   // throttle market-move chatter per commodity

  defaultState() {
    return {
      v: 2,
      appliedResetEpoch: 0,        // last admin-issued global reset this save has applied
      credits: CONFIG.startingCredits,
      currentSystem: "navos",
      positions: {},
      avgCost: {},
      // Hauling ledger (docs/HAULING.md) — positions is the derived total.
      hold: { blocks: {}, gear: [] },
      stationInv: {},
      shipments: [],
      _haulingMigrated: true,
      mainShip: { type: "pinnace" },
      ships: [{ uid: "s1", type: "mule", cls: "transport", name: "Old Faithful",
        status: "idle", accessories: [], mercenary: false, expiresAt: null, retrieveCost: 0 }],
      missions: [], reports: [], listings: [], orders: [], charters: [], expeditions: [], surveyed: {}, industries: [], extractors: {}, components: {}, items: {},
      activeBoosts: [],   // [{ effectId, expiresAt }] — blackbox timed buffs (CRAFTING_AND_MATERIALS §2)
      knownRecipes: [],   // recipe ids unlocked by blueprints (Workshop)
      craftedOnce: [],    // one-of-a-kind recipes already completed
      workshop: { upgrades: 0, queue: [] },
      inventory: { capacity: (typeof STATION_BAY_BASE !== "undefined" ? STATION_BAY_BASE : 50), upgrades: 0 },
      bazaar: { mercs: [], contracts: [], accessories: [], blackboxes: [], blueprints: [], extractors: [], components: [], flagships: [], yard: [] },
      shipVariants: {},   // ship uid → { v: SHIP_VARIANTS id, name } — the yard refit a hull was bought with
      pendingContracts: [],
      bazaarBought: [],
      travel: null,
      seq: 1,
      unlockedSystems: SYSTEMS.filter(s => s.unlock === 0).map(s => s.id),
      reputation: Object.fromEntries(Object.keys(FACTIONS).map(f => [f, 0])),
      achievements: [],
      prestige: { tier: 0, multiplier: 1.0 },
      stats: { trades: 0, contractsDone: 0, peakNetWorth: CONFIG.startingCredits, biggestTrade: 0 },
      newswire: [],
      rivals: null,          // seeded lazily by Rivals.ensure()
      rivalsMeta: null,
      senate: window.Senate ? Senate.defaultState() : null,
      story: { prog: {}, inbox: [], unread: 0, lastArrivalAt: 0, taxBreakPct: 0, taxBreakUntil: 0, flags: {}, ephemeral: {} },
      settings: { muted: false, volume: 0.25, reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches, tutorialSeen: false, lang: "en" },
      lastSeenAt: Date.now(),
      market: null,
      galaxy: null,
      stock: null,
      stations: null,
    };
  },

  // Fill any missing keys so old saves survive config growth.
  migrate(loaded) {
    const def = this.defaultState();
    const s = Object.assign({}, def, loaded);
    // Validate untrusted save shape (localStorage / cloud sync) BEFORE anything
    // iterates these fields: a corrupted or tampered save with a wrong-typed
    // field (e.g. ships:null) used to throw here and brick boot forever, since
    // every reload re-loaded the same bad save. Wrong-typed collections fall back
    // to the default; credits is coerced to a finite, non-negative number.
    if (!Array.isArray(s.ships)) s.ships = def.ships;
    if (!Array.isArray(s.unlockedSystems)) s.unlockedSystems = def.unlockedSystems;
    if (!Array.isArray(s.achievements)) s.achievements = def.achievements;
    if (!s.positions || typeof s.positions !== "object") s.positions = {};
    if (!s.avgCost || typeof s.avgCost !== "object") s.avgCost = {};
    if (typeof s.currentSystem !== "string") s.currentSystem = def.currentSystem;
    s.credits = Number.isFinite(+s.credits) ? Math.max(0, +s.credits) : def.credits;
    s.stats = Object.assign({}, def.stats, loaded.stats);
    s.prestige = Object.assign({}, def.prestige, loaded.prestige);
    s.settings = Object.assign({}, def.settings, loaded.settings);
    // Pre-BGM saves have no `volume` key and defaulted muted:true — unmute so
    // existing players hear the playlist without hunting for the icon.
    if (loaded.settings && loaded.settings.volume === undefined && loaded.settings.muted === true)
      s.settings.muted = false;
    if (s.settings.volume == null || !Number.isFinite(+s.settings.volume)) s.settings.volume = 0.25;
    s.settings.volume = Util.clamp(+s.settings.volume, 0, 1);
    s.settings.muted = !!s.settings.muted;
    if (window.Senate) {
      const ls = loaded.senate || {};
      s.senate = Object.assign(Senate.defaultState(), ls);
      // refresh queued (unvoted) bills once so old saves get the rebalanced mild/rare mix
      if ((ls.gen || 0) < Senate.BILLGEN) { Senate.regenUpcoming(s.senate); s.senate.gen = Senate.BILLGEN; }
    }
    // v1 → v2: the fleet model changed shape; reset fleet/bazaar/items but keep
    // credits, positions, unlocks, achievements, prestige, stats, world.
    if ((loaded.v || 1) < 2) {
      s.mainShip = def.mainShip; s.ships = def.ships; s.missions = []; s.reports = [];
      s.listings = []; s.items = {}; s.inventory = def.inventory; s.bazaar = def.bazaar;
      s.travel = null; s.seq = Math.max(2, loaded.seq || 1); s.v = 2;
      delete s.avgCost; s.avgCost = (loaded.avgCost && typeof loaded.avgCost === "object") ? loaded.avgCost : {};
    }
    s.missions ||= []; s.reports ||= []; s.listings ||= []; s.orders ||= []; s.expeditions ||= []; s.surveyed ||= {}; s.industries ||= []; s.extractors ||= {}; s.components ||= {}; s.items ||= {};
    // Trade routes retired → Charter Contracts. Free any hull left on a route.
    if (Array.isArray(s.ships)) for (const sh of s.ships) if (sh.status === "trading") sh.status = "idle";
    delete s.routes;
    // Validate charter shape at the trust boundary (localStorage / cloud sync).
    const bands = (typeof CHARTER_BANDS !== "undefined" && CHARTER_BANDS) || {};
    const shipUids = new Set(s.ships.map(sh => sh && sh.uid).filter(Boolean));
    const maxShips = (typeof CHARTERCFG !== "undefined" && CHARTERCFG.maxShips) || 6;
    s.charters = (Array.isArray(s.charters) ? s.charters : []).map(c => {
      if (!c || typeof c.id !== "string" || typeof c.band !== "string" || !bands[c.band]) return null;
      if (!(Number.isFinite(+c.durationMs) && +c.durationMs > 0)) return null;
      if (!(Number.isFinite(+c.startedAt) && Number.isFinite(+c.reward) && +c.reward >= 0)) return null;
      if (c.resolved) return null;
      let uids = Array.isArray(c.shipUids) ? c.shipUids.filter(u => typeof u === "string" && shipUids.has(u)) : [];
      if (!uids.length && typeof c.shipUid === "string" && shipUids.has(c.shipUid)) uids = [c.shipUid];
      uids = [...new Set(uids)].slice(0, maxShips);
      if (!uids.length) return null;
      const cargoByShip = {};
      let cargoTotal = 0;
      if (c.cargoByShip && typeof c.cargoByShip === "object") {
        for (const uid of uids) {
          const n = Math.max(0, Math.round(+c.cargoByShip[uid] || 0));
          cargoByShip[uid] = n;
          cargoTotal += n;
        }
      } else if (Number.isFinite(+c.cargoTotal) && +c.cargoTotal >= 0) {
        cargoTotal = Math.round(+c.cargoTotal);
      }
      return {
        id: c.id,
        shipUid: uids[0],
        shipUids: uids,
        band: c.band,
        durationMs: +c.durationMs,
        startedAt: +c.startedAt,
        reward: Math.round(+c.reward),
        cargoByShip,
        cargoTotal,
        faction: (c.faction && FACTIONS[c.faction]) ? c.faction : (bands[c.band].faction || null),
        destroyChance: Util.clamp(+c.destroyChance || 0, 0, 0.85),
        impoundChance: Util.clamp(+c.impoundChance || 0, 0, 0.85),
        impound: !!(bands[c.band].impound > 0),
        resolved: false,
      };
    }).filter(Boolean);
    const onCharter = (uid) => s.charters.some(c =>
      (Array.isArray(c.shipUids) && c.shipUids.includes(uid)) || c.shipUid === uid);
    for (const sh of s.ships) {
      if (sh.status === "charter" && !onCharter(sh.uid))
        sh.status = "idle";
      else if (onCharter(sh.uid) && sh.status !== "impounded")
        sh.status = "charter";
    }
    if (!Array.isArray(s.activeBoosts)) s.activeBoosts = [];
    // Drop expired / unknown boosts so old/corrupt saves don't stick forever.
    s.activeBoosts = s.activeBoosts.filter(b => b && typeof b.effectId === "string" && Number.isFinite(+b.expiresAt) && +b.expiresAt > Date.now());
    // Drop unknown/malformed recipe refs so a tampered or corrupt save can't
    // point at recipes that no longer exist (same treatment as activeBoosts above).
    // If the catalog itself is unavailable, keep every ref instead of filtering
    // them all away — silently wiping real crafting progress is the worse failure.
    const recipeIds = Array.isArray(window.RECIPES) ? new Set(window.RECIPES.map(r => r.id)) : null;
    const knownRecipe = id => !recipeIds || recipeIds.has(id);
    if (!Array.isArray(s.knownRecipes)) s.knownRecipes = [];
    s.knownRecipes = s.knownRecipes.filter(id => typeof id === "string" && knownRecipe(id));
    if (!Array.isArray(s.craftedOnce)) s.craftedOnce = [];
    s.craftedOnce = s.craftedOnce.filter(id => typeof id === "string" && knownRecipe(id));
    if (!s.workshop || typeof s.workshop !== "object") s.workshop = { upgrades: 0, queue: [] };
    if (!Array.isArray(s.workshop.queue)) s.workshop.queue = [];
    s.workshop.queue = s.workshop.queue.filter(j => j && typeof j.id === "string"
      && knownRecipe(j.recipeId) && Number.isFinite(+j.startedAt) && Number.isFinite(+j.readyAt)
      && (j.flavorId === null || typeof j.flavorId === "string"));
    s.workshop.upgrades = Math.max(0, s.workshop.upgrades | 0);
    // story flags / ephemeral survey threads — old saves lack the keys
    s.story ||= { prog: {}, inbox: [], unread: 0, lastArrivalAt: 0, taxBreakPct: 0, taxBreakUntil: 0, flags: {}, ephemeral: {} };
    s.story.prog ||= {}; s.story.inbox ||= []; s.story.flags ||= {}; s.story.ephemeral ||= {};
    // legacy per-ship trade routes (sh.route) were replaced by state.routes — free those ships
    for (const sh of s.ships) if (sh.route) { sh.status = "idle"; delete sh.route; }
    // surveying/debrief ship whose expedition vanished → free it
    for (const sh of s.ships) {
      if ((sh.status === "surveying" || sh.status === "debrief") &&
          !(s.expeditions || []).some(e => e.shipUid === sh.uid && !e.resolved))
        sh.status = "idle";
    }
    // battle damage: default + clamp (saves predate it / could be tampered)
    for (const sh of s.ships) sh.dmg = Util.clamp(+sh.dmg || 0, 0, DMGCFG.maxDmg);
    // Yard refits (state.shipVariants) are a CLIENT-owned slice — app_commit
    // passes the key through untouched, which is the only reason a refit
    // survives the server rebuilding `ships`. That also makes it save data we
    // don't trust: drop entries for hulls that no longer exist, unknown variant
    // ids, and anything that isn't the { v, name } shape, so a tampered or stale
    // save can't invent a refit or a 4KB ship name.
    if (!s.shipVariants || typeof s.shipVariants !== "object" || Array.isArray(s.shipVariants)) s.shipVariants = {};
    {
      const variantIds = Array.isArray(window.SHIP_VARIANTS) ? new Set(SHIP_VARIANTS.map(v => v.id)) : null;
      const hulls = new Set(s.ships.map(sh => sh && sh.uid));
      const clean = {};
      for (const [uid, rec] of Object.entries(s.shipVariants)) {
        if (!hulls.has(uid) || !rec || typeof rec !== "object") continue;
        if (typeof rec.v !== "string" || (variantIds && !variantIds.has(rec.v))) continue;
        clean[uid] = typeof rec.name === "string" && rec.name
          ? { v: rec.v, name: rec.name.slice(0, 40) } : { v: rec.v };
      }
      s.shipVariants = clean;
    }
    s.inventory ||= def.inventory; s.bazaar ||= def.bazaar; s.mainShip ||= def.mainShip;
    s.bazaar.mercs ||= []; s.bazaar.contracts ||= []; s.bazaar.accessories ||= []; s.bazaar.blackboxes ||= [];
    s.bazaar.blueprints ||= []; s.bazaar.yard ||= [];
    s.bazaar.extractors ||= []; s.bazaar.components ||= []; s.bazaar.flagships ||= [];
    // Pass `s` — Game.state isn't assigned yet during migrate. A throw here used
    // to trip init's migrate catch and wipe the whole save (tutorialSeen, Exchange
    // credits/positions, …) on every reload. Keep unlocks best-effort so a
    // Workshop bug can never brick persistence again.
    if (window.Workshop) {
      try { Workshop.ensureAutoUnlocks(s); }
      catch (e) { console.warn("[Game] ensureAutoUnlocks during migrate failed:", e); }
    }
    s.reputation = Object.assign(Object.fromEntries(Object.keys(FACTIONS).map(f => [f, 0])), loaded.reputation || {});
    // Repair Phase-2/3 stub names ("Battleship", "Shield uncommon") left in old saves.
    if (window.Economy && Economy.repairCosmeticNames) Economy.repairCosmeticNames(s);
    // Flat positions/items → hold + station bays (docs/HAULING.md §4).
    // Don't inherit defaultState's `_haulingMigrated: true` — only an explicit
    // flag on the loaded save means migration already ran.
    if (!(loaded && loaded._haulingMigrated)) s._haulingMigrated = false;
    if (window.Assets) {
      try {
        Assets.migrateState(s);
        // Unconditional: park any item with no hold/bay/shipment home (soft-merge
        // blackboxes, equip-detach orphans, etc.). Safe before Game.state is set —
        // parkOrphanGear takes the migrate `s` explicitly.
        Assets.parkOrphanGear(s);
      } catch (e) { console.warn("[Game] Assets.migrateState failed:", e); }
    } else {
      s.hold ||= { blocks: {}, gear: [] };
      s.stationInv ||= {};
      s.shipments = Array.isArray(s.shipments) ? s.shipments : [];
    }
    return s;
  },

  // the admin-issued global-reset counter, shared in Supabase (readable by guests
  // via the anon key). null = cloud not configured / table missing / offline → no reset.
  async fetchResetEpoch() {
    if (!(window.Cloud && Cloud.enabled && Cloud.client)) return null;
    try {
      const { data, error } = await Cloud.client.from("world_reset").select("epoch").eq("id", 1).maybeSingle();
      if (error) throw error;
      return data ? (Number(data.epoch) || 0) : 0;
    } catch (e) { return null; }   // table not set up yet → behave exactly as before
  },
  // a fresh game stamped with the new epoch: 5,000 credits, all owned assets wiped,
  // but the senate (current + passed legislation) and the player's prefs are kept.
  applyAdminReset(loaded, epoch) {
    const fresh = this.defaultState();
    fresh.credits = 5000;
    if (loaded.senate) fresh.senate = loaded.senate;                       // keep senate legislation/history/dossiers
    if (loaded.settings) fresh.settings = Object.assign(fresh.settings, loaded.settings);  // keep mute / reduced-motion
    fresh.appliedResetEpoch = epoch;
    return fresh;
  },
  // one-time "An admin reset has been issued" popup → OK reloads into the fresh game
  showAdminReset() {
    const modal = document.getElementById("reset-modal"), ok = document.getElementById("reset-ok");
    if (!modal || !ok) { location.reload(); return; }
    modal.classList.remove("hidden");
    ok.onclick = () => location.reload();
  },

  async init() {
    // Bring up cloud auth first (if configured) so Store.load can prefer the
    // signed-in player's cloud save; otherwise this is a no-op and we go local.
    if (window.Cloud) { Cloud.init(); await Cloud.restore(); }
    // Apply admin content overrides before anything reads the collections.
    if (window.Content) await Content.load();
    // load the save and the admin-issued global-reset epoch together (both work
    // for guests via the anon key; the epoch is a no-op until the table exists).
    const [loaded, sharedReset] = await Promise.all([Store.load(), this.fetchResetEpoch()]);
    if (loaded && sharedReset != null && sharedReset > (loaded.appliedResetEpoch || 0)) {
      this.state = this.applyAdminReset(loaded, sharedReset);   // credits→5000, owned assets wiped, senate kept
      this._adminReset = true;
      Store.localSave(this.state);
      if (window.Cloud && Cloud.signedIn()) { try { await Cloud.saveRemote(this.state); } catch (e) { console.warn("[reset] cloud persist failed:", e); } }
      console.log("[Game] admin global reset applied (epoch " + sharedReset + ")");
    } else {
      // migrate() validates the loaded shape, but a save corrupted in a way it
      // can't repair must never brick boot (it would re-throw on every reload).
      // Fall back to a fresh game, stashing the unusable save so it's recoverable.
      try {
        this.state = loaded ? this.migrate(loaded) : this.defaultState();
      } catch (e) {
        console.error("[Game] save migration failed — starting fresh:", e);
        // Never clobber an existing backup: a bug that throws on every boot would
        // otherwise overwrite the real save with the already-wiped one on reload #2.
        // First failure wins — that's the copy still holding the player's progress.
        try { if (loaded && !localStorage.getItem("starbaron.corrupt")) localStorage.setItem("starbaron.corrupt", JSON.stringify(loaded)); } catch (_) { /* best-effort backup */ }
        this.state = this.defaultState();
        this._corruptSaveReset = true;
        // Local is backed up above, but the cloud row is the authoritative copy on
        // the next boot — and app_commit accepts a LOWER credits value (it only
        // rejects increases), so autosaving this 1,500c fresh game would overwrite
        // the player's real credits and every client-owned slice (Workshop, story,
        // achievements) server-side. Gate cloud writes exactly like a failed cloud
        // load does; a reload after a real fix still finds the good remote save.
        Store._cloudReady = false;
      }
      if (sharedReset != null) this.state.appliedResetEpoch = Math.max(this.state.appliedResetEpoch || 0, sharedReset);  // new/up-to-date players adopt the current epoch (no reset)
    }
    this.timeScale = 1;
    // resume the galaxy-wide senate before catch-up so it doesn't generate stray local bills
    if (window.Senate && this.state.senate && this.state.senate.shared) Senate.shared = true;

    Market.init();
    Market.volMult = 1;                 // Baron Tiers no longer crank volatility (the market stays calm)
    Market.hydrate(this.state.market);

    // Build the (deterministic) galaxy, then restore its local-news history.
    Galaxy.build();
    Galaxy.hydrate(this.state.galaxy);
    // Sector stock + claimable stations (docs/STATIONS.md). Order: Stock needs
    // Galaxy sectors; Stations.ensure needs Galaxy.list; hydrate after ensure.
    if (window.Stock) {
      Stock.init(Date.now());
      if (this.state.stock) Stock.hydrate(this.state.stock);
    }
    if (window.Stations) Stations.hydrate(this.state.stations);
    Bazaar.ensure();
    Rivals.ensure();

    // ---- offline catch-up (before any feed listeners are wired) ----
    this._booting = true;
    const now = Date.now();
    const elapsed = Util.clamp(now - (this.state.lastSeenAt || now), 0, CONFIG.maxOfflineMs);
    // snapshot "when you left" so the welcome-back recap can show what changed
    const away = { nwBefore: Economy.netWorth(), warBefore: Wars.active(now), senateSince: now - elapsed,
      priceBefore: Object.fromEntries(COMMODITIES.map(c => [c.id, Market.price(c.id)])),
      indBefore: this.state.industries.map(i => ({ id: i.id, systemId: i.systemId, planetIdx: i.planetIdx })) };
    if (elapsed > CONFIG.marketTickMs) Market.advance(elapsed, now);
    // Phase 4: signed-in shelf is server-owned — skip local Stock.advance.
    if (window.Stock && !(window.Economy && Economy.authoritative())) Stock.advance(elapsed, now);
    if (window.Stations) Stations.tick(now);
    const arrival = Economy.checkArrival(now);
    away.customs = (arrival && arrival.customs) || null;   // contraband seized at the gate while away

    let offlineReports, offlineMercs, offlineSold, offlineCharters, offlineOrders, offlineIndustry;
    // Phase 3: logged-in catch-up is server-side (app_pull). Guests stay local.
    // If Phase 3 SQL isn't pasted yet, fall back to the local resolvers.
    let usedPull = false;
    if (window.Economy && Economy.authoritative()) {
      // Hand pre-ledger Workshop state to the server BEFORE anything commits:
      // app_commit forces the workshop slice from the server row, so a queue
      // that hasn't been adopted yet would be erased by the first sync.
      if (window.Workshop) await Workshop.adoptLocal();
      const pulled = await this.pullCatchUp();
      if (pulled) {
        usedPull = true;
        offlineReports = (pulled.resolved || []).concat(pulled.surveys || []);
        offlineSold = pulled.sold || [];
        offlineCharters = []; // charters are client-local until app_charter_* lands
        offlineIndustry = pulled.industry || [];
        offlineMercs = Fleet.pruneMercs(now);
        offlineOrders = await Orders.process();
        if (window.Charters) Charters.reconcileShips();
      }
      // Phase 4: hydrate shared sector shelf (no-op if SQL not pasted yet).
      await this.syncSectorStock();
    }
    if (!usedPull) {
      // softIncomeLocal() is false for logged-in players until app_pull succeeds
      // (or is confirmed missing). That prevents ghost industry stock / charter
      // credits that Phase 3 app_commit and app_trade will reject.
      offlineReports = (await Promise.resolve(Missions.resolveMatured(now))).concat(Expeditions.resolve(now));
      offlineMercs = Fleet.pruneMercs(now);
      offlineSold = Bazaar.tick(now);
      offlineCharters = Charters.resolve(now);
      offlineReports = offlineReports.concat(offlineCharters);
      offlineOrders = await Orders.process();
      offlineIndustry = Industries.resolve(now);
    }
    // Workshop is client-local (not on the Phase-3 ledger yet).
    if (window.Workshop) Workshop.resolve(now);
    // Courier manifests use absolute timestamps — bank arrivals while away.
    if (window.Shipments) Shipments.resolve(now);
    Wars.tick(now);               // resolve a faction war that ended while away
    if (window.Senate) Senate.resolve(now);   // run the daily senate votes while away
    Rivals.tick(now);             // catch the leaderboard up over offline time
    Broadcast.backfill(now, elapsed);   // populate the newswire as if it kept running
    this.state.lastSeenAt = now;

    // ---- UI + flavor wiring ----
    UI.init();
    if (this._corruptSaveReset && UI.toast) UI.toast("Your save couldn't be read and was reset. The old data is kept under localStorage 'starbaron.corrupt', and cloud sync is paused this session so it can't overwrite your saved game. Use Settings → Restore backup when you're ready.", "warn", 12000);
    else if (this.corruptBackupIsRicher() && UI.toast) {
      // Wipe-day survivors: backup still has Workshop gear the live save lost.
      UI.toast("A pre-wipe backup with Workshop progress is in this browser — open Settings → Restore backup to recover it.", "warn", 12000);
    }
    if (window.AuthUI) AuthUI.init();
    if (window.AdminUI) AdminUI.init();
    if (window.Bgm) Bgm.init();
    StarMap.init();
    if (window.Senate) Senate.init();
    if (window.Story) Story.init();
    Feed.wire();
    Feed.prime();                 // fill the chat so it isn't empty on arrival
    UI.fullRender();
    UI.renderNewswire();

    // Local galaxy events: route to the map, and let big trade-hub events leak
    // a "valuable insight" hint into the main chat feed.
    Bus.on("localEvent", entry => {
      StarMap.onLocalEvent(entry);
      if (this._booting) return;
      if (entry.tradeable && Math.random() < 0.7) {
        Feed.emit(`word from ${entry.sysName}: ${entry.headline.toLowerCase()}`, { kind: "omen" });
      }
    });

    Bus.on("missionDone", () => this.requestSave());

    // A senate vote landed during active play — update the chamber / senate tab
    // (no toast: batch offline catch-up used to stack a wall of pop-ups).
    Bus.on("senateVote", bill => {
      if (this._booting) return;
      if (window.Senate && Senate._open && bill.votes) Senate._showVote(bill);   // watch it live if you're in the chamber
      if (UI.page === "senate") UI.renderSenate();
      this.requestSave();
    });

    // Retiring drops you to the bottom of the board — resync rank silently so
    // the reset doesn't spam overtake toasts on the next tick.
    Bus.on("prestige", () => { if (this.state.rivalsMeta) this.state.rivalsMeta.lastRank = Rivals.rank(); });

    // Faction standing crossed a tier — toast + a little in-character chatter.
    Bus.on("rep", e => {
      if (this._booting) return;
      const fac = FACTIONS[e.faction], tier = REP.tiers.find(t => t.id === e.tier);
      UI.toast(`${fac.name}: now ${tier.label}`, e.up ? "good" : "warn", 4000);
      Feed.emit(e.up
        ? `the ${fac.name} are warming to a certain baron — ${tier.label.toLowerCase()} standing now`
        : `you've slipped out of favor with the ${fac.name}…`, { kind: "reaction" });
      this.requestSave();
      if (UI.page === "bazaar") UI.renderBazaar();
    });

    // An admin global reset just landed → tell the player and reload on OK
    // (skips the usual "While You Were Away" recap, which is meaningless here).
    if (this._adminReset) { this._booting = false; this.showAdminReset(); return; }

    // First-run tutorial: show it now for a fresh baron, or queue it to open
    // once the "While You Were Away" modal is dismissed for a returning one.
    this._tutorialPending = !this.state.settings.tutorialSeen;
    const shownWYWA = UI.showWYWA({ elapsedMs: elapsed, reports: offlineReports, sold: offlineSold,
      chartered: offlineCharters, orders: offlineOrders, industry: offlineIndustry, mercs: offlineMercs,
      recap: this.awayRecap(away, now) });
    this._booting = false;
    if (this._tutorialPending && !shownWYWA) { this._tutorialPending = false; UI.openTutorial(); }

    // ---- schedulers ----
    this.startSchedulers();
    if (window.WorldFeed) WorldFeed.init();   // shared, always-on world chat (Supabase cron)
    if (window.Barons) {
      Barons.refresh().then(() => {
        if (Cloud.signedIn && Cloud.signedIn()) return Barons.publish();
      }).finally(() => { if (window.UI) { UI.updateHeader(); if (UI.page === "barons") UI.renderLeaderboard(); } });
      Bus.on("auth", () => {
        Barons.refresh().then(() => {
          if (Cloud.signedIn && Cloud.signedIn()) return Barons.publish();
        }).finally(() => { if (window.UI) { UI.updateHeader(); if (UI.page === "barons") UI.renderLeaderboard(); } });
      });
      Bus.on("prestige", () => { if (Cloud.signedIn && Cloud.signedIn()) Barons.publish(); });
    }
    if (window.Stations) {
      // Who holds which station — the only cross-player view of ownership.
      // Guests read it too (anon RPC), so a signed-out visitor stops seeing
      // every claimed station as NPC.
      const syncStations = () => Stations.refreshDirectory()
        .then(() => Stations.publishOwned())
        // The shared shelf (phase B): move our stalls up, collect what we're
        // owed, read the shelves we can see. Needs the directory first — a
        // station is only shared once its owner has published it.
        .then(() => Stations.syncHall())
        // Shared bay floor (phase C): drop leases the directory says we lost
        // (evicted / station released). Tax cargo arrives via settleHall above.
        .then(() => { Stations.reconcileRemoteLeases(); })
        .finally(() => {
          if (!window.UI) return;
          if (UI.page === "systems") UI.renderSystems();
          const openSys = window.StarMap && StarMap.open && StarMap.current && Galaxy.get(StarMap.current);
          if (openSys) StarMap.renderInfo(openSys);
        });
      void syncStations();
      Bus.on("auth", syncStations);
      // Arriving somewhere is the one moment the shelf in front of us matters.
      Bus.on("dock", () => {
        const sys = Game.state && Game.state.currentSystem;
        if (!sys || !Stations.hallShared(sys)) return;
        void Stations.refreshHalls([sys]).then(() => {
          if (window.StarMap && StarMap.open && StarMap.current === sys) StarMap.renderInfo(Galaxy.get(sys));
        });
      });
    }
    if (window.SenateWorld) SenateWorld.init();   // shared, galaxy-wide senate agenda (Supabase cron)

    // When the tab is backgrounded we suspend ALL work (timers + the star-map
    // animation) so an open tab costs ~nothing over long idle periods; on return
    // we fast-forward the simulation to "now". Keeps the game light indefinitely.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.suspend(); else this.resume();
    });
    window.addEventListener("beforeunload", () => this.save());

    // first paint
    UI.tick();
    console.log("[Cosmocrat] ready. Saves to localStorage. Open Settings for dev toggles.");
  },

  loop() {
    const now = Date.now();
    Market.tick(now);
    if (window.Stock) Stock.tick(now);
    if (window.Stations) Stations.tick(now);
    this.detectMoves();
    if (window.Story) Story.check(now);   // drip storyline messages / pay out finished objectives
    Wars.tick(now);
    const senateBills = window.Senate ? Senate.tick(now) : [];
    Economy.checkArrival(now);
    if (window.Economy && Economy.authoritative()) {
      // Phase 3: soft income banks via app_pull (throttled when something is due).
      // Phase 3 soft income via app_pull when due. Also retry while pull hasn't
      // succeeded yet (unless the RPC is confirmed missing) so we don't sit in
      // a ghost-minting local fallback after a transient pull failure.
      const retryPull = !Cloud.pullReady && !Cloud.pullMissing
        && (now - (this._lastPullTry || 0) > 15000);
      if (!Cloud.pullMissing && !this._pullInflight && (this._softIncomeDue(now) || retryPull)) {
        this._pullInflight = true;
        this._lastPullTry = now;
        void this.pullCatchUp().then(async away => {
          this._pullInflight = false;
          if (window.Charters) Charters.reconcileShips();
          await this.syncSectorStock();
          this.requestSave();
        }).catch(() => { this._pullInflight = false; });
      }
      // Missions still have a dedicated RPC; pull also resolves them — either is fine.
      void Promise.resolve(Missions.resolveMatured(now)).then(done => {
        if (done && done.length) this.requestSave();
      }).catch(e => console.warn("[Missions] resolve failed:", e));
      if (Economy.softIncomeLocal()) {
        const surveyed = Expeditions.resolve(now);
        const chartered = Charters.resolve(now);
        const made = Industries.resolve(now);
        const crafted = window.Workshop ? Workshop.resolve(now) : [];
        const shipped = window.Shipments ? Shipments.resolve(now) : [];
        if (surveyed.length || chartered.length || made.length || crafted.length || shipped.length) this.requestSave();
      } else {
        const shipped = window.Shipments ? Shipments.resolve(now) : [];
        const crafted = window.Workshop ? Workshop.resolve(now) : [];
        if (shipped.length || crafted.length) this.requestSave();
      }
      Fleet.pruneMercs(now);
      Rivals.tick(now);
      Bazaar.tick(now);
      void Orders.process().then(orderEv => {
        for (const ev of orderEv) Bus.emit("order", ev);
        if (orderEv.length) this.requestSave();
      }).catch(e => console.warn("[Orders] process failed:", e));
      if (senateBills.length) this.requestSave();
    } else {
      void Promise.resolve(Missions.resolveMatured(now)).then(done => {
        if (done && done.length) this.requestSave();
      }).catch(e => console.warn("[Missions] resolve failed:", e));
      const surveyed = Expeditions.resolve(now);
      Fleet.pruneMercs(now);
      Rivals.tick(now);
      const chartered = Charters.resolve(now);
      void Orders.process().then(orderEv => {
        for (const ev of orderEv) Bus.emit("order", ev);
        if (orderEv.length) this.requestSave();
      }).catch(e => console.warn("[Orders] process failed:", e));
      const made = Industries.resolve(now);
      const crafted = window.Workshop ? Workshop.resolve(now) : [];
      const shipped = window.Shipments ? Shipments.resolve(now) : [];
      if (surveyed.length || chartered.length || made.length || crafted.length || shipped.length || senateBills.length) this.requestSave();
    }
    UI.tick();
  },

  // ---- lifecycle: run only while the tab is visible -----------------------
  startSchedulers() {
    this.stopSchedulers();   // never double up
    Feed.start();
    Broadcast.start();
    this.scheduleLocalEvent();
    this.scheduleLocalFlavor();
    this.scheduleIncident();
    this.scheduleWar();
    this._loopTimer = setInterval(() => this.loop(), CONFIG.marketTickMs);
    this._autosaveTimer = setInterval(() => this.save(), CONFIG.autosaveMs);
    this._bazaarTimer = setInterval(() => { const sold = Bazaar.tick(Date.now()); if (sold.length) this.requestSave(); }, 12000);
    // slow refresh so relative "X ago" stamps stay current
    this._refreshTimer = setInterval(() => { UI.renderNewswire(); StarMap.refreshFeed(); }, 30000);
  },
  stopSchedulers() {
    Feed.stop();
    if (window.Broadcast) Broadcast.stop();
    clearTimeout(this._localTimer); clearTimeout(this._flavorTimer); clearTimeout(this._incidentTimer); clearTimeout(this._warTimer);
    clearInterval(this._loopTimer); clearInterval(this._autosaveTimer);
    clearInterval(this._bazaarTimer); clearInterval(this._refreshTimer);
    this._loopTimer = this._autosaveTimer = this._bazaarTimer = this._refreshTimer = null;
  },

  // Tab hidden → freeze everything (zero CPU/animation) after a final save.
  suspend() {
    if (this._suspended) return;
    this._suspended = true;
    this.save();                            // local cache + queue cloud
    Store.flush(this.snapshot());           // push to cloud now (best-effort)
    this.stopSchedulers();
    if (window.WorldFeed) WorldFeed.stop();
    if (window.SenateWorld) SenateWorld.stop();
    if (window.StarMap) StarMap.suspend();
    if (window.Senate) Senate.suspend();
    if (window.Bgm) Bgm.pause();
  },
  // Tab visible again → catch the simulation up to real time, then resume.
  resume() {
    if (!this._suspended) return;
    this._suspended = false;
    const now = Date.now();
    const elapsed = Util.clamp(now - (this.state.lastSeenAt || now), 0, CONFIG.maxOfflineMs);
    if (elapsed > CONFIG.marketTickMs) {
      this._booting = true;   // suppress catch-up chatter/toasts
      Market.advance(elapsed, now);
      if (window.Stock) Stock.advance(elapsed, now);
      if (window.Stations) Stations.tick(now);
      Economy.checkArrival(now);
      const finish = () => {
        Wars.tick(now);
        if (window.Senate) Senate.resolve(now);
        Rivals.tick(now);
        this._booting = false;
        this.state.lastSeenAt = now;
        this.startSchedulers();
        if (window.WorldFeed) { WorldFeed.poll(); WorldFeed.start(); }
        if (window.SenateWorld) { SenateWorld.poll(); SenateWorld.start(); }
        UI.tick(); UI.renderNewswire();
        if (window.StarMap) StarMap.resume();
        if (window.Senate) Senate.resume();
        if (window.Bgm) Bgm.applyVolume();
      };
      if (window.Economy && Economy.authoritative()) {
        void this.pullCatchUp().then(async () => {
          if (window.Charters) Charters.reconcileShips();
          await this.syncSectorStock();
          if (Cloud.pullReady || !Economy.softIncomeLocal()) {
            Fleet.pruneMercs(now);
            void Orders.process();
          } else {
            void Promise.resolve(Missions.resolveMatured(now));
            Expeditions.resolve(now);
            Fleet.pruneMercs(now);
            Bazaar.tick(now);
            Charters.resolve(now);
            void Orders.process();
            Industries.resolve(now);
          }
          if (window.Workshop) Workshop.resolve(now);
          finish();
        });
        return;
      }
      void Promise.resolve(Missions.resolveMatured(now));
      Expeditions.resolve(now);
      Fleet.pruneMercs(now);
      Bazaar.tick(now);
      Charters.resolve(now);
      void Orders.process();
      Industries.resolve(now);
      if (window.Workshop) Workshop.resolve(now);
      finish();
      return;
    }
    this.state.lastSeenAt = now;
    this.startSchedulers();
    if (window.WorldFeed) { WorldFeed.poll(); WorldFeed.start(); }   // catch up shared feed
    if (window.SenateWorld) { SenateWorld.poll(); SenateWorld.start(); }   // catch up shared senate
    UI.tick(); UI.renderNewswire();
    if (window.StarMap) StarMap.resume();
    if (window.Senate) Senate.resume();
    if (window.Bgm) Bgm.applyVolume();
  },

  // Phase 4: pull shared sector_stock into local Stock (for UI scarcity / Buy Max).
  async syncSectorStock() {
    if (!(window.Stock && window.Cloud && window.Economy && Economy.authoritative())) return false;
    try {
      const r = await Cloud.sectorStock();
      if (!r || r.ok === false) {
        if (r && r.missing) Stock.markServerShelf(false);
        return false;
      }
      if (r.units) Stock.applyServerUnits(r.units, r.lastTickAt);
      Stock.markServerShelf(true);
      return true;
    } catch (e) {
      if (typeof Cloud._isMissingRpc === "function" && Cloud._isMissingRpc(e)) {
        Stock.markServerShelf(false);
        return false;
      }
      console.warn("[Game] sector stock sync failed:", e);
      return false;
    }
  },

  // Phase 3: bank soft income on the server. Returns the away recap blob or null
  // (null = missing RPC / failure — caller should local-fallback).
  async pullCatchUp() {
    if (!(window.Economy && Economy.authoritative() && window.Cloud)) return null;
    // Cloud.commit bypasses Store._cloudReady — honor the gate here so a
    // corrupt-save / failed-load boot can't push defaultState (1,500c) before
    // the player ever reaches Settings → Restore backup.
    if (!Store._cloudReady) return null;
    try {
      // Soft-sync setup (new industries/expeditions) before pull so the
      // server sees them; credits only decrease (spends), never mint via commit.
      await Cloud.commit(this.snapshot());
      const r = await Cloud.pull();
      if (!r || r.ok === false) {
        console.warn("[Game] app_pull failed:", (r && r.error) || r);
        return null;
      }
      const away = Economy.applyPull(r) || {};
      // Parked surveys / just-resolved contracts → open Dispatches threads.
      if (window.Expeditions && Expeditions.openPendingDebriefs) Expeditions.openPendingDebriefs();
      if (window.MissionStory && MissionStory.openPending)
        MissionStory.openPending(away.resolved || []);
      return away;
    } catch (e) {
      if (typeof Cloud._isMissingRpc === "function" && Cloud._isMissingRpc(e)) {
        Cloud.pullMissing = true;
        console.warn("[Game] app_pull missing — local catch-up (docs/PHASE3_SETUP.md)");
        return null;
      }
      console.warn("[Game] app_pull failed:", e);
      return null;
    }
  },

  // True when a soft-income timer is due (throttle live pulls).
  _softIncomeDue(now = Date.now()) {
    const s = this.state;
    if ((s.missions || []).some(m => !m.resolved && now >= m.startedAt + m.totalMs)) return true;
    if ((s.charters || []).some(c => !c.resolved && now >= c.startedAt + c.durationMs)) return true;
    if ((s.industries || []).some(i => i.nextAt && now >= i.nextAt)) return true;
    if ((s.expeditions || []).some(e => !e.resolved && !e.debrief && now >= e.startedAt + e.etaMs)) return true;
    if ((s.listings || []).some(l => now >= l.sellAt)) return true;
    return false;
  },

  // Emit newHigh/crash chatter when a commodity moves hard (throttled).
  detectMoves() {
    const now = Date.now();
    for (const c of COMMODITIES) {
      const pct = Market.changePct(c.id);
      if (Math.abs(pct) < 6) continue;
      if (now - (this._moveAt[c.id] || 0) < 45000) continue;
      this._moveAt[c.id] = now;
      Bus.emit("marketMove", { commId: c.id, kind: pct > 0 ? "newHigh" : "crash" });
    }
  },

  // A local event fires somewhere in the galaxy every few minutes (scaled by
  // fast-time). fastNews also speeds these up so the pipeline is testable.
  scheduleLocalEvent() {
    clearTimeout(this._localTimer);
    const base = CONFIG.fastNews
      ? Util.randInt(8000, 16000)
      : Util.randInt(GALAXY.localEventMinMs, GALAXY.localEventMaxMs);
    this._localTimer = setTimeout(() => {
      Galaxy.fireLocalEvent();
      this.scheduleLocalEvent();
    }, base / this.timeScale);
  },

  // Slow background chatter: a random system gets a flavor post now and then,
  // so local feeds keep filling even when you're not looking.
  scheduleLocalFlavor() {
    clearTimeout(this._flavorTimer);
    const base = CONFIG.fastNews ? Util.randInt(4000, 9000) : Util.randInt(20000, 45000);
    this._flavorTimer = setTimeout(() => {
      Galaxy.flavorPost(Util.pick(Galaxy.list));
      this.scheduleLocalFlavor();
    }, base / this.timeScale);
  },

  // Random choice-driven incident pop-up (incidents.js). Active-play only: the
  // scheduler is torn down while the tab is hidden, so it never fires on idle.
  scheduleIncident() {
    clearTimeout(this._incidentTimer);
    const base = CONFIG.fastNews ? Util.randInt(15000, 30000) : Util.randInt(INCIDENTCFG.minMs, INCIDENTCFG.maxMs);
    this._incidentTimer = setTimeout(() => { this.fireIncident(); this.scheduleIncident(); }, base / this.timeScale);
  },
  fireIncident() {
    if (this._booting || !window.Incidents) return;
    if (document.querySelector(".modal-backdrop:not(.hidden)")) return;   // don't interrupt another modal
    UI.showIncident(Util.pick(INCIDENTS));
  },

  // Periodic faction war (wars.js). Active-play only, like the other schedulers.
  scheduleWar() {
    clearTimeout(this._warTimer);
    const base = CONFIG.fastNews ? Util.randInt(40000, 80000) : Util.randInt(WARCFG.minMs, WARCFG.maxMs);
    this._warTimer = setTimeout(() => { if (!this._booting && window.Wars) Wars.start(); this.scheduleWar(); }, base / this.timeScale);
  },

  // Diff the before/after snapshots into a "while you were away" recap: net-worth
  // swing, the biggest market moves, an ongoing/ended war, and seized structures.
  awayRecap(away, now = Date.now()) {
    const s = this.state;
    const movers = [];
    for (const c of COMMODITIES) {
      const before = away.priceBefore[c.id], after = Market.price(c.id);
      if (!before) continue;
      const pct = ((after - before) / before) * 100;
      if (Math.abs(pct) >= 4) movers.push({ name: c.name, pct });
    }
    movers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    // industries gone from the list (only the catch-up can remove them → seized)
    const seized = away.indBefore
      .filter(b => !s.industries.some(i => i.id === b.id))
      .map(b => { const sys = Galaxy.get(b.systemId), p = sys && sys.planets[b.planetIdx]; return p ? p.name : b.systemId; });
    const warNow = Wars.active(now);
    let war = null, warEnded = null;
    if (warNow) war = { aggressor: FACTIONS[warNow.a].name, defender: FACTIONS[warNow.b].name, hot: warNow.catA, cold: warNow.catB };
    else if (away.warBefore) warEnded = `${FACTIONS[away.warBefore.a].name}–${FACTIONS[away.warBefore.b].name}`;
    const nwAfter = Economy.netWorth();
    const senate = window.Senate ? Senate.recapSince(away.senateSince, now) : null;
    return { nwBefore: away.nwBefore, nwAfter, nwDelta: nwAfter - away.nwBefore, movers: movers.slice(0, 3), seized, war, warEnded, senate, customs: away.customs || null };
  },

  snapshot() {
    this.state.lastSeenAt = Date.now();
    this.state.market = Market.serialize();
    this.state.galaxy = Galaxy.serialize();
    if (window.Stock) this.state.stock = Stock.serialize();
    if (window.Stations) this.state.stations = Stations.serialize();
    return this.state;
  },

  requestSave() {
    // Persist immediately so any player action (buy/sell, ship, prestige, industry…)
    // is saved the instant it happens; the cloud push is still coalesced in Store.
    clearTimeout(this._saveTimer);
    this.save();
  },
  save() { if (this._noSave) return; Store.save(this.snapshot()); },

  async reset() {
    await Store.clear();
    // Clear in-memory logs too (the reload re-initializes, this is belt-and-braces).
    if (this.state) this.state.newswire = [];
    Galaxy.localLog = {};
    Market.effects = []; Market.localEffects = [];
    if (window.Stock) { Stock.units = {}; Stock.sentiment = {}; }
    if (window.Stations) { Stations.byId = {}; Stations.auctions = {}; }
    location.reload();
  },

  // ---- wiped-save backup (localStorage "starbaron.corrupt") --------------------
  // Written on the first migrate failure. Workshop / knownRecipes / story are
  // client-owned slices app_commit will accept from the client, so a defaultState
  // upload during the wipe could erase them server-side even when credits/items
  // (server-protected) survived. The backup is how those slices come back.
  //
  // Never lift Store._cloudReady or flush from these paths when the gate was set
  // for a reason (#84): a merge into defaultState + flush would commit 1,500c and
  // empty story/achievements (app_commit takes lower credits; client-owned slices
  // pass through verbatim). Local save only; cloud sync resumes on a clean boot.
  readCorruptBackup() {
    try {
      const raw = localStorage.getItem("starbaron.corrupt");
      if (!raw) return null;
      const bak = JSON.parse(raw);
      return bak && typeof bak === "object" ? bak : null;
    } catch (e) { return null; }
  },
  hasCorruptBackup() {
    try { return !!localStorage.getItem("starbaron.corrupt"); }
    catch (e) { return false; }
  },
  _cloneSave(st) {
    try {
      if (typeof structuredClone === "function") return structuredClone(st);
    } catch (e) { /* fall through — e.g. unexpected non-cloneable */ }
    return JSON.parse(JSON.stringify(st));
  },
  _recipeIdSet() {
    return Array.isArray(window.RECIPES) ? new Set(window.RECIPES.map(r => r.id)) : null;
  },
  _knownRecipeId(id, recipeIds = this._recipeIdSet()) {
    return typeof id === "string" && (!recipeIds || recipeIds.has(id));
  },
  // Same filters migrate() applies to Workshop / inventory slices — used when
  // migrate itself still throws on the backup (player hasn't picked up the fix).
  _sanitizeCorruptSlices(bak) {
    const recipeIds = this._recipeIdSet();
    const known = id => this._knownRecipeId(id, recipeIds);
    const items = {};
    if (bak.items && typeof bak.items === "object") {
      for (const [uid, it] of Object.entries(bak.items)) {
        if (!it || typeof it !== "object") continue;
        if (typeof uid !== "string" || typeof it.uid !== "string" || it.uid !== uid) continue;
        if (typeof it.kind !== "string") continue;
        items[uid] = it;
      }
    }
    const extractors = {};
    if (bak.extractors && typeof bak.extractors === "object") {
      for (const [uid, ex] of Object.entries(bak.extractors)) {
        if (!ex || typeof ex !== "object") continue;
        if (typeof uid !== "string" || typeof ex.uid !== "string" || ex.uid !== uid) continue;
        if (typeof ex.type !== "string") continue;
        extractors[uid] = ex;
      }
    }
    const components = {};
    if (bak.components && typeof bak.components === "object") {
      for (const [uid, c] of Object.entries(bak.components)) {
        if (!c || typeof c !== "object") continue;
        if (typeof uid !== "string" || typeof c.uid !== "string" || c.uid !== uid) continue;
        if (typeof c.kind !== "string") continue;
        components[uid] = c;
      }
    }
    const rawQ = (bak.workshop && Array.isArray(bak.workshop.queue)) ? bak.workshop.queue : [];
    const queue = rawQ.filter(j => j && typeof j.id === "string"
      && known(j.recipeId) && Number.isFinite(+j.startedAt) && Number.isFinite(+j.readyAt)
      && +j.readyAt >= +j.startedAt
      && (j.flavorId === null || typeof j.flavorId === "string"));
    const upgrades = Math.max(0, (bak.workshop && bak.workshop.upgrades) | 0);
    const knownRecipes = Array.isArray(bak.knownRecipes)
      ? bak.knownRecipes.filter(id => known(id)) : [];
    const craftedOnce = Array.isArray(bak.craftedOnce)
      ? bak.craftedOnce.filter(id => known(id)) : [];
    return { items, extractors, components, workshop: { upgrades, queue }, knownRecipes, craftedOnce };
  },
  // Prefer migrate() (full trust-boundary validation). Fall back to the slice
  // sanitizer when migrate still throws — that's why the merge path exists.
  _validatedCorruptSource(bak) {
    try { return this.migrate(this._cloneSave(bak)); }
    catch (e) {
      console.warn("[Game] corrupt backup migrate failed — using sanitized slices:", e);
      return this._sanitizeCorruptSlices(bak);
    }
  },
  _sliceCounts(st) {
    if (!st || typeof st !== "object") return { items: 0, queue: 0, recipes: 0, crafted: 0, upgrades: 0, extractors: 0 };
    return {
      items: Object.keys(st.items || {}).length,
      queue: (st.workshop && Array.isArray(st.workshop.queue)) ? st.workshop.queue.length : 0,
      recipes: Array.isArray(st.knownRecipes) ? st.knownRecipes.length : 0,
      crafted: Array.isArray(st.craftedOnce) ? st.craftedOnce.length : 0,
      upgrades: (st.workshop && st.workshop.upgrades) | 0,
      extractors: Object.keys(st.extractors || {}).length,
    };
  },
  corruptBackupSummary(bak = this.readCorruptBackup()) {
    if (!bak) return "";
    const c = this._sliceCounts(bak);
    const bits = [];
    if (c.items) bits.push(`${c.items} inventory item${c.items === 1 ? "" : "s"}`);
    if (c.queue) bits.push(`${c.queue} craft${c.queue === 1 ? "" : "s"} in queue`);
    if (c.recipes) bits.push(`${c.recipes} blueprint${c.recipes === 1 ? "" : "s"}`);
    if (c.upgrades) bits.push(`Workshop +${c.upgrades} slot upgrade${c.upgrades === 1 ? "" : "s"}`);
    if (c.extractors) bits.push(`${c.extractors} extractor${c.extractors === 1 ? "" : "s"}`);
    if (bak.credits != null && Number.isFinite(+bak.credits)) bits.push(`${Math.round(+bak.credits).toLocaleString()}c`);
    return bits.join(", ") || "empty save";
  },
  // True when the backup holds Workshop / inventory progress the live save lacks.
  corruptBackupIsRicher(bak = this.readCorruptBackup()) {
    if (!bak || !this.state) return false;
    const a = this._sliceCounts(bak), b = this._sliceCounts(this.state);
    return a.items > b.items || a.queue > b.queue || a.recipes > b.recipes
      || a.crafted > b.crafted || a.upgrades > b.upgrades || a.extractors > b.extractors;
  },
  // Merge missing client-owned Workshop / inventory slices from the backup into
  // the live save (keeps current credits / server-ledger progress).
  mergeCorruptClientSlices(bak = this.readCorruptBackup()) {
    if (!bak || !this.state) return { ok: false, msg: "No wiped-save backup found in this browser." };
    const src = this._validatedCorruptSource(bak);
    const s = this.state;
    let added = 0;
    s.items ||= {};
    for (const [uid, it] of Object.entries(src.items || {})) {
      if (it && typeof it === "object" && typeof uid === "string" && !s.items[uid]) { s.items[uid] = it; added++; }
    }
    s.extractors ||= {};
    for (const [uid, ex] of Object.entries(src.extractors || {})) {
      if (ex && typeof ex === "object" && typeof uid === "string" && !s.extractors[uid]) { s.extractors[uid] = ex; added++; }
    }
    s.components ||= {};
    for (const [uid, c] of Object.entries(src.components || {})) {
      if (c && typeof c === "object" && typeof uid === "string" && !s.components[uid]) { s.components[uid] = c; added++; }
    }
    if (!s.workshop || typeof s.workshop !== "object") s.workshop = { upgrades: 0, queue: [] };
    s.workshop.queue ||= [];
    const recipeIds = this._recipeIdSet();
    const haveJob = new Set(s.workshop.queue.map(j => j && j.id).filter(Boolean));
    for (const j of (src.workshop && src.workshop.queue) || []) {
      // Re-check the migrate filters — sanitized/migrated src should already
      // satisfy these; refuse readyAt: NaN/0-shaped junk that would deliver instantly.
      if (!(j && typeof j.id === "string" && !haveJob.has(j.id))) continue;
      if (!this._knownRecipeId(j.recipeId, recipeIds)) continue;
      if (!Number.isFinite(+j.startedAt) || !Number.isFinite(+j.readyAt)) continue;
      if (+j.readyAt < +j.startedAt) continue;   // readyAt: 0/NaN-shaped junk delivers instantly
      if (!(j.flavorId === null || typeof j.flavorId === "string")) continue;
      s.workshop.queue.push(j); haveJob.add(j.id); added++;
    }
    const bakUp = (src.workshop && src.workshop.upgrades) | 0;
    if (bakUp > (s.workshop.upgrades | 0)) { s.workshop.upgrades = bakUp; added++; }
    s.knownRecipes ||= [];
    for (const id of src.knownRecipes || []) {
      if (this._knownRecipeId(id, recipeIds) && !s.knownRecipes.includes(id)) { s.knownRecipes.push(id); added++; }
    }
    s.craftedOnce ||= [];
    for (const id of src.craftedOnce || []) {
      if (this._knownRecipeId(id, recipeIds) && !s.craftedOnce.includes(id)) { s.craftedOnce.push(id); added++; }
    }
    if (!added) return { ok: false, msg: "Backup has nothing missing from this save." };
    if (window.Economy) Economy.refreshNetWorth();
    // Persist via Store.save, which still no-ops the cloud side while
    // _cloudReady is false. Do NOT lift that gate or flush — merging into a
    // defaultState() boot and uploading would destroy server credits / story /
    // achievements (see gate at init's migrate catch). When the gate is already
    // open for a good reason, the queued cloud write syncs the recovered slices.
    this._noSave = false;
    this.state.lastSeenAt = Date.now();
    Store.save(this.state);
    // Crafted gear recovered from the backup is client-only until the server
    // adopts it — otherwise the next app_commit rewrites `items` from the
    // server pool and the item disappears all over again.
    if (window.Workshop && Workshop.adoptLocal) void Workshop.adoptLocal(true);
    return { ok: true, added };
  },
  // Full replace from the backup (nuclear — use when soft-merge isn't enough).
  async restoreCorruptBackup() {
    const bak = this.readCorruptBackup();
    if (!bak) return { ok: false, msg: "No wiped-save backup found in this browser." };
    let next;
    try { next = this.migrate(this._cloneSave(bak)); }
    catch (e) {
      console.error("[Game] corrupt backup migrate failed:", e);
      return { ok: false, msg: "This version of the game still can't read that backup — reload to get the latest fix and try again." };
    }
    // Keep the backup's market/galaxy — snapshot() would re-serialize the live
    // modules hydrated from the wiped save and discard them before reload.
    next.lastSeenAt = Date.now();
    // Let the boot after this reload re-offer the restored Workshop gear to the
    // server (app_craft_adopt keeps its own 3-call budget, so this can't loop).
    delete next.workshopAdopt;
    this._noSave = false;
    Store.localSave(Store._stampOwner(next));
    // Only re-open cloud writes when WE gated them for a corrupt-save reset.
    // Never clear a failed-cloud-load gate (unknown remote must stay protected).
    // Flush the migrated backup (not defaultState) so client-owned slices sync;
    // app_commit still rejects credit increases.
    if (this._corruptSaveReset) {
      Store._cloudReady = true;
      try { await Store.flush(next); } catch (e) { /* best-effort */ }
    }
    location.reload();
    return { ok: true };
  },

  // Tiny UI beeps — respect mute + volume (default 25%). Resumes on first gesture.
  audio(type) {
    const set = this.state.settings || {};
    if (set.muted) return;
    const vol = Util.clamp(set.volume == null ? 0.25 : +set.volume, 0, 1);
    if (!(vol > 0)) return;
    try {
      this._audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this._audioCtx;
      if (ctx.state === "suspended") ctx.resume();
      const o = ctx.createOscillator(), g = ctx.createGain();
      const freq = type === "news" ? 220 : type === "good" ? 660 : 440;
      o.frequency.value = freq; o.type = "sine";
      g.gain.value = 0.05 * vol;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (type === "news" ? 0.5 : 0.15));
      o.stop(ctx.currentTime + (type === "news" ? 0.55 : 0.2));
    } catch (e) { /* audio is best-effort */ }
  },
};

window.Game = Game;
// init() is ~60 lines of unguarded module calls after the migrate try/catch (catch-up
// resolvers, Galaxy, UI wiring). A throw in any of them used to be an unhandled promise
// rejection: no UI, no message, blank page — which is how the PR #83 save wipe hid for a
// day. Surface it instead; the save is untouched, so a fixed reload recovers.
window.addEventListener("DOMContentLoaded", () => Game.init().catch(e => {
  console.error("[Game] boot failed:", e);
  if (window.UI && UI.toast) UI.toast("Something went wrong loading the game. Your save is untouched — try reloading.", "warn", 0);
  else document.body.insertAdjacentHTML("afterbegin",
    '<p role="alert" style="padding:1rem;font:14px system-ui;color:#fff;background:#a11">Something went wrong loading the game. Your save is untouched — try reloading.</p>');
}));
