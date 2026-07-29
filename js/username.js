/* username.js — public account handle validation (A–Z only) + blocked-word
   filter. Server mirror: docs/sql/profile_username.sql (_username_blocked).
   Default display when unset: "Baron #<join_n>" (signup order).               */

const Username = {
  MIN: 3,
  MAX: 16,
  // Stems + letter-only workarounds. Matched as substrings against the lower
  // name and a collapsed-repeat form (fuuuck → fuck). Keep in sync with SQL.
  BLOCKED: [
    "fuck", "fuk", "fck", "fuc", "fvck", "phuck", "ffuck",
    "shit", "sht", "shyt",
    "cunt", "cnt",
    "asshole", "arsehole", "asshat",
    "bitch", "btch", "biatch",
    "bastard",
    "damn", "dammit",
    "dick", "dck",
    "cock", "cok",
    "pussy", "puss",
    "penis", "vagina", "vag",
    "whore", "slut", "slutty",
    "nigger", "nigga",
    "faggot", "fag", "fgt",
    "retard", "rtrd", "tard",
    "rape", "raper", "rapist",
    "nazi", "hitler", "holocaust",
    "kike", "spic", "chink", "gook", "tranny", "troon",
    "porn", "porno", "hentai", "nsfw",
    "kkk", "isis",
  ],

  // Collapse runs of the same letter so "fuuuck" still hits "fuck".
  norm(s) {
    return String(s || "").toLowerCase().replace(/(.)\1+/g, "$1");
  },

  isBlocked(name) {
    const raw = String(name || "").toLowerCase();
    const nrm = this.norm(raw);
    for (const w of this.BLOCKED) {
      if (raw.includes(w) || nrm.includes(w)) return true;
    }
    return false;
  },

  // { ok, msg, value } — value is trimmed letters-only candidate (or "" to clear).
  validate(raw, { allowEmpty = true } = {}) {
    const trimmed = String(raw == null ? "" : raw).trim();
    if (!trimmed) {
      if (allowEmpty) return { ok: true, value: "", msg: "" };
      return { ok: false, value: "", msg: "Enter a username." };
    }
    if (!/^[A-Za-z]+$/.test(trimmed)) {
      return { ok: false, value: trimmed, msg: "Letters only (A–Z) — no numbers, spaces, or other scripts." };
    }
    if (trimmed.length < this.MIN || trimmed.length > this.MAX) {
      return { ok: false, value: trimmed, msg: `Username must be ${this.MIN}–${this.MAX} letters.` };
    }
    if (this.isBlocked(trimmed)) {
      return { ok: false, value: trimmed, msg: "That username is not allowed." };
    }
    return { ok: true, value: trimmed, msg: "" };
  },

  defaultLabel(joinN) {
    const n = Number(joinN);
    if (Number.isFinite(n) && n > 0) return "Baron #" + Math.floor(n);
    return "Baron";
  },

  display(username, joinN) {
    const u = username && String(username).trim();
    if (u) return u;
    return this.defaultLabel(joinN);
  },
};

window.Username = Username;
