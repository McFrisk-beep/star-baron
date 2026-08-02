/* routes.js — automated trade routes. A route is a group of idle ships ferrying
   one commodity between two unlocked systems; their cargo is pooled and they
   bank the spread × pooled-cargo every round trip, running while you're away.
   The group moves at its slowest ship's speed. Reuses system price mods
   (Market), ship cargo/speed (Fleet.stats) and Economy for the payout.

   ponytail: capital is abstracted — the group banks the spread directly rather
   than tying up credits buying stock. Add a working-capital float + a
   stall-when-broke rule here if we want routes to carry real risk.            */

const Routes = {
  s() { return window.Game.state; },
  // Phase 3: signed-in + players RPCs → route ship assignment goes through the
  // server (it owns ship status), so app_pull can pay the route.
  authoritative() { return !!(window.Economy && Economy.authoritative()); },
  list() { return this.s().routes || (this.s().routes = []); },
  shipsOf(route) { return route.shipUids.map(u => Fleet.ship(u)).filter(Boolean); },

  // Round-trip time: scales with distance and inversely with the SLOWEST ship's
  // speed (a group is only as fast as its slowest hull). Computed live so speed
  // upgrades and tuning apply immediately.
  //
  // Authoritative (logged-in) timing matches the server: catalog hull speed only
  // (no accessories / damage), and NOT compressed by dev fast-time — otherwise
  // the modal ETA lies and cycles bank every game tick with event-toast spam.
  cycleMsFor(route) {
    const a = SYSTEMS.find(s => s.id === route.from), b = SYSTEMS.find(s => s.id === route.to);
    const dist = Math.max(1, Math.abs((a?.distance ?? 0) - (b?.distance ?? 0)));
    const ships = this.shipsOf(route);
    const speedOf = sh => {
      if (this.authoritative()) return Math.max(0.1, (Fleet.shipDef(sh.type).speed || 1));
      return Fleet.stats(sh).speed || 1;
    };
    const speed = (ships.length ? Math.min(...ships.map(speedOf)) : 1) * (window.Senate ? Senate.travelSpeedMult() : 1);
    const seconds = (2 * dist * ROUTECFG.legSecondsPerDist) / Math.max(0.1, speed);
    // Guests still honor fast-time for quick local tests; floor keeps one cycle
    // from resolving more than once per market tick.
    const scaled = this.authoritative() ? seconds * 1000
      : seconds * 1000 / (window.Game.timeScale || 1);
    return Math.max(CONFIG.marketTickMs, scaled);
  },
  cargoOf(route) { return this.shipsOf(route).reduce((n, sh) => n + Fleet.stats(sh).cargo, 0); },

  // Per-round-trip economics at current prices. spread is clamped ≥0 so a bad
  // route just earns ~nothing rather than draining credits.
  estimate(route) {
    const cargo = this.cargoOf(route);
    // routePrice (not systemPrice): rare-stock exchange premium is for docked
    // trades only — applying it here made many rare-commodity routes look worthless.
    const buy = Market.routePrice(route.comm, route.from);
    const sell = Market.routePrice(route.comm, route.to);
    const spread = Math.max(0, sell - buy);
    const cycleMs = this.cycleMsFor(route);
    const profit = Math.round(spread * cargo * ROUTECFG.margin);
    return { cargo, buy, sell, spread, cycleMs, profit, perHour: profit * 3600000 / cycleMs };
  },
  // Estimate for a not-yet-created route (the setup modal).
  preview(shipUids, comm, from, to) { return this.estimate({ comm, from, to, shipUids }); },

  // Best unlocked buy→sell pair for a commodity (largest positive spread).
  bestPair(comm, unlocked) {
    const u = unlocked || [];
    let best = null, bestSpread = -Infinity;
    for (const from of u) for (const to of u) {
      if (from === to) continue;
      const spread = Market.routePrice(comm, to) - Market.routePrice(comm, from);
      if (spread > bestSpread) { bestSpread = spread; best = { from, to, spread }; }
    }
    return best;
  },

  _startLocal(shipUids, comm, from, to, now = Date.now()) {
    const ships = (shipUids || []).map(u => Fleet.ship(u)).filter(Boolean);
    if (!ships.length) return { ok: false, msg: "Pick at least one ship." };
    if (ships.some(sh => sh.mercenary)) return { ok: false, msg: "Mercenaries can't run routes." };
    if (ships.some(sh => sh.status !== "idle")) return { ok: false, msg: "All ships must be idle." };
    if (!comm || from === to) return { ok: false, msg: "Pick two different systems." };
    const u = this.s().unlockedSystems;
    if (!u.includes(from) || !u.includes(to)) return { ok: false, msg: "Both systems must be unlocked." };
    const route = { id: "rt" + (++this.s().seq), comm, from, to, shipUids: ships.map(s => s.uid) };
    route.nextAt = now + this.cycleMsFor(route);
    for (const sh of ships) sh.status = "trading";
    this.list().push(route);
    return { ok: true };
  },
  start(shipUids, comm, from, to, now = Date.now()) {
    if (!this.authoritative()) return this._startLocal(shipUids, comm, from, to, now);
    return Economy._withRpc(
      () => this._startLocal(shipUids, comm, from, to, now),
      () => Cloud.routeStart(comm, from, to, (shipUids || []).slice()),
      "Couldn't start the route — try again."
    );
  },

  _stopLocal(routeId) {
    const route = this.list().find(r => r.id === routeId);
    if (!route) return { ok: false };
    for (const sh of this.shipsOf(route)) if (sh.status === "trading") sh.status = "idle";
    this.s().routes = this.list().filter(r => r.id !== routeId);
    return { ok: true };
  },
  stop(routeId) {
    if (!this.authoritative()) return this._stopLocal(routeId);
    return Economy._withRpc(
      () => this._stopLocal(routeId),
      () => Cloud.routeStop(routeId),
      "Couldn't stop the route — try again."
    );
  },

  // Roll a random event for a banking run (see ROUTE_EVENTS). Returns null for a
  // quiet, ordinary run. `per` is one cycle's base profit; the event's swing is
  // scaled to it so a single event can never move more than one shipment — safe
  // even when a long offline catch-up banks many cycles at once.
  rollEvent(route, per) {
    if (!(per > 0) || !window.ROUTE_EVENTS || Math.random() >= ROUTECFG.eventChance) return null;
    const total = ROUTE_EVENTS.reduce((n, e) => n + e.w, 0);
    let r = Math.random() * total, ev = ROUTE_EVENTS[0];
    for (const e of ROUTE_EVENTS) { if ((r -= e.w) < 0) { ev = e; break; } }
    // Flagship routeSafe can shrug off a bad roll (safer lanes).
    const safe = window.Fleet ? Fleet.mainBonus("routeSafe") : 0;
    if (!ev.good && safe > 0 && Math.random() < safe) return null;
    let delta = Math.round(per * (Util.randFloat(ev.mult[0], ev.mult[1]) - 1));   // change vs a normal shipment
    // Senate route-safety edict softens (+) or sharpens (−) a raid's bite.
    const safety = window.Senate ? Senate.routeSafetyAdd() : 0;
    if (!ev.good && safety) {
      const cl = (window.SENATECFG && SENATECFG.routeSafetyClamp) || [0.1, 2.5];
      delta = Math.round(delta * Util.clamp(1 - safety, cl[0], cl[1]));
    }
    const out = { id: ev.id, msg: ev.msg, good: !!ev.good, delta, comm: route.comm, from: route.from, to: route.to };
    if (ev.dmg) {                                                                    // wear a random ship on the route
      const sh = Util.pick(this.shipsOf(route));
      if (sh) { const before = sh.dmg || 0; Fleet.addDamage(sh, Util.randFloat(ev.dmg[0], ev.dmg[1])); out.ship = { name: sh.name, pct: Math.round((sh.dmg - before) * 100) }; }
    }
    return out;
  },

  // Phase 3 soft income is server-side when app_pull is live. While logged-in
  // but pull hasn't succeeded yet, do NOT mint local credits/events — Phase 3
  // app_commit rejects credit increases, and local banking desyncs the ledger.
  // Only fall back to local soft income when app_pull is confirmed missing.
  softIncomeLocal() {
    if (!(window.Cloud && Cloud.authoritative && Cloud.authoritative())) return true; // guest
    if (Cloud.pullReady) return false;           // Phase 3 live
    if (Cloud.pullMissing) return true;          // Phase 3 SQL not installed
    return false;                               // retry pull; don't mint ghosts
  },

  // Bank completed round trips up to `now`. A route whose endpoints are no longer
  // unlocked just pauses; a route whose ships all vanished is removed.
  resolve(now = Date.now()) {
    if (!this.softIncomeLocal()) return { total: 0, runs: [], events: [] };
    let total = 0; const runs = [], events = []; const u = this.s().unlockedSystems;
    for (const route of this.list()) {
      route.shipUids = route.shipUids.filter(uid => { const sh = Fleet.ship(uid); return sh && sh.status === "trading"; });
      if (!route.shipUids.length) { route._dead = true; continue; }
      const cycleMs = this.cycleMsFor(route);
      // Heal missing/NaN nextAt — otherwise every market tick looks "due" and
      // event toasts fire every couple of seconds while ETA still looks fine.
      if (!(route.nextAt > 0)) route.nextAt = now + cycleMs;
      if (!u.includes(route.from) || !u.includes(route.to)) {
        if (now >= route.nextAt) route.nextAt = now + cycleMs;
        continue;
      }
      if (now < route.nextAt) continue;
      const dueAt = route.nextAt;
      const cycles = Math.min(Math.floor((now - dueAt) / cycleMs) + 1, ROUTECFG.maxCyclesPerResolve);
      const per = this.estimate(route).profit;
      const ev = this.rollEvent(route, per);
      const gain = per * cycles + (ev ? ev.delta : 0);
      if (gain !== 0) { total += gain; runs.push({ comm: route.comm, gain, cycles }); }
      if (ev) events.push(ev);
      // Keep the schedule aligned to the original due time (not "now + 1"), so a
      // slightly-late tick can't stretch/compress the next ETA oddly.
      route.nextAt = dueAt + cycles * cycleMs;
      if (route.nextAt <= now) route.nextAt = now + cycleMs;
    }
    this.s().routes = this.list().filter(r => !r._dead);
    if (total) { total = Economy.afterTax(total); this.s().credits = Math.max(0, this.s().credits + total); Economy.refreshNetWorth(); }   // Baron Tier earnings tax (losses pass through untaxed; never drive credits below 0)
    return { total, runs, events };
  },
};

window.Routes = Routes;
