/* pois.js — seeded points of interest in the deep-space ring
   (docs/SPACE_INTERACTIVITY.md §2, build order step 1). Derived from
   GALAXY.seed exactly like galaxy.js and lanes.js: every client computes the
   identical layout, nothing is persisted.

   A system's SLOTS are permanent geography — how many sites it has, roughly
   where, and of what kind. What OCCUPIES a churning slot is not: NPC crews
   work a rock out and salvagers haul a wreck away, and a fresh site takes the
   slot (docs/SPACE_INTERACTIVITY.md §1.3 — the epoch input the design asked
   for). Occupancy is a pure function of (slot, generation), and the
   generation is a pure function of the clock, so churn costs no storage and
   still looks the same to everyone. Permanent types — gas clouds, buoys,
   listening posts, rigs and pirate dens — never roll.                       */

// Per-type look and naming. `solo` types place at most once per system;
// `churn` types are worked out by NPCs and replaced (POICFG window).
// `r` is the draw/hit radius in world px (jittered ±15% per occupant).
const POI_TYPES = {
  belt:     { label: "Asteroid cluster", r: 34, color: "#c9a36b", churn: true,
              names: ["{BASE} Drift", "{BASE} Scatter", "{BASE} Shoal", "The {BASE} Rocks"],
              blurb: "Dense rock and tumbling ice. Survey chatter says some of these seams are workable." },
  debris:   { label: "Debris field", r: 28, color: "#9aa4b8", churn: true,
              names: ["{BASE} Scrapline", "{BASE} Graveyard", "{BASE} Junkfield"],
              blurb: "Sheared hull plate and burnt-out drive cones. Something happened here." },
  gas:      { label: "Gas cloud", r: 40, color: "#68d6b2",
              names: ["{BASE} Veil", "{BASE} Bank", "{BASE} Shroud"],
              blurb: "Sensor returns go soft inside. A good place to disappear." },
  derelict: { label: "Derelict hulk", r: 18, color: "#8b93a8", churn: true,
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
  _slots: {},   // sysId -> [slot]        — permanent, computed once
  _cache: {},   // sysId -> { key, list } — occupants, rebuilt when a slot rolls

  // ---- slots: the permanent geography ------------------------------------
  // 4–12 sites per system, scattered through the reserved ring between
  // coreSpan and worldSpan (SYSTEMVIEW §6.1). Gates sit on the core's inset
  // edge (≤ ~0.62 of coreSpan from centre), so the ring floor clears them.
  slots(sysId) {
    const hit = this._slots[sysId];
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
      out.push({ id: sysId + ":" + i, sysId, sectorId: sys.sectorId, type, x, y,
        seed: Math.floor(rng() * 0xffffffff), c, rMin, rMax });
    }
    // How far a replacement may drift from its slot: half the clearance to the
    // nearest neighbour, so a fresh site reads as a different rock in the same
    // neighbourhood and two sites can still never crowd each other.
    for (const p of out) {
      let near = Infinity;
      for (const q of out) if (q !== p) near = Math.min(near, Math.hypot(p.x - q.x, p.y - q.y));
      p.jit = isFinite(near) ? Util.clamp((near - 90) / 2, 0, 35) : 35;
    }
    return (this._slots[sysId] = out);
  },

  // ---- churn: how long an occupant lasts before NPC crews clear it -------
  churns(slot) { return !!(POI_TYPES[slot.type] || {}).churn; },
  lifeMs(slot) {
    if (!this.churns(slot)) return Infinity;
    const lo = POICFG.churnMinMs, hi = POICFG.churnMaxMs;
    return lo + ((slot.seed >>> 8) % 1000) / 1000 * (hi - lo);
  },
  // Staggered so a system's sites don't all roll over at the same moment.
  phaseMs(slot) { return this.churns(slot) ? (slot.seed % 1000) / 1000 * this.lifeMs(slot) : 0; },
  gen(slot, now = Date.now()) {
    return this.churns(slot) ? Math.floor((now + this.phaseMs(slot)) / this.lifeMs(slot)) : 0;
  },
  // When the crews move on and a fresh site takes this slot (Infinity = never).
  rollsAt(slot, now = Date.now()) {
    if (!this.churns(slot)) return Infinity;
    return (this.gen(slot, now) + 1) * this.lifeMs(slot) - this.phaseMs(slot);
  },

  // ---- occupants ---------------------------------------------------------
  // Everything visible about a site: its name, exact spot, size and (for a
  // belt) its seam. Seeded from the slot AND the generation, so a replacement
  // is a genuinely different rock rather than the same one refilled.
  _occupy(slot, gen) {
    const rng = Galaxy._mk((slot.seed ^ Math.imul(gen + 1, 0x9E3779B1)) >>> 0);
    const pick = arr => arr[Math.floor(rng() * arr.length)];
    const def = POI_TYPES[slot.type];
    const base = pick(GALAXY_NAMES.pre) + pick(GALAXY_NAMES.suf);
    // drift within the slot's neighbourhood (bounded by slot.jit so sites can
    // never crowd each other), clamped back into the ring so a replacement
    // never lands on the gates or outside the world
    const jit = slot.jit || 0;
    let x = slot.x + (rng() - 0.5) * 2 * jit, y = slot.y + (rng() - 0.5) * 2 * jit;
    const dx = x - slot.c, dy = y - slot.c;
    const d = Math.hypot(dx, dy) || 1;
    const rr = Util.clamp(d, slot.rMin, slot.rMax);
    x = slot.c + dx / d * rr; y = slot.c + dy / d * rr;
    const poi = {
      id: slot.id, sysId: slot.sysId, type: slot.type, gen,
      name: pick(def.names).replace("{BASE}", base),
      x, y, r: Math.round(def.r * (0.85 + rng() * 0.3)),
      seed: Math.floor(rng() * 0xffffffff),   // per-occupant variant/animation phase
    };
    // Belt composition (docs/SPACE_INTERACTIVITY.md §3.3): which commodity,
    // how rich, and a finite pool. Rich seams sit in the worst neighbourhoods
    // — sector risk scales richness, no balancing pass needed.
    if (slot.type === "belt" && typeof MININGCFG !== "undefined") {
      const seam = COMMODITIES.filter(c => !c.craftOnly && (c.cat === "mineral" || c.cat === "gas"));
      const minerals = seam.filter(c => c.cat === "mineral");
      const commPool = rng() < 0.67 && minerals.length ? minerals : seam;
      const sRich = MININGCFG.sectorRich[slot.sectorId] ?? 1;
      poi.ore = {
        commId: pick(commPool).id,
        rich: +((0.7 + rng() * 0.6) * sRich).toFixed(2),
        pool: Math.round(MININGCFG.poolBase * (0.8 + rng() * 0.6)),
      };
    }
    return poi;
  },

  // The system's sites right now. Cheap on the hot path: the generation
  // vector is a couple of divisions per slot, and the occupants are only
  // rebuilt when one of them actually rolls over.
  list(sysId, now = Date.now()) {
    const slots = this.slots(sysId);
    if (!slots.length) return [];
    const gens = slots.map(s => this.gen(s, now));
    const key = gens.join(",");
    const hit = this._cache[sysId];
    if (hit && hit.key === key) return hit.list;
    const list = slots.map((s, i) => this._occupy(s, gens[i]));
    this._cache[sysId] = { key, list };
    return list;
  },

  slot(poiId) {
    const sysId = String(poiId).split(":")[0];
    return this.slots(sysId).find(s => s.id === poiId) || null;
  },
  get(poiId, now = Date.now()) {
    const sysId = String(poiId).split(":")[0];
    return this.list(sysId, now).find(p => p.id === poiId) || null;
  },

  // Hit-test in world coordinates; `slack` widens small targets (pass a few
  // screen px / zoom so buoys stay clickable zoomed out). Nearest wins.
  at(sysId, wx, wy, slack = 0, now = Date.now()) {
    let best = null, bd = 0;
    for (const p of this.list(sysId, now)) {
      const d = Math.hypot(p.x - wx, p.y - wy) - Math.max(p.r, slack);
      if (d < 0 && (best === null || d < bd)) { bd = d; best = p; }
    }
    return best;
  },
};

window.POI_TYPES = POI_TYPES;
window.POIs = POIs;
