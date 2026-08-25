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
function sqlChase(op, atk) {
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const law = clamp(+op.law || 0, 0, 1);
  const s = Market._fnv1a(["cosmocrat-market-v1", "police", op.id].join("|"));
  if (Market._u01(s, 0) >= clamp(0.9 * law, 0, 0.95)) return null;
  let waves = 0, destroyed = 0, caught = false, escaped = false, item = false, dmg = 0, crime = 0;
  for (let w = 0; w <= 2; w++) {
    const base = 1 + w * 4;
    waves++;
    const def = 700 * (1 + law * 1.4) * Math.pow(1.6, w);
    if (Market._u01(s, base) < clamp(atk / (atk + def), 0.02, 0.75)) {
      destroyed++; crime += 25;
      dmg += 0.06 + Market._u01(s, base + 1) * 0.10;
      if (!item && Market._u01(s, base + 2) < 0.2) item = true;
      continue;
    }
    if (Market._u01(s, base + 3) < clamp(def / (def + atk) * 1.1, 0.1, 0.92)) {
      caught = true; dmg += 0.06 + Market._u01(s, base + 1) * 0.10; break;
    }
    escaped = true; break;
  }
  if (!caught && !escaped) escaped = true;
  return { waves, destroyed, caught, escaped, item, dmg, crime };
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
    const op = { id: "pc" + i, law: ((i * 17) % 101) / 100 };
    const atk = [80, 240, 700, 1800, 3400][i % 5];
    const sq = sqlChase(op, atk);
    // The JS side, read through Police's own helpers so a config change moves both.
    const jsResp = Market._u01(Market._seed(["police", op.id]), 0)
      < Police.responseChance(Util.clamp(op.law, 0, 1));
    assert.strictEqual(!!sq, jsResp, `chase ${i}: same response gate`);
    if (!sq) continue;
    responses++;
    if (sq.caught) caughts++;
    kills += sq.destroyed;
    // Wave strength must match Police.pairScoreAt exactly.
    for (let w = 0; w < sq.waves; w++) {
      assert.ok(Math.abs(Police.pairScoreAt(op.law, w) - 700 * (1 + op.law * 1.4) * Math.pow(1.6, w)) < 1e-6,
        `chase ${i}: wave ${w} strength matches Police.pairScoreAt`);
    }
  }
  assert.ok(responses > 500 && caughts > 50 && kills > 50,
    `the sweep saw responses, catches and kills (${responses}/${caughts}/${kills})`);
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
  assert.strictEqual(POLICECFG.responseBase, 0.9, "responseBase");
  eqArr(POLICECFG.responseClamp, [0, 0.95], "responseClamp");
  has(/least\(greatest\(0\.9 \* law, 0\), 0\.95\)/, "SQL response gate matches responseBase/Clamp");
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
}
{
  // Crime + the police-only item
  assert.strictEqual(CRIMECFG.gain.piracy, 12, "gain.piracy");
  assert.strictEqual(CRIMECFG.gain.piracyFail, 6, "gain.piracyFail");
  assert.strictEqual(CRIMECFG.gain.toll, 4, "gain.toll");
  assert.strictEqual(CRIMECFG.gain.police, 25, "gain.police");
  has(/then 12 else 6 end/, "SQL charges piracy / piracyFail");
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
}

console.log("OK check_piracy_parity");
