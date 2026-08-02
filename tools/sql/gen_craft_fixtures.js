#!/usr/bin/env node
/* gen_craft_fixtures.js — print the server-side crafting fixtures (recipe table,
   blackbox table, hull table) for the CURRENT js/data.js.

   The generator is AdminUI.craftSQL() — the same code behind the admin console's
   🔧 Crafting → Server SQL tab — so what an admin pastes into Supabase after
   editing recipes and what lives in docs/sql/*.sql can't drift apart.

   Use:  node tools/sql/gen_craft_fixtures.js            # everything
         node tools/sql/gen_craft_fixtures.js recipe     # one function only
         node tools/sql/gen_craft_fixtures.js blackbox
         node tools/sql/gen_craft_fixtures.js ship
         node tools/sql/gen_craft_fixtures.js slots

   Paste the output over the matching function in docs/sql/workshop_craft.sql
   (recipe/blackbox), docs/sql/phase2_missions_bazaar.sql (ship) or
   docs/sql/equip_persist.sql (slots), then run `node tools/check_craft_parity.js`
   and `node tools/check_equip_persist.js` to confirm the SQL matches data.js. */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");

const root = path.join(__dirname, "..", "..");
const ctx = vm.createContext({ console, Math, Date, JSON, navigator: undefined });
ctx.window = ctx;
for (const f of ["store.js", "data.js", "admin-ui.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "js", f), "utf8"), ctx, { filename: f });
}

const sql = ctx.AdminUI.craftSQL();
const which = (process.argv[2] || "").toLowerCase();
if (!which) { process.stdout.write(sql); process.exit(0); }

// One function: from its `create or replace` line to the terminating `$$;`.
const names = { recipe: "app.craft_recipe", blackbox: "app.craft_blackbox",
                ship: "app.ship_def", slots: "app._ship_slots" };
const fn = names[which];
if (!fn) { console.error(`unknown section "${which}" (recipe | blackbox | ship)`); process.exit(1); }
const lines = sql.split("\n");
const start = lines.findIndex(l => l.startsWith(`create or replace function ${fn}(`));
const end = lines.indexOf("$$;", start);
if (start < 0 || end < 0) { console.error(`could not slice ${fn} out of the generated SQL`); process.exit(1); }
process.stdout.write(lines.slice(start, end + 1).join("\n") + "\n");
