#!/usr/bin/env node
/* check_broadcast_pool.js — pool entries may be URL strings or {url,title,caption}.
   Run: node tools/check_broadcast_pool.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const ctx = vm.createContext({ console, Math });
ctx.window = ctx;
vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/data.js"), "utf8"), ctx, { filename: "data.js" });

const { ASSET, ASSET_OVERRIDES } = ctx;

ASSET_OVERRIDES["broadcast:tv_drama"] = [
  "https://example.com/a.gif",
  { url: "https://example.com/b.png", title: "LIVE", caption: "Custom line." },
];

const a = ASSET.broadcastEntry("tv_drama", "0");
const b = ASSET.broadcastEntry("tv_drama", "1");
assert.ok(a.url && b.url, "urls resolve");
assert.notStrictEqual(a.url, b.url, "salt picks different pool members");
const flavored = [a, b].find(e => e.title === "LIVE");
assert.ok(flavored && flavored.caption === "Custom line.", "object entries keep flavor");
assert.strictEqual(typeof ASSET.broadcast("tv_drama", "0"), "string", "broadcast() returns URL string");
assert.ok(ASSET.broadcast("tv_ads", "x").endsWith("tv_ads.png"), "empty pool → default PNG");

console.log("check_broadcast_pool: entry shape + salt pick ✔");
