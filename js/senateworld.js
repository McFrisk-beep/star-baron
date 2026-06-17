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
      if (!rows.length) {
        if (Senate.shared) Senate.setShared(false);   // table emptied → fall back to the local senate
        console.log("[SenateWorld] no shared bills yet (run docs/SENATE_SETUP.md) — using the local senate.");
        return;
      }
      this.active = true;
      Senate.setShared(true);                          // server owns the agenda; stop local generation
      for (const r of rows.reverse()) { this.ingest(r); this.lastId = Math.max(this.lastId, r.id); }
      await this._drive();
      console.log(`[SenateWorld] shared senate live (${rows.length} recent bills).`);
    } catch (e) {
      if (Senate.shared && !this.active) Senate.setShared(false);   // unreachable shared source → fall back
      console.warn("[SenateWorld] shared senate unavailable (run docs/SENATE_SETUP.md):", e.message || e);
    }
  },
  async poll() {
    if (!this.active) return;
    try {
      const { data, error } = await Cloud.client.from("world_senate")
        .select(this.cols).gt("id", this.lastId).order("id", { ascending: true }).limit(20);
      if (error) throw error;
      for (const r of (data || [])) { this.ingest(r); this.lastId = Math.max(this.lastId, r.id); }
    } catch (e) { /* transient */ }
    await this._drive();        // resolve any bill that's now past its (shared) deadline, with the final pool
  },

  // ---- pooled influence ---------------------------------------------------
  // submit this player's lobby/bribe/scandal for a bill into the shared pool
  async submit(billId, kind, target, dir, strength) {
    if (!this.enabled() || !Cloud.signedIn()) return;
    try {
      await Cloud.client.from("world_senate_influence")
        .insert({ bill_id: billId, kind, target: target || null, dir: dir || 0, strength: strength || 0 });
    } catch (e) { console.warn("[SenateWorld] influence submit failed:", e.message || e); }
  },
  // fetch + aggregate every player's influence for a bill into one signed-push pool
  async _loadPool(bill) {
    try {
      const { data, error } = await Cloud.client.from("world_senate_influence")
        .select("kind,target,dir,strength").eq("bill_id", bill.id);
      if (error) throw error;
      const p = Senate._emptyPending(); p.billId = bill.id;
      for (const r of (data || [])) {
        const dir = Number(r.dir) || 0, str = Number(r.strength) || 0;
        if (r.kind === "lobby_all") p.pushAll += dir * str;
        else if (r.kind === "lobby_fac" && r.target) p.pushFac[r.target] = (p.pushFac[r.target] || 0) + dir * str;
        else if (r.kind === "bribe" && r.target) p.pushSen[r.target] = (p.pushSen[r.target] || 0) + dir * str;
        else if (r.kind === "scandal" && r.target) p.abstain[r.target] = true;
      }
      Senate.applyPool(bill.id, p, Date.now() >= bill.votesAt);   // ready (final) once the window has closed
    } catch (e) { /* transient — bill just waits for the next poll */ }
  },
  // load the final pool for any now-due bill, then resolve (deterministic + shared)
  async _drive() {
    if (!this.active) return;
    const now = Date.now();
    for (const b of Senate.upcomingBills(now)) if (b.votesAt <= now) await this._loadPool(b);
    this.resolveNow();
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
