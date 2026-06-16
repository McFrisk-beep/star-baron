/* worldfeed.js — reads the SHARED, persistent world feed that a Supabase cron job
   writes every minute (see docs/WORLD_CRON_SETUP.md). This is what makes the
   chat feel like a living, always-on world: it keeps filling even when nobody is
   online, and every player sees the same ambient lines. Read-only on the client
   (only the server-side tick writes). Additive — the local feed (omens, reactions
   to YOUR actions) keeps running on top. No-op if cloud isn't configured.        */

const WorldFeed = {
  lastId: 0,
  timer: null,
  pollMs: 45000,

  enabled() { return !!(window.Cloud && Cloud.enabled && Cloud.client && window.Feed); },

  // On arrival, pull recent shared chatter so the channel is alive + shared,
  // then start polling for new lines.
  async init() {
    if (!this.enabled()) return;
    try {
      const { data, error } = await Cloud.client.from("world_feed")
        .select("id,kind,payload").order("id", { ascending: false }).limit(20);
      if (error) throw error;
      const rows = (data || []).reverse();           // oldest → newest for natural order
      for (const r of rows) { this.render(r); this.lastId = Math.max(this.lastId, r.id); }
      console.log(`[WorldFeed] shared world feed live (${rows.length} recent lines).`);
    } catch (e) {
      console.warn("[WorldFeed] not available (has docs/WORLD_CRON_SETUP.md been run?):", e.message || e);
      return;   // stay on the local feed only
    }
    this.start();
  },

  start() { if (this.enabled()) { clearInterval(this.timer); this.timer = setInterval(() => this.poll(), this.pollMs); } },
  stop() { clearInterval(this.timer); this.timer = null; },

  async poll() {
    if (!this.enabled()) return;
    try {
      const { data, error } = await Cloud.client.from("world_feed")
        .select("id,kind,payload").gt("id", this.lastId).order("id", { ascending: true }).limit(20);
      if (error) throw error;
      for (const r of (data || [])) { this.render(r); this.lastId = Math.max(this.lastId, r.id); }
    } catch (e) { /* transient — try again next tick */ }
  },

  render(r) {
    const p = r.payload || {};
    if (r.kind === "chat" && p.text) {
      Feed.emit(p.text, { handle: p.handle || Feed.handle(), portrait: p.portrait ?? 0, kind: "banter" });
    }
  },
};

window.WorldFeed = WorldFeed;
