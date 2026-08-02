#!/usr/bin/env node
/* check_sql_patch_sync.js — market_commodities_expand.sql duplicates three
   functions from market_price.sql. Normalize whitespace/comments and assert
   the bodies match so the patch can't drift from the canonical copy.
   Run:  node tools/check_sql_patch_sync.js                                    */
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert");

const root = path.join(__dirname, "..");
const canonical = fs.readFileSync(path.join(root, "docs/sql/market_price.sql"), "utf8");
const patch = fs.readFileSync(path.join(root, "docs/sql/market_commodities_expand.sql"), "utf8");

const FNS = ["market.commodity", "market.event_slot", "market.event_slot_local"];

function extract(sql, name) {
  // Grab from `create or replace function <name>` through that function's `$$;`
  const esc = name.replace(/\./g, "\\.");
  const re = new RegExp(
    "create\\s+or\\s+replace\\s+function\\s+" + esc + "\\b[\\s\\S]*?\\$\\$;",
    "i"
  );
  const m = sql.match(re);
  assert.ok(m, `missing ${name}`);
  return m[0];
}

function normalize(body) {
  return body
    .replace(/--[^\n]*/g, "")          // strip SQL line comments
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

for (const name of FNS) {
  const a = normalize(extract(canonical, name));
  const b = normalize(extract(patch, name));
  assert.strictEqual(a, b,
    `${name} differs between market_price.sql and market_commodities_expand.sql`);
}

console.log(`check_sql_patch_sync: ${FNS.length} functions match ✔`);
