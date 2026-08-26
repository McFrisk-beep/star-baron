/* crime.js — the crime coefficient: one number per baron for how much law they
   are carrying. Opens at 50, caps at 1000, cools by 1 a day.

   Today only the Senate reads it (bribery/coercion raise it; 200+ bars you from
   the chamber) plus a customs-scrutiny bump — the wider crime expansion hangs
   off the same number. Server-owned when docs/sql/crime_coefficient.sql is
   applied: app_senate_influence returns the authoritative value and app_commit
   forces it, so the client never gets to decide its own record.               */

const Crime = {
  s() { return window.Game && window.Game.state; },
  cfg() { return window.CRIMECFG || { start: 50, min: 0, max: 1000, watch: 100, lockout: 200, criminal: 300 }; },

  // Guests (and projects without the crime SQL) keep their own record; for
  // everyone else the server's value wins — mirrors Economy.softIncomeLocal().
  local() { return !(window.Economy && Economy.softIncomeLocal && !Economy.softIncomeLocal()); },

  clamp(v) {
    const c = this.cfg();
    const n = Number(v);
    return Util.clamp(Number.isFinite(n) ? n : c.start, c.min, c.max);
  },
  value() { const s = this.s(); return s ? this.clamp(s.crime) : this.cfg().start; },
  set(v) { const s = this.s(); if (s) s.crime = this.clamp(v); return this.value(); },
  // Local bookkeeping only — online, the RPC that authorised the act returns the
  // authoritative value and applyServer() overwrites this.
  add(n) { return this.set(this.value() + (Number(n) || 0)); },
  // Armed robbery puts you straight on the watchlist: below `watch` the record
  // JUMPS to it (the police can chase you the moment you rob); at or above it,
  // the normal gain applies on top. Mirrored in docs/sql/piracy_rpcs.sql and
  // pinned by tools/check_piracy_parity.js.
  bookRobbery(gain) {
    const w = this.cfg().watch || 100, v = this.value();
    return this.set(v < w ? w : v + (Number(gain) || 0));
  },
  applyServer(v) { if (v != null) this.set(v); return this.value(); },
  gain(kind) { return (this.cfg().gain || {})[kind] || 0; },

  tier(v = this.value()) {
    const tiers = this.cfg().tiers || [];
    let out = tiers[0] || { id: "clean", label: "Clean record", color: "#3ad6a0" };
    for (const t of tiers) if (v >= t.at) out = t;
    return out;
  },
  label(v = this.value()) { return this.tier(v).label; },
  watched(v = this.value()) { return v >= this.cfg().watch; },
  locked(v = this.value()) { return v >= this.cfg().lockout; },      // Senate bars you
  isCriminal(v = this.value()) { return v >= this.cfg().criminal; },

  // Chance a coerced senator refuses (and reports you) instead of folding.
  // Zero until `watch`, then climbs with the record.
  coerceFailChance(v = this.value()) {
    const c = this.cfg();
    const over = Math.max(0, v - c.watch);
    return Util.clamp(over / 100 * (c.coerceFailPer100 || 0), 0, c.coerceFailCap != null ? c.coerceFailCap : 0.9);
  },
  // Multiplier on customs seizure odds — a known face gets searched harder.
  customsMult(v = this.value()) {
    const c = this.cfg();
    const over = Math.max(0, v - c.watch);
    return Util.clamp(1 + over / 100 * (c.customsPer100 || 0), 1, c.customsMultCap != null ? c.customsMultCap : 2.5);
  },

  // The file cools by decayPerDay every real day. Whole days only, and
  // crimeSeenAt advances by exactly the days consumed, so this is idempotent
  // however often the loop calls it. Online the server runs the same sum inside
  // app_commit and its value wins.
  decay(now = Date.now()) {
    const s = this.s(); if (!s) return 0;
    const day = 24 * 60 * 60 * 1000;
    if (!s.crimeSeenAt) { s.crimeSeenAt = now; return this.value(); }
    if (now < s.crimeSeenAt) { s.crimeSeenAt = now; return this.value(); }   // clock went backwards
    const days = Math.floor((now - s.crimeSeenAt) / day);
    if (days <= 0) return this.value();
    s.crimeSeenAt += days * day;
    if (!this.local()) return this.value();   // server owns the number — just keep the stamp fresh
    return this.set(this.value() - days * (this.cfg().decayPerDay || 0));
  },

  // Why the Senate door is shut. Shown on every locked tab.
  lockNotice(v = this.value()) {
    const c = this.cfg();
    return `By order of ${c.lockAuthority || "the Senate Ethics Tribunal"}, your delegation is suspended. `
      + `Crime coefficient ${Math.round(v)} — ${this.label(v).toLowerCase()}. `
      + `You may read the edicts in force. You may not lobby, bribe, coerce, table a ballot, or address the chamber. `
      + `Your credentials return when the coefficient falls below ${c.lockout}.`;
  },
};

window.Crime = Crime;
