/* expeditions.js — anomaly surveys on the Star Map. Dispatch ONE idle ship to a
   non-tradeable backdrop system; after a distance-scaled round trip it resolves
   (live in the loop OR once during offline catch-up) into a weighted outcome:
   derelict gear, a fresh commodity seam (a real local price event = tradeable
   insight), a credit windfall, a faction cache, a hull-damaging hazard (rarely
   fatal), or a dry hole. Farther = richer loot and rougher hazards.

   Mirrors routes.js: an array in state.expeditions, ships flagged with a
   non-idle status ("surveying") so missions/routes/repair auto-skip them, and a
   resolve(now) that matures completed surveys. Reuses Incidents.apply for
   credit/rep/item effects, Items.gen for gear, Fleet.addDamage for hazards,
   and Galaxy.fireLocalEvent for the seam. A per-system cooldown (state.surveyed)
   stops back-to-back farming.

   ponytail: one ship per survey (run several concurrently for fleet use) — add
   a group/pooled-scan bonus here if solo surveys feel thin.                    */

const Expeditions = {
  s() { return window.Game.state; },
  list() { return this.s().expeditions || (this.s().expeditions = []); },
  surveyed() { return this.s().surveyed || (this.s().surveyed = {}); },
  activeFor(sysId) { return this.list().find(e => e.sysId === sysId) || null; },

  // Map distance (0..~1) from the docked system to the target — drives both the
  // trip time and the danger band. Uses the deterministic galaxy positions.
  distanceTo(sysId) {
    const here = Galaxy.get(this.s().currentSystem), there = Galaxy.get(sysId);
    if (!here || !there) return 0.2;
    return Math.hypot(here.pos.x - there.pos.x, here.pos.y - there.pos.y);
  },
  isFar(sysId) { return this.distanceTo(sysId) >= EXPEDCFG.farAt; },
  danger(sysId) { return Util.clamp(this.distanceTo(sysId) / 0.6, 0, 1); },   // 0.6 map-units ≈ max danger

  durationFor(sysId, shipUid) {
    const sh = Fleet.ship(shipUid);
    const speed = (sh ? Fleet.stats(sh).speed || 1 : 1) * (window.Senate ? Senate.travelSpeedMult() : 1);
    const seconds = (2 * this.distanceTo(sysId) * EXPEDCFG.legSecondsPerDist) / speed;
    return Math.max(EXPEDCFG.minMs, seconds * 1000 / (window.Game.timeScale || 1));
  },

  cooldownLeft(sysId, now = Date.now()) {
    const done = this.surveyed()[sysId] || 0;
    return Math.max(0, done + EXPEDCFG.cooldownMs - now);
  },
  canSurvey(sysId, now = Date.now()) {
    const sys = Galaxy.get(sysId);
    if (!sys) return { ok: false, msg: "No such system." };
    if (sys.tradeable) return { ok: false, msg: "Trade hubs are charted — nothing to survey." };
    if (this.activeFor(sysId)) return { ok: false, msg: "A survey is already under way here." };
    if (this.cooldownLeft(sysId, now) > 0) return { ok: false, msg: `Recently surveyed — try again in ${Util.duration(this.cooldownLeft(sysId, now))}.` };
    return { ok: true };
  },

  // Dispatch one idle ship. Returns { ok, expedition } or { ok:false, msg }.
  start(sysId, shipUid, now = Date.now()) {
    const can = this.canSurvey(sysId, now); if (!can.ok) return can;
    const sh = Fleet.ship(shipUid);
    if (!sh || sh.status !== "idle") return { ok: false, msg: "Pick an idle ship." };
    if (sh.mercenary) return { ok: false, msg: "Mercenaries won't fly survey work." };
    const exp = { id: "xp" + (++this.s().seq), sysId, shipUid,
      startedAt: now, etaMs: this.durationFor(sysId, shipUid), far: this.isFar(sysId), danger: this.danger(sysId) };
    sh.status = "surveying";
    this.list().push(exp);
    Economy.refreshNetWorth();
    Bus.emit("surveyStart", exp);
    return { ok: true, expedition: exp };
  },

  progress(exp, now = Date.now()) { return Util.clamp((now - exp.startedAt) / exp.etaMs, 0, 1); },
  remaining(exp, now = Date.now()) { return Math.max(0, exp.startedAt + exp.etaMs - now); },

  // Mature every finished survey up to `now`. Returns the reports (also pushed
  // to state.reports so the Fleet panel + "While You Were Away" recap show them).
  resolve(now = Date.now()) {
    const s = this.s(); const out = [];
    for (const exp of this.list()) {
      if (exp.resolved || now < exp.startedAt + exp.etaMs) continue;
      exp.resolved = true;
      const report = this._resolveOne(exp, now);
      s.reports.unshift(report);
      if (s.reports.length > 20) s.reports.length = 20;
      this.surveyed()[exp.sysId] = now;
      out.push(report);
    }
    if (out.length) {
      s.expeditions = this.list().filter(e => !e.resolved);
      Economy.refreshNetWorth();
      Economy.checkAchievements();
      for (const r of out) Bus.emit("surveyDone", r);
    }
    return out;
  },

  _resolveOne(exp, now) {
    const sys = Galaxy.get(exp.sysId);
    const sysName = sys ? sys.name : "an outpost";
    const sh = Fleet.ship(exp.shipUid);
    const report = { uid: exp.id, type: "survey", title: `Survey — ${sysName}`, sysName,
      success: true, ts: now, credits: 0, items: [], lost: [], damaged: [], summary: "" };
    // ship vanished mid-survey (sold?/prestige) — nothing to bring home
    if (!sh) { report.success = false; report.summary = `Lost contact with the survey ship near ${sysName}.`; return report; }

    const band = exp.far ? "far" : "near";
    const kind = this._roll(EXPEDCFG.weights[band]);

    if (kind === "gear") {
      const bias = EXPEDCFG.rarityBiasMax * exp.danger;
      const it = Items.gen({ bias });
      if (Bazaar.inventoryUsed() < Bazaar.capacity()) { this.s().items[it.uid] = it; report.items.push(it); report.summary = `Boarded a derelict off ${sysName} — recovered ${it.name}.`; }
      else report.summary = `Found salvage off ${sysName}, but your hold was full.`;
      sh.status = "idle";
    } else if (kind === "seam") {
      const scarce = Math.random() < 0.5;
      const comm = Galaxy.signatureCommodity(sys);
      const ev = { id: "survey_seam", scope: "comm", dir: scarce ? "up" : "down",
        mult: scarce ? EXPEDCFG.seamMult.scarce : EXPEDCFG.seamMult.glut,
        headline: scarce ? "SURVEY FLAGS {COMM} SHORTFALL NEAR {PLANET}" : "SURVEY STRIKES RICH {COMM} SEAM NEAR {PLANET}",
        body: scarce ? "A baron's survey team maps a failing {COMM} field at {SYS} — it'll grow scarce and dear here."
                     : "A baron's survey team cracks a fresh {COMM} seam at {SYS} — prices soften locally." };
      Galaxy.fireLocalEvent(now, sys.id, ev);
      report.summary = `Survey mapped a ${comm.name} ${scarce ? "shortfall" : "seam"} at ${sysName} — ${scarce ? "prices climbing" : "prices dropping"} there. Trade the tip.`;
      sh.status = "idle";
    } else if (kind === "credits") {
      const range = EXPEDCFG.creditsBy[band];
      const amt = Util.randInt(range[0], range[1]);
      this.s().credits += amt; report.credits = amt;         // salvage windfall (untaxed, like an incident payout)
      report.summary = `Salvaged and sold data from ${sysName} — +${Util.credits(amt)}c.`;
      sh.status = "idle";
    } else if (kind === "faction") {
      const fac = Rep.factionForCategory(Galaxy.signatureCommodity(sys).cat);
      const amt = 3 + Math.round(exp.danger * 4);
      Incidents.apply({ rep: [[fac, amt]] });
      report.summary = `Recovered a ${(FACTIONS[fac] || {}).name || fac} cache at ${sysName} — standing +${amt}.`;
      sh.status = "idle";
    } else if (kind === "hazard") {
      const fatal = Math.random() < EXPEDCFG.destroyChance * (0.5 + exp.danger);
      if (fatal) {
        report.success = false; report.lost.push({ uid: sh.uid, name: sh.name });
        this.s().ships = this.s().ships.filter(x => x.uid !== sh.uid);
        report.summary = `${sh.name} was lost to a hazard while surveying ${sysName}.`;
      } else {
        const before = sh.dmg || 0;
        Fleet.addDamage(sh, Util.randFloat(EXPEDCFG.hazardDmg[0], EXPEDCFG.hazardDmg[1]) * (0.6 + exp.danger));
        report.damaged.push({ uid: sh.uid, name: sh.name, pct: Math.round((sh.dmg - before) * 100) });
        report.summary = `${sh.name} limped home from ${sysName} shaken but intact — a rough scan.`;
        sh.status = "idle";
      }
    } else { // dry
      report.summary = `Charted ${sysName}. Nothing of value out there — this time.`;
      sh.status = "idle";
    }
    return report;
  },

  // Weighted pick over an outcome-weights object.
  _roll(weights) {
    const entries = Object.entries(weights);
    const total = entries.reduce((n, [, w]) => n + w, 0);
    let x = Math.random() * total;
    for (const [k, w] of entries) { x -= w; if (x <= 0) return k; }
    return entries[0][0];
  },
};

window.Expeditions = Expeditions;
