/* broadcast.js — the station screen. Between news it cycles Alien TV; when news
   fires it pre-empts with the headline, distorts the market for newsEffectMs,
   and pins the headline to the ticker + newswire log.                         */

const Broadcast = {
  tvTimer: null,
  newsTimer: null,
  // One-shot timeouts fired by announce()/scheduleNews(). They used to be
  // untracked, so stop() couldn't cancel them: a hidden tab still got a market
  // effect up to 15 min after the omen that scheduled it.
  _shots: [],
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
    for (const id of this._shots) clearTimeout(id);
    this._shots.length = 0;
  },
  // Track a one-shot so stop() can actually cancel it.
  _shot(fn, ms) {
    const id = setTimeout(() => {
      const i = this._shots.indexOf(id); if (i >= 0) this._shots.splice(i, 1);
      fn();
    }, ms);
    this._shots.push(id);
    return id;
  },

  // Hand news over to the shared world source: stop the local generator.
  disableLocalNews() {
    this.shared = true;
    if (this.newsTimer) { clearTimeout(this.newsTimer); this.newsTimer = null; }
  },

  newsLive() { return Date.now() < this.newsUntil; },

  // ---- TV ----------------------------------------------------------------
  // Pick an Alien TV show, then a pool image for that channel. Per-image
  // title/caption (admin) win; otherwise fall back to TV_SHOWS flavor.
  rotateTV() {
    if (!this.newsLive()) {
      const show = Util.pick(TV_SHOWS);
      const salt = Date.now() + ":" + Math.random().toString(36).slice(2, 7);
      const img = (window.ASSET && ASSET.broadcastEntry)
        ? ASSET.broadcastEntry(show.channel, salt)
        : { url: null, title: "", caption: "" };
      Bus.emit("tv", {
        channel: show.channel,
        url: img.url || undefined,
        title: (img.title && String(img.title).trim()) || show.title,
        caption: (img.caption && String(img.caption).trim()) || Util.pick(show.captions),
      });
    }
    // announce() calls rotateTV directly, so without this clear every news or
    // war event spawned a second parallel rotation chain that stop() could only
    // cancel the newest link of.
    clearTimeout(this.tvTimer);
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
    this._shot(() => this.fire(event), Math.max(0, delayMs));
  },

  fire(event, now = Date.now()) {
    const entry = {
      id: event.id, headline: event.headline, body: event.body,
      faction: event.faction, cat: event.cat, ts: now,
      dir: event.effect.mult >= 1 ? "up" : "down",
    };
    this.announce(entry, [event.effect], CONFIG.newsEffectMs / this.ts(), now);
  },

  // Pin a pre-built newswire entry to the screen/ticker/log and apply its market
  // effects for durMs. Shared by ordinary news (fire) and faction wars (wars.js).
  announce(entry, effects, durMs, now = Date.now()) {
    for (const e of effects) Market.applyNews(e.target, e.mult, durMs, now, entry.id + ":" + e.target);
    this.newsUntil = now + CONFIG.newsScreenMs / this.ts();
    const s = this.s();
    s.newswire.unshift(entry);
    if (s.newswire.length > CONFIG.newswireMax) s.newswire.length = CONFIG.newswireMax;
    Bus.emit("news", entry);
    // Resume TV once the news frame times out.
    this._shot(() => { if (!this.newsLive()) this.rotateTV(); }, CONFIG.newsScreenMs / this.ts() + 50);
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
