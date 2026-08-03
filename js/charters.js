/* charters.js — Charter Contracts. Stake an idle hull on a timed job from the
   Bazaar; payout is locked at dispatch; risk band + duration set destroy odds.
   Cancelling early costs credits; after bailoutAt the sponsor buys the ship out.
   Replaces automated trade routes (routes.js retired).

   ponytail: Phase 3 has no charter RPCs yet — resolve/mint stays behind
   Economy.softIncomeLocal() like the old routes. Add app_charter_* when the
   ledger needs to own these payouts.                                          */

const Charters = {
  s() { return window.Game.state; },
  list() { return this.s().charters || (this.s().charters = []); },
  active() { return this.list().filter(c => !c.resolved); },
  ofShip(uid) { return this.active().find(c => c.shipUid === uid) || null; },

  shipRate(ship) {
    const st = Fleet.stats(ship);
    return CHARTERCFG.rateBase
      + st.cargo * CHARTERCFG.rateCargo
      + st.firepower * CHARTERCFG.rateFirepower;
  },

  quote(ship, band, durationMs) {
    const h = durationMs / 3600000;
    const pay = (DANGER.find(d => d.id === band) || DANGER[0]).pay;
    const raw = this.shipRate(ship) * pay * Math.pow(h, CHARTERCFG.taperExp);
    const cap = CHARTERCFG.payoutCapMult
      ? Economy.depth() * CHARTERCFG.payoutCapMult : Infinity;
    return Math.round(Math.min(raw, cap) / 10) * 10;
  },

  durationRiskMult(h) { return Math.pow(Math.max(h, 0.5), CHARTERCFG.durationRiskExp); },

  hullFactor(ship) {
    const st = Fleet.stats(ship);
    return Util.clamp(
      CHARTERCFG.hullSoftness / Math.max(1, st.hull + st.armor * 2 + st.shields * 2),
      CHARTERCFG.hullFactorClamp[0], CHARTERCFG.hullFactorClamp[1]
    );
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

  destroyChance(ship, band, durationMs) {
    const b = CHARTER_BANDS[band] || CHARTER_BANDS.safe;
    const safe = window.Fleet ? Fleet.mainBonus("routeSafe") : 0;
    return Util.clamp(
      b.destroy * this.durationRiskMult(durationMs / 3600000)
        * this.hullFactor(ship) * (1 - safe) * this._senateRiskMult(),
      0, 0.85
    );
  },

  impoundChance(ship, band, durationMs) {
    const b = CHARTER_BANDS[band] || CHARTER_BANDS.safe;
    if (!(b.impound > 0)) return 0;
    const safe = window.Fleet ? Fleet.mainBonus("routeSafe") : 0;
    return Util.clamp(
      b.impound * this.durationRiskMult(durationMs / 3600000)
        * this.hullFactor(ship) * (1 - safe) * this._senateRiskMult(),
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

  dispatch(shipUid, band, durationMin, now = Date.now()) {
    const s = this.s();
    const sh = Fleet.ship(shipUid);
    if (!sh) return { ok: false, msg: "Ship not found." };
    if (sh.mercenary) return { ok: false, msg: "Mercenaries can't take charters." };
    if (sh.status !== "idle") return { ok: false, msg: "Ship must be idle." };
    if (!CHARTER_BANDS[band]) return { ok: false, msg: "Unknown risk band." };
    if (!CHARTERCFG.durations.includes(+durationMin)) return { ok: false, msg: "Pick a listed duration." };
    if (this.active().length >= CHARTERCFG.maxActive) return { ok: false, msg: `At most ${CHARTERCFG.maxActive} charters at once.` };
    // Don't leave the player with zero free hulls and no credits to act.
    const freeHulls = Fleet.idle().filter(x => !x.mercenary && x.uid !== shipUid).length;
    if (freeHulls === 0 && s.credits <= 0)
      return { ok: false, msg: "Can't charter your last hull with no credits left — you'd be stranded." };

    const durationMs = (+durationMin) * 60000;
    const reward = this.quote(sh, band, durationMs);
    const destroy = this.destroyChance(sh, band, durationMs);
    const bandInfo = CHARTER_BANDS[band];
    const charter = {
      id: "ch" + (++s.seq),
      shipUid: sh.uid,
      band,
      durationMs,
      startedAt: now,
      reward,
      faction: bandInfo.faction,
      destroyChance: destroy,
      impoundChance: this.impoundChance(sh, band, durationMs),
      impound: (bandInfo.impound || 0) > 0,
      resolved: false,
    };
    sh.status = "charter";
    this.list().push(charter);
    Economy.refreshNetWorth();
    Bus.emit("charterStart", charter);
    return { ok: true, charter };
  },

  cancel(id, now = Date.now()) {
    const s = this.s();
    const c = this.list().find(x => x.id === id);
    if (!c || c.resolved) return { ok: false, msg: "Charter not found." };
    const value = this.cancelValue(c, now);
    if (value < 0 && s.credits < -value)
      return { ok: false, msg: `Need ${Util.credits(-value)}c to abort — not enough credits.` };
    s.credits += value;
    const sh = Fleet.ship(c.shipUid);
    if (sh && sh.status === "charter") sh.status = "idle";
    const repHit = c.faction ? Rep.onContractCancel(c.faction, c.band) : 0;
    s.charters = this.list().filter(x => x.id !== id);
    Economy.refreshNetWorth();
    Bus.emit("charterCancel", { charter: c, value, repHit });
    return { ok: true, value, repHit, charter: c };
  },

  // Resolve matured charters. Returns reports (also pushed to state.reports).
  resolve(now = Date.now()) {
    // Phase 3 live: server ledger owns soft income — don't mint (or free the
    // hull) until app_charter_* exists. Guests / pullMissing fall through.
    if (window.Economy && !Economy.softIncomeLocal()) return [];
    const s = this.s();
    const out = [];
    for (const c of this.list()) {
      if (c.resolved || now < c.startedAt + c.durationMs) continue;
      c.resolved = true;
      const sh = Fleet.ship(c.shipUid);
      const bandLabel = (DANGER.find(d => d.id === c.band) || {}).label || c.band;
      const report = {
        uid: c.id, title: `Charter — ${bandLabel}`, type: "charter",
        success: true, ts: now, danger: c.band, faction: c.faction || null,
        credits: 0, items: [], stock: null, lost: [], impounded: [], damaged: [],
        shipName: sh ? sh.name : null,
      };

      if (!sh) {
        report.success = false;
        report.summary = "Charter closed — hull already gone.";
      } else if (Math.random() < (c.destroyChance || 0)) {
        report.success = false;
        report.lost.push({ uid: sh.uid, name: sh.name });
        s.ships = s.ships.filter(x => x.uid !== sh.uid);
        report.summary = `${sh.name} lost on a ${bandLabel.toLowerCase()} charter.`;
      } else if (c.impound && Math.random() < (c.impoundChance || 0)) {
        report.success = false;
        sh.status = "impounded";
        sh.retrieveCost = Math.round((Fleet.shipDef(sh.type).price || 2000) * 0.5) || 1500;
        report.impounded.push({ uid: sh.uid, name: sh.name, cost: sh.retrieveCost });
        report.summary = `${sh.name} impounded on a contraband charter — retrieve for ${Util.credits(sh.retrieveCost)}c.`;
      } else {
        const smuggle = c.band === "high" || c.band === "extreme";
        const prof = DMGCFG.types[smuggle ? "smuggle" : "transport"] || DMGCFG.types.transport;
        const dangerMult = DMGCFG.dangerMult[c.band] || 1;
        if (Math.random() < prof.chance) {
          const before = sh.dmg || 0;
          Fleet.addDamage(sh, Util.randFloat(prof.dmg[0], prof.dmg[1]) * dangerMult);
          report.damaged.push({ uid: sh.uid, name: sh.name, pct: Math.round((sh.dmg - before) * 100) });
        }
        const rewardMult = window.Boosts ? (1 + Boosts.mag("contractReward")) : 1;
        const gross = Math.round(c.reward * (c.faction ? Rep.rewardMult(c.faction) : 1) * rewardMult);
        report.credits = Economy.afterTax(gross);
        report.taxed = gross - report.credits;
        s.credits += report.credits;
        s.stats.contractsDone = (s.stats.contractsDone || 0) + 1;
        if (c.faction) Rep.onContract(c.faction, smuggle ? "smuggle" : "transport", c.band);
        sh.status = "idle";
        report.summary = `${sh.name} returned from a ${bandLabel.toLowerCase()} charter (+${Util.credits(report.credits)}c).`;
      }

      s.reports.unshift(report);
      if (s.reports.length > 20) s.reports.length = 20;
      out.push(report);
      Bus.emit("charterDone", report);
    }
    if (out.length) {
      s.charters = this.list().filter(c => !c.resolved);
      Economy.refreshNetWorth();
      Economy.checkAchievements();
    }
    return out;
  },

  // After a server ship slice, re-lock hulls still on open charters.
  // ponytail: drop once app_charter_* owns ship status on the ledger.
  reconcileShips() {
    const locked = new Set(this.active().map(c => c.shipUid));
    for (const sh of this.s().ships || []) {
      if (locked.has(sh.uid) && sh.status !== "charter" && sh.status !== "impounded")
        sh.status = "charter";
    }
  },
};

window.Charters = Charters;
