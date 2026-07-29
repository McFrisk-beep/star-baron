/* check_username.js — letters-only + blocked-word filter for account handles. */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const root = path.join(__dirname, "..");
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };

const ctx = { console, Math, Date, JSON, Object, Array, Number, String, Boolean, RegExp };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, "js/username.js"), "utf8"), ctx);
const U = ctx.Username;

assert(U.validate("Raphael").ok, "plain latin name ok");
assert(U.validate("ab").ok === false, "too short rejected");
assert(U.validate("abcdefghijklmnopq").ok === false, "too long rejected");
assert(U.validate("Raphael2").ok === false, "digits rejected");
assert(U.validate("Raphael Smith").ok === false, "spaces rejected");
assert(U.validate("ラフ").ok === false, "non-latin rejected");
assert(U.validate("مرحبا").ok === false, "arabic rejected");
assert(U.validate("名字").ok === false, "cjk rejected");
assert(U.validate("fuck").ok === false, "blocked stem rejected");
assert(U.validate("fuuuck").ok === false, "repeated-letter workaround rejected");
assert(U.validate("phuck").ok === false, "letter workaround rejected");
assert(U.validate("asshole").ok === false, "compound slur rejected");
assert(U.validate("nigger").ok === false, "slur rejected");
assert(U.validate("").ok, "empty clears to default");
assert(U.defaultLabel(42) === "Baron #42", "default Baron #N");
assert(U.display(null, 7) === "Baron #7", "display falls back to Baron #N");
assert(U.display("Nyx", 7) === "Nyx", "display prefers custom username");

console.log("All username checks passed.");
