#!/usr/bin/env node
/* check_craft_parity.js — docs/sql/workshop_craft.sql makes Workshop crafting
   server-authoritative, which means the recipe table now lives in TWO places.
   Duplicated data drifts, so this pins the SQL fixtures to js/data.js.

   Checked without a live Postgres:
   1) WIRING  — app_commit forces the workshop slice from the server row (the
      queue is the receipt that an item was paid for), the craft RPCs exist and
      are granted, and app_craft_adopt keeps its call/item budget.
   2) RECIPES — app.craft_recipe matches RECIPES exactly: ingredients, credits,
      craftMs, output, flavor, plus the destroyOnUse / auto-unlock tier that
      come from BLUEPRINTS.
   3) TABLES  — app.craft_blackbox vs BLACKBOX_EFFECTS, app.craft_scope_pool vs
      the non-craftOnly COMMODITIES per category, ACCESSORY_KINDS / RARITIES vs
      the gear roll in app.gen_craft_gear, and WORKSHOPCFG's slot numbers.

   Run:  node tools/check_craft_parity.js                                      */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const root = path.join(__dirname, "..");
const sql = fs.readFileSync(path.join(root, "docs/sql/workshop_craft.sql"), "utf8");

const ctx = vm.createContext({ console, Math, Date });
ctx.window = ctx;
for (const f of ["store.js", "data.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "js", f), "utf8"), ctx, { filename: f });
}
// vm objects carry the sandbox realm's prototypes, which deepStrictEqual counts
// as a difference — round-trip them into this realm before comparing.
const here = v => JSON.parse(JSON.stringify(v));
const { RECIPES, BLUEPRINTS, BLACKBOX_EFFECTS, COMMODITIES, WORKSHOPCFG,
        ACCESSORY_KINDS, RARITIES } = here({
  RECIPES: ctx.RECIPES, BLUEPRINTS: ctx.BLUEPRINTS, BLACKBOX_EFFECTS: ctx.BLACKBOX_EFFECTS,
  COMMODITIES: ctx.COMMODITIES, WORKSHOPCFG: ctx.WORKSHOPCFG,
  ACCESSORY_KINDS: ctx.ACCESSORY_KINDS, RARITIES: ctx.RARITIES,
});

const fn = name => {
  const m = new RegExp(`create or replace function ${name}\\b[\\s\\S]*?\\n\\$\\$;`).exec(sql);
  assert.ok(m, `${name} is defined`);
  return m[0];
};
const unquote = s => s.replace(/''/g, "'");

// ---- 1) wiring --------------------------------------------------------------
for (const rpc of ["app_craft_start", "app_craft_claim", "app_craft_slot", "app_craft_adopt"]) {
  assert.match(sql, new RegExp(`create or replace function public\\.${rpc}\\b`), `${rpc} is defined`);
  assert.match(sql, new RegExp(`grant execute on function public\\.${rpc}\\(`),
    `${rpc} is granted to authenticated`);
}
// The whole point: the client can no longer author the queue it gets paid for.
assert.match(fn("public\\.app_commit"),
  /jsonb_set\(merged, '\{workshop\}', coalesce\(server->'workshop'/,
  "app_commit forces the workshop slice from the server row");
// …and the item pool stays server-owned, which is what made crafted gear vanish.
assert.match(fn("public\\.app_commit"),
  /jsonb_set\(merged, '\{items\}', coalesce\(server->'items'/,
  "app_commit still owns the item pool");
// This file replaces app_commit, so it has to carry every earlier fix forward.
// equip_persist.sql is applied last today: forcing ships from the server row
// here would silently un-fix accessory persistence (see check_equip_persist.js).
assert.match(fn("public\\.app_commit"), /jsonb_set\(merged, '\{ships\}', app\._merge_ships\(/,
  "app_commit keeps the equip_persist ship-fitment merge");
assert.ok(!/jsonb_set\(merged, '\{ships\}', coalesce\(server->'ships'/.test(sql),
  "app_commit never force-overwrites ships from the server row");
// result_slice must hand the queue back or the client can never see its own job.
assert.match(fn("app\\.result_slice"), /'workshop', coalesce\(p_state->'workshop'/,
  "result_slice returns the workshop slice");

const adopt = fn("public\\.app_craft_adopt");
assert.match(adopt, /calls >= 3 or lifetime >= 12/, "adopt keeps a call/item budget");
assert.match(adopt, /app\.gen_craft_gear\(uid, uid, it->>'kind', it->>'rarity'\)/,
  "adopt re-rolls gear server-side instead of trusting client stats");
assert.ok(!/'value', \(it->>'value'\)/.test(adopt), "adopt never copies a client item value");

// ---- 2) recipe parity -------------------------------------------------------
const recipeFn = fn("app\\.craft_recipe");
// Each row is  ('<id>', jsonb_build_object( ... ))  — slice on the row starts.
const rows = {};
const starts = [...recipeFn.matchAll(/\n {4}\('([a-z_0-9]+)', jsonb_build_object\(/g)];
assert.ok(starts.length, "app.craft_recipe has fixture rows");
starts.forEach((m, i) => {
  const from = m.index;
  const to = i + 1 < starts.length ? starts[i + 1].index : recipeFn.length;
  rows[m[1]] = recipeFn.slice(from, to);
});

assert.deepStrictEqual(Object.keys(rows).sort(), RECIPES.map(r => r.id).sort(),
  "app.craft_recipe covers exactly the RECIPES ids");

const num = (block, key) => {
  const m = new RegExp(`'${key}', (-?\\d+)`).exec(block);
  return m ? +m[1] : null;
};
const json = (block, key) => {
  const m = new RegExp(`'${key}', '([\\s\\S]*?)'::jsonb`).exec(block);
  return m ? JSON.parse(m[1]) : null;
};
const bool = (block, key) => {
  const m = new RegExp(`'${key}', (true|false)`).exec(block);
  return m ? m[1] === "true" : null;
};

for (const r of RECIPES) {
  const b = rows[r.id];
  const where = `recipe ${r.id}`;
  assert.strictEqual(num(b, "craftMs"), r.craftMs, `${where}: craftMs`);
  assert.strictEqual(num(b, "credits"), r.credits || 0, `${where}: credits`);
  assert.deepStrictEqual(json(b, "ingredients"), r.ingredients || [], `${where}: ingredients`);
  assert.deepStrictEqual(json(b, "output"), r.output || {}, `${where}: output`);
  assert.deepStrictEqual(json(b, "flavor"), r.flavor || null, `${where}: flavor`);
  const nameM = /'name','([^']*(?:''[^']*)*)'/.exec(b);
  assert.ok(nameM && unquote(nameM[1]) === r.name, `${where}: name`);
  const outM = /'outputType','([a-z]+)'/.exec(b);
  assert.ok(outM && outM[1] === r.outputType, `${where}: outputType`);

  // destroyOnUse + auto-unlock tier live on BLUEPRINTS in js/data.js.
  const bp = BLUEPRINTS.find(x => x.recipeId === r.id);
  assert.ok(bp, `${where}: has a blueprint in js/data.js`);
  assert.strictEqual(bool(b, "destroyOnUse"), !!bp.destroyOnUse, `${where}: destroyOnUse`);
  const autoTier = bp.source === "auto" ? (bp.minBaronTier || 0) : null;
  assert.strictEqual(num(b, "autoTier"), autoTier, `${where}: autoTier`);
  if (autoTier === null) assert.match(b, /'autoTier', null/, `${where}: autoTier is null in SQL`);
}

// ---- 3) supporting tables ---------------------------------------------------
const bbFn = fn("app\\.craft_blackbox");
for (const e of BLACKBOX_EFFECTS) {
  const m = new RegExp(`'${e.id}',\\s*jsonb_build_object\\(([^\\n]*)\\)\\)`).exec(bbFn);
  assert.ok(m, `blackbox ${e.id} is in app.craft_blackbox`);
  const row = m[1];
  assert.strictEqual(+/'mag',(-?[\d.]+)/.exec(row)[1], e.mag, `blackbox ${e.id}: mag`);
  assert.strictEqual(+/'durationMs',(\d+)/.exec(row)[1], e.durationMs, `blackbox ${e.id}: durationMs`);
  assert.strictEqual(/'stat','([a-zA-Z]+)'/.exec(row)[1], e.stat, `blackbox ${e.id}: stat`);
  assert.strictEqual(unquote(/'name','([^']*(?:''[^']*)*)'/.exec(row)[1]), e.name, `blackbox ${e.id}: name`);
}
assert.strictEqual((bbFn.match(/^\s{4}\('/gm) || []).length, BLACKBOX_EFFECTS.length,
  "app.craft_blackbox has no extra effects");

// Specialized extractors roll a scope from the non-craftOnly commodities of the
// flavor's category — the pool must match COMMODITIES or scopes drift.
const poolFn = fn("app\\.craft_scope_pool");
const cats = [...new Set(COMMODITIES.map(c => c.cat))];
for (const cat of cats) {
  const m = new RegExp(`\\('${cat}',\\s*array\\[([^\\]]*)\\]\\)`).exec(poolFn);
  const want = COMMODITIES.filter(c => c.cat === cat && !c.craftOnly).map(c => c.id);
  if (!want.length) continue;
  assert.ok(m, `scope pool for ${cat} exists`);
  const got = m[1].split(",").map(s => s.trim().replace(/^'|'$/g, ""));
  assert.deepStrictEqual(got, want, `scope pool for ${cat} matches COMMODITIES`);
}

// Gear roll: kind order drives the bases/pcts/stats arrays by index, so a new
// accessory kind inserted mid-table would silently re-map every stat.
const gearFn = fn("app\\.gen_craft_gear");
const arr = name => {
  const m = new RegExp(`${name} [\\w ]+\\[\\] := array\\[([\\s\\S]*?)\\];`).exec(gearFn);
  assert.ok(m, `gen_craft_gear declares ${name}`);
  return m[1].split(",").map(s => s.trim().replace(/^'|'$/g, ""));
};
const kindIds = Object.keys(ACCESSORY_KINDS);
assert.deepStrictEqual(arr("kinds"), kindIds, "gen_craft_gear kinds match ACCESSORY_KINDS order");
assert.deepStrictEqual(arr("labels"), kindIds.map(k => ACCESSORY_KINDS[k].label),
  "gen_craft_gear labels match ACCESSORY_KINDS");
assert.deepStrictEqual(arr("stats"), kindIds.map(k => ACCESSORY_KINDS[k].stat),
  "gen_craft_gear stats match ACCESSORY_KINDS");
assert.deepStrictEqual(arr("bases").map(Number), kindIds.map(k => ACCESSORY_KINDS[k].base),
  "gen_craft_gear bases match ACCESSORY_KINDS");
assert.deepStrictEqual(arr("pcts"), kindIds.map(k => String(!!ACCESSORY_KINDS[k].pct)),
  "gen_craft_gear pcts match ACCESSORY_KINDS");
for (const r of RARITIES) {
  assert.match(gearFn, new RegExp(`when '${r.id}' then ${r.mult}\\b`),
    `gen_craft_gear uses the ${r.id} stat multiplier from RARITIES`);
}

// Slot math (WORKSHOPCFG) is inlined in the SQL for speed — pin the numbers.
assert.match(fn("app\\._craft_slots"),
  new RegExp(`least\\(${WORKSHOPCFG.maxSlots}, ${WORKSHOPCFG.baseSlots} \\+`),
  "app._craft_slots uses WORKSHOPCFG base/max slots");
assert.match(fn("app\\._craft_slot_cost"), new RegExp(`${WORKSHOPCFG.slotUpgradeBase} \\* power\\(1.65`),
  "app._craft_slot_cost uses WORKSHOPCFG.slotUpgradeBase");
assert.match(fn("public\\.app_craft_claim"), new RegExp(`n >= ${WORKSHOPCFG.maxResolvePerCatchup}\\b`),
  "app_craft_claim uses WORKSHOPCFG.maxResolvePerCatchup");
assert.match(adopt, new RegExp(`least\\(${WORKSHOPCFG.maxSlots - WORKSHOPCFG.baseSlots}, greatest\\(0`),
  "adopt caps slot upgrades at maxSlots - baseSlots");

console.log(`All craft-parity checks passed (${RECIPES.length} recipes, ${BLACKBOX_EFFECTS.length} blackboxes).`);
