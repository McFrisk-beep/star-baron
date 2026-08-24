#!/usr/bin/env node
/* check_station_prune.js — Stations.serialize() drops only rebuildable entries.

   byId holds one entry per claimable system; _fresh(sys) is a pure function of
   the seed-stable system, so an untouched entry is write-only payload — ~43KB of
   the 45KB `stations` slice on every live save, and `stations` is ~95% of the
   whole commit. hydrate() ends in ensure(), which rebuilds them. So serialize()
   persists only the entries that carry something.

   The whole risk here is over-pruning: dropping an entry that ensure() will not
   rebuild, or that held state nobody thought to check for, silently destroys a
   player's station. These pin that it can't.

     P1  an untouched galaxy prunes to (nearly) nothing
     P2  a round trip through serialize -> hydrate is LOSSLESS for every station
     P3  any station carrying real state survives — owner, treasury, modules,
         hold, a hall listing, a contract, an impound claim, a leased bay
     P4  fails closed on a field this check predates (unknown key with content)
     P5  entries ensure() would never rebuild are kept: capitals, unknown systems
     P6  no Galaxy -> prune nothing (there'd be nothing to rebuild from)

   Run: node tools/check_station_prune.js                                       */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");

const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Math, setTimeout, clearTimeout });
ctx.window = ctx;
const T = 1_720_000_000_000;
ctx.Date = { now: () => T, parse: Date.parse };
ctx.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
ctx.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

for (const f of ["store.js", "data.js", "flavor.js", "market.js", "galaxy.js", "stock.js", "stations.js", "extractors.js", "economy.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}
const { Market, Galaxy, Stock, Stations } = ctx;
Market.init(); Galaxy.build(); Stock.init(T);
ctx.Game = { state: {}, requestSave() {} };
ctx.Bus = { emit() {} };
ctx.UI = { toast() {} };
ctx.Fleet = { fleetValue: () => 0, dockTravelMs: () => 1000, mainDef: () => ({ travelSpeed: 1 }) };
ctx.Bazaar = { itemsValue: () => 0, equippedSet: () => new Set(), inventoryItems: () => [], inventoryUsed: () => 0, capacity: () => 40 };

let failed = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); failed++; } else console.log("ok:", m); };
// Key ORDER differs between an entry loaded from a save and the same entry
// rebuilt by ensure(), and that difference is meaningless — compare canonically
// or P2 fails on nothing at all.
const canon = v => Array.isArray(v) ? v.map(canon)
  : (v && typeof v === "object") ? Object.keys(v).sort().reduce((o, k) => (o[k] = canon(v[k]), o), {})
  : v;
const eq = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const claimable = () => Galaxy.list.filter(s => !s.capital);

// A full save->load cycle, exactly as the game does it.
const roundTrip = () => { const snap = JSON.parse(JSON.stringify(Stations.serialize())); Stations.hydrate(snap); return snap; };
const reset = () => { Stations.byId = {}; Stations.hydrate(null); };

// ------------------------------------------------ P1: untouched prunes away
reset();
{
  const total = Object.keys(Stations.byId).length;
  const kept = Object.keys(Stations.serialize().byId).length;
  assert(total > 20, `P1 galaxy has a meaningful station count (${total})`);
  assert(kept === 0, `P1 an untouched galaxy persists 0 of ${total} entries (kept ${kept})`);
  const bytes = JSON.stringify(Stations.serialize()).length;
  assert(bytes < 2000, `P1 untouched \`stations\` slice is small (${bytes} bytes)`);
}

// -------------------------------------------- P2: round trip loses nothing
reset();
{
  const before = JSON.parse(JSON.stringify(Stations.byId));
  roundTrip();
  const after = Stations.byId;
  assert(Object.keys(after).length === Object.keys(before).length,
    `P2 every entry returns after a save/load (${Object.keys(before).length} -> ${Object.keys(after).length})`);
  const diff = Object.keys(before).filter(id => !eq(before[id], after[id]));
  assert(diff.length === 0, `P2 each rebuilt entry is identical (${diff.length} differ${diff.length ? ": " + diff.slice(0, 3) : ""})`);
  // And it must still be stable on a SECOND cycle — a prune that only survives
  // one trip would rot a save slowly rather than loudly.
  roundTrip();
  assert(Object.keys(Stations.byId).length === Object.keys(before).length, "P2 stable across a second save/load");
}

// ------------------------------------------------- P3: real state survives
const mutations = {
  "an owner":        st => { st.ownerId = "u1"; st.status = "owned"; },
  "treasury":        st => { st.treasury = 5000; },
  "a module":        st => { st.modules = { production_hub: 1 }; },
  "cargo in hold":   st => { st.hold = { ore: 12 }; },
  "a hall listing":  st => { st.hall = [{ id: "l1", kind: "gear", name: "X", price: 10 }]; },
  "a contract":      st => { st.contracts = [{ id: "c1", commId: "ore", qty: 5, rate: 9, status: "open" }]; },
  "an impound claim":st => { st.impoundClaims = [{ id: "i1", commId: "ore", qty: 3, value: 90, ransom: 10 }]; },
  "a leased bay":    st => { st.bays = [{ lesseeId: "u2", extractorId: "e1", npc: false }]; },
  "reactor level":   st => { st.reactorLevel = 2; },
  "standing drift":  st => { st.standing = 3; },
  "scrutiny drift":  st => { st.scrutiny = 0; },
  "a delivery":      st => { st.delivered = 4; },
};
for (const [what, mutate] of Object.entries(mutations)) {
  reset();
  const id = claimable()[3].id;
  mutate(Stations.byId[id]);
  const kept = Stations.serialize().byId;
  assert(kept[id] !== undefined, `P3 a station with ${what} is persisted`);
}

// --------------------------------------- P4: unknown-but-populated key kept
{
  reset();
  const id = claimable()[4].id;
  Stations.byId[id].somethingAFutureFeatureAdds = { owed: 500 };
  assert(Stations.serialize().byId[id] !== undefined,
    "P4 an unknown key carrying content keeps the entry (fails closed)");
  // ...but an unknown EMPTY key must not defeat the prune, or it never fires.
  reset();
  const id2 = claimable()[5].id;
  Stations.byId[id2].someEmptyFutureKey = {};
  assert(Stations.serialize().byId[id2] === undefined,
    "P4 an unknown key holding nothing still prunes");
}

// ------------------------------- P5: entries ensure() won't rebuild are kept
{
  reset();
  const cap = Galaxy.list.find(s => s.capital);
  if (cap) {
    Stations.byId[cap.id] = Stations._fresh(cap);
    assert(Stations.serialize().byId[cap.id] !== undefined,
      "P5 a capital's entry is kept (ensure() skips capitals)");
  } else { console.log("ok: P5 no capitals in this galaxy — skipped"); }
  reset();
  Stations.byId["system_that_does_not_exist"] = Stations._fresh({ id: "system_that_does_not_exist", sectorId: "x", stationName: "Ghost Berth" });
  assert(Stations.serialize().byId["system_that_does_not_exist"] !== undefined,
    "P5 an entry for an unknown system is kept (ensure() can't rebuild it)");
}

// ------------------- P7: an entry rebuilt by ensure() == one loaded from a save
// The bug this pins was invisible to every synthetic case above and only showed
// up against a real 45KB save: hydrate() coerces pendingCargo/pendingPayouts
// onto every STORED station, so before _fresh() grew them, a pruned-and-rebuilt
// entry silently lacked two keys its stored twin had. Reads all guard for
// absence today; the next unguarded one would only break on a pruned save.
{
  reset();
  // A save in the pre-prune shape: every entry stored, carrying the coerced keys.
  const legacy = { byId: {}, auctions: {}, access: {}, ledger: {}, lastWarn: {}, unclaimed: [], remoteLeases: {} };
  for (const sys of claimable()) legacy.byId[sys.id] = { ...Stations._fresh(sys), pendingCargo: {}, pendingPayouts: {} };
  Stations.hydrate(JSON.parse(JSON.stringify(legacy)));
  const loaded = JSON.parse(JSON.stringify(Stations.byId));
  const pruned = JSON.parse(JSON.stringify(Stations.serialize()));
  const prunedCount = Object.keys(pruned.byId).length;
  // hydrate() takes ownership of snap.byId and ensure() fills the rebuilt
  // entries straight into it, so measure BEFORE and hand over a copy.
  Stations.byId = {}; Stations.hydrate(JSON.parse(JSON.stringify(pruned)));
  const rebuilt = Stations.byId;
  const ids = new Set([...Object.keys(loaded), ...Object.keys(rebuilt)]);
  const diff = [...ids].filter(id => !eq(loaded[id], rebuilt[id]));
  assert(diff.length === 0,
    `P7 a pruned entry rebuilds identical to its stored twin (${diff.length} differ${diff.length ? ": " + diff.slice(0, 2) : ""})`);
  assert(prunedCount === 0, `P7 a legacy all-stored save still prunes to 0 (kept ${prunedCount})`);
}

// ----------------------------------------------- P6: no Galaxy -> no prune
{
  reset();
  const n = Object.keys(Stations.byId).length;
  const saved = ctx.Galaxy;
  ctx.Galaxy = undefined;
  const kept = Object.keys(Stations.serialize().byId).length;
  ctx.Galaxy = saved;
  assert(kept === n, `P6 without Galaxy nothing is pruned (${kept}/${n} kept)`);
}

console.log(failed ? `\n${failed} FAILED` : "\nall station-prune guardrails hold");
process.exit(failed ? 1 : 0);
