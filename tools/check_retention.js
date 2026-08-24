#!/usr/bin/env node
/* check_retention.js — the retention sweep's guardrails, as runnable regressions.

   docs/sql/retention.sql is the only thing in this project that deletes player
   data on a timer. The station ledgers double as CUSTODY records — a settled row
   is history, but an unsettled one is the sole server-side proof that a player is
   owed credits or has goods waiting. Prune the wrong predicate and the loss is
   silent and permanent, which is exactly the class of bug CLAUDE.md says laziness
   stops at. These lock the predicates down.

     R1  claimed-only for the two credit ledgers (payouts, bay tax)
     R2  station_listings prunes settled states only — never 'open'/'cancelled',
         which still hold the seller's item for app_station_settle()
     R3  station_hauls prunes terminal states only — never 'open'/'active'
     R4  the account reap is gated on app._abandoned, and _abandoned blocks on
         every way an account can still have something at stake
     R5  _abandoned fails closed and probes the station tables dynamically, so a
         project without them still gets its cron log pruned
     R6  players + saves share one window (no half-reap resurrecting a legacy save)
     R7  retention_tick is not reachable by anon/authenticated

   Run: node tools/check_retention.js                                           */
"use strict";
const fs = require("fs");
const path = require("path");

const sql = fs.readFileSync(path.join(__dirname, "..", "docs", "sql", "retention.sql"), "utf8");
let failed = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); failed++; } else console.log("ok:", m); };

// Both app._abandoned and retention_tick carry a (table, predicate) list, and
// they mean opposite things — _abandoned's are reasons to KEEP an account, the
// sweep's are reasons to DELETE rows. Scope the lookup to the sweep so an
// assertion can never accidentally read the guard list and pass.
const SWEEP = sql.slice(sql.indexOf("function public.retention_tick"));
const GUARD = sql.slice(sql.indexOf("function app._abandoned"),
                        sql.indexOf("function public.retention_tick"));
const rule = (tbl) => {
  const i = SWEEP.indexOf(`'${tbl}',`);
  if (i < 0) return null;
  const open = SWEEP.indexOf("$p$", i);
  const close = SWEEP.indexOf("$p$", open + 3);
  return open < 0 || close < 0 ? null : SWEEP.slice(open + 3, close);
};

// ------------------------------------------------------- R1: credits owed
for (const tbl of ["public.station_payouts", "public.station_bay_tax"]) {
  const p = rule(tbl);
  assert(p, `R1 ${tbl} has a rule`);
  // An unclaimed row is money the player has not collected yet.
  assert(p && /claimed_at\s+is\s+not\s+null/.test(p), `R1 ${tbl} prunes claimed rows only`);
  assert(p && /interval\s+'\d+\s+days'/.test(p), `R1 ${tbl} is time-bounded`);
}

// ----------------------------------------------- R2: goods held in custody
{
  const p = rule("public.station_listings");
  assert(p, "R2 station_listings has a rule");
  const states = [...(p || "").matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  assert(states.length > 0 && states.every(s => ["sold", "reclaimed", "refunded"].includes(s)),
    `R2 station_listings prunes settled states only (found: ${states.join(",") || "none"})`);
  // docs/sql/hall_item_custody.sql:416 — settle() hands these back to the seller.
  for (const held of ["open", "cancelled"]) {
    assert(!states.includes(held), `R2 station_listings never prunes '${held}' (item still in custody)`);
  }
}

// -------------------------------------------------------- R3: work in flight
{
  const p = rule("public.station_hauls");
  assert(p, "R3 station_hauls has a rule");
  const states = [...(p || "").matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  assert(states.length > 0 && states.every(s => ["filled", "cancelled", "expired", "failed"].includes(s)),
    `R3 station_hauls prunes terminal states only (found: ${states.join(",") || "none"})`);
  for (const live of ["open", "active"]) {
    assert(!states.includes(live), `R3 station_hauls never prunes '${live}' (haul in flight)`);
  }
}

// ------------------------------------------------------ R4: the account reap
{
  for (const tbl of ["public.players", "public.saves"]) {
    const p = rule(tbl);
    assert(p && /app\._abandoned\(/.test(p), `R4 ${tbl} reap is gated on app._abandoned`);
  }
  const fn = GUARD;
  assert(/role\s*=\s*'admin'/.test(fn), "R4 _abandoned never reaps an admin");
  // Every blocker: something the returning player would rightly expect back.
  const blockers = {
    "public.stations": "owns a station",
    "public.station_payouts": "is owed credits",
    "public.station_bay_tax": "is owed bay tax",
    "public.station_listings": "has goods in custody",
    "public.station_hauls": "has a haul in flight",
    "public.station_auctions": "is high bidder",
  };
  for (const [tbl, why] of Object.entries(blockers)) {
    assert(fn.includes(`'${tbl}'`), `R4 _abandoned blocks when the account ${why} (${tbl})`);
  }
  assert(/status in \('open','cancelled'\)/.test(fn),
    "R4 _abandoned treats a 'cancelled' listing as custody, not history");
  assert(/claimed_at is null/.test(fn), "R4 _abandoned blocks on unclaimed credits");
}

// -------------------------------------------------- R5: fails closed / degrades
{
  const fn = GUARD;
  assert(/return false;/.test(fn) && fn.indexOf("return true;") > fn.lastIndexOf("return false;"),
    "R5 _abandoned returns true only after every blocker has passed");
  assert(/to_regclass\(b\.tbl\) is null then continue/.test(fn),
    "R5 _abandoned skips a station table that does not exist (rather than failing to parse)");
  assert(/to_regclass\(r\.tbl\) is null then continue/.test(sql),
    "R5 the sweep skips a missing target table instead of aborting");
}

// ------------------------------------------------------- R6: one window, both rows
{
  const win = (t) => (rule(t) || "").match(/interval\s+'(\d+\s+days)'/);
  const a = win("public.players"), b = win("public.saves");
  assert(a && b && a[1] === b[1],
    `R6 players and saves share one window (${a && a[1]} vs ${b && b[1]})`);
  // players is authoritative; saves is the legacy fallback js/cloud.js still reads.
  const ls = sql.slice(sql.indexOf("function app._last_seen"), sql.indexOf("function app._abandoned"));
  for (const t of ["public.players", "public.saves"]) {
    assert(ls.includes(t), `R6 _last_seen consults ${t} before calling an account cold`);
  }
}

// ------------------------------------------------------------- R7: not client-callable
{
  assert(/revoke execute on function public\.retention_tick\(boolean\) from public/.test(sql),
    "R7 retention_tick revoked from PUBLIC");
  assert(/revoke execute on function public\.retention_tick\(boolean\) from anon, authenticated/.test(sql),
    "R7 retention_tick revoked from anon + authenticated");
  assert(/p_dry_run boolean default false/.test(sql), "R7 the sweep has a dry run");
}

console.log(failed ? `\n${failed} FAILED` : "\nall retention guardrails hold");
process.exit(failed ? 1 : 0);
