/* assets.js — location-aware cargo ledger (docs/HAULING.md).
   Goods sit in the flagship hold, a per-station bay, or a Courier shipment.
   state.positions stays the derived total (server trade RPCs still own it).

   Invariant: positions[c] == hold.blocks[c] + Σ stationInv[*].blocks[c]
                                + Σ shipments[*].blocks[c]

   ponytail: station bays ride in the save blob for v1 (HAULING §7 fallback).
   Split into public.station_inv when real save size bites.                   */

const Assets = {
  s() { return window.Game.state; },

  emptyBag() { return { blocks: {}, gear: [] }; },
  _bag(bag) {
    if (!bag || typeof bag !== "object") return this.emptyBag();
    if (!bag.blocks || typeof bag.blocks !== "object") bag.blocks = {};
    if (!Array.isArray(bag.gear)) bag.gear = [];
    return bag;
  },

  hold() {
    const s = this.s();
    s.hold = this._bag(s.hold);
    return s.hold;
  },
  bay(systemId) {
    const s = this.s();
    if (!systemId) return this.emptyBag();
    s.stationInv = s.stationInv || {};
    return (s.stationInv[systemId] = this._bag(s.stationInv[systemId]));
  },
  // Drop empty bay rows so the blob stays lean.
  pruneBay(systemId) {
    const s = this.s();
    if (!s.stationInv || !s.stationInv[systemId]) return;
    const b = this._bag(s.stationInv[systemId]);
    const empty = !b.gear.length && !Object.values(b.blocks).some(q => q > 0);
    if (empty) delete s.stationInv[systemId];
  },

  blockSize(commId) {
    const c = (typeof COMMODITIES !== "undefined" ? COMMODITIES : []).find(x => x.id === commId);
    const rar = (c && c.rarity) || "common";
    const cfg = (typeof BLOCKCFG !== "undefined" && BLOCKCFG.byRarity) || {};
    return cfg[rar] || cfg.common || 5000;
  },
  blockSlots(qty, commId) {
    qty = Math.max(0, Math.floor(+qty || 0));
    if (!qty) return 0;
    return Math.ceil(qty / this.blockSize(commId));
  },
  slotsUsed(bag) {
    bag = this._bag(bag);
    let n = bag.gear.length;
    for (const [id, q] of Object.entries(bag.blocks)) n += this.blockSlots(q, id);
    return n;
  },

  // Flagship hold capacity from the hull's new cargo stat + cargo% effects.
  holdCapacity() {
    if (!window.Fleet) return 4;
    const def = Fleet.mainDef() || {};
    const base = Math.max(0, def.cargo | 0) || 4;
    return Math.max(0, Math.floor(base * (1 + (Fleet.mainBonus("cargo") || 0))));
  },
  // Station bay capacity = Inventory Bay upgrade (BAZAARCFG), base STATION_BAY_BASE.
  // Defensive Math.max against a server slice that rewrote inventory.capacity
  // without the hauling floor — ensureBayCapacity at boot is belt-and-braces.
  bayCapacity(systemId) {
    const s = this.s();
    const cap = Math.max(0, (s.inventory && s.inventory.capacity) | 0);
    return Math.max(cap, this.bayCapacityFloor(s));
  },
  holdFree() { return this.holdCapacity() - this.slotsUsed(this.hold()); },
  bayFree(systemId) { return this.bayCapacity(systemId) - this.slotsUsed(this.bay(systemId)); },
  // Overfull is allowed after migration / downsizing — block new deposits only.
  canFit(bag, kind, id, qty, capacity) {
    const used = this.slotsUsed(bag);
    if (used > capacity) return false; // already overfull
    if (kind === "gear") return used + 1 <= capacity;
    const before = this.blockSlots(bag.blocks[id] || 0, id);
    const after = this.blockSlots((bag.blocks[id] || 0) + qty, id);
    return used + (after - before) <= capacity;
  },

  // ---- ledger totals ------------------------------------------------------
  ledgerQty(commId) {
    let n = this.hold().blocks[commId] || 0;
    const inv = this.s().stationInv || {};
    for (const sys of Object.keys(inv)) n += (inv[sys].blocks && inv[sys].blocks[commId]) || 0;
    for (const sh of (this.s().shipments || [])) {
      if (sh.resolved) continue;
      n += (sh.blocks && sh.blocks[commId]) || 0;
    }
    return n;
  },
  bayQty(systemId, commId) { return (this.bay(systemId).blocks[commId] || 0); },
  holdQty(commId) { return this.hold().blocks[commId] || 0; },

  // Recompute positions from the location ledger (source of truth after local mutations).
  reconcile() {
    const s = this.s();
    if (!s.positions || typeof s.positions !== "object") s.positions = {};
    const next = {};
    const bump = (id, q) => { if (q > 0) next[id] = (next[id] || 0) + q; };
    for (const [id, q] of Object.entries(this.hold().blocks)) bump(id, q);
    for (const bag of Object.values(s.stationInv || {})) {
      for (const [id, q] of Object.entries((bag && bag.blocks) || {})) bump(id, q);
    }
    for (const sh of (s.shipments || [])) {
      if (sh.resolved) continue;
      for (const [id, q] of Object.entries(sh.blocks || {})) bump(id, q);
    }
    // Preserve zeroed keys the UI may still read; drop ghosts with no ledger home.
    for (const id of Object.keys(s.positions)) if (!(id in next)) s.positions[id] = 0;
    for (const [id, q] of Object.entries(next)) s.positions[id] = q;
    return s.positions;
  },

  // Trust positions as the total (server slice / old save) and push the delta
  // into the bay at currentSystem. Goods never vanish.
  reconcileFromPositions(systemId) {
    const s = this.s();
    const dest = systemId || s.currentSystem || "navos";
    const bay = this.bay(dest);
    const ids = new Set([
      ...Object.keys(s.positions || {}),
      ...Object.keys(this.hold().blocks),
      ...Object.keys(bay.blocks),
    ]);
    for (const bag of Object.values(s.stationInv || {}))
      for (const id of Object.keys((bag && bag.blocks) || {})) ids.add(id);
    for (const sh of (s.shipments || []))
      if (!sh.resolved) for (const id of Object.keys(sh.blocks || {})) ids.add(id);

    for (const id of ids) {
      const want = Math.max(0, Math.floor(+(s.positions || {})[id] || 0));
      const have = this.ledgerQty(id);
      const delta = want - have;
      if (delta > 0) {
        bay.blocks[id] = (bay.blocks[id] || 0) + delta;
      } else if (delta < 0) {
        // Trim from dest bay first, then other bays, then hold, then shipments.
        let need = -delta;
        need = this._trimBlock(bay, id, need);
        if (need > 0) for (const sys of Object.keys(s.stationInv || {})) {
          if (sys === dest) continue;
          need = this._trimBlock(this.bay(sys), id, need);
          if (need <= 0) break;
        }
        if (need > 0) need = this._trimBlock(this.hold(), id, need);
        // Shipments: leave in flight — positions will re-sync on arrival.
      }
    }
    this.reconcile();
  },
  _trimBlock(bag, id, need) {
    const have = bag.blocks[id] || 0;
    const take = Math.min(have, need);
    if (take > 0) {
      bag.blocks[id] = have - take;
      if (bag.blocks[id] <= 0) delete bag.blocks[id];
    }
    return need - take;
  },

  // ---- deposit / withdraw -------------------------------------------------
  // where: null|"hold" → flagship; systemId → that station bay.
  // opts.force skips capacity (spill / migration). opts.skipPositions leaves
  // positions alone (caller already mutated them — e.g. Economy._buyLocal).
  deposit(where, kind, id, qty, opts = {}) {
    qty = Math.floor(+qty || 0);
    if (qty <= 0 && kind === "block") return { ok: false, msg: "Nothing to deposit." };
    const hold = where == null || where === "hold";
    const bag = hold ? this.hold() : this.bay(where);
    const cap = hold ? this.holdCapacity() : this.bayCapacity(where);
    if (kind === "gear") {
      if (!id) return { ok: false, msg: "No item." };
      if (bag.gear.includes(id)) return { ok: true };
      if (!opts.force && !this.canFit(bag, "gear", id, 1, cap))
        return { ok: false, msg: hold ? "Flagship hold is full." : "Station bay is full." };
      bag.gear.push(id);
      return { ok: true };
    }
    if (kind !== "block") return { ok: false, msg: "Unknown kind." };
    if (!opts.force && !this.canFit(bag, "block", id, qty, cap))
      return { ok: false, msg: hold ? "Flagship hold is full." : "Station bay is full." };
    bag.blocks[id] = (bag.blocks[id] || 0) + qty;
    if (!opts.skipPositions) {
      const s = this.s();
      s.positions[id] = (s.positions[id] || 0) + qty;
    } else {
      this.reconcile();
    }
    return { ok: true, qty };
  },

  withdraw(where, kind, id, qty, opts = {}) {
    qty = Math.floor(+qty || 0);
    const hold = where == null || where === "hold";
    const bag = hold ? this.hold() : this.bay(where);
    if (kind === "gear") {
      const i = bag.gear.indexOf(id);
      if (i < 0) return { ok: false, msg: "Item not here." };
      bag.gear.splice(i, 1);
      if (!hold) this.pruneBay(where);
      return { ok: true };
    }
    if (kind !== "block") return { ok: false, msg: "Unknown kind." };
    const have = bag.blocks[id] || 0;
    const take = Math.min(have, Math.max(0, qty));
    if (take <= 0) return { ok: false, msg: "Nothing to withdraw." };
    bag.blocks[id] = have - take;
    if (bag.blocks[id] <= 0) delete bag.blocks[id];
    if (!hold) this.pruneBay(where);
    if (!opts.skipPositions) {
      const s = this.s();
      s.positions[id] = Math.max(0, (s.positions[id] || 0) - take);
      if (s.positions[id] <= 0) { s.positions[id] = 0; if (s.avgCost) s.avgCost[id] = 0; }
    } else {
      this.reconcile();
    }
    return { ok: true, qty: take };
  },

  // Move between hold and a station bay (or reverse).
  transfer(from, to, kind, id, qty) {
    if (from === to) return { ok: false, msg: "Same place." };
    if (kind === "gear") {
      const w = this.withdraw(from, "gear", id);
      if (!w.ok) return w;
      const d = this.deposit(to, "gear", id);
      if (!d.ok) { this.deposit(from, "gear", id, 1, { force: true }); return d; }
      return { ok: true };
    }
    const w = this.withdraw(from, "block", id, qty, { skipPositions: true });
    if (!w.ok) return w;
    const d = this.deposit(to, "block", id, w.qty, { skipPositions: true });
    if (!d.ok) {
      this.deposit(from, "block", id, w.qty, { force: true, skipPositions: true });
      return d;
    }
    this.reconcile();
    return { ok: true, qty: w.qty };
  },

  // Deposit commodity that was already added to positions (buy / industry mint).
  parkBlocks(systemId, commId, qty) {
    return this.deposit(systemId, "block", commId, qty, { skipPositions: true, force: true });
  },
  // Remove from a bay after positions were already decremented (sell / consume).
  unparkBlocks(systemId, commId, qty) {
    return this.withdraw(systemId, "block", commId, qty, { skipPositions: true });
  },

  // Gear helpers — unequipped items live in hold or a bay.
  gearLocation(uid) {
    if (this.hold().gear.includes(uid)) return "hold";
    for (const sys of Object.keys(this.s().stationInv || {})) {
      if (this.bay(sys).gear.includes(uid)) return sys;
    }
    return null;
  },
  // Items available to equip / use right now (hold + docked bay).
  localGear() {
    const s = this.s();
    const uids = new Set(this.hold().gear);
    if (!s.travel && s.currentSystem) for (const u of this.bay(s.currentSystem).gear) uids.add(u);
    return [...uids].map(u => s.items[u]).filter(Boolean);
  },
  // Park a newly minted item into the docked bay (or hold if traveling).
  parkGear(uid, systemId) {
    const s = this.s();
    const dest = s.travel ? "hold" : (systemId || s.currentSystem || "hold");
    const where = dest === "hold" ? "hold" : dest;
    return this.deposit(where, "gear", uid, 1, { force: true });
  },

  // Floor for station-bay capacity after hauling: base + purchased upgrades.
  // Players who bought an Inventory Bay upgrade must not end up worse than a
  // fresh account (STATION_BAY_BASE); Math.max keeps any larger legacy value.
  bayCapacityFloor(s) {
    const base = (typeof STATION_BAY_BASE !== "undefined" ? STATION_BAY_BASE : 50);
    const step = (typeof BAZAARCFG !== "undefined" && BAZAARCFG.inventoryUpgradeStep) || 10;
    const ups = (s && s.inventory && s.inventory.upgrades) | 0;
    return base + ups * step;
  },
  ensureBayCapacity(s) {
    if (!s || !s.inventory || typeof s.inventory !== "object") return;
    const floor = this.bayCapacityFloor(s);
    s.inventory.capacity = Math.max(s.inventory.capacity | 0, floor);
  },

  // Park unequipped/unlisted items that have no hold/bay/shipment home.
  // Operates on a passed state so Game.migrate can call it before Game.state exists
  // (and so mergeSoftItems-restored blackboxes become visible again).
  parkOrphanGear(state) {
    const s = state || this.s();
    if (!s || !s.items || typeof s.items !== "object") return 0;
    s.hold = this._bag(s.hold);
    s.stationInv = s.stationInv && typeof s.stationInv === "object" ? s.stationInv : {};
    const equipped = new Set();
    for (const sh of s.ships || []) for (const u of (sh.accessories || [])) equipped.add(u);
    const listed = new Set((s.listings || []).map(l => l && l.itemUid).filter(Boolean));
    const placed = new Set(s.hold.gear.slice());
    for (const bag of Object.values(s.stationInv)) for (const u of (bag.gear || [])) placed.add(u);
    for (const sh of (s.shipments || [])) {
      if (sh && !sh.resolved) for (const u of (sh.gear || [])) placed.add(u);
    }
    let n = 0;
    const dest = s.travel ? null : ((typeof s.currentSystem === "string" && s.currentSystem) || "navos");
    for (const it of Object.values(s.items)) {
      if (!it || !it.uid || equipped.has(it.uid) || listed.has(it.uid) || placed.has(it.uid)) continue;
      if (dest) {
        const bay = this._bag(s.stationInv[dest] || this.emptyBag());
        bay.gear.push(it.uid);
        s.stationInv[dest] = bay;
      } else {
        s.hold.gear.push(it.uid);
      }
      placed.add(it.uid);
      n++;
    }
    return n;
  },

  // ---- migration / reset --------------------------------------------------
  // Flat positions → stationInv[currentSystem]; unequipped items → that bay.
  migrateState(s) {
    if (!s || typeof s !== "object") return s;
    s.hold = this._bag(s.hold);
    s.stationInv = s.stationInv && typeof s.stationInv === "object" ? s.stationInv : {};
    s.shipments = Array.isArray(s.shipments) ? s.shipments : [];
    // Already migrated if any bag has content or hold was explicitly initialized
    // with the hauling flag.
    if (s._haulingMigrated) {
      for (const sys of Object.keys(s.stationInv)) s.stationInv[sys] = this._bag(s.stationInv[sys]);
      this.ensureBayCapacity(s);
      this.parkOrphanGear(s);
      return s;
    }
    const dest = (typeof s.currentSystem === "string" && s.currentSystem) || "navos";
    const bay = this._bag(s.stationInv[dest] || this.emptyBag());
    // Commodity stock → bay (overfull OK).
    if (!Object.keys(bay.blocks).length && !Object.keys(s.hold.blocks).length) {
      for (const [id, q] of Object.entries(s.positions || {})) {
        const n = Math.floor(+q || 0);
        if (n > 0) bay.blocks[id] = (bay.blocks[id] || 0) + n;
      }
    }
    s.stationInv[dest] = bay;
    this.parkOrphanGear(s);          // unequipped gear → bay / hold
    this.ensureBayCapacity(s);       // base 50 + upgrades×step (never below a fresh account)
    s._haulingMigrated = true;
    return s;
  },

  reset() {
    const s = this.s();
    s.hold = this.emptyBag();
    s.stationInv = {};
    s.shipments = [];
    s._haulingMigrated = true;
  },

  // ---- Assets tab summaries ----------------------------------------------
  systemsWithAssets() {
    const s = this.s();
    const out = new Set(Object.keys(s.stationInv || {}));
    for (const sh of (s.shipments || [])) {
      if (sh.resolved) continue;
      if (sh.from) out.add(sh.from);
      if (sh.to) out.add(sh.to);
    }
    return [...out];
  },
  bagValue(bag, systemId) {
    bag = this._bag(bag);
    let v = 0;
    for (const [id, q] of Object.entries(bag.blocks)) {
      if (!(q > 0)) continue;
      const px = window.Market ? Market.spot(id, systemId) : 0;
      v += q * px;
    }
    for (const uid of bag.gear) {
      const it = this.s().items[uid];
      if (it) v += it.value || (window.Items ? Items.value(it) : 0);
    }
    return v;
  },
  summaryRows() {
    const s = this.s();
    const rows = [];
    for (const sysId of this.systemsWithAssets()) {
      const bag = this.bay(sysId);
      const slots = this.slotsUsed(bag);
      const value = this.bagValue(bag, sysId);
      const inbound = (s.shipments || []).filter(sh => !sh.resolved && sh.to === sysId);
      const illicit = Object.keys(bag.blocks).some(id => {
        const c = COMMODITIES.find(x => x.id === id);
        return c && c.cat === "illicit" && bag.blocks[id] > 0;
      });
      rows.push({
        systemId: sysId,
        slots, value, illicit,
        inbound,
        here: !s.travel && s.currentSystem === sysId,
      });
    }
    rows.sort((a, b) => b.value - a.value || a.systemId.localeCompare(b.systemId));
    return rows;
  },
};

/* ---- Courier / Shipments (HAULING.md §9) -------------------------------- */
const Shipments = {
  s() { return window.Game.state; },
  list() { return this.s().shipments || (this.s().shipments = []); },
  active(now = Date.now()) { return this.list().filter(sh => !sh.resolved); },
  inboundTo(sysId) { return this.active().filter(sh => sh.to === sysId); },

  destinations() {
    // Systems you already have assets in, plus current dock.
    const set = new Set(Assets.systemsWithAssets());
    const s = this.s();
    if (!s.travel && s.currentSystem) set.add(s.currentSystem);
    return [...set];
  },

  slotRiskFactor(slots) {
    if (window.Charters && Charters.cargoRiskFactor) return Charters.cargoRiskFactor(slots);
    return Util.clamp(Math.pow(Math.max(slots, 1) / 30, 1.2), 0.4, 8);
  },
  durationRiskMult(hours) {
    if (window.Charters && Charters.durationRiskMult) return Charters.durationRiskMult(hours);
    return Math.pow(Math.max(hours, 0.5), 0.85);
  },

  // Galaxy distance shared with Fleet.dockTravelMs (without flagship speed).
  distance(fromId, toId) {
    const a = SYSTEMS.find(x => x.id === fromId), b = SYSTEMS.find(x => x.id === toId);
    if (a && b) return Math.max(1, Math.abs((a.distance ?? 0) - (b.distance ?? 0)));
    if (window.Galaxy) {
      const ga = Galaxy.get(fromId), gb = Galaxy.get(toId);
      if (ga && gb && ga.pos && gb.pos)
        return Math.max(0.08, Math.hypot(ga.pos.x - gb.pos.x, ga.pos.y - gb.pos.y));
    }
    return 1;
  },

  etaMs(fromId, toId) {
    const dist = this.distance(fromId, toId);
    const a = SYSTEMS.find(x => x.id === fromId), b = SYSTEMS.find(x => x.id === toId);
    const k = (a && b)
      ? ((window.MARKETCFG && MARKETCFG.dockK) || 12)
      : ((window.STATIONCFG && STATIONCFG.dockMapK) || 22);
    const speed = (typeof COURIERCFG !== "undefined" && COURIERCFG.speed) || 0.8;
    const seconds = (dist * k) / speed;
    return (seconds * 1000) / (window.Game && Game.timeScale || 1);
  },

  declaredValue(blocks, gear, systemId) {
    let v = 0;
    for (const [id, q] of Object.entries(blocks || {})) {
      if (q > 0 && window.Market) v += q * Market.spot(id, systemId);
    }
    for (const uid of gear || []) {
      const it = this.s().items[uid];
      if (it) v += it.value || (window.Items ? Items.value(it) : 0);
    }
    return v;
  },

  quote(fromId, toId, blocks, gear) {
    const cfg = (typeof COURIERCFG !== "undefined" && COURIERCFG) || {};
    const slots = Assets.slotsUsed({ blocks: blocks || {}, gear: gear || [] });
    const dist = this.distance(fromId, toId);
    const value = this.declaredValue(blocks, gear, fromId);
    let fee = (cfg.base || 200)
      + (cfg.perSlot || 40) * slots
      + (cfg.perDist || 80) * dist
      + (cfg.valueRate || 0.01) * value;
    // Senate lane mult: safer lanes cost more to insure (or cheaper under cuts).
    if (window.Senate && Senate.routeSafetyAdd) {
      const safety = Senate.routeSafetyAdd();
      fee *= 1 + Math.max(-0.3, Math.min(0.4, safety * (cfg.laneMultWeight || 0.5)));
    }
    fee = Math.max(50, Math.round(fee / 10) * 10);

    const eta = this.etaMs(fromId, toId);
    const hours = eta / 3600000;
    let risk = (cfg.baseRisk || 0.04)
      * this.slotRiskFactor(slots)
      * this.durationRiskMult(hours);
    if (window.Senate && Senate.routeSafetyAdd) risk -= Senate.routeSafetyAdd();
    if (window.Fleet) risk -= (Fleet.mainBonus("routeSafe") || 0) * (cfg.routeSafeWeight || 0.5);
    risk = Util.clamp(risk, 0, cfg.riskCap != null ? cfg.riskCap : 0.55);

    const illicit = Object.keys(blocks || {}).some(id => {
      const c = COMMODITIES.find(x => x.id === id);
      return c && c.cat === "illicit" && (blocks[id] || 0) > 0;
    });
    return { fee, slots, etaMs: eta, riskPct: risk, value, illicit, dist };
  },

  dispatch(fromId, toId, blocks, gear) {
    const s = this.s();
    if (!fromId || !toId || fromId === toId) return { ok: false, msg: "Pick a different destination." };
    if (s.travel) return { ok: false, msg: "Dock before dispatching a courier." };
    const dests = this.destinations();
    if (!dests.includes(toId)) return { ok: false, msg: "Couriers only reach stations you already use." };
    const max = (typeof COURIERCFG !== "undefined" && COURIERCFG.maxActive) || 3;
    if (this.active().length >= max) return { ok: false, msg: `Courier guild capped at ${max} manifests.` };

    // Validate availability at origin bay.
    const bay = Assets.bay(fromId);
    const takeBlocks = {}, takeGear = [];
    for (const [id, q] of Object.entries(blocks || {})) {
      const n = Math.floor(+q || 0);
      if (n <= 0) continue;
      if ((bay.blocks[id] || 0) < n) return { ok: false, msg: "Not enough stock in that bay." };
      takeBlocks[id] = n;
    }
    for (const uid of gear || []) {
      if (!bay.gear.includes(uid)) return { ok: false, msg: "Gear isn't in that bay." };
      takeGear.push(uid);
    }
    if (!Object.keys(takeBlocks).length && !takeGear.length) return { ok: false, msg: "Manifest is empty." };

    const q = this.quote(fromId, toId, takeBlocks, takeGear);
    if (q.fee > s.credits) return { ok: false, msg: "Not enough credits." };

    for (const [id, n] of Object.entries(takeBlocks))
      Assets.withdraw(fromId, "block", id, n, { skipPositions: true });
    for (const uid of takeGear) Assets.withdraw(fromId, "gear", uid);
    Assets.reconcile();

    s.credits -= q.fee;
    const now = Date.now();
    const sh = {
      id: "sh" + (++s.seq),
      from: fromId, to: toId,
      blocks: takeBlocks, gear: takeGear,
      fee: q.fee, slots: q.slots,
      departedAt: now, etaMs: q.etaMs,
      riskPct: q.riskPct, illicit: q.illicit,
      resolved: false, outcome: null,
    };
    this.list().push(sh);
    if (window.Economy) Economy.refreshNetWorth();
    this._report("dispatch", sh, `Courier dispatched to ${this._sysName(toId)} — ${q.slots} slots, ETA ${Util.duration(q.etaMs)}, risk ${(q.riskPct * 100).toFixed(0)}%. Fee ${Util.credits(q.fee)}c.`);
    return { ok: true, shipment: sh, quote: q };
  },

  resolve(now = Date.now()) {
    const done = [];
    for (const sh of this.active()) {
      if (now < sh.departedAt + sh.etaMs) continue;
      const lost = this._rollPiracy(sh);
      const customs = sh.illicit ? this._rollCustoms(sh) : null;
      // Land remaining goods in destination bay (force — never delete).
      for (const [id, q] of Object.entries(sh.blocks || {})) {
        if (q > 0) Assets.deposit(sh.to, "block", id, q, { force: true, skipPositions: true });
      }
      for (const uid of sh.gear || []) Assets.deposit(sh.to, "gear", uid, 1, { force: true });
      Assets.reconcile();
      sh.resolved = true;
      sh.outcome = { lost, customs, arrivedAt: now };
      done.push(sh);
      let msg = `Courier arrived at ${this._sysName(sh.to)}.`;
      if (lost) msg += ` Raiders took ${lost.label}.`;
      if (customs) msg += ` Customs seized ${customs.qty} ${customs.name}.`;
      this._report(lost || customs ? "incident" : "arrival", sh, msg);
    }
    // Prune resolved after a while so the array doesn't grow forever.
    const keepMs = 7 * 24 * 3600 * 1000;
    this.s().shipments = this.list().filter(sh =>
      !sh.resolved || (sh.outcome && sh.outcome.arrivedAt > now - keepMs));
    if (done.length && window.Economy) Economy.refreshNetWorth();
    return done;
  },

  _rollPiracy(sh) {
    if (Math.random() >= (sh.riskPct || 0)) return null;
    // Lose one block (or one gear item) — partial loss.
    const ids = Object.keys(sh.blocks || {}).filter(id => (sh.blocks[id] || 0) > 0);
    if (ids.length) {
      const id = Util.pick(ids);
      const size = Assets.blockSize(id);
      const take = Math.min(sh.blocks[id], size);
      sh.blocks[id] -= take;
      if (sh.blocks[id] <= 0) delete sh.blocks[id];
      const c = COMMODITIES.find(x => x.id === id);
      return { kind: "block", id, qty: take, label: `${take} ${(c && c.name) || id}` };
    }
    if (sh.gear && sh.gear.length) {
      const uid = sh.gear.pop();
      const it = this.s().items[uid];
      return { kind: "gear", uid, label: (it && it.name) || "gear" };
    }
    return null;
  },

  _rollCustoms(sh) {
    // Shared odds helper with flagship arrival (Economy.customsChance).
    if (!window.Economy || !Economy.customsChance) return null;
    const illicitIds = Object.keys(sh.blocks || {}).filter(id => {
      const c = COMMODITIES.find(x => x.id === id);
      return c && c.cat === "illicit" && (sh.blocks[id] || 0) > 0;
    });
    if (!illicitIds.length) return null;
    const chance = Economy.customsChance(sh.to, /*fromCourier*/ true);
    if (Math.random() >= chance) return null;
    const id = Util.pick(illicitIds);
    const held = sh.blocks[id] || 0;
    const qty = Math.min(held, Math.max(1, Math.ceil(held * Util.randFloat(CUSTOMS.seize[0], CUSTOMS.seize[1]))));
    sh.blocks[id] = held - qty;
    if (sh.blocks[id] <= 0) delete sh.blocks[id];
    const c = COMMODITIES.find(x => x.id === id);
    const value = Math.round(qty * (window.Market ? Market.systemPrice(id, sh.to) : 0));
    if (window.Stations && Stations.get(sh.to) && (Stations.get(sh.to).modules.customs_house | 0))
      Stations.impoundCargo(sh.to, id, qty, value, Stations.playerId());
    return { id, name: (c && c.name) || id, qty, value };
  },

  _sysName(id) {
    if (window.Galaxy && Galaxy.get(id)) return Galaxy.get(id).name;
    const s = SYSTEMS.find(x => x.id === id);
    return (s && s.name) || id;
  },
  _report(kind, sh, text) {
    if (window.Story && Story._push) {
      Story._push({
        arc: "courier", from: "Courier Guild", portrait: 3,
        text, type: kind === "incident" ? "in" : "reward",
      });
    }
    Bus.emit("shipment", { kind, shipment: sh, text });
  },
};

window.Assets = Assets;
window.Shipments = Shipments;
