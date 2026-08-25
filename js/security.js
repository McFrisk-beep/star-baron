/* security.js — how much law is present, per system and per region
   (docs/SPACE_INTERACTIVITY.md §5.3). One number, derived from state that
   already exists, driving the galaxy chart's region blobs and the corsair
   pressure raiders.js rolls against.

   §5.3's whole argument is that a band must never be authored content:

     Sector base + station modules (a Customs House raises the band, a Free
     Port lowers it) + Senate edicts + whether js/wars.js has a war running.

   The consequence is the good part — **players change the security map by
   playing.** Fitting a Customs House genuinely makes that system safer for
   everyone who flies through it, competitors included: a public good that is
   also individually profitable, and one you can see on the chart.

   Pirate dens are deliberately NOT an input. Security is the law's published
   presence; a den is a local secret you find by flying out to it (§7.1 keeps
   it hidden until found), and folding it in here would paint every den on the
   galaxy map. Den pressure lives in raiders.js, where it is discovered.

   Nothing is stored. Everything below is a pure read of the world.           */

const Security = {
  cfg() { return window.SECURITYCFG || {}; },

  // ---- the score: 0 (no law at all) … 1 (Senate writ) --------------------
  score(sysId) {
    const c = this.cfg();
    const sys = window.Galaxy ? Galaxy.get(sysId) : null;
    if (!sys) return 0.5;
    let v = (c.sectorBase || {})[sys.sectorId];
    if (v == null) v = 0.5;
    if (sys.capital) v += c.capital || 0;
    // Station modules in this system — the player-facing lever. view() covers
    // other barons' published stations too, so their Customs House counts for
    // you exactly as yours counts for them.
    const st = window.Stations && Stations.view ? Stations.view(sysId) : null;
    const mods = (st && st.modules) || {};
    for (const [id, w] of Object.entries(c.modules || {})) v += (mods[id] | 0) * w;
    v += this._senate() * (c.senate || 0);
    v += this._war(sys) ? (c.war || 0) : 0;
    return Util.clamp(v, 0, 1);
  },

  // Convoy Escort Mandate (+) / Lane Patrol Cuts (−) — the same signed number
  // charters.js reads for ship-loss odds, so one edict moves both.
  _senate() {
    return (window.Senate && Senate.routeSafetyAdd) ? (Senate.routeSafetyAdd() || 0) : 0;
  },
  // A war drags the law away from the belligerents' own space. The sector's
  // domain faction is the one whose patrols are elsewhere.
  _war(sys) {
    if (!window.Wars || !Wars.atWar) return false;
    const f = this.sectorFaction(sys.sectorId);
    return !!f && Wars.atWar(f);
  },
  // Which faction's domain a sector's economy sits in (SECTORS[].specialty).
  sectorFaction(sectorId) {
    const sec = window.Galaxy ? Galaxy.sector(sectorId) : null;
    return (sec && sec.specialty && (window.CATEGORY_FACTION || {})[sec.specialty]) || null;
  },

  // The region's band: the mean of its systems. One station can't move a
  // sector on its own — that is honest, and the per-system tip shows the local
  // lift the chart is too coarse to draw.
  sectorScore(sectorId) {
    const sec = window.Galaxy ? Galaxy.sector(sectorId) : null;
    if (!sec || !sec.systems.length) return 0.5;
    let sum = 0;
    for (const id of sec.systems) sum += this.score(id);
    return sum / sec.systems.length;
  },

  band(score) {
    const bands = this.cfg().bands || [];
    let out = bands[0] || { id: "lawless", label: "Lawless", color: "#ff5d73" };
    for (const b of bands) if (score >= b.at) out = b;
    return out;
  },
  bandOf(sysId) { return this.band(this.score(sysId)); },
  sectorBand(sectorId) { return this.band(this.sectorScore(sectorId)); },

  // Why this system reads the way it does — the tip shows the derivation so a
  // band never looks like a number somebody typed in.
  factors(sysId) {
    const c = this.cfg(), out = [];
    const sys = window.Galaxy ? Galaxy.get(sysId) : null;
    if (!sys) return out;
    const sec = Galaxy.sector(sys.sectorId);
    out.push({ label: `${sec ? sec.name : sys.sectorId} baseline`, v: (c.sectorBase || {})[sys.sectorId] ?? 0.5, base: true });
    if (sys.capital) out.push({ label: "sector capital", v: c.capital || 0 });
    const st = window.Stations && Stations.view ? Stations.view(sysId) : null;
    const mods = (st && st.modules) || {};
    for (const [id, w] of Object.entries(c.modules || {})) {
      const n = mods[id] | 0;
      if (n > 0) out.push({ label: ((window.STATION_MODULES || {})[id] || {}).name || id, v: n * w });
    }
    const sen = this._senate() * (c.senate || 0);
    if (sen) out.push({ label: "Senate edicts", v: sen });
    if (this._war(sys)) out.push({ label: "faction war", v: c.war || 0 });
    return out;
  },

  // What the law here does to corsair odds (raiders.js). Lawless space
  // multiplies pressure up; policed space all but shuts it off.
  raidMult(sysId) {
    const r = this.cfg().raidMult || [1, 1];
    return r[1] + (r[0] - r[1]) * this.score(sysId);
  },
};

window.Security = Security;
