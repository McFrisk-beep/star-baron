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
  _username: null,
  _joinN: null,
  // Admin/dev: pause server authority for this session so local state (e.g.
  // admin-set credits) is king and app_pull/app_commit stop clobbering it. Not
  // persisted — a reload re-syncs from the authoritative players row.
  _devLocal: false,
  // true once app_bootstrap succeeds this session; false → legacy saves path.
  playersReady: false,
  // true once app_pull succeeds this session; false → local soft-income catch-up.
  pullReady: false,
  // true when app_pull RPC is confirmed missing (Phase 3 SQL not installed).
  // Distinct from "pull failed transiently" — only then may local soft income run
  // for logged-in players (Phase 2 fallback). Otherwise local minting creates
  // ghost positions/credits that Phase 3 app_commit / app_trade will reject.
  pullMissing: false,

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
  authoritative() { return this.signedIn() && this.playersReady && !this._devLocal; },
  user() { return this._user; },
  email() { return this._user ? this._user.email : null; },

  // Role + public username come from `profiles` (server-side). Username is
  // written only via app_set_username — never a direct client UPDATE.
  async fetchRole() {
    if (!this.enabled || !this._user) {
      this._role = "player"; this._username = null; this._joinN = null;
      return this._role;
    }
    try {
      let data = null, error = null;
      ({ data, error } = await this.client
        .from("profiles").select("role,username,join_n").eq("user_id", this._user.id).maybeSingle());
      if (error && /username|join_n|column/i.test(String(error.message || error))) {
        ({ data, error } = await this.client
          .from("profiles").select("role").eq("user_id", this._user.id).maybeSingle());
      }
      if (error) throw error;
      this._role = (data && data.role) || "player";
      this._username = (data && data.username) || null;
      this._joinN = (data && data.join_n != null) ? Number(data.join_n) : null;
    } catch (e) {
      console.warn("[Cloud] role fetch failed:", e);
      this._role = "player"; this._username = null; this._joinN = null;
    }
    return this._role;
  },
  isAdmin() { return this.signedIn() && this._role === "admin"; },
  role() { return this.signedIn() ? this._role : "guest"; },
  username() { return this.signedIn() ? this._username : null; },
  joinN() { return this.signedIn() ? this._joinN : null; },
  // Public handle: custom username, else "Baron #<join_n>", else email local-part.
  displayName() {
    if (!this.signedIn()) return null;
    if (window.Username) return Username.display(this._username, this._joinN);
    if (this._username) return this._username;
    if (this._joinN) return "Baron #" + this._joinN;
    const email = this.email() || "";
    return email.split("@")[0] || "Baron";
  },
  defaultDisplayName() {
    if (window.Username) return Username.defaultLabel(this._joinN);
    return this._joinN ? "Baron #" + this._joinN : "Baron";
  },
  async setUsername(name) {
    if (!this.signedIn()) throw new Error("not signed in");
    if (window.Username) {
      const v = Username.validate(name, { allowEmpty: true });
      if (!v.ok) return { ok: false, msg: v.msg };
      name = v.value;
    }
    try {
      const data = await this.rpc("app_set_username", { p_username: name == null ? "" : String(name) });
      if (!data || !data.ok) return { ok: false, msg: (data && data.error) || "Could not set username." };
      this._username = data.username || null;
      if (data.join_n != null) this._joinN = Number(data.join_n);
      return { ok: true, username: this._username, join_n: this._joinN, display: data.display || this.displayName() };
    } catch (e) {
      if (this._isMissingRpc(e)) {
        return { ok: false, msg: "Username isn't available yet — run docs/sql/profile_username.sql." };
      }
      throw e;
    }
  },

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
    finally {
      this._user = null; this._pendingRecovery = false;
      this._username = null; this._joinN = null;
      this.playersReady = false; this.pullReady = false; this.pullMissing = false;
      this.craftMissing = false; this.hallMissing = false; this.baysMissing = false;
      this._rpcMissing = {};
    }
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
  // Phase 4: shared sector shelf snapshot (docs/sql/phase4_sector_stock.sql).
  async sectorStock() {
    try { return await this.rpc("app_sector_stock"); }
    catch (e) {
      if (typeof this._isMissingRpc === "function" && this._isMissingRpc(e)) return { ok: false, missing: true };
      throw e;
    }
  },
  // Shared station ownership directory (docs/sql/station_directory.sql).
  // Anon-readable on purpose: a signed-out visitor must see who holds a station
  // instead of the local save's "NPC". Missing SQL latches → everyone falls back
  // to the local-only view.
  async stationDirectory() {
    if (!this.enabled || !this.client || this._rpcMissing.app_station_directory) return null;
    const { data, error } = await this.client.rpc("app_station_directory");
    if (error) {
      if (this._isMissingRpc(error)) {
        this._rpcMissing.app_station_directory = true;
        console.warn("[Cloud] app_station_directory missing — run docs/sql/station_directory.sql");
        return null;
      }
      throw error;
    }
    return data || [];
  },
  async stationPublish(rows) {
    return this._optional("app_station_publish", { p_stations: rows || [] });
  },

  // Cross-player Exchange Hall (docs/sql/station_hall.sql). The read is anon
  // like the directory — a signed-out visitor browses the shelf, they just
  // can't buy. `hallMissing` latches off THIS call and gates the write RPCs:
  // phase 4 ships app_station_list_item/buy_item as not-implemented stubs, so
  // "the function exists" proves nothing. If the shelf can't be read, the
  // client stays on its local hall instead of posting into a stub.
  hallMissing: false,
  async stationHall(systems) {
    if (!this.enabled || !this.client || this.hallMissing) return null;
    const list = (systems || []).filter(Boolean).slice(0, 20);
    if (!list.length) return [];
    const { data, error } = await this.client.rpc("app_station_hall", { p_systems: list });
    if (error) {
      if (this._isMissingRpc(error)) {
        this.hallMissing = true;
        console.warn("[Cloud] app_station_hall missing — run docs/sql/station_hall.sql");
        return null;
      }
      throw error;
    }
    return data || [];
  },
  hallReady() { return this.enabled && !this.hallMissing && this.signedIn(); },
  async stationListItem(system, listing) {
    return this.rpc("app_station_list_item", { p_system: system, p_listing: listing });
  },
  async stationBuyItem(system, listingId) {
    return this.rpc("app_station_buy_item", { p_system: system, p_listing_id: listingId });
  },
  async stationBuyRefund(listingId) {
    return this._optional("app_station_buy_refund", { p_listing_id: listingId });
  },
  async stationCancelListing(listingId) {
    return this.rpc("app_station_cancel_listing", { p_listing_id: listingId });
  },
  async stationSettle() {
    return this._optional("app_station_settle", {});
  },

  // Cross-player Production Hub bays (docs/sql/station_bays.sql). Latches off
  // the lease RPC the same way hallMissing latches off the shelf read — phase 4
  // ships app_station_lease_bay as a not-implemented stub, so "the function
  // exists" proves nothing. A project without this SQL keeps local-only leases.
  baysMissing: false,
  async _bayRpc(name, args) {
    if (this.baysMissing) return { ok: false, error: "Station bays not live on server yet." };
    try { return await this.rpc(name, args || {}); }
    catch (e) {
      if (this._isMissingRpc(e)) {
        this.baysMissing = true;
        console.warn("[Cloud] " + name + " missing — run docs/sql/station_bays.sql");
        return { ok: false, error: "Station bays not live on server yet." };
      }
      throw e;
    }
  },
  baysReady() { return this.enabled && !this.baysMissing && this.signedIn(); },
  async stationLeaseBay(system, bay, extractor) {
    return this._bayRpc("app_station_lease_bay", {
      p_system: system, p_bay: bay | 0, p_extractor: extractor || "",
    });
  },
  async stationVacateBay(system, bay) {
    return this._bayRpc("app_station_vacate_bay", { p_system: system, p_bay: bay | 0 });
  },
  async stationBayProduce(system, bay, gross) {
    return this._bayRpc("app_station_bay_produce", {
      p_system: system, p_bay: bay | 0, p_gross: gross | 0,
    });
  },

  // Station treasury + authoritative hall credits (docs/sql/station_treasury.sql).
  // Latches off withdraw the same way bays latch off lease — phase 4 stubs exist
  // but "the function exists" proves nothing until this paste is applied.
  treasuryMissing: false,
  async _treasuryRpc(name, args) {
    if (this.treasuryMissing) return { ok: false, error: "Station treasury not live on server yet." };
    try { return await this.rpc(name, args || {}); }
    catch (e) {
      if (this._isMissingRpc(e)) {
        this.treasuryMissing = true;
        console.warn("[Cloud] " + name + " missing — run docs/sql/station_treasury.sql");
        return { ok: false, error: "Station treasury not live on server yet." };
      }
      throw e;
    }
  },
  treasuryReady() { return this.enabled && !this.treasuryMissing && this.signedIn(); },
  async stationWithdraw(system, amount) {
    return this._treasuryRpc("app_station_withdraw", { p_system: system, p_amount: amount | 0 });
  },
  async stationSetPolicy(system, policy) {
    return this._treasuryRpc("app_station_set_policy", { p_system: system, p_policy: policy || {} });
  },

  // Cross-player Contract Office (docs/sql/station_contracts.sql).
  contractsMissing: false,
  async _contractsRpc(name, args) {
    if (this.contractsMissing) return { ok: false, error: "Station contracts not live on server yet." };
    try { return await this.rpc(name, args || {}); }
    catch (e) {
      if (this._isMissingRpc(e)) {
        this.contractsMissing = true;
        console.warn("[Cloud] " + name + " missing — run docs/sql/station_contracts.sql");
        return { ok: false, error: "Station contracts not live on server yet." };
      }
      throw e;
    }
  },
  contractsReady() { return this.enabled && !this.contractsMissing && this.signedIn(); },
  async stationHauls(systems) {
    if (!this.enabled || !this.client || this.contractsMissing) return null;
    const list = (systems || []).filter(Boolean).slice(0, 20);
    if (!list.length) return [];
    const { data, error } = await this.client.rpc("app_station_hauls", { p_systems: list });
    if (error) {
      if (this._isMissingRpc(error)) {
        this.contractsMissing = true;
        console.warn("[Cloud] app_station_hauls missing — run docs/sql/station_contracts.sql");
        return null;
      }
      throw error;
    }
    return data || [];
  },
  async stationPostHaul(system, commId, qty, rate) {
    return this._contractsRpc("app_station_post_haul", {
      p_system: system, p_comm_id: commId, p_qty: qty | 0, p_rate: rate | 0,
    });
  },
  async stationCancelHaul(haulId) {
    return this._contractsRpc("app_station_cancel_haul", { p_haul_id: haulId });
  },
  async stationClaimHaul(haulId) {
    return this._contractsRpc("app_station_claim_haul", { p_haul_id: haulId });
  },
  async stationLaunchHaul(haulId, shipUids) {
    return this._contractsRpc("app_station_launch_haul", {
      p_haul_id: haulId, p_ship_uids: shipUids || [],
    });
  },
  async stationSettleHaul(haulId, outcome) {
    return this._contractsRpc("app_station_settle_haul", { p_haul_id: haulId, p_outcome: outcome });
  },
  async stationExpireHauls(system) {
    return this._contractsRpc("app_station_expire_hauls", { p_system: system });
  },
  async stationHoldDeposit(system, deltas) {
    // Draw-only — production is deposited by app_station_after_hour.
    return this._contractsRpc("app_station_hold_deposit", {
      p_system: system, p_deltas: deltas || {},
    });
  },
  async stationDeliver(system, commId, qty) {
    return this._contractsRpc("app_station_deliver", {
      p_system: system, p_comm: commId, p_qty: qty | 0,
    });
  },
  async stationRelease(system, mode) {
    return this._contractsRpc("app_station_release", {
      p_system: system, p_mode: mode || "relinquish",
    });
  },

  // Standing + upkeep cycle (docs/sql/station_upkeep.sql) — phase D2.
  async stationAfterHour(reports) {
    return this._treasuryRpc("app_station_after_hour", { p_reports: reports || [] });
  },

  // Module install (docs/sql/station_modules.sql) — phase D3.
  modulesMissing: false,
  async _modulesRpc(name, args) {
    if (this.modulesMissing) return { ok: false, error: "Station modules not live on server yet." };
    try { return await this.rpc(name, args || {}); }
    catch (e) {
      if (this._isMissingRpc(e)) {
        this.modulesMissing = true;
        console.warn("[Cloud] " + name + " missing — run docs/sql/station_modules.sql");
        return { ok: false, error: "Station modules not live on server yet." };
      }
      throw e;
    }
  },
  modulesReady() { return this.treasuryReady() && !this.modulesMissing; },
  async stationModuleInstall(system, module) {
    return this._modulesRpc("app_station_module_install", { p_system: system, p_module: module });
  },
  async stationModuleUninstall(system, module) {
    return this._modulesRpc("app_station_module_uninstall", { p_system: system, p_module: module });
  },

  // Station auctions (docs/sql/station_auctions.sql) — phase D4.
  auctionsMissing: false,
  async _auctionsRpc(name, args) {
    if (this.auctionsMissing) return { ok: false, error: "Station auctions not live on server yet." };
    try { return await this.rpc(name, args || {}); }
    catch (e) {
      if (this._isMissingRpc(e)) {
        this.auctionsMissing = true;
        console.warn("[Cloud] " + name + " missing — run docs/sql/station_auctions.sql");
        return { ok: false, error: "Station auctions not live on server yet." };
      }
      throw e;
    }
  },
  auctionsReady() { return this.enabled && !this.auctionsMissing && this.signedIn(); },
  async stationAuctions() {
    if (!this.enabled || !this.client || this.auctionsMissing) return null;
    const { data, error } = await this.client.rpc("app_station_auctions");
    if (error) {
      if (this._isMissingRpc(error)) {
        this.auctionsMissing = true;
        console.warn("[Cloud] app_station_auctions missing — run docs/sql/station_auctions.sql");
        return null;
      }
      throw error;
    }
    return data || [];
  },
  async stationAuctionOpen(system, amount) {
    return this._auctionsRpc("app_station_auction_open", { p_system: system, p_amount: amount | 0 });
  },
  async stationBid(system, amount) {
    return this._auctionsRpc("app_station_bid", { p_system: system, p_amount: amount | 0 });
  },
  async stationCloseDue() {
    return this._auctionsRpc("app_station_close_due", {});
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
  //
  // app_commit echoes the WHOLE merged save back — ~215KB, of which
  // applyCommitState reads none of the world slices. app_commit_lite
  // (docs/sql/commit_lite.sql) is a thin wrapper that returns the same result
  // minus those slices. Latch on the first miss so a project running older SQL
  // just keeps paying for the fat response instead of erroring every autosave.
  commitLiteMissing: false,
  async commit(state) {
    if (!this.commitLiteMissing) {
      try { return await this.rpc("app_commit_lite", { p_state: state }); }
      catch (e) {
        if (!this._isMissingRpc(e)) throw e;
        this.commitLiteMissing = true;
        console.warn("[Cloud] app_commit_lite missing — full-size commits (docs/sql/commit_lite.sql)");
      }
    }
    return this.rpc("app_commit", { p_state: state });
  },

  // Workshop — server-authoritative crafting (docs/sql/workshop_craft.sql).
  // craftMissing latches when that file hasn't been applied yet, so a project
  // running older SQL keeps the local craft path instead of erroring on every
  // click. Crafted gear won't survive a commit there — the same as before.
  craftMissing: false,
  async _craftRpc(name, args) {
    if (this.craftMissing) return null;
    try { return await this.rpc(name, args || {}); }
    catch (e) {
      if (this._isMissingRpc(e)) {
        this.craftMissing = true;
        console.warn("[Cloud] " + name + " missing — local crafting (docs/sql/workshop_craft.sql)");
        return null;
      }
      throw e;
    }
  },
  craftReady() { return this.authoritative() && !this.craftMissing; },
  async craftStart(recipeId, flavorId) {
    return this._craftRpc("app_craft_start", { p_recipe_id: recipeId, p_flavor_id: flavorId || null });
  },
  async craftClaim() { return this._craftRpc("app_craft_claim"); },
  async craftSlot() { return this._craftRpc("app_craft_slot"); },
  async craftAdopt(workshop, items) {
    return this._craftRpc("app_craft_adopt", { p_workshop: workshop || {}, p_items: items || {} });
  },

  // Repair / equip — server-authoritative (docs/sql/repair_equip.sql).
  // Both used to be client-only mutations of state.ships, which app_commit then
  // overwrote from the server row (repair) or filtered against the server items
  // pool (equip). `_optional` latches a missing RPC the same way craftMissing
  // does, so a project running older SQL falls back to the old local behaviour
  // instead of erroring on every click. shipRpcReady() is what the client checks
  // BEFORE the optimistic mutation, so a fallback never costs a round trip.
  // Latched by Economy._applyServerSlice when app_pull/app_commit echoes a
  // `mining` key — i.e. docs/sql/mining_rpcs.sql is applied and the server owns
  // belt ops. There is no mining RPC to probe with _optional(): mining rides
  // app_pull, so the echoed slice IS the capability check.
  miningOwned: false,
  _rpcMissing: {},
  async _optional(name, args) {
    if (this._rpcMissing[name]) return null;
    try { return await this.rpc(name, args || {}); }
    catch (e) {
      if (this._isMissingRpc(e)) {
        this._rpcMissing[name] = true;
        console.warn("[Cloud] " + name + " missing — local fallback (docs/sql/repair_equip.sql)");
        return null;
      }
      throw e;
    }
  },
  shipRpcReady(name) { return this.authoritative() && !this._rpcMissing[name]; },
  async repairShip(uid) { return this._optional("app_repair_ship", { p_uid: uid }); },
  // Impound retrieval — server-authoritative (docs/sql/impound_retrieve.sql).
  // Latches a missing RPC like repair/equip so older projects keep the local path.
  async retrieveShip(uid) { return this._optional("app_retrieve_ship", { p_uid: uid }); },
  // Abandon an impounded hull forever (docs/sql/impound_retrieve.sql).
  async abandonShip(uid) { return this._optional("app_abandon_ship", { p_uid: uid }); },
  // Mirror a customs/piracy seizure onto the server ledger (docs/sql/customs_seize.sql).
  async customsSeize(commId, qty) {
    return this._optional("app_customs_seize", { p_comm: commId, p_qty: qty | 0 });
  },
  async equipItem(shipUid, itemUid) {
    return this._optional("app_equip_item", { p_ship_uid: shipUid, p_item_uid: itemUid });
  },
  async unequipItem(shipUid, itemUid) {
    return this._optional("app_unequip_item", { p_ship_uid: shipUid, p_item_uid: itemUid });
  },

  // Charters — server-authoritative dispatch/cancel/resolve
  // (docs/sql/charter_rpcs.sql). Latch a missing RPC like repair/equip so a
  // project running older SQL keeps the client-local charter loop.
  async charterDispatch(charter) {
    return this._optional("app_charter_dispatch", { p_charter: charter });
  },
  async charterCancel(charterId) {
    return this._optional("app_charter_cancel", { p_charter_id: charterId });
  },
  async charterResolve() { return this._optional("app_charter_resolve", {}); },

  // Phase 2 — missions & bazaar
  async missionLaunch(contractId, shipUids) {
    return this.rpc("app_mission_launch", { p_contract_id: contractId, p_ship_uids: shipUids });
  },
  async missionResolve() {
    return this.rpc("app_mission_resolve");
  },
  async bazaarBoard() {
    return this.rpc("app_bazaar_board");
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
  async cancelPendingContract(contractId) {
    return this.rpc("app_cancel_pending_contract", { p_contract_id: contractId });
  },
  async missionAbandon(missionUid) {
    return this.rpc("app_mission_abandon", { p_mission_uid: missionUid });
  },
  // Phase 3: close a parked survey debrief (Dispatches choice).
  async surveyDebrief(expId, outcome) {
    return this.rpc("app_survey_debrief", { p_exp_id: expId, p_outcome: outcome });
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

  // Phase 3 — offline catch-up + prestige
  async pull() {
    const r = await this.rpc("app_pull");
    this.pullReady = true;
    this.pullMissing = false;
    return r;
  },
  async prestige() {
    return this.rpc("app_prestige");
  },
  // Admin dev helper: set the caller's OWN credits/tier server-side (see
  // docs/sql/admin_grant.sql). Pass null to leave a field unchanged.
  async adminGrant(credits, tier) {
    return this.rpc("app_admin_grant", {
      p_credits: credits == null ? null : credits,
      p_tier: tier == null ? null : tier,
    });
  },
  // Settings → Reset Save: wipe the caller's players.state to defaults
  // (docs/sql/reset_save.sql). Keeps cosmetic settings only.
  async resetSave() {
    return this.rpc("app_reset_save");
  },
  // Settings → Restore backup: return the caller's current players.state.
  // No client economy payload (docs/sql/restore_backup.sql). Corrupt-migrate
  // never wiped the cloud row — the client overlays Workshop from the browser backup.
  restoreMissing: false,
  async restoreBackup() {
    if (this.restoreMissing) return { ok: false, missing: true, error: "Restore backup RPC not live." };
    try { return await this.rpc("app_restore_backup"); }
    catch (e) {
      if (this._isMissingRpc(e)) {
        this.restoreMissing = true;
        console.warn("[Cloud] app_restore_backup missing — run docs/sql/restore_backup.sql");
        return { ok: false, missing: true, error: "Restore backup RPC not live." };
      }
      throw e;
    }
  },
  // Admin → Issue Global Reset: consume the shared world_reset epoch server-side
  // (docs/sql/reset_save.sql). The epoch is read from the table by the RPC, never
  // sent from here. Returns { ok, applied, epoch, state }.
  async worldResetApply() {
    return this.rpc("app_world_reset_apply");
  },
  async routeStart(comm, from, to, shipUids) {
    return this.rpc("app_route_start", { p_comm: comm, p_from: from, p_to: to, p_ship_uids: shipUids });
  },
  async routeStop(routeId) {
    return this.rpc("app_route_stop", { p_route_id: routeId });
  },
  async buyExtractor(offerId) {
    return this.rpc("app_buy_extractor", { p_offer_id: offerId });
  },
  async buyComponent(offerId) {
    return this.rpc("app_buy_component", { p_offer_id: offerId });
  },

  // ---- legacy save row (guest migrate / Phase-1 fallback) ----------------
  async loadRemote() {
    if (!this.signedIn()) return null;
    const { data, error } = await this.client
      .from("saves").select("data").eq("user_id", this._user.id).maybeSingle();
    if (error) throw error;
    return data ? data.data : null;
  },
  // Save slices that stay in localStorage and never reach the cloud row: shared
  // world state every client re-reads from the world tables, or regenerates from
  // the seed. Store.carryLocalOnly hands them back across a cloud load so the
  // same browser keeps its copy; a new device just rebuilds them.
  //   galaxy   — per-system flavour log, ~47KB of rendered sentences (ensureSeeded)
  //   senate   — shared agenda + outcomes (world_senate / world_senate_result)
  //   newswire — shared events (world_news)
  //   stock    — shared shelf (app_sector_stock)
  //   market   — effects ride on world_news; prices/hist are recomputed
  //   war      — the running faction war; Wars.tick regenerates one
  // Cross-device recovery for these leans on the shared world tables; a
  // project without that SQL regenerates them fresh on a new device. The same
  // browser always keeps its copy via localStorage + carryLocalOnly.
  // mining/beltPools: guest-local for now — dispatch is gated off the server
  // ledger (Mining.canStart) until the mining SQL phase adds its RPC surface,
  // at which point both move onto WIRE_KEYS + commit_allowlist together.
  localOnly: ["galaxy", "senate", "newswire", "stock", "market", "war"],
  // The legacy `saves` strip is ONLY galaxy (cosmetic, regenerated): that row
  // has no server-side merge and no guaranteed world tables behind it, so it
  // must keep carrying the world slices or a device change loses them —
  // including senate laws passed under the local fallback.
  legacyStrip: ["galaxy"],
  wireState(state) {
    if (!state || typeof state !== "object") return state;
    const out = { ...state };
    for (const k of this.legacyStrip) delete out[k];
    return out;
  },

  // What app_commit is allowed to receive. MUST stay identical to the allowlist
  // in docs/sql/commit_allowlist.sql — the server drops anything else on arrival,
  // so a key here that isn't there is silently discarded, and a key there that
  // isn't here never gets saved. tools/check_cloud_egress.js pins them together.
  //
  // Everything omitted is server-owned: app_commit overwrites it from the stored
  // row regardless, so shipping it up the wire only costs bandwidth. The first
  // five ARE read off the client (credits ratchet, ship fitment, and the
  // industry/expedition/extractor merges) — removing one breaks a merge.
  WIRE_KEYS: [
    "credits", "ships", "industries", "expeditions", "extractors",
    "hold", "stationInv", "shipments", "_haulingMigrated",
    "reports", "orders", "pendingHaulSettles", "seq",
    // Mining ops + what you took off each rock. Merge inputs once
    // docs/sql/mining_rpcs.sql is applied: app._merge_mining accepts new
    // dispatches and a recall, and owns every timer and counter after that;
    // app._merge_belt_pools only ever lets a rock's `used` go UP within a
    // generation. On a project without that SQL they ride as client-owned and
    // mining stays local, exactly as it was.
    "mining", "beltPools",
    // craftedOnce IS sent even though the server owns it: on a project running
    // older SQL (or the raw-app_commit fallback) the row keeps whatever the
    // client sends, so omitting it would wipe the burn list there — and a
    // guest's locally-earned marks must reach the bootstrap on first commit.
    // Where the new wrapper IS applied, it substitutes the stored value under
    // a row lock, so this upload can never CLEAR a mark once the row exists.
    "craftedOnce",
    // activeBoosts and knownRecipes stay client-owned — blackboxes and
    // blueprints are minted client-side by the bazaar (see Economy._softSnap),
    // so the server has no record to force them from.
    "activeBoosts", "knownRecipes",
    "shipVariants", "achievements", "stats",
    "story", "settings", "rivals", "rivalsMeta",
    // lastSeenAt is deliberately absent: app._write_state stamps the server
    // clock on every commit, and the client restamps it around every
    // suspend/resume — keeping it here made every payload unique, which turned
    // the dirty check into dead code on the commit path. The legacy saves path
    // still sends it (wireState), where Store.load's freshness compare needs it.
    "voySeenT", "voyChecks",
    "v", "appliedResetEpoch", "cloudUserId",
    // Lazily created — absent from defaultState(), so easy to miss. surveyRetry
    // holds survey debriefs whose RPC dropped mid-flight; losing it loses the
    // payout. tools/check_cloud_egress.js enumerates the real top-level keys
    // from source so a new one fails the build instead of vanishing in silence.
    "surveyRetry",
    "stations",
  ],
  // The app_commit payload. Distinct from wireState(): the legacy `saves` row has
  // NO server-side merge behind it, so that path must keep sending the whole save
  // or a pre-Phase-1 player loses every server-owned slice on their next load.
  commitState(state) {
    if (!state || typeof state !== "object") return state;
    const out = {};
    for (const k of this.WIRE_KEYS) if (state[k] !== undefined) out[k] = state[k];
    return out;
  },

  async saveRemote(state) {
    if (!this.signedIn()) return;
    // Cloud sync paused (dev/admin local-test): don't run app_commit — it echoes
    // the server-owned slices (credits, ships, …) back over local state, which is
    // exactly what "keep my local edits" must avoid. Local save already happened.
    if (this._devLocal) return;
    // Prefer authoritative commit when Phase 1 is live.
    if (this.playersReady) {
      // Strip here, not in the caller: `state` must stay the live object so the
      // Game.state identity check below still recognises it.
      const r = await this.commit(this.commitState(state));
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
      user_id: this._user.id, data: this.wireState(state), updated_at: new Date().toISOString(),
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
