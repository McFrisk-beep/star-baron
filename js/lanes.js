/* lanes.js — the deterministic hyperspace lane graph (docs/LIVING_GALAXY.md §2).
   Derived from GALAXY.seed after Galaxy.build(), exactly like the galaxy
   itself: every client computes the identical graph, nothing is persisted.
   Sector capitals form a trunk ring (two connectors per sector); within a
   sector each system links to its 1–3 nearest neighbours plus a spanning pass
   so no system is stranded. Lane length = pos distance, the same metric
   charters/surveys already scale by.                                           */

const Lanes = {
  adj: {},        // sysId -> [{ to, len, trunk }]
  list: [],       // unique edges [{ a, b, len, trunk }] for rendering
  _routes: {},    // "a>b" -> { path: [ids], len } (Dijkstra cache)

  // Trunk-ring loop order (LIVING_GALAXY.md §2.1): Core ↔ Korrin Belt,
  // Core ↔ Helm Tide, and on around — the perimeter loop, not SECTORS array
  // order, so no trunk lane crosses the map.
  RING: ["core", "belt", "green", "sprawl", "forge", "tide"],

  build() {
    this.adj = {}; this.list = []; this._routes = {};
    // Independent stream off the same seed family as Galaxy.build().
    const rng = Galaxy._mk((GALAXY.seed ^ 0x1A9E5) >>> 0);
    const dist = (aId, bId) => {
      const a = Galaxy.get(aId).pos, b = Galaxy.get(bId).pos;
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const has = (aId, bId) => (this.adj[aId] || []).some(l => l.to === bId);
    const add = (aId, bId, trunk = false) => {
      if (aId === bId || has(aId, bId)) return;
      const len = dist(aId, bId);
      (this.adj[aId] ||= []).push({ to: bId, len, trunk });
      (this.adj[bId] ||= []).push({ to: aId, len, trunk });
      this.list.push({ a: aId, b: bId, len, trunk });
    };

    // Trunk ring: capitals loop in RING order — two connectors per sector.
    const caps = this.RING.map(id => SECTORS.find(s => s.id === id).capital);
    for (let i = 0; i < caps.length; i++) add(caps[i], caps[(i + 1) % caps.length], true);

    for (const sec of Galaxy.sectors) {
      const ids = sec.systems;
      // Each system links to its 1–3 nearest in-sector neighbours.
      for (const id of ids) {
        const want = 1 + Math.floor(rng() * 3);
        const near = ids.filter(o => o !== id).sort((x, y) => dist(id, x) - dist(id, y));
        for (let k = 0; k < Math.min(want, near.length); k++) add(id, near[k]);
      }
      // Spanning pass: attach every stranded island to the capital's component
      // via the shortest available link, distance to the capital discounted so
      // the capital reads as the hub.
      const reached = new Set([sec.capital]);
      const grow = () => {
        const q = [...reached];
        while (q.length) for (const l of this.adj[q.pop()] || [])
          if (ids.includes(l.to) && !reached.has(l.to)) { reached.add(l.to); q.push(l.to); }
      };
      grow();
      while (reached.size < ids.length) {
        let best = null;
        for (const id of ids) {
          if (reached.has(id)) continue;
          for (const r of reached) {
            const d = dist(id, r) * (r === sec.capital ? 0.8 : 1);
            if (!best || d < best.d) best = { d, from: id, to: r };
          }
        }
        add(best.from, best.to);
        reached.add(best.from); grow();
      }
    }
  },

  // Shortest path a→b through the lanes. Returns { path: [ids], len } or null.
  // ponytail: full Dijkstra per query over ~84 nodes, cached; fine at this size.
  route(a, b) {
    if (!this.adj[a] || !this.adj[b]) return null;
    const key = a + ">" + b;
    if (this._routes[key]) return this._routes[key];
    const distTo = { [a]: 0 }, prev = {}, done = new Set();
    while (true) {
      let u = null;
      for (const id in distTo) if (!done.has(id) && (u === null || distTo[id] < distTo[u])) u = id;
      if (u === null) return null;              // b unreachable (never, graph is connected)
      if (u === b) break;
      done.add(u);
      for (const l of this.adj[u]) {
        const d = distTo[u] + l.len;
        if (distTo[l.to] === undefined || d < distTo[l.to]) { distTo[l.to] = d; prev[l.to] = u; }
      }
    }
    const path = [b];
    while (path[0] !== a) path.unshift(prev[path[0]]);
    const out = { path, len: distTo[b] };
    this._routes[key] = out;
    this._routes[b + ">" + a] = { path: [...path].reverse(), len: distTo[b] };
    return out;
  },

  routeLength(a, b) { const r = this.route(a, b); return r ? r.len : null; },

  // One gate per lane; angle = true bearing from this system toward the
  // neighbour (pos space), so the gate to Navos points at Navos.
  gates(sysId) {
    const here = Galaxy.get(sysId);
    if (!here || !this.adj[sysId]) return [];
    return this.adj[sysId].map(l => {
      const o = Galaxy.get(l.to).pos;
      return { to: l.to, angle: Math.atan2(o.y - here.pos.y, o.x - here.pos.x) };
    });
  },
};

window.Lanes = Lanes;
