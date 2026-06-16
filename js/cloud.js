/* cloud.js — the ONLY module that talks to Supabase (auth + the `saves` table).
   Everything is wrapped so the rest of the game never imports the SDK directly.
   If CLOUD isn't configured (or the SDK failed to load), `enabled` stays false
   and the game runs purely on localStorage. Saves are stored as one JSONB row
   per user, protected by Row-Level Security (auth.uid() = user_id).            */

const Cloud = {
  client: null,
  enabled: false,
  _user: null,
  _role: "player",

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
      this.client.auth.onAuthStateChange((_evt, session) => {
        this._user = session ? session.user : null;
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
  async signUp(email, password) {
    const { data, error } = await this.client.auth.signUp({ email, password });
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
  async signOut() {
    // scope:"local" always clears the local session (even offline) so a reload
    // can't silently re-authenticate; we also null our cached user regardless.
    try { await this.client.auth.signOut({ scope: "local" }); }
    catch (e) { console.warn("[Cloud] signOut:", e); }
    finally { this._user = null; }
  },

  // ---- save row (one JSONB blob per user) --------------------------------
  async loadRemote() {
    if (!this.signedIn()) return null;
    const { data, error } = await this.client
      .from("saves").select("data").eq("user_id", this._user.id).maybeSingle();
    if (error) throw error;
    return data ? data.data : null;
  },
  async saveRemote(state) {
    if (!this.signedIn()) return;
    const { error } = await this.client.from("saves").upsert({
      user_id: this._user.id, data: state, updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  },
  async clearRemote() {
    if (!this.signedIn()) return;
    const { error } = await this.client.from("saves").delete().eq("user_id", this._user.id);
    if (error) throw error;
  },
};

window.Cloud = Cloud;
