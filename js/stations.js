/* stations.js — claimable space stations + auctions + production (docs/STATIONS.md).
   Guest / single-player first: all 78 non-capital stations exist as NPC entities,
   feed sector stock, and can be auctioned / owned locally. Server RPCs later.   */

const Stations = {
  byId: {},           // systemId -> station
  auctions: {},       // systemId -> auction (local / guest)
  remoteAuctions: {}, // systemId -> auction (server, phase D4)
  access: {},         // systemId -> { playerId -> role }
  ledger: {},         // systemId -> [{at, kind, amount, note}]
  lastWarn: {},       // systemId -> stage string (comms dedupe)

  playerId() {
    const c = window.Cloud;
    if (c && c.signedIn && c.signedIn()) {
      const u = typeof c.user === "function" ? c.user() : c.user;
      if (u) return u.id || u.email || "player";
    }
    return "player";
  },

  tierOf(stationName) {
    if (!stationName) return "Berth";
    const parts = String(stationName).split(/\s+/);
    const suf = parts[parts.length - 1];
    return STATION_TIERS[suf] ? suf : "Berth";
  },

  tierInfo(tier) { return STATION_TIERS[tier] || STATION_TIERS.Berth; },

  // ---- build / ensure ----------------------------------------------------
  ensure() {
    if (!window.Galaxy || !Galaxy.list || !Galaxy.list.length) return;
    for (const sys of Galaxy.list) {
      if (sys.capital) continue; // capitals are not claimable stations
      if (this.byId[sys.id]) {
        // Keep name in sync if galaxy rebuild renamed (shouldn't, seed-stable).
        this.byId[sys.id].name = sys.stationName;
        this.byId[sys.id].tier = this.tierOf(sys.stationName);
        continue;
      }
      this.byId[sys.id] = this._fresh(sys);
    }
  },

  _fresh(sys) {
    const tier = this.tierOf(sys.stationName);
    return {
      systemId: sys.id,
      sectorId: sys.sectorId,
      name: sys.stationName,
      tier,
      ownerId: null,
      status: "npc",            // npc | owned | refit | cooldown
      modules: {},              // id -> level (1-based)
      reactorLevel: 0,
      treasury: 0,
      standing: STATIONCFG.standingStart,
      leaseTaxBps: 1000,
      saleTariffBps: 500,
      scrutiny: 10,             // 0–100 public
      hold: {},                 // owner production awaiting haul
      prodComm: null,           // assigned Production Hub commodity
      bays: [],                 // [{lesseeId, extractorId}]
      hall: [],                 // Exchange Hall listings
      contracts: [],            // Contract Office haul posts
      contractStats: { filled: 0, expired: 0 },
      impoundHold: {},          // Customs House seized cargo { commId: qty }
      impoundClaims: [],        // [{id, commId, qty, value, fromId, ransom}]
      upkeepPaidThrough: 0,
      cooldownUntil: 0,
      refitUntil: 0,
      delivered: 0,             // units delivered this cycle (standing)
      expected: 0,
    };
  },

  get(systemId) { return this.byId[systemId] || null; },
  list() { return Object.values(this.byId); },
  claimable() { return this.list().filter(st => st.status === "npc" || st.status === "cooldown"); },

  // "refit" is an owner-held *offline* state: services and production stop, but
  // the owner keeps the station and its console. Only npc/cooldown are ownerless.
  ownerHeld(st) { return !!st && (st.status === "owned" || st.status === "refit"); },
  refitLeft(st) {
    return st && st.status === "refit" ? Math.max(0, (+st.refitUntil || 0) - Date.now()) : 0;
  },

  // Downtime a *pending* change would cost, in ms (0 = none). One place for the
  // rule so the confirm prompt and the change itself can never disagree.
  retoolCost(st, commId) {
    return st && st.prodComm && st.prodComm !== commId ? Math.floor(STATIONCFG.refitMs / 2) : 0;
  },
  uninstallCost() { return STATIONCFG.refitMs; },

  ownedBy(pid = this.playerId()) {
    return this.list().filter(st => this.ownerHeld(st) && this._mine(st, pid));
  },
  ownedCount(pid = this.playerId()) { return this.ownedBy(pid).length; },

  // Guest saves key ownership as "player"; signed-in playerId() is the account
  // uuid. Until server auctions own the claim, treat legacy "player" as ours.
  _mine(st, pid = this.playerId()) {
    return !!st && (st.ownerId === pid || (st.ownerId === "player" && pid !== "player"));
  },

  ownerCap(tierIdx) {
    if (Array.isArray(STATIONCFG.ownerCap)) {
      return STATIONCFG.ownerCap[Util.clamp(tierIdx | 0, 0, STATIONCFG.ownerCap.length - 1)] || 1;
    }
    const info = window.Economy ? Economy.tierInfo(tierIdx) : null;
    return (info && info.stations) || 1;
  },

  // ---- shared station record (docs/sql/station_directory.sql) -------------
  // A station's whole record lived only in its owner's save, so every other
  // client — and every signed-out visitor — drew a claimed, fully upgraded
  // station as a vacant NPC berth. The directory is that record, published.
  //
  // Phase A: read-only. view() below feeds every display and every effect that
  // is a pure read of the record (customs, free port, workshop annex, dry dock,
  // buoys), so docking at another baron's station finally does something.
  // Phase B: hall buy/list write the shared shelf. Phase C: bay lease/vacate/
  // produce write the shared bays column and queue the owner's lease tax.
  // Impound ransom still waits (claims aren't published yet).
  directory: {},        // systemId -> published record
  directoryAt: 0,
  _pubTimer: null,
  // Extractors we parked in someone else's bay (uid lives only in our save).
  // systemId -> { bayIndex: extractorUid }
  remoteLeases: {},

  // Cloud identity, used ONLY to recognise our own directory rows. Local
  // ownership keeps using playerId() — that returns "player" in every save, so
  // switching it to the account id would orphan every station already claimed.
  // ponytail: two ids until app_station_* own the ledger; then playerId() goes.
  accountId() {
    const u = (window.Cloud && typeof Cloud.user === "function") ? Cloud.user() : null;
    return u ? String(u.id || u.email || "") : "";
  },

  // The holder as seen by everyone else. null when that's us or nobody.
  remoteHolder(systemId) {
    const row = this.directory[systemId];
    if (!row || !row.ownerId) return null;
    const me = this.accountId();
    return me && row.ownerId === me ? null : row;
  },

  // The station as it actually is right now: our own record when we hold it (or
  // when nobody has published one), otherwise the owner's published record.
  // EVERY display and effect path reads this. Every mutation path keeps using
  // get(), which is always the local record we're allowed to write.
  view(systemId) {
    const st = this.get(systemId);
    if (!st || this.ownerHeld(st)) return st;
    const rem = this.remoteHolder(systemId);
    if (!rem) return st;
    return {
      ...st,
      ownerId: rem.ownerId,
      ownerDisplay: rem.display,
      status: rem.status,
      tier: rem.tier || st.tier,
      modules: rem.modules,
      reactorLevel: rem.reactorLevel,
      leaseTaxBps: rem.leaseTaxBps,
      saleTariffBps: rem.saleTariffBps,
      scrutiny: rem.scrutiny,
      standing: rem.standing,
      prodComm: rem.prodComm,
      refitUntil: rem.refitUntil,
      contractStats: rem.contractStats,
      hall: rem.hall,
      bays: rem.bays,
      // Not published: treasury, hold, contracts, impound. Ours are empty and
      // must stay that way — a visitor's copy is not a place to bank anything.
      treasury: 0,
      hold: {},
      contracts: [],
      impoundClaims: [],
      remote: true,
    };
  },

  // True when this dock belongs to another baron (their record, not ours).
  isRemote(systemId) { return !!this.remoteHolder(systemId) && !this.ownerHeld(this.get(systemId)); },

  // One place answers "who holds this?" for every readout.
  holderLabel(st) {
    if (!st) return "NPC-held";
    if (st.remote) return `Held by ${st.ownerDisplay}`;
    if (this.ownerHeld(st)) return this._mine(st) ? "Yours" : "Player-held";
    const rem = this.remoteHolder(st.systemId);
    return rem ? `Held by ${rem.display}` : "NPC-held";
  },
  // Compact form for the star map / systems list ("NPC" reads as a tag there).
  holderTag(st) {
    if (!st) return "NPC";
    if (st.remote) return `held by ${st.ownerDisplay}`;
    if (this.ownerHeld(st)) return this._mine(st) ? "yours" : "player-held";
    const rem = this.remoteHolder(st.systemId);
    return rem ? `held by ${rem.display}` : "NPC";
  },

  // Another player's client wrote this row, and it lands in innerHTML and in
  // effect math — so it's a trust boundary, same as save data. Every field is
  // re-typed and clamped here; nothing downstream re-checks.
  _txt(v, max = 40) { return String(v == null ? "" : v).replace(/[<>&"']/g, "").slice(0, max); },
  _num(v, lo, hi, dflt) {
    const n = +v;
    return Number.isFinite(n) ? Util.clamp(n, lo, hi) : dflt;
  },
  _ingest(r) {
    const modules = {};
    for (const [id, lvl] of Object.entries((r.modules && typeof r.modules === "object") ? r.modules : {})) {
      if (!STATION_MODULES[id]) continue;   // unknown module ids can't reach the UI
      const max = (STATION_MODULES[id].power || []).length || 1;
      const n = this._num(lvl, 0, max, 0) | 0;
      if (n > 0) modules[id] = n;
    }
    // Hall payloads live in station_listings (phase B); bay occupancy lives in
    // the shared bays column (phase C). Both are re-typed at this boundary.
    const hall = (Array.isArray(r.hall) ? r.hall : []).slice(0, 40).map(l => ({
      id: this._txt(l && l.id, 40),
      name: this._txt(l && l.name, 48) || "Listing",
      kind: this.hallKinds.includes(l && l.kind) ? l.kind : "gear",
      price: this._num(l && l.price, 0, 1e12, 0),
      expiresAt: this._num(l && l.expiresAt, 0, 8.64e15, 0),
      sellerId: this._txt(l && l.sellerId, 64),
    }));
    const bays = (Array.isArray(r.bays) ? r.bays : []).slice(0, 12).map(b => ({
      lesseeId: this._txt(b && b.lesseeId, 64),
      npc: !!(b && b.npc),
    }));
    return {
      ownerId: String(r.owner_id),
      display: this._txt(r.display, 24) || "Baron",
      tier: STATION_TIERS[r.tier] ? r.tier : "Berth",
      status: r.status === "refit" ? "refit" : "owned",
      modules,
      reactorLevel: this._num(r.reactor_level, 0, STATIONCFG.reactor.length, 0) | 0,
      leaseTaxBps: this._num(r.lease_tax_bps, 0, 10000, 1000) | 0,
      saleTariffBps: this._num(r.sale_tariff_bps, 0, 10000, 500) | 0,
      scrutiny: this._num(r.scrutiny, 0, 100, 10) | 0,
      standing: this._num(r.standing, 0, 100, STATIONCFG.standingStart),
      prodComm: COMMODITIES.some(c => c.id === r.prod_comm) ? r.prod_comm : null,
      refitUntil: r.refit_until ? Date.parse(r.refit_until) || 0 : 0,
      hall,
      bays,
      contractStats: {
        filled: this._num(r.contract_filled, 0, 1e6, 0) | 0,
        expired: this._num(r.contract_expired, 0, 1e6, 0) | 0,
      },
    };
  },

  async refreshDirectory() {
    if (!(window.Cloud && Cloud.stationDirectory)) return this.directory;
    try {
      const rows = await Cloud.stationDirectory();
      if (!rows) return this.directory;
      const next = {};
      for (const r of rows || []) {
        const id = r && r.system_id ? String(r.system_id) : "";
        if (!id || !r.owner_id) continue;
        next[id] = this._ingest(r);
      }
      this.directory = next;
      this.directoryAt = Date.now();
      // Owner's local bay array doesn't know about remote lessees — overlay
      // them so the Stations tab shows occupancy and _playerProduce can skip
      // double-taxing (they produce themselves via produceRemoteLeases).
      for (const st of this.ownedBy()) this._mergeRemoteBays(st);
    } catch (e) {
      console.warn("[Stations] directory fetch failed:", e);
    }
    return this.directory;
  },

  _mergeRemoteBays(st) {
    const row = this.directory[st.systemId];
    if (!row || !this.ownerHeld(st)) return;
    this.syncBays(st);
    const rem = row.bays || [];
    for (let i = 0; i < st.bays.length; i++) {
      const rb = rem[i];
      if (!rb || !rb.lesseeId || rb.npc) {
        // Server says vacant and we only had a foreign ghost — clear it.
        if (st.bays[i] && this._foreignLessee(st.bays[i])) this._clearBay(st, st.bays[i]);
        continue;
      }
      if (rb.lesseeId === this.accountId() || rb.lesseeId === this.playerId()) continue;
      // Don't overwrite a bay we ourselves occupy locally.
      if (st.bays[i].lesseeId === this.playerId() && st.bays[i].extractorId) continue;
      st.bays[i].lesseeId = rb.lesseeId;
      st.bays[i].extractorId = null;
      st.bays[i].npc = false;
    }
  },

  async publishOwned() {
    if (!(window.Cloud && Cloud.stationPublish && Cloud.signedIn && Cloud.signedIn())) return null;
    const rows = this.ownedBy().map(st => ({
      system_id: st.systemId,
      tier: st.tier,
      status: st.status,
      modules: st.modules || {},
      reactor_level: st.reactorLevel | 0,
      lease_tax_bps: st.leaseTaxBps | 0,
      sale_tariff_bps: st.saleTariffBps | 0,
      scrutiny: st.scrutiny | 0,
      standing: Math.round(st.standing || 0),
      prod_comm: st.prodComm || "",
      // ms epoch — never `| 0` this, 32-bit truncation mangles it.
      refit_until: String(st.status === "refit" ? Math.max(0, Math.round(+st.refitUntil || 0)) : 0),
      // One-time bootstrap when the server treasury is still zero (phase D0).
      treasury_bootstrap: this.treasuryShared(st.systemId) ? Math.max(0, Math.floor(+st.treasury || 0)) : 0,
      hold_bootstrap: this.contractsShared(st.systemId) ? (st.hold || {}) : {},
      // Shelf and bay occupancy — what makes a visited station look inhabited.
      // Owner-occupied bays rewrite "player" → account uuid so the shared column
      // names us the same way a remote lease does. Publish merges foreign
      // lessees server-side (docs/sql/station_bays.sql) so we can't wipe them.
      hall: (st.hall || []).slice(0, 40).map(l => ({
        id: l.id, name: l.name, kind: l.kind, price: l.price,
        expiresAt: l.expiresAt, sellerId: l.sellerId,
      })),
      bays: (st.bays || []).slice(0, 12).map(b => {
        // NPC tenants are guest-local only — never publish them onto a shared
        // floor where they'd overwrite a paying lessee on the next autosave.
        if (b.npc && this.bayShared(st.systemId))
          return { lesseeId: "", npc: false };
        let lessee = b.lesseeId || "";
        if (lessee && !b.npc && lessee === this.playerId() && this.accountId())
          lessee = this.accountId();
        return { lesseeId: lessee, npc: !!b.npc };
      }),
    }));
    try {
      const res = await Cloud.stationPublish(rows);
      if (res && res.ok) {
        this._applyTreasurySync(res);
        await this.refreshDirectory();
      }
      // A conflict means someone else claimed it first server-side. Local play
      // is unaffected (nothing is server-authoritative yet) — the directory just
      // keeps showing them as the holder.
      if (res && res.conflicts && res.conflicts.length) {
        console.warn("[Stations] already claimed elsewhere:", res.conflicts.join(", "));
      }
      return res;
    } catch (e) {
      console.warn("[Stations] directory publish failed:", e);
      return null;
    }
  },

  // Ownership changes are bursty (auction close → save → tick); coalesce them.
  _publishSoon() {
    if (!(window.Cloud && Cloud.signedIn && Cloud.signedIn())) return;
    clearTimeout(this._pubTimer);
    this._pubTimer = setTimeout(() => { void this.publishOwned(); }, 1500);
  },

  // ---- shared Exchange Hall (docs/sql/station_hall.sql) -------------------
  // Phase B. Phase A made another baron's shelf visible; the shelf itself was
  // still a copy in each client, so buying from it moved nothing. Here the
  // shelf moves to the server: one baron's listing is the object another baron
  // buys, the price splits at the owner's published tariff, and both sides are
  // queued for whoever is offline. The local st.hall stays as the signed-out
  // shelf — a guest still gets a hall, it's just theirs alone.
  hallKinds: ["gear", "blackbox", "extractor", "component", "ship", "blueprint"],
  hallRemote: {},   // systemId -> [listing] (server shelf; payloads stay server-side)
  unclaimed: [],    // settled items that wouldn't fit yet — already ours, never dropped

  // Shared once the owner has published the station and the hall SQL is live.
  // Readable signed out (the RPC is anon, like the directory); acting on it
  // needs an account, because the payout queue is keyed by one.
  hallShared(systemId) {
    return !!(this.directory[systemId] && window.Cloud && Cloud.enabled && !Cloud.hallMissing);
  },
  _hallWritable() { return !!(window.Cloud && Cloud.hallReady && Cloud.hallReady()); },

  // Local stalls are keyed by playerId() ("player" in every save); shared ones
  // by the account uuid. One question, one answer.
  listingMine(l) {
    if (!l) return false;
    if (!l.shared) return l.sellerId === this.playerId();
    const me = this.accountId();
    return !!me && l.sellerId === me;
  },

  // Same trust boundary as a directory row — another player's client wrote it.
  _ingestListing(r) {
    return {
      id: this._txt(r.id, 64),
      sellerId: this._txt(r.seller_id, 64),
      sellerName: this._txt(r.seller, 24) || "Baron",
      kind: this.hallKinds.includes(r.kind) ? r.kind : "gear",
      name: this._txt(r.name, 48) || "Listing",
      price: this._num(r.price, 0, 1e12, 0),
      value: this._num(r.value, 0, 1e12, 0),
      expiresAt: r.expires_at ? Date.parse(r.expires_at) || 0 : 0,
      shared: true,
    };
  },

  // Which shelves we care about: where we're standing, plus our own stations
  // (other barons put stalls up on those and we need to see them).
  hallSystems() {
    const s = window.Game && Game.state;
    const ids = this.ownedBy().map(st => st.systemId);
    if (s && s.currentSystem) ids.push(s.currentSystem);
    return [...new Set(ids)].filter(id => this.hallShared(id));
  },

  async refreshHalls(systemIds) {
    if (!(window.Cloud && Cloud.stationHall)) return this.hallRemote;
    const ids = [...new Set(systemIds || [])].filter(id => this.hallShared(id));
    if (!ids.length) return this.hallRemote;
    try {
      const rows = await Cloud.stationHall(ids);
      if (!rows) return this.hallRemote;
      for (const id of ids) this.hallRemote[id] = [];
      for (const r of rows) {
        const id = r && r.system_id ? String(r.system_id) : "";
        if (!this.hallRemote[id]) continue;
        this.hallRemote[id].push(this._ingestListing(r));
      }
    } catch (e) {
      console.warn("[Stations] hall fetch failed:", e);
    }
    return this.hallRemote;
  },

  // One pass: move any stalls still sitting in our save up to the shared shelf,
  // collect what we're owed, then re-read the shelves we're looking at.
  async syncHall() {
    if (this._hallWritable()) {
      await this._migrateLocalHall();
      await this.settleHall();
    }
    return this.refreshHalls(this.hallSystems());
  },

  // Our stalls used to live in our own save, where nobody else could ever buy
  // them — and a copy left behind after the move would be the same item twice.
  // Only what the server accepts is dropped locally.
  async _migrateLocalHall() {
    for (const st of this.list()) {
      if (!this.hallShared(st.systemId) || !Array.isArray(st.hall) || !st.hall.length) continue;
      const keep = [];
      for (const l of st.hall) {
        if (!this.listingMine(l) || !l.payload) { keep.push(l); continue; }
        const res = await this._postListing(st.systemId, l.kind, l.price, l);
        if (!res.ok) keep.push(l);
      }
      if (keep.length !== st.hall.length) {
        st.hall = keep;
        if (window.Game) Game.requestSave();
      }
    }
  },

  async _postListing(systemId, kind, price, taken) {
    try {
      const res = await Cloud.stationListItem(systemId, {
        kind, name: taken.name, price,
        value: Math.max(0, Math.round(+taken.value || 0)),
        payload: taken.payload,
      });
      if (!res || !res.ok) return { ok: false, msg: (res && res.error) || "The hall refused that listing." };
      const listing = {
        id: this._txt(res.id, 64),
        sellerId: this.accountId(),
        sellerName: this._txt(res.seller, 24) || "You",
        kind, name: taken.name, price,
        value: Math.max(0, Math.round(+taken.value || 0)),
        expiresAt: res.expires_at ? Date.parse(res.expires_at) || 0
                                  : Date.now() + (STATIONCFG.hallListMs || 48 * 3600 * 1000),
        shared: true,
      };
      (this.hallRemote[systemId] = this.hallRemote[systemId] || []).push(listing);
      return { ok: true, listing };
    } catch (e) {
      console.warn("[Stations] hall list failed:", e);
      return { ok: false, msg: "The hall is unreachable right now." };
    }
  },

  // Everything the shelf (and the bay floor) owes us: sale proceeds, tariffs,
  // lease-tax cargo into our hold, and items behind listings that expired or
  // were cleared. One RPC — hall settle was extended in station_bays.sql.
  async settleHall() {
    if (!(window.Cloud && Cloud.signedIn && Cloud.signedIn() && Cloud.stationSettle)) return null;
    if (!this._hallWritable() && !(Cloud.baysReady && Cloud.baysReady())) return null;
    let res;
    try { res = await Cloud.stationSettle(); }
    catch (e) { console.warn("[Stations] settle failed:", e); return null; }
    if (!res || !res.ok) return null;

    let credits = 0, tariffs = 0, items = 0, cargo = 0;
    if (res.credits != null) Game.state.credits = +res.credits;
    for (const p of Array.isArray(res.payouts) ? res.payouts : []) {
      const amt = Math.max(0, Math.round(+(p && p.amount) || 0));
      if (!amt) continue;
      const st = this.get(this._txt(p.systemId, 40));
      // Tariff payouts are legacy (pre-D0); the server credited treasury on
      // settle. Sale proceeds were credited server-side too — sync credits above.
      if (p.reason === "tariff" && st && this.ownerHeld(st) && this._mine(st)) {
        st.treasury += amt;
        this._ledger(st, amt, "hall_tariff", this._txt(p.note, 48));
        tariffs += amt;
      } else if (p.reason === "sale") {
        credits += amt;
        if (st) this._ledger(st, amt, "hall_payout", this._txt(p.note, 48));
      }
      // refund_owed is a seller debit — already applied server-side; skip local credit.
    }
    for (const row of Array.isArray(res.items) ? res.items : []) {
      const back = this._ingestBought(row);
      if (!back) continue;
      if (!this._deliverListable(back, this.playerId()).ok) this._park(back);
      items++;
    }
    // Lease tax is commodities into the station hold (§8), not wallet credits.
    // D1+ settle deposits into stations.hold server-side and returns `holds`.
    if (res.holds && typeof res.holds === "object") {
      for (const [sid, hold] of Object.entries(res.holds)) {
        const st = this.get(this._txt(sid, 40));
        if (st && this.ownerHeld(st) && this._mine(st)) this._applyHoldFromServer(st, hold);
      }
      for (const row of Array.isArray(res.cargo) ? res.cargo : []) {
        const sid = this._txt(row && row.systemId, 40);
        const commId = this._txt(row && row.commId, 40);
        const qty = Math.max(0, Math.min(500, Math.floor(+(row && row.qty) || 0)));
        if (!sid || !commId || !qty || !COMMODITIES.some(c => c.id === commId)) continue;
        const st = this.get(sid);
        if (st && this.ownerHeld(st) && this._mine(st)) {
          this._ledger(st, 0, "lease_tax", `${qty}× ${commId}`);
          cargo += qty;
        } else {
          const s = Game.state;
          const held = s.positions[commId] || 0;
          s.positions[commId] = held + qty;
          s.avgCost[commId] = held > 0 ? ((s.avgCost[commId] || 0) * held) / (held + qty) : 0;
          cargo += qty;
        }
      }
    } else {
      for (const row of Array.isArray(res.cargo) ? res.cargo : []) {
        const sid = this._txt(row && row.systemId, 40);
        const commId = this._txt(row && row.commId, 40);
        const qty = Math.max(0, Math.min(500, Math.floor(+(row && row.qty) || 0)));
        if (!sid || !commId || !qty) continue;
        if (!COMMODITIES.some(c => c.id === commId)) continue;
        const st = this.get(sid);
        if (st && this.ownerHeld(st) && this._mine(st)) {
          st.hold[commId] = (st.hold[commId] | 0) + qty;
          this._ledger(st, 0, "lease_tax", `${qty}× ${commId}`);
          cargo += qty;
        } else {
          // Lost the station since the tax was queued — residual follows us out.
          const s = Game.state;
          const held = s.positions[commId] || 0;
          s.positions[commId] = held + qty;
          s.avgCost[commId] = held > 0 ? ((s.avgCost[commId] || 0) * held) / (held + qty) : 0;
          cargo += qty;
        }
      }
    }
    if (credits || tariffs || items || cargo) {
      if (window.Economy) Economy.refreshNetWorth();
      if (window.Game) Game.requestSave();
    }
    return { ok: true, credits, tariffs, items, cargo };
  },

  // A payload the server held in escrow was authored by another player's client
  // and lands in our inventory and our net worth. Nothing is taken on faith:
  // every object is rebuilt field by field against the catalogs, uids are
  // re-minted so they can't collide with ours, and values are recomputed.
  _cleanPayload(kind, p) {
    if (!p || typeof p !== "object") return null;
    const uid = pre => pre + (++Game.state.seq);
    if (kind === "blackbox") {
      const e = BLACKBOX_EFFECTS.find(x => x.id === p.effectId);
      if (!e) return null;
      return {
        uid: uid("i"), kind: "blackbox", rarity: "rare", name: `${e.name} Blackbox`,
        consumable: true, effectId: e.id, primary: null, bonus: null,
        value: (window.Items && Items.blackboxValue) ? Items.blackboxValue(e) : 2000,
      };
    }
    if (kind === "gear") {
      if (!ACCESSORY_KINDS[p.kind] || !RARITIES.some(r => r.id === p.rarity)) return null;
      const it = {
        uid: uid("i"), kind: p.kind, rarity: p.rarity,
        name: this._txt(p.name, 48) || "Salvaged Part",
        primary: this._cleanStat(p.primary), bonus: this._cleanStat(p.bonus),
      };
      if (!it.primary) return null;
      it.value = (window.Items && Items.value) ? Items.value(it) : this._num(p.value, 0, 1e9, 0);
      return it;
    }
    if (kind === "extractor") {
      if (!EXTRACTORCFG.types[p.type]) return null;
      const scope = String(p.scope || "");
      const okScope = p.type === "specialized" ? COMMODITIES.some(c => c.id === scope)
        : p.type === "semi" ? COMMODITIES.some(c => c.cat === scope)
        : true;
      if (!okScope) return null;
      // Fitted components stay behind: `components` holds uids into the
      // seller's pool, and those objects aren't part of the sale.
      return {
        uid: uid("ex"), type: p.type, scope: p.type === "jack" ? "all" : scope,
        name: this._txt(p.name, 48) || "Extractor", components: [],
      };
    }
    if (kind === "component") {
      if (!COMPONENTCFG.kinds[p.kind] || !RARITIES.some(r => r.id === p.rarity)) return null;
      return {
        uid: uid("cp"), kind: p.kind, rarity: p.rarity,
        amount: this._num(p.amount, 0, 100, 0),
        name: this._txt(p.name, 48) || COMPONENTCFG.kinds[p.kind].label,
      };
    }
    if (kind === "ship") {
      const def = window.Fleet && Fleet.shipDef(p.type);
      if (!def) return null;
      // The hull only. Accessories and yard refits live in the seller's save
      // (state.items / state.shipVariants) and don't cross with the sale.
      return {
        uid: uid("s"), type: def.id, cls: def.cls,
        name: this._txt(p.name, 32) || def.name, status: "idle",
        accessories: [], mercenary: false, expiresAt: null, retrieveCost: 0,
      };
    }
    if (kind === "blueprint") {
      const r = (typeof RECIPES !== "undefined" ? RECIPES : []).find(x => x.id === p.recipeId);
      return r ? { recipeId: r.id } : null;
    }
    return null;
  },
  _cleanStat(st) {
    if (!st || typeof st !== "object" || !ACCESSORY_KINDS[st.kind]) return null;
    const k = ACCESSORY_KINDS[st.kind];
    return { stat: k.stat, kind: st.kind, pct: !!k.pct, amount: this._num(st.amount, 0, k.pct ? 1 : 1e5, 0) };
  },

  // A settled row (bought, reclaimed) → the listing shape _deliverListable eats.
  _ingestBought(row) {
    if (!row) return null;
    const kind = this.hallKinds.includes(row.kind) ? row.kind : "";
    const payload = kind && this._cleanPayload(kind, row.payload);
    if (!payload) return null;
    return {
      id: this._txt(row.id, 64), kind,
      name: this._txt(row.name, 48) || "Listing",
      payload, value: kind === "blueprint" ? 8000 : (payload.value || 0),
    };
  },

  // Room to receive, checked BEFORE the RPC: the server hands the payload over
  // once and the row is gone, so "inventory full" must fail on our side first.
  _roomFor(kind) {
    if (kind === "gear" || kind === "blackbox") {
      if (window.Bazaar && Bazaar.inventoryUsed() >= Bazaar.capacity())
        return { ok: false, msg: "Inventory full." };
    }
    if (kind === "ship") {
      const cap = window.Economy ? Economy.fleetCap() : 99;
      if (((Game.state.ships || []).length) >= cap) return { ok: false, msg: "Fleet at capacity." };
    }
    return { ok: true };
  },

  // Settled but undeliverable — already paid for, so it waits in the save
  // instead of evaporating, and lands the moment there's room.
  _park(entry) {
    this.unclaimed.push({ kind: entry.kind, name: entry.name, payload: entry.payload });
    if (window.UI && UI.toast) UI.toast(`${entry.name} is waiting — no room for it yet.`, "warn");
  },
  retryUnclaimed() {
    if (!this.unclaimed.length) return 0;
    const keep = [];
    let got = 0;
    for (const e of this.unclaimed) {
      if (this._deliverListable(e, this.playerId()).ok) got++;
      else keep.push(e);
    }
    this.unclaimed = keep;
    if (got && window.Game) Game.requestSave();
    return got;
  },

  // ---- power / modules ---------------------------------------------------
  basePower(st) { return this.tierInfo(st.tier).power; },
  reactorPower(st) {
    const lvl = st.reactorLevel | 0;
    if (lvl <= 0) return 0;
    const row = STATIONCFG.reactor[lvl - 1];
    return row ? row.power : 0;
  },
  powerBudget(st) { return this.basePower(st) + this.reactorPower(st); },
  powerUsed(st) {
    let used = 0;
    for (const [id, lvl] of Object.entries(st.modules || {})) {
      if (id === "reactor") continue;
      const def = STATION_MODULES[id];
      if (!def || !lvl) continue;
      const p = def.power[lvl - 1];
      if (p) used += p;
    }
    return used;
  },
  powerFree(st) { return this.powerBudget(st) - this.powerUsed(st); },

  moduleValue(st) {
    let v = 0;
    for (const [id, lvl] of Object.entries(st.modules || {})) {
      const def = STATION_MODULES[id];
      if (!def) continue;
      for (let i = 0; i < lvl; i++) v += def.cost[i] || 0;
    }
    for (let i = 0; i < (st.reactorLevel | 0); i++) {
      const def = STATION_MODULES.reactor;
      v += (def.cost[i] || 0);
    }
    return v;
  },

  upkeepPerCycle(st) {
    let u = this.tierInfo(st.tier).upkeep;
    const rl = st.reactorLevel | 0;
    if (rl > 0) {
      const row = STATIONCFG.reactor[rl - 1];
      if (row) u += row.upkeep;
    }
    const hub = st.modules.production_hub | 0;
    if (hub > 0) {
      const row = STATIONCFG.prodHub[hub - 1];
      if (row) u += row.upkeep;
    }
    const ws = st.modules.workshop_annex | 0;
    if (ws > 0) {
      const row = STATIONCFG.workshop[ws - 1];
      if (row) u += row.upkeep;
    }
    return u;
  },

  canInstall(st, moduleId) {
    const def = STATION_MODULES[moduleId];
    if (!def) return { ok: false, msg: "Unknown module." };
    if (st.status === "refit") return { ok: false, msg: "Station is in refit." };
    if (st.status !== "owned") return { ok: false, msg: "You don't own this station." };
    if (!this._mine(st)) return { ok: false, msg: "Not your station." };

    const cur = moduleId === "reactor" ? (st.reactorLevel | 0) : (st.modules[moduleId] | 0);
    if (cur >= def.max) return { ok: false, msg: "Already at max level." };
    const next = cur + 1;
    const needPower = def.power[next - 1] || 0;
    // Reactor adds budget; other modules spend it. Check after hypothetical reactor bump.
    let budget = this.powerBudget(st);
    let used = this.powerUsed(st);
    if (moduleId === "reactor") budget += (STATIONCFG.reactor[next - 1] || {}).power || 0;
    else used += needPower;
    if (used > budget) return { ok: false, msg: `Needs ${needPower} power (${budget - this.powerUsed(st)} free).` };

    if (def.conflicts) {
      for (const c of def.conflicts) {
        if ((st.modules[c] | 0) > 0) return { ok: false, msg: `Conflicts with ${STATION_MODULES[c].name}.` };
      }
    }
    if (def.requires) {
      for (const [req, min] of Object.entries(def.requires)) {
        if ((st.modules[req] | 0) < min) return { ok: false, msg: `Requires ${STATION_MODULES[req].name} ${"I".repeat(min)}.` };
      }
    }
    // Faction locks (soft check — Rep may be missing in harness).
    if (moduleId === "customs_house" && window.Rep) {
      const ok = ["mining_combine", "free_trade", "agri_collective"].some(f => Rep.get(f) >= 0);
      if (!ok) return { ok: false, msg: "Needs Neutral+ with a lawful faction." };
    }
    if (moduleId === "black_market" && window.Rep) {
      if (Rep.get("syndicate") < 25) return { ok: false, msg: "Needs Syndicate ≥ Friendly." };
    }
    const cost = def.cost[next - 1] || 0;
    const s = window.Game && Game.state;
    if (s && s.credits < cost) return { ok: false, msg: "Not enough credits." };
    return { ok: true, cost, next };
  },

  install(systemId, moduleId) {
    const st = this.get(systemId);
    if (!st) return { ok: false, msg: "No station." };
    const check = this.canInstall(st, moduleId);
    if (!check.ok) return check;
    if (this.modulesShared(systemId)) {
      return Cloud.stationModuleInstall(systemId, moduleId).then(res => {
        if (!res || !res.ok) return { ok: false, msg: (res && res.error) || "Install refused." };
        if (moduleId === "reactor") st.reactorLevel = res.level | 0;
        else st.modules[moduleId] = res.level | 0;
        if (moduleId === "production_hub") this.syncBays(st);
        if (res.credits != null) Game.state.credits = +res.credits;
        else Game.state.credits -= check.cost;
        this._ledger(st, -(res.cost || check.cost), "install",
          `${STATION_MODULES[moduleId].name} ${"I".repeat(res.level | 0)}`);
        if (window.Game) Game.requestSave();
        this._publishSoon();
        return { ok: true, level: res.level, cost: res.cost || check.cost };
      }).catch(e => {
        console.warn("[Stations] module install failed:", e);
        return { ok: false, msg: "Couldn't reach the station ledger." };
      });
    }
    const s = Game.state;
    s.credits -= check.cost;
    if (moduleId === "reactor") st.reactorLevel = check.next;
    else st.modules[moduleId] = check.next;
    if (moduleId === "production_hub") this.syncBays(st);
    this._ledger(st, -check.cost, "install", `${STATION_MODULES[moduleId].name} ${"I".repeat(check.next)}`);
    if (window.Game) Game.requestSave();
    return { ok: true, level: check.next, cost: check.cost };
  },

  uninstall(systemId, moduleId) {
    const st = this.get(systemId);
    if (!st) return { ok: false, msg: "No station." };
    if (!this._mine(st) || st.status !== "owned") return { ok: false, msg: "Not your station." };
    const cur = moduleId === "reactor" ? (st.reactorLevel | 0) : (st.modules[moduleId] | 0);
    if (cur <= 0) return { ok: false, msg: "Not installed." };
    const def = STATION_MODULES[moduleId];
    let refund = 0;
    for (let i = 0; i < cur; i++) refund += Math.floor((def.cost[i] || 0) * 0.5);
    if (moduleId === "reactor") st.reactorLevel = 0;
    else delete st.modules[moduleId];
    // Drop dependent modules (Refinery needs Prod Hub ≥ II).
    if (moduleId === "production_hub") {
      delete st.modules.refinery;
      this.syncBays(st); // releases extractors as bay count → 0
      st.prodComm = null;
    } else if ((st.modules.production_hub | 0) < 2) {
      delete st.modules.refinery;
    }
    if (moduleId === "exchange_hall") {
      for (const l of st.hall || []) this._restoreListable(l, l.sellerId);
      st.hall = [];
    }
    if (moduleId === "contract_office") {
      for (const c of (st.contracts || []).filter(x => x.status === "open")) this._refundHaul(st, c);
      st.contracts = (st.contracts || []).filter(x => x.status === "active");
    }
    if (moduleId === "customs_house") {
      st.impoundHold = {};
      st.impoundClaims = [];
    }
    if (this.modulesShared(systemId)) {
      return Cloud.stationModuleUninstall(systemId, moduleId).then(res => {
        if (!res || !res.ok) return { ok: false, msg: (res && res.error) || "Uninstall refused." };
        if (moduleId === "reactor") st.reactorLevel = 0;
        else if (moduleId === "production_hub") {
          delete st.modules.production_hub;
          delete st.modules.refinery;
          this.syncBays(st);
          st.prodComm = null;
        } else delete st.modules[moduleId];
        if ((st.modules.production_hub | 0) < 2) delete st.modules.refinery;
        if (res.credits != null) Game.state.credits = +res.credits;
        else Game.state.credits += refund;
        st.status = "refit";
        st.refitUntil = Date.now() + STATIONCFG.refitMs;
        this._ledger(st, res.refund || refund, "uninstall", `${def.name} refund`);
        if (window.Game) Game.requestSave();
        this._publishSoon();
        return { ok: true, refund: res.refund || refund };
      }).catch(e => {
        console.warn("[Stations] module uninstall failed:", e);
        return { ok: false, msg: "Couldn't reach the station ledger." };
      });
    }
    Game.state.credits += refund;
    st.status = "refit";
    st.refitUntil = Date.now() + STATIONCFG.refitMs;
    this._ledger(st, refund, "uninstall", `${def.name} refund`);
    if (window.Game) Game.requestSave();
    return { ok: true, refund };
  },

  // ---- Production Hub ----------------------------------------------------
  setProduction(systemId, commId) {
    const st = this.get(systemId);
    if (!st || !this._mine(st) || !this.ownerHeld(st))
      return { ok: false, msg: "Not your station." };
    if (!(st.modules.production_hub | 0)) return { ok: false, msg: "Install a Production Hub first." };
    const sys = Galaxy.get(systemId);
    if (!sys) return { ok: false, msg: "Unknown system." };
    const c = COMMODITIES.find(x => x.id === commId);
    if (!c || c.craftOnly || c.rarity === "exotic") return { ok: false, msg: "Can't produce that." };
    // System supports any cat where mods[cat] < 1.0
    if ((sys.mods[c.cat] ?? 1) >= 1.0) return { ok: false, msg: "This system doesn't produce that category." };
    // docs/STATIONS.md §8: changing the commodity costs retooling downtime.
    // An idle hub has nothing to retool from, so first assignment starts clean.
    const cost = this.retoolCost(st, commId);
    const retool = cost > 0;
    st.prodComm = commId;
    if (retool) {
      st.status = "refit";
      st.refitUntil = Date.now() + cost; // retooling < full refit
    }
    if (window.Game) Game.requestSave();
    return { ok: true, retool, refitUntil: retool ? st.refitUntil : 0 };
  },

  async setLeaseTax(systemId, bps) {
    const st = this.get(systemId);
    if (!st || !this._mine(st)) return { ok: false, msg: "Not your station." };
    bps = Util.clamp(Math.round(+bps || 0), 0, 4000);
    if (this.treasuryShared(systemId)) {
      const res = await this._setPolicy(systemId, { lease_tax_bps: bps });
      if (!res || !res.ok) return { ok: false, msg: (res && res.msg) || (res && res.error) || "Couldn't set lease tax." };
      return { ok: true, leaseTaxBps: st.leaseTaxBps };
    }
    st.leaseTaxBps = bps;
    if (window.Game) Game.requestSave();
    return { ok: true, leaseTaxBps: st.leaseTaxBps };
  },

  async setSaleTariff(systemId, bps) {
    const st = this.get(systemId);
    if (!st || !this._mine(st)) return { ok: false, msg: "Not your station." };
    bps = Util.clamp(Math.round(+bps || 0), 0, 1500);
    if (this.treasuryShared(systemId)) {
      const res = await this._setPolicy(systemId, { sale_tariff_bps: bps });
      if (!res || !res.ok) return { ok: false, msg: (res && res.msg) || (res && res.error) || "Couldn't set tariff." };
      return { ok: true, saleTariffBps: st.saleTariffBps };
    }
    st.saleTariffBps = bps;
    if (window.Game) Game.requestSave();
    return { ok: true, saleTariffBps: st.saleTariffBps };
  },

  // ---- Access / docking (docs/STATIONS.md §12–13) -------------------------
  roleOf(systemId, pid = this.playerId()) {
    const st = this.get(systemId);
    if (!st) return "guest";
    if (st.ownerId === pid) return "owner";
    const map = this.access[systemId] || {};
    const r = map[pid];
    if (r === "partner" || r === "allied" || r === "barred") return r;
    return "guest";
  },

  setRole(systemId, pid, role) {
    const st = this.get(systemId);
    if (!st || !this._mine(st)) return { ok: false, msg: "Not your station." };
    pid = String(pid || "").trim();
    if (!pid || pid === this.playerId()) return { ok: false, msg: "Invalid player." };
    if (!["allied", "guest", "barred", "partner"].includes(role))
      return { ok: false, msg: "Unknown role." };
    if (!this.access[systemId]) this.access[systemId] = {};
    if (role === "guest") delete this.access[systemId][pid];
    else this.access[systemId][pid] = role;
    if (window.Game) Game.requestSave();
    return { ok: true, role };
  },

  canDock(systemId) {
    const st = this.view(systemId);
    if (!st) return { ok: false, msg: "No station here." };
    if (this.roleOf(systemId) === "barred") return { ok: false, msg: "Docking denied — you are barred." };
    if (st.status === "cooldown") return { ok: false, msg: "Station is offline after a revolt." };
    return { ok: true, st };
  },

  // True when sysId is a sector capital (full hub services).
  isCapital(systemId) {
    if (!systemId) return false;
    const g = window.Galaxy && Galaxy.get(systemId);
    if (g) return !!g.capital;
    return !!(typeof SYSTEMS !== "undefined" && SYSTEMS.some(s => s.id === systemId));
  },

  // Hub / nav availability at the player's current dock.
  // Capitals: full services. Claimable stations: gate on ownership + modules.
  // Modules persist through revolt but stay dormant while status is npc.
  hubAccess(page, systemId) {
    const s = window.Game && Game.state;
    const sysId = systemId || (s && s.currentSystem);
    if (!sysId || !page) return { ok: true };
    // Always-on: navigation, personal fleet, galactic meta.
    if (/^(starmap|systems|barons|comms|ach|hub|senate|fleet|assets)$/.test(page)) return { ok: true };

    if (this.isCapital(sysId)) {
      if (page === "stations") {
        return this.ownedCount() > 0
          ? { ok: true }
          : { ok: false, reason: "You don't own a station yet" };
      }
      return { ok: true };
    }

    const st = this.view(sysId);
    if (!st) return { ok: false, reason: "No station services here" };
    const owned = this.ownerHeld(st);
    const mine = owned && this._mine(st);
    const mod = id => (st.modules && st.modules[id]) | 0;

    // The owner's console stays reachable through a refit — that's where the
    // countdown lives, and where they cancel/reassign what caused it.
    if (page === "stations") return mine ? { ok: true } : { ok: false, reason: owned ? "Not your station" : "Station is NPC-held" };
    if (st.status === "refit") {
      return { ok: false, reason: `Refit in progress — back online in ${Util.duration(this.refitLeft(st))}` };
    }

    if (!owned) {
      const npcReason = {
        exchange: "Commodity exchange is at sector capitals",
        bazaar: "No station market while NPC-held",
        industries: "Foundries run from capital hubs",
        workshop: "Modules dormant while NPC-held",
        stations: "Station is NPC-held",
      };
      return { ok: false, reason: npcReason[page] || "Unavailable at this dock" };
    }

    switch (page) {
      case "exchange":
        return { ok: false, reason: "Commodity exchange is at sector capitals" };
      case "bazaar":
        // Phase A publishes another baron's station read-only: you see it, its
        // modules affect your dock, but nothing here may move their goods yet.
        if (st.remote) return { ok: false, reason: `${st.ownerDisplay}'s market — trading here isn't live yet` };
        if (mod("charter_office") || mod("contract_office") || mod("black_market") || mod("exchange_hall"))
          return { ok: true };
        return { ok: false, reason: "Needs Exchange Hall, Charter, or Contract Office" };
      case "industries":
        return { ok: false, reason: "Foundries run from capital hubs" };
      case "workshop":
        if (mod("workshop_annex") && mine) return { ok: true };
        if (mod("workshop_annex")) return { ok: false, reason: "Owner's Workshop Annex only" };
        return { ok: false, reason: "No Workshop Annex installed" };
      default:
        return { ok: true };
    }
  },

  // Compact services strip for Star Map / System Hubs (module presence).
  serviceList(systemId) {
    if (this.isCapital(systemId)) {
      return [
        { id: "exchange", label: "Commodity Exchange", ok: true },
        { id: "bazaar", label: "Bazaar", ok: true },
        { id: "workshop", label: "Workshop", ok: true },
        { id: "fleet", label: "Fleet Bay", ok: true },
      ];
    }
    const st = this.view(systemId);
    if (!st) return [];
    const refit = st.status === "refit";
    const owned = this.ownerHeld(st);
    const mod = id => (st.modules && st.modules[id]) | 0;
    const row = (id, label, need) => {
      if (!owned) return { id, label, ok: false, reason: "NPC-held — modules dormant" };
      if (need && !mod(need)) return { id, label, ok: false, reason: "Not installed" };
      if (refit) return { id, label, ok: false, reason: `Refit — back online in ${Util.duration(this.refitLeft(st))}` };
      return { id, label, ok: true };
    };
    return [
      { id: "exchange", label: "Commodity Exchange", ok: false, reason: "Capitals only" },
      row("exchange_hall", "Exchange Hall", "exchange_hall"),
      row("production_hub", "Production Hub", "production_hub"),
      row("workshop_annex", "Workshop Annex", "workshop_annex"),
      row("contract_office", "Contract Office", "contract_office"),
      row("charter_office", "Charter Office", "charter_office"),
      row("dry_dock", "Dry Dock", "dry_dock"),
      row("customs_house", "Customs House", "customs_house"),
      row("free_port", "Free Port", "free_port"),
      row("black_market", "Black Market", "black_market"),
      row("warehouse", "Warehouse", "warehouse"),
      row("survey_relay", "Survey Relay", "survey_relay"),
      row("lane_buoy", "Lane Buoy", "lane_buoy"),
    ];
  },

  customsExempt(systemId, pid = this.playerId()) {
    const st = this.view(systemId);
    if (!st || !(st.modules.customs_house | 0)) return false;
    const role = this.roleOf(systemId, pid);
    return role === "owner" || role === "partner" || role === "allied";
  },

  // Public scrutiny readout shown before undock (never hidden).
  publicScrutiny(systemId) {
    const st = this.view(systemId);
    if (!st) return null;
    if (st.modules.free_port | 0) {
      const pct = Math.round((CUSTOMS.base || 0.1) * (STATIONCFG.freePortScrutinyMult || 0.35) * 100);
      return { pct, label: "Free Port", flag: "open", chanceHint: pct };
    }
    if (st.modules.customs_house | 0) {
      const pct = Util.clamp(st.scrutiny | 0, 0, Math.round((CUSTOMS.cap || 0.85) * 100));
      return { pct, label: "Clean", flag: "clean", chanceHint: pct };
    }
    return { pct: null, label: "Open dock", flag: "neutral", chanceHint: null };
  },

  // ---- Exchange Hall (docs/STATIONS.md §9) --------------------------------
  hasHall(st) {
    return !!(st && (st.modules.exchange_hall | 0) && st.status === "owned");
  },

  // Visitors must be docked at the station (non-capital docking is live).
  canUseHall(systemId) {
    const st = this.view(systemId);
    if (st && st.status === "refit" && (st.modules.exchange_hall | 0))
      return { ok: false, msg: `Station is in refit — ${Util.duration(this.refitLeft(st))} left.` };
    if (!this.hasHall(st)) return { ok: false, msg: "No Exchange Hall here." };
    // Another baron's shelf is only tradeable once it's the *same* shelf for
    // both of us. Without the hall SQL, or signed out, it stays a display.
    if (this.hallShared(systemId)) {
      if (!this._hallWritable())
        return { ok: false, msg: "Sign in to trade on a shared hall.", browse: true, st };
    } else if (st.remote) {
      return { ok: false, msg: `${st.ownerDisplay}'s hall — visitor trading isn't live yet.`, browse: true, st };
    }
    const s = window.Game && Game.state;
    if (!s || s.travel) return { ok: false, msg: "Can't trade in transit." };
    if (!st.remote && this._mine(st)) return { ok: true, st };
    if (s.currentSystem === systemId) return { ok: true, st };
    return { ok: false, msg: "Dock at this station to use the Exchange Hall." };
  },

  hallListings(systemId) {
    const st = this.view(systemId);
    const local = (st && Array.isArray(st.hall)) ? st.hall : [];
    // Until the shelf has actually been read, the local one is all we know.
    // After that it's authoritative — except for our own stalls that haven't
    // made it up yet (a full shelf), which would otherwise just vanish.
    if (this.hallShared(systemId) && this.hallRemote[systemId])
      return this.hallRemote[systemId].concat(local.filter(l => this.listingMine(l)));
    return local;
  },

  _listingValue(listing) {
    if (!listing) return 0;
    if (listing.value != null) return +listing.value || 0;
    const p = listing.payload;
    if (!p) return 0;
    if (p.value != null) return +p.value || 0;
    if (listing.kind === "ship" && window.Fleet) {
      const def = Fleet.shipDef(p.type); return def ? def.price : 0;
    }
    if (listing.kind === "extractor" && window.Extractors) return Extractors.price(p) || 0;
    if (listing.kind === "component" && window.Components) return Components.price(p);
    return 0;
  },

  // Escrowed hall goods still count toward net worth (like auction bids) —
  // including the ones now sitting in server-side escrow on a shared shelf.
  hallEscrowValue(pid = this.playerId()) {
    let n = 0;
    for (const st of this.list()) {
      for (const l of st.hall || []) if (l.sellerId === pid) n += this._listingValue(l);
    }
    if (pid !== this.playerId()) return n;
    for (const rows of Object.values(this.hallRemote)) {
      for (const l of rows || []) if (this.listingMine(l)) n += +l.value || 0;
    }
    for (const e of this.unclaimed) n += this._listingValue(e);
    return n;
  },

  contractEscrowValue(pid = this.playerId()) {
    let n = 0;
    for (const st of this.list()) {
      if (st.ownerId !== pid) continue;
      for (const c of st.contracts || []) {
        if (c.status === "open" || c.status === "active") n += c.escrow | 0;
      }
    }
    return n;
  },

  escrowForNetWorth(pid = this.playerId()) {
    return this.escrowTotal(pid) + this.hallEscrowValue(pid) + this.contractEscrowValue(pid);
  },

  _takeListable(kind, ref) {
    const s = Game.state;
    if (kind === "gear" || kind === "blackbox") {
      const it = s.items[ref]; if (!it) return { ok: false, msg: "Item not found." };
      if (window.Bazaar && Bazaar.equippedSet().has(ref)) return { ok: false, msg: "Unequip it first." };
      if (kind === "blackbox" && !(window.Items && Items.isBlackbox(it))) return { ok: false, msg: "Not a blackbox." };
      if (kind === "gear" && window.Items && Items.isBlackbox(it)) return { ok: false, msg: "List blackboxes as blackbox." };
      delete s.items[ref];
      return { ok: true, name: it.name, value: it.value || 0, payload: it };
    }
    if (kind === "extractor") {
      const ex = window.Extractors && Extractors.get(ref);
      if (!ex) return { ok: false, msg: "Extractor not found." };
      if (Extractors.installedSet().has(ref)) return { ok: false, msg: "Uninstall the extractor first." };
      const payload = JSON.parse(JSON.stringify(ex));
      delete Extractors.pool()[ref];
      return { ok: true, name: payload.name, value: Extractors.price(payload) || 0, payload };
    }
    if (kind === "component") {
      const c = window.Components && Components.get(ref);
      if (!c) return { ok: false, msg: "Component not found." };
      if (Components.installedSet().has(ref)) return { ok: false, msg: "Detach the component first." };
      const payload = JSON.parse(JSON.stringify(c));
      delete Components.pool()[ref];
      return { ok: true, name: payload.name || Components.nameFromUid(payload), value: Components.price(payload), payload };
    }
    if (kind === "ship") {
      const sh = (s.ships || []).find(x => x.uid === ref);
      if (!sh) return { ok: false, msg: "Ship not found." };
      if (sh.status !== "idle") return { ok: false, msg: "Ship must be idle." };
      if (sh.mercenary) return { ok: false, msg: "Can't list a mercenary." };
      const payload = JSON.parse(JSON.stringify(sh));
      s.ships = s.ships.filter(x => x.uid !== ref);
      const def = window.Fleet && Fleet.shipDef(payload.type);
      return { ok: true, name: payload.name || payload.type, value: def ? def.price : 0, payload };
    }
    if (kind === "blueprint") {
      const recipes = s.knownRecipes || [];
      if (!recipes.includes(ref)) return { ok: false, msg: "Blueprint not unlocked." };
      const recipe = (typeof RECIPES !== "undefined" ? RECIPES : []).find(r => r.id === ref);
      if (!recipe) return { ok: false, msg: "Unknown recipe." };
      s.knownRecipes = recipes.filter(id => id !== ref);
      return { ok: true, name: `${recipe.name} Blueprint`, value: 8000, payload: { recipeId: ref } };
    }
    return { ok: false, msg: "Unsupported listing type." };
  },

  _restoreListable(listing, toPid) {
    if (!listing || !listing.payload) return;
    // Guest: only the local player has inventory to restore into.
    if (toPid && toPid !== this.playerId()) return;
    const s = Game.state;
    const p = listing.payload;
    if (listing.kind === "gear" || listing.kind === "blackbox") {
      s.items[p.uid] = p;
    } else if (listing.kind === "extractor" && window.Extractors) {
      Extractors.pool()[p.uid] = p;
    } else if (listing.kind === "component" && window.Components) {
      Components.pool()[p.uid] = p;
    } else if (listing.kind === "ship") {
      s.ships = s.ships || [];
      if (!s.ships.some(x => x.uid === p.uid)) s.ships.push(p);
    } else if (listing.kind === "blueprint") {
      s.knownRecipes = s.knownRecipes || [];
      if (p.recipeId && !s.knownRecipes.includes(p.recipeId)) s.knownRecipes.push(p.recipeId);
    }
  },

  _deliverListable(listing, buyerPid) {
    if (!listing || !listing.payload) return { ok: false, msg: "Empty listing." };
    if (buyerPid !== this.playerId()) return { ok: false, msg: "Buyer unavailable." };
    const s = Game.state;
    const p = listing.payload;
    if (listing.kind === "gear" || listing.kind === "blackbox") {
      if (window.Bazaar && Bazaar.inventoryUsed() >= Bazaar.capacity())
        return { ok: false, msg: "Inventory full." };
      s.items[p.uid] = p;
      return { ok: true };
    }
    if (listing.kind === "extractor" && window.Extractors) {
      Extractors.pool()[p.uid] = p;
      return { ok: true };
    }
    if (listing.kind === "component" && window.Components) {
      Components.pool()[p.uid] = p;
      return { ok: true };
    }
    if (listing.kind === "ship") {
      const cap = window.Economy ? Economy.fleetCap() : 99;
      if ((s.ships || []).length >= cap) return { ok: false, msg: "Fleet at capacity." };
      s.ships = s.ships || [];
      s.ships.push(p);
      return { ok: true };
    }
    if (listing.kind === "blueprint") {
      s.knownRecipes = s.knownRecipes || [];
      if (p.recipeId && !s.knownRecipes.includes(p.recipeId)) s.knownRecipes.push(p.recipeId);
      return { ok: true };
    }
    return { ok: false, msg: "Unsupported listing type." };
  },

  async listHallItem(systemId, kind, ref, price) {
    const access = this.canUseHall(systemId);
    if (!access.ok) return access;
    const st = access.st;
    // Black Market unlocks illicit-adjacent goods on the hall.
    if (kind === "blackbox" && !(st.modules.black_market | 0))
      return { ok: false, msg: "Blackboxes need a Black Market." };
    price = Math.floor(+price || 0);
    if (price < (STATIONCFG.hallMinPrice || 50)) return { ok: false, msg: `Price at least ${STATIONCFG.hallMinPrice}c.` };
    const taken = this._takeListable(kind, ref);
    if (!taken.ok) return taken;
    // Shared shelf: the item goes into server-side escrow, not into our save.
    // If the post fails it comes straight back — it must never be in neither.
    if (this.hallShared(systemId)) {
      const res = await this._postListing(systemId, kind, price, taken);
      if (!res.ok) {
        this._restoreListable({ kind, payload: taken.payload }, this.playerId());
        if (window.Game) Game.requestSave();
        return res;
      }
      if (window.Game) Game.requestSave();
      return res;
    }
    if (!Array.isArray(st.hall)) st.hall = [];
    const now = Date.now();
    const listing = {
      id: "hl" + (++Game.state.seq),
      sellerId: this.playerId(),
      kind,
      name: taken.name,
      price,
      value: taken.value,
      payload: taken.payload,
      listedAt: now,
      expiresAt: now + (STATIONCFG.hallListMs || 48 * 3600 * 1000),
    };
    st.hall.push(listing);
    this._ledger(st, 0, "hall_list", `${listing.name} @ ${price}`);
    if (window.Game) Game.requestSave();
    return { ok: true, listing };
  },

  async cancelHallListing(systemId, listingId) {
    const shared = (this.hallRemote[systemId] || []).find(l => l.id === listingId);
    if (shared) return this._cancelShared(systemId, shared);
    const st = this.get(systemId);
    if (!st || !Array.isArray(st.hall)) return { ok: false, msg: "No listing." };
    const idx = st.hall.findIndex(l => l.id === listingId);
    if (idx < 0) return { ok: false, msg: "Listing gone." };
    const listing = st.hall[idx];
    if (listing.sellerId !== this.playerId() && !this._mine(st))
      return { ok: false, msg: "Not your listing." };
    st.hall.splice(idx, 1);
    this._restoreListable(listing, listing.sellerId);
    if (window.Game) Game.requestSave();
    return { ok: true };
  },

  // Pull our own stall off a shared shelf; a station owner may also clear
  // someone else's, and then the goods go back to whoever put them up.
  async _cancelShared(systemId, listing) {
    if (!this._hallWritable()) return { ok: false, msg: "Sign in to manage shared listings." };
    if (!this.listingMine(listing)) {
      const st = this.get(systemId);
      if (!(st && this.ownerHeld(st) && this._mine(st)))
        return { ok: false, msg: "Not your listing." };
    }
    let res;
    try { res = await Cloud.stationCancelListing(listing.id); }
    catch (e) {
      console.warn("[Stations] hall cancel failed:", e);
      return { ok: false, msg: "The hall is unreachable right now." };
    }
    if (!res || !res.ok) {
      await this.refreshHalls([systemId]);
      return { ok: false, msg: (res && res.error) || "Listing gone." };
    }
    this._dropShared(systemId, listing.id);
    if (res.payload) {
      const back = this._ingestBought({ id: listing.id, kind: res.kind, name: res.name, payload: res.payload });
      if (back && !this._deliverListable(back, this.playerId()).ok) this._park(back);
    }
    if (window.Economy) Economy.refreshNetWorth();
    if (window.Game) Game.requestSave();
    return { ok: true, cleared: !!res.cleared };
  },

  _dropShared(systemId, listingId) {
    const rows = this.hallRemote[systemId];
    if (!rows) return;
    this.hallRemote[systemId] = rows.filter(l => l.id !== listingId);
  },

  async buyHallListing(systemId, listingId) {
    const access = this.canUseHall(systemId);
    if (!access.ok) return access;
    const shared = (this.hallRemote[systemId] || []).find(l => l.id === listingId);
    if (shared) return this._buyShared(systemId, shared);
    const st = access.st;
    const idx = (st.hall || []).findIndex(l => l.id === listingId);
    if (idx < 0) return { ok: false, msg: "Listing gone." };
    const listing = st.hall[idx];
    const pid = this.playerId();
    if (listing.sellerId === pid) return { ok: false, msg: "That's your listing." };
    const s = Game.state;
    if (s.credits < listing.price) return { ok: false, msg: "Not enough credits." };
    s.credits -= listing.price;
    const delivered = this._deliverListable(listing, pid);
    if (!delivered.ok) {
      s.credits += listing.price;
      return delivered;
    }
    const tariff = Math.floor(listing.price * Util.clamp(st.saleTariffBps | 0, 0, 1500) / 10000);
    const sellerGets = listing.price - tariff;
    if (tariff > 0) {
      st.treasury += tariff;
      this._ledger(st, tariff, "hall_tariff", listing.name);
    }
    // Seller proceeds: mailbox until claimed (server authority will settle live).
    st.pendingPayouts = st.pendingPayouts || {};
    st.pendingPayouts[listing.sellerId] = (st.pendingPayouts[listing.sellerId] | 0) + sellerGets;
    this.claimHallPayouts();
    st.hall.splice(idx, 1);
    if (window.Economy) Economy.refreshNetWorth();
    if (window.Game) Game.requestSave();
    return { ok: true, listing, tariff, paid: listing.price };
  },

  // The shared-shelf buy. The server takes the listing off the shelf, splits
  // the price at the owner's tariff, queues both sides and hands us the item —
  // so the only thing left to do here is have somewhere to put it and pay.
  // ponytail: the debit is ours because credits still are. A tab closed in the
  // half-second between the RPC returning and delivery loses the item (nothing
  // is charged for it). Both go away in phase D, when the debit moves inside
  // the same transaction; an ack RPC before then would buy little.
  // The shared-shelf buy. The server takes the listing off the shelf, debits
  // the buyer's wallet, splits the tariff into the station treasury, pays (or
  // queues) the seller, and hands us the item.
  async _buyShared(systemId, listing) {
    if (!this._hallWritable()) return { ok: false, msg: "Sign in to buy here." };
    if (this.listingMine(listing)) return { ok: false, msg: "That's your listing." };
    const s = Game.state;
    if (!this._treasuryWritable() && s.credits < listing.price)
      return { ok: false, msg: "Not enough credits." };
    const room = this._roomFor(listing.kind);
    if (!room.ok) return room;

    let res;
    try { res = await Cloud.stationBuyItem(systemId, listing.id); }
    catch (e) {
      console.warn("[Stations] hall buy failed:", e);
      return { ok: false, msg: "The hall is unreachable right now." };
    }
    if (!res || !res.ok) {
      this._dropShared(systemId, listing.id);
      void this.refreshHalls([systemId]);
      return { ok: false, msg: (res && res.error) || "Listing gone." };
    }
    const bought = this._ingestBought(res);
    this._dropShared(systemId, listing.id);
    const paid = this._num(res.price, 0, 1e12, listing.price);
    if (res.credits != null) s.credits = +res.credits;
    else s.credits -= paid;
    if (!bought) {
      let refunded = false;
      const ref = window.Cloud && Cloud.stationBuyRefund
        ? await Cloud.stationBuyRefund(listing.id).catch(e => {
            console.warn("[Stations] hall buy refund failed:", e);
            return null;
          })
        : null;
      if (ref && ref.ok && ref.credits != null) {
        s.credits = +ref.credits;
        refunded = true;
      } else if (res.credits == null) {
        // Pre-D0: we debited locally above — undo it.
        s.credits += paid;
        refunded = true;
      }
      console.warn("[Stations] unusable payload from hall listing", listing.id);
      return {
        ok: false,
        msg: refunded
          ? "That listing was malformed — credits refunded."
          : "That listing was malformed — contact support, payment was taken.",
      };
    }
    if (!this._deliverListable(bought, this.playerId()).ok) this._park(bought);
    if (window.Economy) Economy.refreshNetWorth();
    if (window.Game) Game.requestSave();
    return {
      ok: true, listing: { ...listing, name: bought.name }, paid,
      tariff: this._num(res.tariff, 0, 1e12, 0), seller: this._txt(res.seller, 24),
    };
  },

  // Claim any pending sale proceeds (multiplayer / identity handoff).
  claimHallPayouts() {
    const stList = this.list();
    const pid = this.playerId();
    let got = 0;
    for (const st of stList) {
      if (!st.pendingPayouts || !st.pendingPayouts[pid]) continue;
      const n = st.pendingPayouts[pid] | 0;
      if (n <= 0) continue;
      Game.state.credits += n;
      got += n;
      delete st.pendingPayouts[pid];
      this._ledger(st, n, "hall_payout", "sale proceeds");
    }
    if (got && window.Game) Game.requestSave();
    return { ok: true, amount: got };
  },

  _expireHall(st, now = Date.now()) {
    if (!Array.isArray(st.hall) || !st.hall.length) return [];
    const kept = [], returned = [];
    for (const l of st.hall) {
      if (now >= l.expiresAt) {
        this._restoreListable(l, l.sellerId);
        returned.push(l);
      } else kept.push(l);
    }
    st.hall = kept;
    return returned;
  },

  _npcBuyHall(st, hourIndex) {
    // NPC buyers are liquidity for a shelf nobody else can reach. Once the
    // shelf is shared, real barons are the liquidity — minting a sale here
    // would pay the seller for goods that are still on the server's shelf.
    if (this.hallShared(st.systemId)) return [];
    if (!Array.isArray(st.hall) || !st.hall.length) return [];
    const sold = [];
    const chance = STATIONCFG.hallNpcBuyChance || 0.12;
    const keep = [];
    for (let i = 0; i < st.hall.length; i++) {
      const l = st.hall[i];
      const s = Market._seed([st.systemId, "hall", l.id, String(hourIndex)]);
      if (Market._u01(s, 0) >= chance) { keep.push(l); continue; }
      const tariff = Math.floor(l.price * Util.clamp(st.saleTariffBps | 0, 0, 1500) / 10000);
      const sellerGets = l.price - tariff;
      if (l.sellerId === this.playerId()) Game.state.credits += sellerGets;
      else {
        st.pendingPayouts = st.pendingPayouts || {};
        st.pendingPayouts[l.sellerId] = (st.pendingPayouts[l.sellerId] | 0) + sellerGets;
      }
      if (tariff > 0) { st.treasury += tariff; this._ledger(st, tariff, "hall_tariff", `NPC · ${l.name}`); }
      sold.push(l);
      if (window.Bus) Bus.emit("listingSold", { name: l.name, price: l.price, hall: true });
    }
    st.hall = keep;
    return sold;
  },

  // ---- Contract Office (docs/STATIONS.md §11) -----------------------------
  hasContractOffice(st) {
    return !!(st && (st.modules.contract_office | 0) && st.status === "owned");
  },

  ownerHandle(st) {
    if (st && st.ownerId && st.ownerId !== "player" && st.ownerId !== this.playerId())
      return String(st.ownerId).slice(0, 16);
    if (window.Cloud && Cloud.signedIn && Cloud.signedIn() && Cloud.user) {
      const u = Cloud.user.user_metadata && Cloud.user.user_metadata.username;
      if (u) return u;
    }
    return "Baron";
  },

  reliability(st) {
    const stats = (st && st.contractStats) || { filled: 0, expired: 0 };
    const tot = (stats.filled | 0) + (stats.expired | 0);
    if (!tot) return null;
    return (stats.filled | 0) / tot;
  },

  // ---- shared Contract Office (docs/sql/station_contracts.sql) ------------
  haulRemote: {},   // systemId -> [contract]
  haulIndex: {},    // id -> { st, contract }

  contractsShared(systemId) {
    return !!(this.directory[systemId] && window.Cloud && Cloud.enabled && !Cloud.contractsMissing);
  },
  _contractsWritable() { return !!(window.Cloud && Cloud.contractsReady && Cloud.contractsReady()); },

  haulSystems() {
    const ids = this.ownedBy().map(st => st.systemId);
    for (const sid of Object.keys(this.directory)) {
      if (this.contractsShared(sid)) ids.push(sid);
    }
    return [...new Set(ids)].filter(id => this.contractsShared(id));
  },

  _ingestHaulRow(r) {
    const sid = this._txt(r.system_id, 40);
    const st = sid && this.get(sid);
    if (!st) return null;
    const contract = {
      id: this._txt(r.id, 64),
      commId: this._txt(r.comm_id, 40),
      qty: this._num(r.qty, 1, 500, 0) | 0,
      rate: this._num(r.rate, 5, 1e9, 0) | 0,
      escrow: this._num(r.escrow, 0, 1e12, 0) | 0,
      status: "open",
      ownerId: String(r.owner_id || ""),
      createdAt: r.created_at ? Date.parse(r.created_at) || 0 : 0,
      expiresAt: r.expires_at ? Date.parse(r.expires_at) || 0 : 0,
      systemId: sid,
      shared: true,
    };
    if (!contract.id || !COMMODITIES.some(c => c.id === contract.commId)) return null;
    if (r.filled != null || r.expired != null) {
      st.contractStats = {
        filled: this._num(r.filled, 0, 1e6, 0) | 0,
        expired: this._num(r.expired, 0, 1e6, 0) | 0,
      };
    }
    return { st, contract };
  },

  async refreshHauls(systemIds) {
    if (!(window.Cloud && Cloud.stationHauls)) return this.haulRemote;
    const ids = [...new Set(systemIds || [])].filter(id => this.contractsShared(id));
    if (!ids.length) return this.haulRemote;
    try {
      const rows = await Cloud.stationHauls(ids);
      if (!rows) return this.haulRemote;
      for (const id of ids) this.haulRemote[id] = [];
      for (const key of Object.keys(this.haulIndex)) {
        const hit = this.haulIndex[key];
        if (hit && ids.includes(hit.contract.systemId)) delete this.haulIndex[key];
      }
      for (const r of rows) {
        const hit = this._ingestHaulRow(r);
        if (!hit) continue;
        (this.haulRemote[hit.contract.systemId] = this.haulRemote[hit.contract.systemId] || [])
          .push(hit.contract);
        this.haulIndex[hit.contract.id] = hit;
      }
    } catch (e) {
      console.warn("[Stations] haul fetch failed:", e);
    }
    return this.haulRemote;
  },

  async syncContracts() {
    if (!this._contractsWritable()) return this.refreshHauls([]);
    for (const st of this.ownedBy()) {
      if (this.contractsShared(st.systemId)) void Cloud.stationExpireHauls(st.systemId);
    }
    return this.refreshHauls(this.haulSystems());
  },

  _applyHoldFromServer(st, hold) {
    if (!st || !hold || typeof hold !== "object") return;
    if (!st.hold || typeof st.hold !== "object") st.hold = {};
    for (const [k, v] of Object.entries(hold)) {
      if (COMMODITIES.some(c => c.id === k)) {
        const n = Math.max(0, Math.floor(+v || 0));
        if (n > 0) st.hold[k] = n;
        else delete st.hold[k];
      }
    }
  },

  findHaul(contractId) {
    const hit = this.haulIndex[contractId];
    if (hit) return hit;
    for (const st of this.list()) {
      const c = (st.contracts || []).find(x => x.id === contractId);
      if (c) return { st, contract: c };
    }
    return null;
  },

  _toBoardJob(st, c) {
    const comm = COMMODITIES.find(x => x.id === c.commId);
    const sec = Galaxy.sector(st.sectorId);
    const cap = sec && Galaxy.get(sec.capital);
    const handle = this.ownerHandle(st);
    const rel = this.reliability(st);
    const relTxt = rel == null ? "unrated" : `${Math.round(rel * 100)}% reliable`;
    return {
      id: c.id,
      kind: "job",
      type: "transport",
      source: "station",
      stationId: st.systemId,
      stationName: st.name,
      ownerId: st.ownerId,
      ownerHandle: handle,
      commId: c.commId,
      qty: c.qty,
      rate: c.rate,
      escrow: c.escrow,
      title: `Haul ${c.qty} ${comm ? comm.name : c.commId}`,
      desc: `From ${st.name} → ${cap ? cap.name : "sector capital"}. ${c.rate}c/u escrowed. Posted by ${handle} · ${relTxt}.`,
      sysName: cap ? cap.name : st.name,
      destSysId: sec ? sec.capital : null,
      danger: "low",
      faction: (comm && CATEGORY_FACTION[comm.cat]) || null,
      stakeTier: 0,
      minFirepower: Math.max(4, Math.round(c.qty / 40)),
      cargoRequired: c.qty,
      durationMs: (STATIONCFG.contractDurBaseMs || 25 * 60 * 1000)
        + c.qty * (STATIONCFG.contractDurPerUnitMs || 8000),
      impound: false,
      reward: { credits: c.escrow, itemChance: 0, stockChance: 0 },
      createdAt: c.createdAt,
      expiresAt: c.expiresAt,
      status: "open",
    };
  },

  boardContracts(now = Date.now()) {
    const out = [], seen = new Set();
    for (const rows of Object.values(this.haulRemote)) {
      for (const c of rows) {
        if (!c || c.status !== "open" || now >= c.expiresAt || seen.has(c.id)) continue;
        const st = this.get(c.systemId);
        if (!st || !this.hasContractOffice(this.view(c.systemId))) continue;
        seen.add(c.id);
        out.push(this._toBoardJob(st, c));
      }
    }
    for (const st of this.list()) {
      if (this.contractsShared(st.systemId)) continue;
      if (!this.hasContractOffice(st)) continue;
      for (const c of st.contracts || []) {
        if (c.status !== "open" || now >= c.expiresAt || seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(this._toBoardJob(st, c));
      }
    }
    return out;
  },

  async postHaul(systemId, commId, qty, rate) {
    const st = this.get(systemId);
    if (!st || !this._mine(st) || !this.ownerHeld(st))
      return { ok: false, msg: "Not your station." };
    if (st.status === "refit")
      return { ok: false, msg: `Station is in refit — ${Util.duration(this.refitLeft(st))} left.` };
    if (!this.hasContractOffice(st)) return { ok: false, msg: "Install a Contract Office first." };
    const comm = COMMODITIES.find(c => c.id === commId);
    if (!comm || comm.craftOnly) return { ok: false, msg: "Unknown commodity." };
    qty = Math.floor(+qty || 0);
    rate = Math.floor(+rate || 0);
    if (qty < 1) return { ok: false, msg: "Need at least 1 unit." };
    if (rate < (STATIONCFG.contractMinRate || 5))
      return { ok: false, msg: `Rate at least ${STATIONCFG.contractMinRate}c/unit.` };
    if (this.contractsShared(systemId) && this._contractsWritable()) {
      try {
        const res = await Cloud.stationPostHaul(systemId, commId, qty, rate);
        if (!res || !res.ok) return { ok: false, msg: (res && res.error) || "Posting refused." };
        if (res.credits != null) Game.state.credits = +res.credits;
        this._applyHoldFromServer(st, res.hold);
        const c = res.contract || {};
        const contract = {
          id: this._txt(c.id, 64),
          commId, qty, rate,
          escrow: this._num(c.escrow, 0, 1e12, qty * rate) | 0,
          fee: this._num(res.fee, 0, 1e12, 0) | 0,
          ownerId: this.playerId(),
          status: "open",
          createdAt: this._num(c.createdAt, 0, 8.64e15, Date.now()),
          expiresAt: this._num(c.expiresAt, 0, 8.64e15, Date.now() + (STATIONCFG.contractListMs || 0)),
          systemId,
          shared: true,
        };
        this.haulIndex[contract.id] = { st, contract };
        (this.haulRemote[systemId] = this.haulRemote[systemId] || []).push(contract);
        this._ledger(st, -contract.escrow, "haul_post", `${qty}× ${commId} @ ${rate}`);
        if (contract.fee > 0) this._ledger(st, -contract.fee, "haul_fee", "faction posting fee");
        if (window.Game) Game.requestSave();
        return { ok: true, contract, fee: contract.fee };
      } catch (e) {
        console.warn("[Stations] post haul failed:", e);
        return { ok: false, msg: "Couldn't reach the contract board." };
      }
    }
    const have = st.hold[commId] | 0;
    if (qty > have) return { ok: false, msg: `Only ${have} in station hold.` };
    const escrow = qty * rate;
    const fee = Math.floor(escrow * Util.clamp(STATIONCFG.contractPostFeeBps | 0, 0, 2000) / 10000);
    const s = Game.state;
    if (s.credits < escrow + fee) return { ok: false, msg: `Need ${Util.credits(escrow + fee)} (bounty + ${fee}c fee).` };
    st.hold[commId] = have - qty;
    s.credits -= escrow + fee;
    if (!Array.isArray(st.contracts)) st.contracts = [];
    const now = Date.now();
    const contract = {
      id: "sc" + (++s.seq),
      commId, qty, rate, escrow, fee,
      ownerId: this.playerId(),
      status: "open",
      createdAt: now,
      expiresAt: now + (STATIONCFG.contractListMs || 36 * 3600 * 1000),
    };
    st.contracts.push(contract);
    st.contractStats = st.contractStats || { filled: 0, expired: 0 };
    this._ledger(st, -escrow, "haul_post", `${qty}× ${commId} @ ${rate}`);
    if (fee > 0) this._ledger(st, -fee, "haul_fee", "faction posting fee");
    if (window.Game) Game.requestSave();
    return { ok: true, contract, fee };
  },

  async cancelHaul(systemId, contractId) {
    const hit = this.haulIndex[contractId];
    if (hit && hit.contract.shared) {
      if (!this._contractsWritable()) return { ok: false, msg: "Sign in to manage shared hauls." };
      try {
        const res = await Cloud.stationCancelHaul(contractId);
        if (!res || !res.ok) return { ok: false, msg: (res && res.error) || "Posting gone." };
        const st = hit.st;
        if (res.credits != null) Game.state.credits = +res.credits;
        this._applyHoldFromServer(st, res.hold);
        this._dropHaul(contractId, systemId);
        this._ledger(st, hit.contract.escrow | 0, "haul_refund", contractId);
        if (window.Game) Game.requestSave();
        return { ok: true };
      } catch (e) {
        console.warn("[Stations] cancel haul failed:", e);
        return { ok: false, msg: "Couldn't reach the contract board." };
      }
    }
    const st = this.get(systemId);
    if (!st || !this._mine(st)) return { ok: false, msg: "Not your station." };
    const idx = (st.contracts || []).findIndex(c => c.id === contractId);
    if (idx < 0) return { ok: false, msg: "Posting gone." };
    const c = st.contracts[idx];
    if (c.status !== "open") return { ok: false, msg: "Already in flight." };
    st.contracts.splice(idx, 1);
    this._refundHaul(st, c);
    if (window.Game) Game.requestSave();
    return { ok: true };
  },

  _dropHaulBoard(contractId, systemId) {
    const rows = this.haulRemote[systemId];
    if (rows) this.haulRemote[systemId] = rows.filter(c => c.id !== contractId);
  },

  _dropHaul(contractId, systemId) {
    delete this.haulIndex[contractId];
    this._dropHaulBoard(contractId, systemId);
  },

  async claimHaulForLaunch(contractId) {
    const found = this.findHaul(contractId);
    if (!found || found.contract.status !== "open")
      return { ok: false, msg: "Haul no longer available." };
    const { st, contract } = found;
    if (!this.hasContractOffice(this.view(st.systemId)) && st.status !== "owned")
      return { ok: false, msg: "Haul no longer available." };
    if (this._mine(st))
      return { ok: false, msg: "Can't fly your own station haul." };
    if (contract.shared && this._contractsWritable()) {
      try {
        const res = await Cloud.stationClaimHaul(contractId);
        if (!res || !res.ok) return { ok: false, msg: (res && res.error) || "Haul no longer available." };
        contract.status = "active";
        contract.takenAt = Date.now();
        contract.takenBy = this.playerId();
        this.haulIndex[contractId] = { st, contract };
        this._dropHaulBoard(contractId, st.systemId);
        const job = this._toBoardJob(st, contract);
        job.status = "taken";
        job.haulShared = true;
        if (window.Game) Game.requestSave();
        return { ok: true, contract: job };
      } catch (e) {
        console.warn("[Stations] claim haul failed:", e);
        return { ok: false, msg: "Couldn't reach the contract board." };
      }
    }
    contract.status = "active";
    contract.takenAt = Date.now();
    contract.takenBy = this.playerId();
    const job = this._toBoardJob(st, contract);
    job.status = "taken";
    if (window.Game) Game.requestSave();
    return { ok: true, contract: job };
  },

  async settleHaul(contractId, outcome) {
    const found = this.findHaul(contractId);
    // After reload a claimed haul isn't on the open board — still settle by id.
    if (!found) {
      if (this._contractsWritable() && /^[0-9a-f-]{36}$/i.test(String(contractId || ""))) {
        try {
          const res = await Cloud.stationSettleHaul(contractId, outcome);
          if (!res || !res.ok) {
            const err = (res && res.error) || "Settle refused.";
            return {
              ok: false, msg: err,
              terminal: /gone|already settled|not your haul|not launched/i.test(err),
            };
          }
          if (res.credits != null) Game.state.credits = +res.credits;
          if (window.Economy) Economy.refreshNetWorth();
          if (window.Game) Game.requestSave();
          return { ok: true, credits: res.credits };
        } catch (e) {
          console.warn("[Stations] settle haul failed:", e);
          return { ok: false, msg: "Couldn't reach the contract board." };
        }
      }
      return { ok: false, msg: "Haul gone.", terminal: true };
    }
    const { st, contract } = found;
    if (contract.status !== "active" && contract.status !== "open")
      return { ok: false, msg: "Already settled.", terminal: true };
    if (contract.shared && this._contractsWritable()) {
      try {
        const res = await Cloud.stationSettleHaul(contractId, outcome);
        if (!res || !res.ok) {
          const err = (res && res.error) || "Settle refused.";
          return {
            ok: false, msg: err,
            terminal: /gone|already settled|not your haul/i.test(err),
          };
        }
        if (res.credits != null) Game.state.credits = +res.credits;
        if (this._mine(st)) this._applyHoldFromServer(st, res.hold);
        if (res.contract_filled != null || res.contract_expired != null) {
          st.contractStats = {
            filled: Math.max(0, Math.floor(+res.contract_filled || 0)),
            expired: Math.max(0, Math.floor(+res.contract_expired || 0)),
          };
        }
        const settledOutcome = res.outcome || outcome;
        if (settledOutcome === "success") {
          // Server restocks sector_stock; local put only when Phase 4 shelf isn't live.
          if (!(window.Stock && Stock.authoritative && Stock.authoritative()))
            Stock.put(st.sectorId, contract.commId, contract.qty);
          if (this._mine(st)) st.delivered = (st.delivered | 0) + (contract.qty | 0);
        }
        this._dropHaul(contractId, st.systemId);
        const idx = (st.contracts || []).indexOf(contract);
        if (idx >= 0) st.contracts.splice(idx, 1);
        if (window.Economy) Economy.refreshNetWorth();
        if (window.Game) Game.requestSave();
        return { ok: true, credits: res.credits, outcome: settledOutcome };
      } catch (e) {
        console.warn("[Stations] settle haul failed:", e);
        return { ok: false, msg: "Couldn't reach the contract board." };
      }
    }
    return this._settleHaulLocal(found, outcome);
  },

  _settleHaulLocal(found, outcome) {
    const { st, contract } = found;
    st.contractStats = st.contractStats || { filled: 0, expired: 0 };
    const idx = (st.contracts || []).indexOf(contract);
    if (outcome === "success") {
      Stock.put(st.sectorId, contract.commId, contract.qty);
      st.delivered = (st.delivered | 0) + (contract.qty | 0);
      st.contractStats.filled = (st.contractStats.filled | 0) + 1;
      this._ledger(st, 0, "haul_filled", `${contract.qty}× ${contract.commId}`);
    } else if (outcome === "fail" || outcome === "abandon") {
      this._refundHaul(st, contract);
    } else if (outcome === "expire") {
      this._refundHaul(st, contract);
      st.contractStats.expired = (st.contractStats.expired | 0) + 1;
    }
    if (idx >= 0) st.contracts.splice(idx, 1);
    if (window.Economy) Economy.refreshNetWorth();
    if (window.Game) Game.requestSave();
    return { ok: true };
  },

  _refundHaul(st, c) {
    if (!c) return;
    st.hold[c.commId] = (st.hold[c.commId] | 0) + (c.qty | 0);
    const payTo = c.ownerId || st.ownerId;
    if (payTo === this.playerId()) Game.state.credits += c.escrow | 0;
    else if (payTo) {
      st.pendingPayouts = st.pendingPayouts || {};
      st.pendingPayouts[payTo] = (st.pendingPayouts[payTo] | 0) + (c.escrow | 0);
    }
    this._ledger(st, c.escrow | 0, "haul_refund", c.id);
  },

  _expireHauls(st, now = Date.now()) {
    if (this.contractsShared(st.systemId)) {
      if (this._contractsWritable() && this._mine(st)) void Cloud.stationExpireHauls(st.systemId)
        .then(() => this.refreshHauls([st.systemId]));
      return [];
    }
    if (!Array.isArray(st.contracts) || !st.contracts.length) return [];
    const kept = [], expired = [];
    for (const c of st.contracts) {
      if (c.status === "open" && now >= c.expiresAt) {
        this._refundHaul(st, c);
        st.contractStats = st.contractStats || { filled: 0, expired: 0 };
        st.contractStats.expired = (st.contractStats.expired | 0) + 1;
        expired.push(c);
      } else kept.push(c);
    }
    st.contracts = kept;
    return expired;
  },

  _npcFillHauls(st, hourIndex) {
    if (this.contractsShared(st.systemId)) return [];
    const chance = STATIONCFG.contractNpcFillChance || 0.08;
    const after = STATIONCFG.contractNpcFillAfterMs || 4 * 3600 * 1000;
    const now = Date.now();
    const kept = [], filled = [];
    for (let i = 0; i < st.contracts.length; i++) {
      const c = st.contracts[i];
      if (c.status !== "open" || now - c.createdAt < after) { kept.push(c); continue; }
      const s = Market._seed([st.systemId, "haul", c.id, String(hourIndex)]);
      if (Market._u01(s, 0) >= chance) { kept.push(c); continue; }
      Stock.put(st.sectorId, c.commId, c.qty);
      st.delivered = (st.delivered | 0) + (c.qty | 0);
      st.contractStats = st.contractStats || { filled: 0, expired: 0 };
      st.contractStats.filled = (st.contractStats.filled | 0) + 1;
      this._ledger(st, 0, "haul_npc", `${c.qty}× ${c.commId}`);
      // Escrow consumed by NPC hauler (leaves the economy).
      filled.push(c);
    }
    st.contracts = kept;
    return filled;
  },

  async setScrutiny(systemId, pct) {
    const st = this.get(systemId);
    if (!st || !this._mine(st)) return { ok: false, msg: "Not your station." };
    if (!(st.modules.customs_house | 0)) return { ok: false, msg: "Needs a Customs House." };
    const capPct = Math.round((CUSTOMS.cap || 0.85) * 100);
    const scrutiny = Util.clamp(Math.round(+pct || 0), 0, capPct);
    if (this.treasuryShared(systemId)) {
      const res = await this._setPolicy(systemId, { scrutiny });
      if (!res || !res.ok) return { ok: false, msg: (res && res.msg) || (res && res.error) || "Couldn't set scrutiny." };
      return { ok: true, scrutiny: st.scrutiny };
    }
    st.scrutiny = scrutiny;
    if (window.Game) Game.requestSave();
    return { ok: true, scrutiny: st.scrutiny };
  },

  produceable(systemId) {
    const sys = Galaxy.get(systemId);
    if (!sys) return [];
    return COMMODITIES.filter(c => !c.craftOnly && c.rarity !== "exotic" && (sys.mods[c.cat] ?? 1) < 1.0);
  },

  // ---- Production Hub bays (docs/STATIONS.md §8) --------------------------
  // Phase C: on a published station the floor is shared. bayShared() is the
  // seam — lease/vacate/produce hit the server; an unpublished station (or a
  // project without station_bays.sql) keeps today's local path untouched.
  bayShared(systemId) {
    return !!(this.directory[systemId] && window.Cloud && Cloud.enabled && !Cloud.baysMissing);
  },
  _baysWritable() { return !!(window.Cloud && Cloud.baysReady && Cloud.baysReady()); },

  // Phase D0: treasury and hall-buy credits are server-owned once
  // station_treasury.sql is live. Policy changes route through set_policy too.
  treasuryShared(systemId) {
    const st = this.get(systemId);
    if (!st || !this.ownerHeld(st) || !this._mine(st)) return false;
    return !!(window.Cloud && Cloud.treasuryReady && Cloud.treasuryReady());
  },
  _treasuryWritable() { return !!(window.Cloud && Cloud.treasuryReady && Cloud.treasuryReady()); },

  _applyTreasurySync(res) {
    if (!res || !Array.isArray(res.treasuries)) return;
    for (const row of res.treasuries) {
      const sid = this._txt(row.system_id, 40);
      const st = sid && this.get(sid);
      if (!st || !this._mine(st)) continue;
      if (row.treasury != null) st.treasury = Math.max(0, Math.floor(+row.treasury || 0));
      if (row.standing != null) st.standing = Util.clamp(+row.standing, 0, 100);
      if (row.hold && typeof row.hold === "object") {
        const hold = {};
        for (const [k, v] of Object.entries(row.hold)) {
          if (COMMODITIES.some(c => c.id === k)) hold[k] = Math.max(0, Math.floor(+v || 0));
        }
        st.hold = hold;
      }
      if (row.contract_filled != null || row.contract_expired != null) {
        st.contractStats = {
          filled: Math.max(0, Math.floor(+row.contract_filled || 0)),
          expired: Math.max(0, Math.floor(+row.contract_expired || 0)),
        };
      }
      if (row.modules && typeof row.modules === "object") {
        const mods = {};
        for (const [id, lvl] of Object.entries(row.modules)) {
          if (!STATION_MODULES[id]) continue;
          const n = Math.max(0, Math.floor(+lvl || 0));
          if (n > 0) mods[id] = n;
        }
        st.modules = mods;
        if (mods.production_hub) this.syncBays(st);
      }
      if (row.reactor_level != null) st.reactorLevel = Util.clamp(+row.reactor_level | 0, 0, 5);
    }
  },

  upkeepShared(systemId) {
    return this.treasuryShared(systemId);
  },
  modulesShared(systemId) {
    const st = this.get(systemId);
    if (!st || !this._mine(st)) return false;
    const c = window.Cloud;
    return !!(c && c.modulesReady && c.modulesReady());
  },
  _modulesWritable() {
    const c = window.Cloud;
    return !!(c && c.modulesReady && c.modulesReady());
  },
  auctionsShared() {
    const c = window.Cloud;
    return !!(c && c.auctionsReady && c.auctionsReady());
  },

  _ingestAuction(r) {
    if (!r || !r.system_id) return null;
    const parseTs = v => (typeof v === "number" ? v : Date.parse(v)) || Date.now();
    return {
      systemId: String(r.system_id),
      status: "open",
      opensAt: parseTs(r.opens_at),
      closesAt: parseTs(r.closes_at),
      highBid: Math.floor(+r.high_bid || 0),
      highBidder: r.high_bidder ? String(r.high_bidder) : null,
      bids: [],
    };
  },

  async refreshAuctions() {
    if (!this.auctionsShared()) return this.remoteAuctions;
    try {
      const rows = await Cloud.stationAuctions();
      if (!rows) return this.remoteAuctions;
      const next = {};
      for (const r of rows) {
        const a = this._ingestAuction(r);
        if (a) next[a.systemId] = a;
      }
      this.remoteAuctions = next;
    } catch (e) {
      console.warn("[Stations] auction fetch failed:", e);
    }
    return this.remoteAuctions;
  },

  _applyAuctionClose(res) {
    if (!res || !Array.isArray(res.closed)) return;
    const me = this.accountId();
    for (const row of res.closed) {
      const sid = row && row.system_id ? String(row.system_id) : "";
      if (!sid) continue;
      delete this.remoteAuctions[sid];
      if (row.outcome === "won" && me && row.bidder === me) {
        const st = this.get(sid);
        if (st) {
          st.ownerId = this.playerId();
          st.status = "owned";
          st.standing = STATIONCFG.standingStart;
          st.delivered = 0;
          this._publishSoon();
          if (window.UI && UI.toast) UI.toast(`You won ${st.name} for ${Util.credits(row.amount)}.`, "good");
        }
      }
    }
  },

  async _setPolicy(systemId, policy) {
    if (!this.treasuryShared(systemId)) return null;
    try {
      const res = await Cloud.stationSetPolicy(systemId, policy);
      if (!res || !res.ok) return res || { ok: false, msg: "Policy change refused." };
      const st = this.get(systemId);
      if (st) {
        if (res.lease_tax_bps != null) st.leaseTaxBps = res.lease_tax_bps | 0;
        if (res.sale_tariff_bps != null) st.saleTariffBps = res.sale_tariff_bps | 0;
        if (res.scrutiny != null) st.scrutiny = res.scrutiny | 0;
      }
      if (window.Game) Game.requestSave();
      this._publishSoon();
      return { ok: true };
    } catch (e) {
      console.warn("[Stations] set policy failed:", e);
      return { ok: false, msg: "Couldn't reach the station ledger." };
    }
  },

  // Local leases key by playerId() ("player"); shared ones by account uuid.
  bayMine(bay) {
    if (!bay || !bay.lesseeId || bay.npc) return false;
    if (bay.lesseeId === this.playerId()) return true;
    const me = this.accountId();
    return !!me && bay.lesseeId === me;
  },

  bayCount(st) {
    const hub = st.modules.production_hub | 0;
    if (!hub) return 0;
    const row = STATIONCFG.prodHub[hub - 1];
    return row ? row.bays : 0;
  },

  syncBays(st) {
    const n = this.bayCount(st);
    if (!Array.isArray(st.bays)) st.bays = [];
    // Coerce / drop junk
    st.bays = st.bays.filter(b => b && typeof b === "object").map(b => ({
      lesseeId: b.lesseeId || null,
      extractorId: b.extractorId || null,
      npc: !!b.npc,
    }));
    while (st.bays.length < n) st.bays.push({ lesseeId: null, extractorId: null, npc: false });
    while (st.bays.length > n) this._clearBay(st, st.bays.pop());
    return st.bays;
  },

  _clearBay(st, bay) {
    if (!bay) return;
    // Player extractors stay in the pool; clearing just frees the install slot.
    bay.lesseeId = null;
    bay.extractorId = null;
    bay.npc = false;
  },

  staffedBays(st) {
    this.syncBays(st);
    return (st.bays || []).filter(b => b.lesseeId);
  },

  // Owner parks an extractor in a bay (occupies it; output → station hold).
  occupyBay(systemId, bayIndex, extractorUid) {
    const st = this.get(systemId);
    if (!st || !this._mine(st) || !this.ownerHeld(st))
      return { ok: false, msg: "Not your station." };
    // Staffing during a refit is allowed — output is gated in _playerProduce,
    // so the owner can have the line ready for the moment it comes back up.
    if (!(st.modules.production_hub | 0) || !st.prodComm)
      return { ok: false, msg: "Assign a Production Hub commodity first." };
    this.syncBays(st);
    const bay = st.bays[bayIndex];
    if (!bay) return { ok: false, msg: "No such bay." };
    if (bay.lesseeId) return { ok: false, msg: "Bay is occupied." };
    const ex = window.Extractors && Extractors.get(extractorUid);
    if (!ex) return { ok: false, msg: "Extractor not found." };
    if (Extractors.installedSet().has(extractorUid))
      return { ok: false, msg: "That extractor is already installed elsewhere." };
    if (!Extractors.canProduce(ex, st.prodComm))
      return { ok: false, msg: "This extractor can't produce the hub commodity." };
    bay.lesseeId = this.playerId();
    bay.extractorId = extractorUid;
    bay.npc = false;
    if (window.Game) Game.requestSave();
    this._publishSoon();
    return { ok: true, bay };
  },

  // Non-owner leases a vacant bay with their extractor (output → their cargo,
  // tax to owner). Shared stations go through the RPC; local/guest stays here.
  async leaseBay(systemId, bayIndex, extractorUid) {
    const v = this.view(systemId);
    if (!v || v.status !== "owned") return { ok: false, msg: "Station isn't leasing." };
    if (this.ownerHeld(this.get(systemId)) && this._mine(this.get(systemId)))
      return { ok: false, msg: "You own this station — occupy a bay instead." };
    if (v.remote && this.accountId() && v.ownerId === this.accountId())
      return { ok: false, msg: "You own this station — occupy a bay instead." };
    if (!(v.modules.production_hub | 0) || !v.prodComm)
      return { ok: false, msg: "No Production Hub commodity assigned." };
    const s = window.Game && Game.state;
    if (!s || s.travel) return { ok: false, msg: "Can't lease in transit." };
    if (s.currentSystem !== systemId) return { ok: false, msg: "Dock at this station to lease a bay." };
    const ex = window.Extractors && Extractors.get(extractorUid);
    if (!ex) return { ok: false, msg: "Extractor not found." };
    if (Extractors.installedSet().has(extractorUid))
      return { ok: false, msg: "That extractor is already installed elsewhere." };
    if (!Extractors.canProduce(ex, v.prodComm))
      return { ok: false, msg: "This extractor can't produce the hub commodity." };

    if (this.bayShared(systemId)) {
      if (!this._baysWritable())
        return { ok: false, msg: "Sign in to lease a bay on a shared station." };
      let res;
      try { res = await Cloud.stationLeaseBay(systemId, bayIndex, extractorUid); }
      catch (e) {
        console.warn("[Stations] bay lease failed:", e);
        return { ok: false, msg: "The station floor is unreachable right now." };
      }
      if (!res || !res.ok) {
        void this.refreshDirectory();
        return { ok: false, msg: (res && res.error) || "Bay is occupied." };
      }
      if (!this.remoteLeases[systemId]) this.remoteLeases[systemId] = {};
      this.remoteLeases[systemId][bayIndex] = extractorUid;
      // Mirror occupancy into the directory row we already have so the UI
      // updates without waiting on another round trip.
      const row = this.directory[systemId];
      if (row) {
        const n = this.bayCount(row);
        if (!Array.isArray(row.bays)) row.bays = [];
        while (row.bays.length < n) row.bays.push({ lesseeId: "", npc: false });
        if (row.bays[bayIndex]) {
          row.bays[bayIndex] = { lesseeId: this.accountId(), npc: false };
        }
      }
      if (window.Game) Game.requestSave();
      void this.refreshDirectory();
      return { ok: true, bay: { lesseeId: this.accountId(), extractorId: extractorUid, npc: false }, shared: true };
    }

    // Local / guest path — mutate our copy of the station.
    const st = this.get(systemId);
    if (!st || st.status !== "owned") return { ok: false, msg: "Station isn't leasing." };
    const pid = this.playerId();
    if (st.ownerId === pid) return { ok: false, msg: "You own this station — occupy a bay instead." };
    this.syncBays(st);
    const bay = st.bays[bayIndex];
    if (!bay) return { ok: false, msg: "No such bay." };
    if (bay.lesseeId) return { ok: false, msg: "Bay is occupied." };
    bay.lesseeId = pid;
    bay.extractorId = extractorUid;
    bay.npc = false;
    if (window.Game) Game.requestSave();
    return { ok: true, bay };
  },

  // Vacant leaseable bays at a station (visitor UI). Uses view() so a shared
  // floor's occupancy is the one everyone else sees.
  leaseableBays(systemId) {
    const st = this.view(systemId);
    if (!st || st.status !== "owned" || !(st.modules.production_hub | 0) || !st.prodComm) return [];
    const bays = st.remote ? (st.bays || []) : (this.syncBays(st), st.bays || []);
    return bays.map((b, i) => ({ index: i, bay: b }))
      .filter(x => !x.bay.lesseeId);
  },

  // Credit leased keep-cargo parked while the lessee was offline / remote.
  // Guest-local only — on a shared floor the lessee mints keep themselves.
  claimPendingCargo(systemId) {
    const st = this.get(systemId);
    if (!st || !st.pendingCargo) return { ok: true, claimed: {} };
    const pid = this.playerId();
    const bag = st.pendingCargo[pid];
    if (!bag || typeof bag !== "object") return { ok: true, claimed: {} };
    const s = Game.state;
    const claimed = {};
    for (const [commId, qty] of Object.entries(bag)) {
      const n = Math.floor(+qty || 0);
      if (n <= 0) continue;
      const held = s.positions[commId] || 0;
      s.positions[commId] = held + n;
      s.avgCost[commId] = held > 0 ? ((s.avgCost[commId] || 0) * held) / (held + n) : 0;
      if (window.Assets) Assets.parkBlocks(systemId, commId, n);
      claimed[commId] = n;
    }
    delete st.pendingCargo[pid];
    if (window.Game) Game.requestSave();
    return { ok: true, claimed };
  },

  async vacateBay(systemId, bayIndex) {
    // Shared remote lease — clear the slot server-side and free our extractor.
    if (this.bayShared(systemId) && this.remoteLeases[systemId]
        && this.remoteLeases[systemId][bayIndex] != null) {
      if (!this._baysWritable()) return { ok: false, msg: "Sign in to leave a shared bay." };
      let res;
      try { res = await Cloud.stationVacateBay(systemId, bayIndex); }
      catch (e) {
        console.warn("[Stations] bay vacate failed:", e);
        return { ok: false, msg: "The station floor is unreachable right now." };
      }
      if (!res || !res.ok) {
        // Already gone (owner evicted / station released) — free the extractor.
        if (res && /empty|Not your bay|No station/i.test(res.error || "")) {
          delete this.remoteLeases[systemId][bayIndex];
          if (!Object.keys(this.remoteLeases[systemId]).length) delete this.remoteLeases[systemId];
          if (window.Game) Game.requestSave();
          void this.refreshDirectory();
          return { ok: true };
        }
        return { ok: false, msg: (res && res.error) || "Bay is empty." };
      }
      delete this.remoteLeases[systemId][bayIndex];
      if (!Object.keys(this.remoteLeases[systemId]).length) delete this.remoteLeases[systemId];
      const row = this.directory[systemId];
      if (row && row.bays && row.bays[bayIndex])
        row.bays[bayIndex] = { lesseeId: "", npc: false };
      if (window.Game) Game.requestSave();
      void this.refreshDirectory();
      return { ok: true, shared: true };
    }

    // Owner evicting a remote lessee from a shared floor. Must go through the
    // RPC — clearing the local copy alone toasts "Bay cleared" and the lessee
    // reappears on the next directory merge.
    if (this.bayShared(systemId)) {
      const st = this.get(systemId);
      if (st && this.ownerHeld(st) && this._mine(st)) {
        if (!this._baysWritable())
          return { ok: false, msg: "Sign in to manage shared bays." };
        let res;
        try { res = await Cloud.stationVacateBay(systemId, bayIndex); }
        catch (e) {
          console.warn("[Stations] bay vacate failed:", e);
          return { ok: false, msg: "The station floor is unreachable right now." };
        }
        if (!res || !res.ok) return { ok: false, msg: (res && res.error) || "Bay is empty." };
        this.syncBays(st);
        if (st.bays[bayIndex]) this._clearBay(st, st.bays[bayIndex]);
        if (window.Game) Game.requestSave();
        this._publishSoon();
        void this.refreshDirectory();
        return { ok: true, shared: true };
      }
    }

    const st = this.get(systemId);
    if (!st) return { ok: false, msg: "No station." };
    this.syncBays(st);
    const bay = st.bays[bayIndex];
    if (!bay || !bay.lesseeId) return { ok: false, msg: "Bay is empty." };
    const pid = this.playerId();
    // Owner can evict anyone; lessee can leave their own bay.
    if (st.ownerId !== pid && bay.lesseeId !== pid)
      return { ok: false, msg: "Not your bay." };
    this._clearBay(st, bay);
    if (window.Game) Game.requestSave();
    return { ok: true };
  },

  // Extractors locked into remote (shared) bays — installedSet reads this.
  remoteLeaseExtractorIds() {
    const ids = [];
    for (const slots of Object.values(this.remoteLeases || {})) {
      for (const uid of Object.values(slots || {})) if (uid) ids.push(uid);
    }
    return ids;
  },

  // Drop a remote lease bookkeeping entry when the directory says we're gone
  // (owner evicted, station released, or we lost the race). Extractor frees.
  // Guarded hard: signed out, or a failed/empty directory refresh, must not
  // discard the map — that frees extractors locally while the server slot
  // stays leased (save-data loss).
  reconcileRemoteLeases() {
    if (!this.accountId() || !this.directoryAt) return false;
    let changed = false;
    for (const [sid, slots] of Object.entries(this.remoteLeases || {})) {
      const row = this.directory[sid];
      for (const idx of Object.keys(slots)) {
        const i = +idx;
        const bay = row && Array.isArray(row.bays) ? row.bays[i] : null;
        if (!bay || !this.bayMine(bay)) {
          delete slots[idx];
          changed = true;
        }
      }
      if (!Object.keys(slots).length) {
        delete this.remoteLeases[sid];
        changed = true;
      }
    }
    if (changed && window.Game) Game.requestSave();
    return changed;
  },

  // Lessee-side production on a shared floor. We mint keep into our cargo; the
  // RPC queues tax commodities for the owner. Owner-side _playerProduce skips
  // foreign lessees so the same bay isn't taxed twice.
  async produceRemoteLeases(hourIndex) {
    if (!this._baysWritable()) return 0;
    let total = 0;
    for (const [sid, slots] of Object.entries(this.remoteLeases || {})) {
      if (!this.bayShared(sid)) continue;
      const v = this.view(sid);
      if (!v || v.status !== "owned" || !v.prodComm) continue;
      for (const [idx, exUid] of Object.entries(slots)) {
        const i = +idx;
        const bay = (v.bays || [])[i];
        if (!bay || !this.bayMine(bay)) continue;
        const fake = { lesseeId: this.accountId(), extractorId: exUid, npc: false };
        const gross = this._bayGross(v, fake);
        if (gross <= 0) continue;
        let res;
        try { res = await Cloud.stationBayProduce(sid, i, gross); }
        catch (e) {
          console.warn("[Stations] bay produce failed:", e);
          continue;
        }
        if (!res || !res.ok) {
          // Evicted / cycle already claimed — drop bookkeeping if the bay isn't ours.
          if (res && /Not your bay|No such bay|isn't producing/i.test(res.error || "")) {
            delete slots[idx];
          }
          continue;
        }
        const keep = Math.max(0, Math.min(300, Math.floor(+(res.keep) || 0)));
        const commId = COMMODITIES.some(c => c.id === res.commId) ? res.commId : v.prodComm;
        if (keep > 0 && window.Game) {
          const s = Game.state;
          const held = s.positions[commId] || 0;
          s.positions[commId] = held + keep;
          s.avgCost[commId] = held > 0 ? ((s.avgCost[commId] || 0) * held) / (held + keep) : 0;
          if (window.Assets) Assets.parkBlocks(sid, commId, keep);
        }
        total += keep;
      }
      if (!Object.keys(slots).length) delete this.remoteLeases[sid];
    }
    if (total && window.Game) Game.requestSave();
    return total;
  },

  // Soft NPC tenants for vacant bays — keeps lease tax meaningful in guest mode.
  // Shared floors: clear any guest-era NPCs (don't just skip — leaveChance never
  // runs once fill is off, and stranded npc:true bays keep taxing locally while
  // every other player sees vacant).
  _fillNpcTenants(st, hourIndex) {
    if (this.bayShared(st.systemId)) {
      this.syncBays(st);
      for (const bay of st.bays || []) if (bay.npc) this._clearBay(st, bay);
      return;
    }
    this.syncBays(st);
    if (!st.prodComm || st.status !== "owned") return;
    const taxFrac = Util.clamp((st.leaseTaxBps | 0) / 4000, 0, 1);
    const fillChance = Util.clamp((STATIONCFG.npcLeaseChanceMax || 0.5) * (1 - taxFrac), 0.02, 0.5);
    const leaveChance = taxFrac * (STATIONCFG.npcLeaseLeaveMult || 0.35);
    for (let i = 0; i < st.bays.length; i++) {
      const bay = st.bays[i];
      const s = Market._seed([st.systemId, "lease", String(i), String(hourIndex)]);
      if (bay.lesseeId && bay.npc) {
        if (Market._u01(s, 0) < leaveChance) this._clearBay(st, bay);
        continue;
      }
      if (bay.lesseeId) continue;
      if (Market._u01(s, 1) < fillChance) {
        bay.lesseeId = "npc";
        bay.extractorId = null; // virtual jack-of-all-trades
        bay.npc = true;
      }
    }
  },

  _bayGross(st, bay) {
    const hub = st.modules.production_hub | 0;
    const row = STATIONCFG.prodHub[hub - 1];
    if (!row || !st.prodComm) return 0;
    const perBay = row.yield / row.bays;
    let ex = null;
    if (bay.extractorId && window.Extractors) ex = Extractors.get(bay.extractorId);
    // NPC tenants run a virtual jack.
    if (!ex && bay.npc) ex = { type: "jack", scope: "all", components: [] };
    if (!ex) return 0;
    if (window.Extractors && !Extractors.canProduce(ex, st.prodComm) && !bay.npc) return 0;
    const yMult = window.Extractors ? Extractors.yieldMult(ex) : 1;
    const bon = window.Extractors ? Extractors.bonuses(ex) : { rate: 1 };
    let gross = Math.round(perBay * yMult * bon.rate);
    if ((st.standing | 0) < 20) gross = Math.floor(gross / 2); // general strike
    return Math.max(0, gross);
  },

  // True when this lessee is another signed-in baron (uuid), not us / NPC /
  // local "player". On a shared floor they produce themselves via
  // produceRemoteLeases; double-taxing here would mint free stock for the owner.
  _foreignLessee(bay) {
    if (!bay || !bay.lesseeId || bay.npc) return false;
    if (bay.lesseeId === this.playerId()) return false;
    if (this.accountId() && bay.lesseeId === this.accountId()) return false;
    // UUIDs from the shared column; local guest lessees are short names like "bob".
    return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(bay.lesseeId);
  },

  // Owner + lessee bay production for one hour.
  _playerProduce(st, hourIndex) {
    if (st.status === "refit") return 0;
    if (st.status !== "owned") return 0;
    const hub = st.modules.production_hub | 0;
    if (!hub || !st.prodComm) return 0;
    this.syncBays(st);
    const taxBps = Util.clamp(st.leaseTaxBps | 0, 0, 4000);
    let total = 0;
    let ownerStaffed = 0;
    const pid = this.playerId();
    const shared = this.bayShared(st.systemId);
    for (const bay of st.bays) {
      if (!bay.lesseeId) continue;
      // Shared floor: foreign lessees report their own cycle + tax RPC.
      if (shared && this._foreignLessee(bay)) continue;
      const gross = this._bayGross(st, bay);
      if (gross <= 0) continue;
      total += gross;
      const isOwner = (bay.lesseeId === st.ownerId || bay.lesseeId === pid
        || (this.accountId() && bay.lesseeId === this.accountId())) && !bay.npc
        && st.ownerId === pid;
      if (isOwner) {
        ownerStaffed++;
        st.hold[st.prodComm] = (st.hold[st.prodComm] | 0) + gross;
        continue;
      }
      const taxQty = Math.floor(gross * taxBps / 10000);
      const keep = gross - taxQty;
      if (taxQty > 0) {
        st.hold[st.prodComm] = (st.hold[st.prodComm] | 0) + taxQty;
      }
      if (keep <= 0) continue;
      if (bay.npc) continue; // NPC keeps residual off-map
      if (bay.lesseeId === pid && window.Game) {
        const s = Game.state;
        const held = s.positions[st.prodComm] || 0;
        s.positions[st.prodComm] = held + keep;
        // Soft income at zero cost basis (same as industry minting).
        s.avgCost[st.prodComm] = held > 0 ? ((s.avgCost[st.prodComm] || 0) * held) / (held + keep) : 0;
        if (window.Assets) Assets.parkBlocks(st.systemId, st.prodComm, keep);
      } else {
        // Remote / third-party lessee (guest-local) — park keep until they claim.
        if (!st.pendingCargo || typeof st.pendingCargo !== "object") st.pendingCargo = {};
        const bag = st.pendingCargo[bay.lesseeId] || (st.pendingCargo[bay.lesseeId] = {});
        bag[st.prodComm] = (bag[st.prodComm] | 0) + keep;
      }
    }
    // Expected deliveries scale with hub level and how many owner bays are staffed.
    const staffFactor = Math.max(0.35, ownerStaffed / Math.max(1, st.bays.length));
    st.expected = Math.round(STATIONCFG.expectedDeliveryBase * hub
      * (1 + this.tierInfo(st.tier).rank * 0.15) * staffFactor);
    // Shared hold grows in app_station_after_hour (server-derived baseline).
    // Local hold still updates above for the Stations tab; after_hour sync
    // replaces it. No client deposit — that was a mint vector.
    return total;
  },

  // Haul station hold → sell on the sector capital exchange (owner action).
  async deliverToExchange(systemId, commId, qty) {
    const st = this.get(systemId);
    if (!st || !this._mine(st)) return { ok: false, msg: "Not your station." };
    const s = Game.state;
    if (s.travel) return { ok: false, msg: "Can't deliver in transit." };
    const sec = Galaxy.sector(st.sectorId);
    if (!sec || s.currentSystem !== sec.capital) {
      const cap = sec && Galaxy.get(sec.capital);
      return { ok: false, msg: `Dock at ${cap ? cap.name : "the capital"} to deliver.` };
    }
    qty = Math.min(Math.floor(qty), st.hold[commId] | 0);
    if (qty <= 0) return { ok: false, msg: "Nothing to deliver." };
    if (this.contractsShared(systemId) && this._contractsWritable()
        && window.Cloud && Cloud.stationDeliver) {
      try {
        const res = await Cloud.stationDeliver(systemId, commId, qty);
        if (!res || !res.ok) return { ok: false, msg: (res && res.error) || "Delivery refused." };
        this._applyHoldFromServer(st, res.hold);
        if (res.credits != null) s.credits = +res.credits;
        const got = Math.max(0, Math.floor(+res.qty || qty));
        const proceeds = Math.max(0, +res.proceeds || 0);
        const price = +res.price || (got ? proceeds / got : 0);
        if (!(window.Stock && Stock.authoritative && Stock.authoritative()))
          Stock.put(st.sectorId, commId, got);
        st.delivered = (st.delivered | 0) + got;
        this._ledger(st, proceeds, "delivery", `${got}× ${commId}`);
        Bus.emit("trade", { side: "sell", commId, qty: got, price });
        if (window.Game) Game.requestSave();
        return { ok: true, qty: got, proceeds, price };
      } catch (e) {
        console.warn("[Stations] deliver failed:", e);
        return { ok: false, msg: "Couldn't reach the station hold." };
      }
    }
    if (this.contractsShared(systemId) && this._contractsWritable()
        && window.Cloud && Cloud.stationHoldDeposit) {
      try {
        const res = await Cloud.stationHoldDeposit(systemId, { [commId]: -qty });
        if (!res || !res.ok) return { ok: false, msg: (res && res.error) || "Hold draw refused." };
        this._applyHoldFromServer(st, res.hold);
      } catch (e) {
        console.warn("[Stations] hold take failed:", e);
        return { ok: false, msg: "Couldn't reach the station hold." };
      }
    } else {
      st.hold[commId] -= qty;
    }
    const price = Economy.sellPrice(commId);
    const proceeds = price * qty;
    s.credits += proceeds;
    Stock.put(st.sectorId, commId, qty);
    st.delivered = (st.delivered | 0) + qty;
    this._ledger(st, proceeds, "delivery", `${qty}× ${commId}`);
    Bus.emit("trade", { side: "sell", commId, qty, price });
    if (window.Game) Game.requestSave();
    return { ok: true, qty, proceeds, price };
  },
  // Alias used by UI / harness.
  deliver(systemId, commId, qty) { return this.deliverToExchange(systemId, commId, qty); },

  async withdraw(systemId, amount) {
    const st = this.get(systemId);
    if (!st || !this._mine(st)) return { ok: false, msg: "Not your station." };
    amount = Math.floor(+amount || 0);
    if (amount <= 0 || amount > st.treasury) return { ok: false, msg: "Invalid amount." };
    if (this.treasuryShared(systemId)) {
      let res;
      try { res = await Cloud.stationWithdraw(systemId, amount); }
      catch (e) {
        console.warn("[Stations] withdraw failed:", e);
        return { ok: false, msg: "Couldn't reach the station ledger." };
      }
      if (!res || !res.ok) return { ok: false, msg: (res && res.error) || "Withdraw refused." };
      st.treasury = Math.max(0, Math.floor(+res.treasury || 0));
      if (res.credits != null) Game.state.credits = +res.credits;
      else Game.state.credits += amount;
      this._ledger(st, -amount, "withdraw", "treasury");
      if (window.Economy) Economy.refreshNetWorth();
      if (window.Game) Game.requestSave();
      return { ok: true, amount };
    }
    st.treasury -= amount;
    Game.state.credits += amount;
    this._ledger(st, -amount, "withdraw", "treasury");
    if (window.Game) Game.requestSave();
    return { ok: true, amount };
  },

  // ---- Auctions ----------------------------------------------------------
  openingBid(st) {
    const rank = this.tierInfo(st.tier).rank;
    const raw = STATIONCFG.openingBase + rank * STATIONCFG.openingPerTier
      + this.moduleValue(st) * STATIONCFG.moduleValueFrac;
    return Math.max(STATIONCFG.minBidIncrement, Math.round(raw / 50000) * 50000);
  },

  getAuction(systemId) {
    if (this.auctionsShared() && this.remoteAuctions[systemId])
      return this.remoteAuctions[systemId];
    return this.auctions[systemId] || null;
  },

  openAuction(systemId, bid) {
    const st = this.get(systemId);
    if (!st) return { ok: false, msg: "No station." };
    if (this.ownerHeld(st)) return { ok: false, msg: "Already owned." };
    const rem = this.remoteHolder(systemId);
    if (rem) return { ok: false, msg: `${rem.display} holds this station.` };
    if (st.status === "cooldown" && Date.now() < st.cooldownUntil)
      return { ok: false, msg: "Station is cooling down after a revolt." };
    if (this.auctions[systemId] && this.auctions[systemId].status === "open")
      return { ok: false, msg: "Auction already open." };
    if (this.auctionsShared() && this.remoteAuctions[systemId])
      return { ok: false, msg: "Auction already open." };
    const pid = this.playerId();
    const tier = window.Economy ? Economy.tier() : 0;
    if (this.ownedCount(pid) >= this.ownerCap(tier))
      return { ok: false, msg: "Station ownership cap reached for your tier." };
    const min = this.openingBid(st);
    bid = Math.floor(+bid || min);
    if (bid < min) return { ok: false, msg: `Opening bid is ${Util.credits(min)}.` };
    if (this.auctionsShared()) {
      return Cloud.stationAuctionOpen(systemId, bid).then(res => {
        if (!res || !res.ok) return { ok: false, msg: (res && res.error) || "Couldn't open auction." };
        const auc = this._ingestAuction({
          system_id: systemId,
          opens_at: res.opens_at || Date.now(),
          closes_at: res.closes_at, high_bid: res.high_bid, high_bidder: this.accountId(),
        });
        this.remoteAuctions[systemId] = auc;
        if (res.credits != null) Game.state.credits = +res.credits;
        if (window.Economy) Economy.refreshNetWorth();
        if (window.Game) Game.requestSave();
        if (window.UI && UI.toast) UI.toast(`Auction opened on ${st.name} at ${Util.credits(bid)}.`, "good");
        return { ok: true, auction: auc };
      }).catch(e => {
        console.warn("[Stations] auction open failed:", e);
        return { ok: false, msg: "Couldn't reach the auction ledger." };
      });
    }
    const s = Game.state;
    const escrowed = this.escrowTotal(pid);
    if (s.credits - escrowed < bid) return { ok: false, msg: "Not enough free credits (escrow counts)." };
    // Escrow: deduct immediately.
    s.credits -= bid;
    const now = Date.now();
    // Dev fast-news shortens the 72h window so auctions are testable in-session.
    const dur = (CONFIG.fastNews ? 2 * 60 * 1000 : STATIONCFG.auctionHours * 3600 * 1000);
    this.auctions[systemId] = {
      systemId,
      status: "open",
      opensAt: now,
      closesAt: now + dur,
      highBid: bid,
      highBidder: pid,
      bids: [{ playerId: pid, amount: bid, at: now }],
    };
    if (st.status === "cooldown") st.status = "npc";
    if (window.Game) Game.requestSave();
    if (window.UI && UI.toast) UI.toast(`Auction opened on ${st.name} at ${Util.credits(bid)}.`, "good");
    return { ok: true, auction: this.auctions[systemId] };
  },

  bid(systemId, amount) {
    const auc = this.getAuction(systemId);
    if (!auc || auc.status !== "open") return { ok: false, msg: "No open auction." };
    const st = this.get(systemId);
    const pid = this.playerId();
    const me = this.accountId();
    const tier = window.Economy ? Economy.tier() : 0;
    if (this.ownedCount(pid) >= this.ownerCap(tier)
        && auc.highBidder !== pid && auc.highBidder !== me)
      return { ok: false, msg: "Station ownership cap reached for your tier." };
    amount = Math.floor(+amount || 0);
    const min = auc.highBid + STATIONCFG.minBidIncrement;
    if (amount < min) return { ok: false, msg: `Bid at least ${Util.credits(min)}.` };
    if (this.auctionsShared()) {
      return Cloud.stationBid(systemId, amount).then(res => {
        if (!res || !res.ok) return { ok: false, msg: (res && res.error) || "Bid refused." };
        auc.highBid = Math.floor(+res.high_bid || amount);
        auc.highBidder = me || pid;
        if (res.closes_at) auc.closesAt = Date.parse(res.closes_at) || auc.closesAt;
        if (res.credits != null) Game.state.credits = +res.credits;
        if (window.Economy) Economy.refreshNetWorth();
        if (window.Game) Game.requestSave();
        return { ok: true, auction: auc };
      }).catch(e => {
        console.warn("[Stations] bid failed:", e);
        return { ok: false, msg: "Couldn't reach the auction ledger." };
      });
    }
    const s = Game.state;
    // If we're already high bidder, only need the delta escrowed.
    let need = amount;
    if (auc.highBidder === pid) need = amount - auc.highBid;
    const escrowed = this.escrowTotal(pid) - (auc.highBidder === pid ? auc.highBid : 0);
    if (s.credits - escrowed < need) return { ok: false, msg: "Not enough free credits." };

    // Refund previous high bidder (if other player — guest single-player: usually us or NPC).
    if (auc.highBidder && auc.highBidder !== pid) {
      // Guest mode: only one real player; treat other bidders as NPC (credits burned/sunk).
      // If somehow same save: refund into credits when highBidder === "player" handled below.
      if (auc.highBidder === "player" || auc.highBidder === this.playerId()) {
        s.credits += auc.highBid;
      }
    } else if (auc.highBidder === pid) {
      // Raising own bid: pay the delta only (need already computed).
    }

    if (auc.highBidder === pid) {
      s.credits -= need;
    } else {
      s.credits -= amount;
    }

    const now = Date.now();
    auc.highBid = amount;
    auc.highBidder = pid;
    auc.bids.push({ playerId: pid, amount, at: now });
    // Anti-snipe
    if (auc.closesAt - now < STATIONCFG.antiSnipeMs) {
      auc.closesAt = now + STATIONCFG.antiSnipeMs;
    }
    if (window.Game) Game.requestSave();
    return { ok: true, auction: auc };
  },

  escrowTotal(pid = this.playerId()) {
    let n = 0;
    const me = this.accountId();
    if (this.auctionsShared()) {
      for (const auc of Object.values(this.remoteAuctions)) {
        if (auc.status === "open" && (auc.highBidder === pid || (me && auc.highBidder === me)))
          n += auc.highBid;
      }
      return n;
    }
    for (const auc of Object.values(this.auctions)) {
      if (auc.status === "open" && auc.highBidder === pid) n += auc.highBid;
    }
    return n;
  },

  _isAdmin() { return !!(window.Cloud && Cloud.isAdmin && Cloud.isAdmin()); },

  // Cancel an open auction and refund the local player's escrowed high bid.
  _cancelAuction(systemId) {
    const auc = this.auctions[systemId];
    if (!auc || auc.status !== "open") return;
    const pid = this.playerId();
    if (auc.highBidder === pid || auc.highBidder === "player") {
      Game.state.credits += auc.highBid | 0;
    }
    auc.status = "cancelled";
    delete this.auctions[systemId];
  },

  // Admin: take a claimable station immediately — no bid, no 72h wait, no cap.
  // ponytail: client-gated like the rest of Stations until Phase 4; add
  // app_station_admin_claim (role-checked) before cloud-authoritative ownership.
  adminClaim(systemId) {
    if (!this._isAdmin()) return { ok: false, msg: "Admins only." };
    const st = this.get(systemId);
    if (!st) return { ok: false, msg: "No station." };
    if (st.status === "owned" && this._mine(st))
      return { ok: false, msg: "You already own this station." };
    if (st.status === "owned" && st.ownerId && st.ownerId !== this.playerId())
      return { ok: false, msg: "Already owned — relinquish first." };
    this._cancelAuction(systemId);
    const pid = this.playerId();
    st.ownerId = pid;
    st.status = "owned";
    st.standing = STATIONCFG.standingStart;
    st.delivered = 0;
    st.cooldownUntil = 0;
    if (window.Game) Game.requestSave();
    this._publishSoon();
    return { ok: true, st };
  },

  // Exchange-style value of goods sitting in the station hold (for buyback).
  holdValue(st) {
    let n = 0;
    for (const [commId, qty] of Object.entries((st && st.hold) || {})) {
      const q = qty | 0;
      if (q <= 0) continue;
      const price = (window.Economy && Economy.sellPrice)
        ? Economy.sellPrice(commId)
        : (window.Market ? Market.price(commId) : 0);
      n += Math.round((+price || 0) * q);
    }
    return n;
  },

  // Owner walks away. Modules persist; no cooldown. Treasury + hold buyback return.
  // Shared path: app_station_release credits buyback server-side and zeroes wealth.
  async relinquish(systemId) {
    const st = this.get(systemId);
    if (!st) return { ok: false, msg: "No station." };
    const pid = this.playerId();
    const mine = st.ownerId === pid && this.ownerHeld(st);
    if (!mine) return { ok: false, msg: "Not your station." };

    if (this.treasuryShared(systemId) && this._treasuryWritable()
        && window.Cloud && Cloud.stationRelease) {
      try {
        const res = await Cloud.stationRelease(systemId, "relinquish");
        if (!res || !res.ok) return { ok: false, msg: (res && res.error) || "Release refused." };
        if (res.credits != null) Game.state.credits = +res.credits;
        const treasury = Math.max(0, Math.floor(+res.treasury || 0));
        const holdCredits = Math.max(0, Math.floor(+res.holdCredits || 0));
        if (treasury > 0) this._ledger(st, -treasury, "relinquish", "treasury returned");
        if (holdCredits > 0) this._ledger(st, holdCredits, "relinquish_hold", "hold buyback");
        for (const c of (st.contracts || []).filter(x => x.status === "open")) this._refundHaul(st, c);
        st.contracts = (st.contracts || []).filter(x => x.status === "active");
        for (const l of st.hall || []) this._restoreListable(l, l.sellerId);
        st.hall = [];
        this.syncBays(st);
        for (const bay of st.bays || []) this._clearBay(st, bay);
        st.ownerId = null;
        st.status = "npc";
        st.cooldownUntil = 0;
        st.treasury = 0;
        st.hold = {};
        st.standing = STATIONCFG.standingStart;
        st.prodComm = null;
        st.impoundHold = {};
        st.impoundClaims = [];
        st.delivered = 0;
        delete this.access[st.systemId];
        this._cancelAuction(systemId);
        if (window.Game) Game.requestSave();
        this._publishSoon();
        return { ok: true, st, treasury, holdCredits };
      } catch (e) {
        console.warn("[Stations] release failed:", e);
        return { ok: false, msg: "Couldn't reach the station ledger." };
      }
    }

    const treasury = st.treasury | 0;
    const holdCredits = this.holdValue(st);
    if (treasury > 0) {
      Game.state.credits += treasury;
      this._ledger(st, -treasury, "relinquish", "treasury returned");
      st.treasury = 0;
    }
    if (holdCredits > 0) {
      Game.state.credits += holdCredits;
      this._ledger(st, holdCredits, "relinquish_hold", "hold buyback");
    }
    for (const c of (st.contracts || []).filter(x => x.status === "open")) this._refundHaul(st, c);
    st.contracts = (st.contracts || []).filter(x => x.status === "active");
    for (const l of st.hall || []) this._restoreListable(l, l.sellerId);
    st.hall = [];
    this.syncBays(st);
    for (const bay of st.bays || []) this._clearBay(st, bay);
    st.ownerId = null;
    st.status = "npc";
    st.cooldownUntil = 0;
    st.hold = {};
    st.standing = STATIONCFG.standingStart;
    st.prodComm = null;
    st.impoundHold = {};
    st.impoundClaims = [];
    st.delivered = 0;
    delete this.access[st.systemId];
    this._cancelAuction(systemId);
    if (window.Game) Game.requestSave();
    this._publishSoon();
    return { ok: true, st, treasury, holdCredits };
  },

  // Credits currently locked in bids — counted in net worth.
  _closeAuction(systemId, now = Date.now()) {
    const auc = this.auctions[systemId];
    if (!auc || auc.status !== "open") return;
    if (now < auc.closesAt) return;
    const st = this.get(systemId);
    const winner = auc.highBidder;
    const tier = window.Economy ? Economy.tier() : 0;
    // Cap re-check at close — forfeit to next eligible (guest: just forfeit to NPC).
    if (winner === this.playerId() && this.ownedCount(winner) >= this.ownerCap(tier)) {
      Game.state.credits += auc.highBid; // refund
      auc.status = "forfeit";
      return;
    }
    if (winner === this.playerId()) {
      st.ownerId = winner;
      st.status = "owned";
      st.standing = STATIONCFG.standingStart;
      st.delivered = 0;
      // Winning credits sunk to controlling faction (credit sink — keep it).
      this._ledger(st, auc.highBid, "auction_win", "paid to controlling faction");
      this._publishSoon();
      auc.status = "closed";
      if (window.UI && UI.toast) UI.toast(`You won ${st.name} for ${Util.credits(auc.highBid)}.`, "good");
      if (window.Story && Story.inbox) {
        // Soft comms notice without depending on Story internals.
      }
    } else {
      // NPC / unknown winner — refund local player if they were outbid already (already refunded).
      auc.status = "closed";
      st.status = "npc";
      st.ownerId = null;
    }
  },

  // ---- NPC production baskets → sector stock -----------------------------
  // Categories where system mod < 1.0 are producers. Reroll 2–3 commodities hourly.
  _npcBasket(st, hourIndex) {
    const sys = Galaxy.get(st.systemId);
    if (!sys) return [];
    let cats = Object.keys(sys.mods || {}).filter(c => (sys.mods[c] ?? 1) < 1.0);
    if (!cats.length) {
      const spec = Stock.specialty(st.sectorId);
      if (spec) cats = [spec];
    }
    // Prefer understocked commodities in the producing cats so NPC supply
    // hunts shortages instead of stacking already-full specialty shelves.
    let pool = COMMODITIES.filter(c => !c.craftOnly && c.rarity !== "exotic" && cats.includes(c.cat));
    if (!pool.length) {
      // Last resort: anything the sector is short on.
      pool = COMMODITIES.filter(c => !c.craftOnly && c.rarity !== "exotic" && Stock.ratio(st.sectorId, c.id) < 0.5);
    }
    if (!pool.length) return [];
    pool = pool.slice().sort((a, b) => Stock.ratio(st.sectorId, a.id) - Stock.ratio(st.sectorId, b.id));
    const s = Market._seed([st.systemId, "basket", String(hourIndex)]);
    const n = 2 + (Market._u01(s, 0) < 0.45 ? 1 : 0);
    // Bias toward the scarcest half of the pool, with a little seed jitter.
    const picks = [];
    const used = new Set();
    const focus = pool.slice(0, Math.max(n, Math.ceil(pool.length * 0.6)));
    for (let i = 0; i < n && picks.length < focus.length; i++) {
      const idx = Math.floor(Market._u01(s, i + 1) * focus.length) % focus.length;
      const c = focus[idx];
      if (used.has(c.id)) continue;
      used.add(c.id);
      picks.push(c);
    }
    if (!picks.length) picks.push(pool[0]);
    return picks;
  },

  npcProduceHour(hourIndex) {
    let produced = 0;
    for (const st of this.list()) {
      // Held by another baron: their Production Hub fills their hold, and only
      // reaches the shelf when they haul it to a capital (§4.2). Our local copy
      // must stop quietly minting NPC supply on their behalf.
      if (this.isRemote(st.systemId)) continue;
      if (st.status === "owned" || st.status === "refit") {
        // Player hubs don't feed sector stock directly.
        if (st.status === "owned") this._fillNpcTenants(st, hourIndex);
        this._playerProduce(st, hourIndex);
        continue;
      }
      if (st.status === "cooldown") continue;
      const basket = this._npcBasket(st, hourIndex);
      for (const c of basket) {
        const rarity = c.rarity || "common";
        const base = STOCKCFG.npcUnits[rarity] || 0;
        const mult = Stock.npcOutputMult(st.sectorId, c.id);
        // Cheaper mods → slightly higher output.
        const sys = Galaxy.get(st.systemId);
        const mod = sys ? (sys.mods[c.cat] ?? 1) : 1;
        const cheapBonus = mod < 1 ? (1 + (1 - mod)) : 1;
        const out = Math.max(1, Math.round(base * mult * cheapBonus));
        Stock.put(st.sectorId, c.id, out);
        produced += out;
      }
    }
    return produced;
  },

  // ---- Standing / revolt (after stock hour) ------------------------------
  afterStockHour(hourIndex) {
    const now = Date.now();
    if (!this.auctionsShared()) {
      for (const id of Object.keys(this.auctions)) this._closeAuction(id, now);
    }

    const upkeepReports = [];
    for (const st of this.list()) {
      // Clear finished refits / cooldowns.
      if (st.status === "refit" && now >= st.refitUntil) st.status = st.ownerId ? "owned" : "npc";
      if (st.status === "cooldown" && now >= st.cooldownUntil) st.status = "npc";

      // Exchange Hall: expiry + guest NPC buyers (liquidity until real P2P).
      if (this.hasHall(st)) {
        this._expireHall(st, now);
        const sold = this._npcBuyHall(st, hourIndex);
        if (sold.length && window.Economy) Economy.refreshNetWorth();
      }

      // Contract Office: expire open hauls + slow NPC fill.
      if (this.hasContractOffice(st) || (st.contracts || []).length) {
        this._expireHauls(st, now);
        if (this.hasContractOffice(st)) this._npcFillHauls(st, hourIndex);
      }

      // Standing decay and upkeep are both suspended during a declared refit
      // (docs open question → yes): the station is offline by the owner's choice.
      if (st.status !== "owned") { if (st.status === "refit") st.delivered = 0; continue; }

      if (this.upkeepShared(st.systemId) && this._mine(st)) {
        upkeepReports.push({
          system_id: st.systemId,
          delivered: st.delivered | 0,
          expected: st.expected || STATIONCFG.expectedDeliveryBase,
        });
        if (st.modules.customs_house | 0) {
          if (window.Rep) {
            Rep.change("free_trade", 0.4);
            Rep.change("mining_combine", 0.2);
            Rep.change("syndicate", -0.8);
          }
        } else if (st.modules.free_port | 0) {
          if (window.Rep) {
            Rep.change("syndicate", 0.6);
            Rep.change("free_trade", -0.4);
          }
        }
        st.delivered = 0;
        continue;
      }

      let standing = st.standing;
      const expected = st.expected || STATIONCFG.expectedDeliveryBase;
      const del = st.delivered | 0;
      if (del >= expected) standing += 4;
      else if (del > 0) standing += 1;
      else standing -= 5;

      const hub = st.modules.production_hub | 0;
      this.syncBays(st);
      const staffed = (st.bays || []).filter(b => b.lesseeId && !b.npc && b.lesseeId === st.ownerId).length;
      if (!hub || !st.prodComm || !staffed) standing -= 3; // idle / unstaffed hub
      if ((st.leaseTaxBps | 0) > STATIONCFG.fairLeaseTaxBps) standing -= 2;

      // Upkeep: pull from treasury, then owner credits; unpaid hurts standing.
      const upkeep = this.upkeepPerCycle(st);
      if (st.treasury >= upkeep) {
        st.treasury -= upkeep;
        this._ledger(st, -upkeep, "upkeep", "treasury");
      } else if (this._mine(st) && Game.state.credits >= upkeep) {
        Game.state.credits -= upkeep;
        this._ledger(st, -upkeep, "upkeep", "owner");
      } else {
        standing -= 6;
        this._ledger(st, 0, "upkeep_missed", String(upkeep));
      }

      // Customs / Free Port policy forks (docs/STATIONS.md §12).
      if (st.modules.customs_house | 0) {
        const sub = STATIONCFG.customsSubsidy | 0;
        if (sub > 0) { st.treasury += sub; this._ledger(st, sub, "enforcement", "lawful subsidy"); }
        standing += STATIONCFG.customsStandingTick || 1;
        if (this._mine(st) && window.Rep) {
          Rep.change("free_trade", 0.4);
          Rep.change("mining_combine", 0.2);
          Rep.change("syndicate", -0.8);
        }
      } else if (st.modules.free_port | 0) {
        standing += STATIONCFG.freePortStandingTick || -1;
        if (this._mine(st) && window.Rep) {
          Rep.change("syndicate", 0.6);
          Rep.change("free_trade", -0.4);
        }
      }

      st.standing = Util.clamp(standing, 0, 100);
      st.delivered = 0;

      const sentiment = (window.Stock && Stock.sentiment[st.sectorId]) || STATIONCFG.sentimentStart;
      this._warnStages(st, sentiment);
      this._maybeRevolt(st, sentiment, hourIndex);
    }
    // Hourly: server upkeep/auctions, refresh directory, leases, settle.
    let chain = Promise.resolve();
    if (upkeepReports.length && window.Cloud && Cloud.treasuryReady && Cloud.treasuryReady()) {
      chain = chain.then(() => Cloud.stationAfterHour(upkeepReports)).then(res => {
        if (res && res.ok) {
          this._applyTreasurySync(res);
          if (res.credits != null && window.Game) Game.state.credits = +res.credits;
          for (const row of upkeepReports) {
            const st = this.get(row.system_id);
            if (!st || st.status !== "owned") continue;
            const sentiment = (window.Stock && Stock.sentiment[st.sectorId]) || STATIONCFG.sentimentStart;
            this._warnStages(st, sentiment);
            this._maybeRevolt(st, sentiment, hourIndex);
          }
        }
      });
    }
    if (this.auctionsShared()) {
      chain = chain.then(() => Cloud.stationCloseDue()).then(res => {
        if (res && res.ok) this._applyAuctionClose(res);
      });
    }
    void chain
      .then(() => this.refreshAuctions())
      .then(() => this.refreshDirectory())
      .then(() => this.publishOwned())
      .then(() => {
        this.reconcileRemoteLeases();
        return this.produceRemoteLeases(hourIndex);
      })
      .then(() => this.settleHall())
      .then(() => this._retryPendingHaulSettles());
  },

  _warnStages(st, sentiment) {
    let stage = null;
    if (st.standing < 20) stage = "strike";
    else if (st.standing < 35 && sentiment < 40) stage = "protests";
    else if (st.standing < 45) stage = "unrest";
    if (!stage || this.lastWarn[st.systemId] === stage) return;
    this.lastWarn[st.systemId] = stage;
    const msg = {
      unrest: `Unrest at ${st.name}: standing is slipping. Deliver goods to the capital.`,
      protests: `Protests at ${st.name}: revolt rolls have begun.`,
      strike: `General strike at ${st.name}: production halved, revolt risk doubled.`,
    }[stage];
    if (window.UI && UI.toast) UI.toast(msg, "warn", 8000);
    if (window.Bus) Bus.emit("news", { text: msg, kind: "station" });
  },

  _maybeRevolt(st, sentiment, hourIndex) {
    if (sentiment >= STATIONCFG.revoltSentiment || st.standing >= STATIONCFG.revoltStanding) return;
    let chance = (1 - sentiment / 100) * (1 - st.standing / 100) * STATIONCFG.revoltRate;
    if (st.standing < 20) chance *= 2;
    chance = Util.clamp(chance, 0, 0.35);
    const s = Market._seed([st.systemId, "revolt", String(hourIndex)]);
    if (Market._u01(s, 0) > chance) return;
    // Revolt! Refund open-haul escrow to the owner before wiping identity/hold.
    // Goods reserved in the post return to hold briefly, then the hold is seized.
    for (const c of (st.contracts || []).filter(x => x.status === "open")) this._refundHaul(st, c);
    st.contracts = (st.contracts || []).filter(x => x.status === "active");
    st.ownerId = null;
    st.status = "cooldown";
    st.cooldownUntil = Date.now() + STATIONCFG.cooldownMs;
    st.treasury = 0; // forfeited to faction
    st.hold = {};
    st.standing = STATIONCFG.standingStart;
    st.prodComm = null;
    // Clear bays — player extractors return to storage (not seized).
    this.syncBays(st);
    for (const bay of st.bays || []) this._clearBay(st, bay);
    // Hall listings return to sellers (not seized with the landlord).
    for (const l of st.hall || []) this._restoreListable(l, l.sellerId);
    st.hall = [];
    st.impoundHold = {};
    st.impoundClaims = [];
    delete this.access[st.systemId];
    // Modules persist — including reactor.
    delete this.auctions[st.systemId];
    this.lastWarn[st.systemId] = "revolt";
    // Shared: forfeit treasury/hold + cooldown on the server (don't leave wealth for the next owner).
    if (this.treasuryShared(st.systemId) && this._treasuryWritable()
        && window.Cloud && Cloud.stationRelease) {
      void Cloud.stationRelease(st.systemId, "revolt").catch(e =>
        console.warn("[Stations] revolt release failed:", e));
    } else {
      this._publishSoon();
    }
    if (window.UI && UI.toast) UI.toast(`Revolt! You lost ${st.name}. Modules remain for the next owner.`, "bad", 10000);
  },

  // ---- Workshop Annex discount (option 3: stochastic per unit) -----------
  workshopMatChance(systemId) {
    const st = this.view(systemId);
    if (!st || !(st.modules.workshop_annex | 0)) return 0;
    if (st.status === "refit") return 0;
    const row = STATIONCFG.workshop[(st.modules.workshop_annex) - 1];
    return row ? row.mat : 0;
  },
  workshopTimeFactor(systemId) {
    const st = this.view(systemId);
    if (!st || !(st.modules.workshop_annex | 0)) return 1;
    if (st.status === "refit") return 1;
    const row = STATIONCFG.workshop[(st.modules.workshop_annex) - 1];
    return row ? (1 - row.time) : 1;
  },

  // Customs scrutiny override for a system (null = baseline capital formula).
  scrutinyFor(systemId) {
    const st = this.view(systemId);
    if (!st) return null;
    if (st.modules.free_port)
      return Math.max(0, (CUSTOMS.base || 0.1) * (STATIONCFG.freePortScrutinyMult || 0.35));
    if (st.modules.customs_house) return Util.clamp((st.scrutiny | 0) / 100, 0, CUSTOMS.cap || 0.85);
    return null;
  },

  // ---- Customs impound / ransom (docs/STATIONS.md §12) --------------------
  impoundCargo(systemId, commId, qty, value, fromId) {
    const st = this.get(systemId);
    if (!st || !(st.modules.customs_house | 0)) return { ok: false, msg: "No Customs House." };
    qty = Math.max(1, Math.floor(+qty || 0));
    if (!st.impoundHold || typeof st.impoundHold !== "object") st.impoundHold = {};
    if (!Array.isArray(st.impoundClaims)) st.impoundClaims = [];
    st.impoundHold[commId] = (st.impoundHold[commId] | 0) + qty;
    const ransom = Math.max(1, Math.round((value || 0) * (STATIONCFG.ransomMult || 1.25)));
    const claimId = "ic" + (++Game.state.seq);
    st.impoundClaims.push({
      id: claimId, commId, qty, value: value | 0, ransom,
      fromId: fromId || null, at: Date.now(),
    });
    this._ledger(st, 0, "impound", `${qty}× ${commId}`);
    if (window.Game) Game.requestSave();
    return { ok: true, claimId, ransom };
  },

  sellImpound(systemId, commId, qty) {
    const st = this.get(systemId);
    if (!st || !this._mine(st)) return { ok: false, msg: "Not your station." };
    const s = Game.state;
    if (s.travel) return { ok: false, msg: "Can't sell in transit." };
    const sec = Galaxy.sector(st.sectorId);
    if (!sec || s.currentSystem !== sec.capital) {
      const cap = sec && Galaxy.get(sec.capital);
      return { ok: false, msg: `Dock at ${cap ? cap.name : "the capital"} to fence impound.` };
    }
    qty = Math.min(Math.floor(+qty || 0), st.impoundHold[commId] | 0);
    if (qty <= 0) return { ok: false, msg: "Nothing in impound." };
    const price = Economy.sellPrice(commId);
    const proceeds = Math.round(price * qty);
    st.impoundHold[commId] -= qty;
    this._trimImpoundClaims(st, commId, qty);
    st.treasury += proceeds;
    Stock.put(st.sectorId, commId, qty);
    this._ledger(st, proceeds, "impound_sale", `${qty}× ${commId}`);
    // Lawful fork: enforcement sales please Free Trade, annoy Syndicate.
    if (window.Rep && this._mine(st)) {
      Rep.change("free_trade", 1);
      Rep.change("syndicate", -2);
    }
    if (window.Game) Game.requestSave();
    return { ok: true, qty, proceeds };
  },

  _trimImpoundClaims(st, commId, qty) {
    let left = qty;
    st.impoundClaims = (st.impoundClaims || []).filter(c => {
      if (c.commId !== commId || left <= 0) return true;
      if (c.qty <= left) { left -= c.qty; return false; }
      c.qty -= left; c.ransom = Math.max(1, Math.round(c.ransom * (c.qty / (c.qty + left))));
      left = 0;
      return true;
    });
  },

  payRansom(systemId, claimId) {
    const st = this.get(systemId);
    if (!st) return { ok: false, msg: "No station." };
    const s = Game.state;
    if (s.currentSystem !== systemId) return { ok: false, msg: "Dock at the station to pay ransom." };
    const idx = (st.impoundClaims || []).findIndex(c => c.id === claimId);
    if (idx < 0) return { ok: false, msg: "Claim gone." };
    const c = st.impoundClaims[idx];
    if (c.fromId && c.fromId !== this.playerId()) return { ok: false, msg: "Not your seizure." };
    if (s.credits < c.ransom) return { ok: false, msg: "Not enough credits." };
    const have = st.impoundHold[c.commId] | 0;
    if (have < c.qty) return { ok: false, msg: "Goods already sold." };
    s.credits -= c.ransom;
    st.treasury += c.ransom;
    st.impoundHold[c.commId] = have - c.qty;
    s.positions[c.commId] = (s.positions[c.commId] | 0) + c.qty;
    if (window.Assets) Assets.parkBlocks(systemId, c.commId, c.qty);
    st.impoundClaims.splice(idx, 1);
    this._ledger(st, c.ransom, "ransom", `${c.qty}× ${c.commId}`);
    // Paying a bribe helps Syndicate; owner taking it costs lawful standing.
    if (window.Rep) {
      Rep.change("syndicate", 2);
      Rep.change("free_trade", -1);
      if (this._mine(st)) Rep.change("syndicate", 1);
    }
    if (window.Game) Game.requestSave();
    return { ok: true, qty: c.qty, paid: c.ransom, commId: c.commId };
  },

  // Owner releases a claim back for free (or burns it).
  dropImpoundClaim(systemId, claimId) {
    const st = this.get(systemId);
    if (!st || !this._mine(st)) return { ok: false, msg: "Not your station." };
    const idx = (st.impoundClaims || []).findIndex(c => c.id === claimId);
    if (idx < 0) return { ok: false, msg: "Claim gone." };
    const c = st.impoundClaims[idx];
    st.impoundClaims.splice(idx, 1);
    st.impoundHold[c.commId] = Math.max(0, (st.impoundHold[c.commId] | 0) - c.qty);
    if (window.Game) Game.requestSave();
    return { ok: true };
  },

  // ---- tick (auctions; stock hour is driven by Stock.tick) ---------------
  _haulSettleInflight: null, // Set of contractIds currently settling
  _retryPendingHaulSettles() {
    const s = window.Game && window.Game.state;
    if (!s || !this._contractsWritable()) return;
    const pending = Array.isArray(s.pendingHaulSettles) ? s.pendingHaulSettles : [];
    if (!pending.length) return;
    if (!this._haulSettleInflight) this._haulSettleInflight = new Set();
    const MAX_ATTEMPTS = 8;
    const next = [];
    let changed = false;
    for (const row of pending) {
      if (!row || typeof row.contractId !== "string") { changed = true; continue; }
      const outcome = row.outcome === "fail" || row.outcome === "abandon" ? row.outcome : "success";
      const attempts = Math.max(0, row.attempts | 0);
      if (attempts >= MAX_ATTEMPTS) { changed = true; continue; }
      if (this._haulSettleInflight.has(row.contractId)) {
        next.push({ contractId: row.contractId, outcome, attempts });
        continue;
      }
      this._haulSettleInflight.add(row.contractId);
      next.push({ contractId: row.contractId, outcome, attempts: attempts + 1 });
      void this.settleHaul(row.contractId, outcome).then(res => {
        this._haulSettleInflight.delete(row.contractId);
        const cur = Array.isArray(window.Game.state.pendingHaulSettles) ? window.Game.state.pendingHaulSettles : [];
        if (res && res.ok) {
          window.Game.state.pendingHaulSettles = cur.filter(p => p && p.contractId !== row.contractId);
          if (window.Game.requestSave) window.Game.requestSave();
          return;
        }
        if (res && res.terminal) {
          window.Game.state.pendingHaulSettles = cur.filter(p => p && p.contractId !== row.contractId);
          if (window.Game.requestSave) window.Game.requestSave();
        }
      }).catch(() => { this._haulSettleInflight.delete(row.contractId); });
      changed = true;
    }
    if (changed || next.length !== pending.length) {
      s.pendingHaulSettles = next.slice(0, 20);
      if (window.Game.requestSave) window.Game.requestSave();
    }
  },

  tick(now = Date.now()) {
    this.ensure();
    if (!this.auctionsShared()) {
      for (const id of Object.keys(this.auctions)) this._closeAuction(id, now);
    }
    for (const st of this.list()) {
      if (st.status === "refit" && now >= st.refitUntil) st.status = st.ownerId ? "owned" : "npc";
      if (st.status === "cooldown" && now >= st.cooldownUntil) st.status = "npc";
      if (st.hall && st.hall.length) this._expireHall(st, now);
    }
    this.claimHallPayouts();
    this.retryUnclaimed();
  },

  _ledger(st, amount, kind, note) {
    const id = st.systemId;
    if (!this.ledger[id]) this.ledger[id] = [];
    this.ledger[id].unshift({ at: Date.now(), kind, amount, note: note || "" });
    if (this.ledger[id].length > 40) this.ledger[id].length = 40;
  },

  serialize() {
    return {
      byId: this.byId,
      auctions: this.auctions,
      access: this.access,
      ledger: this.ledger,
      lastWarn: this.lastWarn,
      unclaimed: this.unclaimed,
      remoteLeases: this.remoteLeases,
    };
  },

  hydrate(snap) {
    if (!snap || typeof snap !== "object") { this.ensure(); return; }
    this.byId = (snap.byId && typeof snap.byId === "object") ? snap.byId : {};
    this.auctions = (snap.auctions && typeof snap.auctions === "object") ? snap.auctions : {};
    this.access = (snap.access && typeof snap.access === "object") ? snap.access : {};
    this.ledger = (snap.ledger && typeof snap.ledger === "object") ? snap.ledger : {};
    this.lastWarn = (snap.lastWarn && typeof snap.lastWarn === "object") ? snap.lastWarn : {};
    // Items the hall already settled to us that had nowhere to go. They're paid
    // for, so they're rebuilt from the catalogs on load like any other payload —
    // a corrupt entry is dropped, never handed to the inventory as-is.
    this.unclaimed = (Array.isArray(snap.unclaimed) ? snap.unclaimed : [])
      .slice(0, 60)
      .map(e => {
        const kind = e && this.hallKinds.includes(e.kind) ? e.kind : "";
        const payload = kind && this._cleanPayload(kind, e.payload);
        return payload ? { kind, name: this._txt(e.name, 48) || "Listing", payload } : null;
      })
      .filter(Boolean);
    // Extractors we left in someone else's bay. Uids must still exist in our
    // pool; a missing extractor just drops the lease bookkeeping (the server
    // slot is reconciled on the next directory refresh).
    this.remoteLeases = {};
    const rawLeases = (snap.remoteLeases && typeof snap.remoteLeases === "object")
      ? snap.remoteLeases : {};
    for (const [sid, slots] of Object.entries(rawLeases)) {
      if (!sid || typeof slots !== "object" || !slots) continue;
      const clean = {};
      for (const [idx, uid] of Object.entries(slots)) {
        const i = +idx;
        if (!Number.isFinite(i) || i < 0 || i > 11) continue;
        const id = this._txt(uid, 40);
        if (!id) continue;
        clean[i] = id;
      }
      if (Object.keys(clean).length) this.remoteLeases[this._txt(sid, 40)] = clean;
    }
    // Coerce each station at the trust boundary.
    for (const [id, st] of Object.entries(this.byId)) {
      if (!st || typeof st !== "object") { delete this.byId[id]; continue; }
      st.systemId = id;
      st.modules = (st.modules && typeof st.modules === "object") ? st.modules : {};
      st.hold = (st.hold && typeof st.hold === "object") ? st.hold : {};
      st.bays = Array.isArray(st.bays) ? st.bays : [];
      st.hall = Array.isArray(st.hall) ? st.hall : [];
      st.contracts = Array.isArray(st.contracts) ? st.contracts.filter(c => c && c.id && c.commId) : [];
      for (const c of st.contracts) {
        c.qty = Math.max(0, Math.floor(+c.qty || 0));
        c.rate = Math.max(0, Math.floor(+c.rate || 0));
        c.escrow = Math.max(0, Math.floor(+c.escrow || c.qty * c.rate));
        if (!["open", "active"].includes(c.status)) c.status = "open";
      }
      st.contractStats = (st.contractStats && typeof st.contractStats === "object")
        ? { filled: Math.max(0, st.contractStats.filled | 0), expired: Math.max(0, st.contractStats.expired | 0) }
        : { filled: 0, expired: 0 };
      st.impoundHold = (st.impoundHold && typeof st.impoundHold === "object") ? st.impoundHold : {};
      st.impoundClaims = Array.isArray(st.impoundClaims)
        ? st.impoundClaims.filter(c => c && c.id && c.commId && (c.qty | 0) > 0)
        : [];
      st.pendingCargo = (st.pendingCargo && typeof st.pendingCargo === "object") ? st.pendingCargo : {};
      st.pendingPayouts = (st.pendingPayouts && typeof st.pendingPayouts === "object") ? st.pendingPayouts : {};
      st.reactorLevel = Util.clamp(st.reactorLevel | 0, 0, 5);
      this.syncBays(st);
      st.standing = Util.clamp(+st.standing || STATIONCFG.standingStart, 0, 100);
      st.treasury = Math.max(0, Math.floor(+st.treasury || 0));
      st.leaseTaxBps = Util.clamp(st.leaseTaxBps | 0, 0, 4000);
      st.saleTariffBps = Util.clamp(st.saleTariffBps | 0, 0, 1500);
      st.scrutiny = Util.clamp(st.scrutiny | 0, 0, 100);
      if (!["npc", "owned", "refit", "cooldown"].includes(st.status)) st.status = st.ownerId ? "owned" : "npc";
      // Timers are the only thing standing between an owner and their station —
      // a NaN or a far-future value from a corrupt save must never strand them.
      const now = Date.now();
      st.refitUntil = Math.min(Math.max(0, +st.refitUntil || 0), now + STATIONCFG.refitMs);
      st.cooldownUntil = Math.min(Math.max(0, +st.cooldownUntil || 0), now + STATIONCFG.cooldownMs);
      if (st.status === "refit" && now >= st.refitUntil) st.status = st.ownerId ? "owned" : "npc";
      if (st.status === "cooldown" && now >= st.cooldownUntil) st.status = "npc";
    }
    this.ensure();
  },
};

window.Stations = Stations;
