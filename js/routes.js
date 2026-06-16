/* routes.js — automated trade routes. Assign an idle ship to ferry a commodity
   from a cheap system to a dear one; it banks the price spread × cargo every
   round trip, running while you're away. Reuses system price mods (Market),
   ship cargo (Fleet.stats) and the same dock-travel timing as manual docking.

   ponytail: capital is abstracted — the ship banks the spread directly rather
   than tying up your credits buying stock. Add a working-capital float + a
   stall-when-broke rule here if we want the route to carry real risk.          */

const Routes = {
  s() { return window.Game.state; },

  active() { return this.s().ships.filter(sh => sh.status === "trading" && sh.route); },

  // Per-round-trip economics at current prices. spread is clamped ≥0 so a bad
  // route just earns ~nothing rather than draining credits.
  estimate(ship, comm, from, to) {
    const cargo = Fleet.stats(ship).cargo;
    const buy = Market.systemPrice(comm, from);
    const sell = Market.systemPrice(comm, to);
    const spread = Math.max(0, sell - buy);
    const cycleMs = Math.max(1000, 2 * Fleet.dockTravelMs(from, to));   // there and back
    const profit = Math.round(spread * cargo * ROUTECFG.margin);
    return { cargo, buy, sell, spread, cycleMs, profit, perHour: profit * 3600000 / cycleMs };
  },

  start(shipUid, comm, from, to, now = Date.now()) {
    const sh = Fleet.ship(shipUid);
    if (!sh) return { ok: false, msg: "Ship not found." };
    if (sh.mercenary) return { ok: false, msg: "Mercenaries can't run routes." };
    if (sh.status !== "idle") return { ok: false, msg: "Ship is busy." };
    if (!comm || from === to) return { ok: false, msg: "Pick two different systems." };
    const u = this.s().unlockedSystems;
    if (!u.includes(from) || !u.includes(to)) return { ok: false, msg: "Both systems must be unlocked." };
    const cycleMs = Math.max(1000, 2 * Fleet.dockTravelMs(from, to));
    sh.status = "trading";
    sh.route = { comm, from, to, cycleMs, nextAt: now + cycleMs };
    return { ok: true };
  },

  stop(shipUid) {
    const sh = Fleet.ship(shipUid);
    if (!sh || sh.status !== "trading") return { ok: false };
    sh.status = "idle"; delete sh.route;
    return { ok: true };
  },

  // Bank completed round trips up to `now`. Approximation: every cycle in the
  // window is priced at the current spread (fine for an idle game). A route
  // whose endpoints are no longer unlocked simply pauses (banks nothing).
  resolve(now = Date.now()) {
    let total = 0; const runs = [];
    const u = this.s().unlockedSystems;
    for (const sh of this.active()) {
      const r = sh.route;
      if (!u.includes(r.from) || !u.includes(r.to)) { if (now >= r.nextAt) r.nextAt = now + r.cycleMs; continue; }
      if (now < r.nextAt) continue;
      let cycles = Math.min(Math.floor((now - r.nextAt) / r.cycleMs) + 1, ROUTECFG.maxCyclesPerResolve);
      const gain = this.estimate(sh, r.comm, r.from, r.to).profit * cycles;
      if (gain > 0) { total += gain; runs.push({ ship: sh.name, comm: r.comm, gain, cycles }); }
      r.nextAt = now + r.cycleMs;   // schedule the next trip a full cycle out
    }
    if (total) { this.s().credits += total; Economy.refreshNetWorth(); }
    return { total, runs };
  },
};

window.Routes = Routes;
