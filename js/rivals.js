/* rivals.js — the competitive ladder. Named AI barons (data.js RIVALS) plus a
   seeded field of other barons fill a galaxy-wide board; the player's live net
   worth slots in so climbing the exchange means climbing the ranks. Rival
   wealth drifts once a day (idle = fall behind). Overtakes fire faction-
   flavored chatter; the Barons tab pages ±window around you.                */

const Rivals = {
  s() { return window.Game.state; },
  data(id) { return this.roster().find(r => r.id === id); },
  nw(id) { return this.s().rivals[id] || 0; },
  count() { return this.roster().length + 1; },              // +1 = you

  // Named rivals + deterministically generated field barons (stable per galaxy seed).
  roster() {
    if (this._roster) return this._roster;
    this._roster = RIVALS.concat(this._genField());
    return this._roster;
  },

  _genField() {
    const n = RIVALCFG.fieldCount || 0;
    if (n <= 0) return [];
    const seed = ((typeof GALAXY !== "undefined" ? GALAXY.seed : 1) ^ 0xB4A01) >>> 0;
    const rng = (window.Galaxy && Galaxy._mk) ? Galaxy._mk(seed) : (() => Math.random());
    const pick = arr => arr[Math.floor(rng() * arr.length)];
    const factions = Object.keys(FACTIONS);
    const styles = (typeof SENATE_FIRST !== "undefined") ? Object.keys(SENATE_FIRST) : ["soft"];
    const epithets = RIVALCFG.fieldEpithets || ["the Wanderer"];
    const used = new Set(RIVALS.map(r => r.name));
    const lo = Math.log(RIVALCFG.fieldMin || 2000);
    const hi = Math.log(RIVALCFG.fieldMax || 8000000);
    const out = [];
    for (let i = 0; i < n; i++) {
      const style = pick(styles);
      const firsts = (typeof SENATE_FIRST !== "undefined" && SENATE_FIRST[style]) || ["Sael"];
      const pre = (typeof SENATE_SUR !== "undefined" && SENATE_SUR.pre) || ["Vol"];
      const suf = (typeof SENATE_SUR !== "undefined" && SENATE_SUR.suf) || ["ane"];
      let name;
      for (let t = 0; t < 10; t++) {
        name = pick(firsts) + " " + pick(pre) + pick(suf);
        if (!used.has(name)) break;
        name = name + " " + (i + 2);
      }
      used.add(name);
      // Log-spaced bases so the ladder stays dense from starter to apex.
      const t = n === 1 ? 0.5 : i / (n - 1);
      const base = Math.round(Math.exp(lo + (hi - lo) * t));
      // Slower compounders at the top, hungrier near the bottom — mirrors RIVALS.
      const growthPerHr = 0.055 - t * 0.038;
      out.push({
        id: "field_" + i,
        name,
        epithet: pick(epithets),
        faction: pick(factions),
        portrait: Math.floor(rng() * 12),
        base,
        growthPerHr,
        field: true,
      });
    }
    return out;
  },

  // Baron Tier title from wealth. Named/field barons "wear" the tier their pile
  // would unlock; the player uses their ascended prestige tier instead.
  titleFromNw(nw) {
    const tiers = typeof BARON_TIERS !== "undefined" ? BARON_TIERS : [{ title: "Baron", threshold: 0 }];
    let title = tiers[0].title;
    for (const t of tiers) if (nw >= (t.threshold || 0)) title = t.title;
    return title;
  },

  // Seed/repair rival net worths and bookkeeping on any save shape.
  ensure() {
    const s = this.s();
    if (!s.rivals || typeof s.rivals !== "object") s.rivals = {};
    for (const r of this.roster()) {
      if (typeof s.rivals[r.id] !== "number" || !isFinite(s.rivals[r.id]))
        s.rivals[r.id] = Math.round(r.base * Util.randFloat(0.85, 1.15));
    }
    const known = new Set(this.roster().map(r => r.id));
    for (const id of Object.keys(s.rivals)) if (!known.has(id)) delete s.rivals[id];
    s.rivalsMeta ||= {};
    const m = s.rivalsMeta;
    if (typeof m.lastAt !== "number") m.lastAt = Date.now();
    if (typeof m.lastRank !== "number") m.lastRank = this.rank();
    if (typeof m.lastBarbAt !== "number") m.lastBarbAt = 0;
    m.snap ||= null;
  },

  // Daily drift: compound once per driftMs window, then check rank changes.
  // Pass detection always runs so a climbing player still needles rivals mid-day.
  tick(now) {
    const s = this.s();
    this.ensure();
    const m = s.rivalsMeta;
    const dt = now - (m.lastAt || now);
    if (dt >= RIVALCFG.driftMs) {
      m.lastAt = now;
      const gdt = Util.clamp(dt, 0, CONFIG.maxOfflineMs);
      for (const r of this.roster()) {
        let v = s.rivals[r.id];
        v *= 1 + r.growthPerHr * (gdt / 3600000);   // organic growth over elapsed time
        v *= 1 + Util.gauss(RIVALCFG.noiseSd);       // daily jitter
        s.rivals[r.id] = Util.clamp(v, r.base * RIVALCFG.minMult, r.base * RIVALCFG.maxMult);
      }
      this.refreshSnapshot(now);
      this.maybeAmbient(now);
    }
    this.detectPasses(now);
  },

  // ---- leaderboard ---------------------------------------------------------
  // Full board (rivals + you), richest first.
  board() {
    const rows = this.roster().map(r => ({
      id: r.id, name: r.name, epithet: r.epithet, faction: r.faction,
      portrait: r.portrait, you: false, field: !!r.field,
      netWorth: this.nw(r.id),
      title: this.titleFromNw(this.nw(r.id)),
    }));
    const youNw = Economy.netWorth();
    const youName = (window.Cloud && Cloud.displayName && Cloud.displayName()) || "You";
    rows.push({
      id: "__you", name: youName, epithet: "your empire", faction: null,
      portrait: null, you: true, field: false, netWorth: youNw,
      title: Economy.tierTitle ? Economy.tierTitle() : this.titleFromNw(youNw),
    });
    rows.sort((a, b) => b.netWorth - a.netWorth);
    rows.forEach((row, i) => { row.rank = i + 1; });
    return rows;
  },

  // Slice of the board for the Barons tab. `offset` null → center on you (±window).
  // Otherwise `offset` is the 0-based start index into the full board.
  pageWindow(offset) {
    const board = this.board();
    const win = RIVALCFG.window || 10;
    const pageLen = win * 2 + 1;
    const youIdx = board.findIndex(r => r.you);
    const maxStart = Math.max(0, board.length - pageLen);
    let start;
    if (offset == null || !Number.isFinite(offset)) {
      start = youIdx < 0 ? 0 : Util.clamp(youIdx - win, 0, maxStart);
    } else {
      start = Util.clamp(Math.floor(offset), 0, maxStart);
    }
    const end = Math.min(board.length, start + pageLen);
    return {
      board, rows: board.slice(start, end), start, end, youIdx, youRank: youIdx + 1,
      total: board.length, pageLen, win,
      hasPrev: start > 0,
      hasNext: end < board.length,
      prevStart: Math.max(0, start - pageLen),
      nextStart: Math.min(maxStart, start + pageLen),
    };
  },

  rank() {
    const nw = Economy.netWorth();
    let r = 1;
    for (const x of this.roster()) if (this.nw(x.id) > nw) r++;
    return r;
  },

  // Re-baseline rank arrows on the board every snapshotMs.
  refreshSnapshot(now) {
    const m = this.s().rivalsMeta;
    if (m.snap && now - m.snap.ts < RIVALCFG.snapshotMs) return;
    const ranks = {};
    this.board().forEach(row => { ranks[row.id] = row.rank; });
    m.snap = { ts: now, ranks };
  },

  // ---- chatter -------------------------------------------------------------
  detectPasses(now) {
    const m = this.s().rivalsMeta;
    const board = this.board();
    const youIdx = board.findIndex(r => r.you);
    const rank = youIdx + 1;
    const prev = m.lastRank;
    m.lastRank = rank;
    if (window.Game && window.Game._booting) return;
    if (prev == null || rank === prev) return;

    if (rank < prev) {
      // climbed — needle the rival now directly below you (the one you passed)
      const passed = board[youIdx + 1];
      if (passed && !passed.you) {
        this.barb(passed, "concede", rank);
        Bus.emit("rivalPass", { rival: passed.id, dir: "up", rank });
      }
    } else {
      // slipped — the rival now directly above you just overtook you
      const over = board[youIdx - 1];
      if (over && !over.you) {
        this.barb(over, "gloat", rank);
        Bus.emit("rivalPass", { rival: over.id, dir: "down", rank });
      }
    }
  },

  maybeAmbient(now) {
    if (window.Game && window.Game._booting) return;
    if (Math.random() > RIVALCFG.ambientChance) return;
    // Prefer named rivals for chatter; fall back to anyone.
    const pool = RIVALS.length ? RIVALS : this.roster();
    const r = Util.pick(pool);
    this.barb(r, "ambient", this.rank());
  },

  // Post a rival's line to the trader chat (faction-tone aware, throttled).
  barb(rival, pool, rank) {
    const m = this.s().rivalsMeta;
    if (Date.now() - (m.lastBarbAt || 0) < RIVALCFG.barbMinGapMs) return;
    m.lastBarbAt = Date.now();
    const warm = pool !== "ambient" &&
      Rep.tierIndex(Rep.tierOf(rival.faction).id) >= Rep.tierIndex("allied");
    const lines = (warm && RIVAL_BARBS[pool + "Warm"]) || RIVAL_BARBS[pool];
    const text = Util.pick(lines)
      .replace(/\{EPITHET\}/g, rival.epithet)
      .replace(/\{NW\}/g, Util.credits(this.nw(rival.id)) + "c")
      .replace(/\{RANK\}/g, "#" + rank);
    Feed.emit(text, { portrait: rival.portrait, handle: rival.name, kind: "rival" });
  },
};

window.Rivals = Rivals;
