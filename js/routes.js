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

  // Round-trip time: scales with the distance between systems and inversely with
  // the assigned ship's own speed (a fast hauler runs the loop quicker). Computed
  // live (not baked into the route) so speed upgrades + tuning apply immediately.
  cycleMsFor(ship, from, to) {
    const a = SYSTEMS.find(s => s.id === from), b = SYSTEMS.find(s => s.id === to);
    const dist = Math.max(1, Math.abs((a?.distance ?? 0) - (b?.distance ?? 0)));
    const speed = Fleet.stats(ship).speed || 1;
    const seconds = (2 * dist * ROUTECFG.legSecondsPerDist) / speed;
    return Math.max(1000, seconds * 1000 / (window.Game.timeScale || 1));
  },

  // Per-round-trip economics at current prices. spread is clamped ≥0 so a bad
  // route just earns ~nothing rather than draining credits.
  estimate(ship, comm, from, to) {
    const cargo = Fleet.stats(ship).cargo;
    const buy = Market.systemPrice(comm, from);
    const sell = Market.systemPrice(comm, to);
    const spread = Math.max(0, sell - buy);
    const cycleMs = this.cycleMsFor(ship, from, to);
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
    sh.status = "trading";
    sh.route = { comm, from, to, nextAt: now + this.cycleMsFor(sh, from, to) };
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
      const cycleMs = this.cycleMsFor(sh, r.from, r.to);
      if (!u.includes(r.from) || !u.includes(r.to)) { if (now >= r.nextAt) r.nextAt = now + cycleMs; continue; }
      if (now < r.nextAt) continue;
      const cycles = Math.min(Math.floor((now - r.nextAt) / cycleMs) + 1, ROUTECFG.maxCyclesPerResolve);
      const gain = this.estimate(sh, r.comm, r.from, r.to).profit * cycles;
      if (gain > 0) { total += gain; runs.push({ ship: sh.name, comm: r.comm, gain, cycles }); }
      r.nextAt = now + cycleMs;   // schedule the next trip a full cycle out
    }
    if (total) { this.s().credits += total; Economy.refreshNetWorth(); }
    return { total, runs };
  },
};

window.Routes = Routes;
