/* orders.js — standing orders & price alerts on the Galactic Exchange.
   A buy order fills when the price drops to/below its trigger; a sell order
   fills when it rises to/above; an alert just notifies. They auto-execute on
   market ticks while you're docked (and once during offline catch-up), turning
   "read the market" into a set-and-walk-away edge. Reuses Economy.buy/sell, so
   fills carry the same reputation edge, P&L and feed reactions as hand trades.

   ponytail: offline fills resolve once at the post-catch-up price, so a brief
   dip while you were away can be missed. Track per-tick min/max in Market if we
   want offline fills to be exact.

   Phase 1: process() is async — Economy.buy/sell return a Promise when
   authoritative, so callers must await (main.js loop/resume/init do).          */

const Orders = {
  s() { return window.Game.state; },
  list() { return this.s().orders || (this.s().orders = []); },
  add(o) {
    o.id = "o" + (++this.s().seq);
    // Bind to the system where the order was placed (HAULING.md §5).
    if (!o.systemId) o.systemId = this.s().currentSystem;
    this.list().push(o);
    return o;
  },
  remove(id) { this.s().orders = this.list().filter(o => o.id !== id); },

  // The price the player would transact at right now (their docked system).
  priceNow(commId) { return Market.systemPrice(commId, this.s().currentSystem); },

  // Check every order against current prices. Fills/fires the ones that crossed
  // and returns events for the UI to surface. No trading happens in transit.
  // Buy/sell orders only fill at the system they were placed in.
  // ponytail: a plain in-flight latch, same shape as Barons._publishing.
  // process() awaits buy/sell RPCs (easily longer than the 2s market tick) and
  // only writes s.orders back at the end, so the next tick used to iterate the
  // un-decremented list and queue the same order again — double fills, doubled
  // one-shot alerts, and last-writer-wins resurrecting removed orders.
  // Game.resume() kicks a process() right before restarting the loop, which
  // made the overlap a certainty rather than a race.
  _processing: false,
  async process() {
    const s = this.s();
    if (this._processing) return [];
    if (s.travel || !s.orders || !s.orders.length) return [];
    this._processing = true;
    try {
      return await this._run(s);
    } finally { this._processing = false; }
  },
  async _run(s) {
    // Snapshot: an Orders.add() during the awaits below pushes onto the very
    // array we're iterating. Take a copy so this pass has a fixed work list.
    const events = [], keep = [], started = s.orders.slice();
    for (const o of started) {
      const comm = COMMODITIES.find(c => c.id === o.commId);
      if (!comm) continue;                                   // commodity left config — drop
      const bound = o.systemId || s.currentSystem;
      if ((o.kind === "buy" || o.kind === "sell") && bound !== s.currentSystem) { keep.push(o); continue; }
      const p = this.priceNow(o.commId);
      if (o.kind === "alert") {
        if (o.side === "below" ? p <= o.price : p >= o.price) events.push({ type: "alert", comm, side: o.side, price: p });
        else keep.push(o);                                   // one-shot: fires once, else stays
      } else if (o.kind === "buy" && p <= o.price) {
        const q = Math.min(o.qty, Economy.maxBuy(o.commId));
        if (q > 0) {
          const r = await Economy.buy(o.commId, q);
          if (r && r.ok) { events.push({ type: "filled", side: "buy", comm, qty: r.qty, price: r.price }); o.qty -= r.qty; }
        }
        if (o.qty > 0) keep.push(o);                         // couldn't afford the lot yet — keep the rest
      } else if (o.kind === "sell" && p >= o.price) {
        const bayQ = window.Assets ? Assets.bayQty(s.currentSystem, o.commId) : (s.positions[o.commId] || 0);
        const q = Math.min(o.qty, bayQ);
        if (q > 0) {
          const r = await Economy.sell(o.commId, q);
          if (r && r.ok) { events.push({ type: "filled", side: "sell", comm, qty: r.qty, price: r.price, realized: r.realized }); o.qty -= r.qty; }
        }
        if (o.qty > 0) keep.push(o);                         // nothing (more) to sell yet — keep it
      } else keep.push(o);
    }
    // The player can add or cancel orders during the awaits above, and this is
    // the one place that rewrites the whole list — so honour the live list:
    // drop anything cancelled meanwhile, keep anything newly placed.
    const live = s.orders;
    s.orders = keep.filter(o => live.includes(o)).concat(live.filter(o => !started.includes(o)));
    return events;
  },
};

window.Orders = Orders;
