/* rivals.js — AI baron flavor. Named rivals (data.js RIVALS) drift and needle
   you in chat; they are NOT on the Barons leaderboard (that's human players —
   see barons.js). Windfall tax uses the human board when available.           */

const Rivals = {
  s() { return window.Game.state; },
  data(id) { return RIVALS.find(r => r.id === id); },
  nw(id) { return this.s().rivals[id] || 0; },
  count() { return RIVALS.length + 1; },

  ensure() {
    const s = this.s();
    if (!s.rivals || typeof s.rivals !== "object") s.rivals = {};
    for (const r of RIVALS) {
      if (typeof s.rivals[r.id] !== "number" || !isFinite(s.rivals[r.id]))
        s.rivals[r.id] = Math.round(r.base * Util.randFloat(0.85, 1.15));
    }
    for (const id of Object.keys(s.rivals)) if (!this.data(id)) delete s.rivals[id];
    s.rivalsMeta ||= {};
    const m = s.rivalsMeta;
    if (typeof m.lastAt !== "number") m.lastAt = Date.now();
    if (typeof m.lastRank !== "number") m.lastRank = this.rank();
    if (typeof m.lastBarbAt !== "number") m.lastBarbAt = 0;
    m.snap ||= null;
  },

  tick(now) {
    const s = this.s();
    this.ensure();
    const m = s.rivalsMeta;
    const dt = now - (m.lastAt || now);
    if (dt < RIVALCFG.driftMs) return;
    m.lastAt = now;
    const gdt = Util.clamp(dt, 0, CONFIG.maxOfflineMs);
    for (const r of RIVALS) {
      let v = s.rivals[r.id];
      v *= 1 + r.growthPerHr * (gdt / 3600000);
      v *= 1 + Util.gauss(RIVALCFG.noiseSd);
      s.rivals[r.id] = Util.clamp(v, r.base * RIVALCFG.minMult, r.base * RIVALCFG.maxMult);
    }
    this.detectPasses(now);
    this.maybeAmbient(now);
  },

  // AI-relative rank (flavor / pass toasts). Prefer Barons.rank() for HUD.
  rank() {
    const nw = Economy.netWorth();
    let r = 1;
    for (const x of RIVALS) if (this.nw(x.id) > nw) r++;
    return r;
  },

  detectPasses(now) {
    const m = this.s().rivalsMeta;
    const nw = Economy.netWorth();
    const board = RIVALS.map(r => ({ id: r.id, name: r.name, epithet: r.epithet,
      faction: r.faction, portrait: r.portrait, you: false, netWorth: this.nw(r.id) }));
    board.push({ id: "__you", you: true, netWorth: nw });
    board.sort((a, b) => b.netWorth - a.netWorth);
    const youIdx = board.findIndex(r => r.you);
    const rank = youIdx + 1;
    const prev = m.lastRank;
    m.lastRank = rank;
    if (window.Game && window.Game._booting) return;
    if (prev == null || rank === prev) return;
    if (rank < prev) {
      const passed = board[youIdx + 1];
      if (passed && !passed.you) {
        this.barb(passed, "concede", rank);
        Bus.emit("rivalPass", { rival: passed.id, dir: "up", rank });
      }
    } else {
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
    const r = Util.pick(RIVALS);
    this.barb(r, "ambient", this.rank());
  },

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
