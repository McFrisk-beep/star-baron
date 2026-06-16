/* broadcast.js — the station screen. Between news it cycles Alien TV; when news
   fires it pre-empts with the headline, distorts the market for newsEffectMs,
   and pins the headline to the ticker + newswire log.                         */

const Broadcast = {
  tvTimer: null,
  newsTimer: null,
  newsUntil: 0,
  shared: false,   // true once a shared (cron) news source takes over

  s() { return window.Game.state; },
  ts() { return window.Game.timeScale || 1; },

  start() {
    this.stop();
    this.rotateTV();
    if (!this.shared) this.scheduleNextNews();   // shared news is driven by WorldFeed instead
  },
  stop() {
    if (this.tvTimer) clearTimeout(this.tvTimer);
    if (this.newsTimer) clearTimeout(this.newsTimer);
    this.tvTimer = this.newsTimer = null;
  },

  // Hand news over to the shared world source: stop the local generator.
  disableLocalNews() {
    this.shared = true;
    if (this.newsTimer) { clearTimeout(this.newsTimer); this.newsTimer = null; }
  },

  newsLive() { return Date.now() < this.newsUntil; },

  // ---- TV ----------------------------------------------------------------
  rotateTV() {
    if (!this.newsLive()) {
      const show = Util.pick(TV_SHOWS);
      Bus.emit("tv", {
        channel: show.channel,
        title: show.title,
        caption: Util.pick(show.captions),
      });
    }
    this.tvTimer = setTimeout(() => this.rotateTV(), CONFIG.tvRotateMs);
  },

  // ---- News scheduling ---------------------------------------------------
  scheduleNextNews() {
    const base = CONFIG.fastNews ? 20000 : Util.randInt(CONFIG.newsMinMs, CONFIG.newsMaxMs);
    const delay = base / this.ts();
    this.newsTimer = setTimeout(() => {
      this.fire(Util.pick(NEWS_EVENTS));
      this.scheduleNextNews();
    }, delay);
  },

  // Fire a news event for a given category soon (called by a real omen).
  scheduleNews(cat, delayMs) {
    if (this.shared) return;   // shared world drives news; omens become flavor-only hints
    const candidates = NEWS_EVENTS.filter(e => e.cat === cat);
    const event = candidates.length ? Util.pick(candidates) : Util.pick(NEWS_EVENTS);
    setTimeout(() => this.fire(event), Math.max(0, delayMs));
  },

  fire(event, now = Date.now()) {
    const dur = CONFIG.newsEffectMs / this.ts();
    Market.applyNews(event.effect.target, event.effect.mult, dur, now, event.id);
    this.newsUntil = now + CONFIG.newsScreenMs / this.ts();

    const entry = {
      id: event.id, headline: event.headline, body: event.body,
      faction: event.faction, cat: event.cat, ts: now,
      dir: event.effect.mult >= 1 ? "up" : "down",
    };
    const s = this.s();
    s.newswire.unshift(entry);
    if (s.newswire.length > CONFIG.newswireMax) s.newswire.length = CONFIG.newswireMax;

    Bus.emit("news", entry);
    // Resume TV once the news frame times out.
    setTimeout(() => { if (!this.newsLive()) this.rotateTV(); }, CONFIG.newsScreenMs / this.ts() + 50);
  },

  // Backfill the newswire so the world looks like it kept running while the
  // player was away: top up to a baseline, plus ~1 extra bulletin per ~40 min
  // offline, each stamped at a believable past time. Log-only flavor (the market
  // itself already fast-forwarded via Market.advance). Called once at boot.
  backfill(now = Date.now(), elapsedMs = 0) {
    const s = this.s();
    s.newswire ||= [];
    const span = Util.clamp(elapsedMs, 0, 12 * 3600 * 1000);
    const desired = Math.min(CONFIG.newswireMax, 6 + Math.floor(span / (40 * 60 * 1000)));
    const need = desired - s.newswire.length;
    if (need <= 0) return;
    const window = Math.max(span, 2 * 3600 * 1000);   // spread across the away window (or last 2h)
    const made = [];
    for (let i = 0; i < need; i++) {
      const ev = Util.pick(NEWS_EVENTS);
      const ts = now - Util.randInt(60 * 1000, window);
      made.push({ id: ev.id + "_" + ts, headline: ev.headline, body: ev.body,
        faction: ev.faction, cat: ev.cat, ts, dir: ev.effect.mult >= 1 ? "up" : "down" });
    }
    s.newswire = [...s.newswire, ...made].sort((a, b) => b.ts - a.ts).slice(0, CONFIG.newswireMax);
  },
};

window.Broadcast = Broadcast;
