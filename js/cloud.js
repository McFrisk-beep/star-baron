/* cloud.js — the ONLY module that talks to Supabase (auth + saves/players).
   Everything is wrapped so the rest of the game never imports the SDK directly.
   If CLOUD isn't configured (or the SDK failed to load), `enabled` stays false
   and the game runs purely on localStorage.

   Phase 1–2: logged-in economy goes through SECURITY DEFINER RPCs on `players`
   (see docs/PHASE1_SETUP.md + docs/PHASE2_SETUP.md). Legacy `saves` upsert
   remains as fallback when those RPCs aren't installed yet. Guests never hit
   the network for state.                                                      */

const Cloud = {
  client: null,
  enabled: false,
  _user: null,
  _role: "player",
  // true once app_bootstrap succeeds this session; false → legacy saves path.
  playersReady: false,

  // Build the client if (and only if) we're configured and the SDK is present.
  init() {
    const cfg = window.CLOUD || {};
    const sdk = window.supabase;
    if (!cfg.url || !cfg.anonKey || !sdk || !sdk.createClient) {
      this.enabled = false;
      if (cfg.url && cfg.anonKey && !sdk) console.warn("[Cloud] Supabase SDK not loaded — staying local.");
      return false;
    }
    try {
      this.client = sdk.createClient(cfg.url, cfg.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      this.enabled = true;
      this._pendingRecovery = false;
      this.client.auth.onAuthStateChange((evt, session) => {
        this._user = session ? session.user : null;
        // Reset-password email lands here with tokens in the URL hash.
        if (evt === "PASSWORD_RECOVERY") this._pendingRecovery = true;
        this.fetchRole().finally(() => { if (window.Bus) Bus.emit("auth", this._user); });
      });
      console.log("[Cloud] online accounts enabled (Supabase). Use the Sign in button.");
    } catch (e) {
      console.warn("[Cloud] init failed — staying local:", e);
      this.enabled = false;
    }
    return this.enabled;
  },

  // Restore an existing session (from a prior login) without any UI.
  async restore() {
    if (!this.enabled) return null;
    try {
      const { data } = await this.client.auth.getSession();
      this._user = data && data.session ? data.session.user : null;
    } catch (e) { console.warn("[Cloud] session restore failed:", e); this._user = null; }
    await this.fetchRole();
    return this._user;
  },

  signedIn() { return this.enabled && !!this._user; },
  // Server-authoritative economy path (Phase 1). Guests and pre-migration
  // projects stay on the local / saves sandbox.
  authoritative() { return this.signedIn() && this.playersReady; },
  user() { return this._user; },
  email() { return this._user ? this._user.email : null; },

  // Role comes from the server-side `profiles` table (set by you in the
  // dashboard) — never from anything the client can edit. Defaults to player.
  async fetchRole() {
    if (!this.enabled || !this._user) { this._role = "player"; return this._role; }
    try {
      const { data, error } = await this.client
        .from("profiles").select("role").eq("user_id", this._user.id).maybeSingle();
      if (error) throw error;
      this._role = (data && data.role) || "player";
    } catch (e) { console.warn("[Cloud] role fetch failed:", e); this._role = "player"; }
    return this._role;
  },
  isAdmin() { return this.signedIn() && this._role === "admin"; },
  role() { return this.signedIn() ? this._role : "guest"; },

  // ---- auth --------------------------------------------------------------
  // Where confirmation / reset emails should send the player back (works on
  // GitHub Pages subpaths and local http.server alike).
  authRedirect() {
    return location.href.split("#")[0].split("?")[0];
  },
  isPasswordRecovery() { return !!this._pendingRecovery; },
  clearPasswordRecovery() { this._pendingRecovery = false; },

  async signUp(email, password) {
    const { data, error } = await this.client.auth.signUp({
      email, password, options: { emailRedirectTo: this.authRedirect() },
    });
    if (error) throw error;
    if (data.session && data.user) this._user = data.user;   // null until confirmed if confirm-email is on
    return data;
  },
  async signIn(email, password) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this._user = data.user;
    await this.fetchRole();
    return data;
  },
  // Always resolves without revealing whether the email is registered —
  // Supabase (and we) keep the response uniform for account enumeration.
  async resetPassword(email) {
    const { error } = await this.client.auth.resetPasswordForEmail(email, {
      redirectTo: this.authRedirect(),
    });
    if (error) throw error;
  },
  async updatePassword(password) {
    const { data, error } = await this.client.auth.updateUser({ password });
    if (error) throw error;
    return data;
  },
  async signOut() {
    // scope:"local" always clears the local session (even offline) so a reload
    // can't silently re-authenticate; we also null our cached user regardless.
    try { await this.client.auth.signOut({ scope: "local" }); }
    catch (e) { console.warn("[Cloud] signOut:", e); }
    finally { this._user = null; this._pendingRecovery = false; this.playersReady = false; }
  },

  // ---- RPC helpers (Phase 1 players table) --------------------------------
  async rpc(name, args = {}) {
    if (!this.signedIn()) throw new Error("not signed in");
    const { data, error } = await this.client.rpc(name, args);
    if (error) throw error;
    return data;
  },
  _isMissingRpc(err) {
    const m = String((err && (err.message || err.details || err)) || "").toLowerCase();
    return m.includes("could not find the function") || m.includes("pgrst202")
      || m.includes("does not exist") || (err && err.code === "PGRST202");
  },

  // Ensure players row + return authoritative state. Falls back (playersReady=
  // false) when Phase 1 SQL isn't applied yet so older projects keep working.
  async bootstrap() {
    if (!this.signedIn()) return null;
    try {
      const state = await this.rpc("app_bootstrap");
      this.playersReady = true;
      return state;
    } catch (e) {
      if (this._isMissingRpc(e)) {
        this.playersReady = false;
        console.warn("[Cloud] app_bootstrap missing — using legacy saves (docs/PHASE1_SETUP.md)");
        return null;
      }
      throw e;
    }
  },
  async trade(action, commodity, qty) {
    return this.rpc("app_trade", { p_action: action, p_commodity: commodity, p_qty: qty | 0 });
  },
  async dock(system) {
    return this.rpc("app_dock", { p_system: system });
  },
  async unlock(system) {
    return this.rpc("app_unlock", { p_system: system });
  },
  // Autosave / soft-economy sync. Returns the RPC result `{ ok, state }`.
  // Phase 1–2 interim: server accepts client credits/positions (+ bazaar board);
  // protects travel and (Phase 2) ships/missions/items/inventory.
  async commit(state) {
    return this.rpc("app_commit", { p_state: state });
  },

  // Phase 2 — missions & bazaar
  async missionLaunch(contract, shipUids) {
    return this.rpc("app_mission_launch", { p_contract: contract, p_ship_uids: shipUids });
  },
  async missionResolve() {
    return this.rpc("app_mission_resolve");
  },
  async buyShip(catalogId) {
    return this.rpc("app_buy_ship", { p_catalog_id: catalogId });
  },
  async buyMain(catalogId) {
    return this.rpc("app_buy_main", { p_catalog_id: catalogId });
  },
  async buyMerc(offerId) {
    return this.rpc("app_buy_merc", { p_offer_id: offerId });
  },
  async buyAccessory(offerId) {
    return this.rpc("app_buy_accessory", { p_offer_id: offerId });
  },
  async takeContract(offerId) {
    return this.rpc("app_take_contract", { p_offer_id: offerId });
  },
  async upgradeInventory() {
    return this.rpc("app_upgrade_inventory");
  },
  async sellShip(uid) {
    return this.rpc("app_sell_ship", { p_uid: uid });
  },
  async sellItem(uid) {
    return this.rpc("app_sell_item", { p_uid: uid });
  },

  // ---- legacy save row (guest migrate / Phase-1 fallback) ----------------
  async loadRemote() {
    if (!this.signedIn()) return null;
    const { data, error } = await this.client
      .from("saves").select("data").eq("user_id", this._user.id).maybeSingle();
    if (error) throw error;
    return data ? data.data : null;
  },
  async saveRemote(state) {
    if (!this.signedIn()) return;
    // Prefer authoritative commit when Phase 1 is live.
    if (this.playersReady) {
      const r = await this.commit(state);
      if (r && r.ok === false) throw new Error((r && r.error) || "app_commit failed");
      // Pull server-protected slices back into the live game state.
      if (r && r.state && window.Game && Game.state === state && window.Economy) {
        Economy.applyCommitState(r.state);
      } else if (r && r.state && window.Game && Game.state === state) {
        const st = r.state;
        if (st.currentSystem) state.currentSystem = st.currentSystem;
        state.travel = st.travel && typeof st.travel === "object" ? st.travel : null;
        if (st.unlockedSystems) state.unlockedSystems = st.unlockedSystems;
      }
      return;
    }
    const { error } = await this.client.from("saves").upsert({
      user_id: this._user.id, data: state, updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  },
  async clearRemote() {
    if (!this.signedIn()) return;
    // Best-effort: wipe legacy saves; players row is removed with the auth user
    // (ON DELETE CASCADE) — no client delete policy on players by design.
    try {
      const { error } = await this.client.from("saves").delete().eq("user_id", this._user.id);
      if (error) throw error;
    } catch (e) { console.warn("[Cloud] clearRemote saves:", e); }
  },
};

window.Cloud = Cloud;
