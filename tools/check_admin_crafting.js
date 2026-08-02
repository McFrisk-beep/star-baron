#!/usr/bin/env node
/* check_admin_crafting.js — the admin console's 🔧 Crafting tab writes RECIPES /
   BLUEPRINTS / BLACKBOX_EFFECTS straight into the shared content table, i.e. into
   every player's game. So the three pure pieces behind it get a runnable check:

   1) ROUND-TRIP — loading a shipped recipe into the editor and saving it back
      unchanged must produce the identical recipe AND blueprint. If it doesn't,
      opening a recipe and pressing Save silently rewrites game data.
   2) VALIDATION — the editor is a trust boundary: bad ids, unknown commodities,
      dangling outputs and blueprint-id clashes must be refused, not saved.
   3) SQL — craftSQL() is what an admin pastes into Supabase, and what
      tools/sql/gen_craft_fixtures.js writes into docs/sql/*.sql. It must cover
      every recipe/blackbox/hull in the layout check_craft_parity.js reads.

   Run:  node tools/check_admin_crafting.js                                     */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const root = path.join(__dirname, "..");
const ctx = vm.createContext({ console, Math, Date, JSON });
ctx.window = ctx;
for (const f of ["store.js", "data.js", "admin-ui.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "js", f), "utf8"), ctx, { filename: f });
}
const A = ctx.AdminUI;
const here = v => JSON.parse(JSON.stringify(v));

// ---- 1) round-trip ----------------------------------------------------------
ctx.RECIPES.forEach((recipe, i) => {
  A.cIndex = i;
  A.cDraft = A._toRecipeDraft(recipe);
  const out = A._normalizeRecipe();
  assert.deepStrictEqual(here(out.recipe), here(recipe), `recipe ${recipe.id}: survives an edit-and-save round trip`);
  const bp = ctx.BLUEPRINTS.find(b => b.recipeId === recipe.id);
  assert.ok(bp, `recipe ${recipe.id}: has a blueprint`);
  // uses:Infinity doesn't survive JSON, so compare it separately from the rest.
  assert.strictEqual(out.blueprint.uses, bp.uses, `blueprint ${bp.id}: uses`);
  const strip = b => { const o = Object.assign({}, b); delete o.uses; return here(o); };
  assert.deepStrictEqual(strip(out.blueprint), strip(bp), `blueprint ${bp.id}: survives a round trip`);
  assert.strictEqual(A._validateCraft(out.recipe, out.blueprint), null, `recipe ${recipe.id}: validates`);
});

// ---- 2) validation ----------------------------------------------------------
const gearIdx = ctx.RECIPES.findIndex(r => r.outputType === "gear");
const draftFor = (i, mutate) => { A.cIndex = i; A.cDraft = A._toRecipeDraft(ctx.RECIPES[i]); mutate(A.cDraft); const o = A._normalizeRecipe(); return A._validateCraft(o.recipe, o.blueprint); };
const rejects = (label, i, mutate) => assert.ok(draftFor(i, mutate), `rejected: ${label}`);

rejects("id with punctuation", gearIdx, d => { d.id = "bad id!"; });
rejects("empty name", gearIdx, d => { d.name = "  "; });
rejects("no ingredients", gearIdx, d => { d.ingredients = []; });
rejects("unknown commodity", gearIdx, d => { d.ingredients = [{ id: "unobtanium", qty: 1 }]; });
rejects("unknown gear kind", gearIdx, d => { d.out.kind = "tractor_beam"; });
rejects("unknown rarity", gearIdx, d => { d.out.rarity = "mythic"; });
rejects("duplicate recipe id", gearIdx, d => { d.id = ctx.RECIPES[gearIdx + 1].id; });
rejects("blueprint id owned by another recipe", gearIdx, d => {
  d.bp.id = ctx.BLUEPRINTS.find(b => b.recipeId !== ctx.RECIPES[gearIdx].id).id;
});
const shipIdx = ctx.RECIPES.findIndex(r => r.outputType === "ship");
rejects("hull that isn't in SHIP_CATALOG", shipIdx, d => { d.out.shipType = "ghost_hull"; });
const boxIdx = ctx.RECIPES.findIndex(r => r.outputType === "blackbox");
rejects("blackbox effect that doesn't exist", boxIdx, d => { d.out.effectId = "nonesuch"; });
const exIdx = ctx.RECIPES.findIndex(r => r.outputType === "extractor" && (r.flavor || []).length);
rejects("specialized extractor with no flavor", exIdx, d => { d.flavor = []; });

// A brand-new recipe (cIndex -1) may reuse neither an existing recipe nor
// blueprint id, but a fresh one is fine.
A.cIndex = -1;
A.cDraft = A._toRecipeDraft(ctx.RECIPES[gearIdx]);
assert.ok(A._validateCraft(A._normalizeRecipe().recipe, A._normalizeRecipe().blueprint),
  "rejected: new recipe reusing an existing id");
A.cDraft.id = "gear_test_widget"; A.cDraft.bp.id = "";
const fresh = A._normalizeRecipe();
assert.strictEqual(A._validateCraft(fresh.recipe, fresh.blueprint), null, "a fresh id validates");
assert.strictEqual(fresh.blueprint.id, "bp_gear_test_widget", "blank blueprint id defaults to bp_<recipe id>");

// ---- 3) generated SQL -------------------------------------------------------
const sql = A.craftSQL();
for (const fn of ["app.craft_recipe", "app.craft_blackbox", "app.ship_def", "app._ship_slots"]) {
  assert.match(sql, new RegExp(`create or replace function ${fn.replace(".", "\\.")}\\(`), `craftSQL emits ${fn}`);
}
const recipeFn = /create or replace function app\.craft_recipe[\s\S]*?\n\$\$;/.exec(sql)[0];
const ids = [...recipeFn.matchAll(/\n {4}\('([a-z_0-9]+)', jsonb_build_object\(/g)].map(m => m[1]);
assert.deepStrictEqual(ids, here(ctx.RECIPES.map(r => r.id)),
  "craftSQL emits every recipe, in order, in the layout the parity check parses");
const bbFn = /create or replace function app\.craft_blackbox[\s\S]*?\n\$\$;/.exec(sql)[0];
assert.strictEqual((bbFn.match(/^ {4}\('/gm) || []).length, ctx.BLACKBOX_EFFECTS.length, "craftSQL emits one row per blackbox effect");
const shipFn = /create or replace function app\.ship_def[\s\S]*?\n\$\$;/.exec(sql)[0];
for (const s of ctx.ALL_SHIPS) assert.ok(shipFn.includes(`('${s.id}', '${s.cls}',`), `craftSQL emits hull ${s.id}`);
// Fitment table: every fleet hull, no mains (they never carry accessories).
const slotFn = /create or replace function app\._ship_slots[\s\S]*?\n\$\$;/.exec(sql)[0];
const mains = new Set(ctx.SHIP_CATALOG.main.map(s => s.id));
for (const s of ctx.ALL_SHIPS) {
  const row = `('${s.id}', ${s.slots || 2})`;
  if (mains.has(s.id)) assert.ok(!slotFn.includes(`('${s.id}',`), `craftSQL leaves flagship ${s.id} out of the slot table`);
  else assert.ok(slotFn.includes(row), `craftSQL emits slots for ${s.id}`);
}
// An apostrophe in a name has to survive into a SQL literal.
A.cDraft = null;
const quoted = A._sqs("Smuggler's Veil");
assert.strictEqual(quoted, "'Smuggler''s Veil'", "SQL literals escape apostrophes");
assert.ok(sql.includes("'Smuggler''s Veil'"), "the escaped name reaches the generated SQL");

console.log(`Admin crafting checks passed (${ctx.RECIPES.length} recipes round-tripped, `
  + `${ctx.BLACKBOX_EFFECTS.length} blackboxes, ${ctx.ALL_SHIPS.length} hulls in the SQL).`);
