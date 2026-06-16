/* worldfeed.js — reads the SHARED, persistent world from Supabase (written by the
   cron jobs in docs/WORLD_CRON_SETUP.md):
     • world_feed  — ambient trader chat (everyone sees the same lines)
     • world_news  — galactic news events. Each client applies the SAME effect
       with the SAME start time, so the market reacts identically for everyone,
       and the client's own news generator is switched off (single shared source).
   Read-only on the client. No-op if cloud isn't configured / tables don't exist. */

const WorldFeed = {
  lastId: 0,        // chat cursor
  lastNewsId: 0,    // news cursor
  timer: null,
  pollMs: 45000,
  newsActive: false,

  enabled() { return !!(window.Cloud && Cloud.enabled && Cloud.client && window.Feed); },

  async init() {
    if (!this.enabled()) return;
    await this.loadChat();
    await this.loadNews();
    this.start();
  },

  start() { if (this.enabled()) { clearInterval(this.timer); this.timer = setInterval(() => this.poll(), this.pollMs); } },
  stop() { clearInterval(this.timer); this.timer = null; },
  async poll() { if (!this.enabled()) return; await this.pollChat(); await this.pollNews(); },

  // ---- shared chat --------------------------------------------------------
  async loadChat() {
    try {
      const { data, error } = await Cloud.client.from("world_feed")
        .select("id,kind,payload").order("id", { ascending: false }).limit(20);
      if (error) throw error;
      const rows = (data || []).reverse();
      for (const r of rows) { this.renderChat(r); this.lastId = Math.max(this.lastId, r.id); }
      console.log(`[WorldFeed] shared chat live (${rows.length} recent lines).`);
    } catch (e) { console.warn("[WorldFeed] chat unavailable (run docs/WORLD_CRON_SETUP.md):", e.message || e); }
  },
  async pollChat() {
    try {
      const { data, error } = await Cloud.client.from("world_feed")
        .select("id,kind,payload").gt("id", this.lastId).order("id", { ascending: true }).limit(20);
      if (error) throw error;
      for (const r of (data || [])) { this.renderChat(r); this.lastId = Math.max(this.lastId, r.id); }
    } catch (e) { /* transient */ }
  },
  renderChat(r) {
    const p = r.payload || {};
    if (r.kind === "chat" && p.text) Feed.emit(p.text, { handle: p.handle || Feed.handle(), portrait: p.portrait ?? 0, kind: "banter" });
  },

  // ---- shared news --------------------------------------------------------
  async loadNews() {
    try {
      const { data, error } = await Cloud.client.from("world_news")
        .select("id,event_id,target,mult,duration_ms,headline,body,faction,cat,dir,created_at")
        .order("id", { ascending: false }).limit(20);
      if (error) throw error;
      // table exists → shared news is the single source; silence the local generator
      this.newsActive = true;
      if (window.Broadcast) Broadcast.disableLocalNews();
      const rows = (data || []).reverse();
      for (const r of rows) { this.ingestNews(r, false); this.lastNewsId = Math.max(this.lastNewsId, r.id); }
      if (window.UI) UI.renderNewswire();
      console.log(`[WorldFeed] shared news live (${rows.length} recent events).`);
    } catch (e) { console.warn("[WorldFeed] news unavailable (run docs/WORLD_CRON_SETUP.md):", e.message || e); }
  },
  async pollNews() {
    if (!this.newsActive) return;
    try {
      const { data, error } = await Cloud.client.from("world_news")
        .select("id,event_id,target,mult,duration_ms,headline,body,faction,cat,dir,created_at")
        .gt("id", this.lastNewsId).order("id", { ascending: true }).limit(10);
      if (error) throw error;
      let any = false;
      for (const r of (data || [])) { this.ingestNews(r, true); this.lastNewsId = Math.max(this.lastNewsId, r.id); any = true; }
      if (any && window.UI) UI.renderNewswire();
    } catch (e) { /* transient */ }
  },
  // Apply a shared news event: identical effect + start time on every client, so
  // the market moves the same for everyone. `fresh` = just happened (klaxon it).
  ingestNews(r, fresh) {
    const startedAt = new Date(r.created_at).getTime();
    const now = Date.now();
    const dur = Number(r.duration_ms) || 0;
    const id = (r.event_id || "news") + "_" + r.id;
    if (window.Market && now < startedAt + dur && !Market.effects.some(e => e.id === id)) {
      Market.applyNews(r.target, Number(r.mult), dur, startedAt, id);   // startedAt is shared → identical decay
    }
    const s = window.Game && Game.state;
    if (s && s.newswire && !s.newswire.some(n => n.id === id)) {
      s.newswire.unshift({ id, headline: r.headline, body: r.body, faction: r.faction, cat: r.cat, ts: startedAt, dir: r.dir });
      s.newswire.sort((a, b) => b.ts - a.ts);
      if (s.newswire.length > CONFIG.newswireMax) s.newswire.length = CONFIG.newswireMax;
    }
    if (fresh && window.Bus) Bus.emit("news", { id, headline: r.headline, body: r.body, faction: r.faction, cat: r.cat });
  },
};

window.WorldFeed = WorldFeed;
