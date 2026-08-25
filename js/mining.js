/* mining.js — asteroid mining in the deep-space ring
   (docs/SPACE_INTERACTIVITY.md §3, build order step 2). The untaxed twin of
   industries.js: park a miner-class hull at a seeded belt POI and it drops
   small, frequent, UNTAXED ore batches into your stock (parked at that
   system's bay — the ore leg is the existing hauling game). No permit, no
   faction, no tax; the price is exposure — the parked hull is the stationary
   target later build steps point piracy at.

   Idle-first: everything below is a pure function of the clock. Dispatch,
   close the tab, come back — resolve() banks the batches that accrued.

   State: state.mining = [op], state.beltPools = { poiId: { gen, used } } —
   what YOU took is the only stored field per worked rock (§1.3). NPC crews
   take the rest on a clock, and when the site rolls over (POICFG) a fresh
   rock replaces it and the row resets — so storage is capped at "rocks you
   worked this generation" and nobody has to store the world.

   Corsairs (raiders.js, step 3) are the price of that exposure: a parked claim
   can be jumped, and the batch that was in the hold when they hit is the ENTIRE
   blast radius — never banked ore, never the system bay, never the hull. Guard
   the rock with escort hulls (§3.5's standing job) or work a leaner seam.

   Trust: guest / local-ledger only for now. Signed-in play has server-owned
   positions and ship status (app_commit protects both), so dispatch is gated
   on Economy.softIncomeLocal() until the mining SQL phase adds the RPC
   surface — minting locally would create ghost stock the ledger rejects.     */

const Mining = {
  s() { return window.Game.state; },
  list() { return this.s().mining || (this.s().mining = []); },
  pools() { return this.s().beltPools || (this.s().beltPools = {}); },

  // How long until NPC crews finish this rock and a fresh one takes the slot.
  rollsIn(poi, now = Date.now()) {
    const slot = window.POIs && POIs.slot(poi.id);
    return slot ? Math.max(0, POIs.rollsAt(slot, now) - now) : Infinity;
  },
  // NPC barges work the seam out over the site's life, so a rock nobody
  // touches is still empty by the time the crews move on — get there early or
  // race them for what's left. Pure clock maths; nothing stored.
  npcTaken(poi, now = Date.now()) {
    const slot = window.POIs && POIs.slot(poi.id);
    if (!poi || !poi.ore || !slot || !POIs.churns(slot)) return 0;
    const life = POIs.lifeMs(slot);
    if (!isFinite(life) || life <= 0) return 0;
    const frac = Util.clamp(1 - this.rollsIn(poi, now) / life, 0, 1);
    return Math.floor(poi.ore.pool * (MININGCFG.npcShare ?? 1) * frac);
  },
  // What YOU took from this rock, read-only. The scene asks every frame, so
  // this must never lazily create the row — that would write a save row for
  // every belt on screen (and mark the save dirty) just by looking at it.
  poolUsed(poi) {
    const row = this.pools()[poi.id];
    return row && row.gen === (poi.gen | 0) ? row.used : 0;
  },
  // The one stored row per worked rock, for the write path. A row from an
  // older generation belonged to the rock this one replaced.
  poolRow(poi) {
    const rows = this.pools(), gen = poi.gen | 0;
    let row = rows[poi.id];
    if (!row || row.gen !== gen) row = rows[poi.id] = { gen, used: 0 };
    return row;
  },
  poolLeft(poi, now = Date.now()) {
    if (!poi || !poi.ore) return 0;
    return Math.max(0, poi.ore.pool - this.npcTaken(poi, now) - this.poolUsed(poi));
  },
  prunePools(now = Date.now()) {
    const rows = this.pools();
    for (const id of Object.keys(rows)) {
      const poi = window.POIs && POIs.get(id, now);
      if (!poi || !poi.ore || rows[id].gen !== (poi.gen | 0)) delete rows[id];
    }
  },

  opAt(poiId) { return this.list().find(o => o.poiId === poiId) || null; },
  atSystem(sysId) { return this.list().filter(o => o.sysId === sysId); },
  opFor(shipUid) { return this.list().find(o => o.shipUid === shipUid) || null; },

  // ---- escorts: the standing job (§3.5) ----------------------------------
  // Guard hulls ride the op — dispatched with it, home with it, and locked
  // out of everything else in between, exactly like the miner.
  guardUids(op) { return (op && op.guardUids) || []; },
  guardsOf(op) { return this.guardUids(op).map(u => Fleet.ship(u)).filter(Boolean); },
  opGuarding(shipUid) { return this.list().find(o => this.guardUids(o).includes(shipUid)) || null; },
  // Idle escort-class hulls a claim could be handed to.
  guardCandidates() {
    return Fleet.idle().filter(sh => ((Fleet.shipDef(sh.type) || {}).cls || sh.cls) === "escort" && !sh.mercenary);
  },
  // Corsair pressure on a rock, and what a given wing would do about it.
  threat(poi) { return window.Raiders ? Raiders.claimChance(poi) : 0; },
  repel(shipUid, guardUids = []) { return window.Raiders ? Raiders.repelChance(shipUid, guardUids) : 0; },

  // One-way leg from the docked system, scaled by the hull's speed — the same
  // distance metric expeditions fly.
  travelMs(sysId, shipUid) {
    const here = Galaxy.get(this.s().currentSystem), there = Galaxy.get(sysId);
    const dist = (here && there) ? Math.hypot(here.pos.x - there.pos.x, here.pos.y - there.pos.y) : 0.2;
    const sh = Fleet.ship(shipUid);
    const speed = (sh ? Fleet.stats(sh).speed || 1 : 1) * (window.Senate ? Senate.travelSpeedMult() : 1);
    return Math.max(MININGCFG.minLegMs,
      dist * MININGCFG.legSecondsPerDist * 1000 / Math.max(0.1, speed) / (window.Game.timeScale || 1));
  },
  cycleMsFor(extractorUid) {
    const ex = extractorUid ? Extractors.get(extractorUid) : null;
    return MININGCFG.cycleMs * (ex ? Extractors.bonuses(ex).cycle : 1);
  },
  // Per-batch take: base × seam richness × hull yield stat × rig. A rig only
  // helps if it can produce the seam's commodity — specialized best, exactly
  // the industry tiers (Extractors reused wholesale, §3.4).
  batchQty(poi, shipUid, extractorUid) {
    if (!poi || !poi.ore) return 0;
    const sh = Fleet.ship(shipUid);
    const mine = sh ? Fleet.stats(sh).mine || 0 : 0;
    const ex = extractorUid ? Extractors.get(extractorUid) : null;
    const rig = ex && Extractors.canProduce(ex, poi.ore.commId)
      ? Extractors.yieldMult(ex) * Extractors.bonuses(ex).rate : 1;
    return Math.max(1, Math.round(MININGCFG.baseYield * poi.ore.rich * (1 + mine / 10) * rig));
  },
  // Rigs that would actually help at this rock, from the unequipped pool.
  rigsFor(poi) {
    if (!poi || !poi.ore || !window.Extractors) return [];
    return Extractors.unequipped().filter(ex => Extractors.canProduce(ex, poi.ore.commId));
  },

  canStart(poiId, shipUid, now = Date.now()) {
    if (window.Economy && !Economy.softIncomeLocal())
      return { ok: false, msg: "Mining settles on the local ledger for now — the server-side mining update unlocks dispatch for signed-in barons." };
    const poi = window.POIs ? POIs.get(poiId, now) : null;
    if (!poi || !poi.ore) return { ok: false, msg: "Nothing minable there." };
    if (this.opAt(poiId)) return { ok: false, msg: "You already have a miner working this rock." };
    if (this.list().length >= MININGCFG.maxOps) return { ok: false, msg: `Mining ops at capacity (${MININGCFG.maxOps}).` };
    if (this.poolLeft(poi, now) <= 0) return { ok: false, msg: `Seam worked out — the crews move on in ${Util.duration(this.rollsIn(poi, now))} and a fresh rock takes its place.` };
    const sh = Fleet.ship(shipUid);
    if (!sh || sh.status !== "idle") return { ok: false, msg: "Pick an idle ship." };
    if (((Fleet.shipDef(sh.type) || {}).cls || sh.cls) !== "miner") return { ok: false, msg: "Only miner-class hulls carry the rig mounts for belt work." };
    if (sh.mercenary) return { ok: false, msg: "Mercenaries won't fly mining work." };
    return { ok: true, poi };
  },

  // Guards are validated separately so the dispatch button can quote a wing
  // before it is committed.
  canGuard(shipUid, guardUids = []) {
    const max = (window.RAIDCFG || {}).guardMax || 0;
    if (guardUids.length > max) return { ok: false, msg: `A claim takes at most ${max} escort${max === 1 ? "" : "s"}.` };
    if (guardUids.includes(shipUid)) return { ok: false, msg: "The miner can't escort itself." };
    if (new Set(guardUids).size !== guardUids.length) return { ok: false, msg: "That escort is listed twice." };
    for (const uid of guardUids) {
      const g = Fleet.ship(uid);
      if (!g || g.status !== "idle") return { ok: false, msg: "Pick idle escorts." };
      if (((Fleet.shipDef(g.type) || {}).cls || g.cls) !== "escort") return { ok: false, msg: "Only escort-class hulls stand guard." };
      if (g.mercenary) return { ok: false, msg: "Mercenaries won't sit a claim." };
    }
    return { ok: true };
  },

  start(poiId, shipUid, extractorUid = null, guardUids = [], now = Date.now()) {
    // Legacy 4-arg call (…, extractorUid, now) — keep it working.
    if (typeof guardUids === "number") { now = guardUids; guardUids = []; }
    const can = this.canStart(poiId, shipUid, now);
    if (!can.ok) return can;
    const canG = this.canGuard(shipUid, guardUids);
    if (!canG.ok) return canG;
    if (extractorUid) {
      const ex = Extractors.get(extractorUid);
      if (!ex) return { ok: false, msg: "Rig not found." };
      if (Extractors.installedSet().has(extractorUid)) return { ok: false, msg: "That rig is already installed elsewhere." };
      if (!Extractors.canProduce(ex, can.poi.ore.commId)) return { ok: false, msg: "That rig can't work this seam." };
    }
    const s = this.s();
    const travel = this.travelMs(can.poi.sysId, shipUid);
    const op = {
      id: "mn" + (++s.seq), poiId, sysId: can.poi.sysId, shipUid,
      extractorUid: extractorUid || null, commId: can.poi.ore.commId,
      gen: can.poi.gen | 0,   // the rock it was sent to; a roll-over ends the op
      guardUids: guardUids.slice(),
      startedAt: now, travelMs: travel, arriveAt: now + travel,
      nextAt: now + travel + this.cycleMsFor(extractorUid),
      mined: 0, cycles: 0, raids: 0, lost: 0,
      returnAt: null, fromSys: s.currentSystem,
    };
    Fleet.ship(shipUid).status = "mining";
    for (const g of this.guardsOf(op)) g.status = "guarding";
    this.list().push(op);
    if (window.Bus) Bus.emit("miningStart", op);
    return { ok: true, op };
  },

  // Recall flies the full leg home whichever way the hull was pointed.
  // ponytail: a recall mid-outbound should really fly the elapsed fraction
  // back; full-leg keeps one timestamp and nobody will clock a miner.
  recall(opId, now = Date.now()) {
    const op = this.list().find(o => o.id === opId);
    if (!op) return { ok: false, msg: "No such op." };
    if (op.returnAt) return { ok: false, msg: "Already heading home." };
    op.returnAt = now + op.travelMs;
    return { ok: true, op };
  },

  // Everything the op was holding goes back to the yard: the miner, the guard
  // wing, and (via Extractors.installedSet) the rig.
  _land(op) {
    const sh = Fleet.ship(op.shipUid);
    if (sh) sh.status = "idle";
    for (const g of this.guardsOf(op)) g.status = "idle";
    op._dead = true;
  },

  // A raid resolved by Raiders.rollClaim, applied to the fleet. The stolen ore
  // is simply never banked — positions and the system bay are untouchable, and
  // no hull is ever destroyed or impounded here (§6.6).
  _applyRaid(op, raid) {
    const sh = Fleet.ship(op.shipUid);
    if (sh && raid.minerDmg > 0) Fleet.addDamage(sh, raid.minerDmg);
    if (raid.guardDmg > 0) for (const g of this.guardsOf(op)) Fleet.addDamage(g, raid.guardDmg);
    op.raids = (op.raids || 0) + 1;
    op.lost = (op.lost || 0) + raid.stolen;
  },

  // Bank matured batches (clock math, offline-capped), land returning hulls.
  // Returns made[] entries for the WYWA recap. Minting is gated exactly like
  // Industries.resolve — never grow positions the server ledger won't honour.
  resolve(now = Date.now()) {
    const s = this.s();
    if (!this.list().length) { this.prunePools(now); return []; }
    const made = [], rolled = [], raided = [];
    const local = !window.Economy || Economy.softIncomeLocal();
    for (const op of this.list()) {
      const sh = Fleet.ship(op.shipUid);
      const poi = window.POIs ? POIs.get(op.poiId, now) : null;
      if (!sh || !poi || !poi.ore) { this._land(op); continue; }   // hull gone / bad row — close out
      // The rock it was working got cleared out and replaced: send the hull
      // home rather than silently mining a seam nobody dispatched it to.
      if (!op.returnAt && (poi.gen | 0) !== (op.gen | 0)) {
        op.returnAt = now + op.travelMs;
        rolled.push({ ship: sh.name, sysId: op.sysId });
      }
      if (op.returnAt && now >= op.returnAt) { this._land(op); continue; }
      if (sh.status === "idle") sh.status = "mining";   // self-heal after a merge reset
      for (const g of this.guardsOf(op)) if (g.status === "idle") g.status = "guarding";
      if (op.returnAt || now < op.arriveAt || !local || now < op.nextAt) continue;
      const cycleMs = this.cycleMsFor(op.extractorUid);
      const per = this.batchQty(poi, op.shipUid, op.extractorUid);
      const row = this.poolRow(poi);
      let cycles = Math.min(Math.floor((now - op.nextAt) / cycleMs) + 1, MININGCFG.maxCyclesPerResolve);
      let qty = 0, chased = false;
      // Race the NPC crews: poolLeft() already nets off what they have taken.
      let left = this.poolLeft(poi, now);
      while (cycles-- > 0 && left > 0) {
        const take = Math.min(per, left);
        row.used += take; left -= take;
        // The rock gives up the ore either way — the question is whether it
        // reaches the bay. Seeded on (op, cycle index), so banking a night's
        // worth in one go lands exactly the raids a watched tab would have.
        const k = op.cycles = (op.cycles || 0) + 1;
        const raid = window.Raiders ? Raiders.rollClaim(op, k, poi, take) : null;
        qty += take - (raid ? raid.stolen : 0);
        if (raid) {
          raid.ship = sh.name;
          this._applyRaid(op, raid);
          raided.push(raid);
          if (raid.driveOff) { chased = true; break; }
        }
      }
      // A worked-out rock idles the batch clock; the hull stays parked until
      // the crews move on (which ends the op) or you recall it.
      op.nextAt = now + cycleMs;
      // Chased off the claim: the hull flies home. That is the worst a raid is
      // ever allowed to do to it (§6.6.5).
      if (chased && !op.returnAt) op.returnAt = now + op.travelMs;
      if (qty <= 0) continue;
      op.mined = (op.mined || 0) + qty;
      const held = s.positions[op.commId] || 0, prev = s.avgCost[op.commId] || 0;
      s.positions[op.commId] = held + qty;
      s.avgCost[op.commId] = (held + qty) > 0 ? (held * prev) / (held + qty) : 0;
      // Ore lands at the belt's system bay — hauling it out is the ore leg (§3.5).
      if (window.Assets) Assets.parkBlocks(op.sysId, op.commId, qty);
      made.push({ commodity: op.commId, qty, tax: 0, mining: true, poiName: poi.name, sysId: op.sysId });
    }
    if (this.list().some(o => o._dead)) s.mining = this.list().filter(o => !o._dead);
    this.prunePools(now);
    for (const r of rolled) if (window.Bus) Bus.emit("miningRolled", r);
    // Raids ride the same made[] the recap already reads, so a raid suffered
    // while the tab was shut is in the "while you were away" panel rather than
    // silently missing ore. Live play gets the toast off the bus.
    for (const r of raided) {
      made.push({ raid: r });
      if (window.Bus) Bus.emit("miningRaid", r);
    }
    if (made.length && window.Economy) { Economy.refreshNetWorth(); Economy.checkAchievements(); }
    return made;
  },
};

window.Mining = Mining;
