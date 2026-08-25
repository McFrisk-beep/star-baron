/* raiders.js — NPC piracy (docs/SPACE_INTERACTIVITY.md §4, build order step 3).

   Step 2 parked a fat, lightly-armed hull at a rock in open space and called
   the exposure the price of untaxed ore. This is the bill arriving. Corsairs
   jump parked claims and rob NPC haulers, and they do it where the design said
   they would: rich seams sit in the worst neighbourhoods, so the richness of
   the rock IS the threat level — one number already on the seam, no second
   table to balance (§3.3).

   The anti-grief rules (§6.6) are load-bearing even against NPCs, because this
   is where the player learns what raiding costs:

   • Only cargo in transit is ever at risk. A raid takes the batch that was in
     the hold when it hit — never banked ore, never the system bay, never the
     save. Maximum blast radius is one 30-minute batch.
   • The hull is never destroyed and never impounded. A robbed miner takes
     damage (a repair bill) and can be chased off its rock. It always flies
     home. Losing a ship you never saw die is the one thing this must not do.
   • Preparation is the counterplay, not reflexes. Guard the claim with escort
     hulls (§3.5's standing job) or work a leaner rock in quieter space. Both
     decisions are made at dispatch and resolve while the tab is closed.

   Idle-first and deterministic: every roll is seeded from (op id, cycle index),
   so a week offline banks exactly the raids an always-open tab would have seen.
   Nothing here is stored — Mining owns the one row, and it already existed.   */

const Raiders = {
  cfg() { return window.RAIDCFG || {}; },

  // ---- where the corsairs live -------------------------------------------
  // Dens are permanent geography (POIs never churns() them), so this is a
  // one-time scan of the slot table rather than anything on a hot path.
  _dens: null,
  denSystems() {
    if (this._dens) return this._dens;
    const out = new Set();
    if (!window.POIs || !window.Galaxy) return out;      // don't cache a miss
    for (const sys of Galaxy.list) {
      if (POIs.slots(sys.id).some(s => s.type === "den")) out.add(sys.id);
    }
    return (this._dens = out);
  },
  hasDen(sysId) { return this.denSystems().has(sysId); },

  // ---- pressure: derived, never authored (§1.4) ---------------------------
  // How much law is present here. security.js folds the sector floor, sector
  // capitals, station modules, Senate edicts and any running war into one
  // number, and the galaxy chart paints the same one — so a player's Customs
  // House protects their own claims and shows up on the map for the same
  // reason. Dens stay out of it on purpose (they are the local unknown) and
  // are multiplied in separately below.
  _lawMult(sysId) {
    return window.Security ? Security.raidMult(sysId) : 1;
  },
  // §5.4: in the Sable Sprawl you are not policed, you are taxed — and
  // Syndicate standing is what keeps the local crews off your claim. The same
  // standing the League and the Senate punish you for holding.
  _syndicateMult(sectorId) {
    if (sectorId !== "sprawl" || !window.Rep) return 1;
    return 1 - Math.max(0, Rep.get("syndicate")) / 100 * (this.cfg().syndicateShield || 0);
  },

  // Odds a parked claim is jumped during one mining cycle.
  claimChance(poi) {
    const c = this.cfg();
    if (!poi || !poi.ore) return 0;
    const sys = window.Galaxy ? Galaxy.get(poi.sysId) : null;
    const den = this.hasDen(poi.sysId) ? (c.denMult || 1) : 1;
    const cl = c.chanceClamp || [0, 1];
    return Util.clamp((c.base || 0) * poi.ore.rich * den
      * this._lawMult(poi.sysId) * this._syndicateMult(sys && sys.sectorId), cl[0], cl[1]);
  },

  // Five readable bands for the belt card, off the same number.
  band(chance) {
    const bands = this.cfg().bands || [];
    let out = bands[0] || { id: "quiet", label: "quiet", color: "#3ad6a0" };
    for (const b of bands) if (chance >= b.at) out = b;
    return out;
  },

  // ---- defence: escort hulls, scored exactly as charters score a convoy ---
  // Charters.defenseScore is already balanced against firepower/hull/armor/
  // shields, so a guard wing is worth here what it is worth there.
  _score(ships) {
    if (!window.Charters || !ships.length) return 0;
    return Charters.defenseScore(Charters.fleetStats(ships));
  },
  // A miner's own guns count for a fraction of a real escort's — enough that a
  // Belt Leviathan isn't a sitting duck, never enough to replace a guard.
  defense(minerUid, guardUids = []) {
    if (!window.Fleet) return 0;
    const guards = guardUids.map(u => Fleet.ship(u)).filter(Boolean);
    const miner = Fleet.ship(minerUid);
    return this._score(guards)
      + this._score(miner ? [miner] : []) * (this.cfg().minerSelfDef || 0);
  },
  // Saturating: no guard ≈ never repels, a heavy wing ≈ usually does, and
  // nothing is ever immune — a claim in the Sprawl is never safe.
  repelChance(minerUid, guardUids = []) {
    const c = this.cfg();
    const def = this.defense(minerUid, guardUids);
    const soft = Math.max(1, c.repelSoft || 240);
    const cl = c.repelClamp || [0, 0.9];
    return Util.clamp(def / (def + soft), cl[0], cl[1]);
  },

  // Flavour: the band that jumped you, reusing the mercenary name pools.
  bandName(seed) {
    const p = window.MERC_PREFIX || ["Red"], u = window.MERC_UNIT || ["Corsairs"];
    return `${p[seed % p.length]} ${u[(seed >>> 7) % u.length]}`;
  },

  // ---- the roll ----------------------------------------------------------
  // Pure: same (op, cycle) always gives the same outcome, so banking twelve
  // cycles after a night away equals having watched all twelve land. Returns
  // null for the ordinary case — nobody came.
  //
  // `qty` is the batch that was in the hold when they arrived; that batch is
  // the entire blast radius.
  rollClaim(op, cycle, poi, qty) {
    if (!op || !poi || !poi.ore || !(qty > 0)) return null;
    const c = this.cfg();
    const s = Market._seed(["raid", op.id, String(cycle)]);
    if (Market._u01(s, 0) >= this.claimChance(poi)) return null;
    const guards = op.guardUids || [];
    const repelled = Market._u01(s, 1) < this.repelChance(op.shipUid, guards);
    const roll = (range, n) => {
      const r = range || [0, 0];
      return r[0] + Market._u01(s, n) * (r[1] - r[0]);
    };
    const out = {
      poiId: op.poiId, sysId: op.sysId, poiName: poi.name, commId: op.commId,
      band: this.bandName(s), repelled, stolen: 0, driveOff: false,
      minerDmg: 0, guardDmg: 0, guarded: guards.length,
    };
    if (repelled) {
      // The wing earned its keep: the ore stays, the guards take paint off.
      out.guardDmg = guards.length ? roll(c.guardDmg, 4) * 0.5 : 0;
      return out;
    }
    out.stolen = Math.min(qty, Math.max(1, Math.round(qty * roll(c.stealFrac, 2))));
    out.minerDmg = roll(c.minerDmg, 3);
    out.guardDmg = guards.length ? roll(c.guardDmg, 4) : 0;
    // Chased off the rock — the hull flies home, which is the worst that can
    // ever happen to it. Guards make being driven off much less likely.
    out.driveOff = Market._u01(s, 5) < (c.driveOff || 0) * (guards.length ? 0.4 : 1);
    return out;
  },

  // ---- NPC piracy against NPC traffic (§4.1's sandbox) -------------------
  // A hauler running in or out of a den system can simply be taken. It limps
  // on to its destination with an empty hold — hull kept, cargo gone, the same
  // rule that protects the player. Deterministic per flight per loop, and
  // deliberately shelf-neutral: suppressing NPC supply is the den's job in
  // §7.1, and doing it here would drain stock.js twice.
  tookManifest(flightId, loopIndex, fromSys, toSys) {
    if (!this.hasDen(fromSys) && !this.hasDen(toSys)) return false;
    const s = Market._seed(["raid", "haul", flightId, String(loopIndex)]);
    return Market._u01(s, 0) < (this.cfg().trafficChance || 0);
  },
};

window.Raiders = Raiders;
