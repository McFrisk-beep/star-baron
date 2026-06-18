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
  // insight and the random walk just nudge price within it and quickly fade.
  priceFloorMult: 0.88,       // price floor = (legislation-adjusted) base × this
  priceCeilMult: 1.12,        // price ceil = (legislation-adjusted) base × this  (≈ ±12%)
  meanReversion: 0.02,        // per-tick pull toward the drift+news anchor (0–1)
  newsImpact: 0.10,           // how much a news/insight event nudges price (×nominal). Low = calm.
  overheatBand: 0.03,         // once price runs >3% off base, "other barons" pile in…
  overheatPull: 0.05,         // …adding this per-tick pull back toward base, so fast moves stabilise
  maxTickMove: 0.004,         // hard cap on ordinary per-tick change (legislation's band-shift overrides it)
  // Per-tick wiggle = gauss(vol × volScale). Tiny → a chill market.
  volScale: 0.006,
  driftAmp: 0.04,             // amplitude of the slow per-category secular drift
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
   Ships are persistent assets with combat stats. Transports carry cargo and
   are cheap; escorts bring firepower and are pricey but permanent (until
   destroyed). The "main" ship is your private flagship: it sets sector-transfer
   speed and grants a passive bonus to the whole fleet. speed = relative.       */
const SHIP_CATALOG = {
  transport: [
    { id: "mule",      name: "Mule Shuttle",     cls: "transport", cargo: 12,  firepower: 1,  hull: 40,  armor: 5,   shields: 0,   speed: 1.5, slots: 2, price: 0,     sprite: "shuttle" },
    { id: "drift",     name: "Drift Hauler",     cls: "transport", cargo: 40,  firepower: 2,  hull: 80,  armor: 10,  shields: 0,   speed: 1.2, slots: 2, price: 4200,  sprite: "hauler" },
    { id: "bulk",      name: "Bulk Freighter",   cls: "transport", cargo: 120, firepower: 3,  hull: 160, armor: 20,  shields: 5,   speed: 1.0, slots: 3, price: 16000, sprite: "freighter" },
    { id: "leviathan", name: "Leviathan Barge",  cls: "transport", cargo: 400, firepower: 5,  hull: 320, armor: 40,  shields: 10,  speed: 0.8, slots: 3, price: 60000, sprite: "leviathan" },
  ],
  escort: [
    { id: "corvette",  name: "Corvette",   cls: "escort", cargo: 4,  firepower: 25,  hull: 120, armor: 30,  shields: 20,  speed: 1.8, slots: 2, price: 11000,  sprite: "voidkin" },
    { id: "frigate",   name: "Frigate",    cls: "escort", cargo: 8,  firepower: 55,  hull: 240, armor: 60,  shields: 45,  speed: 1.5, slots: 3, price: 32000,  sprite: "glorthi" },
    { id: "cruiser",   name: "Cruiser",    cls: "escort", cargo: 14, firepower: 120, hull: 480, armor: 120, shields: 90,  speed: 1.2, slots: 4, price: 95000,  sprite: "krell" },
    { id: "battleship",name: "Battleship", cls: "escort", cargo: 20, firepower: 260, hull: 900, armor: 240, shields: 180, speed: 1.0, slots: 4, price: 270000, sprite: "aurelian" },
  ],
  // Main/flagship: travelSpeed drives sector docking time; passive buffs fleet.
  main: [
    { id: "pinnace",     name: "Baron's Pinnace",    cls: "main", travelSpeed: 1.0, passive: { stat: "firepower", pct: 0.05 }, hull: 200,  price: 0,      sprite: "shuttle" },
    { id: "yacht",       name: "Void Yacht",         cls: "main", travelSpeed: 1.6, passive: { stat: "speed",     pct: 0.10 }, hull: 320,  price: 24000,  sprite: "hauler" },
    { id: "flagship",    name: "Command Flagship",   cls: "main", travelSpeed: 2.2, passive: { stat: "firepower", pct: 0.15 }, hull: 640,  price: 140000, sprite: "freighter" },
    { id: "dreadnought", name: "Baron Dreadnought",  cls: "main", travelSpeed: 3.0, passive: { stat: "all",       pct: 0.12 }, hull: 1300, price: 650000, sprite: "leviathan" },
  ],
};
const ALL_SHIPS = [...SHIP_CATALOG.transport, ...SHIP_CATALOG.escort, ...SHIP_CATALOG.main];

/* ---- SHIP ACCESSORIES -----------------------------------------------------
   Procedurally named/statted items (see items.js). Each kind buffs one stat;
   pct stats scale the ship, flat stats add. Legendaries get a 2nd bonus stat. */
const ACCESSORY_KINDS = {
  engine:  { label: "Engine",   stat: "speed",     pct: true,  base: 0.04,  sprite: "engine" },
  reactor: { label: "Reactor",  stat: "firepower", pct: true,  base: 0.06,  sprite: "reactor" },
  cannon:  { label: "Cannon",   stat: "firepower", pct: false, base: 12,    sprite: "cannon" },
  plating: { label: "Plating",  stat: "armor",     pct: false, base: 18,    sprite: "plating" },
  shield:  { label: "Shield",   stat: "shields",   pct: false, base: 16,    sprite: "shield" },
  hold:    { label: "Cargo Pod",stat: "cargo",     pct: false, base: 8,     sprite: "hold" },
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
  mercSlots: 8,            // how many mercs are on offer at once
  contractSlots: 14,       // how many contracts on the board
  accessorySlots: 18,      // how many accessories for sale
  mercTickMs: 90 * 1000,   // how often merc offers churn
  accessoryTickMs: 45 * 1000, // how often an accessory may sell / refresh
  contractExpiryMs: 8 * 60 * 1000,   // an open contract expires after this
  contractNpcTakeMs: 4 * 60 * 1000,  // ~when an NPC may grab an untaken job
  contractTakenShowMs: 2 * 60 * 1000,// "Contract taken" lingers this long
  inventoryUpgradeStep: 10,          // +slots per upgrade
  inventoryUpgradeBase: 6000,        // first upgrade price (scales up)
  itemResaleMult: 0.55,              // instant "Sell now" payout = this × an item's value
  shipResaleMult: 0.5,               // sell a ship for this × its catalog price (40–60% band); gear adds its resale value
};

/* ---- TRADE ROUTES ---------------------------------------------------------
   Assign an idle ship to ferry a commodity from a cheap system to a dear one;
   it banks the price spread × cargo every round trip while you're away.        */
const ROUTECFG = {
  margin: 0.5,              // ship keeps this × (spread × cargo) per round trip (the rest is "friction/fuel")
  legSecondsPerDist: 150,   // round-trip seconds = 2 × distance × this ÷ ship speed (tune transit length here)
  maxCyclesPerResolve: 50,  // cap round trips banked in a single catch-up (anti-windfall on long idles)
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
   The competitive ladder. Twelve AI barons whose net worth drifts upward over
   time (idle = fall behind); the player climbs past them as they grow rich.
   Each rival is affiliated with a faction — your standing colors how they
   needle you when you trade ranks. `base` seeds their net worth (spread ~geo-
   metrically so there's always someone just above and just below you for a
   very long time); `growthPerHr` is their organic compounding rate.            */
const RIVALCFG = {
  driftMs: 4000,          // rivals re-price about this often
  snapshotMs: 20 * 1000,  // how often the leaderboard re-baselines rank arrows
  noiseSd: 0.01,          // per-drift gaussian wiggle on net worth
  minMult: 0.4,           // a rival never sinks below base × this…
  maxMult: 6,             // …nor balloons past base × this
  barbMinGapMs: 70 * 1000,// throttle rival chatter (taunts/gloats/brags)
  ambientChance: 0.06,    // chance per drift a rival brags unprompted
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
const PRESTIGE = {
  threshold: 1000000,      // net worth needed to retire
  bonusPerTier: 0.15,      // +15% income/price-edge per Baron Tier
  volPerTier: 0.05,        // +5% market volatility per tier (harder + richer)
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
  lobbyAllStrength: 0.45, lobbyFacStrength: 0.8, bribeStrength: 1.4,
  relGainOnBribe: 22, relLossOnBackfire: 18,
  scandalBackfireBase: 0.32, scandalTierRelief: 0.06,  // backfire chance −6%/tier
  lobbyAllCost: 9000, lobbyFacCost: 5500, bribeCostBase: 3500, scandalCostBase: 7000,
  dossierMinPrice: 1500, dossierMaxPrice: 9000, dossierSlots: 3,
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

// Admin-uploaded sprite overrides ("category:name" -> custom URL), loaded from
// Supabase by content.js. _asset() returns the override if present, else the
// built-in /assets path — so swapping a sprite is just setting a key here.
const ASSET_OVERRIDES = {};
const _asset = (key, path) => ASSET_OVERRIDES[key] || path;

// asset path helpers — change these if you reorganize /assets
const ASSET = {
  portrait: i => _asset(`portrait:${i}`, `assets/portraits/alien_${String(i).padStart(2, "0")}.png`),
  commodity: id => _asset(`commodity:${id}`, `assets/commodities/${id}.png`),
  ship: sprite => _asset(`ship:${sprite}`, `assets/ships/${sprite}.png`),
  broadcast: name => _asset(`broadcast:${name}`, `assets/broadcast/${name}.png`),
  star: type => _asset(`star:${type}`, `assets/stars/${type}.png`),
  planet: type => _asset(`planet:${type}`, `assets/planets/${type}.png`),
  station: race => _asset(`station:${race}`, `assets/stations/${race}.png`),
  raceship: race => _asset(`raceship:${race}`, `assets/raceships/${race}.png`),
  nebula: name => _asset(`nebula:${name}`, `assets/nebula/${name}.png`),
  asteroids: () => _asset(`asteroids:_`, `assets/space/asteroids.png`),
};

// Make data available as globals (works on file:// and GitHub Pages, no fetch).
window.CONFIG = CONFIG;
window.COMMODITIES = COMMODITIES;
window.SYSTEMS = SYSTEMS;
window.SHIP_CATALOG = SHIP_CATALOG;
window.ALL_SHIPS = ALL_SHIPS;
window.ACCESSORY_KINDS = ACCESSORY_KINDS;
window.RARITIES = RARITIES;
window.BAZAARCFG = BAZAARCFG;
window.ROUTECFG = ROUTECFG;
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
window.SENATECFG = SENATECFG;
window.GALAXY = GALAXY;
window.RACES = RACES;
window.SECTORS = SECTORS;
window.STAR_TYPES = STAR_TYPES;
window.PLANET_TYPES = PLANET_TYPES;
window.SYSTEMVIEW = SYSTEMVIEW;
window.ASSET = ASSET;
window.ASSET_OVERRIDES = ASSET_OVERRIDES;
