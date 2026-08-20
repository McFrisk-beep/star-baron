/* charters.js — Charter Contracts. Stake idle hull(s) on a timed job from the
   Bazaar; payout is locked at dispatch; risk band + duration set destroy odds.
   Pay scales with cargo; loss odds rise hard with cargo and fall with attack /
   hull / armor / shields — so pure haulers earn more and die more, escorts
   earn less and keep the convoy alive. Group up to CHARTERCFG.maxShips.
   Cancelling early costs credits; after bailoutAt the sponsor buys the ship out.
   Replaces automated trade routes (routes.js retired).

   Server-authoritative when docs/sql/charter_rpcs.sql is applied: dispatch/
   cancel/resolve route through app_charter_* (payouts, buyouts, hull loss and
   impounds land on the ledger instead of evaporating on the next commit).
   Guests and older projects keep the client-local loop below.                 */

const Charters = {
  s() { return window.Game.state; },
  list() { return this.s().charters || (this.s().charters = []); },
  // Unresolved rows — hulls locked, timer counting.
  active() { return this.list().filter(c => !c.resolved); },
  running() { return this.active(); },
  ofShip(uid) { return this.running().find(c => this.shipUids(c).includes(uid)) || null; },

  // Prefer shipUids[]; legacy single-ship rows keep shipUid.
  shipUids(charter) {
    if (!charter) return [];
    if (Array.isArray(charter.shipUids) && charter.shipUids.length)
      return charter.shipUids.filter(Boolean);
    return charter.shipUid ? [charter.shipUid] : [];
  },

  _asShips(shipsOrShip) {
    if (Array.isArray(shipsOrShip)) return shipsOrShip.filter(Boolean);
    return shipsOrShip ? [shipsOrShip] : [];
  },

  fleetStats(ships) {
    const out = { cargo: 0, firepower: 0, hull: 0, armor: 0, shields: 0 };
    for (const sh of this._asShips(ships)) {
      const st = Fleet.stats(sh);
      out.cargo += st.cargo || 0;
      out.firepower += st.firepower || 0;
      out.hull += st.hull || 0;
      out.armor += st.armor || 0;
      out.shields += st.shields || 0;
    }
    return out;
  },

  // Pay is cargo-driven — guns don't inflate the contract rate.
  shipRate(ships) {
    const st = this.fleetStats(ships);
    return CHARTERCFG.rateBase + st.cargo * CHARTERCFG.rateCargo;
  },

  quote(ships, band, durationMs) {
    const h = durationMs / 3600000;
    const pay = (DANGER.find(d => d.id === band) || DANGER[0]).pay;
    const raw = this.shipRate(ships) * pay * Math.pow(h, CHARTERCFG.taperExp);
    const cap = CHARTERCFG.payoutCapMult
      ? Economy.depth() * CHARTERCFG.payoutCapMult : Infinity;
    return Math.round(Math.min(raw, cap) / 10) * 10;
  },

  durationRiskMult(h) { return Math.pow(Math.max(h, 0.5), CHARTERCFG.durationRiskExp); },

  cargoRiskFactor(cargo) {
    const soft = Math.max(1, CHARTERCFG.cargoRiskSoft || 30);
    const exp = CHARTERCFG.cargoRiskExp == null ? 1.2 : CHARTERCFG.cargoRiskExp;
    const cl = CHARTERCFG.cargoRiskClamp || [0.4, 8];
    return Util.clamp(Math.pow(Math.max(cargo, 1) / soft, exp), cl[0], cl[1]);
  },

  defenseScore(st) {
    return (st.firepower || 0) * (CHARTERCFG.defFirepower || 3)
      + (st.hull || 0) * (CHARTERCFG.defHull || 1)
      + (st.armor || 0) * (CHARTERCFG.defArmor || 2)
      + (st.shields || 0) * (CHARTERCFG.defShields || 2);
  },

  defenseFactor(ships) {
    const st = this.fleetStats(ships);
    const soft = Math.max(1, CHARTERCFG.defenseSoftness || 100);
    const cl = CHARTERCFG.defenseFactorClamp || [0.25, 2.5];
    return Util.clamp(soft / Math.max(1, this.defenseScore(st)), cl[0], cl[1]);
  },

  // Senate Convoy Escort Mandate (+) / Lane Patrol Cuts (−) scale charter risk
  // the same way they used to swing route-raid losses (SENATECFG.routeSafetyClamp).
  _senateRiskMult() {
    if (!window.Senate || !Senate.routeSafetyAdd) return 1;
    const safety = Senate.routeSafetyAdd();
    if (!safety) return 1;
    const cl = (window.SENATECFG && SENATECFG.routeSafetyClamp) || [0.1, 2.5];
    return Util.clamp(1 - safety, cl[0], cl[1]);
  },

  destroyChance(ships, band, durationMs) {
    const b = CHARTER_BANDS[band] || CHARTER_BANDS.safe;
    const st = this.fleetStats(ships);
    const safe = window.Fleet ? Fleet.mainBonus("routeSafe") : 0;
    return Util.clamp(
      b.destroy * this.durationRiskMult(durationMs / 3600000)
        * this.cargoRiskFactor(st.cargo) * this.defenseFactor(ships)
        * (1 - safe) * this._senateRiskMult(),
      0, 0.85
    );
  },

  impoundChance(ships, band, durationMs) {
    const b = CHARTER_BANDS[band] || CHARTER_BANDS.safe;
    if (!(b.impound > 0)) return 0;
    const st = this.fleetStats(ships);
    const safe = window.Fleet ? Fleet.mainBonus("routeSafe") : 0;
    return Util.clamp(
      b.impound * this.durationRiskMult(durationMs / 3600000)
        * this.cargoRiskFactor(st.cargo) * this.defenseFactor(ships)
        * (1 - safe) * this._senateRiskMult(),
      0, 0.85
    );
  },

  // Signed credits: negative = abort fee, positive = buyout. Late buyout ceiling
  // is scaled down by destroy odds so cancelling at the last tick isn't
  // strictly better than finishing a high-risk charter (CHARTER_CONTRACTS §5).
  cancelValue(charter, now = Date.now()) {
    const dur = charter.durationMs, R = charter.reward;
    const t = Util.clamp(now - charter.startedAt, 0, dur);
    const p = t / dur;
    if (p < CHARTERCFG.bailoutAt) return -Math.round(R * CHARTERCFG.abortFeeRate);

    const windowMs = dur * (1 - CHARTERCFG.bailoutAt);
    const stepMs = CHARTERCFG.salvageStepMin * 60000;
    const nSteps = Math.max(1, Math.round(windowMs / stepMs));
    const done = Math.min(nSteps - 1, Math.floor((t - dur * CHARTERCFG.bailoutAt) / stepMs));
    const ramp = nSteps > 1 ? done / (nSteps - 1) : 1;
    const ceil = Math.max(
      CHARTERCFG.salvageFloor,
      CHARTERCFG.salvageCeil * (1 - (charter.destroyChance || 0) * 2)
    );
    return Math.round(R * (CHARTERCFG.salvageFloor + (ceil - CHARTERCFG.salvageFloor) * ramp));
  },

  // Preview cancel numbers for a not-yet-dispatched quote (uses quoted reward + chance).
  cancelPreview(reward, destroyChance, durationMs, nowOffset = 0) {
    return this.cancelValue({
      reward, destroyChance, durationMs, startedAt: Date.now() - nowOffset,
    });
  },

  // Fraction of locked reward paid when these hulls return. Legacy rows without
  // a cargo snapshot pay in full (single-ship era). Zero-cargo groups (rateBase
  // only) also pay in full if anything survives.
  payoutFrac(charter, survivors) {
    const by = charter && charter.cargoByShip;
    if (!by || typeof by !== "object") return 1;
    const total = Math.max(0, +charter.cargoTotal || 0);
    if (total <= 0) return 1;
    let alive = 0;
    for (const sh of survivors || []) alive += Math.max(0, +by[sh.uid] || 0);
    return Util.clamp(alive / total, 0, 1);
  },

  // Dispatch/cancel/resolve go through app_charter_* when the server owns the
  // ledger (docs/sql/charter_rpcs.sql): the payout was a local credit increase
  // (rejected by app_commit), lost hulls resurrected from the server row, and
  // buyouts evaporated — only abort fees stuck. The local path stays for guests
  // and for projects that haven't applied the SQL yet.
  dispatch(shipUids, band, durationMin, now = Date.now()) {
    if (!(window.Cloud && Cloud.shipRpcReady && Cloud.shipRpcReady("app_charter_dispatch")))
      return this._dispatchLocal(shipUids, band, durationMin, now);
    let row = null;
    return Economy._withRpc(
      () => {
        const r = this._dispatchLocal(shipUids, band, durationMin, now);
        if (r.ok) row = r.charter;
        return r;
      },
      // Server restamps startedAt, clamps the quote, and locks the hulls; its
      // slice replaces the optimistic row. null = RPC missing → keep local.
      async () => (await Cloud.charterDispatch(row)) || { ok: true },
      "Couldn't reach the charter sponsor — try again."
    );
  },

  _dispatchLocal(shipUids, band, durationMin, now = Date.now()) {
    const s = this.s();
    const uids = [...new Set((Array.isArray(shipUids) ? shipUids : [shipUids]).filter(Boolean))];
    if (!uids.length) return { ok: false, msg: "Pick at least one ship." };
    if (uids.length > (CHARTERCFG.maxShips || 6))
      return { ok: false, msg: `At most ${CHARTERCFG.maxShips} ships per charter.` };
    if (!CHARTER_BANDS[band]) return { ok: false, msg: "Unknown risk band." };
    if (!CHARTERCFG.durations.includes(+durationMin)) return { ok: false, msg: "Pick a listed duration." };
    if (this.running().length >= CHARTERCFG.maxActive) return { ok: false, msg: `At most ${CHARTERCFG.maxActive} charters at once.` };

    const ships = [];
    for (const uid of uids) {
      const sh = Fleet.ship(uid);
      if (!sh) return { ok: false, msg: "Ship not found." };
      if (sh.mercenary) return { ok: false, msg: "Mercenaries can't take charters." };
      if (sh.status !== "idle") return { ok: false, msg: `${sh.name} must be idle.` };
      ships.push(sh);
    }
    // Don't leave the player with zero free hulls and no credits to act.
    const freeHulls = Fleet.idle().filter(x => !x.mercenary && !uids.includes(x.uid)).length;
    if (freeHulls === 0 && s.credits <= 0)
      return { ok: false, msg: "Can't charter your last hull with no credits left — you'd be stranded." };

    const durationMs = (+durationMin) * 60000;
    const reward = this.quote(ships, band, durationMs);
    const destroy = this.destroyChance(ships, band, durationMs);
    const bandInfo = CHARTER_BANDS[band];
    // Snapshot cargo at dispatch — resolve pro-rates pay by cargo that returns,
    // so losing the hauler can't cash the full convoy quote on an escort alone.
    const cargoByShip = {};
    let cargoTotal = 0;
    for (const sh of ships) {
      const cargo = Math.max(0, Fleet.stats(sh).cargo | 0);
      cargoByShip[sh.uid] = cargo;
      cargoTotal += cargo;
    }
    const charter = {
      id: "ch" + (++s.seq),
      shipUid: ships[0].uid,          // legacy single-ship field (first hull)
      shipUids: ships.map(sh => sh.uid),
      band,
      durationMs,
      startedAt: now,
      reward,
      cargoByShip,
      cargoTotal,
      faction: bandInfo.faction,
      destroyChance: destroy,
      impoundChance: this.impoundChance(ships, band, durationMs),
      impound: (bandInfo.impound || 0) > 0,
      resolved: false,
    };
    for (const sh of ships) sh.status = "charter";
    this.list().push(charter);
    Economy.refreshNetWorth();
    Bus.emit("charterStart", charter);
    return { ok: true, charter };
  },

  cancel(id, now = Date.now()) {
    if (!(window.Cloud && Cloud.shipRpcReady && Cloud.shipRpcReady("app_charter_cancel")))
      return this._cancelLocal(id, now);
    return Economy._withRpc(
      () => this._cancelLocal(id, now),
      async () => (await Cloud.charterCancel(id)) || { ok: true },
      "Couldn't reach the charter sponsor — try again."
    );
  },

  _cancelLocal(id, now = Date.now()) {
    const s = this.s();
    const c = this.list().find(x => x.id === id);
    if (!c || c.resolved) return { ok: false, msg: "Charter not found." };
    const value = this.cancelValue(c, now);
    if (value < 0 && s.credits < -value)
      return { ok: false, msg: `Need ${Util.credits(-value)}c to abort — not enough credits.` };
    s.credits += value;
    const repHit = c.faction ? Rep.onContractCancel(c.faction, c.band) : 0;
    // Drop the row first so ofShip/running see the remaining lock set.
    s.charters = this.list().filter(x => x.id !== id);
    for (const uid of this.shipUids(c)) {
      const sh = Fleet.ship(uid);
      if (sh && sh.status === "charter" && !this.ofShip(uid)) sh.status = "idle";
    }
    Economy.refreshNetWorth();
    Bus.emit("charterCancel", { charter: c, value, repHit });
    return { ok: true, value, repHit, charter: c };
  },

  // Resolve matured charters. Returns reports (also pushed to state.reports).
  // Authoritative path awaits app_charter_resolve (server clock + seeded RNG);
  // guests stay sync. Callers handle either via Promise.resolve(...).
  resolve(now = Date.now()) {
    if (window.Cloud && Cloud.shipRpcReady && Cloud.shipRpcReady("app_charter_resolve")) return this._resolveAuth(now);
    return this._resolveLocal(now);
  },

  async _resolveAuth(now) {
    const due = this.list().some(c => !c.resolved && (c.deferred || now >= c.startedAt + c.durationMs));
    if (!due || this._authBusy) return [];
    this._authBusy = true;
    try {
      // Roster snapshot before the RPC — lost hulls leave s.ships (§5.7).
      const rosters = {};
      for (const c of this.list()) if (!c.resolved)
        rosters[c.id] = this.shipUids(c).map(u => { const sh = Fleet.ship(u); return sh ? { uid: sh.uid, name: sh.name, type: sh.type } : null; }).filter(Boolean).slice(0, 12);
      const r = await Economy._rpcOnly(() => Cloud.charterResolve(), "Couldn't settle charters — try again.");
      if (r && r.missing) return this._resolveLocal(now);
      if (!r || !r.ok) return [];
      const out = Array.isArray(r.resolved) ? r.resolved : [];
      for (const rep of out) if (!rep.roster && rosters[rep.uid]) rep.roster = rosters[rep.uid];
      for (const sr of this.s().reports || []) if (!sr.roster && rosters[sr.uid]) sr.roster = rosters[sr.uid];
      if (out.length) { Economy.refreshNetWorth(); Economy.checkAchievements(); }
      for (const report of out) {
        // Same after-action inbox as Fleet contracts (Dispatches → Fleet Ops).
        if (window.MissionStory) MissionStory.begin(report);
        Bus.emit("charterDone", report);
      }
      return out;
    } finally { this._authBusy = false; }
  },

  _resolveLocal(now = Date.now()) {
    const s = this.s();
    const out = [];
    for (const c of this.list()) {
      if (c.resolved || (!c.deferred && now < c.startedAt + c.durationMs)) continue;
      const uids = this.shipUids(c);
      const ships = uids.map(u => Fleet.ship(u)).filter(Boolean);
      const bandLabel = (DANGER.find(d => d.id === c.band) || {}).label || c.band;
      const art = /^[aeiou]/i.test(bandLabel) ? "an" : "a"; // "an extreme charter"
      const names = ships.map(sh => sh.name);
      const report = {
        uid: c.id, title: `Charter — ${bandLabel}`, type: "charter",
        success: true, ts: now, danger: c.band, faction: c.faction || null,
        credits: 0, items: [], stock: null, lost: [], impounded: [], damaged: [],
        shipName: names.length ? names.join(", ") : null,
        // replay roster (LIVING_GALAXY.md §5.7) — captured before losses
        roster: ships.map(sh => ({ uid: sh.uid, name: sh.name, type: sh.type })).slice(0, 12),
      };

      c.resolved = true;
      if (c.deferred) {
        // Legacy "payout pending" row from before auto-resolve: the hulls came
        // home idle long ago — settle the locked reward and close it out.
        report.credits = Economy.afterTax(c.reward);
        report.taxed = c.reward - report.credits;
        s.credits += report.credits;
        report.summary = `${names.length ? names.join(", ") : "Charter"} — deferred payout settled (+${Util.credits(report.credits)}c).`;
      } else if (!ships.length) {
        report.success = false;
        report.summary = "Charter closed — hulls already gone.";
      } else {
        // Each hull rolls the convoy chance — escorts lower that shared rate.
        const survivors = [];
        for (const sh of ships) {
          if (Math.random() < (c.destroyChance || 0)) {
            report.lost.push({ uid: sh.uid, name: sh.name });
            s.ships = s.ships.filter(x => x.uid !== sh.uid);
          } else if (c.impound && Math.random() < (c.impoundChance || 0)) {
            sh.status = "impounded";
            sh.retrieveCost = Fleet.impoundFine(sh);   // stamp = the half-value fee (display-legacy)
            report.impounded.push({ uid: sh.uid, name: sh.name, cost: sh.retrieveCost });
          } else {
            survivors.push(sh);
          }
        }

        if (!survivors.length) {
          report.success = false;
          const bits = [];
          if (report.lost.length) bits.push(`lost ${report.lost.map(x => x.name).join(", ")}`);
          if (report.impounded.length) bits.push(`impounded ${report.impounded.map(x => x.name).join(", ")}`);
          report.summary = `Charter wiped — ${bits.join("; ") || "no hulls returned"}.`;
        } else {
          const smuggle = c.band === "high" || c.band === "extreme";
          const prof = DMGCFG.types[smuggle ? "smuggle" : "transport"] || DMGCFG.types.transport;
          const dangerMult = DMGCFG.dangerMult[c.band] || 1;
          // A run that lost or surrendered hulls was a real incident — the
          // survivors don't come home untouched.
          const incident = report.lost.length || report.impounded.length;
          for (const sh of survivors) {
            if (Math.random() < (incident ? 1 : prof.chance)) {
              const before = sh.dmg || 0;
              Fleet.addDamage(sh, Util.randFloat(prof.dmg[0], prof.dmg[1]) * dangerMult);
              report.damaged.push({ uid: sh.uid, name: sh.name, pct: Math.round((sh.dmg - before) * 100) });
            }
            sh.status = "idle";
          }
          const rewardMult = window.Boosts ? (1 + Boosts.mag("contractReward")) : 1;
          const frac = this.payoutFrac(c, survivors);
          const gross = Math.round(c.reward * frac * (c.faction ? Rep.rewardMult(c.faction) : 1) * rewardMult);
          report.credits = Economy.afterTax(gross);
          report.taxed = gross - report.credits;
          report.cargoFrac = frac;
          s.credits += report.credits;
          s.stats.contractsDone = (s.stats.contractsDone || 0) + 1;
          if (c.faction) Rep.onContract(c.faction, smuggle ? "smuggle" : "transport", c.band);
          const lostNote = report.lost.length
            ? ` Lost ${report.lost.map(x => x.name).join(", ")}.` : "";
          const impNote = report.impounded.length
            ? ` Impounded ${report.impounded.map(x => x.name).join(", ")}.` : "";
          const cutNote = frac < 1 - 1e-9
            ? ` Payout cut to ${Math.round(frac * 100)}% — cargo hulls missing.` : "";
          report.summary = `${survivors.map(sh => sh.name).join(", ")} returned from ${art} ${bandLabel.toLowerCase()} charter (+${Util.credits(report.credits)}c).${lostNote}${impNote}${cutNote}`;
        }
      }

      s.reports.unshift(report);
      if (s.reports.length > 20) s.reports.length = 20;
      out.push(report);
      // Same after-action inbox as Fleet contracts (Dispatches → Fleet Ops).
      if (window.MissionStory) MissionStory.begin(report);
      Bus.emit("charterDone", report);
    }
    if (out.length) {
      s.charters = this.list().filter(c => !c.resolved);
      Economy.refreshNetWorth();
      Economy.checkAchievements();
    }
    return out;
  },

  // After a server ship slice, re-lock hulls still on open charters. With
  // charter_rpcs.sql applied the server already stamps 'charter' and this is a
  // no-op; it stays for the guest / older-SQL fallback path.
  reconcileShips() {
    const locked = new Set();
    for (const c of this.running()) for (const uid of this.shipUids(c)) locked.add(uid);
    for (const sh of this.s().ships || []) {
      if (locked.has(sh.uid) && sh.status !== "charter" && sh.status !== "impounded")
        sh.status = "charter";
    }
  },
};

window.Charters = Charters;
