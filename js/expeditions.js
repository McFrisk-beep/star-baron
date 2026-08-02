/* expeditions.js — anomaly surveys on the Star Map. Dispatch ONE idle ship to a
   non-tradeable backdrop system; after a distance-scaled round trip the survey
   MATURES into a Dispatches mini-story (SurveyStory) — choices, scan/endure
   odds, rewards — instead of auto-resolving. Farther = richer / rougher.

   Mirrors routes.js: state.expeditions, ships status "surveying" → "debrief"
   while the player finishes the thread. Cooldown (state.surveyed) applies when
   the dispatch closes.                                                        */

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

  // Scan success odds for a risky survey choice. Survey hulls + scanners help;
  // danger and hazard-kind events hurt. Endure softens hazard failure.
  choiceChance(base, scan, endure, danger, hazardish) {
    let c = base + scan * 0.06 - danger * 0.28;
    if (hazardish) c += endure * 0.04;
    if (window.Fleet) c += Fleet.mainBonus("survey") * 0.5;
    if (window.Boosts) c += Boosts.mag("surveyScan");   // Deep Lens blackbox
    return Util.clamp(c, 0.05, 0.95);
  },
  scanPower(shipUid) {
    const sh = Fleet.ship(shipUid); if (!sh) return 0;
    return Fleet.stats(sh).scan || 0;
  },

  // Dispatch one idle ship. Returns { ok, expedition } or { ok:false, msg }.
  start(sysId, shipUid, now = Date.now()) {
    const can = this.canSurvey(sysId, now); if (!can.ok) return can;
    const sh = Fleet.ship(shipUid);
    if (!sh || sh.status !== "idle") return { ok: false, msg: "Pick an idle ship." };
    if (sh.mercenary) return { ok: false, msg: "Mercenaries won't fly survey work." };
    const sys = Galaxy.get(sysId);
    const sig = sys && Galaxy.signatureCommodity ? Galaxy.signatureCommodity(sys) : null;
    const fac = sig && window.Rep ? Rep.factionForCategory(sig.cat) : null;
    const exp = { id: "xp" + (++this.s().seq), sysId, shipUid,
      startedAt: now, etaMs: this.durationFor(sysId, shipUid), far: this.isFar(sysId), danger: this.danger(sysId),
      // Phase 3: seed at dispatch so server resolve is reproducible
      rngSeed: (now ^ (this.s().seq * 2654435761)) >>> 0,
      faction: fac,
    };
    sh.status = "surveying";
    this.list().push(exp);
    Economy.refreshNetWorth();
    Bus.emit("surveyStart", exp);
    return { ok: true, expedition: exp };
  },

  progress(exp, now = Date.now()) { return Util.clamp((now - exp.startedAt) / exp.etaMs, 0, 1); },
  remaining(exp, now = Date.now()) { return Math.max(0, exp.startedAt + exp.etaMs - now); },

  // Mature finished survey trips into Dispatches debriefs (not auto-loot).
  // Returns stub reports for the "while you were away" recap ("awaiting debrief").
  // Phase 3 live: app_pull parks expeditions at debrief; openPendingDebriefs()
  // opens the Dispatches threads. Guests still mature here.
  resolve(now = Date.now()) {
    if (window.Routes && !Routes.softIncomeLocal()) {
      // Server already parked matured trips — just open any missing threads.
      this.openPendingDebriefs(now);
      return [];
    }
    const s = this.s(); const out = [];
    for (const exp of this.list()) {
      if (exp.resolved || exp.debrief || now < exp.startedAt + exp.etaMs) continue;
      exp.debrief = true;
      if (window.SurveyStory) {
        SurveyStory.begin(exp, now);
        const sys = Galaxy.get(exp.sysId);
        out.push({ uid: exp.id, type: "survey", title: `Survey — ${sys ? sys.name : "outpost"}`,
          success: true, ts: now, credits: 0, items: [], lost: [], damaged: [],
          summary: `Survey team returned from ${sys ? sys.name : "an outpost"} — debrief waiting in Dispatches.`,
          awaitingDebrief: true });
      } else {
        // Fallback if survey-story.js didn't load — quiet return home.
        const sh = Fleet.ship(exp.shipUid); if (sh) sh.status = "idle";
        exp.resolved = true;
        this.surveyed()[exp.sysId] = now;
      }
    }
    if (out.length) {
      // Keep debriefing expeditions in the list until SurveyStory.applyOutcome removes them.
      s.expeditions = this.list().filter(e => !e.resolved);
      for (const r of out) Bus.emit("surveyDone", r);
    }
    this.openPendingDebriefs(now);
    return out;
  },

  // Open SurveyStory threads for parked debriefs that don't have one yet
  // (after app_pull, or if begin() was skipped during boot).
  openPendingDebriefs(now = Date.now()) {
    if (!window.SurveyStory || !window.Story) return 0;
    let n = 0;
    for (const exp of this.list()) {
      if (!exp.debrief || exp.resolved) continue;
      const id = "survey_" + exp.id;
      const prog = Story.s() && Story.s().prog[id];
      if (prog) continue;
      if (SurveyStory.begin(exp, now)) n++;
    }
    return n;
  },
};

window.Expeditions = Expeditions;
