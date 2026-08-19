#!/usr/bin/env node
/* check_low_priority.js — the ten low-severity audit findings, as runnable
   regressions. One file because they share a vm harness; each block names the
   finding it pins down.

     L1   an unresolvable storyline must not hold a MAX_ACTIVE slot forever
     L2   client bay capacity and the server's item gate mean the same thing
     L3   a signed-in player is quoted the price app_trade will actually fill at
     L4   an adopted industry nextAt can't be backdated to bank cycles
     L5   Economy.sell sends the bay-clamped fill, not the raw ask
     L6   NPC hall sale / impound fencing don't burn goods for an erased mint
     L7   payRansom refuses rather than taking the fine for cargo that vanishes
     L8   BGM's same-track check survives percent-encoded filenames
     L9   bazaarBought prunes, done threads drop their baseline, loot parks right
     L10  admin catalog edits can't throw a render away

   Run:  node tools/check_low_priority.js                                      */
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const root = path.join(__dirname, "..");
const src = f => fs.readFileSync(path.join(root, "js", f), "utf8");
const sql = f => fs.readFileSync(path.join(root, "docs/sql", f), "utf8");
let failed = 0;
const pending = [];      // async probes, awaited before the summary
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); failed++; } else console.log("ok:", m); };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

// A context with the pure data + market modules, on a pinned clock.
function marketCtx() {
  const ctx = vm.createContext({ console, Math });
  ctx.window = ctx;
  ctx.Date = { now: () => 1_700_000_000_000 };
  for (const f of ["store.js", "data.js", "cloud-config.js", "cloud.js", "content.js", "market.js"])
    vm.runInContext(src(f), ctx, { filename: f });
  ctx.Content.snapshotDefaults();
  ctx.Market.init();
  return ctx;
}

// ------------------------------------------------------------------- L1
// A prog entry whose storyline() no longer resolves (admin deleted the mission,
// ephemeral row lost) can never complete — step 1 of check() skips it. Counting
// it toward MAX_ACTIVE wedged the "start a new storyline" branch permanently.
{
  const prog = { gone: { status: "active" }, live: { status: "active" } };
  const storyline = id => (id === "gone" ? null : { id, _survey: false, _missionReport: false });
  const countActive = () => Object.keys(prog).filter(id => {
    if (prog[id].status !== "active") return false;
    const sl = storyline(id);
    if (!sl) return false;
    return !(sl._survey || sl._missionReport);
  }).length;
  assert(countActive() === 1, "L1: an unresolvable storyline doesn't occupy a MAX_ACTIVE slot");

  const storySrc = src("story.js");
  assert(/const sl = this\.storyline\(id\);\s*\n\s*\/\/[\s\S]{0,220}?if \(!sl\) return false;/.test(storySrc),
    "L1: story.js drops null storylines from the active count");
}

// ------------------------------------------------------------------- L2
// Server capacity defaulted to 6 (+10/upgrade) and counted EVERY item, equipped
// accessories included; the client counts docked-bay slots against a floor of
// 50. Six items and the buy failed with a nearly empty bay on screen.
{
  const hyg = sql("save_hygiene.sql");
  assert(/50 \+ 10 \* greatest\(coalesce\(\(p_state->'inventory'->>'upgrades'\)::int, 0\), 0\)/.test(hyg),
    "L2: app._bay_capacity uses the client's STATION_BAY_BASE + 10/upgrade floor");
  assert(/merged := app\._normalize_inventory\(merged\);/.test(hyg),
    "L2: app_commit normalizes inventory.capacity onto that floor");
  assert((hyg.match(/used := app\._inventory_used\(st\);/g) || []).length === 2,
    "L2: both capacity gates (accessory buy, craft start) count unequipped items");
  assert(!/used := \(select count\(\*\)::int from jsonb_object_keys/.test(hyg),
    "L2: no raw all-items count survives in the re-declared gates");

  // The floor the SQL hard-codes must be the one the client actually uses.
  const data = src("data.js");
  const base = /const STATION_BAY_BASE = (\d+)/.exec(data);
  const step = /inventoryUpgradeStep: (\d+)/.exec(data);
  assert(base && +base[1] === 50, "L2: STATION_BAY_BASE is still 50 (the SQL hard-codes it)");
  assert(step && +step[1] === 10, "L2: inventoryUpgradeStep is still 10 (the SQL hard-codes it)");
}

// ------------------------------------------------------------------- L3
// app_trade prices from the SQL contract alone: market.price_system ×
// scarcity_mult. The rare-stock premium, senate band, windfall overlay and news
// effects are client-only, so quoting them put the ticker up to ~35% off the
// fill — a "sell at >=900" order executed well under its limit.
{
  const ctx = marketCtx();
  const { Market, COMMODITIES } = ctx;
  const sys = ctx.SYSTEMS[0].id;
  const rare = COMMODITIES.find(c => c.rarity === "rare");
  assert(!!rare, "L3: the catalog still has a rare commodity to premium");

  // Stock present → guest sees the ×1.35 premium; the server never does.
  ctx.Stock = { scarcityMultForSystem: () => 1 };
  Market.stocks = () => 5;
  ctx.Economy = { authoritative: () => false };
  const guest = Market.systemPrice(rare.id, sys);
  ctx.Economy = { authoritative: () => true };
  const signedIn = Market.systemPrice(rare.id, sys);
  const contract = Market.formulaSystem(rare.id, sys, ctx.Date.now());

  assert(near(signedIn, contract),
    "L3: a signed-in quote is exactly formulaSystem × scarcity (the SQL contract)");
  assert(guest > signedIn * 1.3,
    `L3: the guest quote still carries the rare premium (${guest.toFixed(2)} vs ${signedIn.toFixed(2)})`);

  // ...and the phantom senate tariff is gone from the executed price.
  const ecoSrc = src("economy.js");
  assert(/_tradeTax\(cat, side\) \{\s*\n\s*if \(this\.authoritative\(\)\) return 0;/.test(ecoSrc),
    "L3: Economy._tradeTax drops the client-only senate tariff when the server fills");
  assert(!/Senate\.tradeTax\(cat, "buy"\)/.test(ecoSrc) && !/Senate\.tradeTax\(cat, "sell"\)/.test(ecoSrc),
    "L3: buyPrice/sellPrice no longer inline the tariff");
}

// ------------------------------------------------------------------- L4
// _merge_industries adopted a client row verbatim (nextAt included) whenever
// extractorUid/commodity changed. nextAt=0 + a toggled uid banked min(8) cycles
// at zero cost basis, repeatable every pull.
{
  const hyg = sql("save_hygiene.sql");
  const MIN_CYCLE = 12 * 60 * 60 * 1000 * 0.4;
  assert(new RegExp(`p_now_ms \\+ ${MIN_CYCLE}`).test(hyg),
    `L4: the clamp floors nextAt at now + the shortest server cycle (${MIN_CYCLE}ms)`);
  assert((hyg.match(/app\._clamp_industry_next\(c, now_ms\)/g) || []).length === 2,
    "L4: both client-adoption paths clamp (the changed row and the client-only row)");
  assert(!/-- Fresh install\/change — take client nextAt\n\s*s := c;/.test(hyg),
    "L4: the raw `s := c` adoption is gone");

  // The clamp itself: a forged 0 gets pushed out, an honest install is untouched.
  const now = 1_700_000_000_000;
  const clamp = nextAt => Math.max(nextAt, now + MIN_CYCLE);
  assert(clamp(0) === now + MIN_CYCLE, "L4: a forged nextAt=0 banks no cycles");
  const honest = now + 12 * 60 * 60 * 1000;                    // full-cycle extractor
  assert(clamp(honest) === honest, "L4: an honest install keeps its own timer");

  // Cross-check the constant against the SQL that actually spends it.
  const phase3 = sql("phase3_pull_prestige.sql");
  assert(/cycle_bon := greatest\(0\.4, 1\.0 - speed_bon\);/.test(phase3)
      && /cycle_ms := 12\.0 \* 60 \* 60 \* 1000 \* cycle_bon;/.test(phase3),
    "L4: _catchup_industries still runs 12h × a 0.4 floor, so the clamp is a floor not a delay");
}

// ------------------------------------------------------------------- L5
// buy sent the locally-clamped fill; sell sent the caller's raw ask. The server
// clamps only to TOTAL positions, so a sell could drain a bay in another system.
{
  const ecoSrc = src("economy.js");
  const sellFn = ecoSrc.slice(ecoSrc.indexOf("  async sell(commId, qty)"));
  assert(/let filled = want;/.test(sellFn) && /Cloud\.trade\("sell", commId, filled\)/.test(sellFn),
    "L5: sell sends the clamped fill, not the raw want");
  assert(!/Cloud\.trade\("sell", commId, want\)/.test(sellFn),
    "L5: the raw-want send is gone");
  assert(/Cloud\.trade\("sell", commId, refill\)/.test(sellFn),
    "L5: the ghost-stock retry clamps the same way");

  // Drive the seam: _sellLocal clamps to the docked bay, the RPC must see that.
  let sent = null;
  const Economy = {
    authoritative: () => true,
    _sellLocal: (id, want) => ({ ok: true, qty: Math.min(want, 12) }),   // bay holds 12
    _withRpc: async (opt, rpc) => { const r = await opt(); await rpc(); return r; },
  };
  Economy.sell = new Function("commId", "qty", "Cloud", `
    return (async () => {
      const want = Math.floor(qty);
      let filled = want;
      return this._withRpc(
        () => { const rr = this._sellLocal(commId, want); if (rr && rr.ok) filled = rr.qty; return rr; },
        () => Cloud.trade("sell", commId, filled));
    })();
  `);
  const Cloud = { trade: (_s, _c, q) => { sent = q; return { ok: true }; } };
  pending.push(Economy.sell.call(Economy, "grain", 500, Cloud).then(() => {
    assert(sent === 12, `L5: asking for 500 with 12 in the bay sends 12 (sent ${sent})`);
  }));
}

// ------------------------------------------------------------------- L6 / L7
// Under Phase 3 a credit/positions mint is erased by the next app_commit while
// the item / hold / listing removal sticks. These three paths minted raw.
{
  const st = src("stations.js");

  const npc = st.slice(st.indexOf("  _npcBuyHall(st, hourIndex)"), st.indexOf("  // ---- Contract Office"));
  assert(/l\.sellerId === this\.playerId\(\) && !this\._softMintLocal\(\)\) \{ keep\.push\(l\); continue; \}/.test(npc),
    "L6: an NPC won't buy our own stall when the proceeds would be erased");

  const fence = st.slice(st.indexOf("  sellImpound(systemId, commId, qty)"), st.indexOf("  _trimImpoundClaims"));
  assert(/if \(this\.treasuryShared\(systemId\)\)\s*\n\s*return \{ ok: false/.test(fence),
    "L6: fencing impound refuses while the server owns the treasury");
  assert(fence.indexOf("treasuryShared") < fence.indexOf("st.impoundHold[commId] -= qty"),
    "L6: it refuses BEFORE decrementing the hold / putting the goods on the shelf");

  const ransom = st.slice(st.indexOf("  payRansom(systemId, claimId)"), st.indexOf("  // Owner releases a claim"));
  assert(/if \(!this\._softMintLocal\(\)\)\s*\n\s*return \{ ok: false/.test(ransom),
    "L7: payRansom refuses rather than charging for cargo the ledger will erase");
  assert(ransom.indexOf("_softMintLocal") < ransom.indexOf("s.credits -= c.ransom"),
    "L7: it refuses BEFORE taking the fine");
  assert(/this\._mintPositions\(c\.commId, c\.qty\);/.test(ransom)
      && !/s\.positions\[c\.commId\] = \(s\.positions\[c\.commId\] \| 0\) \+ c\.qty;/.test(ransom),
    "L7: the returned cargo goes through _mintPositions (zero cost basis), not a raw +=");
}

// ------------------------------------------------------------------- L8
// a.src reads back resolved AND percent-encoded, so includes(t.url) was always
// false once filenames grew spaces — every resume reloaded and restarted the
// track from 0:00.
{
  const ctx = vm.createContext({ console, Math, document: { hidden: false } });
  ctx.window = ctx;
  ctx.Date = { now: () => 1 };
  vm.runInContext(src("bgm.js"), ctx, { filename: "bgm.js" });
  const { Bgm } = ctx;

  const TRACK = { url: "assets/bgm/1. Abandoned Outpost.mp3" };
  let loads = 0;
  const el = {
    _src: "",
    get src() { return this._src; },
    set src(v) { this._src = "https://example.test/" + encodeURI(v); },   // what a browser reports
    volume: 1, paused: true,
    load() { loads++; }, play() { return { catch() {} }; }, pause() {},
    removeAttribute() { this._src = ""; },
  };
  Bgm.el = el;
  Bgm.ensure = () => el;
  Bgm.tracks = () => [TRACK];
  Bgm.volume = () => 1;

  Bgm.play(true);
  assert(loads === 1, "L8: the first play loads the track");
  assert(el.src.includes("%20"), "L8: the harness reproduces the percent-encoded src");
  Bgm.play(false);
  Bgm.play(false);
  assert(loads === 1, `L8: resuming the same track does not reload it (loads=${loads})`);
  Bgm.play(true);
  assert(loads === 2, "L8: an explicit restart still reloads");
  Bgm.stop();
  const afterStop = loads;                       // stop() calls load() itself
  Bgm.play(false);
  assert(loads === afterStop + 1, "L8: after stop() the next play reloads (the field is cleared)");
}

// ------------------------------------------------------------------- L9
// Three unbounded-growth / mis-parked leaks that ride in every 10s commit.
{
  // (a) bazaarBought: one string per lifetime purchase, client AND server.
  const ctx = vm.createContext({ console, Math });
  ctx.window = ctx;
  const NOW = 1_700_000_000_000;
  ctx.Date = { now: () => NOW };
  for (const f of ["store.js", "data.js", "cloud-config.js", "cloud.js", "content.js", "market.js",
                   "reputation.js", "items.js", "flavor.js", "fleet.js"])
    vm.runInContext(src(f), ctx, { filename: f });
  ctx.Content.snapshotDefaults();
  ctx.Market.init();
  vm.runInContext(src("bazaar.js"), ctx, { filename: "bazaar.js" });
  const { Bazaar } = ctx;

  const board = Bazaar.boardEpoch(NOW), slow = Bazaar.slowEpoch(NOW), yard = Bazaar.yardEpoch(NOW);
  const bought = [
    `mc-${board}-0`, `mc-${board - 1}-0`, `mc-${board - 9}-0`,       // board: 2 epochs of life
    `bb-${slow}-1`, `bb-${slow - 1}-1`,                              // slow shelf: 24h
    `sy-${yard}-2`, `sy-${yard - 3}-2`,                              // yard: 5min
    "legacy-offer", "ex1234",                                        // undatable — keep
  ];
  ctx.Game = { state: { bazaarBought: bought.slice() } };
  Bazaar.s = () => ctx.Game.state;
  const dropped = Bazaar.pruneBought(NOW);
  const kept = ctx.Game.state.bazaarBought;
  assert(dropped === 3, `L9: the three datably-dead marks are pruned (got ${dropped})`);
  assert(kept.includes(`mc-${board}-0`) && kept.includes(`mc-${board - 1}-0`),
    "L9: a board mark whose offer can still be generated survives");
  assert(!kept.includes(`mc-${board - 9}-0`), "L9: a stale board mark is dropped");
  assert(kept.includes(`bb-${slow}-1`) && !kept.includes(`bb-${slow - 1}-1`),
    "L9: yesterday's slow-shelf mark is dropped, today's kept");
  assert(kept.includes(`sy-${yard}-2`) && !kept.includes(`sy-${yard - 3}-2`),
    "L9: a stale shipyard mark is dropped");
  assert(kept.includes("legacy-offer") && kept.includes("ex1234"),
    "L9: an id the rule can't date is kept, not guessed at");

  // Nothing still on the shelf may be pruned — that would re-offer a bought slot.
  for (let i = 0; i < (ctx.BAZAARCFG.blackboxSlots || 0); i++)
    assert(Bazaar.boughtLive(Bazaar.genSeededBlackbox(slow, i).id, NOW),
      `L9: today's blackbox slot ${i} stays marked`);
  for (let i = 0; i < (ctx.BAZAARCFG.yardSlots || 8); i++)
    assert(Bazaar.boughtLive(Bazaar.genSeededYardShip(yard, i).id, NOW),
      `L9: this rotation's yard slot ${i} stays marked`);

  // The SQL mirror has to agree on the clocks.
  const hyg = sql("save_hygiene.sql");
  assert(/'bb', 'bp'\) then\s*\n\s*return ep >= greatest\(0, p_now_ms\) \/ 86400000;/.test(hyg),
    "L9: the SQL slow-shelf clock is 24h, like slowRotationMs");
  assert(/kind = 'sy' then\s*\n\s*return ep >= greatest\(0, p_now_ms\) \/ 300000;/.test(hyg),
    "L9: the SQL yard clock is 5min, like yardRotationMs");
  assert(/return ep >= \(greatest\(0, p_now_ms\) \/ 60000\) - 2;/.test(hyg),
    "L9: the SQL board clock is 60s with two epochs of life");
  assert(/merged := app\._prune_bazaar_bought\(merged, now_ms\);/.test(hyg),
    "L9: app_commit prunes, so the server copy shrinks too (it force-restores the key)");
  assert(ctx.BAZAARCFG.slowRotationMs === 86400000 && ctx.BAZAARCFG.yardRotationMs === 300000
      && Bazaar.boardEpochMs === 60000,
    "L9: the client clocks the SQL hard-codes are unchanged");

  // (b) a finished thread kept a full METRICS baseline forever.
  const storySrc = src("story.js");
  assert(/p\.status = "done";\s*\n\s*delete p\.base;/.test(storySrc),
    "L9: _advance drops the delta baseline when a thread finishes");
  assert(/if \(p && p\.status !== "active"\) delete p\.base;/.test(src("main.js")),
    "L9: migrate sheds the baselines already sitting in old saves");

  // (c) survey loot read exp.systemId; the field is sysId — salvage always
  //     landed at the current dock instead of the surveyed system.
  const surveySrc = src("survey-story.js");
  assert(!/exp\.systemId/.test(surveySrc), "L9: no exp.systemId reads left");
  assert((surveySrc.match(/\(exp && exp\.sysId\) \|\| this\.s\(\)\.currentSystem/g) || []).length === 2,
    "L9: gear and material salvage both park at the surveyed system");
  assert(/sysId/.test(src("expeditions.js")), "L9: expeditions still name the field sysId");
}

// ------------------------------------------------------------------- L10
// An admin SHIP_CATALOG / DANGER override can retire an id a live save still
// names. An unguarded deref threw through the whole render.
{
  const fleetSrc = src("fleet.js");
  assert(/\(\(this\.shipDef\(ship\.type\) \|\| \{\}\)\.price \|\| 2000\)/.test(fleetSrc),
    "L10: repairCost guards the catalog lookup");
  assert(/const slots = \(this\.shipDef\(sh\.type\) \|\| \{\}\)\.slots \|\| 2;/.test(fleetSrc),
    "L10: _equipLocal guards the slot lookup");
  // The mission / incident impound paths reach the catalog through impoundFine,
  // which already guards — assert that stays true rather than re-guarding it.
  assert(/impoundFine\(sh\) \{\s*\n\s*const price = \(this\.shipDef\(sh\.type\) \|\| \{\}\)\.price \|\| 0;/.test(fleetSrc),
    "L10: impoundFine (mission + incident impound) still guards");
  assert(/Fleet\.impoundFine\(sh\)/.test(src("missions.js")) && /Fleet\.impoundFine\(sh\)/.test(src("incidents.js")),
    "L10: mission and incident impound both go through it");

  const uiSrc = src("ui.js");
  assert(!/DANGER\.find\(d => d\.id === contract\.danger\);/.test(uiSrc),
    "L10: the mission modal's danger lookup has a fallback");
  assert(/DANGER\.find\(d => d\.id === contract\.danger\) \|\| DANGER\[0\];/.test(uiSrc),
    "L10: ...and it falls back to the first band");
  assert(/DANGER\.find\(d => d\.id === c\.danger\) \|\| DANGER\[0\];/.test(uiSrc),
    "L10: the contract card's danger lookup does too");

  // Drive it: a save naming a retired hull must not throw.
  const repairCost = (shipDef, ship, DMGCFG) => {
    const dmg = ship.dmg || 0;
    return dmg ? Math.max(50, Math.round(((shipDef(ship.type) || {}).price || 2000) * DMGCFG.costRate * dmg)) : 0;
  };
  let threw = null, cost = 0;
  try { cost = repairCost(() => undefined, { type: "retired_hull", dmg: 0.5 }, { costRate: 0.4 }); }
  catch (e) { threw = e; }
  assert(!threw, "L10: repairing a retired hull doesn't throw" + (threw ? " — " + threw.message : ""));
  assert(cost === 400, `L10: it falls back to the 2000c default hull price (got ${cost})`);
}

// ------------------------------------------------- SQL copies can't drift
// save_hygiene.sql re-declares three functions from earlier files. Assert each
// is byte-identical to its source apart from the lines this fix changes.
{
  const extract = (text, name) => {
    const re = new RegExp("create\\s+or\\s+replace\\s+function\\s+" +
      name.replace(/\./g, "\\.") + "\\b[\\s\\S]*?\\n\\$\\$;", "i");
    const m = text.match(re);
    return m ? m[0].split("\n") : null;
  };
  const PATCHES = [
    ["phase2_missions_bazaar.sql", "public.app_buy_accessory", 2],
    ["workshop_craft.sql", "public.app_craft_start", 2],
    ["crime_coefficient.sql", "public.app_commit", 0],
  ];
  const hyg = sql("save_hygiene.sql");
  for (const [file, name, replaced] of PATCHES) {
    const a = extract(sql(file), name), b = extract(hyg, name);
    if (!a || !b) { assert(false, `sync: ${name} found in both ${file} and save_hygiene.sql`); continue; }
    const aSet = new Set(a), bSet = new Set(b);
    const removed = a.filter(l => !bSet.has(l)).length;
    const added = b.filter(l => !aSet.has(l)).length;
    assert(removed === replaced,
      `sync: ${name} drops exactly ${replaced} source line(s) (got ${removed})`);
    assert(added <= replaced + 4,
      `sync: ${name} adds only the intended lines (got ${added})`);
  }
}

Promise.all(pending).then(() => {
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall low-priority checks passed");
});
