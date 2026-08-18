/* survey-story.js — matured anomaly surveys open a Dispatches mini-story
   instead of auto-paying. Ship + survey gear (scan / endure) shift the odds on
   risky choices; buttons show success %. Outcomes apply when the thread ends. */

const SurveyStory = {
  PORTRAIT: 1,

  // Event templates. `kind` ties to EXPEDCFG.weights. Each builds dialogue steps;
  // risky choices use baseChance, scaled by Expeditions.successChance(scan,…).
  EVENTS: [
    { id: "derelict_hold", kind: "derelict", from: "Survey Ops",
      open: "Beacon lock on a silent freighter off {SYS}. Transponder reads 'salvage rights disputed.' Your {SHIP} reports scan {SCAN}. Approach?",
      pushLabel: "Board the freighter", pushBase: 0.55,
      pushOk: "Airlock yields. Hold still has sealed crates — and a few opinions about ownership.",
      pushFail: "Boarding clamps shear. Something in the dark takes a bite out of the hull.",
      leave: "Mark it and burn out. Some freighters stay silent for a reason.",
      rewardOk: { credits: [800, 2800], item: true, materials: true },
      rewardFail: { hazard: true },
      leaveReward: { credits: [100, 400] } },
    { id: "ghost_signal", kind: "signal", from: "Survey Ops",
      open: "A repeating ping from the {SYS} debris belt. Pattern looks League, then Syndicate, then neither. Scan {SCAN}. Chase it?",
      pushLabel: "Chase the ping", pushBase: 0.50,
      pushOk: "Ping resolves into a cache buoy. Data sells. Conscience optional.",
      pushFail: "Ping was a lure. Micrometeor screen eats your approach vector.",
      leave: "Let the ghost talk to itself.",
      rewardOk: { credits: [600, 2200], rep: true, materials: true },
      rewardFail: { hazard: true },
      leaveReward: {} },
    { id: "ore_whisper", kind: "seam", from: "Survey Ops",
      open: "Magnetics around {SYS} scream 'seam' — or 'sensor ghost.' Pushing the array harder risks frying it. Scan {SCAN}.",
      pushLabel: "Force a deep map", pushBase: 0.58,
      pushOk: "Confirmed. Local {COMM} field mapped — prices will move.",
      pushFail: "Array blooms with static. You chart noise and a headache.",
      leave: "Log a soft ping. Sell the rumor, not the map.",
      rewardOk: { seam: true },
      rewardFail: { credits: [50, 200] },
      leaveReward: { credits: [200, 700] } },
    { id: "ruin_gate", kind: "ruin", from: "Survey Ops",
      open: "Stonework that isn't stone — a ruin gate tumbling sunward of {SYS}. Inscriptions match no current faction. Enter?",
      pushLabel: "Send a probe team", pushBase: 0.45,
      pushOk: "The gate accepts the probe. Relic gear comes back singing.",
      pushFail: "The gate closes on the probe. Feedback walks up the tether into your hull.",
      leave: "Photograph from range. Archaeologists can sue each other later.",
      rewardOk: { item: "rare", credits: [400, 1500], materials: true },
      rewardFail: { hazard: true },
      leaveReward: { credits: [150, 500] } },
    { id: "cache_drop", kind: "faction", from: "Survey Ops",
      open: "A faction drop-pod tumbling cold near {SYS}. Seals look bribeable. Scan {SCAN}. Crack it?",
      pushLabel: "Crack the seals", pushBase: 0.60,
      pushOk: "Standing improved with whoever stocked the pod. They'll deny it.",
      pushFail: "Tamper charge. The pod objects.",
      leave: "Ping the nearest patrol and take a finder's fee.",
      rewardOk: { rep: true, credits: [300, 1200] },
      rewardFail: { hazard: true },
      leaveReward: { credits: [400, 900] } },
    { id: "credit_drift", kind: "credits", from: "Survey Ops",
      open: "Ice-locked cargo pods adrift off {SYS}. Easy credits if the clamps hold. Scan {SCAN}.",
      pushLabel: "Grapple the pods", pushBase: 0.65,
      pushOk: "Clamps hold. Salvage sells clean.",
      pushFail: "A pod spins wrong. Cable snags and kisses the plating.",
      leave: "Too messy. Burn past.",
      rewardOk: { credits: [500, 2500], materials: true },
      rewardFail: { hazard: true, credits: [100, 300] },
      leaveReward: {} },
    { id: "gear_locker", kind: "gear", from: "Survey Ops",
      open: "A cracked survey locker from some forgotten cartograph. Tools still blink. Claim?",
      pushLabel: "Crack the locker", pushBase: 0.62,
      pushOk: "Gear recovered — scanners love company.",
      pushFail: "Locker was booby-trapped with a polite amount of shrapnel.",
      leave: "Leave it for the next optimistic baron.",
      rewardOk: { item: true, preferSurvey: true },
      rewardFail: { hazard: true },
      leaveReward: {} },
    { id: "dry_chart", kind: "dry", from: "Survey Ops",
      open: "You chart {SYS}. Rock, dust, and the universe's opinion of your ambition. Still — a thorough map has buyers.",
      pushLabel: "Sell the chart cold", pushBase: 0.80,
      pushOk: "A mid-tier desk pays for thorough boredom.",
      pushFail: "Buyer ghosted. You keep the dust.",
      leave: "File it under 'been for later.'",
      rewardOk: { credits: [200, 900] },
      rewardFail: {},
      leaveReward: {} },
    { id: "hazard_bloom", kind: "hazard", from: "Survey Ops",
      open: "Radiation bloom swelling near {SYS}. Your endure rating is {ENDURE}. Push for a sample, or abort?",
      pushLabel: "Sample the bloom", pushBase: 0.40,
      pushOk: "Sample bottled. Science (and the black market) pays.",
      pushFail: "Bloom bites back. Hull complains in several languages.",
      leave: "Abort. Live barons chart more systems.",
      rewardOk: { credits: [1000, 3500], item: true, materials: true },
      rewardFail: { hazard: true },
      leaveReward: { credits: [50, 150] } },
    { id: "mirror_wreck", kind: "derelict", from: "Survey Ops",
      open: "Wreck geometry mirrors your own {SHIP} silhouette. Coincidence, joke, or trap. Scan {SCAN}.",
      pushLabel: "Dock with the mirror", pushBase: 0.48,
      pushOk: "Not a mirror — a cousin. Loot and a bad feeling.",
      pushFail: "It was a trap with good taste. Shields flare.",
      leave: "Break lock. Some jokes write themselves in hull plating.",
      rewardOk: { credits: [700, 2400], item: true, materials: true },
      rewardFail: { hazard: true },
      leaveReward: {} },
    { id: "senate_buoy", kind: "signal", from: "Survey Ops",
      open: "A Senate weather buoy dumped classified hop data near {SYS}. Hot property. Scan {SCAN}.",
      pushLabel: "Strip the buoy", pushBase: 0.52,
      pushOk: "Data sells to three desks who hate each other. Perfect.",
      pushFail: "Buoy self-wipes and files a complaint with your paint job.",
      leave: "Ping Aide Pell's cousins and take a quiet tip.",
      rewardOk: { credits: [900, 3000] },
      rewardFail: { hazard: true },
      leaveReward: { credits: [350, 800], rep: true } },
    { id: "colony_beacon", kind: "ruin", from: "Survey Ops",
      open: "Pre-Guild colony beacon still broadcasting a harvest prayer at {SYS}. Dig?",
      pushLabel: "Excavate the beacon", pushBase: 0.50,
      pushOk: "Buried seed-vault tech. Agri desks will duel over it.",
      pushFail: "Cave-in. The prayer continues without you.",
      leave: "Record the hymn. Sell the vibe.",
      rewardOk: { seam: true, credits: [400, 1400], materials: true },
      rewardFail: { hazard: true },
      leaveReward: { credits: [180, 600] } },
  ],

  s() { return window.Game && window.Game.state; },

  // Pick a template biased by EXPEDCFG weights for near/far.
  pickEvent(exp) {
    const band = exp.far ? "far" : "near";
    const weights = (window.EXPEDCFG && EXPEDCFG.weights[band]) || {};
    const pool = [];
    for (const ev of this.EVENTS) {
      const w = weights[ev.kind] != null ? weights[ev.kind] : 1;
      for (let i = 0; i < w; i++) pool.push(ev);
    }
    return Util.pick(pool.length ? pool : this.EVENTS);
  },

  fill(text, ctx) {
    return String(text || "")
      .replace(/\{SYS\}/g, ctx.sysName)
      .replace(/\{SHIP\}/g, ctx.shipName)
      .replace(/\{SCAN\}/g, ctx.scan.toFixed(1))
      .replace(/\{ENDURE\}/g, ctx.endure.toFixed(1))
      .replace(/\{COMM\}/g, ctx.commName)
      .replace(/\{PCT\}/g, ctx.pct != null ? ctx.pct : "");
  },

  // Called when an expedition timer matures — opens a Dispatches thread.
  begin(exp, now = Date.now()) {
    const st = this.s(); if (!st || !window.Story) return null;
    const sys = Galaxy.get(exp.sysId);
    const sysName = sys ? sys.name : "an outpost";
    const sh = Fleet.ship(exp.shipUid);
    if (!sh) {
      return this._lostContact(exp, sysName, now);
    }
    const stats = Fleet.stats(sh);
    const scan = stats.scan || 0;
    const endure = stats.endure || 0;
    const sig = sys && Galaxy.signatureCommodity ? Galaxy.signatureCommodity(sys) : null;
    const tpl = this.pickEvent(exp);
    const pushChance = Expeditions.choiceChance(tpl.pushBase, scan, endure, exp.danger, tpl.kind === "hazard");
    const pct = Math.round(pushChance * 100);
    const ctx = { sysName, shipName: sh.name, scan, endure, commName: (sig && sig.name) || "ore", pct };

    const id = "survey_" + exp.id;
    const steps = [
      { key: "open", text: this.fill(tpl.open, ctx),
        choices: [
          { label: `${tpl.pushLabel} (${pct}% success)`, reply: "Pushing the approach.",
            chance: pushChance,
            ack: this.fill(tpl.pushOk, ctx),
            failAck: this.fill(tpl.pushFail, ctx),
            reward: { _survey: { expId: exp.id, outcome: "push_ok", tplId: tpl.id } },
            failReward: { _survey: { expId: exp.id, outcome: "push_fail", tplId: tpl.id } },
            end: true },
          { label: "Break off / play it safe", reply: "Breaking off.",
            ack: this.fill(tpl.leave, ctx),
            reward: { _survey: { expId: exp.id, outcome: "leave", tplId: tpl.id } },
            end: true },
        ],
        replies: [
          { label: "How bad is the risk?", reply: "Give me the risk picture.",
            ack: `Scan ${scan.toFixed(1)} · endure ${endure.toFixed(1)} · danger band ${(exp.danger * 100).toFixed(0)}%. Push success ≈ ${pct}%. Better scanners and survey hulls move that needle.` },
        ] },
    ];

    const sl = {
      id, kind: "job", from: tpl.from || "Survey Ops", portrait: this.PORTRAIT,
      outro: `Survey Ops: “${sysName} filed. Ship released.”`,
      steps, _survey: true, _expId: exp.id,
    };

    st.story = st.story || Story.s();
    const story = Story.s();
    story.ephemeral = story.ephemeral || {};
    story.ephemeral[id] = sl;
    story.prog[id] = { step: 0, base: Story.snap(st), status: "active", accepted: true };
    sh.status = "debrief";
    Story._postIn(sl, steps[0]);
    if (window.UI && UI.bumpComms) UI.bumpComms();
    Bus.emit("surveyDebrief", { exp, id });
    return { id, sl };
  },

  // Ship gone (sold / lost) before the debrief could open. Close the expedition
  // for good — leaving it unresolved made openPendingDebriefs re-fire this every
  // loop tick: a duplicate report per tick and the system blocked forever.
  _lostContact(exp, sysName, now) {
    const s = this.s();
    exp.resolved = true;
    s.expeditions = (s.expeditions || []).filter(e => e.id !== exp.id);
    Expeditions.surveyed()[exp.sysId] = now;
    if ((s.reports || []).some(r => r.uid === exp.id)) return null;   // already filed
    const report = { uid: exp.id, type: "survey", title: `Survey — ${sysName}`, sysName,
      success: false, ts: now, credits: 0, items: [], lost: [], damaged: [],
      summary: `Lost contact with the survey ship near ${sysName}.` };
    s.reports.unshift(report);
    if (s.reports.length > 20) s.reports.length = 20;
    Bus.emit("surveyDone", report);
    return null;
  },

  // Apply a finished survey choice. Called from Story.grant when reward._survey set.
  // Guest: local mint. Phase 3 live: app_survey_debrief banks the ledger.
  applyOutcome(payload) {
    const st = this.s(); if (!st || !payload) return "";
    const auth = !!(window.Economy && !Economy.softIncomeLocal()
      && window.Cloud && Cloud.surveyDebrief);
    if (auth) return this._applyAuth(payload);
    return this._applyLocal(payload);
  },

  async _applyAuth(payload) {
    try {
      const r = await Cloud.surveyDebrief(payload.expId, payload.outcome);
      if (!r || r.ok === false) {
        if (this._deadDebrief(r)) {
          // Server already settled (or never had) this survey — nothing to retry.
          this._releaseOnly(payload.expId);
          return (r && (r.error || r.msg)) || "Survey filed.";
        }
        return this._queueRetry(payload);
      }
      return this._applyDebriefResult(r, payload.expId);
    } catch (e) {
      if (typeof Cloud._isMissingRpc === "function" && Cloud._isMissingRpc(e)) {
        // Phase 3 SQL not installed — no server ledger to retry against.
        this._releaseOnly(payload.expId);
        return "Survey filed (offline).";
      }
      return this._queueRetry(payload);
    }
  },

  // A failure that can never succeed on retry (survey gone / bad outcome), as
  // opposed to a dropped packet or a busy server.
  _deadDebrief(r) {
    return r && /not found|missing expedition|bad survey outcome/i
      .test(String(r.error || r.msg || ""));
  },

  _applyDebriefResult(r, expId) {
    const st = this.s();
    if (window.Economy && Economy._applyServerSlice) Economy._applyServerSlice(r);
    else {
      if (r.credits != null) st.credits = r.credits;
      if (r.ships) st.ships = r.ships;
      if (r.expeditions) st.expeditions = r.expeditions;
      if (r.surveyed) st.surveyed = r.surveyed;
      if (r.reports) st.reports = r.reports;
      if (r.reputation) st.reputation = r.reputation;
    }
    // Drop the ephemeral thread's expedition if the slice lagged.
    st.expeditions = (st.expeditions || []).filter(e => e.id !== expId);
    st.surveyRetry = (st.surveyRetry || []).filter(q => q.expId !== expId);
    const report = r.report || { uid: expId, type: "survey", success: true,
      summary: r.summary || "Survey filed.", ts: Date.now(), credits: 0, items: [], lost: [], damaged: [] };
    if (window.Economy) {
      Economy.refreshNetWorth();
      try { Economy.checkAchievements(); } catch (e) { /* tests */ }
    }
    Bus.emit("surveyDone", report);
    return r.summary || report.summary || "Survey filed.";
  },

  // A dropped packet here used to brick the ship: the thread closed, the
  // expedition was deleted client-side, and the next commit dropped it
  // server-side — with the hull stamped "debrief" forever and the debrief that
  // could release it gone. Instead: park the chosen outcome on a client-owned
  // key and re-file until the server answers. The expedition (and the hull's
  // debrief status) stay put meanwhile, so nothing desyncs.
  _queueRetry(payload) {
    const st = this.s();
    st.surveyRetry = st.surveyRetry || [];
    if (!st.surveyRetry.some(q => q.expId === payload.expId))
      st.surveyRetry.push({ expId: payload.expId, outcome: payload.outcome, tplId: payload.tplId });
    return "Link dropped mid-debrief — Survey Ops will re-file automatically.";
  },

  _retryAt: 0,
  _retryBusy: false,
  // Re-file queued debriefs (called from the main loop when authoritative).
  async retryPending(now = Date.now()) {
    const st = this.s(); if (!st || !(st.surveyRetry || []).length) return;
    if (this._retryBusy || now - this._retryAt < 30000) return;
    if (window.Economy && (Economy.busy() || Economy.softIncomeLocal())) return;
    if (!(window.Cloud && Cloud.surveyDebrief)) return;
    this._retryAt = now;
    this._retryBusy = true;
    const q = st.surveyRetry[0];
    try {
      if (!(st.expeditions || []).some(e => e.id === q.expId)) {
        // Expedition gone (a slice already settled it) — nothing left to file.
        st.surveyRetry = st.surveyRetry.filter(x => x.expId !== q.expId);
        return;
      }
      const r = await Cloud.surveyDebrief(q.expId, q.outcome);
      if (r && r.ok !== false) {
        const summary = this._applyDebriefResult(r, q.expId);
        if (window.UI && UI.toast) UI.toast(summary, "good");
        if (window.Game) Game.requestSave();
      } else if (this._deadDebrief(r)) {
        this._releaseOnly(q.expId);
      }
      // Any other failure: stay queued for the next window.
    } catch (e) {
      if (typeof Cloud._isMissingRpc === "function" && Cloud._isMissingRpc(e)) this._releaseOnly(q.expId);
    } finally {
      this._retryBusy = false;
    }
  },

  _releaseOnly(expId) {
    const st = this.s(); if (!st) return;
    const exp = (st.expeditions || []).find(e => e.id === expId);
    const sh = exp ? Fleet.ship(exp.shipUid) : null;
    if (sh && (sh.status === "debrief" || sh.status === "surveying")) sh.status = "idle";
    if (exp) {
      Expeditions.surveyed()[exp.sysId] = Date.now();
      st.expeditions = (st.expeditions || []).filter(e => e.id !== expId);
    }
    st.surveyRetry = (st.surveyRetry || []).filter(q => q.expId !== expId);
  },

  _applyLocal(payload) {
    const st = this.s(); if (!st || !payload) return "";
    const exp = (st.expeditions || []).find(e => e.id === payload.expId)
      || (st.surveyPending || []).find(e => e.id === payload.expId);
    const tpl = this.EVENTS.find(e => e.id === payload.tplId) || this.EVENTS[0];
    const now = Date.now();
    const sys = exp ? Galaxy.get(exp.sysId) : null;
    const sysName = sys ? sys.name : "an outpost";
    const sh = exp ? Fleet.ship(exp.shipUid) : null;
    const report = { uid: exp ? exp.id : ("xp" + now), type: "survey", title: `Survey — ${sysName}`, sysName,
      success: true, ts: now, credits: 0, items: [], lost: [], damaged: [], summary: "" };

    const spec = payload.outcome === "push_ok" ? tpl.rewardOk
      : payload.outcome === "push_fail" ? tpl.rewardFail
      : tpl.leaveReward;

    if (payload.outcome === "push_fail") report.success = false;

    this._pay(spec, exp, sh, report, sys);

    if (sh && sh.status === "debrief") sh.status = "idle";
    if (exp) {
      Expeditions.surveyed()[exp.sysId] = now;
      st.expeditions = (st.expeditions || []).filter(e => e.id !== exp.id);
      st.surveyPending = (st.surveyPending || []).filter(e => e.id !== exp.id);
    }
    st.reports.unshift(report);
    if (st.reports.length > 20) st.reports.length = 20;
    if (window.Economy) {
      Economy.refreshNetWorth();
      try { Economy.checkAchievements(); } catch (e) { /* save-shaped state may lack achievements during tests */ }
    }
    Bus.emit("surveyDone", report);
    return report.summary || "Survey filed.";
  },

  _pay(spec, exp, sh, report, sys) {
    if (!spec) { report.summary = `Charted ${report.sysName}.`; return; }
    // Guest/offline: mint credits/items locally. Phase 3 live (!softIncomeLocal):
    // skip — same accepted follow-up as Story.grant (server ledger / app_pull would
    // overwrite soft mints). Ship release + report still proceed in applyOutcome.
    const payLocal = !(window.Economy && !Economy.softIncomeLocal());
    if (spec.credits && payLocal) {
      let amt = Array.isArray(spec.credits) ? Util.randInt(spec.credits[0], spec.credits[1]) : spec.credits;
      if (window.Senate && Senate.salvageBonusAdd() > 0) amt = Math.round(amt * (1 + Senate.salvageBonusAdd()));   // Salvage Rights Act
      this.s().credits += amt; report.credits = amt;
    }
    if (spec.item && payLocal && window.Items) {
      const prefer = spec.preferSurvey ? Util.pick(["scanner", "probe", "survey_shield"]) : null;
      const bias = EXPEDCFG.rarityBiasMax * ((exp && exp.danger) || 0);
      const it = Items.gen({ bias, kind: prefer || undefined, rarity: spec.item === true ? undefined : spec.item });
      const room = !(window.Bazaar) || (() => { try { return Bazaar.inventoryUsed() < Bazaar.capacity(); } catch (e) { return true; } })();
      if (room) {
        this.s().items[it.uid] = it; report.items.push(it);
        // Survey loot lands at the surveyed system — go get it (HAULING.md §5).
        if (window.Assets) Assets.parkGear(it.uid, (exp && exp.systemId) || this.s().currentSystem);
      }
    }
    if (spec.materials && payLocal) {
      const far = !!(exp && exp.far);
      const qtyRange = (EXPEDCFG.materialQty && EXPEDCFG.materialQty[far ? "far" : "near"]) || [2, 8];
      const exoticP = (EXPEDCFG.materialExoticChance && EXPEDCFG.materialExoticChance[far ? "far" : "near"]) || 0.2;
      const exotic = COMMODITIES.filter(c => c.craftOnly || c.rarity === "exotic");
      const rareish = COMMODITIES.filter(c => !c.craftOnly && (c.rarity === "rare" || c.rarity === "uncommon"));
      const pool = (Math.random() < exoticP && exotic.length ? exotic : rareish.length ? rareish : COMMODITIES);
      const c = Util.pick(pool);
      const landAt = (exp && exp.systemId) || this.s().currentSystem;
      if (c) {
        const qty = Util.randInt(qtyRange[0], qtyRange[1]);
        const st = this.s();
        const held = st.positions[c.id] || 0, avg = st.avgCost[c.id] || 0;
        st.positions[c.id] = held + qty;
        st.avgCost[c.id] = held + qty > 0 ? (held * avg) / (held + qty) : 0; // salvage — no cost basis
        if (window.Assets) Assets.parkBlocks(landAt, c.id, qty);
        report.stock = { commId: c.id, name: c.name, qty };
      }
      // Occasional blackbox alongside material salvage (CRAFTING_AND_MATERIALS §2.3).
      const bbP = (EXPEDCFG.blackboxChance && EXPEDCFG.blackboxChance[far ? "far" : "near"]) || 0;
      if (bbP && Math.random() < bbP && window.Items) {
        const room = !(window.Bazaar) || (() => { try { return Bazaar.inventoryUsed() < Bazaar.capacity(); } catch (e) { return true; } })();
        if (room) {
          const box = Items.genBlackbox();
          this.s().items[box.uid] = box;
          report.items.push(box);
          if (window.Assets) Assets.parkGear(box.uid, landAt);
        }
      }
      // Expedition-tier blueprints (CRAFTING_AND_MATERIALS §3.3).
      const bpP = (window.WORKSHOPCFG && WORKSHOPCFG.blueprintDropChance && WORKSHOPCFG.blueprintDropChance[far ? "far" : "near"]) || 0;
      if (bpP && Math.random() < bpP && window.Workshop) {
        const pool = Workshop.dropPool("expedition");
        if (pool.length) {
          const bp = Util.pick(pool);
          const gr = Workshop.grantBlueprint(bp.id);
          if (gr.ok) report.summary = (report.summary ? report.summary + " " : "") + `Recovered ${bp.name}.`;
        }
      }
    }
    if (spec.seam && sys && window.Galaxy) {
      const scarce = Math.random() < 0.5;
      const comm = Galaxy.signatureCommodity(sys);
      const ev = { id: "survey_seam", scope: "comm", dir: scarce ? "up" : "down",
        mult: scarce ? EXPEDCFG.seamMult.scarce : EXPEDCFG.seamMult.glut,
        headline: scarce ? "SURVEY FLAGS {COMM} SHORTFALL NEAR {PLANET}" : "SURVEY STRIKES RICH {COMM} SEAM NEAR {PLANET}",
        body: scarce ? "A baron's survey team maps a failing {COMM} field at {SYS}."
                     : "A baron's survey team cracks a fresh {COMM} seam at {SYS}." };
      Galaxy.fireLocalEvent(Date.now(), sys.id, ev);
      report.summary = `Mapped a ${comm.name} ${scarce ? "shortfall" : "seam"} at ${report.sysName}.`;
    }
    if (spec.rep && sys && window.Rep) {
      const fac = Rep.factionForCategory(Galaxy.signatureCommodity(sys).cat);
      const amt = 3 + Math.round(((exp && exp.danger) || 0) * 4);
      Incidents.apply({ rep: [[fac, amt]] });
      report.summary = (report.summary ? report.summary + " " : "") +
        `Faction standing with ${(FACTIONS[fac] || {}).name || fac} +${amt}.`;
    }
    if (spec.hazard && sh) {
      const fatal = Math.random() < EXPEDCFG.destroyChance * (0.5 + ((exp && exp.danger) || 0))
        * (1 / (1 + (Fleet.stats(sh).endure || 0) * 0.15));
      if (fatal) {
        report.success = false;
        report.lost.push({ uid: sh.uid, name: sh.name });
        this.s().ships = this.s().ships.filter(x => x.uid !== sh.uid);
        report.summary = `${sh.name} was lost while surveying ${report.sysName}.`;
        return;
      }
      const before = sh.dmg || 0;
      Fleet.addDamage(sh, Util.randFloat(EXPEDCFG.hazardDmg[0], EXPEDCFG.hazardDmg[1]) * (0.6 + ((exp && exp.danger) || 0)));
      report.damaged.push({ uid: sh.uid, name: sh.name, pct: Math.round((sh.dmg - before) * 100) });
      report.summary = `${sh.name} limped home from ${report.sysName} — shaken.`;
    }
    if (!report.summary) {
      if (report.credits) report.summary = `Salvage from ${report.sysName}: +${Util.credits(report.credits)}c.`;
      else if (report.items.length) report.summary = `Recovered ${report.items[0].name} near ${report.sysName}.`;
      else if (report.stock) report.summary = `Salvaged ${report.stock.qty} ${report.stock.name} near ${report.sysName}.`;
      else report.summary = `Survey of ${report.sysName} filed.`;
    }
  },
};

window.SurveyStory = SurveyStory;
