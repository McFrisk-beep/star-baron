/* senate.js — space politics. A galactic senate (one senator per system, sector
   capitals weighted heavier) votes ~once a day on edicts that bite the whole
   game: price caps, prohibitions, tariffs, industry levies, tighter borders
   (smuggling), ship restrictions — plus player-friendly subsidies / tax
   holidays. Edicts expire (or get repealed). Your Baron Tier gates how much you
   can sway a vote: lobby a bloc → bribe a senator → smear one with a scandal.

   Senators are generated DETERMINISTICALLY from the galaxy seed (zero save cost
   for their identity); only the dynamic bits live in state.senate: the bill
   schedule + results (with packed per-senator votes), active edicts, your
   pending influence, and per-senator dossier/relationship data.

   Effects are aggregated once in _effects() and read by the gameplay hooks
   (market / economy / missions / industries / fleet) — one source of truth, the
   same shape as Wars. This file also owns the animated Senate Chamber overlay. */

const Senate = {
  refs: {},
  _open: false,
  _raf: null,
  _roster: null,
  _byId: null,
  _seats: null,
  _seatEls: {},
  _rev: 0,            // module-local revision; bumped on any change → invalidates the effects cache

  s() { return window.Game.state; },
  sen() {
    const s = this.s();
    if (!s.senate) s.senate = this.defaultState();
    return s.senate;
  },
  defaultState() {
    return { bills: [], nextVoteAt: 0, reps: {}, pending: this._emptyPending(), cycle: 0, billSeq: 0, lastBillId: null };
  },

  // ===== deterministic helpers ============================================
  _hash(str) { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; },
  _mk(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; },

  // ===== roster (deterministic, memoized) =================================
  roster() {
    if (this._roster) return this._roster;
    const out = [], used = new Set();
    let idx = 0;
    for (const sys of Galaxy.list) { out.push(this._genSenator(sys, idx++, used)); }
    this._roster = out;
    this._byId = Object.fromEntries(out.map(s => [s.id, s]));
    return out;
  },
  byId(id) { this.roster(); return this._byId[id]; },

  _blocFor(sys, rng) {
    if (sys.sectorId === "core") return "independent";
    if (rng() < SENATECFG.independentChance) return "independent";
    const counts = {};
    for (const p of (sys.planets || [])) counts[p.cat] = (counts[p.cat] || 0) + 1;
    let dom = null, best = -1;
    for (const k in counts) if (counts[k] > best) { best = counts[k]; dom = k; }
    return (dom && CATEGORY_FACTION[dom]) || "free_trade";
  },
  _genName(rng, style, used) {
    const firsts = SENATE_FIRST[style] || SENATE_FIRST.soft || ["Sael"];
    const pick = arr => arr[Math.floor(rng() * arr.length)];
    for (let tries = 0; tries < 8; tries++) {
      const name = pick(firsts) + " " + pick(SENATE_SUR.pre) + pick(SENATE_SUR.suf);
      if (!used.has(name)) { used.add(name); return name; }
    }
    // give up uniquely after a few tries — append a numeral
    const base = pick(firsts) + " " + pick(SENATE_SUR.pre) + pick(SENATE_SUR.suf);
    let n = base, i = 2; while (used.has(n)) n = base + " " + i++;
    used.add(n); return n;
  },
  _genSenator(sys, idx, used) {
    const rng = this._mk(this._hash("senator:" + sys.id));
    const race = sys.race;
    const style = (RACES[race] || {}).nameStyle || "soft";
    const bloc = this._blocFor(sys, rng);
    const sec = Galaxy.sector(sys.sectorId);
    const cap = !!sys.capital;
    const stances = {};
    for (const iss of SENATE_ISSUES) {
      const center = (iss.bias && iss.bias[bloc]) || 0;
      stances[iss.key] = Util.clamp(Math.round(center + (rng() * 2 - 1) * 2), -3, 3);
    }
    const titles = cap ? SENATE_TITLES.high : SENATE_TITLES.normal;
    return {
      id: "sen_" + sys.id, idx,
      name: this._genName(rng, style, used),
      race, raceName: (RACES[race] || {}).name || race,
      systemId: sys.id, systemName: sys.name,
      sectorId: sys.sectorId, sectorName: sec ? sec.name : sys.sectorId,
      capital: cap,
      title: titles[Math.floor(rng() * titles.length)],
      bloc,
      weight: cap ? SENATECFG.weightCapital : ((sys.planets || []).length >= 5 ? SENATECFG.weightHub : SENATECFG.weightNormal),
      stances,
      portrait: Math.floor(rng() * (CONFIG.portraitCount || 12)),   // trader-chat sprite (admin-overridable via ASSET.portrait)
    };
  },

  blocName(b) { return b === "independent" ? "Independent" : ((FACTIONS[b] || {}).name || b); },
  blocColor(b) { return b === "independent" ? "#9aa9c8" : ((FACTIONS[b] || {}).color || "#9aa9c8"); },
  stanceLabel(v) { return SENATECFG.stanceLabels[Util.clamp(v + 3, 0, 6)]; },

  // ===== bill scheduling & generation =====================================
  interval() { return SENATECFG.voteIntervalMs / (window.Game.timeScale || 1); },

  _instantiate(tpl) {
    const cats = ["mineral", "gas", "agri", "tech", "luxury", "illicit"];
    const cap = w => w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
    let target = "", effect = { type: tpl.type }, pct = "";
    if (tpl.scope === "cat") {
      const c = Util.pick(cats); target = cap(c);
      if (tpl.type === "priceCap") { effect.cat = c; effect.mult = tpl.mag; pct = Math.round((1 - tpl.mag) * 100) + "%"; }
      else if (tpl.type === "subsidy") { effect.cat = c; effect.mult = tpl.mag; pct = Math.round((tpl.mag - 1) * 100) + "%"; }
      else if (tpl.type === "tariff") { effect.cat = c; effect.tax = tpl.mag; pct = Math.round(tpl.mag * 100) + "%"; }
      else if (tpl.type === "ban") { effect.cat = c; }
    } else if (tpl.scope === "comm") {
      const comm = Util.pick(COMMODITIES); target = comm.name; effect.commId = comm.id;
    } else if (tpl.scope === "faction") {
      const all = Math.random() < 0.4;
      const fac = all ? "all" : Util.pick(Object.keys(FACTIONS));
      effect.faction = fac; effect.add = tpl.mag;
      target = all ? "all sectors" : FACTIONS[fac].name;
      pct = Math.round(Math.abs(tpl.mag) * 100) + "%";
    } else if (tpl.scope === "shipcls") {
      const cls = Util.pick(["escort", "transport"]); effect.cls = cls; target = cap(cls);
    } else if (tpl.scope === "none") {
      if (tpl.type === "border") { effect.add = tpl.mag; pct = Math.round(tpl.mag * 100) + "%"; }
    }
    const fill = t => t.replace(/\{TARGET\}/g, target).replace(/\{PCT\}/g, pct);
    return { title: fill(tpl.title), blurb: fill(tpl.blurb), effect };
  },

  _genBill(votesAt, now) {
    const senate = this.sen();
    const id = "bill_" + (++senate.billSeq);
    const active = this.activeEdicts(now);
    if (active.length && Math.random() < SENATECFG.repealChance) {
      const t = Util.pick(active);
      return { id, repealOf: t.id, issue: t.issue, lean: -1, type: "repeal",
        title: "Repeal — " + t.title, blurb: "Strikes down “" + t.title + "” and restores the prior status quo.",
        effect: null, votesAt, status: "upcoming" };
    }
    const tpl = Util.pick(SENATE_EDICTS);
    const inst = this._instantiate(tpl);
    return { id, repealOf: null, issue: tpl.issue, lean: 1, type: tpl.type,
      title: inst.title, blurb: inst.blurb, effect: inst.effect, votesAt, status: "upcoming" };
  },

  ensureSchedule(now) {
    const senate = this.sen();
    if (!senate.bills) senate.bills = [];
    if (!senate.nextVoteAt) senate.nextVoteAt = now + this.interval();
    let up = senate.bills.filter(b => b.status === "upcoming").sort((a, b) => a.votesAt - b.votesAt);
    let guard = 0;
    while (up.length < SENATECFG.billLookahead && guard++ < 20) {
      const at = up.length ? up[up.length - 1].votesAt + this.interval() : senate.nextVoteAt;
      const bill = this._genBill(at, now);
      senate.bills.push(bill); up.push(bill);
    }
    senate.nextVoteAt = up.length ? up[0].votesAt : now + this.interval();
  },

  // ===== resolution (loop + offline catch-up) =============================
  tick(now) { return this.resolve(now); },
  resolve(now) {
    const senate = this.sen();
    this.ensureSchedule(now);
    const out = []; let guard = 0;
    while (guard++ < SENATECFG.maxResolvePerCatchup) {
      const due = senate.bills.filter(b => b.status === "upcoming" && b.votesAt <= now).sort((a, b) => a.votesAt - b.votesAt);
      if (!due.length) break;
      const bill = due[0];
      this._resolveBill(bill, bill.votesAt);
      out.push(bill);
      senate.cycle = (senate.cycle || 0) + 1;
      senate.lastBillId = bill.id;
      if (senate.pending && senate.pending.billId === bill.id) senate.pending = this._emptyPending();
      this.ensureSchedule(now);
    }
    let changed = out.length > 0;
    for (const b of senate.bills) if (b.status === "passed" && b.endsAt && b.endsAt <= now) { b.status = "expired"; changed = true; }
    if (changed) { this._trim(); this._bumpRev(); }
    return out;
  },
  _resolveBill(bill, atTime) {
    const roster = this.roster(), senate = this.sen();
    const pending = (senate.pending && senate.pending.billId === bill.id) ? senate.pending : null;
    let aye = 0, nay = 0, abst = 0, wAye = 0, wNay = 0;
    const votes = new Array(roster.length).fill("x");
    for (const sn of roster) {
      const v = this._vote(sn, bill, pending);
      votes[sn.idx] = v;
      if (v === "a") { aye++; wAye += sn.weight; }
      else if (v === "n") { nay++; wNay += sn.weight; }
      else abst++;
    }
    bill.votes = votes.join("");
    bill.result = { aye, nay, abstain: abst, wAye, wNay };
    const passed = wAye > wNay;
    if (bill.repealOf) {
      if (passed) { const t = senate.bills.find(b => b.id === bill.repealOf); if (t && t.status === "passed") t.status = "repealed"; }
      bill.status = passed ? "passed" : "failed";
    } else {
      bill.status = passed ? "passed" : "failed";
      if (passed) bill.endsAt = atTime + SENATECFG.edictDurationMs;
    }
    Bus.emit("senateVote", bill);
  },
  // a single senator's vote: "a" aye · "n" nay · "x" abstain
  _vote(sn, bill, pending) {
    if (pending && pending.scandals && pending.scandals[sn.id]) return "x";   // smeared → sits it out
    let score = ((sn.stances[bill.issue] || 0) / 3) * bill.lean;
    const rep = (this.sen().reps || {})[sn.id];
    const want = pending ? (pending.want === "pass" ? 1 : pending.want === "block" ? -1 : 0) : 0;
    if (want) {
      if (rep && rep.rel) score += (rep.rel / 100) * want * 0.6;
      if (pending.bribes && pending.bribes[sn.id]) score += SENATECFG.bribeStrength * want;
      if (pending.lobbyAll) score += pending.lobbyAll * want;
      const f = pending.lobbyFac && pending.lobbyFac[sn.bloc];
      if (f) score += f * want;
    }
    score += (this._hash(sn.id + "|" + bill.id) / 4294967296 - 0.5) * 2 * SENATECFG.voteNoise;
    if (score > SENATECFG.abstainBand) return "a";
    if (score < -SENATECFG.abstainBand) return "n";
    return "x";
  },
  _trim() {
    const senate = this.sen();
    if (senate.bills.length <= SENATECFG.historyKeep + 12) return;
    // keep all upcoming + active edicts, plus the most recent N finished bills
    const live = senate.bills.filter(b => b.status === "upcoming" || (b.status === "passed" && b.endsAt && b.endsAt > Date.now() && b.type !== "repeal"));
    const rest = senate.bills.filter(b => !live.includes(b)).sort((a, b) => (b.votesAt || 0) - (a.votesAt || 0)).slice(0, SENATECFG.historyKeep);
    senate.bills = live.concat(rest).sort((a, b) => (a.votesAt || 0) - (b.votesAt || 0));
  },

  // ===== queries ==========================================================
  activeEdicts(now = Date.now()) {
    return this.sen().bills.filter(b => b.status === "passed" && b.type !== "repeal" && b.effect && (!b.endsAt || b.endsAt > now));
  },
  upcomingBills(now = Date.now()) { this.ensureSchedule(now); return this.sen().bills.filter(b => b.status === "upcoming").sort((a, b) => a.votesAt - b.votesAt); },
  nextBill(now = Date.now()) { return this.upcomingBills(now)[0] || null; },
  lastResolved() {
    const senate = this.sen();
    if (senate.lastBillId) { const b = senate.bills.find(x => x.id === senate.lastBillId); if (b) return b; }
    const done = senate.bills.filter(b => b.votes).sort((a, b) => (b.votesAt || 0) - (a.votesAt || 0));
    return done[0] || null;
  },
  history(limit = 12) {
    return this.sen().bills.filter(b => b.votes).sort((a, b) => (b.votesAt || 0) - (a.votesAt || 0)).slice(0, limit);
  },
  voteOf(bill, sn) { return (bill && bill.votes && sn) ? bill.votes[sn.idx] : null; },
  senatorHistory(id, limit = 10) {
    const sn = this.byId(id); if (!sn) return [];
    return this.sen().bills.filter(b => b.votes).sort((a, b) => (b.votesAt || 0) - (a.votesAt || 0))
      .slice(0, limit).map(b => ({ bill: b, vote: b.votes[sn.idx] }));
  },

  // ===== effect aggregation (read by gameplay hooks) ======================
  _effects(now = Date.now()) {
    const bucket = Math.floor(now / 2000);
    if (this._fx && this._fxSig === this._rev && this._fxBucket === bucket) return this._fx;
    const fx = { banComm: {}, banCat: {}, catMult: {}, commMult: {}, buyTax: {}, sellTax: {},
      indTaxAll: 0, indTaxFac: {}, border: 0, shipBan: {} };
    for (const b of this.activeEdicts(now)) {
      const e = b.effect; if (!e) continue;
      switch (e.type) {
        case "priceCap": case "subsidy":
          if (e.cat) fx.catMult[e.cat] = (fx.catMult[e.cat] || 1) * e.mult;
          if (e.commId) fx.commMult[e.commId] = (fx.commMult[e.commId] || 1) * e.mult; break;
        case "ban":
          if (e.commId) fx.banComm[e.commId] = 1; if (e.cat) fx.banCat[e.cat] = 1; break;
        case "tariff":
          if (e.cat) { fx.buyTax[e.cat] = (fx.buyTax[e.cat] || 0) + e.tax; fx.sellTax[e.cat] = (fx.sellTax[e.cat] || 0) + e.tax; } break;
        case "industryTax": case "taxHoliday":
          if (e.faction === "all") fx.indTaxAll += e.add; else fx.indTaxFac[e.faction] = (fx.indTaxFac[e.faction] || 0) + e.add; break;
        case "border": fx.border += e.add; break;
        case "shipBan": if (e.cls) fx.shipBan[e.cls] = 1; break;
      }
    }
    this._fx = fx; this._fxSig = this._rev; this._fxBucket = bucket;
    return fx;
  },
  _bumpRev() { this._rev++; },
  priceFactor(commId, cat) { const fx = this._effects(); return (fx.catMult[cat] || 1) * (fx.commMult[commId] || 1); },
  isBanned(commId, cat) { const fx = this._effects(); return !!(fx.banComm[commId] || fx.banCat[cat]); },
  tradeTax(cat, side) { const fx = this._effects(); return (side === "buy" ? fx.buyTax[cat] : fx.sellTax[cat]) || 0; },
  industryTaxAdd(fac) { const fx = this._effects(); return fx.indTaxAll + (fac ? (fx.indTaxFac[fac] || 0) : 0); },
  smuggleFailAdd() { return this._effects().border; },
  shipClassBanned(cls) { return !!this._effects().shipBan[cls]; },

  // ===== player influence =================================================
  _emptyPending() { return { billId: null, want: null, lobbyAll: 0, lobbyFac: {}, bribes: {}, scandals: {} }; },
  _pendingFor(bill) {
    const senate = this.sen();
    if (!senate.pending || senate.pending.billId !== bill.id) senate.pending = Object.assign(this._emptyPending(), { billId: bill.id });
    return senate.pending;
  },
  pending() { const b = this.nextBill(); return b ? this._pendingFor(b) : this._emptyPending(); },
  _rep(id) { const senate = this.sen(); senate.reps ||= {}; return (senate.reps[id] ||= { revealed: false, rel: 0, scandal: 0 }); },
  revealed(id) { const r = (this.sen().reps || {})[id]; return !!(r && r.revealed); },
  reveal(id) { this._rep(id).revealed = true; this._bumpRev(); },
  relationship(id) { const r = (this.sen().reps || {})[id]; return r ? (r.rel || 0) : 0; },

  tier() { return (this.s().prestige || {}).tier || 0; },
  power() { return 1 + this.tier() * SENATECFG.tierInfluenceBonus; },
  maxTargets() { return 1 + this.tier(); },
  targetsUsed(p) { return Object.keys(p.bribes).length + Object.keys(p.scandals).length; },
  can(kind) {
    const t = this.tier();
    if (kind === "lobby") return t >= SENATECFG.lobbyMinTier;
    if (kind === "bribe") return t >= SENATECFG.bribeMinTier;
    if (kind === "scandal") return t >= SENATECFG.scandalMinTier;
    return false;
  },

  setWant(want) {
    const b = this.nextBill(); if (!b) return { ok: false, msg: "No bill on the floor." };
    const p = this._pendingFor(b); p.want = (p.want === want ? null : want);
    this._bumpRev(); return { ok: true };
  },
  lobby(scope) {
    if (!this.can("lobby")) return { ok: false, msg: `Lobbying unlocks at Baron Tier ${SENATECFG.lobbyMinTier}.` };
    const b = this.nextBill(); if (!b) return { ok: false, msg: "No bill on the floor." };
    const p = this._pendingFor(b);
    if (!p.want) return { ok: false, msg: "Back or block the bill first, then lobby." };
    const cost = scope === "all" ? SENATECFG.lobbyAllCost : SENATECFG.lobbyFacCost;
    const s = this.s(); if (s.credits < cost) return { ok: false, msg: "Not enough credits." };
    s.credits -= cost;
    if (scope === "all") p.lobbyAll = (p.lobbyAll || 0) + SENATECFG.lobbyAllStrength * this.power();
    else { p.lobbyFac[scope] = (p.lobbyFac[scope] || 0) + SENATECFG.lobbyFacStrength * this.power(); }
    Economy.refreshNetWorth(); this._bumpRev(); return { ok: true, cost };
  },
  bribe(senatorId) {
    if (!this.can("bribe")) return { ok: false, msg: `Bribery unlocks at Baron Tier ${SENATECFG.bribeMinTier}.` };
    const b = this.nextBill(); if (!b) return { ok: false, msg: "No bill on the floor." };
    const p = this._pendingFor(b);
    if (!p.want) return { ok: false, msg: "Back or block the bill first." };
    const sn = this.byId(senatorId); if (!sn) return { ok: false, msg: "Unknown senator." };
    if (p.bribes[senatorId]) return { ok: false, msg: "Already in your pocket this session." };
    if (this.targetsUsed(p) >= this.maxTargets()) return { ok: false, msg: `Only ${this.maxTargets()} senator(s) per session at your tier.` };
    const cost = Math.round(SENATECFG.bribeCostBase * sn.weight);
    const s = this.s(); if (s.credits < cost) return { ok: false, msg: "Not enough credits." };
    s.credits -= cost; p.bribes[senatorId] = true;
    const rep = this._rep(senatorId); rep.rel = Util.clamp((rep.rel || 0) + SENATECFG.relGainOnBribe, -100, 100);
    Economy.refreshNetWorth(); this._bumpRev(); return { ok: true, cost };
  },
  scandal(senatorId) {
    if (!this.can("scandal")) return { ok: false, msg: `Scandals unlock at Baron Tier ${SENATECFG.scandalMinTier}.` };
    const b = this.nextBill(); if (!b) return { ok: false, msg: "No bill on the floor." };
    const p = this._pendingFor(b);
    const sn = this.byId(senatorId); if (!sn) return { ok: false, msg: "Unknown senator." };
    if (p.scandals[senatorId]) return { ok: false, msg: "Already smeared this session." };
    if (this.targetsUsed(p) >= this.maxTargets()) return { ok: false, msg: `Only ${this.maxTargets()} senator(s) per session at your tier.` };
    const cost = SENATECFG.scandalCostBase;
    const s = this.s(); if (s.credits < cost) return { ok: false, msg: "Not enough credits." };
    s.credits -= cost;
    const rep = this._rep(senatorId);
    const backfire = Math.random() < Math.max(0.05, SENATECFG.scandalBackfireBase - this.tier() * SENATECFG.scandalTierRelief);
    if (backfire) { rep.rel = Util.clamp((rep.rel || 0) - SENATECFG.relLossOnBackfire, -100, 100); Economy.refreshNetWorth(); this._bumpRev(); return { ok: true, cost, backfired: true }; }
    p.scandals[senatorId] = true; rep.scandal = (rep.scandal || 0) + 1;
    Economy.refreshNetWorth(); this._bumpRev(); return { ok: true, cost, backfired: false };
  },

  // ===== welcome-back recap helper ========================================
  // bills that finished in (since, now] — for the While-You-Were-Away modal.
  recapSince(since, now = Date.now()) {
    const passed = [], failed = [], repealed = [];
    for (const b of this.sen().bills) {
      if (!b.votesAt || b.votesAt <= since || b.votesAt > now) continue;
      if (b.status === "passed" && b.type !== "repeal") passed.push(b);
      else if (b.status === "passed" && b.type === "repeal") repealed.push(b);
      else if (b.status === "failed") failed.push(b);
    }
    return { passed, failed, repealed };
  },

  // ===== animated chamber overlay =========================================
  init() {
    const $ = id => document.getElementById(id);
    this.refs = { overlay: $("senate-overlay"), svg: $("senate-svg"), tip: $("sc-tip"),
      speaker: $("sc-speaker"), stage: $("sc-stage"),
      btnReplay: $("sc-replay"), btnHall: $("sc-hall"), btnClose: $("sc-close") };
    if (!this.refs.overlay) return;
    this.refs.btnClose.onclick = () => this.closeChamber();
    this.refs.btnReplay.onclick = () => this.replay();
    this.refs.btnHall.onclick = () => this.showHall();
    document.addEventListener("keydown", e => { if (e.key === "Escape" && this._open) this.closeChamber(); });
  },
  openChamber() {
    if (!this.refs.overlay) this.init();
    if (!this.refs.overlay) return;
    this._open = true;
    this.refs.overlay.classList.remove("hidden");
    this._buildSeats();
    this._renderSeats();
    this._initPanZoom();
    this._fitChamber();       // cover-fit so the chamber fills the screen on mobile (pan/pinch to explore)
    this.showHall();          // open in recess (partial attendance) — "Replay vote" plays the last session
    this._startLoop();
  },
  closeChamber() {
    this._open = false;
    if (this.refs.overlay) this.refs.overlay.classList.add("hidden");
    this._clearBubbles();
    this._stopLoop();
  },
  suspend() { if (this._open) this._stopLoop(); },
  resume() { if (this._open) this._startLoop(); },
  _startLoop() { if (!this._raf) this._raf = requestAnimationFrame(() => this._frame()); },
  _stopLoop() { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } },

  // ---- pan / zoom (mirrors the star-map galaxy view) ----------------------
  // The chamber is drawn in a fixed 1000×560 space; we pan & zoom by mutating
  // the SVG viewBox. "Cover" fit fills the screen on mobile; getScreenCTM()
  // keeps pixel↔user conversion correct.
  _setVBc(v) { this.gz = v; this.refs.svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`); },
  _toSVGc(cx, cy) {
    const m = this.refs.svg.getScreenCTM(); if (!m) return { x: 0, y: 0 };
    const p = this.refs.svg.createSVGPoint(); p.x = cx; p.y = cy;
    const q = p.matrixTransform(m.inverse()); return { x: q.x, y: q.y };
  },
  _clampVBc(v) {
    const AR = this._cAR, B = this._cB;
    const w = Util.clamp(v.w, this._cMinW, this._cMaxW), h = w / AR;
    const rw = B.x1 - B.x0, rh = B.y1 - B.y0;
    const x = w >= rw ? (B.x0 + B.x1 - w) / 2 : Util.clamp(v.x, B.x0, B.x1 - w);
    const y = h >= rh ? (B.y0 + B.y1 - h) / 2 : Util.clamp(v.y, B.y0, B.y1 - h);
    return { x, y, w, h };
  },
  _fitChamber() {
    const minX = 28, maxX = 972, minY = 52, maxY = 560;   // seats + podium (bubbles sit just above)
    const cw = maxX - minX, ch = maxY - minY;
    const r = this.refs.stage.getBoundingClientRect();
    const AR = (r.width > 0 && r.height > 0) ? r.width / r.height : cw / ch;
    this._cAR = AR;
    this._cB = { x0: minX - cw * 0.12, y0: minY - ch * 0.12, x1: maxX + cw * 0.12, y1: maxY + ch * 0.12 };
    this._cMaxW = Math.max(cw, ch * AR) * 1.1;
    this._cMinW = Math.max(120, Math.min(cw, ch * AR) * 0.3);
    let w, h;
    if (cw / ch > AR) { h = ch; w = h * AR; } else { w = cw; h = w / AR; }
    this._setVBc(this._clampVBc({ x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - h / 2, w, h }));
  },
  _panByc(dxPx, dyPx) {
    const m = this.refs.svg.getScreenCTM(); if (!m || !m.a) return;
    this._setVBc(this._clampVBc({ x: this.gz.x - dxPx / m.a, y: this.gz.y - dyPx / m.d, w: this.gz.w, h: this.gz.h }));
  },
  _zoomAtc(cx, cy, factor) {
    const b = this._toSVGc(cx, cy);
    const fx = (b.x - this.gz.x) / this.gz.w, fy = (b.y - this.gz.y) / this.gz.h;
    const w = this.gz.w * factor, h = w / this._cAR;
    this._setVBc(this._clampVBc({ x: b.x - fx * w, y: b.y - fy * h, w, h }));
  },
  _initPanZoom() {
    if (this._pzcReady) return; this._pzcReady = true;
    const svg = this.refs.svg; this._ptrs = new Map();
    svg.addEventListener("pointerdown", e => { this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); this._dragged = false; this._pinchPrev = null; svg.classList.add("grabbing"); });
    svg.addEventListener("pointermove", e => {
      const p = this._ptrs.get(e.pointerId); if (!p) return;
      const px = p.x, py = p.y; p.x = e.clientX; p.y = e.clientY;
      if (this._ptrs.size >= 2) { this._pinchc(); return; }
      if (Math.abs(e.clientX - px) + Math.abs(e.clientY - py) > 2) this._dragged = true;
      this._panByc(e.clientX - px, e.clientY - py);
    });
    const up = e => { if (!this._ptrs.delete(e.pointerId)) return; this._pinchPrev = null; if (!this._ptrs.size) svg.classList.remove("grabbing"); };
    window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
    svg.addEventListener("wheel", e => { e.preventDefault(); this._zoomAtc(e.clientX, e.clientY, e.deltaY > 0 ? 1.12 : 1 / 1.12); }, { passive: false });
  },
  _pinchc() {
    const [a, b] = [...this._ptrs.values()];
    const dist = Math.hypot(b.x - a.x, b.y - a.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (this._pinchPrev && dist > 0) { this._zoomAtc(mid.x, mid.y, this._pinchPrev.dist / dist); this._panByc(mid.x - this._pinchPrev.mid.x, mid.y - this._pinchPrev.mid.y); }
    this._pinchPrev = { dist, mid }; this._dragged = true;
  },

  _buildSeats() {
    if (this._seats) return;
    const roster = this.roster(), N = roster.length;
    const cx = 500, cy = 545, rIn = 130, rOut = 470;
    const rows = Math.max(4, Math.round(Math.sqrt(N)) + 1);
    const radii = []; for (let r = 0; r < rows; r++) radii.push(rIn + (rOut - rIn) * (r / (rows - 1)));
    const wsum = radii.reduce((a, b) => a + b, 0);
    let caps = radii.map(rad => Math.max(1, Math.round(N * rad / wsum)));
    let total = caps.reduce((a, b) => a + b, 0);
    while (total < N) { let m = 0; for (let i = 1; i < caps.length; i++) if (radii[i] > radii[m]) m = i; caps[m]++; total++; }
    while (total > N) { let m = 0; for (let i = 1; i < caps.length; i++) if (caps[i] > caps[m]) m = i; if (caps[m] > 1) { caps[m]--; total--; } else break; }
    const slots = [];
    for (let r = 0; r < rows; r++) {
      const cap = caps[r], rad = radii[r];
      for (let i = 0; i < cap; i++) {
        const t = cap === 1 ? 0.5 : i / (cap - 1);
        const a = Math.PI + t * Math.PI;           // 180° (left) → 360° (right), seats above the podium
        slots.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad, a, rad });
      }
    }
    slots.sort((p, q) => (p.a - q.a) || (p.rad - q.rad));
    const order = roster.slice().sort((p, q) =>
      (p.bloc < q.bloc ? -1 : p.bloc > q.bloc ? 1 : 0) || (p.sectorId < q.sectorId ? -1 : 1) || (p.idx - q.idx));
    const map = {};
    for (let i = 0; i < order.length && i < slots.length; i++) map[order[i].id] = slots[i];
    this._seats = map;
  },
  _renderSeats() {
    const svg = this.refs.svg, ns = "http://www.w3.org/2000/svg";
    svg.innerHTML = "";
    // a single objectBoundingBox clip → every portrait <image> is cropped to a circle
    const defs = document.createElementNS(ns, "defs");
    const clip = document.createElementNS(ns, "clipPath");
    clip.setAttribute("id", "seatClip"); clip.setAttribute("clipPathUnits", "objectBoundingBox");
    const cc = document.createElementNS(ns, "circle"); cc.setAttribute("cx", "0.5"); cc.setAttribute("cy", "0.5"); cc.setAttribute("r", "0.5");
    clip.appendChild(cc); defs.appendChild(clip); svg.appendChild(defs);
    const well = document.createElementNS(ns, "ellipse");
    well.setAttribute("cx", 500); well.setAttribute("cy", 548); well.setAttribute("rx", 95); well.setAttribute("ry", 30);
    well.setAttribute("class", "sc-well"); svg.appendChild(well);
    const podium = document.createElementNS(ns, "rect");
    podium.setAttribute("x", 482); podium.setAttribute("y", 512); podium.setAttribute("width", 36); podium.setAttribute("height", 30);
    podium.setAttribute("rx", 5); podium.setAttribute("class", "sc-podium"); svg.appendChild(podium);
    this._seatEls = {}; this._bubbles = [];
    for (const sn of this.roster()) {
      const p = this._seats[sn.id]; if (!p) continue;
      const R = sn.capital ? 10 : 7, Ri = R - 2.2;
      const g = document.createElementNS(ns, "g"); g.setAttribute("class", "sc-seat-g"); g.style.cursor = "pointer";
      const ring = document.createElementNS(ns, "circle");
      ring.setAttribute("cx", p.x.toFixed(1)); ring.setAttribute("cy", p.y.toFixed(1)); ring.setAttribute("r", R);
      ring.setAttribute("class", "sc-seat" + (sn.capital ? " cap" : "") + " vacant");
      const pic = document.createElementNS(ns, "image");
      const href = ASSET.portrait(sn.portrait);
      pic.setAttributeNS("http://www.w3.org/1999/xlink", "href", href); pic.setAttribute("href", href);
      pic.setAttribute("x", (p.x - Ri).toFixed(1)); pic.setAttribute("y", (p.y - Ri).toFixed(1));
      pic.setAttribute("width", (Ri * 2).toFixed(1)); pic.setAttribute("height", (Ri * 2).toFixed(1));
      pic.setAttribute("clip-path", "url(#seatClip)"); pic.setAttribute("preserveAspectRatio", "xMidYMid slice");
      pic.setAttribute("class", "sc-pic"); pic.style.opacity = "0";
      g.appendChild(ring); g.appendChild(pic);
      g.addEventListener("mouseenter", e => this._tip(sn, e));
      g.addEventListener("mousemove", e => this._tipMove(e));
      g.addEventListener("mouseleave", () => this.refs.tip.style.display = "none");
      g.addEventListener("click", () => { if (this._dragged) return; if (window.UI) UI.openSenatorCard(sn.id); });
      svg.appendChild(g);
      this._seatEls[sn.id] = { g, ring, pic };
    }
  },
  // present? show the portrait + (vote/bloc) ring; absent → empty dim seat, no hover
  _setSeat(id, present, color) {
    const el = this._seatEls[id]; if (!el) return;
    el.pic.style.opacity = present ? "1" : "0";
    el.g.style.pointerEvents = present ? "auto" : "none";
    el.ring.classList.remove("aye", "nay", "abst", "bloc", "pending", "vacant");
    if (!present) { el.ring.classList.add("vacant"); el.ring.style.fill = ""; return; }
    if (color === "bloc") { el.ring.classList.add("bloc"); el.ring.style.fill = this.blocColor(this.byId(id).bloc); }
    else { el.ring.style.fill = ""; el.ring.classList.add(color); }
  },
  _tip(sn, e) {
    const v = (this._mode === "vote" && this._bill) ? this.voteOf(this._bill, sn) : null;
    const vt = v === "a" ? '<span class="up">▲ aye</span>' : v === "n" ? '<span class="down">▼ nay</span>' : v === "x" ? '<span class="tip-dim">abstain</span>' : "";
    this.refs.tip.innerHTML = `<b>${sn.name}</b> <span class="tip-dim">${sn.title}</span><br>` +
      `<span style="color:${this.blocColor(sn.bloc)}">◆ ${this.blocName(sn.bloc)}</span> · ${sn.systemName}` +
      (vt ? `<br>vote: ${vt}` : (this._mode === "hall" ? `<br><span class="tip-dim">present — ${this.revealed(sn.id) ? "dossier on file" : "buy a dossier for their stance"}</span>` : ""));
    this.refs.tip.style.display = "block"; this._tipMove(e);
  },
  _tipMove(e) {
    const r = this.refs.stage.getBoundingClientRect();
    this.refs.tip.style.left = (e.clientX - r.left + 14) + "px";
    this.refs.tip.style.top = (e.clientY - r.top + 14) + "px";
  },

  // ---- recess attendance: only a rotating handful of senators are present ----
  _rollPresence(initial) {
    const ids = this.roster().map(s => s.id);
    const target = Math.max(5, Math.round(ids.length * 0.18));
    if (initial || !this._present) this._present = new Set();
    if (!initial) {                                  // a couple drift out…
      const cur = [...this._present], leave = Util.randInt(0, 2);
      for (let i = 0; i < leave && cur.length; i++) { const k = Util.randInt(0, cur.length - 1); this._present.delete(cur[k]); cur.splice(k, 1); }
    }
    const absent = ids.filter(id => !this._present.has(id));
    let need = initial ? target - this._present.size : Util.randInt(1, 3);
    need = Util.clamp(need, 0, Math.min(absent.length, target + 2 - this._present.size));
    for (let i = 0; i < need && absent.length; i++) { const k = Util.randInt(0, absent.length - 1); this._present.add(absent[k]); absent.splice(k, 1); }
  },
  _applyPresence() { for (const sn of this.roster()) this._setSeat(sn.id, this._present.has(sn.id), "bloc"); },
  _bubble(id) {
    const p = this._seats[id]; if (!p || !this.refs.svg) return;
    const ns = "http://www.w3.org/2000/svg";
    const text = Util.pick(SENATE_BUBBLES);
    const w = Math.max(34, text.length * 6.2 + 14), h = 18;
    const x = Util.clamp(p.x, w / 2 + 4, 996 - w / 2), y = p.y - (this.byId(id).capital ? 10 : 7) - 15;
    const g = document.createElementNS(ns, "g"); g.setAttribute("class", "sc-bubble");
    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", (x - w / 2).toFixed(1)); rect.setAttribute("y", (y - h / 2).toFixed(1));
    rect.setAttribute("width", w.toFixed(1)); rect.setAttribute("height", h); rect.setAttribute("rx", 7);
    const t = document.createElementNS(ns, "text"); t.setAttribute("x", x.toFixed(1)); t.setAttribute("y", (y + 4).toFixed(1));
    t.setAttribute("text-anchor", "middle"); t.setAttribute("class", "sc-bubble-t"); t.textContent = text;
    g.appendChild(rect); g.appendChild(t); this.refs.svg.appendChild(g);
    requestAnimationFrame(() => g.classList.add("show"));
    this._bubbles ||= []; this._bubbles.push(g);
    setTimeout(() => { g.classList.remove("show"); setTimeout(() => g.remove(), 350); this._bubbles = (this._bubbles || []).filter(b => b !== g); }, 2600);
    while (this._bubbles.length > 5) { const old = this._bubbles.shift(); if (old) old.remove(); }
  },
  _clearBubbles() { if (this._bubbles) for (const b of this._bubbles) b.remove(); this._bubbles = []; },

  _reduced() { return !!(this.s().settings && this.s().settings.reduced); },
  _showVote(bill) {
    this._mode = "vote"; this._bill = bill; this._voteDone = false;
    this._clearBubbles();
    this._tally = { aye: 0, nay: 0, abst: 0, wAye: 0, wNay: 0 };
    this.refs.btnReplay.style.display = "";
    for (const sn of this.roster()) this._setSeat(sn.id, true, "pending");   // full attendance for the vote
    const order = this.roster().slice().sort((a, b) => (this._seats[a.id]?.a || 0) - (this._seats[b.id]?.a || 0));
    this._revealed = {};
    if (this._reduced()) {
      for (const sn of order) { this._revealed[sn.id] = true; this._applyVote(sn.id); }
      this._voteDone = true; this._renderTally();
    } else {
      const t0 = performance.now();
      this._reveal = order.map((sn, i) => ({ id: sn.id, at: t0 + (i / Math.max(1, order.length)) * SENATECFG.staggerMs }));
    }
    this._renderSpeaker();
  },
  _applyVote(id) {
    const v = this._bill.votes[this.byId(id).idx], w = this.byId(id).weight;
    if (v === "a") { this._tally.aye++; this._tally.wAye += w; this._setSeat(id, true, "aye"); }
    else if (v === "n") { this._tally.nay++; this._tally.wNay += w; this._setSeat(id, true, "nay"); }
    else { this._tally.abst++; this._setSeat(id, true, "abst"); }
  },
  replay() { const b = this._bill || this.lastResolved(); if (b && b.votes) { this._showVote(b); this._startLoop(); } },
  showHall() {
    this._mode = "hall"; this._bill = null;
    this._clearBubbles();
    this.refs.btnReplay.style.display = this.lastResolved() ? "" : "none";
    this._rollPresence(true);
    this._applyPresence();
    this._nextHall = 0;
    this._renderRecessText();
  },
  _hallBeat() {
    this._rollPresence(false);
    this._applyPresence();
    const present = [...this._present];
    if (present.length) this._bubble(Util.pick(present));
    this._renderRecessText();
  },
  _renderRecessText() {
    const present = [...(this._present || [])], next = this.nextBill();
    const eta = next ? Util.duration(Math.max(0, next.votesAt - Date.now())) : "—";
    let line = "The chamber stands in recess; senators drift in and out.";
    if (present.length > 1) {
      const a = this.byId(present[Util.randInt(0, present.length - 1)]);
      const b = this.byId(present[Util.randInt(0, present.length - 1)]);
      if (a && b && a.id !== b.id) {
        const iss = Util.pick(SENATE_ISSUES);
        line = Util.pick(SENATE_HALL).replace(/\{A\}/g, a.name).replace(/\{B\}/g, b.name).replace(/\{ISSUE\}/g, iss.label.toLowerCase());
      }
    }
    this.refs.speaker.innerHTML = `<div class="sc-hall-line">${line}</div>` +
      `<div class="sc-sub">In recess · <b>${present.length}</b>/${this.roster().length} present · next session in <b>${eta}</b>` +
      `${next ? ` · <span class="sc-up">${next.title}</span> · buy dossiers to know the absent senators' stances` : ""}</div>`;
  },
  _renderSpeaker() {
    const b = this._bill; if (!b) return;
    const line = Util.pick(SENATE_SPEAKER).replace(/\{TITLE\}/g, b.title);
    const result = (this._voteDone)
      ? (b.status === "passed" ? `<span class="sc-pass">PASSED</span>` : `<span class="sc-fail">FAILED</span>`)
      : `<span class="sc-live">voting…</span>`;
    this.refs.speaker.innerHTML =
      `<div class="sc-speaker-line">🏛 ${line}</div>` +
      `<div class="sc-bill"><b>${b.title}</b> ${result}</div>` +
      `<div class="sc-sub">${b.blurb}</div>` +
      `<div class="sc-tally" id="sc-tally"></div>`;
    this._renderTally();
  },
  _renderTally() {
    const el = document.getElementById("sc-tally"); if (!el || !this._tally) return;
    const t = this._tally, wt = t.wAye + t.wNay || 1;
    el.innerHTML = `<span class="up">Aye ${t.aye}</span> · <span class="down">Nay ${t.nay}</span> · <span class="tip-dim">Abstain ${t.abst}</span>` +
      `<div class="sc-bar"><span class="sc-bar-aye" style="width:${(t.wAye / wt * 100).toFixed(0)}%"></span><span class="sc-bar-nay" style="width:${(t.wNay / wt * 100).toFixed(0)}%"></span></div>`;
  },
  _frame() {
    if (!this._open) { this._raf = null; return; }
    const now = performance.now();
    if (this._mode === "vote" && this._reveal && !this._voteDone) {
      let changed = false;
      for (const r of this._reveal) if (!this._revealed[r.id] && r.at <= now) { this._revealed[r.id] = true; this._applyVote(r.id); changed = true; }
      if (changed) this._renderTally();
      if (Object.keys(this._revealed).length >= this._reveal.length) { this._voteDone = true; this._renderSpeaker(); }
    } else if (this._mode === "hall") {
      if (now > (this._nextHall || 0)) { this._nextHall = now + 1700 + Math.random() * 1500; this._hallBeat(); }
    }
    this._raf = requestAnimationFrame(() => this._frame());
  },
};

window.Senate = Senate;
