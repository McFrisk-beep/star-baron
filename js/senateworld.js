/* senateworld.js — reads the SHARED, galaxy-wide senate agenda from Supabase
   (written by the `senate_tick` cron in docs/SENATE_SETUP.md):
     • world_senate — the canonical bill schedule every player faces. Each client
       resolves a bill deterministically at its shared `votes_at` (same senators,
       same market trend, same bill id → the same outcome for everyone), so the
       legislation is galaxy-wide rather than per-player.

   When the table exists the local bill generator is switched off (the server
   owns the agenda). Read-only on the client; a no-op (local fallback) if cloud
   isn't configured or the table doesn't exist yet.

   Pooled multiplayer influence (combining every player's lobby/bribe/scandal
   into the shared outcome) is the planned next layer — see docs/SENATE_SETUP.md. */

const SenateWorld = {
  lastId: 0,
  timer: null,
  pollMs: 45000,
  active: false,

  enabled() { return !!(window.Cloud && Cloud.enabled && Cloud.client && window.Senate); },

  cols: "id,issue,type,lean,effect,title,blurb,votes_at,ends_at,created_at",

  async init() {
    if (!this.enabled()) return;
    await this.load();
    this.start();
  },
  start() { if (this.enabled()) { clearInterval(this.timer); this.timer = setInterval(() => this.poll(), this.pollMs); } },
  stop() { clearInterval(this.timer); this.timer = null; },

  async load() {
    try {
      const { data, error } = await Cloud.client.from("world_senate")
        .select(this.cols).order("id", { ascending: false }).limit(40);
      if (error) throw error;
      const rows = data || [];
      if (!rows.length) { console.log("[SenateWorld] no shared bills yet (run docs/SENATE_SETUP.md) — using the local senate."); return; }
      this.active = true;
      Senate.setShared(true);                       // server owns the agenda; stop local generation
      for (const r of rows.reverse()) { this.ingest(r); this.lastId = Math.max(this.lastId, r.id); }
      this.resolveNow();
      console.log(`[SenateWorld] shared senate live (${rows.length} recent bills).`);
    } catch (e) { console.warn("[SenateWorld] shared senate unavailable (run docs/SENATE_SETUP.md):", e.message || e); }
  },
  async poll() {
    if (!this.active) return;
    try {
      const { data, error } = await Cloud.client.from("world_senate")
        .select(this.cols).gt("id", this.lastId).order("id", { ascending: true }).limit(20);
      if (error) throw error;
      let any = false;
      for (const r of (data || [])) { this.ingest(r); this.lastId = Math.max(this.lastId, r.id); any = true; }
      if (any) this.resolveNow();
    } catch (e) { /* transient */ }
  },

  ingest(r) {
    Senate.ingestSharedBill({
      id: "wb" + r.id,
      issue: r.issue, type: r.type, lean: Number(r.lean) || 1,
      effect: r.effect || null, title: r.title, blurb: r.blurb,
      votesAt: new Date(r.votes_at).getTime(),
      endsAt: r.ends_at ? new Date(r.ends_at).getTime() : null,
      status: "upcoming",
    });
  },
  // resolve any now-due shared bills and refresh the open views/save
  resolveNow() {
    if (!window.Game || !window.Game.state) return;
    const out = Senate.resolve(Date.now());
    if (out && out.length) window.Game.requestSave();
    if (window.UI && UI.page === "senate") UI.renderSenate();
  },
};

window.SenateWorld = SenateWorld;
