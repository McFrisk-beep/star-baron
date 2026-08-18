#!/usr/bin/env node
/* check_survey_custody.js — usage-sim review H5–H8: the survey seam.

   What this locks down:
     * H8 — a survey whose ship vanished (_lostContact) RESOLVES: the expedition
       leaves the list and the report files once, not once per loop tick.
     * H7 — a dropped app_survey_debrief packet queues the chosen outcome on
       st.surveyRetry (client-owned key) instead of deleting the expedition;
       the ship stays 'debrief', the thread isn't reopened, and retryPending
       re-files until the server answers (or reports the survey gone).
     * H6 — docs/sql/survey_custody.sql stamps 'surveying'/'debrief' on the
       server roster inside app_commit and releases orphaned survey statuses;
       client-side Expeditions.reconcileShips re-stamps after every slice.
     * H5 — soft/local purchases (blackbox / blueprint / dossier) refuse while
       Economy.busy(), and Game.pullCatchUp marks busy for the whole
       commit→pull round trip, so a stale pull can't refund a soft spend.

   Run:  node tools/check_survey_custody.js                                     */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");

// ---- 1) the SQL surface ----------------------------------------------------
{
  const sql = read("docs/sql/survey_custody.sql");
  assert.match(sql, /create or replace function app\._survey_custody/, "app._survey_custody is defined");
  assert.match(sql, /create or replace function public\.app_commit/, "app_commit is re-declared");
  assert.match(sql, /grant execute on function public\.app_commit\(jsonb\) to authenticated/, "app_commit granted");
  // The custody pass runs on the merged state, before the write.
  const call = sql.indexOf("app._survey_custody(merged)");
  const write = sql.indexOf("app._write_state(merged", call);
  assert.ok(call > -1 && write > call, "custody runs on merged state before app._write_state");
  // Extends the charter layer (fitment merge + workshop + charters intact).
  for (const token of ["app._merge_ships", "workshopAdopt", "{charters}", "app._merge_expeditions"]) {
    assert.ok(sql.includes(token), `app_commit still carries ${token}`);
  }
  // Only survey statuses are claimable/releasable — never mission/charter/impound.
  assert.match(sql, /status not in \('idle', 'surveying', 'debrief'\)/, "busy hulls can't be claimed");
  assert.match(sql, /in \('surveying', 'debrief'\) then\s*\n\s*sh := jsonb_set\(sh, '\{status\}', '"idle"'\)/,
    "orphaned survey statuses are released to idle");
  assert.match(sql, /\(sh->>'mercenary'\)::boolean/, "mercenary hulls can't be claimed");
  // Paste order documented.
  assert.ok(read("docs/PHASE3_SETUP.md").includes("survey_custody.sql"), "PHASE3_SETUP.md lists the file");
  console.log("ok: survey_custody.sql — custody pass declared, layered, granted");
}

// ---- 2) client harness (survey-story + expeditions) ------------------------
const ctx = vm.createContext({ console, Math, JSON, Object, Array, Number, Promise });
ctx.window = ctx;
ctx.Date = Date;
for (const f of ["store.js", "data.js", "story.js", "survey-story.js", "expeditions.js"])
  vm.runInContext(read("js/" + f), ctx, { filename: f });
const { Expeditions, SurveyStory, Story } = ctx;

const systems = {
  here: { id: "here", name: "Home", tradeable: true, pos: { x: 0.5, y: 0.5 } },
  out1: { id: "out1", name: "Verge", tradeable: false, pos: { x: 0.6, y: 0.5 } },
};
ctx.Galaxy = { get: id => systems[id], signatureCommodity: () => ({ id: "ore", name: "Ore", cat: "mineral" }) };
ctx.Fleet = {
  ship(uid) { return ctx.Game.state.ships.find(s => s.uid === uid); },
  stats(sh) { return { speed: 1, scan: sh.scan || 0, endure: sh.endure || 0 }; },
  mainBonus: () => 0,
};
ctx.Bus = { on() {}, emit() {} };
ctx.Rep = { factionForCategory: () => "mining_combine" };
ctx.Senate = { travelSpeedMult: () => 1, salvageBonusAdd: () => 0 };
ctx.Economy = {
  refreshNetWorth() {}, checkAchievements() {},
  busy: () => false,
  softIncomeLocal: () => false,   // Phase 3 live
};
ctx.Cloud = { authoritative: () => true, pullReady: true, pullMissing: false,
  _isMissingRpc: () => false, surveyDebrief: null };
ctx.Game = { timeScale: 1, state: null, requestSave() {} };

const freshState = () => ({
  seq: 1, credits: 1000, ships: [], reports: [], expeditions: [], surveyed: {},
  currentSystem: "here", items: {}, stats: { trades: 0, contractsDone: 0 },
  unlockedSystems: ["here"], industries: [],
  story: { prog: {}, inbox: [], unread: 0, lastArrivalAt: 0, flags: {}, ephemeral: {} },
});

(async () => {
  // ---- H8: lost contact resolves instead of looping ------------------------
  ctx.Game.state = freshState();
  let s = ctx.Game.state;
  s.expeditions.push({ id: "xp1", sysId: "out1", shipUid: "ghost", debrief: true,
    startedAt: 0, etaMs: 1, danger: 0.2, far: false });
  for (let i = 0; i < 5; i++) Expeditions.openPendingDebriefs(1000 + i);
  assert.strictEqual(s.reports.length, 1, "lost contact files ONE report across 5 ticks");
  assert.strictEqual(s.expeditions.length, 0, "lost-contact expedition leaves the list");
  assert.ok(s.surveyed.out1, "cooldown stamped");
  assert.strictEqual(Expeditions.canSurvey("out1", 1010).ok, false, "system on cooldown, not blocked forever");
  console.log("ok: H8 — _lostContact resolves the expedition, dedupes the report");

  // ---- H7: dropped debrief packet queues a retry, never bricks the hull ----
  ctx.Game.state = freshState(); s = ctx.Game.state;
  s.ships.push({ uid: "s1", name: "Scout", status: "debrief", scan: 1, endure: 1 });
  s.expeditions.push({ id: "xp2", sysId: "out1", shipUid: "s1", debrief: true,
    startedAt: 0, etaMs: 1, danger: 0.2, far: false });
  ctx.Cloud.surveyDebrief = async () => { throw new Error("network dropped"); };
  const msg = await SurveyStory._applyAuth({ expId: "xp2", outcome: "leave", tplId: "dry_chart" });
  assert.ok(/re-file/i.test(msg), "player told the debrief re-files");
  assert.strictEqual(s.expeditions.length, 1, "expedition KEPT (commit must not drop it server-side)");
  assert.strictEqual(s.ships[0].status, "debrief", "hull stays parked at debrief");
  assert.strictEqual((s.surveyRetry || []).length, 1, "outcome queued on st.surveyRetry");
  // The closed thread must not reopen while the retry is pending.
  assert.strictEqual(Expeditions.openPendingDebriefs(2000), 0, "no duplicate debrief thread");
  // Queueing twice doesn't duplicate.
  await SurveyStory._applyAuth({ expId: "xp2", outcome: "leave", tplId: "dry_chart" });
  assert.strictEqual(s.surveyRetry.length, 1, "retry queue dedupes by expId");

  // Retry succeeds → server slice applies, queue drains, hull released.
  ctx.Cloud.surveyDebrief = async (expId, outcome) => {
    assert.strictEqual(expId, "xp2"); assert.strictEqual(outcome, "leave");
    return { ok: true, credits: 1234, ships: [{ uid: "s1", name: "Scout", status: "idle" }],
      expeditions: [], surveyed: { out1: 3000 }, summary: "Survey filed." };
  };
  SurveyStory._retryAt = 0;
  await SurveyStory.retryPending(60000);
  assert.strictEqual(s.surveyRetry.length, 0, "retry queue drained on success");
  assert.strictEqual(s.credits, 1234, "server payout applied");
  assert.strictEqual(s.ships[0].status, "idle", "hull released by the server slice");
  assert.strictEqual(s.expeditions.length, 0, "expedition settled");

  // Dead answer ("Survey not found.") → drop the entry and release locally.
  ctx.Game.state = freshState(); s = ctx.Game.state;
  s.ships.push({ uid: "s2", name: "Scout II", status: "debrief" });
  s.expeditions.push({ id: "xp3", sysId: "out1", shipUid: "s2", debrief: true, startedAt: 0, etaMs: 1 });
  s.surveyRetry = [{ expId: "xp3", outcome: "leave", tplId: "dry_chart" }];
  ctx.Cloud.surveyDebrief = async () => ({ ok: false, error: "Survey not found." });
  SurveyStory._retryAt = 0;
  await SurveyStory.retryPending(120000);
  assert.strictEqual(s.surveyRetry.length, 0, "dead debrief dropped from the queue");
  assert.strictEqual(s.ships[0].status, "idle", "hull released when the server says the survey is gone");
  assert.strictEqual(s.expeditions.length, 0, "expedition cleared");
  console.log("ok: H7 — dropped packet queues + re-files; dead answers release");

  // ---- H6 client: reconcileShips re-stamps after a slice -------------------
  ctx.Game.state = freshState(); s = ctx.Game.state;
  s.ships.push({ uid: "a", status: "idle" }, { uid: "b", status: "idle" }, { uid: "c", status: "mission" });
  s.expeditions.push(
    { id: "e1", sysId: "out1", shipUid: "a", startedAt: 0, etaMs: 9e9 },
    { id: "e2", sysId: "out1", shipUid: "b", debrief: true, startedAt: 0, etaMs: 1 },
    { id: "e3", sysId: "out1", shipUid: "c", startedAt: 0, etaMs: 9e9 });   // forged: hull on a mission
  Expeditions.reconcileShips();
  assert.strictEqual(s.ships[0].status, "surveying", "active survey re-stamped after slice");
  assert.strictEqual(s.ships[1].status, "debrief", "parked debrief re-stamped after slice");
  assert.strictEqual(s.ships[2].status, "mission", "mission hull never touched");
  console.log("ok: H6 — reconcileShips re-locks survey hulls, leaves busy hulls alone");

  // ---- H6 wiring: slices call the reconcile --------------------------------
  const eco = read("js/economy.js");
  assert.ok((eco.match(/Expeditions\.reconcileShips\(\)/g) || []).length >= 2,
    "economy.js reconciles expeditions in both slice appliers");

  // ---- H5: pullCatchUp holds busy; soft buys refuse while busy -------------
  const main = read("js/main.js");
  const pc = main.slice(main.indexOf("async pullCatchUp()"));
  assert.ok(pc.indexOf("Economy._pending++") > -1
    && pc.indexOf("Economy._pending++") < pc.indexOf("await Cloud.commit"),
    "pullCatchUp marks busy before the commit request");
  assert.match(pc, /finally \{\s*\n\s*Economy\._pending = Math\.max\(0, Economy\._pending - 1\);/,
    "pullCatchUp releases busy in finally");
  assert.ok(main.includes("SurveyStory.retryPending"), "main loop pumps queued debriefs");

  const bctx = vm.createContext({ console, Math, JSON, Object, Array, Number, Date });
  bctx.window = bctx;
  for (const f of ["store.js", "data.js", "content.js", "market.js", "items.js", "flavor.js", "extractors.js", "bazaar.js"])
    vm.runInContext(read("js/" + f), bctx, { filename: f });
  bctx.Game = { state: { seq: 1, credits: 99999, items: {}, bazaar: { blackboxes: [], blueprints: [], dossiers: [] }, inventory: { capacity: 6 } } };
  bctx.Economy = { authoritative: () => true, busy: () => true, refreshNetWorth() {} };
  bctx.Rep = { discount: () => 0 };
  for (const fn of ["buyBlackbox", "buyBlueprint", "buyDossier"]) {
    const r = bctx.Bazaar[fn]("any");
    assert.strictEqual(r.ok, false, `${fn} refuses while busy`);
    assert.match(r.msg, /Syncing/, `${fn} says why`);
  }
  console.log("ok: H5 — pull round trip holds busy; soft buys refuse in-flight");

  console.log("check_survey_custody: ok");
})().catch(e => { console.error(e); process.exit(1); });
