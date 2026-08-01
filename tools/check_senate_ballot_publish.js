/* check_senate_ballot_publish.js — a passed player ballot must reach OTHER players.
   Ballots carry a fractional lean and a uuid author; world_senate_result was
   created with `lean int` and no author columns, so publishing a resolved ballot
   errored and was swallowed — the author saw it pass, nobody else did (clients
   never re-vote a shared bill, they wait on the published row).

   Covers: the published payload keeps the fractional lean + authorship, the
   "you" sentinel maps to the signed-in uuid, a non-uuid author is dropped rather
   than sent at a uuid column, the pre-migration schema still publishes via the
   column fallback, and applying a pre-migration result never wipes attribution
   a client already has. Loads the real senate/senateworld in a vm. No browser. */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const root = path.join(__dirname, "..");
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };

(async () => {

const ctx = { console, Math, Date, JSON, Object, Array, Number, String, Promise, RegExp,
  isNaN, parseInt, parseFloat, setInterval: () => 0, clearInterval() {} };
ctx.window = ctx;
ctx.matchMedia = () => ({ matches: false });
ctx.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
vm.createContext(ctx);
const load = f => vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx);
load("js/store.js");     // Util, Bus
load("js/data.js");      // CONFIG, FACTIONS, SENATECFG, …
load("js/flavor.js");    // SENATE_EDICTS, …

ctx.Game = { timeScale: 1, requestSave() {}, state: {
  credits: 1000, prestige: { tier: 0 },
  senate: { bills: [], nextVoteAt: 0, reps: {}, pending: null, cycle: 0, billSeq: 0, lastBillId: null, shared: true },
} };
ctx.Economy = { refreshNetWorth() {}, authoritative() { return false; } };
ctx.Rivals = { rank() { return 1; } };
load("js/senate.js");
load("js/senateworld.js");
const Senate = ctx.Senate, SenateWorld = ctx.SenateWorld;

const UID = "3f1c8a2e-5b4d-4c7a-9e10-2b6d8f4a1c33";
const now = Date.now();

// ---- fake Supabase: record upserts, optionally reject the ballot columns ----
let upserts = [];
let preMigration = false;      // true = schema without proposed_by/proposed_label
ctx.Cloud = {
  enabled: true,
  isAdmin: () => true,
  signedIn: () => true,
  user: () => ({ id: UID }),
  displayName: () => "Baron Test",
  client: {
    from(table) {
      return {
        upsert(row) {
          upserts.push({ table, row });
          if (preMigration && "proposed_by" in row)
            return Promise.resolve({ error: { message: 'column "proposed_by" of relation "world_senate_result" does not exist' } });
          return Promise.resolve({ error: null });
        },
      };
    },
  },
};

const ballot = over => Object.assign({
  id: "wb42", issue: "trade", type: "tariff", lean: 0.37,
  effect: { type: "tariff", cat: "mineral", tax: 0.08 },
  title: "Mineral Tariff", blurb: "A duty.", votes: "aanx",
  result: { aye: 2, nay: 1, abstain: 1, wAye: 5, wNay: 2 }, status: "passed",
  repealOf: null, votesAt: now, endsAt: now + 3 * 86400e3,
  proposedBy: UID, proposedLabel: "Baron Test",
}, over || {});

// ---- 1) the published row keeps the fractional lean + authorship ------------
upserts = [];
await SenateWorld.publishResult(ballot());
assert(upserts.length === 1 && upserts[0].table === "world_senate_result", "publishes one world_senate_result row");
let row = upserts[0].row;
assert(row.lean === 0.37, "fractional ballot lean survives the publish (needs `lean numeric`, not int)");
assert(row.proposed_by === UID, "ballot author is published so other clients can attribute it");
assert(row.proposed_label === "Baron Test", "ballot author label is published");
assert(row.status === "passed" && row.votes === "aanx", "the canonical tally is published verbatim");

// ---- 2) the local "you" sentinel maps to the signed-in uuid -----------------
upserts = [];
await SenateWorld.publishResult(ballot({ proposedBy: "you" }));
assert(upserts[0].row.proposed_by === UID, '"you" sentinel resolves to the signed-in uuid, not sent literally');

// ---- 3) a non-uuid author is dropped, never sent at a uuid column -----------
upserts = [];
await SenateWorld.publishResult(ballot({ proposedBy: "preview" }));
assert(upserts[0].row.proposed_by === null, "non-uuid author id is dropped (would error on a uuid column)");

// ---- 4) pre-migration schema still publishes, via the column fallback -------
preMigration = true;
upserts = [];
await SenateWorld.publishResult(ballot());
assert(upserts.length === 2, "a missing-column error retries once");
assert(!("proposed_by" in upserts[1].row) && !("proposed_label" in upserts[1].row),
  "retry drops the ballot columns so the outcome still reaches other players");
assert(upserts[1].row.status === "passed" && upserts[1].row.bill_id === "wb42",
  "the retried row still carries the actual outcome");
preMigration = false;

// ---- 5) applying a result carries authorship through to other clients -------
SenateWorld.applyResult({
  bill_id: "wb77", issue: "trade", type: "tariff", lean: 0.42,
  effect: { type: "tariff", cat: "gas", tax: 0.05 }, title: "Gas Tariff", blurb: "b",
  votes: "aan", result: { aye: 2, nay: 1, abstain: 0, wAye: 4, wNay: 2 }, status: "passed",
  repeal_of: null, votes_at: new Date(now).toISOString(), ends_at: null,
  proposed_by: UID, proposed_label: "Baron Test",
}, false);
let got = Senate.sen().bills.find(b => b.id === "wb77");
assert(got && got.status === "passed", "another player's client applies the published ballot outcome");
assert(got.proposedBy === UID && got.proposedLabel === "Baron Test",
  "the applied bill is attributed to its author on every client");

// ---- 6) a pre-migration result must NOT wipe attribution already held -------
// This client saw the upcoming ballot (so it knows the author), then receives a
// result row from a project whose table lacks the columns.
Senate.ingestSharedBill({
  id: "wb88", issue: "trade", type: "tariff", lean: 0.5,
  effect: { type: "tariff", cat: "tech", tax: 0.05 }, title: "Tech Tariff", blurb: "b",
  votesAt: now, endsAt: null, status: "upcoming",
  proposedBy: UID, proposedLabel: "Baron Test",
});
SenateWorld.applyResult({
  bill_id: "wb88", issue: "trade", type: "tariff", lean: 0.5,
  effect: { type: "tariff", cat: "tech", tax: 0.05 }, title: "Tech Tariff", blurb: "b",
  votes: "aan", result: { aye: 2, nay: 1, abstain: 0, wAye: 4, wNay: 2 }, status: "passed",
  repeal_of: null, votes_at: new Date(now).toISOString(), ends_at: null,
  // no proposed_by / proposed_label — pre-migration schema
}, false);
got = Senate.sen().bills.find(b => b.id === "wb88");
assert(got.status === "passed", "pre-migration result still applies");
assert(got.proposedBy === UID, "a result without author columns keeps the attribution the client already had");

console.log("All senate ballot-publish checks passed.");

})();
