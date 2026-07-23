/* store.js — the ONLY thing that knows where saves live. Local-first: every save
   is written to localStorage immediately (fast, offline-safe). When the player
   is signed in (see cloud.js), saves are ALSO pushed to the cloud on a debounce,
   and load() prefers the cloud copy. Nothing else in the codebase touches
   storage — it just calls load/save/clear.                                      */

const SAVE_KEY = "starbaron";

const Store = {
  _cloudTimer: null,
  _cloudMs: 5000,         // debounce window for cloud pushes (local is instant)
  // When signed in, refuse cloud writes until load() has successfully talked to
  // Supabase. Prevents a fresh defaultState (1,500c) from overwriting a good
  // cloud save during an offline / paused-project boot.
  _cloudReady: true,

  // ---- local (always available) -----------------------------------------
  localLoad() {
    try { const raw = localStorage.getItem(SAVE_KEY); return raw ? JSON.parse(raw) : null; }
    catch (e) { console.warn("[Store] local load failed:", e); return null; }
  },
  localSave(state) {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); return true; }
    catch (e) { console.warn("[Store] local save failed:", e); return false; }
  },
  localClear() {
    try { localStorage.removeItem(SAVE_KEY); return true; }
    catch (e) { console.warn("[Store] local clear failed:", e); return false; }
  },

  signedIn() { return !!(window.Cloud && Cloud.signedIn()); },
  _userId() { return (window.Cloud && Cloud.user() && Cloud.user().id) || null; },

  // Tag a save with the signed-in user so a post-logout guest cache can never
  // beat that user's cloud row on the next login (see load()).
  _stampOwner(state) {
    if (!state || typeof state !== "object") return state;
    const uid = this._userId();
    if (uid) state.cloudUserId = uid;
    else if ("cloudUserId" in state) delete state.cloudUserId;
    return state;
  },

  // Surface a persistent cloud failure once.
  _cloudFail(where, e) {
    console.warn(`[Store] cloud ${where} failed:`, e);
    if (this._cloudWarned) return;
    this._cloudWarned = true;
    const hint = (window.Cloud && Cloud.playersReady)
      ? "Cloud sync isn't working — check docs/PHASE1_SETUP.md."
      : "Cloud sync isn't working — has the 'saves' table been created? (docs/CLOUD_SETUP.md)";
    if (window.UI && UI.toast) UI.toast(hint, "warn", 7000);
  },

  // ---- public API (unchanged signatures) --------------------------------
  async load() {
    const local = this.localLoad();
    // Guests never touch the cloud. Signed-in players stay gated until we know
    // what the remote row looks like (or that it truly doesn't exist yet).
    this._cloudReady = !this.signedIn();
    if (this.signedIn()) {
      try {
        // Phase 1: authoritative players row via app_bootstrap.
        const boot = await Cloud.bootstrap();
        if (boot) {
          this._cloudReady = true;
          this.localSave(this._stampOwner(boot));
          console.log("[Store] loaded authoritative players state");
          return boot;
        }
        // Legacy saves path (Phase 1 SQL not applied yet).
        const remote = await Cloud.loadRemote();
        this._cloudReady = true;
        if (remote) {
          // Local is written on every change instantly; the cloud push is debounced,
          // so a quick refresh can leave the cloud STALER than local. Keep whichever
          // was saved more recently — but ONLY if local belongs to this account.
          // A guest game started after Sign out has a newer lastSeenAt and used to
          // win here, then autosave would upload 1,500c over the real cloud save.
          const uid = this._userId();
          const localMine = !!(local && uid && local.cloudUserId === uid);
          const lt = localMine ? (local.lastSeenAt || 0) : 0;
          const rt = (remote && remote.lastSeenAt) || 0;
          if (localMine && lt > rt) { console.log("[Store] local save newer than cloud — keeping local"); return local; }
          this.localSave(this._stampOwner(remote));
          console.log("[Store] loaded cloud save");
          return remote;
        }
        console.log("[Store] signed in, no cloud save yet — using local");
      } catch (e) {
        this._cloudFail("load", e);
        this._cloudReady = false;   // do NOT push a default/guest blob over unknown remote
      }
    }
    return local;
  },

  async save(state) {
    this._stampOwner(state);
    this.localSave(state);                          // always cache locally first
    if (this.signedIn()) this._queueCloud(state);   // …then sync to cloud (debounced)
    return true;
  },

  // Coalesce frequent autosaves into one cloud write every _cloudMs.
  _queueCloud(state) {
    if (!this._cloudReady) return;
    clearTimeout(this._cloudTimer);
    this._cloudTimer = setTimeout(() => {
      if (!this._cloudReady || !this.signedIn()) return;
      Cloud.saveRemote(state).then(() => console.log("[Store] cloud save synced")).catch(e => this._cloudFail("save", e));
    }, this._cloudMs);
  },

  // Push the latest state to the cloud right now (on logout / tab hide / unload).
  async flush(state) {
    clearTimeout(this._cloudTimer);
    if (!this.signedIn() || !this._cloudReady) return;
    try { if (state) { this._stampOwner(state); await Cloud.saveRemote(state); } }
    catch (e) { this._cloudFail("flush", e); }
  },

  async clear() {
    this.localClear();
    if (this.signedIn()) { try { await Cloud.clearRemote(); } catch (e) { console.warn("[Store] cloud clear failed:", e); } }
    return true;
  },
};

/* ---- tiny shared utilities + event bus (no framework) -------------------- */

const Util = {
  // Inclusive-ish random int in [min, max].
  randInt: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
  randFloat: (min, max) => Math.random() * (max - min) + min,
  pick: arr => arr[Math.floor(Math.random() * arr.length)],
  shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; },
  clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)),
  // Box-Muller normal(0, sd).
  gauss(sd) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sd;
  },
  // Compact credit formatting: 1.2K, 3.4M, 1.1B.
  credits(n) {
    const neg = n < 0;
    let a = Math.abs(n);
    let s;
    if (a >= 1e9) s = (a / 1e9).toFixed(2) + "B";
    else if (a >= 1e6) s = (a / 1e6).toFixed(2) + "M";
    else if (a >= 1e3) s = (a / 1e3).toFixed(1) + "K";
    else s = Math.round(a).toString();
    return (neg ? "-" : "") + s;
  },
  price(n) {
    return n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(n < 10 ? 2 : 1);
  },
  // Exact, grouped credits (e.g. 1,523,400) — for the HUD where precision matters.
  creditsFull(n) { return Math.round(n).toLocaleString(); },
  // ts → "just now" / "5 min ago" / "3 hr ago" / "2 days ago" / "4 months ago".
  ago(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 45) return "just now";
    const m = s / 60; if (m < 60) return `${Math.floor(m)} min ago`;
    const h = m / 60; if (h < 24) return `${Math.floor(h)} hr ago`;
    const d = h / 24; if (d < 30) { const n = Math.floor(d); return `${n} day${n > 1 ? "s" : ""} ago`; }
    const mo = d / 30; if (mo < 12) { const n = Math.floor(mo); return `${n} month${n > 1 ? "s" : ""} ago`; }
    const y = Math.floor(mo / 12); return `${y} yr${y > 1 ? "s" : ""} ago`;
  },

  // ms → "3m 12s" / "1h 04m".
  duration(ms) {
    if (ms <= 0) return "now";
    const s = Math.ceil(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
    return `${sec}s`;
  },
};

// Minimal pub/sub so modules stay decoupled (and Phase 2-portable).
const Bus = (() => {
  const handlers = {};
  return {
    on(evt, fn) { (handlers[evt] ||= []).push(fn); },
    emit(evt, payload) { (handlers[evt] || []).forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } }); },
  };
})();

window.Store = Store;
window.Util = Util;
window.Bus = Bus;
