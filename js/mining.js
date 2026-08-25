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

  start(poiId, shipUid, extractorUid = null, now = Date.now()) {
    const can = this.canStart(poiId, shipUid, now);
    if (!can.ok) return can;
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
      startedAt: now, travelMs: travel, arriveAt: now + travel,
      nextAt: now + travel + this.cycleMsFor(extractorUid),
      mined: 0, returnAt: null, fromSys: s.currentSystem,
    };
    Fleet.ship(shipUid).status = "mining";
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

  // Bank matured batches (clock math, offline-capped), land returning hulls.
  // Returns made[] entries for the WYWA recap. Minting is gated exactly like
  // Industries.resolve — never grow positions the server ledger won't honour.
  resolve(now = Date.now()) {
    const s = this.s();
    if (!this.list().length) { this.prunePools(now); return []; }
    const made = [], rolled = [];
    const local = !window.Economy || Economy.softIncomeLocal();
    for (const op of this.list()) {
      const sh = Fleet.ship(op.shipUid);
      const poi = window.POIs ? POIs.get(op.poiId, now) : null;
      if (!sh || !poi || !poi.ore) { op._dead = true; continue; }   // hull gone / bad row — close out
      // The rock it was working got cleared out and replaced: send the hull
      // home rather than silently mining a seam nobody dispatched it to.
      if (!op.returnAt && (poi.gen | 0) !== (op.gen | 0)) {
        op.returnAt = now + op.travelMs;
        rolled.push({ ship: sh.name, sysId: op.sysId });
      }
      if (op.returnAt && now >= op.returnAt) {
        sh.status = "idle";
        op._dead = true;
        continue;
      }
      if (sh.status === "idle") sh.status = "mining";   // self-heal after a merge reset
      if (op.returnAt || now < op.arriveAt || !local || now < op.nextAt) continue;
      const cycleMs = this.cycleMsFor(op.extractorUid);
      const per = this.batchQty(poi, op.shipUid, op.extractorUid);
      const row = this.poolRow(poi);
      let cycles = Math.min(Math.floor((now - op.nextAt) / cycleMs) + 1, MININGCFG.maxCyclesPerResolve);
      let qty = 0;
      // Race the NPC crews: poolLeft() already nets off what they have taken.
      let left = this.poolLeft(poi, now);
      while (cycles-- > 0 && left > 0) {
        const take = Math.min(per, left);
        qty += take; row.used += take; left -= take;
      }
      // A worked-out rock idles the batch clock; the hull stays parked until
      // the crews move on (which ends the op) or you recall it.
      op.nextAt = now + cycleMs;
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
    if (made.length && window.Economy) { Economy.refreshNetWorth(); Economy.checkAchievements(); }
    return made;
  },
};

window.Mining = Mining;
