/* fleet.js — ships, cargo runs, ETA, offline catch-up.
   A ship sits `at` a system (idle) or is in `transit` from→to. Dispatching
   loads goods at the ship's current location (buy) and sells them on arrival at
   the destination (sell). Arbitrage = buy where a category is cheap, sell where
   it's dear (SYSTEMS[].mods).                                                  */

const Fleet = {
  s() { return window.Game.state; },

  shipType(t) { return SHIP_TYPES.find(x => x.id === t); },

  // Travel time. distance is absolute-from-home; a hop costs the gap (min 1).
  travelMs(fromId, toId, shipType) {
    const a = SYSTEMS.find(s => s.id === fromId);
    const b = SYSTEMS.find(s => s.id === toId);
    const dist = Math.max(1, Math.abs((a?.distance ?? 0) - (b?.distance ?? 0)));
    const minutes = dist / shipType.speed;
    return (minutes * 60 * 1000) / (window.Game.timeScale || 1);
  },

  idleShips() { return this.s().ships.filter(sh => sh.status === "idle"); },

  dispatch(uid, commId, qty, destId) {
    const s = this.s();
    const ship = s.ships.find(x => x.uid === uid);
    if (!ship || ship.status !== "idle") return { ok: false, msg: "Ship not available." };
    const type = this.shipType(ship.type);
    const origin = ship.at;
    if (destId === origin) return { ok: false, msg: "Pick a different destination." };
    if (!s.unlockedSystems.includes(destId)) return { ok: false, msg: "Destination locked." };
    qty = Math.min(Math.floor(qty), type.hold);
    if (qty <= 0) return { ok: false, msg: "Load some cargo first." };
    const price = Market.systemPrice(commId, origin);
    const cost = price * qty;
    if (cost > s.credits) return { ok: false, msg: "Not enough credits to load cargo." };

    s.credits -= cost;
    ship.status = "transit";
    ship.from = origin;
    ship.to = destId;
    ship.at = null;
    ship.cargo = { id: commId, qty, buyPrice: price };
    ship.departedAt = Date.now();
    ship.etaMs = this.travelMs(origin, destId, type);
    Economy.refreshNetWorth();
    Bus.emit("dispatch", { ship, commId, qty, destId });
    return { ok: true, ship };
  },

  progress(ship) {
    if (ship.status !== "transit") return 1;
    return Util.clamp((Date.now() - ship.departedAt) / ship.etaMs, 0, 1);
  },
  etaRemaining(ship) {
    if (ship.status !== "transit") return 0;
    return Math.max(0, ship.departedAt + ship.etaMs - Date.now());
  },

  // Resolve every transit ship whose ETA has passed. Used live (each tick) AND
  // for offline catch-up after the market has been advanced. Returns a summary.
  resolveMatured(now) {
    const s = this.s();
    const done = [];
    for (const ship of s.ships) {
      if (ship.status !== "transit") continue;
      if (ship.departedAt + ship.etaMs > now) continue;
      const cargo = ship.cargo;
      const sellPrice = Market.systemPrice(cargo.id, ship.to);
      const proceeds = sellPrice * cargo.qty;
      const profit = proceeds - cargo.buyPrice * cargo.qty;
      s.credits += proceeds;
      const comm = COMMODITIES.find(c => c.id === cargo.id);
      const sys = SYSTEMS.find(x => x.id === ship.to);
      const type = this.shipType(ship.type);
      done.push({
        shipName: type ? type.name : ship.type,
        commName: comm ? comm.name : cargo.id,
        commId: cargo.id, qty: cargo.qty, proceeds, profit,
        to: ship.to, toName: sys ? sys.name : ship.to,
      });
      ship.status = "idle";
      ship.at = ship.to;
      ship.from = null;
      ship.to = null;
      ship.cargo = null;
      ship.departedAt = null;
      ship.etaMs = null;
      s.stats.runs = (s.stats.runs || 0) + 1;
      s.stats.runProfit = (s.stats.runProfit || 0) + profit;
    }
    if (done.length) {
      Economy.refreshNetWorth();
      Economy.checkAchievements();
      for (const d of done) Bus.emit("runDone", d);
    }
    return done;
  },
};

window.Fleet = Fleet;
