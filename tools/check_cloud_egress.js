#!/usr/bin/env node
/* check_cloud_egress.js — the Supabase egress cuts, as runnable regressions.

     E1  Market.serialize() drops prices/hist (hydrate recomputes both anyway)
     E2  Cloud.wireState() keeps every player slice, strips the local-only ones
     E3  Store skips a cloud push whose wire payload is unchanged…
     E4  …but pushes again as soon as anything the server cares about moves,
         and a FAILED push always retries (never latched "clean")
     E5  flush() honours the same fingerprint
     E6  Store.carryLocalOnly restores a local-only slice a cloud load omits
     E7  app_commit_lite strips exactly the slices applyCommitState never reads

   Run: node tools/check_cloud_egress.js                                        */
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const root = path.join(__dirname, "..");
const src = f => fs.readFileSync(path.join(root, f), "utf8");
let failed = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); failed++; } else console.log("ok:", m); };

// --------------------------------------------------------------- E1: market
// prices/hist are pure functions of (seed, effects, now): hydrate() overwrites
// both unconditionally, so persisting them was write-only payload (~54KB).
{
  const marketSrc = src("js/market.js");
  const ser = marketSrc.slice(marketSrc.indexOf("  serialize() {"));
  const body = ser.slice(0, ser.indexOf("\n  },"));
  assert(!/\bprices\b/.test(body), "E1 Market.serialize no longer persists prices");
  assert(!/\bhist\b/.test(body), "E1 Market.serialize no longer persists hist");
  assert(/effects/.test(body), "E1 Market.serialize still persists effects (real state)");
  // The load side must genuinely rebuild them, or E1 is data loss, not a saving.
  const hyd = marketSrc.slice(marketSrc.indexOf("  hydrate(snap) {"));
  assert(/this\.prices\[c\.id\] = this\.displayGlobal/.test(hyd), "E1 hydrate recomputes prices");
  assert(/this\.hist\[c\.id\] = this\._sampleHist/.test(hyd), "E1 hydrate recomputes hist");
}

// ---------------------------------------------------- Store + Cloud harness
function boot() {
  const mem = { local: null };
  // Controllable clock: Store debounces cloud pushes by _cloudMs, and these
  // checks care about ordering, not wall time.
  const timers = { pending: null };
  const ctx = {
    console: { log() {}, warn() {} },
    setTimeout: (fn) => { timers.pending = fn; return 1; },
    clearTimeout: () => { timers.pending = null; },
    localStorage: {
      getItem: () => mem.local,
      setItem: (_k, v) => { mem.local = v; },
      removeItem: () => { mem.local = null; },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  // Real Cloud, so wireState/localOnly are the shipped ones — but never wired
  // to a client, so nothing here can reach the network.
  vm.runInContext(src("js/cloud.js"), ctx);
  vm.runInContext(src("js/store.js"), ctx);
  const pushes = [];
  ctx.Cloud.signedIn = () => true;
  ctx.Cloud.user = () => ({ id: "user-aaa" });
  ctx.Cloud.saveRemote = async (state) => {
    if (ctx.Cloud._failNext) { ctx.Cloud._failNext = false; throw new Error("boom"); }
    pushes.push(JSON.parse(JSON.stringify(state)));
  };
  return { ctx, Store: ctx.Store, Cloud: ctx.Cloud, pushes, mem, timers };
}
// Fire the pending debounce instead of waiting _cloudMs for it.
const settle = async (timers) => {
  const fn = timers.pending;
  timers.pending = null;
  if (fn) fn();
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

// ------------------------------------------------------------ E2: wireState
{
  const { Cloud } = boot();
  assert(typeof Cloud.wireState === "function", "E2 Cloud.wireState exists (Store's fingerprint relies on it)");
  const state = { credits: 10, ships: [1], items: {}, galaxy: { localLog: { sol: ["x"] } }, market: { effects: [] } };
  const wire = Cloud.wireState(state);
  assert(wire.galaxy === undefined, "E2 wireState strips galaxy (local-only)");
  assert(wire.credits === 10 && wire.ships && wire.items, "E2 wireState keeps player slices");
  assert(state.galaxy !== undefined, "E2 wireState does not mutate the live state");
}

// ------------------------------------------------- E3/E4: the dirty check
(async () => {
  {
    const { Store, Cloud, pushes, timers } = boot();
    Store._cloudReady = true;
    const state = { credits: 500, galaxy: { localLog: {} } };

    await Store.save(state); await settle(timers);
    assert(pushes.length === 1, "E3 first save pushes");

    await Store.save(state); await settle(timers);
    assert(pushes.length === 1, "E3 an identical save does not push again");

    // Flavour chatter lands in a local-only slice — it must NOT wake the cloud.
    state.galaxy.localLog.sol = [{ text: "a beacon still broadcasting" }];
    await Store.save(state); await settle(timers);
    assert(pushes.length === 1, "E3 a local-only change does not push (this is the whole point)");

    state.credits = 900;
    await Store.save(state); await settle(timers);
    assert(pushes.length === 2, "E4 a real change pushes");
    assert(pushes[1].credits === 900, "E4 the push carries the new value");

    // A dropped push must never leave the fingerprint looking synced.
    state.credits = 1200;
    Cloud._failNext = true;
    await Store.save(state); await settle(timers);
    assert(pushes.length === 2, "E4 the failed push did not land");
    assert(Store._lastSig === null, "E4 a failed push clears the fingerprint");
    await Store.save(state); await settle(timers);
    assert(pushes.length === 3 && pushes[2].credits === 1200, "E4 the retry pushes the same save");
  }

  // ------------------------------------------------------------- E5: flush
  {
    const { Store, pushes, timers } = boot();
    Store._cloudReady = true;
    const state = { credits: 42 };
    await Store.flush(state);
    assert(pushes.length === 1, "E5 flush pushes an unsynced save");
    await Store.flush(state);
    assert(pushes.length === 1, "E5 flush skips a save the server already has");
    state.credits = 43;
    await Store.flush(state);
    assert(pushes.length === 2, "E5 flush pushes once it changes again");
  }

  // ----------------------------------------------------- E6: carryLocalOnly
  {
    const { Store } = boot();
    const fromCloud = { credits: 900 };                       // no galaxy — by design
    const cached = { credits: 100, galaxy: { localLog: { sol: ["kept"] } } };
    Store.carryLocalOnly(fromCloud, cached);
    assert(fromCloud.galaxy && fromCloud.galaxy.localLog.sol[0] === "kept",
      "E6 the cached flavour log survives a cloud load");
    assert(fromCloud.credits === 900, "E6 the cloud row still wins for real state");
    // Never resurrect a slice the cloud legitimately owns.
    const both = { credits: 1, galaxy: { localLog: { sol: ["fresh"] } } };
    Store.carryLocalOnly(both, cached);
    assert(both.galaxy.localLog.sol[0] === "fresh", "E6 an existing slice is not overwritten");
  }

  // ------------------------------------------------------ E7: commit_lite
  // The SQL subtracts keys from app_commit's echo. If applyCommitState ever
  // starts reading one of them, the strip becomes silent data loss — so pin
  // the two lists against each other.
  {
    const sql = src("docs/sql/commit_lite.sql");
    const stripped = [...sql.matchAll(/^\s*- '([a-zA-Z]+)'/gm)].map(m => m[1]);
    assert(stripped.length === 7, `E7 commit_lite strips 7 slices (found ${stripped.length})`);
    const eco = src("js/economy.js");
    const apply = eco.slice(eco.indexOf("  applyCommitState(st) {"));
    const body = apply.slice(0, apply.indexOf("\n  },"));
    for (const k of stripped) {
      assert(!new RegExp(`st\\.${k}\\b`).test(body), `E7 applyCommitState never reads st.${k}`);
    }
    // And the client must actually ask for the lite wrapper.
    assert(/app_commit_lite/.test(src("js/cloud.js")), "E7 Cloud.commit calls app_commit_lite");
    assert(/commitLiteMissing/.test(src("js/cloud.js")), "E7 …with a fallback when the SQL isn't applied");
  }

  // ------------------------------------------------- E8: allowlist coverage
  // app_commit_lite filters the upload down to an allowlist before app_commit
  // sees it, and app_commit writes back whatever survives. So a top-level save
  // key that is on NEITHER the allowlist NOR app_commit's server-forced list
  // NOR Cloud.localOnly is silently dropped from the stored row — real progress
  // gone, no error anywhere.
  //
  // defaultState() is not enough to catch that: surveyRetry, war and
  // cloudUserId are all created lazily and would have been missed (surveyRetry
  // existed on exactly one live save). So enumerate the keys the CODE actually
  // touches, and fail on anything unclassified.
  {
    // app_commit's server-forced keys. Refresh with:
    //   select distinct m[1] from pg_proc p, lateral regexp_matches(
    //     pg_get_functiondef(p.oid), 'jsonb_set\(merged, ''\{([a-zA-Z_]+)\}''', 'g') m
    //   where p.proname = 'app_commit';
    const FORCED = new Set(("avgCost bazaar bazaarBought charters components credits crime "
      + "crimeSeenAt currentSystem expeditions extractors industries inventory items listings "
      + "mainShip missions pendingContracts positions prestige reputation routes ships surveyed "
      + "travel unlockedSystems workshop workshopAdopt").split(" "));

    const cloud = src("js/cloud.js");
    const noComments = t => t.replace(/\/\/.*$/gm, "");
    const wire = new Set([...noComments(cloud.match(/WIRE_KEYS: \[([\s\S]*?)\n  \]/)[1])
      .matchAll(/"([a-zA-Z_]+)"/g)].map(m => m[1]));
    const localOnly = new Set([...cloud.match(/localOnly: \[([^\]]*)\]/)[1]
      .matchAll(/"([a-zA-Z_]+)"/g)].map(m => m[1]));

    // The js/*.js modules whose s() IS the whole save (Story.s() returns
    // state.story, so its this.s().inbox must not be mistaken for a save key).
    const files = require("fs").readdirSync(path.join(root, "js")).filter(f => f.endsWith(".js"));
    const keys = new Set();
    const defSrc = src("js/main.js");
    const def = defSrc.slice(defSrc.indexOf("defaultState() {"), defSrc.indexOf("  // Fill any missing keys"));
    for (const m of def.matchAll(/^\s{6}([a-zA-Z_]+):/gm)) keys.add(m[1]);
    for (const f of files) {
      const body = src("js/" + f);
      // ANY reference is evidence of a save key, not just an assignment:
      // surveyRetry is only ever read as `this.s().surveyRetry || []`, and an
      // assignment-only regex silently missed it — the exact bug this guards.
      for (const m of body.matchAll(/Game\.state\.([a-zA-Z_]+)/g)) keys.add(m[1]);
      if (!/\bs\(\)\s*\{\s*return window\.Game\.state;/.test(body)) continue;
      for (const m of body.matchAll(/this\.s\(\)\.([a-zA-Z_]+)/g)) keys.add(m[1]);
    }

    const unclassified = [...keys].filter(k => !wire.has(k) && !FORCED.has(k) && !localOnly.has(k)).sort();
    assert(unclassified.length === 0,
      `E8 every top-level save key is classified (unclassified: ${unclassified.join(", ") || "none"})`);
    // And the two halves of the allowlist must be the same list, or a key is
    // either dropped on arrival or never sent.
    const sql = src("docs/sql/commit_allowlist.sql");
    const allow = new Set([...sql.match(/where k in \(([\s\S]*?)\n  \);/)[1]
      .replace(/--.*$/gm, "").matchAll(/'([a-zA-Z_]+)'/g)].map(m => m[1]));
    const a = [...wire].sort().join(","), b = [...allow].sort().join(",");
    assert(a === b, `E8 js WIRE_KEYS === sql allowlist (${wire.size} vs ${allow.size})`);
    // The five merge inputs app_commit reads off the client must never be cut.
    for (const k of ["credits", "ships", "industries", "expeditions", "extractors"])
      assert(wire.has(k), `E8 merge input '${k}' is still sent (app_commit reads it off the client)`);
  }

  if (failed) { console.error(`\n${failed} check(s) failed.`); process.exit(1); }
  console.log("\nall cloud-egress checks passed.");
})();
