#!/usr/bin/env node
/* check_crime_coefficient.js — usage-sim review H9/H10/H11.

   What this locks down:
     * H9  — docs/sql/merc_expiry.sql prunes an expired IDLE mercenary inside
             app_commit (mirroring js/fleet.js pruneMercs) so the zombie stops
             resurrecting and eating a fleet-cap slot.
     * H10 — senate influence is priced, capped and recorded server-side, and
             the crime coefficient it feeds behaves: opens at 50, cools 1/day,
             watch at 100, barred at 200, Criminal at 300, caps at 1000.
             The client refuses the act at the same line and rolls a rejected
             push back.
     * H11 — the ballot RPCs lock the player row (and the docket) before
             debiting, and opening a station auction can't double-escrow.

   The live-Postgres half (real concurrency, real charges) is
   tools/sql/build_h9_h11_check.js — this is the part CI can run.

   Run:  node tools/check_crime_coefficient.js                                 */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");

// ===========================================================================
// 1) SQL surface
// ===========================================================================
{
  const merc = read("docs/sql/merc_expiry.sql");
  assert.match(merc, /create or replace function app\._prune_mercs/, "app._prune_mercs is defined");
  assert.match(merc, /create or replace function public\.app_commit/, "merc_expiry re-declares app_commit");
  assert.match(merc, /app\._prune_mercs\(merged, now_ms\)/, "app_commit runs the sweep");
  // The client rule, verbatim: mercenary AND idle AND expired. A merc still out
  // on a job keeps its contract until the hull is home.
  assert.match(merc, /coalesce\(\(sh->>'mercenary'\)::boolean, false\)/, "sweep tests the mercenary flag");
  assert.match(merc, /coalesce\(sh->>'status', 'idle'\) = 'idle'/, "sweep only releases idle hulls");
  assert.match(merc, /exp_ms <= p_now_ms/, "sweep only releases expired contracts");
  console.log("ok H9: merc_expiry.sql sweeps expired idle mercs inside app_commit");

  const crime = read("docs/sql/crime_coefficient.sql");
  for (const fn of ["app._crime_value", "app._crime_decay", "app._crime_add",
                    "app._influence_floor_cost", "app._influence_strength", "app._influence_min_tier"]) {
    assert.ok(crime.includes(`create or replace function ${fn}`), `${fn} is defined`);
  }
  assert.match(crime, /create or replace function public\.app_senate_influence/, "influence RPC re-declared");
  assert.match(crime, /grant execute on function public\.app_senate_influence\([^)]*\) to authenticated/, "granted");
  assert.match(crime, /revoke execute on function public\.app_senate_influence\([^)]*\) from anon/, "anon revoked");
  // The three layers of the fix.
  assert.match(crime, /cost := app\._influence_floor_cost\(act\)/, "the RPC prices the push");
  assert.match(crime, /if credits < cost then/, "…and refuses when the caller can't pay");
  assert.match(crime, /jsonb_set\(st, '\{credits\}', to_jsonb\(credits - cost\)\)/, "…and debits server-side");
  assert.match(crime, /max_targets := 1 \+ greatest\(0, tier\)/, "per-bill senator cap is 1 + tier");
  assert.match(crime, /tier < app\._influence_min_tier\(act\)/, "tier gates are enforced");
  assert.match(crime, /strength := app\._influence_strength\(/, "strength is computed, never trusted");
  assert.match(crime, /crime >= app\._crime_lockout\(\)/, "barred barons are refused");
  assert.match(crime, /app\._crime_add\(st, 20\)/, "coercion books +20");
  assert.match(crime, /app\._crime_add\(st, 6\)/, "bribery books +6");
  // …and app_commit owns the record.
  assert.match(crime, /merged := app\._crime_decay\(merged, now_ms\)/, "app_commit cools the record");
  assert.match(crime, /jsonb_set\(merged, '\{crime\}',\s*\n?\s*coalesce\(server->'crime'/, "app_commit forces crime from the server row");
  assert.ok(!/jsonb_set\(merged, '\{crime\}', p_state->'crime'\)/.test(crime), "a client crime value is never accepted");
  assert.match(crime, /'crime', app\._crime_value\(p_state\)/, "result_slice carries the record");
  console.log("ok H10: crime_coefficient.sql prices, caps and records senate influence");

  const ballot = read("docs/sql/senate_ballot.sql");
  assert.strictEqual((ballot.match(/from public\.players where user_id = uid for update/g) || []).length, 2,
    "both ballot RPCs lock the player row before debiting");
  assert.match(ballot, /pg_advisory_xact_lock\(hashtext\('cosmocrat:senate_ballot'\)\)/,
    "tabling serializes on the shared docket");
  assert.strictEqual((ballot.match(/'error', 'senate_locked'/g) || []).length, 2,
    "ballot and bump both refuse a barred baron");

  const auc = read("docs/sql/station_auctions.sql");
  assert.match(auc, /pg_advisory_xact_lock\(hashtext\('cosmocrat:station_auction:' \|\| p_system\)\)/,
    "auction opens serialize per station");
  assert.match(auc, /where public\.station_auctions\.status <> 'open';/,
    "the upsert can't overwrite a live auction");
  assert.match(auc, /if not found then\s*\n\s*pstate := jsonb_set\(pstate, '\{credits\}', to_jsonb\(credits \+ amt\)\)/,
    "a lost race refunds the escrow instead of eating it");
  assert.strictEqual((auc.match(/pg_advisory_xact_lock\(hashtext\('cosmocrat:station_auction:/g) || []).length, 2,
    "open and bid take the same station lock first (no open-vs-bid deadlock)");

  // The old, weak copy of the influence RPC must warn that it is superseded —
  // re-pasting security_hardening.sql after crime_coefficient.sql would undo H10.
  assert.match(read("docs/sql/security_hardening.sql"),
    /SUPERSEDED by docs\/sql\/crime_coefficient\.sql/,
    "security_hardening.sql warns that its app_senate_influence is superseded");
  console.log("ok H11: ballot rows lock before debiting; auction opens can't double-escrow");
}

// ===========================================================================
// 2) client ↔ SQL parity — the numbers must not drift apart
// ===========================================================================
const ctx = { console, Math, Date, JSON, Object, Array, Number, String, isNaN, parseInt, parseFloat };
ctx.window = ctx;
ctx.matchMedia = () => ({ matches: false });
ctx.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
vm.createContext(ctx);
const load = f => vm.runInContext(read(f), ctx, { filename: f });
load("js/store.js");     // Util, Bus
load("js/data.js");      // CRIMECFG, SENATECFG, CUSTOMS, …
load("js/flavor.js");
load("js/crime.js");
const { Crime, CRIMECFG } = ctx;

{
  const crime = read("docs/sql/crime_coefficient.sql");
  const sqlConst = (fn) => {
    const m = new RegExp(`create or replace function ${fn}\\(\\) returns numeric\\s*\\nlanguage sql immutable as \\$\\$ select (\\d+)`).exec(crime);
    assert.ok(m, `${fn} reads as a constant`);
    return +m[1];
  };
  assert.strictEqual(sqlConst("app\\._crime_start"), CRIMECFG.start, "start matches");
  assert.strictEqual(sqlConst("app\\._crime_max"), CRIMECFG.max, "cap matches");
  assert.strictEqual(sqlConst("app\\._crime_lockout"), CRIMECFG.lockout, "lockout matches");
  assert.strictEqual(sqlConst("app\\._crime_watch"), CRIMECFG.watch, "watch line matches");
  assert.ok(crime.includes(`app._crime_add(st, ${CRIMECFG.gain.coerce})`), "coercion gain matches CRIMECFG");
  assert.ok(crime.includes(`app._crime_add(st, ${CRIMECFG.gain.bribe})`), "bribery gain matches CRIMECFG");
  assert.strictEqual(CRIMECFG.gain.lobby, 0, "lobbying stays legal");
  assert.ok(crime.includes(`* ${CRIMECFG.coerceFailPer100}`), "coercion refusal slope matches CRIMECFG");
  assert.ok(crime.includes(`least(${CRIMECFG.coerceFailCap},`), "coercion refusal cap matches CRIMECFG");
  assert.ok(crime.includes("crime := greatest(0, crime - days);"),
    `SQL decay is ${CRIMECFG.decayPerDay}/day like CRIMECFG`);
  assert.strictEqual(CRIMECFG.decayPerDay, 1, "decay is 1/day on both sides");
  // Influence floor prices = SENATECFG base × the best relationship discount (0.4).
  const S = ctx.SENATECFG;
  for (const [kind, base] of [["lobby_fac", S.lobbyFacCost], ["bribe", S.bribeCostBase], ["coerce", S.scandalCostBase]]) {
    const m = new RegExp(`when '${kind}'\\s+then\\s+(\\d+)::bigint`).exec(crime);
    assert.ok(m, `${kind} has a floor price`);
    assert.strictEqual(+m[1], Math.round(base * 0.4), `${kind} floor is 40% of the SENATECFG base`);
  }
  console.log("ok: CRIMECFG and the SQL constants agree (start/cap/lines/gains/decay/prices)");
}

// ===========================================================================
// 3) the coefficient itself
// ===========================================================================
{
  const day = 24 * 60 * 60 * 1000;
  ctx.Game = { timeScale: 1, requestSave() {}, state: { crime: CRIMECFG.start, crimeSeenAt: Date.now() } };
  ctx.Economy = { softIncomeLocal: () => true, refreshNetWorth() {} };   // guest

  assert.strictEqual(Crime.value(), 50, "a new baron opens at 50");
  assert.strictEqual(Crime.tier().id, "clean", "…with a clean record");
  assert.ok(!Crime.watched() && !Crime.locked() && !Crime.isCriminal(), "…and no penalties");

  // Tampered saves are a trust boundary.
  for (const bad of [null, undefined, "0", NaN, -50, 99999, {}]) {
    const v = Crime.clamp(bad);
    assert.ok(v >= CRIMECFG.min && v <= CRIMECFG.max, `clamp(${JSON.stringify(bad)}) stays in range`);
  }
  assert.strictEqual(Crime.clamp(-50), 0, "a negative record clamps to 0");
  assert.strictEqual(Crime.clamp(99999), 1000, "the record caps at 1000");

  // Thresholds.
  Crime.set(99);  assert.ok(!Crime.watched() && !Crime.locked(), "99 is still clean");
  Crime.set(100); assert.ok(Crime.watched() && !Crime.locked(), "100 is watched, not barred");
  assert.strictEqual(Crime.tier().id, "watched", "100 → Watchlisted");
  Crime.set(199); assert.ok(!Crime.locked(), "199 still gets into the chamber");
  Crime.set(200); assert.ok(Crime.locked() && !Crime.isCriminal(), "200 bars you but isn't the label yet");
  assert.strictEqual(Crime.tier().id, "barred", "200 → Barred");
  Crime.set(300); assert.ok(Crime.isCriminal() && Crime.locked(), "300 is the Criminal label");
  assert.strictEqual(Crime.label(), "Criminal", "…and it reads 'Criminal'");

  // Coercion refusal ramps from the watch line.
  assert.strictEqual(Crime.coerceFailChance(100), 0, "no refusal risk at the watch line");
  assert.ok(Math.abs(Crime.coerceFailChance(200) - 0.35) < 1e-9, "+35% per 100 over the line");
  assert.strictEqual(Crime.coerceFailChance(50), 0, "a clean record is never refused");
  assert.ok(Crime.coerceFailChance(1000) <= CRIMECFG.coerceFailCap, "refusal is capped");

  // Customs scrutiny ramps the same way.
  assert.strictEqual(Crime.customsMult(50), 1, "clean records are searched normally");
  assert.strictEqual(Crime.customsMult(100), 1, "…and so are watch-line records");
  assert.ok(Math.abs(Crime.customsMult(200) - 1.25) < 1e-9, "+25% seizure odds per 100 over the line");
  assert.ok(Crime.customsMult(5000) <= CRIMECFG.customsMultCap, "the customs bump is capped");

  // Decay: whole days only, idempotent, floors at 0.
  const s = ctx.Game.state;
  s.crime = 60; s.crimeSeenAt = Date.now() - 3 * day - 1000;
  Crime.decay();
  assert.strictEqual(Crime.value(), 57, "three days cools the record by 3");
  Crime.decay(); Crime.decay();
  assert.strictEqual(Crime.value(), 57, "re-running the sweep changes nothing");
  s.crime = 2; s.crimeSeenAt = Date.now() - 30 * day;
  Crime.decay();
  assert.strictEqual(Crime.value(), 0, "the record floors at 0");
  s.crime = 60; s.crimeSeenAt = Date.now() + 5 * day;   // clock skew
  Crime.decay();
  assert.strictEqual(Crime.value(), 60, "a backwards clock doesn't hand out free decay");

  // Online the server owns the number: local decay must not fight it.
  ctx.Economy.softIncomeLocal = () => false;
  s.crime = 80; s.crimeSeenAt = Date.now() - 5 * day;
  Crime.decay();
  assert.strictEqual(Crime.value(), 80, "server-owned records aren't cooled locally");
  ctx.Economy.softIncomeLocal = () => true;

  assert.ok(Crime.lockNotice(250).startsWith("By order of "), "the lock notice names the authority");
  assert.ok(Crime.lockNotice(250).includes("250"), "…and the number");
  console.log("ok: the coefficient opens at 50, cools 1/day, and its lines hold");
}

// ===========================================================================
// 4) the Senate honours the same lines
// ===========================================================================
(async () => {
  ctx.Game.state = {
    credits: 5000000, crime: 50, crimeSeenAt: Date.now(),
    prestige: { tier: 3 }, reputation: {},
    senate: { bills: [], nextVoteAt: 0, reps: {}, pending: null, cycle: 0, billSeq: 0, lastBillId: null },
  };
  ctx.Economy = { refreshNetWorth() {}, authoritative: () => false, softIncomeLocal: () => true };
  ctx.Rivals = { rank: () => 1 };
  load("js/senate.js");
  const Senate = ctx.Senate;
  Senate.shared = false;
  // One bill on the floor, and a senator to lean on.
  Senate.tick(Date.now());
  const bill = Senate.nextBill();
  assert.ok(bill, "a bill reached the floor");
  Senate.byId = id => ({ id, name: "Senator " + id, weight: 1 });
  Senate.setWant("pass");

  // A clean record can work the chamber.
  let r = Senate.bribe("sen_a");
  assert.strictEqual(r.ok, true, "a clean baron can bribe");
  assert.strictEqual(Crime.value(), 56, "…and it goes on the record (+6)");
  r = Senate.scandal("sen_b");
  assert.strictEqual(r.ok, true, "a clean baron can coerce");
  assert.strictEqual(Crime.value(), 76, "…and coercion costs more record (+20)");

  // Barred: every act is refused, and nothing is charged.
  Crime.set(250);
  const creditsBefore = ctx.Game.state.credits;
  for (const [label, res] of [["lobby", Senate.lobby("free_trade")],
                              ["bribe", Senate.bribe("sen_c")],
                              ["coerce", Senate.scandal("sen_d")],
                              ["ballot", Senate.proposeBill("price_control|mineral", 1, 3)],
                              ["bump", Senate.bumpBill("whatever")]]) {
    assert.strictEqual(res.ok, false, `barred: ${label} is refused`);
    assert.match(res.msg, /[Bb]arred/, `barred: ${label} says why`);
  }
  assert.strictEqual(ctx.Game.state.credits, creditsBefore, "a barred baron is never charged");
  console.log("ok: at 200+ the client refuses every senate act and charges nothing");

  // Back under the line, coercion can still be refused by the senator — the
  // attempt costs, books the record, and burns the target slot without forcing
  // a vote (coerce[id] === 0).
  Crime.set(150);
  const realRandom = Math.random;
  ctx.Math.random = () => 0.0001;                     // force the refusal
  const before = ctx.Game.state.credits;
  r = Senate.scandal("sen_e");
  ctx.Math.random = realRandom;
  assert.strictEqual(r.ok, true, "a refused coercion still resolves");
  assert.strictEqual(r.refused, true, "…flagged as refused");
  assert.ok(ctx.Game.state.credits < before, "…and the money is gone");
  const pend = Senate.pending();
  assert.strictEqual(pend.coerce["sen_e"], 0, "…the slot is burned but no vote is forced");
  assert.ok("sen_e" in pend.coerce, "…so the senator can't be leaned on twice");
  console.log("ok: above the watch line a coercion can be refused (paid for, no forced vote)");

  // Shared mode: a server refusal rolls the whole push back.
  Senate.shared = true;
  Crime.set(50);
  ctx.Cloud = { signedIn: () => true };
  const stateBefore = { credits: ctx.Game.state.credits, crime: Crime.value() };
  ctx.SenateWorld = { submit: async () => ({ ok: false, error: "only 4 senator(s) per vote at your tier" }) };
  const p = Senate.bribe("sen_f");
  assert.ok(p && typeof p.then === "function", "shared influence returns the server's verdict");
  const out = await p;
  assert.strictEqual(out.ok, false, "a server refusal is surfaced");
  assert.match(out.msg, /only 4 senator/, "…with the server's reason");
  assert.strictEqual(ctx.Game.state.credits, stateBefore.credits, "…and the credits come back");
  assert.strictEqual(Crime.value(), stateBefore.crime, "…and the record is unchanged");
  assert.ok(!(("sen_f") in Senate.pending().pushSen), "…and the push is gone");

  // A server-side lockout answer reads as barred.
  ctx.SenateWorld = { submit: async () => ({ ok: false, error: "senate_locked", crime: 240 }) };
  const out2 = await Senate.bribe("sen_g");
  assert.strictEqual(out2.ok, false, "server lockout refuses");
  assert.match(out2.msg, /[Bb]arred.*240/, "…and names the coefficient");

  // The authoritative crime value from a successful push wins.
  ctx.SenateWorld = { submit: async () => ({ ok: true, refused: false, cost: 20000, crime: 123 }) };
  const out3 = await Senate.bribe("sen_h");
  assert.strictEqual(out3.ok, true, "a booked push succeeds");
  assert.strictEqual(Crime.value(), 123, "…and the server's record wins");
  console.log("ok: shared pushes roll back on refusal and adopt the server's record");

  console.log("check_crime_coefficient: ok");
})().catch(e => { console.error(e); process.exit(1); });
