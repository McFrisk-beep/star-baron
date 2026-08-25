/* combat.js — the battle choreographer (docs/LIVING_GALAXY.md §5).
   Pure: (report, roster, seed) → script. No DOM, no canvas — battleview.js
   renders the script. Choreography works BACKWARDS from the resolved report:
   ships in report.lost get a death beat, ships in report.damaged get hits
   summing exactly to their pct, untouched ships are never shown hit. Enemy
   losses are free variables — success reads as a rout, failure as your line
   breaking and falling back to the jump point. The movie must never disagree
   with the wallet.

   Script shape:
     { duration,                       // seconds
       ships: [{ id, side, name, type, sprite, size, role, shields,
                 path: [{t,x,y}...],  // unit-space waypoints, renderer lerps
                 deathT? }],
       events: [{ t, kind, from, to, dmg?, text? }] }   // sorted by t
   kinds: beam | missile | flak | shieldhit | shielddown | death | launch | say.
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

  // Ship radio, picked deterministically from the fight seed.
  LINES: {
    open:    ["Contacts on scope — weapons free.", "They're on us. All ships, engage!", "Form up. Here they come.", "Hostiles inbound — battle stations."],
    retreat: ["We're taking heavy damage — falling back!", "Break off! Regroup at the jump point!", "Too hot — get us out of here!"],
    wipe:    ["Mayday, mayday — we're going down!", "All hands, abandon ship!"],
    win:     ["Enemy line's broken — clean sweep.", "That's the last of them. Well fought.", "Hostiles routed. Securing the field."],
    pyrrhic: ["We won… barely. Tow the wrecks home.", "Victory. Count the cost later."],
    death:   ["Hull breach! We're going—", "Reactor's critical! Eject, ej—"],
    shields: ["Shields are down!", "Deflectors gone — brace for impact!"],
  },

  // Charters fight with the freight templates: smuggle heat on the risky
  // bands, plain transport otherwise (charters.js uses the same profiles).
  _type(r) {
    if (r.type !== "charter") return r.type;
    return (r.danger === "high" || r.danger === "extreme") ? "smuggle" : "transport";
  },

  // A report is watchable when an engagement actually happened (a clean
  // courier run has no scene) and the roster survived into the save.
  replayable(r) {
    if (!r || !Array.isArray(r.roster) || !r.roster.length) return false;
    if (!(typeof DMGCFG !== "undefined" && DMGCFG.types[this._type(r)])) return false;
    return !!((r.lost || []).length || (r.damaged || []).length
      || (r.impounded || []).length || !r.success
      || r.type === "combat" || r.type === "assassinate"
      || r.skirmish);   // voyage.js mid-flight events: non-decisive, always watchable
  },

  // Danger → fight scale. Duration scales with stakes (§5.3): a low-band
  // skirmish is a short brawl, an extreme engagement gets the full minute.
  _danger(d) {
    return { safe:     { dur: 30, n: [1, 2], tier: 0 },
             low:      { dur: 36, n: [2, 3], tier: 1 },
             moderate: { dur: 44, n: [3, 5], tier: 2 },
             high:     { dur: 52, n: [4, 6], tier: 3 },
             extreme:  { dur: 60, n: [5, 8], tier: 4 } }[d]
      || { dur: 40, n: [2, 4], tier: 1 };
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
    if (def.cls === "transport" || def.cls === "survey" || def.cls === "miner") return "convoy";
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
    const tmpl = this._type(report);

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
    if (!usable.length) usable.push({ id: "raider", name: "Raider", firepower: 15, hull: 90, armor: 15, shields: 5, speed: 1.8, sprite: "mechanim", tier: 0 });
    const nEnemies = Math.min(9, Math.max(1, ri(cfg.n[0], cfg.n[1]) + (players.length > 4 ? 1 : 0)));
    const enemies = [];
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
    const D = Math.max(6, Math.min(62, cfg.dur + Math.min(4, (players.length + enemies.length) * 0.25)));
    const t1 = D * 0.15, t2 = D * 0.35, t3 = D * 0.88;

    const ships = players.concat(enemies);
    this._paths(tmpl, players, enemies, D, t1, t2, rng);
    this._strafe(tmpl, players, enemies, D, t2, t3, rng);
    this._exits(tmpl, report, players, enemies, D, t3, rng);

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

    // shields: arcs early, then the collapse before the hull starts taking it
    for (const s of ships) {
      if (!s.shields || !(s.pct || s.dead)) continue;
      const end = Math.min(t2 + 2, s.deathT || t3);
      const hitT = +(rf(t1, Math.max(t1 + 0.5, end - 1))).toFixed(2);
      const foes = (s.side === "player" ? enemies : players).filter(f => this._live(f, hitT));
      if (foes.length) events.push({ t: hitT, kind: "shieldhit", from: pick(foes).id, to: s.id });
      const downT = +(Math.min(end, rf(t2, t2 + 2))).toFixed(2);
      events.push({ t: downT, kind: "shielddown", from: s.id, to: s.id });
      if (s.side === "player" && rng() < 0.5 && downT + 0.3 <= (s.deathT || Infinity))
        events.push({ t: +(downT + 0.3).toFixed(2), kind: "say", from: s.id, to: s.id, text: pick(this.LINES.shields) });
    }

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
        const a = enemies.filter(e => this._live(e, t));
        if (a.length) return { from: pick(a), t };
        const last = enemies.reduce((x, y) => ((x.deathT || 0) >= (y.deathT || 0) ? x : y));
        return { from: last, t: Math.max(0.4, +(last.deathT - 0.1).toFixed(2)) };
      };
      shares.forEach(v => {
        const h = shooter(+(rf(t2 * 0.9, end)).toFixed(2));
        events.push({ t: h.t, kind: this._weapon(h.from, rng), from: h.from.id, to: p.id, dmg: v });
      });
    }

    // kill volleys: 2–3 hard hits walk into each death beat (no dmg field —
    // the wallet accounting lives only on `damaged` ships)
    for (const s of dying) {
      const side = s.side === "player" ? enemies : players;
      const foes = side.filter(f => this._live(f, s.deathT));
      for (let i = ri(2, 3); i > 0 && foes.length; i--) {   // no live foe → the ring alone tells it
        const from = pick(foes);
        events.push({ t: +(Math.max(0.5, s.deathT - rf(0.15, 1.2))).toFixed(2), kind: this._weapon(from, rng), from: from.id, to: s.id });
      }
      if (s.side === "player" && !report.wipe && rng() < 0.6)
        events.push({ t: +(Math.max(0.4, s.deathT - 0.9)).toFixed(2), kind: "say", from: s.id, to: s.id, text: pick(this.LINES.death) });
      events.push({ t: s.deathT, kind: "death", from: s.id, to: s.id });
    }

    // ambient exchanges: everyone fires; near-misses (no dmg) are the only
    // fire that ever points at an untouched ship
    for (const s of ships) {
      if (s.role === "convoy") continue;
      const foes = s.side === "player" ? enemies : players;
      if (!foes.length) continue;
      const cadence = s.role === "screen" ? 0.9 : s.role === "capital" ? 2.2 : 1.4;
      const mine = Math.min(t3, s.deathT || t3, s.jumpT || t3);   // stop when it dies or jumps
      for (let t = t1 + rf(0, cadence); t < mine; t += cadence * rf(0.8, 1.3)) {
        const to = pick(foes.filter(f => this._live(f, t)));
        if (!to) break;
        const kind = this._weapon(s, rng);
        events.push({ t: +t.toFixed(2), kind, from: s.id, to: to.id });
        const cap = mine;
        if (kind === "missile" && rng() < 0.4 && t + 0.25 < cap)       // paired salvo
          events.push({ t: +(t + 0.25).toFixed(2), kind: "missile", from: s.id, to: to.id });
        if (s.role === "capital") {                                    // broadside walk
          if (t + 0.15 < cap) events.push({ t: +(t + 0.15).toFixed(2), kind: "beam", from: s.id, to: to.id });
          if (rng() < 0.7 && t + 0.3 < cap) events.push({ t: +(t + 0.3).toFixed(2), kind: "beam", from: s.id, to: to.id });
        }
      }
      // carriers put waves up across the engagement, not one burst at the top
      if (s.role === "carrier") {
        const last = Math.min(t3, s.deathT || t3, s.jumpT || t3);
        for (let i = 0, n = ri(3, 4); i < n; i++) {
          const at = +(rf(t1, Math.max(t1 + 0.5, last - 1))).toFixed(2);
          if (at < last) events.push({ t: at, kind: "launch", from: s.id, to: s.id });
        }
      }
    }

    // ---- radio: opening call + the outcome line -------------------------
    const outcome = report.wipe ? "wipe" : report.success
      ? (players.some(p => p.dead) ? "pyrrhic" : "flawless") : "loss";
    const talkers = players.filter(p => !p.dead);
    if (players.length)
      events.push({ t: +(t1 + rf(0, 1)).toFixed(2), kind: "say", from: players[0].id, to: players[0].id, text: pick(this.LINES.open) });
    if (outcome === "loss" && talkers.length)
      events.push({ t: +(t3 - rf(0.5, 1.5)).toFixed(2), kind: "say", from: pick(talkers).id, to: pick(talkers).id, text: pick(this.LINES.retreat) });
    else if (outcome === "wipe") {
      const last = players.reduce((a, b) => ((a.deathT || 0) >= (b.deathT || 0) ? a : b), players[0]);
      if (last) events.push({ t: +(Math.max(0.4, (last.deathT || t3) - 0.5)).toFixed(2), kind: "say", from: last.id, to: last.id, text: pick(this.LINES.wipe) });
    } else if (talkers.length)
      events.push({ t: +(t3 + rf(0.2, 0.8)).toFixed(2), kind: "say", from: pick(talkers).id, to: pick(talkers).id,
        text: pick(outcome === "pyrrhic" ? this.LINES.pyrrhic : this.LINES.win) });

    events.sort((a, b) => a.t - b.t);
    return {
      duration: +D.toFixed(2),
      outcome,
      ships: ships.map(s => ({ id: s.id, side: s.side, name: s.name, type: s.type,
        sprite: s.sprite, size: s.size, role: s.role, shields: s.shields,
        path: s.path, deathT: s.deathT, jumpT: s.jumpT })),
      events,
    };
  },

  // still on the field at t: not dead, not jumped out
  _live(s, t) { return (!s.deathT || s.deathT > t) && (!s.jumpT || s.jumpT > t); },

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
  // Fights happen at RANGE: lines stop well apart and duel across the gap;
  // only screens knife in close.
  _paths(type, players, enemies, D, t1, t2, rng) {
    const rf = (a, b) => a + rng() * (b - a);
    const jit = m => rf(-m, m);
    const col = (list, x, gap = 0.11) => {
      const y0 = 0.5 - (list.length - 1) * gap / 2;
      list.forEach((s, i) => { s._sx = x + jit(0.03); s._sy = y0 + i * gap + jit(0.02); });
    };

    if (type === "escort" || type === "transport") {
      // convoy huddles / strung out; raiders converge from outside (ambush
      // bursts from one flank on transport) but hold a firing ring
      const strung = type === "transport";
      players.forEach((s, i) => {
        const k = players.length > 1 ? i / (players.length - 1) : 0.5;
        s._sx = strung ? 0.15 + k * 0.5 : 0.42 + jit(0.08);
        s._sy = strung ? 0.65 - k * 0.25 : 0.48 + jit(0.08);
        if (s.role !== "convoy") { s._sx += jit(0.06); s._sy += (i % 2 ? 0.16 : -0.16); }
        s.path = [{ t: 0, x: s._sx, y: s._sy },
          { t: t2, x: s._sx + (strung ? 0.1 : 0.04) + jit(0.03), y: s._sy + jit(0.04) },
          { t: D, x: s._sx + (strung ? 0.24 : 0.08) + jit(0.05), y: s._sy + jit(0.06) }];
      });
      const flank = rng() < 0.5 ? 0.06 : 0.94;
      enemies.forEach((s, i) => {
        const a = strung ? 0 : (i / Math.max(1, enemies.length)) * Math.PI * 2 + rf(0, 0.6);
        const sx = strung ? 0.25 + rng() * 0.5 : 0.5 + Math.cos(a) * 0.52;
        const sy = strung ? flank : 0.5 + Math.sin(a) * 0.42;
        const tx = strung ? sx + 0.06 : 0.5 + Math.cos(a) * 0.3, ty = strung ? (flank < 0.5 ? 0.28 : 0.72) : 0.5 + Math.sin(a) * 0.26;
        s.path = [{ t: 0, x: sx, y: sy }, { t: t2, x: tx, y: ty },
          { t: D, x: tx + jit(0.08), y: ty + jit(0.08) }];
      });
    } else if (type === "smuggle") {
      // a chase for the gate, pursuers cutting angles from long range
      players.forEach((s, i) => {
        s.path = [{ t: 0, x: 0.06, y: 0.6 + jit(0.08) + i * 0.05 },
          { t: t2, x: 0.42 + jit(0.04), y: 0.5 + jit(0.06) },
          { t: D, x: 0.92, y: 0.34 + jit(0.05) }];
      });
      enemies.forEach((s, i) => {
        const high = i % 2 === 0;
        s.path = [{ t: 0, x: 0.04 + jit(0.04), y: high ? 0.12 : 0.92 },
          { t: t2, x: 0.44 + jit(0.06), y: high ? 0.28 : 0.74 },
          { t: D, x: 0.82 + jit(0.05), y: high ? 0.36 : 0.6 }];
      });
    } else if (type === "assassinate") {
      // one ringed high-value target, you punch inward but fight at range
      const big = enemies.reduce((a, b) => (a && a.size >= b.size ? a : b), enemies[0]);
      enemies.forEach((s, i) => {
        if (s === big) { s.path = [{ t: 0, x: 0.74, y: 0.5 }, { t: D, x: 0.78, y: 0.5 + jit(0.04) }]; return; }
        const a = (i / Math.max(1, enemies.length - 1)) * Math.PI * 2;
        s.path = [{ t: 0, x: 0.74 + Math.cos(a) * 0.12, y: 0.5 + Math.sin(a) * 0.12 },
          { t: t2, x: 0.62 + Math.cos(a) * 0.16, y: 0.5 + Math.sin(a) * 0.16 },
          { t: D, x: 0.6 + Math.cos(a) * 0.12, y: 0.5 + Math.sin(a) * 0.12 }];
      });
      col(players, 0.1);
      players.forEach(s => {
        s.path = [{ t: 0, x: s._sx, y: s._sy }, { t: t2, x: 0.34 + jit(0.04), y: s._sy * 0.4 + 0.3 },
          { t: D, x: 0.42 + jit(0.04), y: 0.5 + jit(0.1) }];
      });
    } else {
      // combat (default): two lines close to gun range and slug it out
      col(players, 0.1); col(enemies, 0.9);
      players.forEach(s => {
        const adv = s.role === "screen" ? 0.42 : s.role === "capital" ? 0.14 : 0.24;
        s.path = [{ t: 0, x: s._sx, y: s._sy }, { t: t2, x: s._sx + adv, y: s._sy + jit(0.05) },
          { t: D, x: s._sx + adv + 0.04, y: s._sy + jit(0.08) }];
      });
      enemies.forEach(s => {
        const adv = s.role === "screen" ? 0.42 : s.role === "capital" ? 0.14 : 0.24;
        s.path = [{ t: 0, x: s._sx, y: s._sy }, { t: t2, x: s._sx - adv, y: s._sy + jit(0.05) },
          { t: D, x: s._sx - adv - 0.04, y: s._sy + jit(0.08) }];
      });
    }
  },

  // ---- movement pass: circle and strafe through the attrition act ---------
  // Replaces each fighter's post-close drift with living movement: screens
  // circle, the line strafes laterally, capitals hold a slow drift. Convoy
  // hulls and smuggle runners keep their template paths (they're running).
  _strafe(tmpl, players, enemies, D, t2, t3, rng) {
    const rf = (a, b) => a + rng() * (b - a);
    const cl = v => Math.min(0.97, Math.max(0.03, v));
    if (tmpl === "smuggle") return;   // both sides are running — it's a chase
    for (const s of players.concat(enemies)) {
      if (s.role === "convoy") continue;
      const anchor = this._at(s, t2);
      s.path = s.path.filter(w => w.t < t2 || w.t === 0);
      s.path.push({ t: +t2.toFixed(2), x: anchor.x, y: anchor.y });
      const circle = s.role === "screen" || (s.role === "line" && rng() < 0.35);
      const dir = rng() < 0.5 ? 1 : -1;
      let ang = rf(0, Math.PI * 2);
      const r = s.role === "screen" ? rf(0.09, 0.15) : rf(0.05, 0.09);
      const step = s.role === "capital" ? rf(4.5, 6.5) : rf(2.4, 4);
      let flip = rng() < 0.5 ? 1 : -1;
      for (let t = t2 + step; t < D - 0.5; t += step * rf(0.85, 1.25)) {
        let x, y;
        if (s.role === "capital") { x = anchor.x + rf(-0.03, 0.03); y = anchor.y + rf(-0.03, 0.03); }
        else if (circle) { ang += dir * rf(0.9, 1.5); x = anchor.x + Math.cos(ang) * r; y = anchor.y + Math.sin(ang) * r; }
        else { flip = -flip; x = anchor.x + rf(-0.04, 0.04); y = anchor.y + flip * rf(0.06, 0.12); }   // strafing runs
        s.path.push({ t: +t.toFixed(2), x: cl(x), y: cl(y) });
      }
      const last = s.path[s.path.length - 1];
      s.path.push({ t: D, x: last.x, y: last.y });
    }
  },

  // ---- resolution act: survivors leave the field --------------------------
  // Nobody "flies off the edge": a ship that breaks contact turns onto its
  // escape vector, burns, and JUMPS — `jumpT` is when it lights the drive and
  // vanishes (the renderer plays the charge, the streak and the flash).
  // Loss: your survivors run and jump, pursuers hold the field. Success:
  // routed enemies jump out. Boarded smugglers don't get to leave at all.
  _exits(tmpl, report, players, enemies, D, t3, rng) {
    const rf = (a, b) => a + rng() * (b - a);
    const cl = v => Math.min(0.95, Math.max(0.05, v));
    const cut = (s, t, x, y, endT) => {
      const here = this._at(s, t);
      s.path = s.path.filter(w => w.t < t || w.t === 0);
      s.path.push({ t: +t.toFixed(2), x: here.x, y: here.y });
      s.path.push({ t: +(endT || D).toFixed(2), x, y });
    };
    // break off at t, run along the escape vector, light the drive at jumpT
    const jump = (s, t, dx, dy) => {
      const h = this._at(s, t);
      const jt = +Math.min(D - 0.2, t + rf(2.4, 3.4)).toFixed(2);
      cut(s, t, cl(h.x + dx), cl(h.y + dy), jt);
      s.jumpT = jt;
    };
    if (!report.success && !report.wipe) {
      const caught = tmpl === "smuggle" && (report.impounded || []).length;
      for (const s of players) {
        if (s.dead) continue;                            // death truncation handles them
        const t = t3 - rf(0, 1);
        if (caught) { const h = this._at(s, t); cut(s, t, h.x + rf(-0.02, 0.02), h.y + rf(-0.02, 0.02)); }  // boarded: held, no jump
        else jump(s, t, -rf(0.16, 0.26), rf(-0.06, 0.06));                                                  // break off and jump
      }
      for (const s of enemies) {
        if (s.dead) continue;
        const t = t3 + rf(0, 0.5), h = this._at(s, t);
        cut(s, t, h.x + rf(-0.04, 0.04), h.y + rf(-0.04, 0.04));   // hold the field
      }
    } else if (report.success) {
      for (const s of enemies) {
        if (s.dead) continue;
        const t = t3 - rf(0, 0.8), h = this._at(s, t);
        jump(s, t, (h.x > 0.5 ? 1 : -1) * rf(0.16, 0.26), rf(-0.08, 0.08));   // rout, then jump out
      }
      // a clean smuggling run makes the gate and jumps through it
      if (tmpl === "smuggle") for (const s of players) {
        if (s.dead) continue;
        s.jumpT = +(D - rf(0.3, 0.8)).toFixed(2);
        s.path = s.path.filter(w => w.t < s.jumpT || w.t === 0);
        s.path.push({ t: s.jumpT, x: 0.94, y: 0.34 + rf(-0.04, 0.04) });
      }
    }
  },
};

window.Combat = Combat;
