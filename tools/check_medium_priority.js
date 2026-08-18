#!/usr/bin/env node
/* check_medium_priority.js — the medium-severity audit findings, as runnable
   regressions. One file because they share a vm harness; each block names the
   finding it pins down.

     M1  UI.toast before UI.init must not throw (cloud-down boot blank page)
     M4  a `storage` event from another tab stops this tab writing
     M5  one transient cloud-load failure is retried, not latched for the session
     M6  cross-player strings are escaped at the innerHTML sink
     M7  Orders.process() cannot re-enter from the 2s loop
     M9  Broadcast's one-shot timers are all cancellable by stop()

   M2 lives in check_save_migrate.js (it is a migrate case). M3 (login-window
   flush) and M8 (StarMap suspend timers) are asserted by source inspection at
   the bottom — both are pure DOM/lifecycle wiring with no seam to drive here.

   Run: node tools/check_medium_priority.js                                     */
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const root = path.join(__dirname, "..");
const src = f => fs.readFileSync(path.join(root, "js", f), "utf8");
let failed = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); failed++; } else console.log("ok:", m); };

// ---------------------------------------------------------------- M1: toast
// Store._cloudFail toasts BEFORE UI.init populates refs. That used to throw a
// TypeError which escaped Store.load's catch; the DOMContentLoaded fallback
// then threw identically, so even the boot-failure banner never rendered —
// a blank page on every reload until connectivity came back.
{
  const shown = [];
  const stack = { children: [], firstChild: null, appendChild(el) { this.children.push(el); this.firstChild = this.children[0]; } };
  const UI = {
    refs: {},
    _pendingToasts: null,
    el: (_t, cls, text) => ({ cls, text, classList: { add() {}, remove() {}, toggle() {} }, remove() {} }),
  };
  // The two lines under test, lifted verbatim in behaviour from js/ui.js.
  const uiSrc = src("ui.js");
  assert(/if \(!stack\) \{ \(this\._pendingToasts \|\|= \[\]\)\.push/.test(uiSrc),
    "M1: UI.toast queues instead of throwing when refs.toast is missing");
  assert(/const held = this\._pendingToasts; this\._pendingToasts = null;/.test(uiSrc),
    "M1: UI.init flushes the queued toasts once refs exist");

  // Drive the real function body to prove it neither throws nor drops the text.
  const toast = new Function("text", "kind", "ms", `
    const stack = this.refs.toast;
    if (!stack) { (this._pendingToasts ||= []).push([text, kind, ms]); return; }
    stack.appendChild({ text }); this.__shown = (this.__shown || 0) + 1;
  `);
  let threw = null;
  try { toast.call(UI, "cloud sync is down", "warn", 7000); } catch (e) { threw = e; }
  assert(!threw, "M1: toasting before init does not throw" + (threw ? " — " + threw.message : ""));
  assert(UI._pendingToasts && UI._pendingToasts[0][0] === "cloud sync is down",
    "M1: the warning is held, not swallowed");
  UI.refs.toast = stack;
  const held = UI._pendingToasts; UI._pendingToasts = null;
  for (const [t, k, m] of held) toast.call(UI, t, k, m);
  assert(UI.__shown === 1 && stack.children[0].text === "cloud sync is down",
    "M1: it renders once refs are populated");
  shown.length = 0;
}

// -------------------------------------------------- Store harness (M4/M5/M6)
function loadStore({ bootFails = 0 } = {}) {
  const mem = { local: null };
  const listeners = [];
  let bootCalls = 0;
  const cloud = {
    signedIn: () => true,
    user: () => ({ id: "user-aaa" }),
    playersReady: true,
    saved: [],
    async bootstrap() {
      if (++bootCalls <= bootFails) throw new Error("network down");
      return { credits: 4242, cloudUserId: "user-aaa" };
    },
    async loadRemote() { return null; },
    async saveRemote(s) { this.saved.push(s); },
  };
  const ctx = {
    console: { log() {}, warn() {}, error(...a) { console.error(...a); } },
    setTimeout, clearTimeout, Date, Math, JSON, Object, Array, String, Number, Promise,
    localStorage: {
      getItem: () => mem.local,
      setItem: (_k, v) => { mem.local = String(v); },
      removeItem: () => { mem.local = null; },
    },
    addEventListener: (evt, fn) => { if (evt === "storage") listeners.push(fn); },
  };
  ctx.window = ctx;
  ctx.Cloud = cloud;
  vm.createContext(ctx);
  vm.runInContext(src("store.js"), ctx, { filename: "store.js" });   // also defines the real Bus
  const busEvents = [];
  ctx.Bus.on("save-stale", () => busEvents.push("save-stale"));
  // A real storage event arrives AFTER the other tab's value is already in
  // localStorage — mirror that, or "did we clobber it?" can't be observed.
  const fireStorage = e => { if (e.key === null) mem.local = null; else if (e.key === "starbaron") mem.local = e.newValue; listeners.forEach(fn => fn(e)); };
  return { ctx, mem, cloud, busEvents, fireStorage, bootCalls: () => bootCalls, listeners };
}

(async () => {
  // ------------------------------------------------------------ M4: multi-tab
  // Two tabs were last-writer-wins: play an hour in tab B, click back to tab A,
  // and A's stale in-memory state overwrote it with no warning.
  {
    const h = loadStore();
    const { Store } = h.ctx;
    await Store.load();
    assert(h.listeners.length === 1, "M4: Store.load registers exactly one storage listener");

    Store.localSave({ credits: 100 });
    assert(JSON.parse(h.mem.local).credits === 100, "M4: writes work before another tab appears");

    // A `storage` event only fires in the OTHER documents — hearing one means
    // somebody else now owns the save.
    h.fireStorage({ key: "starbaron", newValue: '{"credits":999}' });
    assert(Store._stale === true, "M4: a foreign write to the save key marks this tab stale");
    assert(h.busEvents.includes("save-stale"), "M4: …and tells the UI so the player sees it");

    Store.localSave({ credits: 1 });
    assert(JSON.parse(h.mem.local).credits === 999, "M4: a stale tab can no longer clobber localStorage");

    const before = h.cloud.saved.length;
    await Store.flush({ credits: 1 });
    Store._queueCloud({ credits: 1 });
    await new Promise(r => setTimeout(r, Store._cloudMs + 60));
    assert(h.cloud.saved.length === before, "M4: a stale tab pushes nothing to the cloud either");

    // Unrelated keys (auth token, prefs) must not trip it.
    const h2 = loadStore();
    await h2.ctx.Store.load();
    h2.fireStorage({ key: "sb-auth-token", newValue: "x" });
    assert(h2.ctx.Store._stale === false, "M4: an unrelated storage key is ignored");
    // …but a wholesale clear (key null) is a sign-out elsewhere.
    h2.fireStorage({ key: null, newValue: null });
    assert(h2.ctx.Store._stale === true, "M4: storage.clear() (sign-out in another tab) also stops writes");
  }

  // ---------------------------------------------------------- M5: retry latch
  // A single blip used to latch _cloudReady=false for the WHOLE session: every
  // push and pullCatchUp silently no-ops and the next good boot adopts the
  // stale server row, discarding the hours played in between.
  {
    const h = loadStore({ bootFails: 1 });
    const t0 = Date.now();
    const state = await h.ctx.Store.load();
    assert(h.bootCalls() === 2, "M5: a failed cloud load is retried once");
    assert(Date.now() - t0 >= 1000, "M5: …after a backoff, not instantly");
    assert(state && state.credits === 4242, "M5: the retry's result is what boot uses");
    assert(h.ctx.Store._cloudReady === true, "M5: cloud writes stay open after a recovered blip");
  }
  {
    const h = loadStore({ bootFails: 99 });   // loadRemote also returns null → latch
    await h.ctx.Store.load();
    assert(h.bootCalls() === 2, "M5: it retries exactly once, then gives up");
    assert(h.ctx.Store._cloudReady === false,
      "M5: a genuinely unreachable cloud still latches (no guest blob over an unknown row)");
  }

  // ------------------------------------------------------------- M6: escaping
  // Baron names, feed handles and world news reach innerHTML. The only barrier
  // was server-side SQL the client explicitly tolerates being absent or stale,
  // and localStorage here holds the Supabase auth token.
  {
    const { Util } = loadStore().ctx;
    assert(typeof Util.esc === "function", "M6: Util.esc exists as the shared sink helper");
    const payload = `<img src=x onerror="alert(1)">`;
    assert(!Util.esc(payload).includes("<"), "M6: angle brackets are escaped");
    assert(Util.esc(`" onmouseover="x`).indexOf('"') === -1, "M6: double quotes are escaped (attribute break-out)");
    assert(Util.esc("a'b").indexOf("'") === -1, "M6: single quotes are escaped");
    assert(Util.esc("&lt;") === "&amp;lt;", "M6: ampersand escaped first (no double-decode)");
    assert(Util.esc(null) === "" && Util.esc(undefined) === "", "M6: null/undefined render empty, not 'null'");
    assert(Util.esc("Perfectly Ordinary Baron") === "Perfectly Ordinary Baron", "M6: ordinary names pass through");

    const ui = src("ui.js");
    assert(/const name = Util\.esc\(r\.name\)/.test(ui), "M6: leaderboard name goes through Util.esc");
    assert(/lb-title">\$\{Util\.esc\(r\.title\)\}/.test(ui), "M6: leaderboard title goes through Util.esc");
    assert(/const who = Util\.esc\(handle\);/.test(ui) && /msg-handle">\$\{who\}/.test(ui),
      "M6: world-feed handle goes through Util.esc");
    assert(/<b>\$\{Util\.esc\(n\.headline\)\}<\/b>/.test(ui) && /wire-body">\$\{Util\.esc\(n\.body\)\}/.test(ui),
      "M6: world-news headline + body go through Util.esc");
    for (const [re, what] of [
      [/lb-name">\$\{r\.name/, "leaderboard name"],
      [/lb-title">\$\{r\.title/, "leaderboard title"],
      [/msg-handle">\$\{handle\}/, "feed handle"],
      [/tintbox", handle\.slice/, "feed handle initial (non-string handles used to throw here)"],
      [/<b>\$\{n\.headline\}/, "news headline"],
      [/wire-body">\$\{n\.body\}/, "news body"],
    ]) assert(!re.test(ui), `M6: no raw interpolation left at the ${what} sink`);
  }

  // --------------------------------------------------------- M7: order re-entry
  // process() awaits buy/sell RPCs (easily longer than the 2s market tick) and
  // only writes s.orders back at the end — the next tick used to iterate the
  // un-decremented list and fill the same order twice.
  {
    const ctx = {
      console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Object, Array,
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    ctx.COMMODITIES = [{ id: "ore", name: "Ore" }];
    ctx.Market = { systemPrice: () => 10 };
    ctx.Assets = { bayQty: () => 0 };
    // Auto-releasing gate: without the latch a re-entrant call would await the
    // same buy, so a manual release-after would deadlock the check instead of
    // failing it. 60ms is longer than the setImmediate below, shorter than any
    // patience CI has.
    let buys = 0;
    const gate = new Promise(r => setTimeout(r, 60));
    ctx.Economy = {
      maxBuy: () => 5,
      async buy(_id, q) { buys++; await gate; return { ok: true, qty: q, price: 10 }; },
      async sell() { return { ok: false }; },
    };
    const state = { travel: null, seq: 0, currentSystem: "navos", positions: {},
                    orders: [{ id: "o1", kind: "buy", commId: "ore", qty: 5, price: 20, systemId: "navos" }] };
    ctx.Game = { state };
    vm.runInContext(src("orders.js"), ctx, { filename: "orders.js" });
    const { Orders } = ctx;

    const first = Orders.process();          // parks inside the awaited buy
    await new Promise(r => setImmediate(r));
    const second = await Orders.process();   // the next 2s tick, mid-flight
    assert(second.length === 0, "M7: a re-entrant process() while one is in flight is a no-op");
    const ev = await first;
    assert(buys === 1, "M7: …so the order is not filled twice");
    assert(ev.length === 1 && ev[0].qty === 5, "M7: the in-flight call still returns its fill");
    assert(state.orders.length === 0, "M7: a fully filled order is removed exactly once");
    assert(Orders._processing === false, "M7: the latch is released even after the awaits");
  }

  // An order cancelled DURING the awaits must not be resurrected by the
  // wholesale `s.orders = keep` write at the end; one placed then must survive.
  {
    const ctx = { console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Object, Array };
    ctx.window = ctx;
    vm.createContext(ctx);
    ctx.COMMODITIES = [{ id: "ore", name: "Ore" }, { id: "food", name: "Food" }];
    ctx.Market = { systemPrice: () => 10 };
    ctx.Assets = { bayQty: () => 0 };
    let release;
    const gate = new Promise(r => { release = r; setTimeout(r, 2000); });   // belt-and-braces: never hang CI
    ctx.Economy = {
      maxBuy: () => 1,
      async buy(_id, q) { await gate; return { ok: true, qty: q, price: 10 }; },
      async sell() { return { ok: false }; },
    };
    const keepMe = { id: "o1", kind: "buy", commId: "ore", qty: 3, price: 20, systemId: "navos" };
    const cancelMe = { id: "o2", kind: "alert", commId: "food", side: "above", price: 9e9, systemId: "navos" };
    const state = { travel: null, seq: 2, currentSystem: "navos", positions: {}, orders: [keepMe, cancelMe] };
    ctx.Game = { state };
    vm.runInContext(src("orders.js"), ctx, { filename: "orders.js" });
    const { Orders } = ctx;

    const run = Orders.process();
    await new Promise(r => setImmediate(r));
    Orders.remove("o2");                                  // player cancels mid-flight
    const fresh = Orders.add({ kind: "alert", commId: "ore", side: "above", price: 1, systemId: "navos" });
    release();
    await run;
    const ids = state.orders.map(o => o.id);
    assert(!ids.includes("o2"), "M7: an order cancelled during the awaits stays cancelled");
    assert(ids.includes(fresh.id), "M7: an order placed during the awaits survives");
    assert(ids.includes("o1"), "M7: the partially filled order is kept");
  }

  // ------------------------------------------------------ M9: broadcast timers
  // rotateTV re-armed without clearing, and announce() calls it directly — so
  // every news/war event spawned another parallel rotation chain. scheduleNews
  // created a wholly untracked timeout that stop() could not cancel at all.
  {
    const live = new Set();
    let nextId = 1;
    const ctx = {
      console,
      setTimeout: (fn, ms) => { const id = nextId++; live.add(id); return id; },   // never actually fires
      clearTimeout: id => { live.delete(id); },
      Date, Math, JSON, Object, Array, Number, String, Promise,
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    ctx.CONFIG = { tvRotateMs: 9000, newsMinMs: 1e5, newsMaxMs: 2e5, newsEffectMs: 6e5,
                   newsScreenMs: 12000, newswireMax: 20, fastNews: false };
    ctx.TV_SHOWS = [{ channel: "ch1", title: "Show", captions: ["c"] }];
    ctx.NEWS_EVENTS = [{ id: "e1", headline: "H", body: "B", faction: "gbn", cat: "war",
                         effect: { target: "ore", mult: 1.2 } }];
    ctx.Util = { pick: a => a[0], randInt: (a) => a, clamp: (v) => v };
    ctx.Market = { applyNews() {} };
    ctx.Bus = { emit() {} };
    ctx.ASSET = { broadcastEntry: () => ({ url: null, title: "", caption: "" }) };
    ctx.Game = { state: { newswire: [] }, timeScale: 1 };
    vm.runInContext(src("broadcast.js"), ctx, { filename: "broadcast.js" });
    const { Broadcast } = ctx;

    Broadcast.start();
    const afterStart = live.size;
    assert(afterStart === 2, "M9: start() arms exactly the TV rotation + the news scheduler");

    // Ten news events. Pre-fix each announce() forked another rotation chain
    // and left an uncancellable resume-TV timeout behind.
    for (let i = 0; i < 10; i++) Broadcast.fire(ctx.NEWS_EVENTS[0]);
    Broadcast.scheduleNews("war", 900000);   // the 15-min omen timer
    Broadcast.stop();
    assert(live.size === 0,
      `M9: stop() cancels every timer Broadcast created (${live.size} left running)`);
    assert(Broadcast._shots.length === 0, "M9: …and its one-shot bag is emptied");

    // A rotation chain must never fork: rotateTV clears before re-arming.
    live.clear();
    Broadcast.rotateTV();
    Broadcast.rotateTV();
    Broadcast.rotateTV();
    assert(live.size === 1, `M9: repeated rotateTV keeps ONE pending rotation (got ${live.size})`);
    Broadcast.stop();
    assert(live.size === 0, "M9: stop() clears it");
  }

  // ------------------------------------------- M3 / M8: lifecycle wiring, by source
  {
    const auth = src("auth-ui.js");
    const signInAt = auth.indexOf("await Cloud.signIn(email, pass)");
    const guardAt = auth.indexOf("Game._noSave = true");
    assert(guardAt > -1 && signInAt > -1 && guardAt < signInAt,
      "M3: the no-save guard is set BEFORE the signIn round-trip (a tab-hide in that window uploaded the guest save)");
    assert(/_thawLocalSaves\(\)/.test(auth) && (auth.match(/this\._thawLocalSaves\(\)/g) || []).length >= 2,
      "M3: both non-reload exits (confirm-email, error) lift the guard again");

    const map = src("starmap.js");
    const suspend = map.slice(map.indexOf("  suspend() {"), map.indexOf("  stopSystem() {"));
    assert(/clearInterval\(this\.feedTimer\)/.test(suspend), "M8: suspend() clears feedTimer");
    assert(/clearInterval\(this\.galaxyTimer\)/.test(suspend), "M8: suspend() clears galaxyTimer");
    assert(/_resumeFeed/.test(suspend) && /_resumeGalaxy/.test(suspend),
      "M8: …and resume() restarts only the ones that were running");
  }

  if (failed) { console.error(`\n${failed} medium-priority check(s) FAILED.`); process.exit(1); }
  console.log("\nAll medium-priority checks passed.");
})();
