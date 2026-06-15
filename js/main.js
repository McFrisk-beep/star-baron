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
      credits: CONFIG.startingCredits,
      currentSystem: "navos",
      positions: {},
      avgCost: {},
      mainShip: { type: "pinnace" },
      ships: [{ uid: "s1", type: "mule", cls: "transport", name: "Old Faithful",
        status: "idle", accessories: [], mercenary: false, expiresAt: null, retrieveCost: 0 }],
      missions: [], reports: [], listings: [], items: {},
      inventory: { capacity: 6, upgrades: 0 },
      bazaar: { mercs: [], contracts: [], accessories: [] },
      travel: null,
      seq: 1,
      unlockedSystems: SYSTEMS.filter(s => s.unlock === 0).map(s => s.id),
      reputation: Object.fromEntries(Object.keys(FACTIONS).map(f => [f, 0])),
      achievements: [],
      prestige: { tier: 0, multiplier: 1.0 },
      stats: { trades: 0, contractsDone: 0, peakNetWorth: CONFIG.startingCredits, biggestTrade: 0 },
      newswire: [],
      settings: { muted: true, reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches },
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
    // v1 → v2: the fleet model changed shape; reset fleet/bazaar/items but keep
    // credits, positions, unlocks, achievements, prestige, stats, world.
    if ((loaded.v || 1) < 2) {
      s.mainShip = def.mainShip; s.ships = def.ships; s.missions = []; s.reports = [];
      s.listings = []; s.items = {}; s.inventory = def.inventory; s.bazaar = def.bazaar;
      s.travel = null; s.seq = Math.max(2, loaded.seq || 1); s.v = 2;
      delete s.avgCost; s.avgCost = loaded.avgCost || {};
    }
    s.missions ||= []; s.reports ||= []; s.listings ||= []; s.items ||= {};
    s.inventory ||= def.inventory; s.bazaar ||= def.bazaar; s.mainShip ||= def.mainShip;
    s.bazaar.mercs ||= []; s.bazaar.contracts ||= []; s.bazaar.accessories ||= [];
    s.reputation = Object.assign(Object.fromEntries(Object.keys(FACTIONS).map(f => [f, 0])), loaded.reputation || {});
    return s;
  },

  async init() {
    const loaded = await Store.load();
    this.state = loaded ? this.migrate(loaded) : this.defaultState();
    this.timeScale = 1;

    Market.init();
    Market.volMult = 1 + this.state.prestige.tier * PRESTIGE.volPerTier;
    Market.hydrate(this.state.market);

    // Build the (deterministic) galaxy, then restore its local-news history.
    Galaxy.build();
    Galaxy.hydrate(this.state.galaxy);
    Bazaar.ensure();

    // ---- offline catch-up (before any feed listeners are wired) ----
    this._booting = true;
    const now = Date.now();
    const elapsed = Util.clamp(now - (this.state.lastSeenAt || now), 0, CONFIG.maxOfflineMs);
    if (elapsed > CONFIG.marketTickMs) Market.advance(elapsed, now);
    Economy.checkArrival(now);
    const offlineReports = Missions.resolveMatured(now);
    Fleet.pruneMercs(now);
    const offlineSold = Bazaar.tick(now);
    this.state.lastSeenAt = now;

    // ---- UI + flavor wiring ----
    UI.init();
    StarMap.init();
    Feed.wire();
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

    UI.showWYWA({ elapsedMs: elapsed, reports: offlineReports, sold: offlineSold });
    this._booting = false;

    // ---- schedulers ----
    Feed.start();
    Broadcast.start();
    this.scheduleLocalEvent();
    this.scheduleLocalFlavor();
    setInterval(() => this.loop(), CONFIG.marketTickMs);
    setInterval(() => this.save(), CONFIG.autosaveMs);
    setInterval(() => { const sold = Bazaar.tick(Date.now()); if (sold.length) this.requestSave(); }, 12000);
    // slow refresh so relative "X ago" stamps stay current
    setInterval(() => { UI.renderNewswire(); StarMap.refreshFeed(); }, 30000);

    document.addEventListener("visibilitychange", () => { if (document.hidden) this.save(); });
    window.addEventListener("beforeunload", () => this.save());

    // first paint
    UI.tick();
    console.log("[Star Baron] ready. Saves to localStorage. Open Settings for dev toggles.");
  },

  loop() {
    const now = Date.now();
    Market.tick(now);
    this.detectMoves();
    Economy.checkArrival(now);
    const done = Missions.resolveMatured(now);
    Fleet.pruneMercs(now);
    if (done.length) this.requestSave();
    UI.tick();
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

  snapshot() {
    this.state.lastSeenAt = Date.now();
    this.state.market = Market.serialize();
    this.state.galaxy = Galaxy.serialize();
    return this.state;
  },

  requestSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), 800);
  },
  save() { Store.save(this.snapshot()); },

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
