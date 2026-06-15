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
  chatMaxMessages: 60,        // how many to keep on screen

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
  driftAmp: 0.12,             // amplitude of the slow per-category secular drift
  driftPeriodMs: 20 * 60 * 1000, // one full sector-rotation cycle

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

// asset path helpers — change these if you reorganize /assets
const ASSET = {
  portrait: i => `assets/portraits/alien_${String(i).padStart(2, "0")}.png`,
  commodity: id => `assets/commodities/${id}.png`,
  ship: sprite => `assets/ships/${sprite}.png`,
  broadcast: name => `assets/broadcast/${name}.png`,
};

// Make data available as globals (works on file:// and GitHub Pages, no fetch).
window.CONFIG = CONFIG;
window.COMMODITIES = COMMODITIES;
window.SYSTEMS = SYSTEMS;
window.SHIP_TYPES = SHIP_TYPES;
window.FACTIONS = FACTIONS;
window.PRESTIGE = PRESTIGE;
window.ASSET = ASSET;
