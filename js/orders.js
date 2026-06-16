/* orders.js — standing orders & price alerts on the Galactic Exchange.
   A buy order fills when the price drops to/below its trigger; a sell order
   fills when it rises to/above; an alert just notifies. They auto-execute on
   market ticks while you're docked (and once during offline catch-up), turning
   "read the market" into a set-and-walk-away edge. Reuses Economy.buy/sell, so
   fills carry the same reputation edge, P&L and feed reactions as hand trades.

   ponytail: offline fills resolve once at the post-catch-up price, so a brief
   dip while you were away can be missed. Track per-tick min/max in Market if we
   want offline fills to be exact.                                              */

const Orders = {
  s() { return window.Game.state; },
  list() { return this.s().orders || (this.s().orders = []); },
  add(o) { o.id = "o" + (++this.s().seq); this.list().push(o); return o; },
  remove(id) { this.s().orders = this.list().filter(o => o.id !== id); },

  // The price the player would transact at right now (their docked system).
  priceNow(commId) { return Market.systemPrice(commId, this.s().currentSystem); },

  // Check every order against current prices. Fills/fires the ones that crossed
  // and returns events for the UI to surface. No trading happens in transit.
  process() {
    const s = this.s();
    if (s.travel || !s.orders || !s.orders.length) return [];
    const events = [], keep = [];
    for (const o of s.orders) {
      const comm = COMMODITIES.find(c => c.id === o.commId);
      if (!comm) continue;                                   // commodity left config — drop
      const p = this.priceNow(o.commId);
      if (o.kind === "alert") {
        if (o.side === "below" ? p <= o.price : p >= o.price) events.push({ type: "alert", comm, side: o.side, price: p });
        else keep.push(o);                                   // one-shot: fires once, else stays
      } else if (o.kind === "buy" && p <= o.price) {
        const q = Math.min(o.qty, Economy.maxBuy(o.commId));
        if (q > 0) { const r = Economy.buy(o.commId, q); if (r.ok) { events.push({ type: "filled", side: "buy", comm, qty: r.qty, price: r.price }); o.qty -= r.qty; } }
        if (o.qty > 0) keep.push(o);                         // couldn't afford the lot yet — keep the rest
      } else if (o.kind === "sell" && p >= o.price) {
        const q = Math.min(o.qty, s.positions[o.commId] || 0);
        if (q > 0) { const r = Economy.sell(o.commId, q); if (r.ok) { events.push({ type: "filled", side: "sell", comm, qty: r.qty, price: r.price, realized: r.realized }); o.qty -= r.qty; } }
        if (o.qty > 0) keep.push(o);                         // nothing (more) to sell yet — keep it
      } else keep.push(o);
    }
    s.orders = keep;
    return events;
  },
};

window.Orders = Orders;
