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
      mainShip: { type: "pinnace" },
      ships: [{ uid: "s1", type: "mule", cls: "transport", name: "Old Faithful",
        status: "idle", accessories: [], mercenary: false, expiresAt: null, retrieveCost: 0 }],
      missions: [], reports: [], listings: [], orders: [], routes: [], industries: [], extractors: {}, components: {}, items: {},
      inventory: { capacity: 6, upgrades: 0 },
      bazaar: { mercs: [], contracts: [], accessories: [], extractors: [], components: [] },
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
      settings: { muted: true, reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches, tutorialSeen: false },
      lastSeenAt: Date.now(),
      market: null,
      galaxy: null,
    };
  },

  // Fill any missing keys so old saves survive config growth.
  migrate(loaded) {
    const def = this.defaultState();
    const s = Object.assign({}, def, loaded);
    s.stats = Object.assign({}, def.stats, loaded.stats);
    s.prestige = Object.assign({}, def.prestige, loaded.prestige);
    s.settings = Object.assign({}, def.settings, loaded.settings);
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
      delete s.avgCost; s.avgCost = loaded.avgCost || {};
    }
    s.missions ||= []; s.reports ||= []; s.listings ||= []; s.orders ||= []; s.routes ||= []; s.industries ||= []; s.extractors ||= {}; s.components ||= {}; s.items ||= {};
    // legacy per-ship trade routes (sh.route) were replaced by state.routes — free those ships
    for (const sh of s.ships) if (sh.route) { sh.status = "idle"; delete sh.route; }
    s.inventory ||= def.inventory; s.bazaar ||= def.bazaar; s.mainShip ||= def.mainShip;
    s.bazaar.mercs ||= []; s.bazaar.contracts ||= []; s.bazaar.accessories ||= []; s.bazaar.extractors ||= []; s.bazaar.components ||= [];
    s.reputation = Object.assign(Object.fromEntries(Object.keys(FACTIONS).map(f => [f, 0])), loaded.reputation || {});
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
      this.state = loaded ? this.migrate(loaded) : this.defaultState();
      if (sharedReset != null) this.state.appliedResetEpoch = Math.max(this.state.appliedResetEpoch || 0, sharedReset);  // new/up-to-date players adopt the current epoch (no reset)
    }
    this.timeScale = 1;
    // resume the galaxy-wide senate before catch-up so it doesn't generate stray local bills
    if (window.Senate && this.state.senate && this.state.senate.shared) Senate.shared = true;

    Market.init();
    Market.volMult = 1 + this.state.prestige.tier * PRESTIGE.volPerTier;
    Market.hydrate(this.state.market);

    // Build the (deterministic) galaxy, then restore its local-news history.
    Galaxy.build();
    Galaxy.hydrate(this.state.galaxy);
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
    Economy.checkArrival(now);
    const offlineReports = Missions.resolveMatured(now);
    const offlineMercs = Fleet.pruneMercs(now);   // mercenaries whose service ended while away
    const offlineSold = Bazaar.tick(now);
    const offlineRoutes = Routes.resolve(now);   // bank trade-route round trips made while away
    const offlineOrders = Orders.process();      // fill standing orders that crossed while away
    const offlineIndustry = Industries.resolve(now);  // bank offworld production made while away
    Wars.tick(now);               // resolve a faction war that ended while away
    if (window.Senate) Senate.resolve(now);   // run the daily senate votes while away
    Rivals.tick(now);             // catch the leaderboard up over offline time
    Broadcast.backfill(now, elapsed);   // populate the newswire as if it kept running
    this.state.lastSeenAt = now;

    // ---- UI + flavor wiring ----
    UI.init();
    if (window.AuthUI) AuthUI.init();
    if (window.AdminUI) AdminUI.init();
    StarMap.init();
    if (window.Senate) Senate.init();
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

    // A senate vote landed during active play — surface the outcome.
    Bus.on("senateVote", bill => {
      if (this._booting) return;
      const carried = bill.status === "passed";
      const msg = bill.repealOf
        ? (carried ? `Senate repealed “${bill.title.replace(/^Repeal — /, "")}”.` : `Repeal of an edict failed.`)
        : (carried ? `Senate PASSED: ${bill.title}.` : `Senate rejected: ${bill.title}.`);
      UI.toast(msg, bill.repealOf ? "info" : carried ? "warn" : "good", 5000);
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
      routed: offlineRoutes, orders: offlineOrders, industry: offlineIndustry, mercs: offlineMercs,
      recap: this.awayRecap(away, now) });
    this._booting = false;
    if (this._tutorialPending && !shownWYWA) { this._tutorialPending = false; UI.openTutorial(); }

    // ---- schedulers ----
    this.startSchedulers();
    if (window.WorldFeed) WorldFeed.init();   // shared, always-on world chat (Supabase cron)
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
    this.detectMoves();
    Wars.tick(now);
    const senateBills = window.Senate ? Senate.tick(now) : [];
    Economy.checkArrival(now);
    const done = Missions.resolveMatured(now);
    Fleet.pruneMercs(now);
    Rivals.tick(now);
    const routed = Routes.resolve(now);
    const orderEv = Orders.process();
    for (const ev of orderEv) Bus.emit("order", ev);
    const made = Industries.resolve(now);
    if (done.length || routed.total || orderEv.length || made.length || senateBills.length) this.requestSave();
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
      Economy.checkArrival(now);
      Missions.resolveMatured(now);
      Fleet.pruneMercs(now);
      Bazaar.tick(now);
      Routes.resolve(now);
      Orders.process();
      Industries.resolve(now);
      Wars.tick(now);
      if (window.Senate) Senate.resolve(now);
      Rivals.tick(now);
      this._booting = false;
    }
    this.state.lastSeenAt = now;
    this.startSchedulers();
    if (window.WorldFeed) { WorldFeed.poll(); WorldFeed.start(); }   // catch up shared feed
    if (window.SenateWorld) { SenateWorld.poll(); SenateWorld.start(); }   // catch up shared senate
    UI.tick(); UI.renderNewswire();
    if (window.StarMap) StarMap.resume();
    if (window.Senate) Senate.resume();
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
    return { nwBefore: away.nwBefore, nwAfter, nwDelta: nwAfter - away.nwBefore, movers: movers.slice(0, 3), seized, war, warEnded, senate };
  },

  snapshot() {
    this.state.lastSeenAt = Date.now();
    this.state.market = Market.serialize();
    this.state.galaxy = Galaxy.serialize();
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
    location.reload();
  },

  // Tiny opt-in audio (off by default). Resumes on first user gesture.
  audio(type) {
    if (this.state.settings.muted) return;
    try {
      this._audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this._audioCtx;
      if (ctx.state === "suspended") ctx.resume();
      const o = ctx.createOscillator(), g = ctx.createGain();
      const freq = type === "news" ? 220 : type === "good" ? 660 : 440;
      o.frequency.value = freq; o.type = "sine";
      g.gain.value = 0.05;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (type === "news" ? 0.5 : 0.15));
      o.stop(ctx.currentTime + (type === "news" ? 0.55 : 0.2));
    } catch (e) { /* audio is best-effort */ }
  },
};

window.Game = Game;
window.addEventListener("DOMContentLoaded", () => Game.init());
