/* barons.js — human-only Baron Leaderboard. Reads public.baron_board (see
   docs/BARON_BOARD_SETUP.md); signed-in players publish via app_baron_publish
   (wealth freezes for the UTC day). Guests can view but don't appear until
   they sign in. AI rivals stay in rivals.js for flavor only.                 */

const Barons = {
  rows: [],           // last fetched remote rows (no "you" synthetic)
  fetchedAt: 0,
  missing: false,     // true once we know SQL isn't installed
  publishBroken: false, // true once publish fails on schema — board still reads fine
  _publishing: false,
  window: () => (typeof RIVALCFG !== "undefined" && RIVALCFG.window) || 10,

  enabled() { return !!(window.Cloud && Cloud.enabled && Cloud.client); },
  signedIn() { return !!(window.Cloud && Cloud.signedIn && Cloud.signedIn()); },

  // ---- remote ------------------------------------------------------------
  async refresh() {
    if (!this.enabled()) { this.rows = []; return this.rows; }
    try {
      let data = null, error = null;
      // Prefer RPC (works even if table RLS tightens later).
      ({ data, error } = await Cloud.client.rpc("app_baron_board"));
      if (error && Cloud._isMissingRpc && Cloud._isMissingRpc(error)) {
        ({ data, error } = await Cloud.client.from("baron_board")
          .select("user_id,display,title,tier,net_worth,day_key,updated_at")
          .order("net_worth", { ascending: false })
          .limit(2000));
      }
      if (error) throw error;
      this.missing = false;
      this.rows = (data || []).map(r => ({
        id: String(r.user_id),
        name: r.display || "Baron",
        title: r.title || "Baron",
        tier: r.tier | 0,
        netWorth: Number(r.net_worth) || 0,
        dayKey: r.day_key | 0,
        you: false,
      }));
      this.fetchedAt = Date.now();
    } catch (e) {
      const msg = String((e && (e.message || e)) || e);
      if (/baron_board|app_baron_board|does not exist|PGRST/i.test(msg)
          || (Cloud._isMissingRpc && Cloud._isMissingRpc(e))) {
        this.missing = true;
        console.warn("[Barons] board unavailable — run docs/sql/baron_board.sql");
      } else {
        console.warn("[Barons] fetch failed:", e);
      }
      this.rows = [];
    }
    return this.rows;
  },

  // Push our row. Safe to call often — server ignores same-day wealth writes.
  async publish() {
    if (!this.signedIn() || this.missing || this.publishBroken || this._publishing) return null;
    if (!window.Economy) return null;
    this._publishing = true;
    try {
      const data = await Cloud.rpc("app_baron_publish");
      if (data && data.ok === false) return data;
      // Refresh so our new/updated row is on the board.
      await this.refresh();
      return data;
    } catch (e) {
      if (Cloud._isMissingRpc && Cloud._isMissingRpc(e)) {
        this.missing = true;
        console.warn("[Barons] publish unavailable — run docs/sql/baron_board.sql");
      } else {
        const msg = String((e && (e.message || e.details || e)) || e);
        // Stale RPC before the v_title/v_tier rename — one line, not the full PostgREST dump.
        // Latch it: a schema mismatch won't fix itself mid-session, so retrying on
        // every save just buys a 400 and a console entry per autosave.
        if (/42702|ambiguous/i.test(msg)) {
          this.publishBroken = true;
          console.warn("[Barons] publish needs SQL refresh — re-run docs/sql/baron_board.sql");
        } else {
          console.warn("[Barons] publish failed:", e);
        }
      }
      return null;
    } finally {
      this._publishing = false;
    }
  },

  // ---- board -------------------------------------------------------------
  // Merge remote players with a live "you" row when signed in (so climbing
  // mid-day still moves your rank vs everyone else's frozen daily pile).
  board() {
    const uid = this.signedIn() && Cloud.user() ? String(Cloud.user().id) : null;
    const remote = this.rows.filter(r => !uid || r.id !== uid).map(r => ({ ...r, you: false }));
    if (uid && window.Economy) {
      remote.push({
        id: uid,
        name: (Cloud.displayName && Cloud.displayName()) || "You",
        title: Economy.tierTitle ? Economy.tierTitle() : "Baron",
        tier: Economy.tier ? Economy.tier() : 0,
        netWorth: Economy.netWorth(),
        you: true,
      });
    }
    remote.sort((a, b) => b.netWorth - a.netWorth || String(a.name).localeCompare(String(b.name)));
    remote.forEach((row, i) => { row.rank = i + 1; });
    return remote;
  },

  count() { return this.board().length; },

  rank() {
    const board = this.board();
    const you = board.find(r => r.you);
    return you ? you.rank : null;
  },

  pageWindow(offset) {
    const board = this.board();
    const win = this.window();
    const pageLen = win * 2 + 1;
    const youIdx = board.findIndex(r => r.you);
    const maxStart = Math.max(0, board.length - pageLen);
    let start;
    if (offset == null || !Number.isFinite(offset)) {
      start = youIdx < 0 ? 0 : Util.clamp(youIdx - win, 0, maxStart);
    } else {
      start = Util.clamp(Math.floor(offset), 0, maxStart);
    }
    const end = Math.min(board.length, start + pageLen);
    return {
      board, rows: board.slice(start, end), start, end, youIdx,
      youRank: youIdx >= 0 ? youIdx + 1 : null,
      total: board.length, pageLen, win,
      hasPrev: start > 0,
      hasNext: end < board.length,
      prevStart: Math.max(0, start - pageLen),
      nextStart: Math.min(maxStart, start + pageLen),
    };
  },
};

window.Barons = Barons;
