/* fleet.js — the fleet of persistent ships. Ships have combat stats (hull,
   armor, shields, firepower) plus cargo and speed, modified by equipped
   accessories and the main ship's passive bonus. Cargo runs are gone; ships now
   fly Bazaar contracts (see missions.js). The main/flagship sets sector-docking
   speed.                                                                       */

const Fleet = {
  s() { return window.Game.state; },

  shipDef(typeId) { return ALL_SHIPS.find(x => x.id === typeId); },
  mainDef() { return SHIP_CATALOG.main.find(x => x.id === this.s().mainShip.type) || SHIP_CATALOG.main[0]; },

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

  ship(uid) { return this.s().ships.find(x => x.uid === uid); },
  idle() { return this.s().ships.filter(sh => sh.status === "idle"); },

  // Effective stats = base × (1 + Σ pct buffs) + Σ flat buffs, incl. accessories
  // and the main ship's passive.
  stats(ship) {
    const def = this.shipDef(ship.type);
    const out = { cargo: def.cargo || 0, firepower: def.firepower || 0, hull: def.hull || 0,
      armor: def.armor || 0, shields: def.shields || 0, speed: def.speed || 1, slots: def.slots || 2 };
    const flat = {}, pct = {};
    for (const uid of ship.accessories || []) {
      const it = this.s().items[uid]; if (!it) continue;
      for (const st of [it.primary, it.bonus]) {
        if (!st) continue;
        if (st.pct) pct[st.stat] = (pct[st.stat] || 0) + st.amount;
        else flat[st.stat] = (flat[st.stat] || 0) + st.amount;
      }
    }
    const mp = this.mainDef().passive;
    if (mp) {
      const apply = mp.stat === "all" ? ["firepower", "speed", "hull", "armor", "shields"] : [mp.stat];
      for (const k of apply) pct[k] = (pct[k] || 0) + mp.pct;
    }
    for (const k of Object.keys(out)) {
      if (k === "slots") continue;
      out[k] = (out[k] + (flat[k] || 0)) * (1 + (pct[k] || 0));
    }
    for (const k of ["firepower", "hull", "armor", "shields", "cargo"]) out[k] = Math.round(out[k]);
    out.speed = +out.speed.toFixed(2);
    return out;
  },

  power(uids) { return uids.reduce((n, uid) => { const sh = this.ship(uid); return n + (sh ? this.stats(sh).firepower : 0); }, 0); },
  cargoCap(uids) { return uids.reduce((n, uid) => { const sh = this.ship(uid); return n + (sh ? this.stats(sh).cargo : 0); }, 0); },
  avgSpeed(uids) {
    if (!uids.length) return 1;
    return uids.reduce((n, uid) => { const sh = this.ship(uid); return n + (sh ? this.stats(sh).speed : 1); }, 0) / uids.length;
  },

  // Sector docking time (ms), driven by the main ship's travelSpeed.
  dockTravelMs(fromId, toId) {
    const a = SYSTEMS.find(s => s.id === fromId), b = SYSTEMS.find(s => s.id === toId);
    const dist = Math.max(1, Math.abs((a?.distance ?? 0) - (b?.distance ?? 0)));
    const speed = this.mainDef().travelSpeed || 1;
    const seconds = (dist * 12) / speed;
    return (seconds * 1000) / (window.Game.timeScale || 1);
  },

  // ---- accessories --------------------------------------------------------
  equip(shipUid, itemUid) {
    const sh = this.ship(shipUid); const it = this.s().items[itemUid];
    if (!sh || !it) return { ok: false, msg: "Not found." };
    if (sh.status !== "idle") return { ok: false, msg: "Ship is busy." };
    const slots = this.shipDef(sh.type).slots || 2;
    if ((sh.accessories || []).length >= slots) return { ok: false, msg: "No free slots." };
    // remove from any listing / other ship first (caller ensures it's in inventory)
    sh.accessories = sh.accessories || [];
    sh.accessories.push(itemUid);
    return { ok: true };
  },
  unequip(shipUid, itemUid) {
    const sh = this.ship(shipUid); if (!sh) return { ok: false };
    sh.accessories = (sh.accessories || []).filter(u => u !== itemUid);
    return { ok: true };
  },

  // ---- impound retrieval --------------------------------------------------
  retrieve(uid) {
    const sh = this.ship(uid);
    if (!sh || sh.status !== "impounded") return { ok: false, msg: "Nothing to retrieve." };
    if ((sh.retrieveCost || 0) > this.s().credits) return { ok: false, msg: "Not enough credits." };
    this.s().credits -= sh.retrieveCost;
    sh.status = "idle"; sh.retrieveCost = 0;
    Economy.refreshNetWorth();
    return { ok: true };
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
