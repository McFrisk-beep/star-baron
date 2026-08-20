/* combat.js — the battle choreographer (docs/LIVING_GALAXY.md §5).
   Pure: (report, roster, seed) → script. No DOM, no canvas — battleview.js
   renders the script. Choreography works BACKWARDS from the resolved report:
   ships in report.lost get a death beat, ships in report.damaged get hits
   summing exactly to their pct, untouched ships are never shown hit. Enemy
   losses are free variables — success reads as a rout, failure as your line
   breaking. The movie must never disagree with the wallet.

   Script shape:
     { duration,                       // seconds
       ships: [{ id, side, name, type, sprite, size, role, shields,
                 path: [{t,x,y}...],  // unit-space waypoints, renderer lerps
                 deathT? }],
       events: [{ t, kind, from, to, dmg? }] }   // sorted by t
   kinds: beam | missile | flak | shieldhit | death | launch.
   beam/missile/flak WITHOUT dmg are near-misses (no impact on the target) —
   that keeps space busy in flawless fights while honouring "untouched ships
   are never shown hit". dmg values on one ship sum to its report pct.        */

const Combat = {
  // FNV-1a — mission uid → deterministic seed (same fight every replay).
  seedFrom(str) {
    let h = 2166136261;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  },
  _mk(seed) {   // mulberry32, same generator family as Galaxy._mk
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },

  // A report is watchable when an engagement actually happened (a clean
  // courier run has no scene) and the roster survived into the save.
  replayable(r) {
    if (!r || !Array.isArray(r.roster) || !r.roster.length) return false;
    if (!(typeof DMGCFG !== "undefined" && DMGCFG.types[r.type])) return false;
    return !!((r.lost || []).length || (r.damaged || []).length
      || (r.impounded || []).length || !r.success
      || r.type === "combat" || r.type === "assassinate");
  },

  // Danger → fight scale. Duration scales with stakes (§5.3): a safe scrape is
  // a short flyby, an extreme slugfest gets the full runtime.
  _danger(d) {
    return { safe:     { dur: 7,  n: [1, 2], tier: 0 },
             low:      { dur: 10, n: [2, 3], tier: 1 },
             moderate: { dur: 14, n: [3, 5], tier: 2 },
             high:     { dur: 19, n: [4, 6], tier: 3 },
             extreme:  { dur: 25, n: [5, 8], tier: 4 } }[d]
      || { dur: 12, n: [2, 4], tier: 1 };
  },

  // Enemy flavour from the report's sponsor: syndicate jobs draw syndicate
  // muscle, corporate factions field security, everything else is pirates.
  _flavour(faction) {
    if (faction === "syndicate") return "syndicate";
    if (faction === "free_trade" || faction === "mining_combine" || faction === "agri_collective") return "corporate";
    return "pirate";
  },

  // Role from existing stats (§5.4) — no new data.
  _role(def) {
    if (def.id === "carrier") return "carrier";
    if (def.cls === "transport" || def.cls === "survey") return "convoy";
    if ((def.firepower || 0) >= 120 && (def.speed || 1) <= 1.2) return "capital";
    if ((def.speed || 1) >= 1.8 && (def.hull || 100) < 150) return "screen";
    return "line";
  },

  _size(hull) { return Math.max(8, Math.round(Math.sqrt(hull || 100) * 1.05)); },

  _def(type) {
    const all = (typeof ALL_SHIPS !== "undefined") ? ALL_SHIPS : [];
    return all.find(d => d.id === type)
      || { id: type, cls: "escort", firepower: 20, hull: 110, armor: 20, shields: 10, speed: 1.6, sprite: "voidkin" };
  },

  script(report, roster, seed) {
    const rng = this._mk(seed != null ? seed : this.seedFrom(report.uid));
    const rf = (a, b) => a + rng() * (b - a);
    const ri = (a, b) => Math.floor(rf(a, b + 1));
    const pick = arr => arr[Math.floor(rng() * arr.length)];
    const cfg = this._danger(report.danger);

    // ---- both sides, fates first ----------------------------------------
    const lostIds = new Set((report.lost || []).map(x => x.uid));
    const dmgBy = {};
    for (const d of (report.damaged || [])) dmgBy[d.uid] = d.pct;
    const players = (roster || []).slice(0, 12).map(p => {
      const def = this._def(p.type);
      return { id: p.uid, side: "player", name: p.name, type: p.type,
        sprite: def.cls === "escort" ? "race:" + def.sprite : "ship:" + def.sprite,
        size: this._size(def.hull), role: this._role(def), shields: def.shields || 0,
        fp: def.firepower || 5, dead: lostIds.has(p.uid), pct: dmgBy[p.uid] || 0 };
    });
    if (report.wipe) for (const p of players) p.dead = true;

    const pool = (typeof ENEMY_CATALOG !== "undefined" ? ENEMY_CATALOG : { pirate: [] })[this._flavour(report.faction)] || [];
    const usable = pool.filter(e => e.tier <= cfg.tier);
    const nEnemies = Math.min(9, Math.max(1, ri(cfg.n[0], cfg.n[1]) + (players.length > 4 ? 1 : 0)));
    const enemies = [];
    if (!usable.length) usable.push({ id: "raider", name: "Raider", firepower: 15, hull: 90, armor: 15, shields: 5, speed: 1.8, sprite: "mechanim", tier: 0 });
    for (let i = 0; i < nEnemies; i++) {
      // bias toward the band's top tier so high jobs field real hulls
      const e = rng() < 0.5 ? usable[usable.length - 1] : pick(usable);
      const race = (typeof RACES !== "undefined") && RACES[e.sprite];
      enemies.push({ id: "e" + i, side: "enemy", name: e.name, type: e.id,
        sprite: (race ? "race:" : "ship:") + e.sprite,
        size: this._size(e.hull), role: this._role(Object.assign({ cls: "escort" }, e)),
        shields: e.shields || 0, fp: e.firepower || 10, dead: false, pct: 0 });
    }

    // enemy fates are free variables: rout on success, few losses on failure
    const eDeaths = report.success ? Math.max(1, enemies.length - (rng() < 0.3 ? 1 : 0))
      : Math.round(enemies.length * (report.wipe ? 0.1 : 0.25));
    for (let i = 0; i < eDeaths && i < enemies.length; i++) enemies[i].dead = true;

    // ---- timeline: approach → first exchange → attrition → resolution ----
    const engaged = players.some(p => p.dead || p.pct) || !report.success
      || report.type === "combat" || report.type === "assassinate";
    const D = Math.max(6, Math.min(26,
      (engaged ? cfg.dur : Math.min(cfg.dur, 8)) + Math.min(4, (players.length + enemies.length) * 0.25)));
    const t1 = D * 0.20, t2 = D * 0.45, t3 = D * 0.85;

    const ships = players.concat(enemies);
    this._paths(report.type, players, enemies, D, t1, t2, rng);

    // death beats: player losses land in attrition (later on success — the
    // pyrrhic read), enemy rout crescendos toward t3
    const events = [];
    const dying = ships.filter(s => s.dead);
    const span = report.success ? [t2 + 0.5, t3] : [t2, D * 0.95];
    dying.sort(() => rng() - 0.5);
    dying.forEach((s, i) => {
      s.deathT = +(rf(span[0], span[1])).toFixed(2);
      if (s.side === "enemy" && report.success && i === dying.length - 1) s.deathT = +(t3 - 0.3).toFixed(2);
      const here = this._at(s, s.deathT);            // position BEFORE truncating
      s.path = s.path.filter(w => w.t < s.deathT || w.t === 0);
      s.path.push({ t: s.deathT, x: here.x, y: here.y });
    });

    // damage hits: shares sum EXACTLY to the report pct (largest remainder)
    for (const p of players) {
      if (!p.pct) continue;
      const end = Math.min(t3, p.deathT || t3);
      const n = 1 + (p.pct > 8 ? 1 : 0) + (p.pct > 18 ? 1 : 0);
      const raw = Array.from({ length: n }, () => rf(0.5, 1.5));
      const tot = raw.reduce((a, b) => a + b, 0);
      let left = p.pct;
      const shares = raw.map((w, i) => {
        const v = i === n - 1 ? left : Math.max(1, Math.round(p.pct * w / tot));
        left -= v; return v;
      });
      // shooter must be alive at t — if every enemy is gone by then, pull the
      // hit back to just before the last one dies (sum stays exact either way)
      const shooter = t => {
        const a = enemies.filter(e => !e.deathT || e.deathT > t);
        if (a.length) return { from: pick(a), t };
        const last = enemies.reduce((x, y) => ((x.deathT || 0) >= (y.deathT || 0) ? x : y));
        return { from: last, t: Math.max(0.4, +(last.deathT - 0.1).toFixed(2)) };
      };
      if (p.shields > 0) { const h = shooter(+(rf(t1, t2)).toFixed(2)); events.push({ t: h.t, kind: "shieldhit", from: h.from.id, to: p.id }); }
      shares.forEach(v => {
        const h = shooter(+(rf(t2 * 0.9, end)).toFixed(2));
        events.push({ t: h.t, kind: this._weapon(h.from, rng), from: h.from.id, to: p.id, dmg: v });
      });
    }

    // kill volleys: 2–3 hard hits walk into each death beat (no dmg field —
    // the wallet accounting lives only on `damaged` ships)
    for (const s of dying) {
      const side = s.side === "player" ? enemies : players;
      const foes = side.filter(f => !f.deathT || f.deathT > s.deathT);
      for (let i = ri(2, 3); i > 0 && foes.length; i--) {   // no live foe → the ring alone tells it
        const from = pick(foes);
        events.push({ t: +(Math.max(0.5, s.deathT - rf(0.15, 1.2))).toFixed(2), kind: this._weapon(from, rng), from: from.id, to: s.id });
      }
      events.push({ t: s.deathT, kind: "death", from: s.id, to: s.id });
    }

    // ambient exchanges: everyone fires; near-misses (no dmg) are the only
    // fire that ever points at an untouched ship
    for (const s of ships) {
      if (s.role === "convoy") continue;
      const foes = s.side === "player" ? enemies : players;
      if (!foes.length) continue;
      const cadence = s.role === "screen" ? 1.1 : s.role === "capital" ? 2.6 : 1.8;
      for (let t = t1 + rf(0, cadence); t < Math.min(t3, s.deathT || t3); t += cadence * rf(0.8, 1.3)) {
        const to = pick(foes.filter(f => !f.deathT || f.deathT > t));
        if (!to) break;
        events.push({ t: +t.toFixed(2), kind: this._weapon(s, rng), from: s.id, to: to.id });
        if (s.role === "capital" && rng() < 0.6 && t + 0.12 < Math.min(t3, s.deathT || t3))
          events.push({ t: +(t + 0.12).toFixed(2), kind: "beam", from: s.id, to: to.id });   // broadside
      }
      if (s.role === "carrier" && !s.deathT)
        for (let i = 0, n = ri(2, 3); i < n; i++)
          events.push({ t: +(rf(t1, t2)).toFixed(2), kind: "launch", from: s.id, to: s.id });
    }

    events.sort((a, b) => a.t - b.t);
    return {
      duration: +D.toFixed(2),
      outcome: report.wipe ? "wipe" : report.success
        ? (players.some(p => p.dead) ? "pyrrhic" : "flawless")
        : "loss",
      ships: ships.map(s => ({ id: s.id, side: s.side, name: s.name, type: s.type,
        sprite: s.sprite, size: s.size, role: s.role, shields: s.shields,
        path: s.path, deathT: s.deathT })),
      events,
    };
  },

  _weapon(s, rng) {
    if (!s) return "beam";
    if (s.role === "capital") return "beam";
    if (s.role === "screen") return rng() < 0.6 ? "flak" : "beam";
    return rng() < 0.35 ? "missile" : rng() < 0.6 ? "beam" : "flak";
  },

  // position on a ship's own path at time t (linear between waypoints)
  _at(s, t) {
    const p = s.path;
    if (t <= p[0].t) return p[0];
    for (let i = 1; i < p.length; i++) {
      if (t <= p[i].t) {
        const k = (t - p[i - 1].t) / Math.max(1e-9, p[i].t - p[i - 1].t);
        return { x: p[i - 1].x + (p[i].x - p[i - 1].x) * k, y: p[i - 1].y + (p[i].y - p[i - 1].y) * k };
      }
    }
    return p[p.length - 1];
  },

  // ---- formation templates (§5.3): five shapes keyed by mission type ------
  _paths(type, players, enemies, D, t1, t2, rng) {
    const rf = (a, b) => a + rng() * (b - a);
    const jit = m => rf(-m, m);
    const col = (list, x, gap = 0.09) => {
      const y0 = 0.5 - (list.length - 1) * gap / 2;
      list.forEach((s, i) => { s._sx = x + jit(0.03); s._sy = y0 + i * gap + jit(0.02); });
    };

    if (type === "escort" || type === "transport") {
      // convoy huddles / strung out; raiders converge from outside (ambush
      // bursts from one flank on transport)
      const strung = type === "transport";
      players.forEach((s, i) => {
        const k = players.length > 1 ? i / (players.length - 1) : 0.5;
        s._sx = strung ? 0.15 + k * 0.5 : 0.42 + jit(0.08);
        s._sy = strung ? 0.65 - k * 0.25 : 0.48 + jit(0.08);
        if (s.role !== "convoy") { s._sx += jit(0.06); s._sy += (i % 2 ? 0.14 : -0.14); }
        s.path = [{ t: 0, x: s._sx, y: s._sy },
          { t: t2, x: s._sx + (strung ? 0.12 : 0.04) + jit(0.03), y: s._sy + jit(0.04) },
          { t: D, x: s._sx + (strung ? 0.3 : 0.08) + jit(0.05), y: s._sy + jit(0.06) }];
      });
      const flank = rng() < 0.5 ? 0.06 : 0.94;
      enemies.forEach((s, i) => {
        const a = strung ? 0 : (i / Math.max(1, enemies.length)) * Math.PI * 2 + rf(0, 0.6);
        const sx = strung ? 0.25 + rng() * 0.5 : 0.5 + Math.cos(a) * 0.52;
        const sy = strung ? flank : 0.5 + Math.sin(a) * 0.42;
        const tx = strung ? sx + 0.08 : 0.5 + Math.cos(a) * 0.2, ty = strung ? 0.48 : 0.5 + Math.sin(a) * 0.17;
        s.path = [{ t: 0, x: sx, y: sy }, { t: t2, x: tx, y: ty },
          { t: D, x: tx + jit(0.08), y: ty + jit(0.08) }];
      });
    } else if (type === "smuggle") {
      // a chase for the gate, pursuers cutting angles
      players.forEach((s, i) => {
        s.path = [{ t: 0, x: 0.08, y: 0.6 + jit(0.08) + i * 0.05 },
          { t: t2, x: 0.45 + jit(0.04), y: 0.5 + jit(0.06) },
          { t: D, x: 0.92, y: 0.34 + jit(0.05) }];
      });
      enemies.forEach((s, i) => {
        const high = i % 2 === 0;
        s.path = [{ t: 0, x: 0.04 + jit(0.04), y: high ? 0.2 : 0.88 },
          { t: t2, x: 0.5 + jit(0.06), y: high ? 0.36 : 0.66 },
          { t: D, x: 0.85 + jit(0.05), y: 0.4 + jit(0.06) }];
      });
    } else if (type === "assassinate") {
      // one ringed high-value target, you punch inward
      const big = enemies.reduce((a, b) => (a && a.size >= b.size ? a : b), enemies[0]);
      enemies.forEach((s, i) => {
        if (s === big) { s.path = [{ t: 0, x: 0.7, y: 0.5 }, { t: D, x: 0.74, y: 0.5 + jit(0.04) }]; return; }
        const a = (i / Math.max(1, enemies.length - 1)) * Math.PI * 2;
        s.path = [{ t: 0, x: 0.7 + Math.cos(a) * 0.11, y: 0.5 + Math.sin(a) * 0.11 },
          { t: t2, x: 0.62 + Math.cos(a) * 0.14, y: 0.5 + Math.sin(a) * 0.14 },
          { t: D, x: 0.6 + Math.cos(a) * 0.1, y: 0.5 + Math.sin(a) * 0.1 }];
      });
      col(players, 0.12);
      players.forEach(s => {
        s.path = [{ t: 0, x: s._sx, y: s._sy }, { t: t2, x: 0.42 + jit(0.04), y: s._sy * 0.4 + 0.3 },
          { t: D, x: 0.55 + jit(0.04), y: 0.5 + jit(0.08) }];
      });
    } else {
      // combat (default): two lines close and slug it out
      col(players, 0.14); col(enemies, 0.86);
      players.forEach(s => {
        const adv = s.role === "screen" ? 0.34 : s.role === "capital" ? 0.2 : 0.28;
        s.path = [{ t: 0, x: s._sx, y: s._sy }, { t: t2, x: s._sx + adv, y: s._sy + jit(0.05) },
          { t: D, x: s._sx + adv + 0.04, y: s._sy + jit(0.08) }];
      });
      enemies.forEach(s => {
        const adv = s.role === "screen" ? 0.34 : 0.26;
        s.path = [{ t: 0, x: s._sx, y: s._sy }, { t: t2, x: s._sx - adv, y: s._sy + jit(0.05) },
          { t: D, x: s._sx - adv - 0.04, y: s._sy + jit(0.08) }];
      });
    }
    // convoy hulls run for the edge when their line breaks (failure read)
    for (const s of players) if (s.role === "convoy" && !s.dead) {
      const last = s.path[s.path.length - 1];
      last.x = Math.min(1.05, last.x + 0.15);
    }
  },
};

window.Combat = Combat;
