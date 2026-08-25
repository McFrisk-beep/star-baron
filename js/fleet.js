/* fleet.js — the fleet of persistent ships. Ships have combat stats (hull,
   armor, shields, firepower) plus cargo and speed, modified by equipped
   accessories and the main ship's passive bonus. Cargo runs are gone; ships now
   fly Bazaar contracts (see missions.js). The main/flagship sets sector-docking
   speed.                                                                       */

const Fleet = {
  s() { return window.Game.state; },

  shipDef(typeId) { return ALL_SHIPS.find(x => x.id === typeId); },
  mainDef() { return SHIP_CATALOG.main.find(x => x.id === this.s().mainShip.type) || SHIP_CATALOG.main[0]; },

  // Normalize flagship bonuses: prefer effects[]; fall back to legacy {stat,pct}.
  mainEffects() {
    const d = this.mainDef(); if (!d) return [];
    if (Array.isArray(d.effects) && d.effects.length) return d.effects;
    if (d.passive) return [{ type: d.passive.stat, pct: d.passive.pct }];
    return [];
  },
  mainBonus(type) {
    let n = 0;
    for (const e of this.mainEffects()) {
      if (e.type === type) n += e.pct || 0;
      else if (e.type === "all" && ["firepower", "speed", "hull", "armor", "shields", "cargo"].includes(type)) n += e.pct || 0;
    }
    return n;
  },
  mainEffectsLabel() {
    return this.mainEffects().map(e => {
      const meta = (window.FLAGSHIP_EFFECTS && FLAGSHIP_EFFECTS[e.type]) || { label: e.type };
      return `+${Math.round((e.pct || 0) * 100)}% ${meta.label}`;
    }).join(" · ") || "—";
  },

  // Server stubs: catalog name ("Battleship"), initcap(type), or "Battleship Merc 0".
  isStubName(sh) {
    if (!sh || !sh.name) return true;
    const def = this.shipDef(sh.type);
    if (def && sh.name === def.name) return true;
    const t = String(sh.type || "");
    if (sh.name === t.charAt(0).toUpperCase() + t.slice(1)) return true;
    if (/ Merc \d+$/.test(sh.name)) return true;
    return false;
  },
  // `state` is passed by Economy.repairCosmeticNames during Game.migrate, when
  // window.Game.state isn't assigned yet — don't drop it, or a yard ship's name
  // is re-rolled on the very reload it needs to survive.
  nameFromUid(uid, type, mercenary, state) {
    // A ship bought off the shipyard shelf came with a name; keep it. The server
    // stamps a stub ("Battleship") on the row, so without this the hull the
    // player picked out by name is re-rolled into a random one on every reload.
    const st = state || (window.Game && window.Game.state) || null;
    const bought = uid && st && ((st.shipVariants || {})[uid] || {}).name;
    if (bought && !mercenary) return bought;
    const a = window.SHIP_NAME_A || ["Iron"], b = window.SHIP_NAME_B || ["Widow"];
    const mp = window.MERC_PREFIX || ["Red"], mu = window.MERC_UNIT || ["Talons"];
    let h = 2166136261; const s = String(uid || type || "ship");
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h >>>= 0;
    if (mercenary) return `${mp[h % mp.length]} ${mu[(h >>> 7) % mu.length]}`;
    return `${a[h % a.length]} ${b[(h >>> 7) % b.length]}`;
  },

  // Build a fresh owned-ship instance from a catalog id.
  makeShip(catalogId, opts = {}) {
    const def = this.shipDef(catalogId);
    return {
      uid: "s" + (++this.s().seq),
      type: catalogId, cls: def.cls,
      name: opts.name || `${Util.pick(SHIP_NAME_A)} ${Util.pick(SHIP_NAME_B)}`,
      status: "idle", accessories: [],
      mercenary: !!opts.mercenary, expiresAt: opts.expiresAt || null, retrieveCost: 0,
    };
  },

  // ---- yard refits (variants) --------------------------------------------
  // A ship bought from the Bazaar shipyard is a specific refitted hull, not a
  // bare catalog entry. The refit lives in state.shipVariants[uid] rather than
  // on the ship object because `ships` is SERVER-owned: app_commit rebuilds the
  // array from the players row, so anything stamped onto a ship here is gone by
  // the next autosave (the same trap that broke repair). shipVariants is a key
  // app_commit doesn't touch, so it rides through untouched and comes back from
  // app_bootstrap.
  //
  // ponytail: that also makes it client-trusted — a tampered save could claim a
  // better refit. Bounded on purpose (every variant trades one stat for another,
  // and Game.migrate drops unknown ids), so the ceiling is "best trade-off on
  // every hull", not free stats. Move it onto the ship row in app_buy_ship if
  // the yard ever sells refits at a premium.
  variantDef(id) { return (window.SHIP_VARIANTS || []).find(v => v.id === id) || null; },
  variantFor(ship) {
    if (!ship) return null;
    const rec = (this.s().shipVariants || {})[ship.uid];
    return rec ? this.variantDef(rec.v) : null;
  },
  // Variants only ever apply to hulls whose class they were written for.
  variantsFor(cls) {
    return (window.SHIP_VARIANTS || []).filter(v => !v.cls || v.cls.includes(cls));
  },
  // "Wide-Belly" → shown next to the hull name. Empty for a stock hull.
  variantLabel(ship) {
    const v = this.variantFor(ship);
    return v && v.id !== "stock" ? v.name : "";
  },
  // "+30% cargo · −15% speed" — the refit's trade, for the card.
  variantEffects(variant) {
    if (!variant) return "";
    return Object.entries(variant.mods || {})
      .map(([k, p]) => `${p >= 0 ? "+" : "−"}${Math.round(Math.abs(p) * 100)}% ${k}`)
      .join(" · ") || "baseline hull";
  },
  // Record the refit (and the yard's name) against a ship the player just bought.
  setVariant(uid, variantId, name) {
    const s = this.s();
    if (!uid || !this.variantDef(variantId)) return;
    s.shipVariants = s.shipVariants || {};
    s.shipVariants[uid] = name ? { v: variantId, name } : { v: variantId };
  },
  // Drop entries for ships that no longer exist, so the map can't grow forever
  // across sells / prestige resets.
  pruneVariants() {
    const s = this.s(), map = s.shipVariants;
    if (!map) return;
    const live = new Set((s.ships || []).map(sh => sh.uid));
    for (const uid of Object.keys(map)) if (!live.has(uid)) delete map[uid];
  },

  ship(uid) { return this.s().ships.find(x => x.uid === uid); },
  idle() { return this.s().ships.filter(sh => sh.status === "idle"); },

  // Effective stats = base × (1 + Σ pct buffs) + Σ flat buffs, incl. accessories
  // and the main ship's combat-relevant effects. scan/endure feed survey odds.
  stats(ship) {
    const def = this.shipDef(ship.type) || {};
    const out = { cargo: def.cargo || 0, firepower: def.firepower || 0, hull: def.hull || 0,
      armor: def.armor || 0, shields: def.shields || 0, speed: def.speed || 1, slots: def.slots || 2,
      scan: def.scan || 0, endure: def.endure || 0, mine: def.mine || 0 };
    if (def.cls === "survey") out.scan += 1; // survey hulls always read a little clearer
    const flat = {}, pct = {};
    // The yard refit is just another percentage source, summed with accessory and
    // flagship percentages — so a −15% speed refit and a +8% engine net out to
    // −7%, which is what the Bazaar card previews and what players expect.
    const variant = this.variantFor(ship);
    if (variant) for (const [k, p] of Object.entries(variant.mods || {})) pct[k] = (pct[k] || 0) + p;
    for (const uid of ship.accessories || []) {
      const it = this.s().items[uid]; if (!it) continue;
      for (const st of [it.primary, it.bonus]) {
        if (!st) continue;
        if (st.pct) pct[st.stat] = (pct[st.stat] || 0) + st.amount;
        else flat[st.stat] = (flat[st.stat] || 0) + st.amount;
      }
    }
    for (const e of this.mainEffects()) {
      const apply = e.type === "all" ? ["firepower", "speed", "hull", "armor", "shields", "cargo"]
        : ["firepower", "speed", "hull", "armor", "shields", "cargo"].includes(e.type) ? [e.type] : [];
      for (const k of apply) pct[k] = (pct[k] || 0) + (e.pct || 0);
      if (e.type === "survey") flat.scan = (flat.scan || 0) + (e.pct || 0) * 10;
    }
    for (const k of Object.keys(out)) {
      if (k === "slots") continue;
      out[k] = (out[k] + (flat[k] || 0)) * (1 + (pct[k] || 0));
    }
    // battle damage: hull drops with it, and a battered ship fights & flies worse
    const dmg = ship.dmg || 0;
    if (dmg) {
      out.hull *= 1 - dmg;
      out.firepower *= 1 - dmg * DMGCFG.statPenalty;
      out.speed *= 1 - dmg * DMGCFG.statPenalty;
      out.scan *= 1 - dmg * DMGCFG.statPenalty * 0.5;
      out.mine *= 1 - dmg * DMGCFG.statPenalty * 0.5;
    }
    for (const k of ["firepower", "hull", "armor", "shields", "cargo"]) out[k] = Math.round(out[k]);
    out.speed = +out.speed.toFixed(2);
    out.scan = +out.scan.toFixed(1);
    out.endure = +out.endure.toFixed(1);
    out.mine = +out.mine.toFixed(1);
    return out;
  },

  // ---- battle damage & repairs -------------------------------------------
  addDamage(ship, frac) { ship.dmg = Util.clamp((ship.dmg || 0) + frac, 0, DMGCFG.maxDmg); },
  repairCost(ship) {
    const dmg = ship.dmg || 0;
    // `|| {}` — an admin SHIP_CATALOG override can drop a hull id out from under
    // a save; a throw here takes the whole Fleet render with it (Fleet.stats does
    // the same).
    return dmg ? Math.max(50, Math.round(((this.shipDef(ship.type) || {}).price || 2000) * DMGCFG.costRate * dmg)) : 0;
  },
  // Repairing must go through app_repair_ship when the server owns the fleet.
  // A purely local repair is undone on the next autosave: app_commit rebuilds
  // every ship from the server row (app._merge_ships keeps the server's `dmg`)
  // while accepting the lower client credits — so the player paid the bill and
  // kept the damage. Don't put this back on the local-only path.
  _repairLocal(uid) {
    const sh = this.ship(uid);
    if (!sh || !(sh.dmg > 0)) return { ok: false, msg: "Nothing to repair." };
    if (sh.status !== "idle") return { ok: false, msg: "Ship is busy — repairs need a drydock." };
    const cost = this.repairCost(sh);
    if (cost > this.s().credits) return { ok: false, msg: "Not enough credits." };
    this.s().credits -= cost;
    sh.dmg = 0;
    Economy.refreshNetWorth();
    return { ok: true, cost };
  },
  repair(uid) {
    if (!(window.Cloud && Cloud.shipRpcReady("app_repair_ship"))) return this._repairLocal(uid);
    return Economy._withRpc(
      () => this._repairLocal(uid),
      // null = the RPC isn't installed on this project; keep the optimistic
      // local repair rather than rolling it back into a scary error toast.
      async () => (await Cloud.repairShip(uid)) || { ok: true },
      "Couldn't reach the drydock — try again."
    );
  },

  power(uids) { return uids.reduce((n, uid) => { const sh = this.ship(uid); return n + (sh ? this.stats(sh).firepower : 0); }, 0); },
  cargoCap(uids) { return uids.reduce((n, uid) => { const sh = this.ship(uid); return n + (sh ? this.stats(sh).cargo : 0); }, 0); },
  avgSpeed(uids) {
    if (!uids.length) return 1;
    return uids.reduce((n, uid) => { const sh = this.ship(uid); return n + (sh ? this.stats(sh).speed : 1); }, 0) / uids.length;
  },

  // Sector docking time (ms), driven by the main ship's travelSpeed.
  dockTravelMs(fromId, toId) {
    // Capitals keep SYSTEMS.distance; claimable stations use galaxy map distance.
    const a = SYSTEMS.find(s => s.id === fromId), b = SYSTEMS.find(s => s.id === toId);
    let dist, k;
    if (a && b) {
      dist = Math.max(1, Math.abs((a.distance ?? 0) - (b.distance ?? 0)));
      k = (window.MARKETCFG ? MARKETCFG.dockK : 12);
    } else if (window.Galaxy) {
      const ga = Galaxy.get(fromId), gb = Galaxy.get(toId);
      if (ga && gb && ga.pos && gb.pos) {
        // Route length through the lane graph (LIVING_GALAXY.md §2.5); straight
        // hypot stays as the fallback if lanes are unavailable.
        const lane = window.Lanes && Lanes.routeLength(fromId, toId);
        dist = Math.max(0.08, lane || Math.hypot(ga.pos.x - gb.pos.x, ga.pos.y - gb.pos.y));
        k = (window.STATIONCFG && STATIONCFG.dockMapK) || 22;
      } else {
        dist = 1; k = window.MARKETCFG ? MARKETCFG.dockK : 12;
      }
    } else {
      dist = 1; k = window.MARKETCFG ? MARKETCFG.dockK : 12;
    }
    const speed = (this.mainDef().travelSpeed || 1) * (window.Senate ? Senate.travelSpeedMult() : 1);
    const seconds = (dist * k) / speed;
    // Deliberate pacing (LIVING_GALAXY.md step 3): every hyperspace hop adds a
    // ~5s gate dwell (spool + drop-out), so multi-lane routes read as journeys.
    // Client-computed ETAs only — a server-stamped ETA wins unchanged.
    const route = window.Lanes ? Lanes.route(fromId, toId) : null;
    const hops = route ? Math.max(1, route.path.length - 1) : 1;
    return (seconds * 1000 + hops * 5000) / (window.Game.timeScale || 1);
  },

  // ---- accessories --------------------------------------------------------
  // Like repair, fitment is server business: app_commit rebuilds ships from the
  // server row and app._merge_ships only re-accepts accessory uids the SERVER's
  // items pool knows, so a local-only equip (e.g. gear crafted while the craft
  // RPCs were missing) is dropped on the next autosave. app_equip_item writes it
  // authoritatively and returns a real error instead of a silent revert.
  _equipLocal(shipUid, itemUid) {
    const sh = this.ship(shipUid); const it = this.s().items[itemUid];
    if (!sh || !it) return { ok: false, msg: "Not found." };
    if (window.Items && Items.isBlackbox(it)) return { ok: false, msg: "Blackboxes are used from Inventory, not equipped." };
    if (sh.status !== "idle") return { ok: false, msg: "Ship is busy." };
    const slots = (this.shipDef(sh.type) || {}).slots || 2;
    if ((sh.accessories || []).length >= slots) return { ok: false, msg: "No free slots." };
    // Pull gear out of the hold/bay so slots free up (HAULING.md).
    if (window.Assets) {
      const loc = Assets.gearLocation(itemUid);
      if (!loc) return { ok: false, msg: "Item isn't in your hold or this bay." };
      const s = this.s();
      if (loc !== "hold" && (s.travel || loc !== s.currentSystem))
        return { ok: false, msg: "Dock where the item is stored to equip it." };
      Assets.withdraw(loc === "hold" ? "hold" : loc, "gear", itemUid);
    }
    sh.accessories = sh.accessories || [];
    sh.accessories.push(itemUid);
    return { ok: true };
  },
  equip(shipUid, itemUid) {
    if (!(window.Cloud && Cloud.shipRpcReady("app_equip_item"))) return this._equipLocal(shipUid, itemUid);
    return Economy._withRpc(
      () => this._equipLocal(shipUid, itemUid),
      async () => (await Cloud.equipItem(shipUid, itemUid)) || { ok: true },
      "Couldn't reach the fitting bay — try again."
    );
  },
  _unequipLocal(shipUid, itemUid) {
    const sh = this.ship(shipUid); if (!sh) return { ok: false };
    // The release fee is half of hull + fitted gear, so stripping a hull in the
    // lot would dodge most of the fine. Server enforces the same gate.
    if (sh.status === "impounded") return { ok: false, msg: "The impound lot holds the whole vessel — gear included." };
    sh.accessories = (sh.accessories || []).filter(u => u !== itemUid);
    // Park back into the docked bay (or hold if traveling).
    if (window.Assets) Assets.parkGear(itemUid, this.s().currentSystem);
    return { ok: true };
  },
  unequip(shipUid, itemUid) {
    if (!(window.Cloud && Cloud.shipRpcReady("app_unequip_item"))) return this._unequipLocal(shipUid, itemUid);
    return Economy._withRpc(
      () => this._unequipLocal(shipUid, itemUid),
      async () => (await Cloud.unequipItem(shipUid, itemUid)) || { ok: true },
      "Couldn't reach the fitting bay — try again."
    );
  },

  // ---- impound retrieval --------------------------------------------------
  // Retrieving must go through app_retrieve_ship when the server owns the fleet.
  // A purely local retrieve is undone on the next autosave: app_commit rebuilds
  // ships from the server row, so the hull re-shows as impounded while the credit
  // spend sticks — pay the fine forever, hull stranded (Critical C3). Same trap
  // that broke repair; retrieve just never got its RPC.
  //
  // Release fee: half the vessel's value — hull price plus everything bolted to
  // it — floored at 600c. Mirrors app._impound_fine (docs/sql/impound_retrieve.sql);
  // the server recomputes it, this is the card display + guest fallback. Any
  // retrieveCost stamped on the row by older impound paths is display-legacy.
  impoundFine(sh) {
    const price = (this.shipDef(sh.type) || {}).price || 0;
    let gear = 0;
    for (const uid of sh.accessories || []) gear += (this.s().items[uid] || {}).value || 0;
    return Math.max(600, Math.round(0.5 * (price + gear)));
  },
  // "Impounded by … for …" — deterministic per hull so the notice doesn't
  // reshuffle every render. Pure flavor; the fine is impoundFine().
  impoundNotice(sh) {
    const agencies = [
      "the Navos Customs Directorate", "the Harbormaster-General's Office",
      "the Free-Trade League's Lane Authority", "Mining Combine Tariff Enforcement",
      "the Agri-Collective Quarantine Bureau", "the Capital Transit Tribunal",
    ];
    const violations = [
      "unlicensed contraband transit", "falsified cargo manifests",
      "smuggling through a sanctioned lane", "unpaid docking levies",
      "operating without a transit charter", "violations of the Senate trade edicts",
    ];
    let h = 2166136261; const s = String(sh.uid || sh.type || "ship");
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h >>>= 0;
    return `This vessel has been impounded by ${agencies[h % agencies.length]} for ${violations[(h >>> 7) % violations.length]}.`;
  },
  _retrieveLocal(uid) {
    const sh = this.ship(uid);
    if (!sh || sh.status !== "impounded") return { ok: false, msg: "Nothing to retrieve." };
    const cost = this.impoundFine(sh);
    if (cost > this.s().credits) return { ok: false, msg: "Not enough credits." };
    this.s().credits -= cost;
    sh.status = "idle"; sh.retrieveCost = 0;
    Economy.refreshNetWorth();
    return { ok: true, cost };
  },
  retrieve(uid) {
    if (!(window.Cloud && Cloud.shipRpcReady("app_retrieve_ship"))) return this._retrieveLocal(uid);
    return Economy._withRpc(
      () => this._retrieveLocal(uid),
      // null = the RPC isn't installed on this project; keep the optimistic local
      // retrieve rather than rolling it back into a scary error toast.
      async () => (await Cloud.retrieveShip(uid)) || { ok: true },
      "Couldn't reach the impound lot — try again."
    );
  },

  // Walk away instead of paying: the hull — and its fitted gear, the lot holds
  // the whole vessel — is forfeit, forever. Server path: app_abandon_ship.
  _abandonLocal(uid) {
    const s = this.s();
    const sh = this.ship(uid);
    if (!sh || sh.status !== "impounded") return { ok: false, msg: "Only an impounded ship can be abandoned." };
    for (const u of sh.accessories || []) delete s.items[u];
    s.ships = s.ships.filter(x => x.uid !== uid);
    this.pruneVariants();
    Economy.refreshNetWorth();
    return { ok: true, name: sh.name };
  },
  abandon(uid) {
    if (!(window.Cloud && Cloud.shipRpcReady("app_abandon_ship"))) return this._abandonLocal(uid);
    return Economy._withRpc(
      () => this._abandonLocal(uid),
      async () => (await Cloud.abandonShip(uid)) || { ok: true },
      "Couldn't reach the impound lot — try again."
    );
  },

  // Prune expired mercenaries (called by the game loop).
  pruneMercs(now) {
    const s = this.s();
    const expired = s.ships.filter(sh => sh.mercenary && sh.status === "idle" && sh.expiresAt && sh.expiresAt <= now);
    if (!expired.length) return [];
    s.ships = s.ships.filter(sh => !expired.includes(sh));
    for (const sh of expired) for (const u of sh.accessories || []) { /* gear returns to inventory automatically (loc derived) */ }
    return expired;
  },

  // Sum value of the fleet + main ship (for net worth).
  fleetValue() {
    let v = (this.mainDef().price || 0);
    for (const sh of this.s().ships) {
      if (sh.mercenary) continue;            // mercs are rented, not owned wealth
      const def = this.shipDef(sh.type);
      if (def) v += def.price;
    }
    return v;
  },
};

window.Fleet = Fleet;
