#!/usr/bin/env node
/* check_piracy_parity.js — docs/sql/piracy_rpcs.sql vs js/piracy.js + js/police.js.
   The SQL resolves intercepts server-side for signed-in barons; the JS does it
   for guests and for the live tab. If the two disagree, a player's loot, their
   crime record and whether the police caught them change depending on whether
   they were logged in — so this file pins them together two ways:

     1. A JS MIRROR of the SQL's arithmetic (the trick check_mining_parity.js
        uses) run against the real js/piracy.js and js/police.js rolls over
        thousands of ops.
     2. A STATIC read of the .sql text, asserting every constant baked into it
        still matches the PIRACYCFG / POLICECFG / CRIMECFG value it mirrors,
        and that the three copied wrappers still carry every line of the
        mining_rpcs.sql bodies they extend.

   (2) is the one that catches the realistic failure: somebody retunes a number
   in js/data.js and never opens the SQL. Run: node tools/check_piracy_parity.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const root = path.join(__dirname, "..");
const SQL = fs.readFileSync(path.join(root, "docs/sql/piracy_rpcs.sql"), "utf8");
const MINING = fs.readFileSync(path.join(root, "docs/sql/mining_rpcs.sql"), "utf8");

const ctx = vm.createContext({ console, Math, Date });
ctx.window = ctx;
for (const f of ["store.js", "data.js", "flavor.js", "market.js", "galaxy.js", "lanes.js",
  "security.js", "pois.js", "stock.js", "stations.js", "reputation.js", "crime.js",
  "fleet.js", "charters.js", "voyage.js", "raiders.js", "traffic.js", "items.js",
  "combat.js", "piracy.js", "police.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "js", f), "utf8"), ctx, { filename: f });
}
ctx.Market.init();
ctx.Game = { state: { settings: {}, seq: 1, ships: [], items: {}, reputation: {} } };
const { Market, Piracy, Police, PIRACYCFG, POLICECFG, CRIMECFG, POLICE_ITEM, Util } = ctx;

{
  // PL/pgSQL reads an IF condition by scanning for the terminating THEN at
  // paren depth zero — it does not know a bare CASE opens a THEN of its own.
  // `if x > (case when a then b else c end) then` compiles; the same line
  // without the parens fails with "syntax error at end of input", and only
  // when the migration is APPLIED. Nothing else here compiles SQL, so this
  // catches it in the check instead of in a deploy.
  const lines = SQL.split("\n");
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(els)?if\b/i.test(lines[i])) continue;
    let cond = "";
    for (let j = i; j < lines.length && j < i + 10; j++) cond += " " + lines[j];
    // Walk the tokens in order: the condition ends at the FIRST `then` at
    // paren depth zero (that is exactly how the PL/pgSQL scanner reads it —
    // it does not know CASE). A bare `case` seen BEFORE that point means the
    // case's own THEN will terminate the condition early: the bug. A `case`
    // after it (in the branch body) is fine.
    let depth = 0;
    for (const m of cond.matchAll(/[()]|\bcase\b|\bthen\b/gi)) {
      const t = m[0].toLowerCase();
      if (t === "(") depth++;
      else if (t === ")") depth--;
      else if (depth > 0) continue;
      else if (t === "then") break;                     // condition closed cleanly
      else { bad.push(`${i + 1}: ${lines[i].trim().slice(0, 60)}`); break; }
    }
  }
  assert.strictEqual(bad.length, 0,
    `bare CASE inside an IF condition (parenthesise it, or the function will not compile):\n  ${bad.join("\n  ")}`);
}

// ---- 1a. the mirror: app._piracy_outcome, transcribed ----------------------
// Keep this identical to the SQL body. It is deliberately a separate
// transcription rather than a call into Piracy — a bug copied into both would
// defeat the point.
function sqlOutcome(op) {
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const s = Market._fnv1a(["cosmocrat-market-v1", "piracy", op.id].join("|"));
  const chance = clamp(+op.chance || 0, 0.05, 0.9);
  const val = Math.max(+op.value || 0, 0);
  const cargo = Math.max(+op.cargo || 0, 0);
  if (op.verb === "escort")
    return { won: true, credits: Math.round((0.10 + Market._u01(s, 1) * 0.06) * val), dmg: 0, loot: null };
  if (!(Market._u01(s, 0) < chance))
    return { won: false, credits: 0, dmg: 0.04 + Market._u01(s, 1) * 0.08, loot: null };
  if (op.verb === "toll")
    return { won: true, credits: Math.round((0.16 + Market._u01(s, 1) * 0.14) * val), dmg: 0, loot: null };
  const lo = op.kind === "freighter" ? 10 : 4, hi = op.kind === "freighter" ? 22 : 10;
  const loot = {};
  let total = 0;
  op.manifest.forEach((cid, i) => {
    const q = Math.max(1, Math.round(lo + Market._u01(s, 2 + i) * (hi - lo)));
    loot[cid] = (loot[cid] || 0) + q; total += q;
  });
  if (cargo > 0 && total > cargo) {
    const k = cargo / total;
    for (const id of Object.keys(loot)) loot[id] = Math.max(1, Math.floor(loot[id] * k));
  }
  return { won: true, credits: 0, dmg: 0, loot };
}

// ---- 1b. the mirror: app._police_chase, transcribed ------------------------
// Mirror of app._patrols_in — the presence gate both the chase and the
// band-manhunt read. Transcribed, like everything else here.
function sqlPatrolsIn(sys, law, t) {
  const s = Market._fnv1a(["cosmocrat-market-v1", "patrolN", sys || "", String(Math.floor(t / 1200000))].join("|"));
  const u = Market._u01(s, 0);
  if (law >= 0.62) return 1 + Math.floor(Market._u01(s, 1) * 3);
  if (law >= 0.42) return u < 0.5 ? 1 : 0;
  if (law >= 0.22) return u < 0.25 ? 1 : 0;
  return 0;
}

function sqlChase(op, atk) {
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const law = clamp(+op.law || 0, 0, 1);
  const pairs = sqlPatrolsIn(op.sysId, law, (+op.resolveAt || 0) + 30000);
  if (!pairs) return null;
  const s = Market._fnv1a(["cosmocrat-market-v1", "police", op.id].join("|"));
  let waves = 0, destroyed = 0, caught = false, escaped = false, item = false, dmg = 0, crime = 0;
  const waveList = [];
  for (let w = 0; w <= 2; w++) {
    const base = 1 + w * 4;
    waves++;
    const def = 700 * (1 + law * 1.4) * Math.pow(1.6, w);
    if (Market._u01(s, base) < clamp(atk / (atk + def), 0.02, 0.75)) {
      destroyed++; crime += 25;
      const wDmg = 0.06 + Market._u01(s, base + 1) * 0.10;
      dmg += wDmg;
      if (!item && Market._u01(s, base + 2) < 0.2) item = true;
      waveList.push({ destroyed: true, dmg: wDmg });
      continue;
    }
    if (Market._u01(s, base + 3) < clamp(def / (def + atk) * 1.1, 0.1, 0.92)) {
      caught = true;
      const wDmg = 0.06 + Market._u01(s, base + 1) * 0.10;
      dmg += wDmg;
      waveList.push({ caught: true, dmg: wDmg });
      break;
    }
    escaped = true; waveList.push({}); break;
  }
  if (!caught && !escaped) escaped = true;
  return { waves, destroyed, caught, escaped, item, dmg, crime, waveList, pairs };
}

// ---- 1c. the mirror: app._police_manhunt, transcribed ----------------------
function sqlManhunt(op, atk, crime) {
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const law = clamp(op.law != null ? +op.law : 0.5, 0, 1);
  let chance;
  if (crime >= 300) {
    const over = Math.max(crime - 300, 0);
    chance = clamp(0.45 * (1 + over / 100 * 0.25), 0, 0.9);
  } else if (crime >= 100 && law >= 0.42) {
    if (!sqlPatrolsIn(op.sysId, law, +op.startedAt || 0)) return null;
    chance = 1;
  } else return null;
  const s = Market._fnv1a(["cosmocrat-market-v1", "manhunt", op.id].join("|"));
  if (Market._u01(s, 0) >= chance) return null;
  const def = 700 * (1 + law * 1.4);
  const broke = Market._u01(s, 1) < clamp(atk / (atk + def), 0.02, 0.75);
  return { broke, caught: !broke,
    dmg: broke ? 0.06 + Market._u01(s, 2) * 0.10 : 0,
    frac: 0.30 + Market._u01(s, 3) * 0.40 };
}

// ---- the sweep -------------------------------------------------------------
{
  const VERBS = ["rob", "toll", "escort"], KINDS = ["freighter", "trader"];
  const MAN = [["iron_ore"], ["iron_ore", "silicon"], ["silicon", "graphene_lattice", "iron_ore"]];
  let robs = 0, wins = 0;
  for (let i = 0; i < 3000; i++) {
    const op = { id: "pr" + i, verb: VERBS[i % 3], kind: KINDS[i % 2], manifest: MAN[i % 3],
      chance: 0.05 + ((i * 7) % 86) / 100, value: 1000 + i * 37,
      cargo: [0, 6, 14, 20, 400][i % 5], law: ((i * 13) % 101) / 100 };
    const js = Piracy.rollOutcome(op), sq = sqlOutcome(op);
    assert.strictEqual(js.won, sq.won, `outcome ${i}: same verdict`);
    assert.strictEqual(js.credits, sq.credits, `outcome ${i}: same credits`);
    assert.ok(Math.abs((js.dmg || 0) - sq.dmg) < 1e-9, `outcome ${i}: same damage`);
    assert.strictEqual(JSON.stringify(js.loot || null), JSON.stringify(sq.loot),
      `outcome ${i}: same loot`);
    if (op.verb === "rob") { robs++; if (js.won) wins++; }
  }
  assert.ok(robs > 900 && wins > 100, `the sweep actually exercised robbing (${wins}/${robs} won)`);
}
{
  let responses = 0, caughts = 0, kills = 0;
  for (let i = 0; i < 3000; i++) {
    const op = { id: "pc" + i, law: ((i * 17) % 101) / 100,
      sysId: "sys" + (i % 37), resolveAt: (i % 11) * 600000 };
    const atk = [80, 240, 700, 1800, 3400][i % 5];
    const sq = sqlChase(op, atk);
    // The gate is patrol PRESENCE now — read through Police's own helper so a
    // config change moves both sides.
    const jsResp = Police.patrolsIn(op.sysId, Util.clamp(op.law, 0, 1), op.resolveAt + 30000) > 0;
    assert.strictEqual(!!sq, jsResp, `chase ${i}: same presence gate`);
    if (sq) assert.strictEqual(sq.pairs,
      Police.patrolsIn(op.sysId, Util.clamp(op.law, 0, 1), op.resolveAt + 30000),
      `chase ${i}: same pair count`);
    if (!sq) continue;
    responses++;
    if (sq.caught) caughts++;
    kills += sq.destroyed;
    // Wave strength must match Police.pairScoreAt exactly.
    for (let w = 0; w < sq.waves; w++) {
      assert.ok(Math.abs(Police.pairScoreAt(op.law, w) - 700 * (1 + op.law * 1.4) * Math.pow(1.6, w)) < 1e-6,
        `chase ${i}: wave ${w} strength matches Police.pairScoreAt`);
    }
    // And the REAL client-side rolls (Police.chaseOutcome — what pursue and
    // the stage clock both read) must agree with the SQL wave for wave.
    const js = Police.chaseOutcome(op, atk);
    assert.ok(js, `chase ${i}: chaseOutcome forms when the SQL does`);
    assert.strictEqual(js.waves.length, sq.waves, `chase ${i}: same wave count`);
    assert.strictEqual(js.destroyed, sq.destroyed, `chase ${i}: same pairs broken`);
    assert.strictEqual(js.caught, sq.caught, `chase ${i}: same catch verdict`);
    assert.strictEqual(js.escaped, sq.escaped, `chase ${i}: same escape verdict`);
    for (let w = 0; w < sq.waves; w++) {
      assert.strictEqual(!!js.waves[w].destroyed, !!sq.waveList[w].destroyed, `chase ${i}w${w}: same wave verdict`);
      assert.strictEqual(!!js.waves[w].caught, !!sq.waveList[w].caught, `chase ${i}w${w}: same wave catch`);
      assert.ok(Math.abs((js.waves[w].dmg || 0) - (sq.waveList[w].dmg || 0)) < 1e-9,
        `chase ${i}w${w}: same wave damage`);
    }
    // The staged clock both sides derive from those waves — and a toll's
    // response arrives slower (arriveMs x tollArriveMult = 62500).
    assert.strictEqual(Police.chaseLenMs(js), 25000 + js.waves.length * 40000,
      `chase ${i}: chaseLenMs matches the SQL's arrive/waveGap arithmetic`);
    assert.strictEqual(Police.chaseLenMs(js, "toll"), 62500 + js.waves.length * 40000,
      `chase ${i}: a toll's chaseLenMs uses the slower arrive`);
  }
  assert.ok(responses > 500 && caughts > 50 && kills > 50,
    `the sweep saw responses, catches and kills (${responses}/${caughts}/${kills})`);
}

{
  // The manhunt: the JS rolls and the SQL mirror must agree wave for wave,
  // and the crime GATE must bite at exactly the criminal line.
  let hunts = 0, kills = 0, broke = 0, bandHunts = 0;
  for (let i = 0; i < 3000; i++) {
    const op = { id: "mh" + i, law: ((i * 23) % 101) / 100,
      sysId: "sys" + (i % 37), startedAt: (i % 11) * 600000 };
    const atk = [80, 240, 700, 1800, 3400][i % 5];
    const crime = [0, 100, 299, 300, 420, 900][i % 6];
    const js = Police.manhuntOutcome(op, atk, crime), sq = sqlManhunt(op, atk, crime);
    assert.strictEqual(!!js, !!sq, `manhunt ${i}: same gate`);
    if (crime < 100) assert.strictEqual(js, null, `manhunt ${i}: a clean-ish record is not hunted`);
    if (crime < 300 && op.law < 0.42) assert.strictEqual(js, null,
      `manhunt ${i}: below contested the law waits for the criminal line`);
    if (js && crime < 300) bandHunts++;
    if (!sq) continue;
    hunts++;
    if (sq.caught) kills++; else broke++;
    assert.strictEqual(js.broke, sq.broke, `manhunt ${i}: same verdict`);
    assert.strictEqual(js.caught, sq.caught, `manhunt ${i}: same catch`);
    assert.ok(Math.abs(js.dmg - sq.dmg) < 1e-9, `manhunt ${i}: same damage`);
    assert.ok(Math.abs(js.frac - sq.frac) < 1e-9, `manhunt ${i}: same contact point`);
    assert.ok(js.frac >= 0.30 && js.frac <= 0.70, `manhunt ${i}: contact inside the outbound leg`);
  }
  assert.ok(hunts > 300 && kills > 50 && broke > 50 && bandHunts > 50,
    `the sweep saw hunts, kills, breaks and BAND hunts (${hunts}/${kills}/${broke}/${bandHunts})`);
  // A heavier record is hunted harder.
  assert.ok(Police.manhuntChance(900) > Police.manhuntChance(300), "a worse record draws more hunts");
  assert.ok(Police.manhuntChance(1000) <= POLICECFG.manhuntClamp[1], "never a certainty");
}

// ---- 2. the static read: every constant still agrees -----------------------
const has = (re, why) => assert.ok(re.test(SQL), why);
const eqArr = (a, b, why) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), why);
{
  // PIRACYCFG
  eqArr(PIRACYCFG.chanceClamp, [0.05, 0.9], "chanceClamp is what the SQL clamps to");
  has(/least\(greatest\(coalesce\(\(p_op->>'chance'\)::float8, 0\), 0\.05\), 0\.9\)/, "SQL clamps chance to chanceClamp");
  eqArr(PIRACYCFG.escortPayFrac, [0.10, 0.16], "escortPayFrac");
  has(/0\.10 \+ market\.u01\(s, 1\) \* 0\.06/, "SQL escort fee matches escortPayFrac");
  eqArr(PIRACYCFG.tollFrac, [0.16, 0.30], "tollFrac");
  has(/0\.16 \+ market\.u01\(s, 1\) \* 0\.14/, "SQL toll cut matches tollFrac");
  eqArr(PIRACYCFG.atkDmg, [0.04, 0.12], "atkDmg");
  has(/0\.04 \+ market\.u01\(s, 1\) \* 0\.08/, "SQL failed-run damage matches atkDmg");
  eqArr(PIRACYCFG.lootQty.freighter, [10, 22], "lootQty.freighter");
  eqArr(PIRACYCFG.lootQty.trader, [4, 10], "lootQty.trader");
  has(/lo := 10; hi := 22; else lo := 4; hi := 10/, "SQL loot ranges match lootQty");
  assert.strictEqual(PIRACYCFG.maxOps, 2, "maxOps");
  has(/if op_n > 2 then continue/, "SQL drops ops past maxOps");
  has(/if n <= 2 then/, "…and the merge caps at maxOps too");
  assert.strictEqual(PIRACYCFG.hitTtlMs, 2 * 60 * 60 * 1000, "hitTtlMs");
  has(/2 \* 60 \* 60 \* 1000/, "SQL prunes hit marks on hitTtlMs");
  // rep swings
  eqArr(PIRACYCFG.rep.rob, [["free_trade", -3], ["syndicate", 2]], "rob standing");
  has(/'free_trade', -3[\s\S]{0,80}'syndicate', 2/, "SQL applies the rob standing swing");
  eqArr(PIRACYCFG.rep.escort, [["free_trade", 3]], "escort standing");
}
{
  // POLICECFG
  // Presence gate (the old 0.9xlaw response roll is gone).
  assert.strictEqual(POLICECFG.presenceSlotMs, 1200000, "presenceSlotMs");
  assert.strictEqual(POLICECFG.tollArriveMult, 2.5, "tollArriveMult (25000 x 2.5 = 62500 in SQL)");
  has(/'patrolN', coalesce\(p_sys, ''\),\n?\s*floor\(p_t \/ 1200000\.0\)::bigint::text/,
    "SQL presence seeds on (system, 20-min slot) like Police.patrolsIn");
  has(/if p_law >= 0\.62 then return 1 \+ floor\(market\.u01\(s, 1\) \* 3\)::int/,
    "SQL fields 1-3 pairs in guarded/policed space");
  has(/elsif p_law >= 0\.42 then return case when u < 0\.5 then 1 else 0 end/,
    "…one about half the time in contested");
  has(/elsif p_law >= 0\.22 then return case when u < 0\.25 then 1 else 0 end/,
    "…a quarter of the time on the frontier, none in lawless");
  has(/pairs := app\._patrols_in\(p_op->>'sysId', law,\n?\s*coalesce\(\(p_op->>'resolveAt'\)::float8, 0\) \+ 30000\.0\)/,
    "the chase gates on presence at the scene when the deed ends");
  has(/or \(op->>'verb' = 'toll' and \(outcome->>'won'\)::boolean\)/,
    "a won toll draws the chase too");
  has(/case when op->>'verb' = 'toll' then 62500\.0 else 25000\.0 end/,
    "…arriving slower than a distress call");
  has(/credits := credits - coalesce\(\(outcome->>'credits'\)::float8, 0\)/,
    "a caught toll forfeits the payment");
  has(/elsif p_crime >= 100 and law >= 0\.42 then/,
    "a Watchlisted baron is hunted in contested+ space");
  assert.strictEqual(POLICECFG.pairScore, 700, "pairScore");
  assert.strictEqual(POLICECFG.lawScore, 1.4, "lawScore");
  assert.strictEqual(POLICECFG.waveMult, 1.6, "waveMult");
  has(/700\.0 \* \(1 \+ law \* 1\.4\) \* power\(1\.6, w\)/, "SQL wave strength matches the config");
  assert.strictEqual(POLICECFG.maxWaves, 3, "maxWaves");
  has(/for w in 0\.\.2 loop/, "SQL runs maxWaves waves");
  eqArr(POLICECFG.destroyClamp, [0.02, 0.75], "destroyClamp");
  has(/0\.02\), 0\.75\)/, "SQL destroy odds match destroyClamp");
  assert.strictEqual(POLICECFG.catchMult, 1.1, "catchMult");
  eqArr(POLICECFG.catchClamp, [0.1, 0.92], "catchClamp");
  has(/\* 1\.1, 0\.1\), 0\.92\)/, "SQL catch odds match catchMult/catchClamp");
  eqArr(POLICECFG.chaseDmg, [0.06, 0.16], "chaseDmg");
  has(/0\.06 \+ market\.u01\(s, base \+ 1\) \* 0\.10/, "SQL chase damage matches chaseDmg");
  assert.strictEqual(POLICECFG.itemChance, 0.2, "itemChance");
  has(/market\.u01\(s, base \+ 2\) < 0\.2/, "SQL salvage roll matches itemChance");
  // The staged clock (docs/SPACE_INTERACTIVITY.md §5.2 built form).
  assert.strictEqual(PIRACYCFG.battleMs, 30000, "battleMs");
  has(/\+ 30000\.0/, "SQL settles battleMs after the intercept");
  assert.strictEqual(POLICECFG.arriveMs, 25000, "arriveMs");
  assert.strictEqual(POLICECFG.waveGapMs, 40000, "waveGapMs");
  has(/\(case when op->>'verb' = 'toll' then 62500\.0 else 25000\.0 end\)\n?\s*\+ coalesce\(jsonb_array_length\(chase->'waveList'\), 0\) \* 40000\.0/,
    "SQL settle waits the verb's arrive + waveGapMs per wave, like Piracy.settleAt");
  has(/returnAt'\)::float8, 0\) \+ 30000\.0/, "SQL lands returnAt + battleMs\u2026");
  has(/'\{chaseLenMs\}', to_jsonb\(/, "\u2026stamps the chase length on the op at settle\u2026");
  has(/\(op->>'chaseLenMs'\)::float8 else 0 end\)\n?\s*and coalesce\(\(op->>'resolved'\)/,
    "\u2026and adds it to the landing gate, so the run home departs after the duel (Piracy.landAt)");
  // The manhunt (CRIMECFG.criminal and above).
  assert.strictEqual(POLICECFG.manhuntBase, 0.45, "manhuntBase");
  assert.strictEqual(POLICECFG.manhuntPer100, 0.25, "manhuntPer100");
  eqArr(POLICECFG.manhuntClamp, [0, 0.9], "manhuntClamp");
  eqArr(POLICECFG.manhuntAt, [0.30, 0.70], "manhuntAt");
  assert.strictEqual(CRIMECFG.criminal, 300, "criminal — the manhunt line");
  has(/if p_crime >= 300 then/, "SQL hunts everywhere past the criminal line");
  has(/0\.45 \* \(1 \+ over \/ 100 \* 0\.25\), 0\), 0\.9\)/, "SQL manhunt odds match the config");
  has(/0\.30 \+ market\.u01\(s, 3\) \* 0\.40/, "SQL contact point matches manhuntAt");
  has(/'\{mh\}', 'true'::jsonb/, "SQL once-gates the manhunt on op.mh");
  has(/least\(40000\.0,\n?\s*greatest\(0, \(coalesce\(\(op->>'resolveAt'\)::float8, 0\) - mh_end\) \* 0\.9\)\)/,
    "SQL clamps the manhunt duel to the outbound leg, like Piracy.manhuntEndAt");
  has(/if ship_gone then continue; end if;/, "…and drops the op when the hull is taken");
  // Destruction on capture: the ship row is removed, not damaged.
  has(/where x\.value->>'uid' <> op->>'shipUid'/, "SQL removes a run-down hull from the fleet");
  has(/and not coalesce\(\(chase->>'caught'\)::boolean, false\)/, "…and skips its repair bill");
}
{
  // Crime + the police-only item
  assert.strictEqual(CRIMECFG.gain.piracy, 12, "gain.piracy");
  assert.strictEqual(CRIMECFG.gain.piracyFail, 6, "gain.piracyFail");
  assert.strictEqual(CRIMECFG.gain.toll, 4, "gain.toll");
  assert.strictEqual(CRIMECFG.gain.police, 25, "gain.police");
  has(/then 12 else 6 end/, "SQL charges piracy / piracyFail");
  assert.strictEqual(CRIMECFG.watch, 100, "watch — the robbery floor");
  has(/when crime < 100 then 100 else crime \+ gain end/,
    "SQL books a rob straight onto the watchlist, like Crime.bookRobbery");
  has(/'toll' then 4 else 0 end/, "SQL charges a toll");
  has(/crime \+ 25/, "SQL charges a destroyed patrol");
  assert.strictEqual(POLICE_ITEM.name, "Senate Enforcement Core", "the police item's name");
  assert.strictEqual(POLICE_ITEM.primary.amount, 0.45, "…its firepower bonus");
  assert.strictEqual(POLICE_ITEM.bonus.amount, 60, "…and its shield bonus");
  has(/'Senate Enforcement Core'/, "SQL mints the same item");
  has(/'amount', 0\.45/, "…with the same primary");
  has(/'amount', 60/, "…and the same bonus");
  // Items.value for that shape, hardcoded in SQL because the server has no
  // rarity table: 0.45 x 8000 x 30 (legendary price) x 1.4 (has a bonus).
  ctx.Game.state.seq = 1;
  const minted = { ...JSON.parse(JSON.stringify(POLICE_ITEM)), uid: "i1" };
  assert.strictEqual(ctx.Items.value(minted), 151200, "Items.value agrees with the SQL constant");
  has(/'value', 151200/, "SQL stamps that value");
}
{
  // The three copied wrappers must still carry every line of the bodies they
  // extend, or pasting this file last would silently roll back a protection.
  const grab = (src, head) => {
    const i = src.indexOf(head);
    assert.ok(i > 0, `found ${head}`);
    return src.slice(i, src.indexOf("\n$$;", i));
  };
  for (const head of ["create or replace function app.result_slice",
    "create or replace function public.app_commit",
    "create or replace function public.app_pull"]) {
    const mine = grab(SQL, head), theirs = grab(MINING, head);
    for (const line of theirs.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("--")) continue;
      assert.ok(mine.includes(t), `${head}: still carries mining's line \`${t.slice(0, 60)}\``);
    }
  }
  has(/app\._catchup_piracy\(st, now_ms::float8\)/, "app_pull runs the piracy catch-up");
  has(/'piracy', piracy/, "…and hands the away slice back");
  has(/app\._merge_piracy\(/, "app_commit merges piracy ops");
  has(/app\._merge_hot\(/, "…and the hot-cargo flags");
  has(/app\._piracy_report_push\(reports, rep_row\)/, "the resolver files rob + wave reports");
  has(/'hauler', jsonb_build_object\('name', op->>'name', 'kind', op->>'kind'\)/,
    "rob reports carry the hauler, so the movie fields the ship the chart drew");
  has(/'enemyCount', least\(8, 2 \* \(coalesce\(\(chase->>'pairs'\)::int, 1\) \+ w_i\)\)/,
    "wave reports field every pair on station plus the wave's reinforcement");
  has(/'wave', w_i,/, "…and carry the wave, so combat fields a uniform hull");
  has(/'\{reports\}', reports/, "…and writes them back onto the state");
}

console.log("OK check_piracy_parity");
