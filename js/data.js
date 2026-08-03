/* =============================================================================
   data.js — STATIC GAME CONFIG
   Tune the whole economy from here. No game logic lives in this file.
   Asset paths are relative so you can swap any PNG in /assets without touching
   code, as long as you keep the filename.
   ============================================================================ */

const CONFIG = {
  startingCredits: 1500,

  // Market tick: how often live prices wiggle (ms).
  marketTickMs: 2000,

  // Chat feed: a new alien message every 4–8s (randomized per message).
  chatMinMs: 4000,
  chatMaxMs: 8000,
  chatMaxMessages: 100,       // trader chat: keep the last N on screen

  // Feed-log caps.
  newswireMax: 30,            // GBN newswire log: keep the last N
  localFeedMax: 15,           // per-system local feed: keep the last N

  // Broadcast: NEWS fires every 1–2h (randomized). Between news = TV shows.
  newsMinMs: 60 * 60 * 1000,  // 1 hour
  newsMaxMs: 120 * 60 * 1000, // 2 hours
  tvRotateMs: 25 * 1000,      // TV show changes every ~25s when no news is live
  newsScreenMs: 90 * 1000,    // how long the NEWS frame stays up before TV resumes

  // How long a price-moving news event distorts the market (ms).
  newsEffectMs: 45 * 60 * 1000,

  // Omen → news: a *real* omen schedules its news event this far ahead.
  omenLeadMinMs: 5 * 60 * 1000,
  omenLeadMaxMs: 15 * 60 * 1000,

  // Number of alien portrait sprites available in /assets/portraits.
  portraitCount: 12,

  // Market guardrails. Prices stay in a TIGHT band around base; only senate
  // legislation shifts the band (the one thing that moves price sharply). News,
  // insight and the deterministic oscillators nudge price within it.
  priceFloorMult: 0.88,       // price floor = (legislation-adjusted) base × this
  priceCeilMult: 1.12,        // price ceil = (legislation-adjusted) base × this  (≈ ±12%)
  newsImpact: 0.10,           // how much a news/insight/schedule event nudges price (×nominal). Low = calm.
  driftAmp: 0.04,             // amplitude of the slow per-category secular drift
  driftPeriodMs: 30 * 60 * 1000, // one full sector-rotation cycle

  // Legacy random-walk knobs (unused by the Phase-0 deterministic market; kept
  // so old notes/saves mentioning them aren't confusing mid-migration).
  meanReversion: 0.02,
  overheatBand: 0.03,
  overheatPull: 0.05,
  maxTickMove: 0.004,
  volScale: 0.006,

  // Offline catch-up: cap how much real time we simulate forward on return.
  maxOfflineMs: 7 * 24 * 60 * 60 * 1000, // 7 days

  // Autosave cadence.
  autosaveMs: 10 * 1000,

  // DEV: set true to make news fire every ~20s so you can watch it work.
  fastNews: false,
};

/* ---- COMMODITIES ----------------------------------------------------------
   category drives which systems are cheap/dear and which news hits it.
   vol = volatility (0–1); higher = bigger live price swings.
   rarity = common|uncommon|rare|exotic — gates Exchange stocking (Market.stocks).
   craftOnly = not in normal system stock; expedition/mission/blueprint sourced.
   See docs/CRAFTING_AND_MATERIALS.md §1.                                        */
const COMMODITIES = [
  // Minerals
  { id: "iron_ore",         name: "Iron Ore",         cat: "mineral", base: 40,   vol: 0.04, rarity: "common" },
  { id: "silicon",          name: "Silicon",          cat: "mineral", base: 65,   vol: 0.05, rarity: "common" },
  { id: "rare_earths",      name: "Rare Earths",      cat: "mineral", base: 220,  vol: 0.09, rarity: "uncommon" },
  { id: "titanium_ore",     name: "Titanium Ore",     cat: "mineral", base: 150,  vol: 0.07, rarity: "uncommon" },
  { id: "cobalt_ore",       name: "Cobalt Ore",       cat: "mineral", base: 90,   vol: 0.06, rarity: "common" },
  { id: "graphene_lattice", name: "Graphene Lattice", cat: "mineral", base: 260,  vol: 0.09, rarity: "uncommon" },
  { id: "pulsar_shard",     name: "Pulsar Shard",     cat: "mineral", base: 680,  vol: 0.17, rarity: "rare" },
  { id: "voidstone",        name: "Voidstone",        cat: "mineral", base: 1400, vol: 0.20, rarity: "exotic", craftOnly: true },
  // Gas
  { id: "hydrogen",         name: "Hydrogen",         cat: "gas",     base: 30,   vol: 0.05, rarity: "common" },
  { id: "helium3",          name: "Helium-3",         cat: "gas",     base: 180,  vol: 0.08, rarity: "common" },
  { id: "water_ice",        name: "Water Ice",        cat: "gas",     base: 25,   vol: 0.06, rarity: "common" },
  { id: "plasma_gas",       name: "Plasma Gas",       cat: "gas",     base: 210,  vol: 0.10, rarity: "uncommon" },
  { id: "methane_slurry",   name: "Methane Slurry",   cat: "gas",     base: 85,   vol: 0.06, rarity: "common" },
  { id: "xenon_gas",        name: "Xenon Gas",        cat: "gas",     base: 260,  vol: 0.11, rarity: "uncommon" },
  { id: "cryo_vapor",       name: "Cryo Vapor",       cat: "gas",     base: 340,  vol: 0.12, rarity: "rare" },
  { id: "quantum_foam",     name: "Quantum Foam",     cat: "gas",     base: 1100, vol: 0.19, rarity: "exotic", craftOnly: true },
  // Agri
  { id: "foodstuffs",       name: "Foodstuffs",       cat: "agri",    base: 55,   vol: 0.05, rarity: "common" },
  { id: "synthsilk",        name: "Synthsilk",        cat: "agri",    base: 140,  vol: 0.07, rarity: "common" },
  { id: "grain",            name: "Grain",            cat: "agri",    base: 35,   vol: 0.04, rarity: "common" },
  { id: "protein_stock",    name: "Protein Stock",    cat: "agri",    base: 70,   vol: 0.05, rarity: "common" },
  { id: "hydro_greens",     name: "Hydro Greens",     cat: "agri",    base: 50,   vol: 0.05, rarity: "common" },
  { id: "algae_paste",      name: "Algae Paste",      cat: "agri",    base: 45,   vol: 0.05, rarity: "common" },
  { id: "biofiber",         name: "Biofiber",         cat: "agri",    base: 160,  vol: 0.08, rarity: "uncommon" },
  { id: "nectar_extract",   name: "Nectar Extract",   cat: "agri",    base: 190,  vol: 0.08, rarity: "uncommon" },
  { id: "medicinal_herbs",  name: "Medicinal Herbs",  cat: "agri",    base: 200,  vol: 0.09, rarity: "uncommon" },
  { id: "spore_culture",    name: "Spore Culture",    cat: "agri",    base: 380,  vol: 0.14, rarity: "rare" },
  // Tech
  { id: "nanochips",        name: "Nanochips",        cat: "tech",    base: 320,  vol: 0.10, rarity: "common" },
  { id: "antimatter",       name: "Antimatter",       cat: "tech",    base: 900,  vol: 0.14, rarity: "rare" },
  { id: "fusion_cell",      name: "Fusion Cell",      cat: "tech",    base: 260,  vol: 0.08, rarity: "common" },
  { id: "sensor_array",     name: "Sensor Array",     cat: "tech",    base: 410,  vol: 0.11, rarity: "uncommon" },
  { id: "neural_processor", name: "Neural Processor", cat: "tech",    base: 560,  vol: 0.13, rarity: "rare" },
  { id: "quantum_core",     name: "Quantum Core",     cat: "tech",    base: 750,  vol: 0.13, rarity: "rare" },
  { id: "ai_matrix",        name: "AI Matrix",        cat: "tech",    base: 2200, vol: 0.22, rarity: "exotic", craftOnly: true },
  // Luxury
  { id: "spice",            name: "Spice",            cat: "luxury",  base: 260,  vol: 0.12, rarity: "common" },
  { id: "gemstones",        name: "Gemstones",        cat: "luxury",  base: 300,  vol: 0.10, rarity: "common" },
  { id: "vintage_wine",     name: "Vintage Wine",     cat: "luxury",  base: 180,  vol: 0.08, rarity: "common" },
  { id: "perfume_essence",  name: "Perfume Essence",  cat: "luxury",  base: 220,  vol: 0.09, rarity: "common" },
  { id: "fine_art",         name: "Fine Art",         cat: "luxury",  base: 420,  vol: 0.13, rarity: "uncommon" },
  { id: "exotic_pelts",     name: "Exotic Pelts",     cat: "luxury",  base: 520,  vol: 0.15, rarity: "rare" },
  // Contraband / illicit
  { id: "contraband",         name: "Contraband",         cat: "illicit", base: 480,  vol: 0.18, rarity: "common" },
  { id: "narcotics",          name: "Narcotics",          cat: "illicit", base: 340,  vol: 0.16, rarity: "common" },
  { id: "forged_credentials", name: "Forged Credentials", cat: "illicit", base: 410,  vol: 0.15, rarity: "uncommon" },
  { id: "weapons_cache",      name: "Weapons Cache",      cat: "illicit", base: 600,  vol: 0.17, rarity: "uncommon" },
  { id: "bio_toxin",          name: "Bio Toxin",          cat: "illicit", base: 720,  vol: 0.19, rarity: "rare" },
  { id: "cipher_shard",       name: "Cipher Shard",       cat: "illicit", base: 950,  vol: 0.21, rarity: "rare", craftOnly: true },
];

/* ---- STAR SYSTEMS ---------------------------------------------------------
   mods = price multipliers by category. <1 = cheap to buy here (a source),
   >1 = sells dear here (a sink). distance drives cargo-run travel time.
   locked systems are unlocked by paying `unlock` credits.                     */
const SYSTEMS = [
  { id: "navos",  name: "Navos Junction", distance: 0,  unlock: 0,
    mods: { mineral: 1.0, gas: 1.0, agri: 1.0, tech: 1.0, luxury: 1.0, illicit: 1.0 }, home: true },
  { id: "korrin", name: "Korrin Belt",    distance: 3,  unlock: 0,
    mods: { mineral: 0.65, gas: 0.9, agri: 1.25, tech: 1.2, luxury: 1.15, illicit: 1.1 } },
  { id: "velm",   name: "Velm Tide",      distance: 5,  unlock: 0,
    mods: { mineral: 1.2, gas: 0.6, agri: 0.85, tech: 1.15, luxury: 1.1, illicit: 1.0 } },
  { id: "thessa", name: "Thessa Greens",  distance: 7,  unlock: 6000,
    mods: { mineral: 1.15, gas: 1.1, agri: 0.55, tech: 1.25, luxury: 1.2, illicit: 1.05 } },
  { id: "orin",   name: "Orin Forge",     distance: 10, unlock: 18000,
    mods: { mineral: 1.1, gas: 1.15, agri: 1.2, tech: 0.6, luxury: 1.1, illicit: 1.15 } },
  { id: "sable",  name: "Sable Reach",    distance: 14, unlock: 45000,
    mods: { mineral: 1.25, gas: 1.2, agri: 1.3, tech: 1.2, luxury: 0.7, illicit: 0.55 } },
];

/* ---- SHIPS ----------------------------------------------------------------
   Ships are persistent assets with combat stats. Transports carry cargo;
   escorts bring firepower; survey hulls are built for anomaly scans (scan /
   endure). The "main" ship is your private flagship: sector-transfer speed plus
   one-or-more unique effects (rarity = effect count). speed = relative.       */
const SHIP_CATALOG = {
  transport: [
    { id: "mule",      name: "Mule Shuttle",     cls: "transport", cargo: 12,  firepower: 1,  hull: 40,  armor: 5,   shields: 0,   speed: 1.5, slots: 2, price: 0,     sprite: "shuttle" },
    { id: "clipper",   name: "Lane Clipper",     cls: "transport", cargo: 22,  firepower: 2,  hull: 55,  armor: 8,   shields: 4,   speed: 1.7, slots: 2, price: 2800,  sprite: "shuttle" },
    { id: "drift",     name: "Drift Hauler",     cls: "transport", cargo: 40,  firepower: 2,  hull: 80,  armor: 10,  shields: 0,   speed: 1.2, slots: 2, price: 4200,  sprite: "hauler" },
    { id: "tanker",    name: "Cryo Tanker",      cls: "transport", cargo: 70,  firepower: 2,  hull: 110, armor: 14,  shields: 8,   speed: 1.05,slots: 3, price: 9000,  sprite: "hauler" },
    { id: "bulk",      name: "Bulk Freighter",   cls: "transport", cargo: 120, firepower: 3,  hull: 160, armor: 20,  shields: 5,   speed: 1.0, slots: 3, price: 16000, sprite: "freighter" },
    { id: "ore_mule",  name: "Ore Mule",         cls: "transport", cargo: 180, firepower: 4,  hull: 200, armor: 28,  shields: 6,   speed: 0.9, slots: 3, price: 28000, sprite: "freighter" },
    { id: "leviathan", name: "Leviathan Barge",  cls: "transport", cargo: 400, firepower: 5,  hull: 320, armor: 40,  shields: 10,  speed: 0.8, slots: 3, price: 60000, sprite: "leviathan" },
    // Workshop craftables (never sold — price 0, blueprint-gated).
    { id: "craft_courier",   name: "Yard Courier",    cls: "transport", cargo: 30,  firepower: 4,  hull: 95,  armor: 16, shields: 12, speed: 1.9,  slots: 3, price: 0, sprite: "shuttle",   craftOnly: true },
    { id: "craft_freighter", name: "Yard Freighter",  cls: "transport", cargo: 150, firepower: 6,  hull: 230, armor: 32, shields: 18, speed: 1.05, slots: 4, price: 0, sprite: "freighter", craftOnly: true },
    { id: "void_caravan",    name: "Void Caravan",    cls: "transport", cargo: 470, firepower: 9,  hull: 390, armor: 55, shields: 28, speed: 0.9,  slots: 4, price: 0, sprite: "leviathan", craftOnly: true },
    { id: "argent_ark",      name: "The Argent Ark",  cls: "transport", cargo: 760, firepower: 22, hull: 640, armor: 95, shields: 65, speed: 1.0,  slots: 5, price: 0, sprite: "leviathan", craftOnly: true, unique: true },
  ],
  escort: [
    { id: "gunboat",   name: "Gunboat",    cls: "escort", cargo: 2,  firepower: 18,  hull: 90,  armor: 22,  shields: 12,  speed: 2.0, slots: 2, price: 7000,   sprite: "voidkin" },
    { id: "corvette",  name: "Corvette",   cls: "escort", cargo: 4,  firepower: 25,  hull: 120, armor: 30,  shields: 20,  speed: 1.8, slots: 2, price: 11000,  sprite: "voidkin" },
    { id: "destroyer", name: "Destroyer",  cls: "escort", cargo: 6,  firepower: 40,  hull: 180, armor: 45,  shields: 30,  speed: 1.65,slots: 3, price: 20000,  sprite: "glorthi" },
    { id: "frigate",   name: "Frigate",    cls: "escort", cargo: 8,  firepower: 55,  hull: 240, armor: 60,  shields: 45,  speed: 1.5, slots: 3, price: 32000,  sprite: "glorthi" },
    { id: "cruiser",   name: "Cruiser",    cls: "escort", cargo: 14, firepower: 120, hull: 480, armor: 120, shields: 90,  speed: 1.2, slots: 4, price: 95000,  sprite: "krell" },
    { id: "carrier",   name: "Escort Carrier", cls: "escort", cargo: 18, firepower: 90, hull: 520, armor: 100, shields: 110, speed: 1.1, slots: 4, price: 120000, sprite: "krell" },
    { id: "battleship",name: "Battleship", cls: "escort", cargo: 20, firepower: 260, hull: 900, armor: 240, shields: 180, speed: 1.0, slots: 4, price: 270000, sprite: "aurelian" },
    // Workshop craftables (not sold in the Bazaar shipyard — price 0; blueprint-gated).
    { id: "craft_corvette", name: "Yard Corvette", cls: "escort", cargo: 5, firepower: 32, hull: 145, armor: 38, shields: 26, speed: 1.85, slots: 3, price: 0, sprite: "voidkin", craftOnly: true },
    { id: "craft_frigate",  name: "Yard Frigate",  cls: "escort", cargo: 9, firepower: 68, hull: 275, armor: 70, shields: 55, speed: 1.5, slots: 3, price: 0, sprite: "glorthi", craftOnly: true },
    { id: "craft_cruiser",  name: "Yard Cruiser",  cls: "escort", cargo: 16, firepower: 150, hull: 560, armor: 140, shields: 105, speed: 1.25, slots: 4, price: 0, sprite: "krell", craftOnly: true },
    { id: "last_aegis",     name: "The Last Aegis", cls: "escort", cargo: 24, firepower: 340, hull: 1100, armor: 300, shields: 220, speed: 1.15, slots: 5, price: 0, sprite: "aurelian", craftOnly: true, unique: true },
  ],
  // Survey hulls: weak in a fight, strong on anomaly scans (scan / endure).
  survey: [
    { id: "probe_skiff",  name: "Probe Skiff",    cls: "survey", cargo: 2, firepower: 1, hull: 45,  armor: 6,  shields: 8,  speed: 2.2, slots: 3, price: 6500,  sprite: "shuttle", scan: 2, endure: 1 },
    { id: "survey_cutter",name: "Survey Cutter",  cls: "survey", cargo: 4, firepower: 2, hull: 70,  armor: 10, shields: 14, speed: 1.9, slots: 3, price: 14000, sprite: "hauler",  scan: 3, endure: 2 },
    { id: "deep_mapper",  name: "Deep Mapper",    cls: "survey", cargo: 6, firepower: 3, hull: 110, armor: 16, shields: 22, speed: 1.6, slots: 4, price: 32000, sprite: "freighter", scan: 5, endure: 3 },
    { id: "void_cartograph", name: "Void Cartograph", cls: "survey", cargo: 8, firepower: 4, hull: 160, armor: 22, shields: 30, speed: 1.4, slots: 4, price: 72000, sprite: "leviathan", scan: 7, endure: 4 },
    // Workshop craftables (never sold — price 0, blueprint-gated).
    { id: "craft_probe",      name: "Yard Probe",       cls: "survey", cargo: 3,  firepower: 2, hull: 85,  armor: 12, shields: 18, speed: 2.1, slots: 3, price: 0, sprite: "shuttle",   scan: 4,  endure: 2, craftOnly: true },
    { id: "craft_pathfinder", name: "Pathfinder Cutter",cls: "survey", cargo: 6,  firepower: 4, hull: 150, armor: 20, shields: 30, speed: 1.7, slots: 4, price: 0, sprite: "hauler",    scan: 6,  endure: 4, craftOnly: true },
    { id: "oracle_lens",      name: "The Oracle Lens",  cls: "survey", cargo: 10, firepower: 7, hull: 250, armor: 36, shields: 52, speed: 1.6, slots: 5, price: 0, sprite: "leviathan", scan: 11, endure: 7, craftOnly: true, unique: true },
  ],
  // Main/flagship: travelSpeed + effects[]. rarity tier ⇒ effect count (common=1 … legendary=5).
  main: [
    // common — 1 effect
    { id: "pinnace",      name: "Baron's Pinnace",     cls: "main", rarity: "common",    travelSpeed: 1.0, effects: [{ type: "firepower", pct: 0.05 }], hull: 200,  price: 0,      sprite: "shuttle" },
    { id: "lane_runner",  name: "Lane Runner",         cls: "main", rarity: "common",    travelSpeed: 1.4, effects: [{ type: "speed", pct: 0.08 }],      hull: 220,  price: 12000,  sprite: "shuttle" },
    { id: "ore_throne",   name: "Ore Throne",          cls: "main", rarity: "common",    travelSpeed: 1.1, effects: [{ type: "industry", pct: 0.06 }],   hull: 260,  price: 18000,  sprite: "hauler" },
    { id: "quiet_keel",   name: "Quiet Keel",          cls: "main", rarity: "common",    travelSpeed: 1.2, effects: [{ type: "routeSafe", pct: 0.10 }],  hull: 240,  price: 16000,  sprite: "hauler" },
    // uncommon — 2 effects
    { id: "yacht",        name: "Void Yacht",          cls: "main", rarity: "uncommon",  travelSpeed: 1.6, effects: [{ type: "speed", pct: 0.10 }, { type: "cargo", pct: 0.06 }], hull: 320, price: 24000, sprite: "hauler" },
    { id: "harvest_seat", name: "Harvest Seat",        cls: "main", rarity: "uncommon",  travelSpeed: 1.3, effects: [{ type: "industry", pct: 0.08 }, { type: "taxRelief", pct: 0.04 }], hull: 340, price: 38000, sprite: "freighter" },
    { id: "chart_crown",  name: "Chart Crown",         cls: "main", rarity: "uncommon",  travelSpeed: 1.5, effects: [{ type: "survey", pct: 0.12 }, { type: "speed", pct: 0.05 }], hull: 300, price: 36000, sprite: "shuttle" },
    { id: "escort_pulpit",name: "Escort Pulpit",       cls: "main", rarity: "uncommon",  travelSpeed: 1.4, effects: [{ type: "firepower", pct: 0.10 }, { type: "routeSafe", pct: 0.08 }], hull: 380, price: 42000, sprite: "freighter" },
    // rare — 3 effects
    { id: "flagship",     name: "Command Flagship",    cls: "main", rarity: "rare",      travelSpeed: 2.2, effects: [{ type: "firepower", pct: 0.12 }, { type: "speed", pct: 0.06 }, { type: "routeSafe", pct: 0.08 }], hull: 640, price: 140000, sprite: "freighter" },
    { id: "foundry_ark",  name: "Foundry Ark",         cls: "main", rarity: "rare",      travelSpeed: 1.8, effects: [{ type: "industry", pct: 0.12 }, { type: "taxRelief", pct: 0.06 }, { type: "cargo", pct: 0.08 }], hull: 700, price: 160000, sprite: "leviathan" },
    { id: "lens_of_sable",name: "Lens of Sable",       cls: "main", rarity: "rare",      travelSpeed: 2.0, effects: [{ type: "survey", pct: 0.18 }, { type: "speed", pct: 0.08 }, { type: "firepower", pct: 0.05 }], hull: 560, price: 155000, sprite: "hauler" },
    // epic — 4 effects
    { id: "magnate_spire",name: "Magnate Spire",       cls: "main", rarity: "epic",      travelSpeed: 2.4, effects: [{ type: "firepower", pct: 0.10 }, { type: "industry", pct: 0.10 }, { type: "routeSafe", pct: 0.10 }, { type: "taxRelief", pct: 0.05 }], hull: 900, price: 320000, sprite: "leviathan" },
    { id: "ghost_cathedral", name: "Ghost Cathedral",  cls: "main", rarity: "epic",      travelSpeed: 2.6, effects: [{ type: "survey", pct: 0.20 }, { type: "routeSafe", pct: 0.12 }, { type: "speed", pct: 0.10 }, { type: "cargo", pct: 0.08 }], hull: 820, price: 340000, sprite: "freighter" },
    // legendary — 5 effects
    { id: "dreadnought",  name: "Baron Dreadnought",   cls: "main", rarity: "legendary", travelSpeed: 3.0, effects: [{ type: "all", pct: 0.10 }, { type: "industry", pct: 0.08 }, { type: "routeSafe", pct: 0.10 }, { type: "survey", pct: 0.10 }, { type: "taxRelief", pct: 0.06 }], hull: 1300, price: 650000, sprite: "leviathan" },
    { id: "cosmocrat_seat", name: "Cosmocrat Seat",    cls: "main", rarity: "legendary", travelSpeed: 3.2, effects: [{ type: "all", pct: 0.08 }, { type: "industry", pct: 0.12 }, { type: "taxRelief", pct: 0.08 }, { type: "routeSafe", pct: 0.12 }, { type: "survey", pct: 0.12 }], hull: 1400, price: 800000, sprite: "leviathan" },
  ],
};
const ALL_SHIPS = [...SHIP_CATALOG.transport, ...SHIP_CATALOG.escort, ...(SHIP_CATALOG.survey || []), ...SHIP_CATALOG.main];

/* ---- SHIP VARIANTS --------------------------------------------------------
   Every hull the Bazaar shipyard puts on the shelf is a specific, pre-named
   second-hand ship rather than a catalog entry: a yard refit that traded one
   stat away for another. `mods` are percentages applied to the hull's base
   stats in Fleet.stats(); `cls` (optional) limits a refit to those hull
   classes.

   HARD RULE — every variant must be a TRADE-OFF, never a free upgrade. The
   sale price is the plain catalog price, because that's what the server charges
   in app_buy_ship: a variant that was strictly better would be free power, and
   a variant that cost more would bill the player for something the server never
   collected. Keep the pluses and minuses roughly balanced, and if you ever want
   price to vary, teach app_buy_ship about the offer first.                     */
const SHIP_VARIANTS = [
  { id: "stock",     name: "Stock",       tag: "factory refit",   mods: {} },
  { id: "widebelly", name: "Wide-Belly",  tag: "hauler refit",    mods: { cargo: 0.30, speed: -0.15 } },
  { id: "runner",    name: "Blockade",    tag: "runner refit",    mods: { speed: 0.25, cargo: -0.20 } },
  { id: "ironclad",  name: "Ironclad",    tag: "armour refit",    mods: { armor: 0.35, hull: 0.15, speed: -0.12 } },
  { id: "uparmed",   name: "Up-Gunned",   tag: "weapons refit",   mods: { firepower: 0.40, cargo: -0.15, speed: -0.05 } },
  { id: "stripped",  name: "Stripped",    tag: "lightened",       mods: { speed: 0.20, armor: -0.25, shields: -0.25 } },
  { id: "shielded",  name: "Bulwark",     tag: "shield refit",    mods: { shields: 0.45, firepower: -0.15 } },
  { id: "veteran",   name: "Veteran",     tag: "well-used",       mods: { firepower: 0.15, hull: -0.12, armor: -0.10 } },
  { id: "longhaul",  name: "Long-Haul",   tag: "endurance refit", mods: { cargo: 0.18, hull: 0.18, firepower: -0.25 } },
  // survey-only refits
  { id: "farsight",  name: "Farsight",    tag: "sensor refit",    cls: ["survey"], mods: { scan: 0.35, hull: -0.15 } },
  { id: "hardened",  name: "Hardened",    tag: "deep-void refit", cls: ["survey"], mods: { endure: 0.40, speed: -0.15 } },
];

// Labels for flagship effect types (UI + tooltips).
const FLAGSHIP_EFFECTS = {
  firepower: { label: "Fleet firepower" },
  speed:     { label: "Fleet speed" },
  hull:      { label: "Fleet hull" },
  armor:     { label: "Fleet armor" },
  shields:   { label: "Fleet shields" },
  cargo:     { label: "Fleet cargo" },
  all:       { label: "All fleet stats" },
  industry:  { label: "Industry yield" },
  routeSafe: { label: "Safer charters" },
  survey:    { label: "Survey scan power" },
  taxRelief: { label: "Industry tax relief" },
};

/* ---- SHIP ACCESSORIES -----------------------------------------------------
   Procedurally named/statted items (see items.js). Each kind buffs one stat;
   pct stats scale the ship, flat stats add. Legendaries get a 2nd bonus stat.
   Survey gear (scanner / probe / survey_shield) tunes anomaly scan odds.      */
const ACCESSORY_KINDS = {
  engine:  { label: "Engine",   stat: "speed",     pct: true,  base: 0.04,  sprite: "engine" },
  reactor: { label: "Reactor",  stat: "firepower", pct: true,  base: 0.06,  sprite: "reactor" },
  cannon:  { label: "Cannon",   stat: "firepower", pct: false, base: 12,    sprite: "cannon" },
  plating: { label: "Plating",  stat: "armor",     pct: false, base: 18,    sprite: "plating" },
  shield:  { label: "Shield",   stat: "shields",   pct: false, base: 16,    sprite: "shield" },
  hold:    { label: "Cargo Pod",stat: "cargo",     pct: false, base: 8,     sprite: "hold" },
  scanner: { label: "Deep Scanner", stat: "scan",  pct: false, base: 1.5,   sprite: "reactor", survey: true },
  probe:   { label: "Probe Rack",   stat: "scan",  pct: false, base: 1.0,   sprite: "engine",  survey: true },
  survey_shield: { label: "Survey Shield", stat: "endure", pct: false, base: 1.2, sprite: "shield", survey: true },
};
// rarity → stat multiplier, price multiplier, drop weight, color, label.
const RARITIES = [
  { id: "common",    mult: 1.0, price: 1.0, weight: 50, color: "#9aa9c8", label: "Common" },
  { id: "uncommon",  mult: 1.5, price: 2.2, weight: 28, color: "#46d39a", label: "Uncommon" },
  { id: "rare",      mult: 2.3, price: 5,   weight: 14, color: "#5aa9ff", label: "Rare" },
  { id: "epic",      mult: 3.4, price: 12,  weight: 6,  color: "#c07bff", label: "Epic" },
  { id: "legendary", mult: 5.0, price: 30,  weight: 2,  color: "#ffb43a", label: "Legendary" },
];

/* ---- BAZAAR / CONTRACTS ---------------------------------------------------*/
const BAZAARCFG = {
  // Contracts get harder as your Baron Tier climbs: bigger pay, but steeper fleet
  // requirements and a heavier failure penalty (per tier).
  tierStakeMult: 0.5,      // +50% gross reward per Baron Tier
  tierReqMult: 0.3,        // +30% required firepower/cargo per Baron Tier
  tierRiskMult: 0.2,       // +20% ship-loss chance / retrieval cost on failure per Baron Tier
  mercSlots: 8,            // how many mercs are on offer at once
  contractSlots: 14,       // how many contracts on the board
  accessorySlots: 18,      // how many accessories for sale
  blackboxSlots: 2,        // rare rotating consumable blackboxes on the Gear tab
  blueprintSlots: 2,       // rare rotating recipe blueprints on the Gear tab
  // Blackboxes + blueprints restock on their OWN slow clock, not the 60s board
  // epoch: both are permanent-ish power (a recipe unlocked forever, a stacked
  // timed buff), so a fast rotation let anyone with credits buy out the pool in
  // one sitting. One shelf per day; sold-out slots stay sold out until it turns.
  slowRotationMs: 24 * 60 * 60 * 1000,
  flagshipSlots: 4,        // rotating flagship offers (current flagship is always shown separately)
  // Shipyard: named, refitted hulls that rotate as a set. You never see the whole
  // catalog at once — waiting for the hull/refit you want is the point.
  yardSlots: 8,            // how many ships are on the shelf at a time
  yardRotationMs: 5 * 60 * 1000,   // the shelf turns over this often
  mercTickMs: 90 * 1000,   // how often merc offers churn
  accessoryTickMs: 45 * 1000, // how often an accessory may sell / refresh
  contractExpiryMs: 8 * 60 * 1000,   // an open contract expires after this
  contractNpcTakeMs: 4 * 60 * 1000,  // ~when an NPC may grab an untaken job
  contractTakenShowMs: 2 * 60 * 1000,// "Contract taken" lingers this long
  inventoryUpgradeStep: 10,          // +slots per upgrade
  inventoryUpgradeBase: 6000,        // first upgrade price (scales up)
  itemResaleMult: 0.55,              // instant "Sell now" payout = this × an item's value
  shipResaleMult: 0.5,               // sell a ship for this × its catalog price (40–60% band); gear adds its resale value
  // Cancel a taken-but-not-launched job: fee = max(min, reward × rate × (1 + tier × tierMult)).
  cancelFeeRate: 0.10,               // 10% of contract reward at Baron
  cancelFeeTierMult: 0.35,           // +35% of that base per Baron Tier (Magnate ≈13.5% … Cosmocrat ≈31%)
  cancelFeeMin: 250,                 // floor so tiny tips/jobs still sting
};

/* ---- CHARTER CONTRACTS ----------------------------------------------------
   Long-duration jobs bought from the Bazaar. Player stakes a hull (not credits)
   against a locked-in payout; risk band + duration set pay and destroy odds.
   Replaces automated trade routes (see docs / CHARTER_CONTRACTS).              */
const CHARTERCFG = {
  durations: [30, 60, 120, 240, 480, 720, 1440, 2880, 4320], // minutes: 30m … 72h
  rateBase: 600,          // flat c/h floor for any hull
  rateCargo: 30,          // c/h per point of cargo
  rateFirepower: 60,      // c/h per point of firepower
  taperExp: 0.75,         // hours^taperExp — long charters pay less per hour
  payoutCapMult: 3,       // cap vs Economy.depth(); null disables
  durationRiskExp: 0.5,   // hours^this — a 72h run is ~8.5× as dangerous as 1h
  hullSoftness: 220,      // hull points at which a ship is "sturdy" (factor 1.0)
  hullFactorClamp: [0.45, 2.2],
  bailoutAt: 0.5,         // fraction of duration before which cancelling costs money
  abortFeeRate: 0.70,     // early cancel = −reward × this
  salvageFloor: 0.35,     // buyout at the bailout point
  salvageCeil: 0.60,      // buyout ceiling as the charter matures
  salvageStepMin: 10,     // buyout ticks up in steps of this many minutes
  maxActive: 3,           // charters running at once
};

// Charter-specific risk (pay multipliers reuse DANGER). destroy/impound are
// 1h bases; Charters.destroyChance scales them by duration × hull softness.
const CHARTER_BANDS = {
  safe:     { destroy: 0,    impound: 0,    faction: null,             blurb: "Lane courier — always completes." },
  low:      { destroy: 0.01, impound: 0,    faction: "free_trade",     blurb: "Bulk haul with light lane risk." },
  moderate: { destroy: 0.03, impound: 0,    faction: "mining_combine", blurb: "Ore run — damage or a shorted purse." },
  high:     { destroy: 0.07, impound: 0,    faction: "agri_collective",blurb: "Smuggle run — hulls don't always come home." },
  extreme:  { destroy: 0.14, impound: 0.06, faction: "syndicate",      blurb: "Contraband charter — destroyed or impounded." },
};

/* ---- INCIDENTS ------------------------------------------------------------
   Random choice-driven encounters during active play (incidents.js). Timer
   only runs while the tab is visible, so they never fire during idle.          */
const INCIDENTCFG = {
  minMs: 6 * 60 * 1000,    // soonest between incidents
  maxMs: 13 * 60 * 1000,   // latest between incidents
};

/* ---- FACTION WARS ---------------------------------------------------------
   Rival factions periodically go to war, shocking their domain categories and
   spawning bonus-paying "war effort" contracts (wars.js).                      */
const WARCFG = {
  minMs: 25 * 60 * 1000,   // soonest between wars
  maxMs: 50 * 60 * 1000,   // latest between wars
  durationMs: 22 * 60 * 1000,
  spike: 1.45,             // aggressor's goods get scarce/dear
  slump: 0.68,             // defender's goods slump in the chaos
  contractBonus: 0.5,      // war-effort contracts pay +50%
};

/* ---- INDUSTRIES -----------------------------------------------------------
   Build factories/mines/farms on star-map planets; they slowly produce that
   planet's commodity into your tradeable stock (industries.js). Licensed by
   your standing with the commodity's controlling faction; halted by local
   disruptions (strikes) and faction-war slumps.                               */
const INDUSTRYCFG = {
  cycleMs: 12 * 60 * 60 * 1000,   // taxed batches drop every ~12h (slow & passive)
  baseYield: 50,                  // batches/12h before planet suitability (and, later, extractor/components)
  permitBase: 6000,               // faction permit price at neutral standing (× a standing discount); neutral space is free
  permitRepDiscount: 0.5,         // up to 50% off the permit at +100 standing
  permitMinRep: 0,                // need standing ≥ this to licence a faction planet
  neutralTax: 0.05,               // flat tax in neutral (core / Navos) space
  factionBaseTax: 0.12,           // tax on a faction planet at neutral standing
  taxRepRelief: 0.6,              // positive standing cuts tax by up to this fraction (at +100)
  taxNegPenalty: 1.5,             // negative standing multiplies tax up (full effect at the seizure line)
  destroyRep: -40,                // a faction seizes your structure at/below this standing
  atRiskRep: -25,                 // show an "at risk" warning from here down
  warBoost: 2,                    // ×production when its category is a war's hot side
  maxPerPlayer: 12,               // how many permits you may hold at once
  maxCyclesPerResolve: 8,         // offline batch cap per industry (8 × 12h ≈ 4 days)
};

/* ---- EXTRACTORS -----------------------------------------------------------
   Bought in the Bazaar and installed into a permitted industry slot. Type sets
   what it can produce and its yield tier: specialized = one commodity (best),
   semi = a whole category (gas / tech / …), jack = anything (worst).           */
const EXTRACTORCFG = {
  types: {
    specialized: { label: "specialized", yieldMult: 1.5, price: 14000 },
    semi:        { label: "semi-spec",    yieldMult: 1.0, price: 9000 },
    jack:        { label: "jack",         yieldMult: 0.6, price: 5000 },
  },
  bazaarSlots: 4,          // how many extractors on offer at once
  componentSlots: 2,       // component slots per extractor
};

/* ---- COMPONENTS -----------------------------------------------------------
   Rarity-tiered upgrades bought in the Bazaar and slotted into an extractor:
   "rate" raises yield, "speed" shortens the batch cycle. Effect = base × the
   rarity multiplier (RARITIES).                                                */
const COMPONENTCFG = {
  kinds: { rate: { label: "Yield Booster" }, speed: { label: "Cycle Optimizer" } },
  rateBase: 0.08,          // +yield fraction per rate component (× rarity mult)
  speedBase: 0.06,         // −cycle-time fraction per speed component (× rarity mult)
  cycleFloor: 0.4,         // an extractor's cycle can't drop below this × base
  priceBase: 1800,         // × rarity price multiplier
  bazaarSlots: 5,          // how many components on offer at once
};

/* Planet suitability: how well a planet TYPE yields each commodity CATEGORY
   (a multiplier on base output). Volcanic worlds are rich in minerals but
   hopeless for farms; gas giants gush gas; toxic worlds breed contraband.      */
const PLANET_SUITABILITY = {
  rocky:     { mineral: 1.4, gas: 0.6, agri: 0.4,  tech: 1.0, luxury: 0.7, illicit: 0.9 },
  terran:    { mineral: 0.6, gas: 0.8, agri: 1.8,  tech: 1.1, luxury: 1.3, illicit: 0.6 },
  ocean:     { mineral: 0.5, gas: 1.2, agri: 1.5,  tech: 0.9, luxury: 1.2, illicit: 0.7 },
  ice:       { mineral: 0.8, gas: 1.7, agri: 0.3,  tech: 0.9, luxury: 0.6, illicit: 0.8 },
  lava:      { mineral: 1.8, gas: 0.6, agri: 0.1,  tech: 1.2, luxury: 0.5, illicit: 1.0 },
  gas_giant: { mineral: 0.3, gas: 1.9, agri: 0.1,  tech: 0.8, luxury: 0.6, illicit: 0.7 },
  barren:    { mineral: 1.5, gas: 0.5, agri: 0.1,  tech: 0.9, luxury: 0.5, illicit: 1.2 },
  ringed:    { mineral: 1.2, gas: 1.3, agri: 0.3,  tech: 1.0, luxury: 1.1, illicit: 0.8 },
  toxic:     { mineral: 1.1, gas: 1.0, agri: 0.05, tech: 1.2, luxury: 0.5, illicit: 1.6 },
};
// danger tiers drive contract risk → base success + reward scaling.
// `pay` multiplies a contract's base credit reward, so higher-risk jobs (which
// need real firepower) pay much more than the safe early grind.
const DANGER = [
  { id: "safe",     label: "Safe",     baseSuccess: 0.98, pay: 1.0, fpScale: 0 },
  { id: "low",      label: "Low",      baseSuccess: 0.85, pay: 1.4, fpScale: 30 },
  { id: "moderate", label: "Moderate", baseSuccess: 0.6,  pay: 2.0, fpScale: 90 },
  { id: "high",     label: "High",     baseSuccess: 0.4,  pay: 2.8, fpScale: 200 },
  { id: "extreme",  label: "Extreme",  baseSuccess: 0.25, pay: 3.8, fpScale: 450 },
];

/* ---- CUSTOMS --------------------------------------------------------------
   A docking scan that makes CARRYING contraband on the exchange genuinely
   risky, not just a flavor commodity. On arrival, if you hold contraband,
   customs may seize a slice of the stack — likelier under Senate border edicts
   (reuses smuggleFailAdd) and at systems that barely tolerate illicit trade
   (their low `illicit` price mod = tighter scrutiny), softened by Syndicate
   standing (they grease the dockmaster). Losing the goods is the whole
   penalty — no fine on top. Pairs with the smuggle-contract impound path.    */
const CUSTOMS = {
  base: 0.10,          // baseline seizure odds when carrying contraband through a scan
  cap: 0.85,           // never a certainty — a bribe/tip edge always exists
  repShield: 0.30,     // Friendly Syndicate cuts the odds by up to this at +100 standing
  scrutinyClamp: [0.5, 1.6], // system-tolerance multiplier bounds (2 − illicit mod)
  seize: [0.30, 0.70], // fraction of the held contraband taken on a hit
};

/* ---- EXPEDITIONS ----------------------------------------------------------
   Anomaly surveys: dispatch an idle ship to a non-tradeable backdrop system
   and, after a distance-scaled trip, it resolves (live OR offline) into a
   weighted outcome — derelict gear, a fresh commodity seam (a real local price
   event = tradeable insight), a credit windfall, a faction cache, a hazard
   that damages the hull (reuses the damage system; rarely destroys the ship),
   or a dry hole. Farther systems are more dangerous: better loot, worse
   hazards. A per-system cooldown stops back-to-back farming.                  */
const EXPEDCFG = {
  legSecondsPerDist: 220,        // round-trip seconds per unit of (0..1) map distance, before ship speed
  minMs: 20 * 1000,              // floor so a next-door scan still takes a beat
  cooldownMs: 30 * 60 * 1000,    // a surveyed system can be re-surveyed after this
  farAt: 0.28,                   // map distance at/above which a system counts as "far" (richer + rougher)
  rarityBiasMax: 0.6,            // derelict-gear rarity bias at max danger
  hazardDmg: [0.08, 0.30],       // hull fraction lost on a hazard (scaled by danger)
  destroyChance: 0.10,           // chance a hazard is catastrophic (ship lost) — scaled by danger
  creditsBy: { near: [300, 1200], far: [1500, 6000] },
  seamMult: { scarce: 1.5, glut: 0.62 },   // the price swing a discovered seam applies locally
  // Crafting materials (esp. craftOnly exotics) from survey loot — see CRAFTING_AND_MATERIALS §1.2.
  materialQty: { near: [2, 6], far: [4, 14] },
  materialExoticChance: { near: 0.12, far: 0.35 },  // otherwise rare/uncommon pool
  blackboxChance: { near: 0.10, far: 0.22 },       // chance a materials reward also drops a blackbox
  // blueprintDropChance lives on WORKSHOPCFG (shared with mission drops)
  // Matured surveys open a Dispatches mini-story (SurveyStory) instead of
  // auto-resolving. weights still bias which event template pool is favored.
  weights: {
    near: { gear: 3, seam: 3, credits: 3, faction: 2, hazard: 1, dry: 2, signal: 2, derelict: 2, ruin: 1 },
    far:  { gear: 3, seam: 3, credits: 2, faction: 2, hazard: 3, dry: 1, signal: 3, derelict: 3, ruin: 2 },
  },
};

/* ---- BLACKBOX EFFECTS -----------------------------------------------------
   Consumable inventory items. Use → entry on state.activeBoosts until expiresAt.
   See docs/CRAFTING_AND_MATERIALS.md §2.                                       */
const BLACKBOX_EFFECTS = [
  { id: "overclock_core",  name: "Overclock Core",  desc: "+25% extractor yield",
    stat: "industryYield",  mag: 0.25,  durationMs: 2 * 3600 * 1000 },
  { id: "smugglers_veil",  name: "Smuggler's Veil", desc: "-50% customs seizure odds",
    stat: "customsSeize",   mag: -0.50, durationMs: 3 * 3600 * 1000 },
  { id: "autopilot_surge", name: "Autopilot Surge", desc: "-20% mission transit time",
    stat: "missionTransit", mag: -0.20, durationMs: 4 * 3600 * 1000 },
  { id: "silver_tongue",   name: "Silver Tongue",   desc: "+15% contract reward",
    stat: "contractReward", mag: 0.15,  durationMs: 3 * 3600 * 1000 },
  { id: "void_shield",     name: "Void Shield",     desc: "-30% mission hull damage",
    stat: "missionDamage",  mag: -0.30, durationMs: 2 * 3600 * 1000 },
  { id: "tax_ghost",       name: "Tax Ghost",       desc: "-50% industry tax",
    stat: "industryTax",    mag: -0.50, durationMs: 4 * 3600 * 1000 },
  { id: "fabricators_boon", name: "Fabricator's Boon", desc: "-30% Workshop craft time",
    stat: "craftTime",      mag: -0.30, durationMs: 3 * 3600 * 1000 },
  // Second wave — short, punchy versions of the same levers plus survey odds.
  { id: "foundry_blitz",   name: "Foundry Blitz",   desc: "-55% Workshop craft time",
    stat: "craftTime",      mag: -0.55, durationMs: 1 * 3600 * 1000 },
  { id: "bulk_yield",      name: "Bulk Yield Injector", desc: "+45% extractor yield",
    stat: "industryYield",  mag: 0.45,  durationMs: 1 * 3600 * 1000 },
  { id: "iron_ledger",     name: "Iron Ledger",     desc: "-75% industry tax",
    stat: "industryTax",    mag: -0.75, durationMs: 2 * 3600 * 1000 },
  { id: "ghost_manifest",  name: "Ghost Manifest",  desc: "-80% customs seizure odds",
    stat: "customsSeize",   mag: -0.80, durationMs: 90 * 60 * 1000 },
  { id: "hard_bargain",    name: "Hard Bargain",    desc: "+35% contract reward",
    stat: "contractReward", mag: 0.35,  durationMs: 90 * 60 * 1000 },
  { id: "aegis_field",     name: "Aegis Field",     desc: "-60% mission hull damage",
    stat: "missionDamage",  mag: -0.60, durationMs: 90 * 60 * 1000 },
  { id: "long_haul",       name: "Long Haul Protocol", desc: "-35% mission transit time",
    stat: "missionTransit", mag: -0.35, durationMs: 2 * 3600 * 1000 },
  // surveyScan is added straight to a survey choice's odds (Expeditions.choiceChance).
  { id: "deep_lens",       name: "Deep Lens",       desc: "+10pp survey success odds",
    stat: "surveyScan",     mag: 0.10,  durationMs: 3 * 3600 * 1000 },
];

/* ---- WORKSHOP / CRAFTING --------------------------------------------------
   Timed craft queue + blueprint-gated recipes. See CRAFTING_AND_MATERIALS §3. */
const WORKSHOPCFG = {
  baseSlots: 2,
  maxSlots: 5,
  slotUpgradeBase: 14000,          // first extra slot cost (scales like inventory)
  maxResolvePerCatchup: 12,        // crafts delivered in one offline resolve
  blueprintDropChance: { near: 0.06, far: 0.14 },
  missionBlueprintChance: 0.12,    // on high/extreme success (excludes destroyOnUse uniques)
};

// Blueprint meta. recipeId unlocks into state.knownRecipes on acquire.
// source: auto | bazaar | expedition | mission (acquisition hint for drops/stock).
// minBaronTier: prestige.tier floor for source:"auto" (0 = Baron / "Tier 1").
const BLUEPRINTS = [
  { id: "bp_plating_common",   name: "Blueprint: Common Plating",      recipeId: "gear_plating_common",   outputType: "gear",      source: "auto",       minBaronTier: 0, uses: Infinity, destroyOnUse: false },
  { id: "bp_cannon_uncommon",  name: "Blueprint: Uncommon Cannon",     recipeId: "gear_cannon_uncommon",  outputType: "gear",      source: "bazaar",     uses: Infinity, destroyOnUse: false },
  { id: "bp_shield_rare",      name: "Blueprint: Rare Shield",         recipeId: "gear_shield_rare",      outputType: "gear",      source: "expedition", uses: Infinity, destroyOnUse: false },
  { id: "bp_reactor_epic",     name: "Blueprint: Epic Reactor",        recipeId: "gear_reactor_epic",     outputType: "gear",      source: "bazaar",     uses: Infinity, destroyOnUse: false },
  { id: "bp_scanner_legend",   name: "Blueprint: Legendary Scanner",   recipeId: "gear_scanner_legend",   outputType: "gear",      source: "mission",    uses: Infinity, destroyOnUse: false },
  { id: "bp_ex_jack",          name: "Blueprint: Jack Extractor",      recipeId: "ex_jack",               outputType: "extractor", source: "auto",       minBaronTier: 0, uses: Infinity, destroyOnUse: false },
  { id: "bp_ex_semi",          name: "Blueprint: Semi-Spec Extractor", recipeId: "ex_semi",               outputType: "extractor", source: "bazaar",     uses: Infinity, destroyOnUse: false },
  { id: "bp_ex_specialized",   name: "Blueprint: Specialized Extractor", recipeId: "ex_specialized",      outputType: "extractor", source: "expedition", uses: Infinity, destroyOnUse: false },
  { id: "bp_ship_corvette",    name: "Blueprint: Yard Corvette",       recipeId: "ship_corvette",         outputType: "ship",      source: "bazaar",     uses: Infinity, destroyOnUse: false },
  { id: "bp_ship_cruiser",     name: "Blueprint: Yard Cruiser",        recipeId: "ship_cruiser",          outputType: "ship",      source: "expedition", uses: Infinity, destroyOnUse: false },
  { id: "bp_ship_last_aegis",  name: "Blueprint: The Last Aegis",      recipeId: "ship_last_aegis",       outputType: "ship",      source: "mission",    uses: 1, destroyOnUse: true },
  { id: "bp_bb_overclock",     name: "Blueprint: Overclock Core",      recipeId: "bb_overclock_core",     outputType: "blackbox",  source: "auto",       minBaronTier: 1, uses: Infinity, destroyOnUse: false },
  { id: "bp_bb_veil",          name: "Blueprint: Smuggler's Veil",     recipeId: "bb_smugglers_veil",     outputType: "blackbox",  source: "bazaar",     uses: Infinity, destroyOnUse: false },
  { id: "bp_bb_autopilot",     name: "Blueprint: Autopilot Surge",     recipeId: "bb_autopilot_surge",    outputType: "blackbox",  source: "auto",       minBaronTier: 1, uses: Infinity, destroyOnUse: false },
  { id: "bp_bb_silver",        name: "Blueprint: Silver Tongue",       recipeId: "bb_silver_tongue",      outputType: "blackbox",  source: "bazaar",     uses: Infinity, destroyOnUse: false },
  { id: "bp_bb_void",          name: "Blueprint: Void Shield",         recipeId: "bb_void_shield",        outputType: "blackbox",  source: "expedition", uses: Infinity, destroyOnUse: false },
  { id: "bp_bb_tax",           name: "Blueprint: Tax Ghost",           recipeId: "bb_tax_ghost",          outputType: "blackbox",  source: "mission",    uses: Infinity, destroyOnUse: false },
  { id: "bp_bb_fabricator",    name: "Blueprint: Fabricator's Boon",   recipeId: "bb_fabricators_boon",   outputType: "blackbox",  source: "bazaar",     uses: Infinity, destroyOnUse: false },
  // ---- second wave --------------------------------------------------------
  { id: "bp_hold_common",      name: "Blueprint: Common Cargo Pod",    recipeId: "gear_hold_common",      outputType: "gear",      source: "auto",       minBaronTier: 0, uses: Infinity, destroyOnUse: false },
  { id: "bp_engine_uncommon",  name: "Blueprint: Uncommon Engine",     recipeId: "gear_engine_uncommon",  outputType: "gear",      source: "bazaar",     uses: Infinity, destroyOnUse: false },
  { id: "bp_probe_uncommon",   name: "Blueprint: Uncommon Probe Rack", recipeId: "gear_probe_uncommon",   outputType: "gear",      source: "expedition", uses: Infinity, destroyOnUse: false },
  { id: "bp_plating_rare",     name: "Blueprint: Rare Plating",        recipeId: "gear_plating_rare",     outputType: "gear",      source: "bazaar",     uses: Infinity, destroyOnUse: false },
  { id: "bp_survey_shield_rare", name: "Blueprint: Rare Survey Shield", recipeId: "gear_survey_shield_rare", outputType: "gear",   source: "expedition", uses: Infinity, destroyOnUse: false },
  { id: "bp_cannon_epic",      name: "Blueprint: Epic Cannon",         recipeId: "gear_cannon_epic",      outputType: "gear",      source: "bazaar",     uses: Infinity, destroyOnUse: false },
  { id: "bp_engine_epic",      name: "Blueprint: Epic Engine",         recipeId: "gear_engine_epic",      outputType: "gear",      source: "mission",    uses: Infinity, destroyOnUse: false },
  { id: "bp_shield_legend",    name: "Blueprint: Legendary Shield",    recipeId: "gear_shield_legend",    outputType: "gear",      source: "mission",    uses: Infinity, destroyOnUse: false },
  { id: "bp_ship_courier",     name: "Blueprint: Yard Courier",        recipeId: "ship_courier",          outputType: "ship",      source: "bazaar",     uses: Infinity, destroyOnUse: false },
  { id: "bp_ship_freighter",   name: "Blueprint: Yard Freighter",      recipeId: "ship_freighter",        outputType: "ship",      source: "bazaar",     uses: Infinity, destroyOnUse: false },
  { id: "bp_ship_frigate",     name: "Blueprint: Yard Frigate",        recipeId: "ship_frigate",          outputType: "ship",      source: "expedition", uses: Infinity, destroyOnUse: false },
  { id: "bp_ship_probe",       name: "Blueprint: Yard Probe",          recipeId: "ship_probe",            outputType: "ship",      source: "auto",       minBaronTier: 1, uses: Infinity, destroyOnUse: false },
  { id: "bp_ship_pathfinder",  name: "Blueprint: Pathfinder Cutter",   recipeId: "ship_pathfinder",       outputType: "ship",      source: "expedition", uses: Infinity, destroyOnUse: false },
  { id: "bp_ship_void_caravan",name: "Blueprint: Void Caravan",        recipeId: "ship_void_caravan",     outputType: "ship",      source: "mission",    uses: Infinity, destroyOnUse: false },
  { id: "bp_ship_argent_ark",  name: "Blueprint: The Argent Ark",      recipeId: "ship_argent_ark",       outputType: "ship",      source: "mission",    uses: 1, destroyOnUse: true },
  { id: "bp_ship_oracle_lens", name: "Blueprint: The Oracle Lens",     recipeId: "ship_oracle_lens",      outputType: "ship",      source: "mission",    uses: 1, destroyOnUse: true },
  { id: "bp_bb_foundry_blitz", name: "Blueprint: Foundry Blitz",       recipeId: "bb_foundry_blitz",      outputType: "blackbox",  source: "bazaar",     uses: Infinity, destroyOnUse: false },
  { id: "bp_bb_bulk_yield",    name: "Blueprint: Bulk Yield Injector", recipeId: "bb_bulk_yield",         outputType: "blackbox",  source: "expedition", uses: Infinity, destroyOnUse: false },
  { id: "bp_bb_iron_ledger",   name: "Blueprint: Iron Ledger",         recipeId: "bb_iron_ledger",        outputType: "blackbox",  source: "mission",    uses: Infinity, destroyOnUse: false },
  { id: "bp_bb_ghost_manifest",name: "Blueprint: Ghost Manifest",      recipeId: "bb_ghost_manifest",     outputType: "blackbox",  source: "bazaar",     uses: Infinity, destroyOnUse: false },
  { id: "bp_bb_hard_bargain",  name: "Blueprint: Hard Bargain",        recipeId: "bb_hard_bargain",       outputType: "blackbox",  source: "bazaar",     uses: Infinity, destroyOnUse: false },
  { id: "bp_bb_aegis_field",   name: "Blueprint: Aegis Field",         recipeId: "bb_aegis_field",        outputType: "blackbox",  source: "expedition", uses: Infinity, destroyOnUse: false },
  { id: "bp_bb_long_haul",     name: "Blueprint: Long Haul Protocol",  recipeId: "bb_long_haul",          outputType: "blackbox",  source: "auto",       minBaronTier: 2, uses: Infinity, destroyOnUse: false },
  { id: "bp_bb_deep_lens",     name: "Blueprint: Deep Lens",           recipeId: "bb_deep_lens",          outputType: "blackbox",  source: "expedition", uses: Infinity, destroyOnUse: false },
];

const RECIPES = [
  // Gear
  { id: "gear_plating_common",  name: "Common Plating",     outputType: "gear", tier: "common",
    ingredients: [{ id: "iron_ore", qty: 6 }, { id: "silicon", qty: 2 }],
    craftMs: 20 * 60 * 1000, blueprintId: "bp_plating_common",
    output: { kind: "plating", rarity: "common" } },
  { id: "gear_cannon_uncommon", name: "Uncommon Cannon",    outputType: "gear", tier: "uncommon",
    ingredients: [{ id: "titanium_ore", qty: 8 }, { id: "nanochips", qty: 4 }],
    craftMs: 60 * 60 * 1000, blueprintId: "bp_cannon_uncommon",
    output: { kind: "cannon", rarity: "uncommon" } },
  { id: "gear_shield_rare",     name: "Rare Shield",        outputType: "gear", tier: "rare",
    ingredients: [{ id: "titanium_ore", qty: 6 }, { id: "sensor_array", qty: 5 }, { id: "quantum_core", qty: 2 }],
    craftMs: 2 * 60 * 60 * 1000, blueprintId: "bp_shield_rare",
    output: { kind: "shield", rarity: "rare" } },
  { id: "gear_reactor_epic",    name: "Epic Reactor",       outputType: "gear", tier: "epic",
    ingredients: [{ id: "quantum_core", qty: 4 }, { id: "plasma_gas", qty: 3 }, { id: "gemstones", qty: 2 }],
    craftMs: 4 * 60 * 60 * 1000, blueprintId: "bp_reactor_epic",
    output: { kind: "reactor", rarity: "epic" } },
  { id: "gear_scanner_legend",  name: "Legendary Scanner",  outputType: "gear", tier: "legendary",
    ingredients: [{ id: "ai_matrix", qty: 2 }, { id: "quantum_core", qty: 3 }, { id: "voidstone", qty: 1 }],
    craftMs: 8 * 60 * 60 * 1000, blueprintId: "bp_scanner_legend",
    output: { kind: "scanner", rarity: "legendary" } },
  // Extractors
  { id: "ex_jack", name: "Jack Extractor", outputType: "extractor", tier: "jack",
    ingredients: [{ id: "iron_ore", qty: 10 }, { id: "silicon", qty: 5 }, { id: "nanochips", qty: 2 }],
    craftMs: 3 * 60 * 60 * 1000, blueprintId: "bp_ex_jack",
    output: { extractorType: "jack", scope: "all" } },
  { id: "ex_semi", name: "Semi-Spec Extractor", outputType: "extractor", tier: "semi",
    ingredients: [{ id: "titanium_ore", qty: 8 }, { id: "nanochips", qty: 6 }, { id: "sensor_array", qty: 3 }],
    craftMs: 6 * 60 * 60 * 1000, blueprintId: "bp_ex_semi",
    output: { extractorType: "semi", scope: "mineral" } },
  { id: "ex_specialized", name: "Specialized Extractor", outputType: "extractor", tier: "specialized",
    ingredients: [{ id: "titanium_ore", qty: 12 }, { id: "nanochips", qty: 10 }, { id: "quantum_core", qty: 4 }],
    flavor: [
      { id: "pulsar_shard", qty: 1, scopeCat: "mineral" },
      { id: "plasma_gas", qty: 1, scopeCat: "gas" },
      { id: "spore_culture", qty: 1, scopeCat: "agri" },
      { id: "neural_processor", qty: 1, scopeCat: "tech" },
      { id: "fine_art", qty: 1, scopeCat: "luxury" },
      { id: "bio_toxin", qty: 1, scopeCat: "illicit" },
    ],
    craftMs: 10 * 60 * 60 * 1000, blueprintId: "bp_ex_specialized",
    output: { extractorType: "specialized" } },
  // Ships
  { id: "ship_corvette", name: "Yard Corvette", outputType: "ship", tier: "escort",
    ingredients: [{ id: "titanium_ore", qty: 40 }, { id: "nanochips", qty: 20 }, { id: "plasma_gas", qty: 15 }],
    credits: 10000, craftMs: 24 * 60 * 60 * 1000, blueprintId: "bp_ship_corvette",
    output: { shipType: "craft_corvette" } },
  { id: "ship_cruiser", name: "Yard Cruiser", outputType: "ship", tier: "escort",
    ingredients: [{ id: "titanium_ore", qty: 70 }, { id: "nanochips", qty: 35 }, { id: "quantum_core", qty: 20 }],
    credits: 40000, craftMs: 48 * 60 * 60 * 1000, blueprintId: "bp_ship_cruiser",
    output: { shipType: "craft_cruiser" } },
  { id: "ship_last_aegis", name: "The Last Aegis", outputType: "ship", tier: "unique",
    ingredients: [{ id: "voidstone", qty: 30 }, { id: "ai_matrix", qty: 20 }, { id: "quantum_core", qty: 40 }, { id: "antimatter", qty: 25 }],
    credits: 250000, craftMs: 5 * 24 * 60 * 60 * 1000, blueprintId: "bp_ship_last_aegis",
    output: { shipType: "last_aegis" } },
  // Blackboxes
  { id: "bb_overclock_core", name: "Overclock Core (box)", outputType: "blackbox", tier: "consumable",
    ingredients: [{ id: "quantum_core", qty: 4 }, { id: "plasma_gas", qty: 2 }, { id: "gemstones", qty: 3 }],
    craftMs: 30 * 60 * 1000, blueprintId: "bp_bb_overclock",
    output: { effectId: "overclock_core" } },
  { id: "bb_smugglers_veil", name: "Smuggler's Veil (box)", outputType: "blackbox", tier: "consumable",
    ingredients: [{ id: "weapons_cache", qty: 5 }, { id: "cipher_shard", qty: 3 }, { id: "narcotics", qty: 2 }],
    craftMs: 45 * 60 * 1000, blueprintId: "bp_bb_veil",
    output: { effectId: "smugglers_veil" } },
  { id: "bb_autopilot_surge", name: "Autopilot Surge (box)", outputType: "blackbox", tier: "consumable",
    ingredients: [{ id: "sensor_array", qty: 6 }, { id: "plasma_gas", qty: 4 }],
    craftMs: 30 * 60 * 1000, blueprintId: "bp_bb_autopilot",
    output: { effectId: "autopilot_surge" } },
  { id: "bb_silver_tongue", name: "Silver Tongue (box)", outputType: "blackbox", tier: "consumable",
    ingredients: [{ id: "fine_art", qty: 4 }, { id: "vintage_wine", qty: 3 }, { id: "gemstones", qty: 2 }],
    craftMs: 40 * 60 * 1000, blueprintId: "bp_bb_silver",
    output: { effectId: "silver_tongue" } },
  { id: "bb_void_shield", name: "Void Shield (box)", outputType: "blackbox", tier: "consumable",
    ingredients: [{ id: "titanium_ore", qty: 5 }, { id: "biofiber", qty: 4 }, { id: "quantum_core", qty: 2 }],
    craftMs: 40 * 60 * 1000, blueprintId: "bp_bb_void",
    output: { effectId: "void_shield" } },
  { id: "bb_tax_ghost", name: "Tax Ghost (box)", outputType: "blackbox", tier: "consumable",
    ingredients: [{ id: "cipher_shard", qty: 6 }, { id: "bio_toxin", qty: 4 }],
    craftMs: 60 * 60 * 1000, blueprintId: "bp_bb_tax",
    output: { effectId: "tax_ghost" } },
  { id: "bb_fabricators_boon", name: "Fabricator's Boon (box)", outputType: "blackbox", tier: "consumable",
    ingredients: [{ id: "nanochips", qty: 5 }, { id: "graphene_lattice", qty: 3 }, { id: "fusion_cell", qty: 2 }],
    craftMs: 35 * 60 * 1000, blueprintId: "bp_bb_fabricator",
    output: { effectId: "fabricators_boon" } },

  /* ---- second wave -------------------------------------------------------
     More gear kinds (engine / cargo pod / survey rigs), craft-only transport
     and survey hulls, and a blackbox per new effect.                        */
  // Gear
  { id: "gear_hold_common", name: "Common Cargo Pod", outputType: "gear", tier: "common",
    ingredients: [{ id: "iron_ore", qty: 8 }, { id: "synthsilk", qty: 4 }],
    craftMs: 25 * 60 * 1000, blueprintId: "bp_hold_common",
    output: { kind: "hold", rarity: "common" } },
  { id: "gear_engine_uncommon", name: "Uncommon Engine", outputType: "gear", tier: "uncommon",
    ingredients: [{ id: "cobalt_ore", qty: 6 }, { id: "fusion_cell", qty: 5 }, { id: "xenon_gas", qty: 3 }],
    craftMs: 70 * 60 * 1000, blueprintId: "bp_engine_uncommon",
    output: { kind: "engine", rarity: "uncommon" } },
  { id: "gear_probe_uncommon", name: "Uncommon Probe Rack", outputType: "gear", tier: "uncommon",
    ingredients: [{ id: "sensor_array", qty: 5 }, { id: "silicon", qty: 4 }, { id: "xenon_gas", qty: 2 }],
    craftMs: 80 * 60 * 1000, blueprintId: "bp_probe_uncommon",
    output: { kind: "probe", rarity: "uncommon" } },
  { id: "gear_plating_rare", name: "Rare Plating", outputType: "gear", tier: "rare",
    ingredients: [{ id: "titanium_ore", qty: 12 }, { id: "graphene_lattice", qty: 6 }, { id: "cobalt_ore", qty: 4 }],
    craftMs: 150 * 60 * 1000, blueprintId: "bp_plating_rare",
    output: { kind: "plating", rarity: "rare" } },
  { id: "gear_survey_shield_rare", name: "Rare Survey Shield", outputType: "gear", tier: "rare",
    ingredients: [{ id: "graphene_lattice", qty: 6 }, { id: "sensor_array", qty: 4 }, { id: "cryo_vapor", qty: 3 }],
    craftMs: 3 * 60 * 60 * 1000, blueprintId: "bp_survey_shield_rare",
    output: { kind: "survey_shield", rarity: "rare" } },
  { id: "gear_cannon_epic", name: "Epic Cannon", outputType: "gear", tier: "epic",
    ingredients: [{ id: "titanium_ore", qty: 10 }, { id: "pulsar_shard", qty: 5 }, { id: "antimatter", qty: 3 }],
    craftMs: 5 * 60 * 60 * 1000, blueprintId: "bp_cannon_epic",
    output: { kind: "cannon", rarity: "epic" } },
  { id: "gear_engine_epic", name: "Epic Engine", outputType: "gear", tier: "epic",
    ingredients: [{ id: "pulsar_shard", qty: 6 }, { id: "xenon_gas", qty: 5 }, { id: "neural_processor", qty: 4 }],
    craftMs: 5 * 60 * 60 * 1000, blueprintId: "bp_engine_epic",
    output: { kind: "engine", rarity: "epic" } },
  { id: "gear_shield_legend", name: "Legendary Shield", outputType: "gear", tier: "legendary",
    ingredients: [{ id: "ai_matrix", qty: 3 }, { id: "voidstone", qty: 2 }, { id: "quantum_foam", qty: 4 }],
    craftMs: 9 * 60 * 60 * 1000, blueprintId: "bp_shield_legend",
    output: { kind: "shield", rarity: "legendary" } },
  // Ships — transport
  { id: "ship_courier", name: "Yard Courier", outputType: "ship", tier: "transport",
    ingredients: [{ id: "titanium_ore", qty: 25 }, { id: "nanochips", qty: 12 }, { id: "plasma_gas", qty: 8 }],
    credits: 6000, craftMs: 12 * 60 * 60 * 1000, blueprintId: "bp_ship_courier",
    output: { shipType: "craft_courier" } },
  { id: "ship_freighter", name: "Yard Freighter", outputType: "ship", tier: "transport",
    ingredients: [{ id: "iron_ore", qty: 60 }, { id: "titanium_ore", qty: 30 }, { id: "nanochips", qty: 18 }],
    credits: 25000, craftMs: 30 * 60 * 60 * 1000, blueprintId: "bp_ship_freighter",
    output: { shipType: "craft_freighter" } },
  { id: "ship_void_caravan", name: "Void Caravan", outputType: "ship", tier: "transport",
    ingredients: [{ id: "titanium_ore", qty: 120 }, { id: "graphene_lattice", qty: 60 }, { id: "quantum_core", qty: 30 }, { id: "fusion_cell", qty: 20 }],
    credits: 90000, craftMs: 60 * 60 * 60 * 1000, blueprintId: "bp_ship_void_caravan",
    output: { shipType: "void_caravan" } },
  { id: "ship_argent_ark", name: "The Argent Ark", outputType: "ship", tier: "unique",
    ingredients: [{ id: "voidstone", qty: 25 }, { id: "ai_matrix", qty: 15 }, { id: "quantum_core", qty: 30 }, { id: "quantum_foam", qty: 20 }],
    credits: 200000, craftMs: 4 * 24 * 60 * 60 * 1000, blueprintId: "bp_ship_argent_ark",
    output: { shipType: "argent_ark" } },
  // Ships — escort / survey
  { id: "ship_frigate", name: "Yard Frigate", outputType: "ship", tier: "escort",
    ingredients: [{ id: "titanium_ore", qty: 55 }, { id: "nanochips", qty: 28 }, { id: "fusion_cell", qty: 12 }],
    credits: 22000, craftMs: 36 * 60 * 60 * 1000, blueprintId: "bp_ship_frigate",
    output: { shipType: "craft_frigate" } },
  { id: "ship_probe", name: "Yard Probe", outputType: "ship", tier: "survey",
    ingredients: [{ id: "silicon", qty: 30 }, { id: "sensor_array", qty: 14 }, { id: "xenon_gas", qty: 10 }],
    credits: 8000, craftMs: 14 * 60 * 60 * 1000, blueprintId: "bp_ship_probe",
    output: { shipType: "craft_probe" } },
  { id: "ship_pathfinder", name: "Pathfinder Cutter", outputType: "ship", tier: "survey",
    ingredients: [{ id: "titanium_ore", qty: 40 }, { id: "sensor_array", qty: 25 }, { id: "cryo_vapor", qty: 10 }, { id: "neural_processor", qty: 6 }],
    credits: 30000, craftMs: 40 * 60 * 60 * 1000, blueprintId: "bp_ship_pathfinder",
    output: { shipType: "craft_pathfinder" } },
  { id: "ship_oracle_lens", name: "The Oracle Lens", outputType: "ship", tier: "unique",
    ingredients: [{ id: "voidstone", qty: 20 }, { id: "ai_matrix", qty: 18 }, { id: "neural_processor", qty: 25 }, { id: "quantum_foam", qty: 15 }],
    credits: 180000, craftMs: 84 * 60 * 60 * 1000, blueprintId: "bp_ship_oracle_lens",
    output: { shipType: "oracle_lens" } },
  // Blackboxes
  { id: "bb_foundry_blitz", name: "Foundry Blitz (box)", outputType: "blackbox", tier: "consumable",
    ingredients: [{ id: "nanochips", qty: 6 }, { id: "graphene_lattice", qty: 4 }, { id: "antimatter", qty: 3 }],
    craftMs: 40 * 60 * 1000, blueprintId: "bp_bb_foundry_blitz",
    output: { effectId: "foundry_blitz" } },
  { id: "bb_bulk_yield", name: "Bulk Yield Injector (box)", outputType: "blackbox", tier: "consumable",
    ingredients: [{ id: "quantum_core", qty: 5 }, { id: "pulsar_shard", qty: 4 }, { id: "methane_slurry", qty: 3 }],
    craftMs: 45 * 60 * 1000, blueprintId: "bp_bb_bulk_yield",
    output: { effectId: "bulk_yield" } },
  { id: "bb_iron_ledger", name: "Iron Ledger (box)", outputType: "blackbox", tier: "consumable",
    ingredients: [{ id: "forged_credentials", qty: 5 }, { id: "cipher_shard", qty: 4 }, { id: "fine_art", qty: 2 }],
    craftMs: 70 * 60 * 1000, blueprintId: "bp_bb_iron_ledger",
    output: { effectId: "iron_ledger" } },
  { id: "bb_ghost_manifest", name: "Ghost Manifest (box)", outputType: "blackbox", tier: "consumable",
    ingredients: [{ id: "forged_credentials", qty: 6 }, { id: "narcotics", qty: 4 }, { id: "cipher_shard", qty: 3 }],
    craftMs: 55 * 60 * 1000, blueprintId: "bp_bb_ghost_manifest",
    output: { effectId: "ghost_manifest" } },
  { id: "bb_hard_bargain", name: "Hard Bargain (box)", outputType: "blackbox", tier: "consumable",
    ingredients: [{ id: "vintage_wine", qty: 5 }, { id: "perfume_essence", qty: 4 }, { id: "exotic_pelts", qty: 3 }],
    craftMs: 50 * 60 * 1000, blueprintId: "bp_bb_hard_bargain",
    output: { effectId: "hard_bargain" } },
  { id: "bb_aegis_field", name: "Aegis Field (box)", outputType: "blackbox", tier: "consumable",
    ingredients: [{ id: "graphene_lattice", qty: 6 }, { id: "biofiber", qty: 4 }, { id: "cryo_vapor", qty: 3 }],
    craftMs: 50 * 60 * 1000, blueprintId: "bp_bb_aegis_field",
    output: { effectId: "aegis_field" } },
  { id: "bb_long_haul", name: "Long Haul Protocol (box)", outputType: "blackbox", tier: "consumable",
    ingredients: [{ id: "sensor_array", qty: 5 }, { id: "fusion_cell", qty: 4 }, { id: "xenon_gas", qty: 3 }],
    craftMs: 45 * 60 * 1000, blueprintId: "bp_bb_long_haul",
    output: { effectId: "long_haul" } },
  { id: "bb_deep_lens", name: "Deep Lens (box)", outputType: "blackbox", tier: "consumable",
    ingredients: [{ id: "neural_processor", qty: 4 }, { id: "sensor_array", qty: 3 }, { id: "spore_culture", qty: 2 }],
    craftMs: 60 * 60 * 1000, blueprintId: "bp_bb_deep_lens",
    output: { effectId: "deep_lens" } },
];

/* ---- MARKET MICROSTRUCTURE ------------------------------------------------
   Kills cross-system arbitrage as a free-money printer. Three levers:
   • modCompression — shrinks the per-system price gaps (raw mod deviations from
     1.0 are scaled by this), so the raw spread between stations is smaller.
   • Market depth (from your Baron Tier `cap`) + a PERSISTENT, decaying trade
     impact: buying pushes a system's price up, selling pushes it down, and the
     nudge lingers (impactHalfLifeMs) — so splitting one big trade into many
     small ones, or hopping back and forth, closes the gap just the same.
   • dockK — the docking-time constant; higher = longer hops between stations.
   See docs and tools/depth_sim for the tuning math.                          */
const MARKETCFG = {
  modCompression: 0.35,          // per-system mod deviation kept (0.35 = gaps shrink 65%; smaller cross-station spread → less arbitrage)
  dockK: 18,                     // sector docking seconds per distance unit (was 12 — longer hops)
  // Rare goods only appear at 1–2 stations and cost more where they do (scarcity).
  rareStockPremium: 1.35,

  // ---- Deterministic market (Phase 0 — see docs/SERVER_AUTHORITATIVE_DESIGN.md §4)
  // Seed MUST match the SQL market_price() function. Same seed → same curve.
  seed: "cosmocrat-market-v1",
  // Keep short-horizon moves tiny (≪0.1%/tick); real swings play out over minutes–hours.
  volGain: 0.25,                 // price *= 1 + vol × volGain × osc; |osc| ≲ 1
  // Three oscillator period bands (ms); each commodity picks inside its band via hash.
  oscPeriodMinMs: [15 * 60 * 1000, 40 * 60 * 1000, 90 * 60 * 1000],
  oscPeriodMaxMs: [30 * 60 * 1000, 70 * 60 * 1000, 180 * 60 * 1000],
  eventPeriodMs: 90 * 60 * 1000,       // galactic seeded-event slot length
  localEventPeriodMs: 45 * 60 * 1000,  // per-system seeded-event slot length
  eventDurationMs: 45 * 60 * 1000,     // how long a scheduled event distorts price
  localEventDurationMs: 20 * 60 * 1000,
};

/* ---- SECTOR STOCK / SUPPLY ECONOMY (docs/STATIONS.md) ---------------------
   Finite per-sector commodity stock. Price = anchor × sectorMod × scarcity.
   tradeImpact is gone — buying depletes stock and scarcity moves the price.   */
const STOCKCFG = {
  elasticity: 0.35,
  minMult: 0.70,
  maxMult: 3.00,
  baseline: { common: 6000, uncommon: 2500, rare: 800 },
  specialtyMult: 1.6,            // sector specialty category baseline
  offSpecialtyMult: 0.7,         // everything else
  tickMs: 60 * 60 * 1000,        // hourly consumption / NPC production
  trickleFrac: 0.02,             // surplus fraction moved into empty sectors
  // NPC output /hour: tuned so zero-player galaxy equilibrates near baseline.
  npcUnits: { common: 12, uncommon: 5, rare: 2 },
  npcOutputBoost: 2.5,           // npcOutputMult = clamp(1+(1-ratio)*boost, 1, 3.5)
  npcOutputMultMax: 3.5,
  seasonalAmp: 0.08,             // ± noise on consumption
  glutCapMult: 3.0,              // hard shelf ceiling vs baseline
};

// Per-commodity hourly demand at a "normal" sector, before sectorPop / cat mults.
const CONSUMPTION = {
  defaultByRarity: { common: 8, uncommon: 3, rare: 1 },
  // Category × sector affinity (design §3). Applied on top of per-comm base.
  catSectorMult: {
    agri:    { _: 1 },
    gas:     { _: 1 },
    mineral: { _: 0.55 },
    tech:    { forge: 2, _: 1 },
    luxury:  { sprawl: 2.5, core: 1.5, _: 0.5 },
    illicit: { sprawl: 2, core: 1.2, _: 0.6 },
  },
  // Relative population pressure per sector (Core densest).
  sectorPop: { core: 1.35, belt: 1.0, tide: 0.95, green: 1.1, forge: 1.05, sprawl: 1.2 },
};

/* ---- SPACE STATIONS (docs/STATIONS.md) ------------------------------------
   78 claimable non-capital stations. Tier from the generated stationName
   suffix. Power budget gates modules; Reactor buys more power at steep upkeep. */
const STATION_TIERS = {
  Berth:      { power: 3,  upkeep: 800,   rank: 0 },
  Relay:      { power: 5,  upkeep: 1600,  rank: 1 },
  Waystation: { power: 7,  upkeep: 3000,  rank: 2 },
  Dock:       { power: 9,  upkeep: 5200,  rank: 3 },
  Outpost:    { power: 12, upkeep: 8500,  rank: 4 },
  Anchorage:  { power: 15, upkeep: 13000, rank: 5 },
  Station:    { power: 15, upkeep: 13000, rank: 5 }, // capital flavour aliases
  Spire:      { power: 15, upkeep: 13000, rank: 5 },
  Platform:   { power: 15, upkeep: 13000, rank: 5 },
};

const STATIONCFG = {
  auctionHours: 72,
  minBidIncrement: 50000,
  antiSnipeMs: 30 * 60 * 1000,
  openingBase: 150000,
  openingPerTier: 100000,
  moduleValueFrac: 0.5,          // inherited modules inflate opening bid
  refitMs: 6 * 60 * 60 * 1000,
  cooldownMs: 24 * 60 * 60 * 1000,
  sentimentStart: 70,
  standingStart: 60,
  revoltRate: 0.15,
  revoltSentiment: 40,
  revoltStanding: 35,
  fairLeaseTaxBps: 2000,         // >20% lease tax hurts standing
  expectedDeliveryBase: 40,      // units/cycle expected at Prod Hub I × tier
  // Vacant-bay NPC tenants (guest economy): fill chance falls as lease tax rises.
  npcLeaseChanceMax: 0.50,
  npcLeaseLeaveMult: 0.35,       // leave chance ≈ taxFrac × this
  // Exchange Hall (docs/STATIONS.md §9)
  hallListMs: 48 * 60 * 60 * 1000,  // listing expiry window
  hallNpcBuyChance: 0.12,         // per listing per hourly tick (guest liquidity)
  hallMinPrice: 50,
  reactor: [
    { power: 2,  upkeep: 1200 },
    { power: 4,  upkeep: 3000 },
    { power: 6,  upkeep: 6000 },
    { power: 8,  upkeep: 11000 },
    { power: 10, upkeep: 18000 },
  ],
  prodHub: [
    { power: 4,  yield: 60,  bays: 2, upkeep: 900 },
    { power: 6,  yield: 140, bays: 3, upkeep: 1800 },
    { power: 8,  yield: 260, bays: 4, upkeep: 3200 },
    { power: 10, yield: 420, bays: 6, upkeep: 5000 },
    { power: 12, yield: 640, bays: 8, upkeep: 7500 },
  ],
  workshop: [
    { power: 3, time: 0.15, mat: 0.10, upkeep: 1000 },
    { power: 5, time: 0.30, mat: 0.20, upkeep: 2200 },
    { power: 7, time: 0.45, mat: 0.30, upkeep: 4000 },
  ],
  // Ownership caps by Baron Tier index (0=Baron … 6=Cosmocrat).
  ownerCap: [1, 1, 1, 2, 2, 2, 3],
};

// Module catalogue. `conflicts` = mutual exclusion; `requires` = other module min level.
const STATION_MODULES = {
  production_hub: { name: "Production Hub", max: 5, power: [4, 6, 8, 10, 12], cost: [25000, 55000, 110000, 200000, 350000] },
  refinery:       { name: "Refinery",       max: 1, power: [5], requires: { production_hub: 2 }, cost: [80000] },
  exchange_hall:  { name: "Exchange Hall",  max: 1, power: [4], cost: [60000] },
  workshop_annex: { name: "Workshop Annex", max: 3, power: [3, 5, 7], cost: [40000, 90000, 160000] },
  dry_dock:       { name: "Dry Dock",       max: 1, power: [3], cost: [45000] },
  charter_office: { name: "Charter Office", max: 1, power: [3], cost: [40000] },
  contract_office:{ name: "Contract Office",max: 1, power: [4], cost: [70000] },
  survey_relay:   { name: "Survey Relay",   max: 1, power: [4], cost: [55000] },
  warehouse:      { name: "Warehouse",      max: 2, power: [2, 3], cost: [30000, 50000] },
  customs_house:  { name: "Customs House",  max: 1, power: [3], conflicts: ["free_port", "black_market"], cost: [65000] },
  free_port:      { name: "Free Port",      max: 1, power: [3], conflicts: ["customs_house"], cost: [65000] },
  black_market:   { name: "Black Market",   max: 1, power: [5], conflicts: ["customs_house"], cost: [90000] },
  lane_buoy:      { name: "Lane Buoy",      max: 1, power: [2], cost: [35000] },
  reactor:        { name: "Reactor",        max: 5, power: [0, 0, 0, 0, 0], cost: [40000, 90000, 160000, 280000, 450000] },
};

/* ---- BATTLE DAMAGE --------------------------------------------------------
   Per-mission-type wear profile, rolled per ship when a mission resolves.
   `chance` = odds of taking any damage on a success; `dmg` = hull fraction
   lost per hit (scaled by danger, ×`failMult` on a failed mission);
   `destroy` / `destroyFail` = odds the ship is outright destroyed on a
   success / failure. Destruction also scales with (1 − successChance), so
   overwhelming force comes home intact and long shots get ships killed.
   Damaged hulls fight worse (see statPenalty) until repaired for credits.   */
const DMGCFG = {
  costRate: 0.35,     // full repair of a wrecked hull costs 35% of the ship's price
  statPenalty: 0.5,   // firepower & speed lose up to half their value at max damage
  maxDmg: 0.95,       // damage caps here — only a destroy roll removes a ship
  dangerMult: { safe: 0.5, low: 0.75, moderate: 1, high: 1.3, extreme: 1.6 },
  types: {            // courier scrapes → smuggler chases → open battle
    transport:   { chance: 0.20, dmg: [0.02, 0.08], failMult: 2.5, destroy: 0,    destroyFail: 0.06 },
    escort:      { chance: 0.55, dmg: [0.04, 0.14], failMult: 2.0, destroy: 0.01, destroyFail: 0.15 },
    combat:      { chance: 0.92, dmg: [0.08, 0.30], failMult: 1.8, destroy: 0.03, destroyFail: 0.30 },
    smuggle:     { chance: 0.40, dmg: [0.05, 0.20], failMult: 2.0, destroy: 0.02, destroyFail: 0 },   // failure impounds instead
    assassinate: { chance: 0.70, dmg: [0.06, 0.25], failMult: 1.8, destroy: 0.02, destroyFail: 0.30 },
  },
};

/* ---- FACTIONS -------------------------------------------------------------
   Themes the newswire AND is the reputation axis. `domain` = the commodity
   categories a faction controls; `rival` = who you annoy when you help them.  */
const FACTIONS = {
  syndicate:      { name: "The Syndicate",     color: "#ff5d73", domain: ["illicit"],          rival: "free_trade" },
  mining_combine: { name: "Mining Combine",    color: "#9aa9c8", domain: ["mineral", "gas"],   rival: "agri_collective" },
  free_trade:     { name: "Free-Trade League", color: "#3ad6a0", domain: ["tech"],             rival: "syndicate" },
  agri_collective:{ name: "Agri-Collective",   color: "#78d278", domain: ["agri", "luxury"],   rival: "mining_combine" },
};
// which faction controls each commodity category
const CATEGORY_FACTION = { mineral: "mining_combine", gas: "mining_combine", agri: "agri_collective", luxury: "agri_collective", tech: "free_trade", illicit: "syndicate" };

/* ---- REPUTATION -----------------------------------------------------------
   Standing −100..+100 with each faction. Earned from contracts & trades; spends
   as exchange price edges, bazaar discounts, contract reward bonuses, and gates
   the top jobs behind being Friendly with the sponsor.                         */
const REP = {
  min: -100, max: 100,
  maxEdge: 0.06,        // reputation tightens your exchange spread by up to 6% at +100 standing
  // bid-ask spread on the exchange: you buy a touch above mid and sell a touch
  // below it, so an instant round-trip at one spot always loses money (no buy↔sell
  // arbitrage). Reputation narrows it from `spread` down to `minSpread`.
  spread: 0.04, minSpread: 0.005,
  discountMax: 0.10,    // up to 10% off ships/accessories from your best ally
  rewardMaxBonus: 0.25, // up to +25% contract pay from a friendly sponsor
  gateTier: "friendly", // assassinate / extreme jobs need this with the sponsor
  tiers: [
    { at: -100, id: "hostile",  label: "Hostile",  color: "#ff5d73" },
    { at: -50,  id: "disliked", label: "Disliked", color: "#ff9a4b" },
    { at: -15,  id: "neutral",  label: "Neutral",  color: "#9aa9c8" },
    { at: 15,   id: "friendly", label: "Friendly", color: "#46d39a" },
    { at: 50,   id: "allied",   label: "Allied",   color: "#5aa9ff" },
    { at: 85,   id: "exalted",  label: "Exalted",  color: "#ffb43a" },
  ],
};

/* ---- RIVAL BARONS ---------------------------------------------------------
   AI flavor rivals (chat taunts). The Barons *leaderboard* is human players
   only — see docs/BARON_BOARD_SETUP.md / js/barons.js. `base` seeds AI net
   worth; `growthPerHr` compounds on each drift tick.                          */
const RIVALCFG = {
  driftMs: 4000,          // AI rivals re-price about this often (flavor only)
  snapshotMs: 20 * 1000,
  noiseSd: 0.01,
  minMult: 0.4,
  maxMult: 6,
  barbMinGapMs: 70 * 1000,
  ambientChance: 0.06,
  window: 10,             // Barons tab: ranks above + below you
};
const RIVALS = [
  { id: "pace",    name: "Dolio Pace",  epithet: "the Hopeful",        faction: "free_trade",      portrait: 0,  base: 2500,    growthPerHr: 0.060 },
  { id: "harrow",  name: "Quill Harrow",epithet: "the Penny Baron",    faction: "mining_combine",  portrait: 1,  base: 6000,    growthPerHr: 0.050 },
  { id: "akari",   name: "Senn Akari",  epithet: "the Upstart",        faction: "agri_collective", portrait: 2,  base: 14000,   growthPerHr: 0.050 },
  { id: "toll",    name: "Bram Toll",   epithet: "the Tollmaster",     faction: "syndicate",       portrait: 3,  base: 30000,   growthPerHr: 0.045 },
  { id: "renko",   name: "Iva Renko",   epithet: "the Climber",        faction: "free_trade",      portrait: 4,  base: 65000,   growthPerHr: 0.040 },
  { id: "gran",    name: "Otho Gran",   epithet: "Ore-Fist",           faction: "mining_combine",  portrait: 5,  base: 130000,  growthPerHr: 0.038 },
  { id: "marrow",  name: "Lys Marrow",  epithet: "the Spice Countess", faction: "agri_collective", portrait: 6,  base: 260000,  growthPerHr: 0.034 },
  { id: "dury",    name: "Cax Dury",    epithet: "the Fence",          faction: "syndicate",       portrait: 7,  base: 520000,  growthPerHr: 0.030 },
  { id: "voss",    name: "Pell Voss",   epithet: "the Magnate",        faction: "free_trade",      portrait: 8,  base: 950000,  growthPerHr: 0.027 },
  { id: "kessel",  name: "Dorn Kessel", epithet: "the Deepvein",       faction: "mining_combine",  portrait: 9,  base: 1700000, growthPerHr: 0.024 },
  { id: "vaunt",   name: "Sera Vaunt",  epithet: "the Greencrown",     faction: "agri_collective", portrait: 10, base: 3000000, growthPerHr: 0.020 },
  { id: "vex",     name: "Mara Vex",    epithet: "the Velvet Knife",   faction: "syndicate",       portrait: 11, base: 6000000, growthPerHr: 0.018 },
];

/* ---- PRESTIGE -------------------------------------------------------------
   [DECISION] starting curve — tune freely. Unlocks at the net-worth
   threshold; "sell the empire" grants a permanent multiplier and bumps the
   Baron Tier so the next run is both harder (more volatile) and richer.       */
/* ---- BARON TIERS (prestige "ascension") -----------------------------------
   Retiring now ASCENDS a tier: you keep your empire (stocks, industries, senator
   ties) and gain a fancier title, a bigger industry-permit cap and fleet cap —
   but pay a permanent, rising tax on all earnings. `threshold` is the net worth
   you must reach to ascend INTO that tier. Beyond the last entry you stay Cosmocrat. */
// `cap` = the most credits of a single commodity you can move in ONE buy/sell
// (the per-trade notional ceiling). It also sets the exchange's market depth for
// that tier: trading near the cap eats heavy slippage, so the exploit of dumping
// a huge position at one quoted price is gone. Scales with progression.
const BARON_TIERS = [
  { title: "Baron",     tax: 0.00, permits: 8,  fleet: 3,  cap: 15000,    stations: 1, threshold: 0 },
  { title: "Magnate",   tax: 0.10, permits: 12, fleet: 4,  cap: 30000,    stations: 1, threshold: 1000000 },
  { title: "Tycoon",    tax: 0.20, permits: 16, fleet: 5,  cap: 60000,    stations: 1, threshold: 2500000 },
  { title: "Oligarch",  tax: 0.30, permits: 20, fleet: 6,  cap: 120000,   stations: 2, threshold: 6000000 },
  { title: "Plutocrat", tax: 0.40, permits: 24, fleet: 7,  cap: 220000,   stations: 2, threshold: 15000000 },
  { title: "Potentate", tax: 0.50, permits: 28, fleet: 8,  cap: 350000,   stations: 2, threshold: 40000000 },
  { title: "Cosmocrat", tax: 0.60, permits: 32, fleet: 10, cap: 500000,   stations: 3, threshold: 100000000 },
];

const PRESTIGE = {
  threshold: 1000000,      // legacy: base net worth gate (per-tier gates live in BARON_TIERS)
};

/* ---- SENATE / SPACE POLITICS ----------------------------------------------
   A galactic senate (one senator per system; sector capitals weigh more) votes
   ~once a day on edicts that bite the whole game: price caps, prohibitions,
   tariffs, industry levies, tighter borders (smuggling), ship restrictions —
   plus player-friendly subsidies/tax holidays. Your Baron Tier gates how much
   you can sway a vote (lobby → bribe → scandal). Edicts expire or get repealed.
   Senators are generated deterministically from the galaxy seed (senate.js).   */
const SENATECFG = {
  voteIntervalMs: 24 * 60 * 60 * 1000,      // a vote ~once a day (scaled by dev fast-time)
  billLookahead: 6,                          // upcoming bills queued & previewable at once (the floor bill + 5)
  edictDurationMs: 3 * 24 * 60 * 60 * 1000,  // a passed edict lasts ~3 days unless repealed
  repealChance: 0.25,                        // chance a new bill repeals an active edict instead
  maxResolvePerCatchup: 14,                  // cap votes resolved in one offline catch-up
  historyKeep: 30,                           // finished bills retained for vote history
  abstainBand: 0.14,                         // |vote score| under this → the senator abstains
  voteNoise: 0.28,                           // deterministic per-(senator,bill) jitter
  staggerMs: 15000,                          // how long the chamber's vote cascade plays (senators vote in a random order)
  // bill severity: most bills are mild; a rare "sweeping" one bites harder (scales the effect magnitude)
  severities: [
    { factor: 0.5, weight: 64, label: "" },
    { factor: 1.0, weight: 28, label: "" },
    { factor: 1.7, weight: 8, label: "Sweeping" },
  ],
  // opinions drift over time (deterministic from the galaxy clock, so identical for every player)
  driftAmp: 1.6,                             // stance swing magnitude over a cycle (on the −3..3 scale)
  driftPeriodMs: 3 * 24 * 60 * 60 * 1000,    // one full opinion cycle (~3 days)
  switchMargin: 10,                          // a senator only defects bloc when drifted views beat their own by this
  // votes also react to the live market & standing edicts
  contextStrength: 0.45,                     // how hard the current market level nudges a price-bill vote
  satFatigue: 0.5,                           // appetite drop when an edict on the same issue is already in force
  weightCapital: 3, weightHub: 2, weightNormal: 1,  // seat weighting (capitals carry the chamber)
  independentChance: 0.12,                   // some senators sit as independents (cross-bench)
  // ---- player influence — gated by Baron Tier (0 = spectator) ----
  lobbyMinTier: 1, bribeMinTier: 2, scandalMinTier: 3,
  tierInfluenceBonus: 0.18,                  // +18% sway strength per Baron Tier
  lobbyFacStrength: 0.8, bribeStrength: 1.4,
  lobbyDecay: 0.55,                          // each repeat lobby of a faction sways ×this (diminishing returns)
  lobbyRivalFactor: 0.6,                     // lobbying a faction shoves its rival bloc this much the OTHER way
  lobbyRepGain: 6, lobbyRivalRepLoss: 4,     // a lobby lifts the faction's standing and dents its rival's
  relGainOnBribe: 20, scandalRelLoss: 28,    // bribing warms a senator; coercion (scandal) burns them
  // base costs (credits). Lobby scales with your FACTION standing; bribe/scandal with the SENATOR relationship.
  lobbyFacCost: 100000, bribeCostBase: 50000, scandalCostBase: 20000,
  lobbyCostRelK: 0.4, bribeCostRelK: 0.4, scandalCostRelK: 0.4,  // ±40% cost swing from relationship
  dossierMinPrice: 1500, dossierMaxPrice: 9000, dossierSlots: 3,
  // windfall levy: the surtax only bites barons ranked in the top N of the board
  windfallTopN: 3,
  // route-safety clamp: how far a Convoy Mandate (+) / Lane Cuts (−) can swing
  // charter destroy/impound odds (0.1 = nearly shrugged, 2.5 = 2.5× riskier)
  routeSafetyClamp: [0.1, 2.5],
  // ballot initiative: table your own bill onto the docket (high tier + a fee).
  // Weekly quota = tier − ballotMinTier + 1 (tier 3 → 1/week, tier 4 → 2, …).
  // Strength (factor) and duration (days) scale the fee; stronger/longer bills lean harder.
  ballotMinTier: 3, ballotCost: 250000, ballotBumpCost: 100000,
  ballotFactors: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
  ballotDaysMin: 1, ballotDaysMax: 10, ballotDaysDefault: 3,
  // ponytail: soft galaxy docket cap for player-authored bills; raise if the chamber feels empty
  ballotDocketCap: 8,
  // stance scale −3..+3 → label[v+3]; hidden stances read as the "unknown" string.
  stanceLabels: ["vehemently opposed", "strongly disagree", "slightly disagree", "either way", "slightly agree", "strongly agree", "solid support"],
  stanceUnknown: "information lacking",
};

/* ---- GALAXY / SECTORS -----------------------------------------------------
   The map is generated procedurally (galaxy.js) from GALAXY.seed so it is the
   same universe every load. Each sector has a theme, a galaxy-view position
   (0–1 space), a specialty category (cheap = a source), a dominant race, and a
   nebula backdrop. Each existing tradeable SYSTEM becomes that sector's named
   capital; the rest of the sector's 9–18 systems are generated, priced, and
   alive with local news — but trading/fleet stay on the curated capitals.     */
const GALAXY = {
  seed: 0xBADCAFE,
  sectorMinSystems: 9,
  sectorMaxSystems: 18,
  localEventMinMs: 8 * 60 * 1000,   // a local event somewhere this often…
  localEventMaxMs: 16 * 60 * 1000,
  localEffectMs: 30 * 60 * 1000,    // …and it distorts that system for this long
};

const RACES = {
  voidkin:  { name: "Voidkin",  color: "#7b8cff", nameStyle: "soft" },
  glorthi:  { name: "Glorthi",  color: "#3ad6a0", nameStyle: "guttural" },
  aurelian: { name: "Aurelian", color: "#ffc24b", nameStyle: "regal" },
  krell:    { name: "Krell",    color: "#ff5d73", nameStyle: "harsh" },
  mechanim: { name: "Mechanim", color: "#9aa9c8", nameStyle: "code" },
  syndics:  { name: "Syndics",  color: "#a078ff", nameStyle: "slick" },
};

// One sector per existing capital system. pos = center in galaxy-view 0–1 space.
const SECTORS = [
  { id: "core",   name: "Core Worlds",   capital: "navos",  specialty: null,      race: "voidkin",
    nebula: "void",   star: "white",  pos: { x: 0.50, y: 0.50 } },
  { id: "belt",   name: "Korrin Belt",   capital: "korrin", specialty: "mineral", race: "mechanim",
    nebula: "blue",   star: "blue",   pos: { x: 0.24, y: 0.34 } },
  { id: "tide",   name: "Tide Reaches",  capital: "velm",   specialty: "gas",     race: "glorthi",
    nebula: "green",  star: "yellow", pos: { x: 0.76, y: 0.30 } },
  { id: "green",  name: "Green Expanse", capital: "thessa", specialty: "agri",    race: "aurelian",
    nebula: "gold",   star: "orange", pos: { x: 0.20, y: 0.72 } },
  { id: "forge",  name: "Forge Reach",   capital: "orin",   specialty: "tech",    race: "krell",
    nebula: "red",    star: "red",    pos: { x: 0.80, y: 0.70 } },
  { id: "sprawl", name: "Sable Sprawl",  capital: "sable",  specialty: "luxury",  race: "syndics",
    nebula: "purple", star: "neutron",pos: { x: 0.52, y: 0.86 } },
];

const STAR_TYPES = ["yellow", "blue", "red", "white", "orange", "neutron", "binary"];
const PLANET_TYPES = ["rocky", "terran", "ocean", "ice", "lava", "gas_giant", "barren", "ringed", "toxic"];

/* ---- SYSTEM VIEW (animated scene) -----------------------------------------
   Tunables for the canvas scene behind a system on the Star Map: ambient ship
   traffic, the hyperspace gate ships warp in/out through, and ship voice-lines.
   Lower ship speeds make the system feel vast.                                 */
const SYSTEMVIEW = {
  shipSpeedMin: 24, shipSpeedMax: 52,   // px/s — was 42–90; slower = bigger space
  gateLeaveChance: 0.22,                 // chance a ship picks the gate (jumps out) over a dock
  chatterMinGapMs: 3800,                 // min real gap between ambient hail/reply exchanges
  chatterRate: 0.5,                      // per-second chance of an exchange once off cooldown
  bubbleMs: 2900,                        // how long a speech bubble lingers
};

// Admin-uploaded sprite overrides ("category:name" -> custom URL or URL[]),
// loaded from Supabase by content.js. A string replaces the default; an array
// is a pool — _assetPool picks one deterministically from `salt` (item uid).
// Broadcast pools may store { url, title?, caption? } entries (flavor per frame).
const ASSET_OVERRIDES = {};
const _asset = (key, path) => {
  const v = ASSET_OVERRIDES[key];
  return (typeof v === "string" && v) ? v : path;
};
const _poolHash = salt => {
  let h = 2166136261;
  const s = String(salt || "");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const _entryUrl = e => (typeof e === "string" ? e : (e && e.url)) || "";
const _assetPoolEntry = (key, salt, path) => {
  const v = ASSET_OVERRIDES[key];
  let entry = null;
  if (Array.isArray(v) && v.length) entry = v[_poolHash(salt) % v.length];
  else if (typeof v === "string" && v) entry = v;
  else if (v && typeof v === "object" && v.url) entry = v;
  if (!entry) return { url: path, title: "", caption: "" };
  if (typeof entry === "string") return { url: entry, title: "", caption: "" };
  return {
    url: entry.url || path,
    title: entry.title ? String(entry.title) : "",
    caption: entry.caption ? String(entry.caption) : "",
  };
};
const _assetPool = (key, salt, path) => _assetPoolEntry(key, salt, path).url;

// asset path helpers — change these if you reorganize /assets
const ASSET = {
  portrait: i => _asset(`portrait:${i}`, `assets/portraits/alien_${String(i).padStart(2, "0")}.png`),
  commodity: id => _asset(`commodity:${id}`, `assets/commodities/${id}.png`),
  ship: sprite => _asset(`ship:${sprite}`, `assets/ships/${sprite}.png`),
  // Broadcast: pool of frames (PNG/GIF). Salt varies the pick; Entry includes optional flavor.
  broadcast: (name, salt = "0") => _assetPool(`broadcast:${name}`, salt, `assets/broadcast/${name}.png`),
  broadcastEntry: (name, salt = "0") => _assetPoolEntry(`broadcast:${name}`, salt, `assets/broadcast/${name}.png`),
  star: type => _asset(`star:${type}`, `assets/stars/${type}.png`),
  planet: type => _asset(`planet:${type}`, `assets/planets/${type}.png`),
  station: race => _asset(`station:${race}`, `assets/stations/${race}.png`),
  raceship: race => _asset(`raceship:${race}`, `assets/raceships/${race}.png`),
  nebula: name => _asset(`nebula:${name}`, `assets/nebula/${name}.png`),
  asteroids: () => _asset(`asteroids:_`, `assets/space/asteroids.png`),
  hub: id => _asset(`hub:${id}`, `assets/hub/${id}.png`),   // prop/NPC sprites for the station hub
  hubBg: () => _asset(`hub:_bg`, `assets/hub/bg.png`),      // optional room backdrop (falls back to the CSS starscape)
  // Per-tab page backgrounds (admin Images → Page backgrounds). Empty default = no image.
  // Cover+center stage behind page UI — mobile crops left/right (see .page-bg).
  pageBg: id => _asset(`pagebg:${id}`, ""),
  // Per-hull art pools. Admins upload N images against a catalog hull id and
  // each individual ship picks one deterministically from `salt` — the shipyard
  // offer id on the shelf, then the ship's uid once it's bought, so the picture
  // a player bought is the picture they keep. Falls back to the shared class
  // sprite (assets/ships / assets/raceships) when the pool is empty, which is
  // what every hull looked like before.
  shipArt: (typeId, salt = "") => {
    const pooled = _assetPool(`shipart:${typeId}`, salt, "");
    if (pooled) return pooled;
    const def = (typeof ALL_SHIPS !== "undefined" ? ALL_SHIPS : []).find(x => x.id === typeId);
    if (!def) return `assets/ships/shuttle.png`;
    return def.cls === "escort" ? ASSET.raceship(def.sprite) : ASSET.ship(def.sprite);
  },
  // Blackbox art per EFFECT and blueprint art per BLUEPRINT, each a pool. Both
  // fall back to the generic accessory pools they used to share, so an admin who
  // uploads nothing sees no change.
  blackbox: (effectId, salt = "") => {
    const pooled = _assetPool(`blackbox:${effectId}`, salt, "");
    return pooled || ASSET.accessory("blackbox", salt);
  },
  blueprint: (blueprintId, salt = "") => {
    const pooled = _assetPool(`blueprint:${blueprintId}`, salt, "");
    return pooled || ASSET.accessory("blueprint", salt);
  },
  // Bazaar / inventory art — admin can set a single PNG or a pool per key.
  accessory: (kind, salt = "") => _assetPool(`accessory:${kind}`, salt, `assets/accessories/${kind}.png`),
  extractor: (type, salt = "") => _assetPool(`extractor:${type}`, salt, `assets/extractors/${type}.png`),
  component: (kind, salt = "") => _assetPool(`component:${kind}`, salt, `assets/components/${kind}.png`),
  contract: type => _asset(`contract:${type}`, `assets/contracts/${type}.png`),
  merc: (shipType, salt = "") => {
    const pooled = _assetPool(`merc:${shipType}`, salt, "");
    if (pooled) return pooled;
    const def = (typeof ALL_SHIPS !== "undefined" ? ALL_SHIPS : []).find(x => x.id === shipType);
    if (!def) return `assets/ships/shuttle.png`;
    return def.cls === "escort" ? ASSET.raceship(def.sprite) : ASSET.ship(def.sprite);
  },
};

/* PAGE_BG_PAGES — nav tabs that take an admin-uploaded 1920×1080 background.
   Star Map is an overlay (uses its own nebula/spacebg), so it's omitted.       */
const PAGE_BG_PAGES = [
  { id: "hub", label: "Hub" },
  { id: "exchange", label: "Exchange" },
  { id: "fleet", label: "Fleet" },
  { id: "systems", label: "Star Systems" },
  { id: "bazaar", label: "Bazaar" },
  { id: "industries", label: "Industries" },
  { id: "workshop", label: "Workshop" },
  { id: "stations", label: "Stations" },
  { id: "senate", label: "Senate" },
  { id: "barons", label: "Barons" },
  { id: "ach", label: "Milestones" },
  { id: "comms", label: "Comms" },
];

/* HUB_PROPS — the feature registry for the walkable hub. Each entry is a
   "station" the player can walk up to; opening it calls UI.showPage(page) (the
   SAME path as the bottom tabs), so nothing new is wired into navigation. Props
   are PLACED into rooms by id in HUB_ROOMS below. `icon` is the emoji shown
   until you drop real art at assets/hub/<id>.png.                              */
const HUB_PROPS = [
  { id: "exchange",   page: "exchange",   label: "Exchange",     icon: "📈" },
  { id: "fleet",      page: "fleet",      label: "Fleet Bay",    icon: "🚀" },
  { id: "bazaar",     page: "bazaar",     label: "Bazaar",       icon: "🛒" },
  { id: "industries", page: "industries", label: "Foundry",      icon: "🏭" },
  { id: "workshop",   page: "workshop",   label: "Workshop",     icon: "🔧" },
  { id: "stations",   page: "stations",   label: "Stations",     icon: "🛰️" },
  { id: "senate",     page: "senate",     label: "Senate",       icon: "🏛️" },
  { id: "starmap",    page: "starmap",    label: "Star Map",     icon: "🗺️" },
  { id: "systems",    page: "systems",    label: "Star Systems", icon: "🪐" },
  { id: "barons",     page: "barons",     label: "Barons",       icon: "👑" },
  { id: "comms",      page: "comms",      label: "Comms",        icon: "📡" },
  { id: "ach",        page: "ach",        label: "Milestones",   icon: "🏆" },
];

/* HUBCFG — walkable-hub tuning (canvas tilemap). The player walks room to room;
   walking onto a door tile loads the connected room; coming within `interact`
   tiles of a prop raises a "▸ Open X" prompt you click (or press E) to enter —
   nothing auto-opens. Optional art: a 4-row walk sheet at assets/hub/player.png
   (rows = facing per `sheet.order`, cols = frames) swaps the astronaut emoji;
   assets/hub/tiles.png is reserved for a future floor/wall tileset.            */
const HUBCFG = {
  playerEmoji: "🧑‍🚀",
  startRoom: "atrium",
  speed: 4.2,          // tiles per second
  interact: 1.15,      // prop interaction radius, in tiles
  sheet: { cols: 4, rows: 4, order: ["down", "left", "right", "up"], fps: 8 },
};

/* HUB_ROOMS — each room is its own screen (top-down). `grid` is ASCII tile art:
   '#' wall (solid), '.' floor, '+' door (walkable; transitions per `doors`).
   `doors` link a door tile [tx,ty] to another room + the spawn tile there.
   `props` place features (by HUB_PROPS id) at tile [tx,ty]. `spawn` is the
   default entry tile. Draw new rooms by editing the ASCII — no code.
   `deco` (optional) holds decorative sprites dropped in via the map editor:
   { src, x, y, w, h, solid? } where x/y/w/h are in tile units (fractional for
   free placement); `solid` makes the sprite block the player.                  */
const HUB_ROOMS = {
  atrium: {
    name: "Concourse",
    grid: [
      "#############",
      "#...........#",
      "#...........#",
      "#...........#",
      "+...........+",
      "#...........#",
      "#...........#",
      "#.....+.....#",
      "#############",
    ],
    spawn: [6, 4],
    doors: [
      { tx: 0,  ty: 4, to: "market", spawn: [8, 4] },
      { tx: 12, ty: 4, to: "fleet",  spawn: [2, 4] },
      { tx: 6,  ty: 7, to: "hall",   spawn: [6, 1] },
    ],
    props: [],
    signs: [
      { tx: 0,  ty: 3, text: "Market ◂" },
      { tx: 12, ty: 3, text: "▸ Fleet" },
      { tx: 6,  ty: 8, text: "Senate Hall ▾" },
    ],
  },
  market: {
    name: "Market Wing",
    grid: [
      "###########",
      "#.........#",
      "#.........#",
      "#.........#",
      "#.........+",
      "#.........#",
      "#.........#",
      "###########",
    ],
    spawn: [8, 4],
    doors: [{ tx: 10, ty: 4, to: "atrium", spawn: [1, 4] }],
    props: [
      { id: "exchange", tx: 3, ty: 2 },
      { id: "bazaar",   tx: 6, ty: 2 },
    ],
    signs: [{ tx: 10, ty: 3, text: "Concourse ▸" }],
  },
  fleet: {
    name: "Fleet Bay",
    grid: [
      "###########",
      "#.........#",
      "#.........#",
      "#.........#",
      "+.........#",
      "#.........#",
      "#.........#",
      "###########",
    ],
    spawn: [2, 4],
    doors: [{ tx: 0, ty: 4, to: "atrium", spawn: [11, 4] }],
    props: [
      { id: "fleet",    tx: 3, ty: 2 },
      { id: "starmap",  tx: 6, ty: 2 },
      { id: "systems",  tx: 8, ty: 5 },
      { id: "workshop", tx: 5, ty: 5 },
    ],
    signs: [{ tx: 0, ty: 3, text: "◂ Concourse" }],
  },
  hall: {
    name: "Senate Hall",
    grid: [
      "######+######",
      "#...........#",
      "#...........#",
      "#...........#",
      "#...........#",
      "#...........#",
      "#...........#",
      "#############",
    ],
    spawn: [6, 1],
    doors: [{ tx: 6, ty: 0, to: "atrium", spawn: [6, 6] }],
    props: [
      { id: "senate",     tx: 3,  ty: 3 },
      { id: "industries", tx: 6,  ty: 2 },
      { id: "barons",     tx: 9,  ty: 3 },
      { id: "comms",      tx: 4,  ty: 5 },
      { id: "ach",        tx: 8,  ty: 5 },
    ],
    signs: [{ tx: 6, ty: 0, text: "▴ Concourse" }],
  },
};

// Make data available as globals (works on file:// and GitHub Pages, no fetch).
window.CONFIG = CONFIG;
window.COMMODITIES = COMMODITIES;
window.SYSTEMS = SYSTEMS;
window.SHIP_CATALOG = SHIP_CATALOG;
window.SHIP_VARIANTS = SHIP_VARIANTS;
window.ALL_SHIPS = ALL_SHIPS;
window.FLAGSHIP_EFFECTS = FLAGSHIP_EFFECTS;
window.ACCESSORY_KINDS = ACCESSORY_KINDS;
window.RARITIES = RARITIES;
window.BAZAARCFG = BAZAARCFG;
window.DMGCFG = DMGCFG;
window.CUSTOMS = CUSTOMS;
window.EXPEDCFG = EXPEDCFG;
window.BLACKBOX_EFFECTS = BLACKBOX_EFFECTS;
window.WORKSHOPCFG = WORKSHOPCFG;
window.BLUEPRINTS = BLUEPRINTS;
window.RECIPES = RECIPES;
window.MARKETCFG = MARKETCFG;
window.STOCKCFG = STOCKCFG;
window.CONSUMPTION = CONSUMPTION;
window.STATION_TIERS = STATION_TIERS;
window.STATIONCFG = STATIONCFG;
window.STATION_MODULES = STATION_MODULES;
window.CHARTERCFG = CHARTERCFG;
window.CHARTER_BANDS = CHARTER_BANDS;
window.INCIDENTCFG = INCIDENTCFG;
window.WARCFG = WARCFG;
window.INDUSTRYCFG = INDUSTRYCFG;
window.EXTRACTORCFG = EXTRACTORCFG;
window.COMPONENTCFG = COMPONENTCFG;
window.PLANET_SUITABILITY = PLANET_SUITABILITY;
window.DANGER = DANGER;
window.FACTIONS = FACTIONS;
window.CATEGORY_FACTION = CATEGORY_FACTION;
window.REP = REP;
window.RIVALCFG = RIVALCFG;
window.RIVALS = RIVALS;
window.PRESTIGE = PRESTIGE;
window.BARON_TIERS = BARON_TIERS;
window.SENATECFG = SENATECFG;
window.GALAXY = GALAXY;
window.RACES = RACES;
window.SECTORS = SECTORS;
window.STAR_TYPES = STAR_TYPES;
window.PLANET_TYPES = PLANET_TYPES;
window.SYSTEMVIEW = SYSTEMVIEW;
window.ASSET = ASSET;
window.PAGE_BG_PAGES = PAGE_BG_PAGES;
window.HUB_PROPS = HUB_PROPS;
window.HUBCFG = HUBCFG;
window.HUB_ROOMS = HUB_ROOMS;
window.ASSET_OVERRIDES = ASSET_OVERRIDES;
