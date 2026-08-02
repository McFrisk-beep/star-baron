/* market_sql_ref.js — JS mirror of docs/sql/market_price.sql
   Used by tools/check_market_parity.js so we can assert JS↔SQL parity without a
   live Postgres. When you change the SQL, change this file to match.

   COMMS = full market.commodity() lookup (all 45, incl. craftOnly).
   EVENT_COMMS = event_slot / event_slot_local target pool (41 non-craftOnly,
   same order as Market.tradeable()).                                           */
"use strict";

const SEED = "cosmocrat-market-v1";
const VOL_GAIN = 0.25;
const FLOOR_M = 0.88;
const CEIL_M = 1.12;
const DRIFT_AMP = 0.04;
const DRIFT_PERIOD = 1_800_000;
const MOD_COMPRESSION = 0.35;
const NEWS_IMPACT = 0.10;
const EVENT_PERIOD = 5_400_000;
const EVENT_DUR = 2_700_000;
const LOCAL_PERIOD = 2_700_000;
const LOCAL_DUR = 1_200_000;
const OSC_MIN = [900_000, 2_400_000, 5_400_000];
const OSC_MAX = [1_800_000, 4_200_000, 10_800_000];
const CATS = ["mineral", "gas", "agri", "tech", "luxury", "illicit"];
const COMMS = [
  { id: "iron_ore", cat: "mineral", base: 40, vol: 0.04 },
  { id: "silicon", cat: "mineral", base: 65, vol: 0.05 },
  { id: "rare_earths", cat: "mineral", base: 220, vol: 0.09 },
  { id: "titanium_ore", cat: "mineral", base: 150, vol: 0.07 },
  { id: "cobalt_ore", cat: "mineral", base: 90, vol: 0.06 },
  { id: "graphene_lattice", cat: "mineral", base: 260, vol: 0.09 },
  { id: "pulsar_shard", cat: "mineral", base: 680, vol: 0.17 },
  { id: "voidstone", cat: "mineral", base: 1400, vol: 0.20 },
  { id: "hydrogen", cat: "gas", base: 30, vol: 0.05 },
  { id: "helium3", cat: "gas", base: 180, vol: 0.08 },
  { id: "water_ice", cat: "gas", base: 25, vol: 0.06 },
  { id: "plasma_gas", cat: "gas", base: 210, vol: 0.10 },
  { id: "methane_slurry", cat: "gas", base: 85, vol: 0.06 },
  { id: "xenon_gas", cat: "gas", base: 260, vol: 0.11 },
  { id: "cryo_vapor", cat: "gas", base: 340, vol: 0.12 },
  { id: "quantum_foam", cat: "gas", base: 1100, vol: 0.19 },
  { id: "foodstuffs", cat: "agri", base: 55, vol: 0.05 },
  { id: "synthsilk", cat: "agri", base: 140, vol: 0.07 },
  { id: "grain", cat: "agri", base: 35, vol: 0.04 },
  { id: "protein_stock", cat: "agri", base: 70, vol: 0.05 },
  { id: "hydro_greens", cat: "agri", base: 50, vol: 0.05 },
  { id: "algae_paste", cat: "agri", base: 45, vol: 0.05 },
  { id: "biofiber", cat: "agri", base: 160, vol: 0.08 },
  { id: "nectar_extract", cat: "agri", base: 190, vol: 0.08 },
  { id: "medicinal_herbs", cat: "agri", base: 200, vol: 0.09 },
  { id: "spore_culture", cat: "agri", base: 380, vol: 0.14 },
  { id: "nanochips", cat: "tech", base: 320, vol: 0.10 },
  { id: "antimatter", cat: "tech", base: 900, vol: 0.14 },
  { id: "fusion_cell", cat: "tech", base: 260, vol: 0.08 },
  { id: "sensor_array", cat: "tech", base: 410, vol: 0.11 },
  { id: "neural_processor", cat: "tech", base: 560, vol: 0.13 },
  { id: "quantum_core", cat: "tech", base: 750, vol: 0.13 },
  { id: "ai_matrix", cat: "tech", base: 2200, vol: 0.22 },
  { id: "spice", cat: "luxury", base: 260, vol: 0.12 },
  { id: "gemstones", cat: "luxury", base: 300, vol: 0.10 },
  { id: "vintage_wine", cat: "luxury", base: 180, vol: 0.08 },
  { id: "perfume_essence", cat: "luxury", base: 220, vol: 0.09 },
  { id: "fine_art", cat: "luxury", base: 420, vol: 0.13 },
  { id: "exotic_pelts", cat: "luxury", base: 520, vol: 0.15 },
  { id: "contraband", cat: "illicit", base: 480, vol: 0.18 },
  { id: "narcotics", cat: "illicit", base: 340, vol: 0.16 },
  { id: "forged_credentials", cat: "illicit", base: 410, vol: 0.15 },
  { id: "weapons_cache", cat: "illicit", base: 600, vol: 0.17 },
  { id: "bio_toxin", cat: "illicit", base: 720, vol: 0.19 },
  { id: "cipher_shard", cat: "illicit", base: 950, vol: 0.21 },
];
// craftOnly ids are in COMMS for price lookup but never event targets.
const EVENT_COMMS = [
  "iron_ore", "silicon", "rare_earths", "titanium_ore", "cobalt_ore", "graphene_lattice", "pulsar_shard",
  "hydrogen", "helium3", "water_ice", "plasma_gas", "methane_slurry", "xenon_gas", "cryo_vapor",
  "foodstuffs", "synthsilk", "grain", "protein_stock", "hydro_greens", "algae_paste", "biofiber",
  "nectar_extract", "medicinal_herbs", "spore_culture",
  "nanochips", "antimatter", "fusion_cell", "sensor_array", "neural_processor", "quantum_core",
  "spice", "gemstones", "vintage_wine", "perfume_essence", "fine_art", "exotic_pelts",
  "contraband", "narcotics", "forged_credentials", "weapons_cache", "bio_toxin",
];
const SYS_MODS = {
  navos:  { mineral: 1.0, gas: 1.0, agri: 1.0, tech: 1.0, luxury: 1.0, illicit: 1.0 },
  korrin: { mineral: 0.65, gas: 0.9, agri: 1.25, tech: 1.2, luxury: 1.15, illicit: 1.1 },
  velm:   { mineral: 1.2, gas: 0.6, agri: 0.85, tech: 1.15, luxury: 1.1, illicit: 1.0 },
  thessa: { mineral: 1.15, gas: 1.1, agri: 0.55, tech: 1.25, luxury: 1.2, illicit: 1.05 },
  orin:   { mineral: 1.1, gas: 1.15, agri: 1.2, tech: 0.6, luxury: 1.1, illicit: 1.15 },
  sable:  { mineral: 1.25, gas: 1.2, agri: 1.3, tech: 1.2, luxury: 0.7, illicit: 0.55 },
};

function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function seedHash(...parts) { return fnv1a([SEED, ...parts].join("|")); }
function u01(seed, n = 0) {
  let a = seed >>> 0, r = 0;
  for (let i = 0; i <= n; i++) {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return r;
}
function commodity(id) { return COMMS.find(c => c.id === id); }
function modCompressed(system, cat) {
  const raw = (SYS_MODS[system] && SYS_MODS[system][cat]) ?? 1;
  return 1 + (raw - 1) * MOD_COMPRESSION;
}
function categoryDrift(cat, t) {
  const idx = Math.max(0, CATS.indexOf(cat));
  const phase = (idx / CATS.length) * Math.PI * 2;
  return 1 + DRIFT_AMP * Math.sin((t / DRIFT_PERIOD) * Math.PI * 2 + phase);
}
function osc(commId, t) {
  const raw = [], periods = [], thetas = [];
  for (let i = 0; i < 3; i++) {
    const s = seedHash(commId, "osc", String(i));
    raw.push(0.35 + u01(s, 0) * 0.65);
    periods.push(OSC_MIN[i] + u01(s, 1) * (OSC_MAX[i] - OSC_MIN[i]));
    thetas.push(u01(s, 2) * Math.PI * 2);
  }
  const norm = Math.hypot(raw[0], raw[1], raw[2]) || 1;
  let sum = 0;
  for (let i = 0; i < 3; i++) sum += (raw[i] / norm) * Math.sin((Math.PI * 2 * t) / periods[i] + thetas[i]);
  return sum;
}
function eventSlot(kind, slot) {
  const s = seedHash(kind, "slot", String(slot));
  const pickCat = u01(s, 0) < 0.7;
  const n = EVENT_COMMS.length;
  const target = pickCat
    ? CATS[Math.floor(u01(s, 1) * CATS.length) % CATS.length]
    : EVENT_COMMS[Math.floor(u01(s, 1) * n) % n];
  const up = u01(s, 2) < 0.55;
  const mult = up ? 1.15 + u01(s, 3) * 0.55 : 0.55 + u01(s, 3) * 0.30;
  return { target, mult };
}
function eventSlotLocal(system, slot) {
  const s = seedHash("local", system, "slot", String(slot));
  const pickCat = u01(s, 0) < 0.6;
  const n = EVENT_COMMS.length;
  const target = pickCat
    ? CATS[Math.floor(u01(s, 1) * CATS.length) % CATS.length]
    : EVENT_COMMS[Math.floor(u01(s, 1) * n) % n];
  const up = u01(s, 2) < 0.5;
  const mult = up ? 1.2 + u01(s, 3) * 0.5 : 0.5 + u01(s, 3) * 0.35;
  return { target, mult };
}
function scheduleMult(comm, t, period, duration, kind, system = null) {
  let m = 1;
  const slot = Math.floor(t / period);
  const lookback = Math.ceil(duration / period) + 1;
  for (let s = slot - lookback; s <= slot; s++) {
    if (s < 0) continue;
    const ev = system == null ? eventSlot(kind, s) : eventSlotLocal(system, s);
    const start = s * period;
    if (t < start || t >= start + duration) continue;
    if (ev.target !== comm.id && ev.target !== comm.cat) continue;
    const envelope = Math.sin(((t - start) / duration) * Math.PI);
    m *= 1 + (ev.mult - 1) * envelope * NEWS_IMPACT;
  }
  return m;
}
function priceGlobal(commId, t) {
  const c = commodity(commId);
  let price = c.base * categoryDrift(c.cat, t) * (1 + c.vol * VOL_GAIN * osc(c.id, t))
    * scheduleMult(c, t, EVENT_PERIOD, EVENT_DUR, "galactic", null);
  return Math.max(c.base * FLOOR_M, Math.min(c.base * CEIL_M, price));
}
function priceSystem(commId, system, t) {
  const c = commodity(commId);
  return priceGlobal(commId, t) * modCompressed(system, c.cat)
    * scheduleMult(c, t, LOCAL_PERIOD, LOCAL_DUR, "local", system);
}

module.exports = { priceGlobal, priceSystem, COMMS, EVENT_COMMS, SYS_MODS };
