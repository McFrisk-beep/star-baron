/* pois.js — seeded points of interest in the deep-space ring
   (docs/SPACE_INTERACTIVITY.md §2, build order step 1). Derived from
   GALAXY.seed exactly like galaxy.js and lanes.js: every client computes the
   identical layout, nothing is persisted. Step 1 ships places only — a POI is
   a named, clickable thing at a location in the ring between coreSpan and
   worldSpan. The verbs (mining, dens, salvage) are later build steps; they
   hang their one state row off poi.id without moving anything here.          */

// Per-type look and naming. `solo` types place at most once per system.
// `r` is the draw/hit radius in world px (jittered ±15% per POI).
const POI_TYPES = {
  belt:     { label: "Asteroid cluster", r: 34, color: "#c9a36b",
              names: ["{BASE} Drift", "{BASE} Scatter", "{BASE} Shoal", "The {BASE} Rocks"],
              blurb: "Dense rock and tumbling ice. Survey chatter says some of these seams are workable." },
  debris:   { label: "Debris field", r: 28, color: "#9aa4b8",
              names: ["{BASE} Scrapline", "{BASE} Graveyard", "{BASE} Junkfield"],
              blurb: "Sheared hull plate and burnt-out drive cones. Something happened here." },
  gas:      { label: "Gas cloud", r: 40, color: "#68d6b2",
              names: ["{BASE} Veil", "{BASE} Bank", "{BASE} Shroud"],
              blurb: "Sensor returns go soft inside. A good place to disappear." },
  derelict: { label: "Derelict hulk", r: 18, color: "#8b93a8",
              names: ["Wreck of the {BASE}", "{BASE}'s Folly", "The {BASE} Hulk"],
              blurb: "Cold hull, dead transponder. Registry unknown." },
  rig:      { label: "Mining rig", r: 20, color: "#ffc24b",
              names: ["{BASE} Workings", "{BASE} Claim", "{BASE} Diggings"],
              blurb: "An automated rig, still chewing rock for an owner who may not answer hails." },
  buoy:     { label: "Jump buoy", r: 12, color: "#5fd7ff", solo: true,
              names: ["{BASE} Beacon", "Buoy {BASE}", "{BASE} Marker"],
              blurb: "Lane-keeping hardware. Tampering with it is a crime in most jurisdictions." },
  den:      { label: "Pirate den", r: 22, color: "#ff5d73", solo: true,
              names: ["{BASE} Roost", "{BASE} Hideout", "The {BASE} Hole"],
              blurb: "Unregistered traffic clusters here after dark. The locals don't wave." },
  post:     { label: "Listening post", r: 14, color: "#b28bff", solo: true,
              names: ["{BASE} Array", "{BASE} Ear", "{BASE} Antenna"],
              blurb: "Somebody's ears, pointed at everything that moves in this system." },
};

const POIs = {
  _cache: {},   // sysId -> [poi] — pure function of the seed, computed once

  // 4–12 POIs scattered through the reserved ring between coreSpan and
  // worldSpan (SYSTEMVIEW §6.1). Gates sit on the core's inset edge (≤ ~0.62
  // of coreSpan from centre on the diagonal), so the ring floor clears them.
  list(sysId) {
    const hit = this._cache[sysId];
    if (hit) return hit;
    const sys = window.Galaxy && Galaxy.get(sysId);
    if (!sys) return [];
    const rng = Galaxy._mk((GALAXY.seed ^ _poolHash("poi:" + sysId)) >>> 0);
    const pick = arr => arr[Math.floor(rng() * arr.length)];
    const CORE = SYSTEMVIEW.coreSpan || 1000;
    const WORLD = Math.max(CORE, SYSTEMVIEW.worldSpan || CORE);
    const c = WORLD / 2, rMin = CORE * 0.64, rMax = WORLD * 0.47;
    // weighted type pool — mineral systems read as belt country
    const pool = [];
    const add = (t, w) => { while (w-- > 0) pool.push(t); };
    add("belt", sys.asteroidBelt ? 4 : 2); add("debris", 2); add("gas", 2);
    add("derelict", 2); add("rig", 1); add("buoy", 1); add("post", 1); add("den", 1);
    const n = 4 + Math.floor(rng() * 9);
    const out = [], placed = {};
    for (let i = 0; i < n; i++) {
      let type = pick(pool);
      if (POI_TYPES[type].solo && placed[type]) type = "debris";
      placed[type] = true;
      // rejection-sample a spot in the ring clear of the neighbours
      let x = c + rMin, y = c;
      for (let tries = 0; tries < 20; tries++) {
        const a = rng() * Math.PI * 2, r = rMin + rng() * (rMax - rMin);
        x = c + Math.cos(a) * r; y = c + Math.sin(a) * r;
        if (out.every(p => Math.hypot(p.x - x, p.y - y) > 110)) break;
      }
      const def = POI_TYPES[type];
      const base = pick(GALAXY_NAMES.pre) + pick(GALAXY_NAMES.suf);
      out.push({
        id: sysId + ":" + i, sysId, type,
        name: pick(def.names).replace("{BASE}", base),
        x, y, r: Math.round(def.r * (0.85 + rng() * 0.3)),
        seed: Math.floor(rng() * 0xffffffff),   // per-POI variant/animation phase
      });
    }
    return (this._cache[sysId] = out);
  },

  // Hit-test in world coordinates; `slack` widens small targets (pass a few
  // screen px / zoom so buoys stay clickable zoomed out). Nearest wins.
  at(sysId, wx, wy, slack = 0) {
    let best = null, bd = 0;
    for (const p of this.list(sysId)) {
      const d = Math.hypot(p.x - wx, p.y - wy) - Math.max(p.r, slack);
      if (d < 0 && (best === null || d < bd)) { bd = d; best = p; }
    }
    return best;
  },
};

window.POI_TYPES = POI_TYPES;
window.POIs = POIs;
