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
      v: 1,
      credits: CONFIG.startingCredits,
      currentSystem: "navos",
      positions: {},
      avgCost: {},
      ships: [{ uid: "s1", type: "shuttle", status: "idle", at: "navos" }],
      seq: 1,
      unlockedSystems: SYSTEMS.filter(s => s.unlock === 0).map(s => s.id),
      reputation: {},
      achievements: [],
      prestige: { tier: 0, multiplier: 1.0 },
      stats: { trades: 0, runs: 0, peakNetWorth: CONFIG.startingCredits, biggestTrade: 0, runProfit: 0 },
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
    // legacy ships without `at`
    for (const sh of s.ships) if (sh.status === "idle" && !sh.at) sh.at = "navos";
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

    // ---- offline catch-up (before any feed listeners are wired) ----
    const now = Date.now();
    const elapsed = Util.clamp(now - (this.state.lastSeenAt || now), 0, CONFIG.maxOfflineMs);
    if (elapsed > CONFIG.marketTickMs) Market.advance(elapsed, now);
    const offlineRuns = Fleet.resolveMatured(now);
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

    // live arrival toasts (offline ones go in the WYWA modal instead)
    Bus.on("runDone", d => {
      if (this._booting) return;
      UI.toast(`${d.shipName} docked at ${d.toName}: ${d.qty} ${d.commName} (+${Util.credits(d.profit)}c)`, d.profit >= 0 ? "good" : "bad", 4500);
      UI.renderShips();
      this.audio("good");
      this.requestSave();
    });

    UI.showWYWA({ elapsedMs: elapsed, runs: offlineRuns });

    // ---- schedulers ----
    Feed.start();
    Broadcast.start();
    this.scheduleLocalEvent();
    setInterval(() => this.loop(), CONFIG.marketTickMs);
    setInterval(() => this.save(), CONFIG.autosaveMs);

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
    Fleet.resolveMatured(now);   // live arrivals
    UI.tick();
  },

  // Emit newHigh/crash chatter when a commodity moves hard (throttled).
  detectMoves() {
    const now = Date.now();
    for (const c of COMMODITIES) {
      const pct = Market.changePct(c.id);
      if (Math.abs(pct) < 12) continue;
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
