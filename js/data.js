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

  // Market guardrails: price can't drift past base × these. Keeps the
  // random walk + news shocks from running away to absurdity.
  priceFloorMult: 0.3,
  priceCeilMult: 3.0,
  meanReversion: 0.02,        // per-tick pull back toward base (0–1)
  // Per-tick wiggle = gauss(vol × volScale). Keep this small for a "chill"
  // market: at volScale 0.03 even the jumpiest commodity moves ~0.5%/tick,
  // most far less. Raise for a wilder market.
  volScale: 0.03,
  driftAmp: 0.06,             // amplitude of the slow per-category secular drift
  driftPeriodMs: 30 * 60 * 1000, // one full sector-rotation cycle

  // Offline catch-up: cap how much real time we simulate forward on return.
  maxOfflineMs: 7 * 24 * 60 * 60 * 1000, // 7 days

  // Autosave cadence.
  autosaveMs: 10 * 1000,

  // DEV: set true to make news fire every ~20s so you can watch it work.
  fastNews: false,
};

/* ---- COMMODITIES ----------------------------------------------------------
   category drives which systems are cheap/dear and which news hits it.
   vol = volatility (0–1); higher = bigger live price swings.                  */
const COMMODITIES = [
  { id: "iron_ore",    name: "Iron Ore",    cat: "mineral", base: 40,  vol: 0.04 },
  { id: "silicon",     name: "Silicon",     cat: "mineral", base: 65,  vol: 0.05 },
  { id: "rare_earths", name: "Rare Earths", cat: "mineral", base: 220, vol: 0.09 },
  { id: "hydrogen",    name: "Hydrogen",    cat: "gas",     base: 30,  vol: 0.05 },
  { id: "helium3",     name: "Helium-3",    cat: "gas",     base: 180, vol: 0.08 },
  { id: "water_ice",   name: "Water Ice",   cat: "gas",     base: 25,  vol: 0.06 },
  { id: "foodstuffs",  name: "Foodstuffs",  cat: "agri",    base: 55,  vol: 0.05 },
  { id: "synthsilk",   name: "Synthsilk",   cat: "agri",    base: 140, vol: 0.07 },
  { id: "nanochips",   name: "Nanochips",   cat: "tech",    base: 320, vol: 0.10 },
  { id: "antimatter",  name: "Antimatter",  cat: "tech",    base: 900, vol: 0.14 },
  { id: "spice",       name: "Spice",       cat: "luxury",  base: 260, vol: 0.12 },
  { id: "contraband",  name: "Contraband",  cat: "illicit", base: 480, vol: 0.18 },
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
   speed = distance units cleared per minute. travelMin = distance/speed.      */
const SHIP_TYPES = [
  { id: "shuttle",   name: "Mule-class Shuttle", hold: 12,  speed: 1.5, price: 0,     sprite: "shuttle" },
  { id: "hauler",    name: "Drift Hauler",       hold: 40,  speed: 1.2, price: 4200,  sprite: "hauler" },
  { id: "freighter", name: "Bulk Freighter",     hold: 120, speed: 1.0, price: 16000, sprite: "freighter" },
  { id: "leviathan", name: "Leviathan Barge",    hold: 400, speed: 0.8, price: 60000, sprite: "leviathan" },
];

/* ---- FACTIONS -------------------------------------------------------------
   Used to theme the newswire so it reads as a living galaxy.                  */
const FACTIONS = {
  syndicate:      { name: "The Syndicate",       color: "#ff5d73" },
  mining_combine: { name: "Mining Combine",      color: "#9aa9c8" },
  free_trade:     { name: "Free-Trade League",   color: "#3ad6a0" },
  agri_collective:{ name: "Agri-Collective",     color: "#78d278" },
};

/* ---- PRESTIGE -------------------------------------------------------------
   [DECISION] starting curve — tune freely. Unlocks at the net-worth
   threshold; "sell the empire" grants a permanent multiplier and bumps the
   Baron Tier so the next run is both harder (more volatile) and richer.       */
const PRESTIGE = {
  threshold: 1000000,      // net worth needed to retire
  bonusPerTier: 0.15,      // +15% income/price-edge per Baron Tier
  volPerTier: 0.05,        // +5% market volatility per tier (harder + richer)
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

// asset path helpers — change these if you reorganize /assets
const ASSET = {
  portrait: i => `assets/portraits/alien_${String(i).padStart(2, "0")}.png`,
  commodity: id => `assets/commodities/${id}.png`,
  ship: sprite => `assets/ships/${sprite}.png`,
  broadcast: name => `assets/broadcast/${name}.png`,
  star: type => `assets/stars/${type}.png`,
  planet: type => `assets/planets/${type}.png`,
  station: race => `assets/stations/${race}.png`,
  raceship: race => `assets/raceships/${race}.png`,
  nebula: name => `assets/nebula/${name}.png`,
  asteroids: () => `assets/space/asteroids.png`,
};

// Make data available as globals (works on file:// and GitHub Pages, no fetch).
window.CONFIG = CONFIG;
window.COMMODITIES = COMMODITIES;
window.SYSTEMS = SYSTEMS;
window.SHIP_TYPES = SHIP_TYPES;
window.FACTIONS = FACTIONS;
window.PRESTIGE = PRESTIGE;
window.GALAXY = GALAXY;
window.RACES = RACES;
window.SECTORS = SECTORS;
window.STAR_TYPES = STAR_TYPES;
window.PLANET_TYPES = PLANET_TYPES;
window.ASSET = ASSET;
