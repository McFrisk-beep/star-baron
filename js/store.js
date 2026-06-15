/* store.js — the ONLY thing that knows where saves live.
   Phase 1: localStorage. Phase 2: reimplement these same signatures against a
   backend (fetch + auth token). Nothing else in the codebase touches storage. */

const SAVE_KEY = "starbaron";

const Store = {
  async load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn("[Store] load failed:", e);
      return null;
    }
  },
  async save(state) {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.warn("[Store] save failed:", e);
      return false;
    }
  },
  async clear() {
    try {
      localStorage.removeItem(SAVE_KEY);
      return true;
    } catch (e) {
      console.warn("[Store] clear failed:", e);
      return false;
    }
  },
};

/* ---- tiny shared utilities + event bus (no framework) -------------------- */

const Util = {
  // Inclusive-ish random int in [min, max].
  randInt: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
  randFloat: (min, max) => Math.random() * (max - min) + min,
  pick: arr => arr[Math.floor(Math.random() * arr.length)],
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
