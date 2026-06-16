/* galaxy.js — the procedural galaxy. Generated deterministically from
   GALAXY.seed so it's the SAME universe every load (and ready to become the
   one shared universe in Phase 2). Structure is regenerated from the seed; only
   dynamic local-news history is persisted. Local events distort a single
   system's prices via Market.applyLocal — the "valuable insight" hook.         */

const Galaxy = {
  sectors: [],          // [{...SECTORS def, systems:[ids]}]
  systems: {},          // id -> system object
  list: [],             // flat list of system objects
  localLog: {},         // systemId -> [news entries] (persisted), newest first

  // ---- seeded PRNG (mulberry32) -----------------------------------------
  _mk(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },

  // ---- build ------------------------------------------------------------
  build() {
    const rng = this._mk(GALAXY.seed);
    const pick = arr => arr[Math.floor(rng() * arr.length)];
    const ri = (lo, hi) => Math.floor(rng() * (hi - lo + 1)) + lo;
    const rf = (lo, hi) => rng() * (hi - lo) + lo;
    const cats = ["mineral", "gas", "agri", "tech", "luxury", "illicit"];
    this.sectors = []; this.systems = {}; this.list = [];

    for (const sec of SECTORS) {
      const count = ri(GALAXY.sectorMinSystems, GALAXY.sectorMaxSystems);
      const ids = [];
      const cap = SYSTEMS.find(s => s.id === sec.capital);

      // capital (curated, tradeable) sits at the sector center
      const capital = {
        id: cap.id, name: cap.name, sectorId: sec.id, capital: true, tradeable: true,
        race: sec.race, star: sec.star, nebula: sec.nebula,
        mods: cap.mods, unlock: cap.unlock,
        asteroidBelt: sec.specialty === "mineral",
        pos: { x: sec.pos.x, y: sec.pos.y },
        planets: this._planets(cap.name, sec, rng, ri, pick, cats),
        stationName: `${cap.name} ${pick(["Anchorage", "Station", "Spire", "Platform"])}`,
      };
      this._register(capital); ids.push(capital.id);

      // generated systems orbit the capital on a jittered golden-angle disk
      for (let i = 1; i < count; i++) {
        const name = this._name(rng, pick);
        const ang = i * 2.39996 + rf(-0.3, 0.3);
        const rad = 0.045 + (i / count) * 0.10 + rf(-0.01, 0.01);
        const race = rng() < 0.7 ? sec.race : pick(Object.keys(RACES));
        const sys = {
          id: `${sec.id}_${i}_${name.toLowerCase().replace(/[^a-z]/g, "")}`,
          name, sectorId: sec.id, capital: false, tradeable: false,
          race, star: pick(STAR_TYPES), nebula: sec.nebula,
          mods: this._mods(sec, cats, rf, pick, ri),
          asteroidBelt: rng() < 0.4,
          pos: {
            x: Math.min(0.97, Math.max(0.03, sec.pos.x + Math.cos(ang) * rad)),
            y: Math.min(0.95, Math.max(0.05, sec.pos.y + Math.sin(ang) * rad * 0.9)),
          },
          planets: this._planets(name, sec, rng, ri, pick, cats),
          stationName: `${name} ${pick(["Outpost", "Relay", "Dock", "Waystation", "Berth"])}`,
        };
        this._register(sys); ids.push(sys.id);
      }
      this.sectors.push(Object.assign({}, sec, { systems: ids }));
    }
  },

  _register(sys) { this.systems[sys.id] = sys; this.list.push(sys); },

  _name(rng, pick) {
    let n = pick(GALAXY_NAMES.pre) + pick(GALAXY_NAMES.suf);
    if (rng() < 0.35) n += " " + pick(GALAXY_NAMES.tags);
    return n;
  },

  _mods(sec, cats, rf, pick, ri) {
    const m = {};
    for (const c of cats) m[c] = +(rf(0.92, 1.12)).toFixed(2);
    if (sec.specialty) m[sec.specialty] = +(rf(0.55, 0.8)).toFixed(2);   // source
    const dear = pick(cats);
    m[dear] = +(rf(1.12, 1.32)).toFixed(2);                              // sink
    return m;
  },

  _planets(sysName, sec, rng, ri, pick, cats) {
    const roman = ["I", "II", "III", "IV", "V", "VI", "VII"];
    const n = ri(2, 6);
    const out = [];
    for (let i = 0; i < n; i++) {
      const cat = (rng() < 0.5 && sec.specialty) ? sec.specialty : pick(cats);
      const otherCat = pick(cats.filter(c => c !== cat));
      const imp = pick(COMMODITIES.filter(c => c.cat === otherCat)) || pick(COMMODITIES);
      const prod = pick(COMMODITIES.filter(c => c.cat === cat)) || pick(COMMODITIES);
      out.push({
        name: `${sysName} ${roman[i]}`,
        type: pick(PLANET_TYPES),
        industry: pick(INDUSTRIES[cat]),
        cat,
        commodity: prod.id,            // what an industry here produces (into your tradeable stock)
        importing: imp.name,
      });
    }
    return out;
  },

  // ---- queries ----------------------------------------------------------
  get(id) { return this.systems[id]; },
  modsFor(id) { const s = this.systems[id]; return s ? s.mods : {}; },
  sector(id) { return this.sectors.find(s => s.id === id); },

  // The commodity whose category this system distorts the most (its "signature").
  signatureCommodity(sys) {
    let best = null, dev = -1;
    for (const c of COMMODITIES) {
      const d = Math.abs((sys.mods[c.cat] ?? 1) - 1);
      if (d > dev) { dev = d; best = c; }
    }
    return best || COMMODITIES[0];
  },

  // -1..+1 live signal for galaxy-view node coloring/pulse.
  localIndex(id) {
    const sys = this.systems[id];
    if (!sys) return 0;
    let signal = Market.changePct(this.signatureCommodity(sys).id) / 15;
    for (const e of Market.activeLocal(id)) {
      const remain = 1 - (Date.now() - e.startedAt) / e.durationMs;
      signal += (e.mult > 1 ? 0.6 : -0.6) * remain;
    }
    return Util.clamp(signal, -1, 1);
  },

  hasEvent(id) { return Market.activeLocal(id).length > 0; },

  // ---- local events (mechanical "valuable insight") ---------------------
  fireLocalEvent(now = Date.now()) {
    const sys = Util.pick(this.list);
    const ev = Util.pick(LOCAL_EVENTS);
    let cat, target, commName;
    if (ev.scope === "cat") {
      cat = this.signatureCommodity(sys).cat;
      target = cat;
      commName = (COMMODITIES.find(c => c.cat === cat) || COMMODITIES[0]).name;
    } else {
      const comm = this.signatureCommodity(sys);
      cat = comm.cat; target = comm.id; commName = comm.name;
    }
    const dur = GALAXY.localEffectMs / (window.Game.timeScale || 1);
    Market.applyLocal(sys.id, target, ev.mult, dur, now, ev.id + now);

    const planet = sys.planets.length ? Util.pick(sys.planets).name : sys.name + " I";
    const fill = t => t.replace(/\{SYS\}/g, sys.name).replace(/\{PLANET\}/g, planet)
      .replace(/\{COMM\}/g, commName).replace(/\{CAT\}/g, cat)
      .replace(/\{RACE\}/g, RACES[sys.race].name);
    const entry = {
      systemId: sys.id, sysName: sys.name, mechanical: true,
      headline: fill(ev.headline), body: fill(ev.body),
      dir: ev.dir, ts: now, tradeable: sys.tradeable,
    };
    this.addLocalNews(sys.id, entry);
    Bus.emit("localEvent", entry);
    return entry;
  },

  // ---- local news log (persisted, newest first, capped) -----------------
  addLocalNews(id, entry) {
    const log = (this.localLog[id] ||= []);
    log.unshift(entry);
    if (log.length > CONFIG.localFeedMax) log.length = CONFIG.localFeedMax;
  },
  newsFor(id) { return this.localLog[id] || []; },

  // A flavor post for a system (the slow background chatter). Persisted.
  flavorLine(sys) {
    const planet = sys.planets.length ? Util.pick(sys.planets).name : sys.name + " I";
    return Util.pick(LOCAL_NEWS).replace(/\{SYS\}/g, sys.name)
      .replace(/\{PLANET\}/g, planet).replace(/\{RACE\}/g, RACES[sys.race].name);
  },
  flavorPost(sys, now = Date.now()) {
    const entry = { systemId: sys.id, mechanical: false, text: this.flavorLine(sys), ts: now };
    this.addLocalNews(sys.id, entry);
    return entry;
  },

  // Give a freshly-opened system a little backfilled history so it reads alive.
  ensureSeeded(sys, now = Date.now()) {
    const log = (this.localLog[sys.id] ||= []);
    if (log.length >= 3) return;
    for (let i = log.length; i < 3; i++) {
      log.push({ systemId: sys.id, mechanical: false, text: this.flavorLine(sys),
        ts: now - Util.randInt(2, 300) * 60000 });
    }
    log.sort((a, b) => b.ts - a.ts);
    if (log.length > CONFIG.localFeedMax) log.length = CONFIG.localFeedMax;
  },

  // ---- persistence (structure is from seed; only history is saved) ------
  serialize() { return { localLog: this.localLog }; },
  hydrate(snap) { if (snap && snap.localLog) this.localLog = snap.localLog; },
};

window.Galaxy = Galaxy;
