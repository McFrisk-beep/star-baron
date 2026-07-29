/* senateworld.js — the SHARED, galaxy-wide senate via Supabase (see
   docs/SENATE_SETUP.md). Three tables:
     • world_senate          — the bill agenda every player faces (authored by the
                               `senate_tick` cron on a fixed schedule).
     • world_senate_influence — every player's pooled lobby/bribe/scandal.
     • world_senate_result   — the CANONICAL outcome of each vote.

   To guarantee every client shows the *same* tally (never 60-40 here, 49-51
   there), exactly one client — the admin — resolves each vote and publishes the
   result; everyone else (players and guests) applies that stored result verbatim
   instead of re-voting. The local bill generator is switched off while shared.

   A no-op (local fallback) if cloud isn't configured or the tables don't exist
   yet. Writing world_senate_result is admin-gated by RLS. */

const SenateWorld = {
  lastId: 0,
  timer: null,
  pollMs: 45000,
  active: false,

  enabled() { return !!(window.Cloud && Cloud.enabled && Cloud.client && window.Senate); },

  // proposed_by/label need docs/sql/senate_ballot.sql — fall back if columns are missing
  colsBase: "id,issue,type,lean,effect,title,blurb,votes_at,ends_at,created_at",
  colsBallot: "id,issue,type,lean,effect,title,blurb,votes_at,ends_at,created_at,proposed_by,proposed_label",
  _agendaCols: null,
  resCols: "bill_id,issue,type,lean,effect,title,blurb,votes,result,status,repeal_of,votes_at,ends_at,created_at",

  async init() {
    if (!this.enabled()) return;
    await this.load();
    this.start();
  },
  start() { if (this.enabled()) { clearInterval(this.timer); this.timer = setInterval(() => this.poll(), this.pollMs); } },
  stop() { clearInterval(this.timer); this.timer = null; },

  async _selectAgenda(filter) {
    const cols = this._agendaCols || this.colsBallot;
    let q = Cloud.client.from("world_senate").select(cols);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error && cols === this.colsBallot && /proposed_by|proposed_label|column/i.test(String(error.message || error))) {
      this._agendaCols = this.colsBase;         // pre-ballot schema — keep shared senate working
      return this._selectAgenda(filter);
    }
    if (!error) this._agendaCols = cols;
    return { data, error };
  },

  async load() {
    let agenda = null, results = null;          // null = fetch failed; [] = reached server, empty
    try {
      const { data, error } = await this._selectAgenda(q => q.order("id", { ascending: false }).limit(40));
      if (error) throw error; agenda = data || [];
    } catch (e) { console.warn("[SenateWorld] agenda unavailable (run docs/SENATE_SETUP.md §1):", e.message || e); }
    try {
      const { data, error } = await Cloud.client.from("world_senate_result")
        .select(this.resCols).order("created_at", { ascending: false }).limit(80);
      if (error) throw error; results = data || [];
    } catch (e) { console.warn("[SenateWorld] results unavailable (run docs/SENATE_SETUP.md §1c):", e.message || e); }

    const haveAgenda = Array.isArray(agenda) && agenda.length, haveResults = Array.isArray(results) && results.length;
    if (!haveAgenda && !haveResults) {
      if (Senate.shared && agenda !== null) Senate.setShared(false);   // reached the server and it's empty → local fallback
      console.log("[SenateWorld] no shared senate yet — using the local senate.");
      return;
    }
    this.active = true;
    Senate.setShared(true);                       // server owns the agenda + outcomes; stop local generation
    if (haveAgenda) for (const r of agenda.reverse()) { this.ingest(r); this.lastId = Math.max(this.lastId, r.id); }
    if (haveResults) for (const r of results.reverse()) this.applyResult(r, false);   // quiet on first load
    await this._drive();                          // admin: resolve anything now-due and publish
    console.log(`[SenateWorld] shared senate live (${haveAgenda ? agenda.length : 0} bills, ${haveResults ? results.length : 0} results).`);
  },
  async poll() {
    if (!this.active) return;
    try {
      const lastId = this.lastId;
      const { data, error } = await this._selectAgenda(q => q.gt("id", lastId).order("id", { ascending: true }).limit(20));
      if (error) throw error;
      for (const r of (data || [])) { this.ingest(r); this.lastId = Math.max(this.lastId, r.id); }
    } catch (e) { /* transient */ }
    try {
      const { data, error } = await Cloud.client.from("world_senate_result")
        .select(this.resCols).order("created_at", { ascending: false }).limit(60);
      if (error) throw error;
      for (const r of (data || []).reverse()) this.applyResult(r, true);   // announce newly-landed outcomes
    } catch (e) { /* transient or table missing */ }
    await this._drive();        // admin only: resolve any bill now past its (shared) deadline + publish
  },

  // ---- canonical outcomes (published by the admin, applied by everyone) ----
  applyResult(r, announce) {
    const bill = Senate.ingestResolvedBill({
      id: r.bill_id, issue: r.issue, type: r.type, lean: Number(r.lean) || 1,
      effect: r.effect || null, title: r.title, blurb: r.blurb,
      votes: r.votes || "", result: r.result || null, status: r.status || "passed",
      repealOf: r.repeal_of || null,
      votesAt: r.votes_at ? new Date(r.votes_at).getTime() : Date.now(),
      endsAt: r.ends_at ? new Date(r.ends_at).getTime() : null,
    });
    if (!bill) return;                            // already applied → no churn
    if (window.Game && window.Game.state) Game.requestSave();
    if (announce && window.Bus) Bus.emit("senateVote", bill);
    if (window.UI && UI.page === "senate") UI.renderSenate();
  },
  // the admin client writes the one true result every account reads
  async publishResult(bill) {
    if (!this.enabled() || !Cloud.isAdmin()) return;
    try {
      await Cloud.client.from("world_senate_result").upsert({
        bill_id: bill.id, issue: bill.issue, type: bill.type, lean: bill.lean,
        effect: bill.effect || null, title: bill.title, blurb: bill.blurb,
        votes: bill.votes || "", result: bill.result || null, status: bill.status,
        repeal_of: bill.repealOf || null,
        votes_at: bill.votesAt ? new Date(bill.votesAt).toISOString() : null,
        ends_at: bill.endsAt ? new Date(bill.endsAt).toISOString() : null,
      }, { onConflict: "bill_id" });
    } catch (e) { console.warn("[SenateWorld] publish result failed (run docs/SENATE_SETUP.md §1c):", e.message || e); }
  },

  // ---- pooled influence ---------------------------------------------------
  // submit this player's lobby/bribe/scandal for a bill into the shared pool.
  // Goes through the SECURITY DEFINER RPC, which validates + clamps strength and
  // rate-limits per bill (see docs/sql/security_hardening.sql) so no client can
  // forge an outsized push. Falls back to the legacy direct insert only on
  // projects where that hardening RPC isn't installed yet.
  async submit(billId, kind, target, dir, strength) {
    if (!this.enabled() || !Cloud.signedIn()) return;
    try {
      const { error } = await Cloud.client.rpc("app_senate_influence", {
        p_bill_id: billId, p_kind: kind, p_target: target || null,
        p_dir: dir || 0, p_strength: strength || 0,
      });
      if (error) {
        if (Cloud._isMissingRpc && Cloud._isMissingRpc(error)) {
          const { error: e2 } = await Cloud.client.from("world_senate_influence")
            .insert({ bill_id: billId, kind, target: target || null, dir: dir || 0, strength: strength || 0 });
          if (e2) throw e2;
        } else throw error;
      }
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
        if (r.kind === "lobby_fac" && r.target) {
          p.pushFac[r.target] = (p.pushFac[r.target] || 0) + dir * str;
          const rival = (window.FACTIONS && FACTIONS[r.target]) ? FACTIONS[r.target].rival : null;
          if (rival) p.pushFac[rival] = (p.pushFac[rival] || 0) - dir * str * SENATECFG.lobbyRivalFactor;   // rival bloc digs in
        } else if (r.kind === "bribe" && r.target) p.pushSen[r.target] = (p.pushSen[r.target] || 0) + dir * str;
        else if (r.kind === "coerce" && r.target) p.coerce[r.target] = dir;   // forced vote
      }
      Senate.applyPool(bill.id, p, Date.now() >= bill.votesAt);   // ready (final) once the window has closed
    } catch (e) { /* transient — bill just waits for the next poll */ }
  },
  // load the final pool for any now-due bill, then resolve + publish. Only the
  // admin (the authority) does this; every other client applies the published
  // result instead, so all clients show the identical tally.
  async _drive() {
    if (!this.active || !(window.Cloud && Cloud.isAdmin())) return;
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
      proposedBy: r.proposed_by || null,
      proposedLabel: r.proposed_label || null,
    });
  },

  // Table a player ballot onto the shared agenda (docs/sql/senate_ballot.sql).
  async proposeBallot(edictId, target, factor, days) {
    if (!this.enabled() || !Cloud.signedIn())
      return { ok: false, msg: "Sign in to table a bill onto the galaxy-wide agenda." };
    try {
      const { data, error } = await Cloud.client.rpc("app_senate_ballot", {
        p_edict_id: edictId, p_target: target || null,
        p_factor: factor == null ? 1 : Number(factor),
        p_days: days == null ? 3 : Math.round(Number(days)),
      });
      if (error) {
        if (Cloud._isMissingRpc && Cloud._isMissingRpc(error))
          return { ok: false, msg: "Galaxy clerks aren't accepting ballots yet — run docs/sql/senate_ballot.sql." };
        throw error;
      }
      if (!data || !data.ok) return { ok: false, msg: (data && data.error) || "Could not table that bill." };
      const row = data.bill || {};
      const bill = {
        id: "wb" + row.id, issue: row.issue, type: row.type, lean: Number(row.lean) || 1,
        effect: row.effect || null, title: row.title, blurb: row.blurb,
        votesAt: row.votes_at ? new Date(row.votes_at).getTime() : Date.now(),
        endsAt: row.ends_at ? new Date(row.ends_at).getTime() : null,
        status: "upcoming",
        proposedBy: row.proposed_by || (Cloud.user() && Cloud.user().id) || null,
        proposedLabel: row.proposed_label || null,
        edictMs: row.edict_days ? row.edict_days * 24 * 60 * 60 * 1000 : null,
        ballotFactor: row.factor, ballotDays: row.edict_days,
      };
      this.ingest({
        id: row.id, issue: bill.issue, type: bill.type, lean: bill.lean, effect: bill.effect,
        title: bill.title, blurb: bill.blurb, votes_at: row.votes_at, ends_at: row.ends_at,
        proposed_by: bill.proposedBy, proposed_label: bill.proposedLabel,
      });
      this.lastId = Math.max(this.lastId, Number(row.id) || 0);
      if (window.UI && UI.page === "senate") UI.renderSenate();
      return { ok: true, bill, charged: !!data.charged, credits: data.credits, cost: data.cost };
    } catch (e) {
      console.warn("[SenateWorld] ballot failed:", e.message || e);
      return { ok: false, msg: e.message || "Could not table that bill." };
    }
  },

  async bumpBallot(billId) {
    if (!this.enabled() || !Cloud.signedIn())
      return { ok: false, msg: "Sign in to move a bill on the galaxy-wide agenda." };
    try {
      const { data, error } = await Cloud.client.rpc("app_senate_ballot_bump", { p_bill_id: String(billId) });
      if (error) {
        if (Cloud._isMissingRpc && Cloud._isMissingRpc(error))
          return { ok: false, msg: "Ballot bump isn't available yet — re-run docs/sql/senate_ballot.sql." };
        throw error;
      }
      if (!data || !data.ok) return { ok: false, msg: (data && data.error) || "Could not move that bill up." };
      await this.poll();
      if (window.UI && UI.page === "senate") UI.renderSenate();
      return { ok: true, charged: !!data.charged, credits: data.credits, cost: data.cost };
    } catch (e) {
      console.warn("[SenateWorld] ballot bump failed:", e.message || e);
      return { ok: false, msg: e.message || "Could not move that bill up." };
    }
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
