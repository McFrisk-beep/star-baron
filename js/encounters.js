/* encounters.js — canvas-first engagements (owner's direction).

   An ENCOUNTER is a deterministic description of a fight: who is on the
   field, where, over what window, and a shield/hull/projectile schedule that
   lands EXACTLY on the pre-rolled verdict. The canvas renders it; it never
   decides it — offline equals online and the server stays authoritative.

   Two ways in, one model:
     • LIVE — Encounters.active(now) derives fights from the piracy ops'
       stage clocks (boarding, police waves, the manhunt), synced to the
       wall clock. The system scene draws them small; the zoom view draws
       the same snapshot big.
     • REPLAY — Encounters.fromReport(r) rebuilds the identical fight from
       the report ALONE: the uid is the seed, the roster is your side,
       hauler/wave/enemyCount name theirs, success/lost/damaged fix the
       verdict. Nothing new is stored anywhere, so server-filed reports
       replay too.

   Snapshot space is a unit square around the fight's own centre; renderers
   scale it to pixels. All times are ms on whatever clock the caller uses. */

const Encounters = {
  s() { return window.Game && Game.state; },

  DUR: { boarding: 30000, wave: 40000, manhunt: 40000 },

  // ---- descriptors ---------------------------------------------------------
  // {: uid, kind, sysId, t0, t1, sides: {you:[...], foe:[...]}, verdict }
  // A side entry: { name, type, sprite, size, hull, sh, convoy, fate }
  // fate: "ok" | {dmg} | "dead" | "jump"
  _def(type) {
    const all = (typeof ALL_SHIPS !== "undefined") ? ALL_SHIPS : [];
    return all.find(d => d.id === type)
      || { id: type, cls: "escort", firepower: 20, hull: 110, armor: 20, shields: 10, speed: 1.6, sprite: "voidkin" };
  },
  _rng(uid, salt) { return Combat._mk(Combat.seedFrom(uid + "|" + salt)); },
  _size(hull) { return Math.max(0.05, Math.min(0.12, Math.sqrt(hull || 100) / 190)); },

  _youSide(roster) {
    return (roster || []).slice(0, 4).map(p => {
      const d = this._def(p.type);
      return { name: p.name, type: p.type,
        sprite: (d.cls === "escort" ? "race:" : "ship:") + d.sprite,
        size: this._size(d.hull), hull: d.hull || 100, sh: d.shields || 0, fate: "ok" };
    });
  },
  _police(n, tier) {
    const pool = (typeof ENEMY_CATALOG !== "undefined") ? ENEMY_CATALOG.police : [];
    const e = pool[Math.min(tier, pool.length - 1)] || { id: "pol", name: "Patrol", hull: 130, shields: 28, sprite: "voidkin" };
    return Array.from({ length: n }, () => ({ name: e.name, type: e.id,
      sprite: "race:" + e.sprite, size: this._size(e.hull),
      hull: e.hull, sh: e.shields || 0, police: true, fate: "ok" }));
  },
  _haulerSide(hauler, count, uid) {
    const hk = hauler.kind === "freighter";
    const side = [{ name: hauler.name || "Hauler", type: hk ? "freighter" : "trader",
      sprite: hk ? "ship:freighter" : "ship:shuttle", size: this._size(hk ? 300 : 140),
      hull: hk ? 300 : 140, sh: 0, convoy: true, fate: "jump" }];
    const guns = ((typeof ENEMY_CATALOG !== "undefined") ? ENEMY_CATALOG.corporate : []).filter(e => e.tier <= 1);
    const rng = this._rng(uid, "guns");
    for (let i = 1; i < count; i++) {
      const e = guns.length ? guns[Math.floor(rng() * guns.length)] : { id: "gun", name: "Escort", hull: 120, shields: 20, sprite: "mechanim" };
      side.push({ name: e.name, type: e.id, sprite: "ship:" + e.sprite,
        size: this._size(e.hull), hull: e.hull, sh: e.shields || 0, fate: "ok" });
    }
    return side;
  },

  // The report IS the encounter (uid = seed, fields = cast + verdict).
  fromReport(r) {
    if (!r || !Array.isArray(r.roster) || !r.roster.length) return null;
    const you = this._youSide(r.roster);
    const lostIds = new Set((r.lost || []).map(x => x.uid));
    const dmgBy = {};
    for (const d of r.damaged || []) dmgBy[d.uid] = (d.pct || 0) / 100;
    r.roster.forEach((p, i) => {
      if (!you[i]) return;
      you[i].fate = (lostIds.has(p.uid) || r.wipe) ? "dead" : dmgBy[p.uid] ? { dmg: dmgBy[p.uid] } : "ok";
    });
    let kind, foe;
    if (r.hauler) {
      kind = "boarding";
      foe = this._haulerSide(r.hauler, Math.max(1, r.enemyCount || 2), r.uid);
      // hired guns die on a successful strip (seeded count, at least one)
      if (r.success && foe.length > 1) {
        const rng = this._rng(r.uid, "fates");
        for (let i = 1; i < foe.length; i++) if (i === 1 || rng() < 0.6) foe[i].fate = "dead";
      }
    } else if (r.police) {
      kind = "wave";
      foe = this._police(Math.max(2, r.enemyCount || 2), Math.min(r.wave || 0, 3));
      // success = the pairs broke; failure = they hold the field and you burn
      for (const f of foe) f.fate = r.success ? "dead" : "ok";
    } else return null;   // missions/charters keep the legacy path for now
    return { uid: r.uid, kind, sysId: r.sysId || null, t0: 0,
      t1: this.DUR[kind] || 30000, sides: { you, foe }, success: !!r.success };
  },

  // ---- live descriptors from the piracy stage clocks -----------------------
  active(now = Date.now()) {
    const out = [];
    const st = this.s();
    if (!st || !window.Piracy || !window.Police) return out;
    for (const op of st.piracy || []) {
      const sh = window.Fleet && Fleet.ship(op.shipUid);
      if (!sh) continue;
      const roster = [{ uid: sh.uid, name: sh.name, type: sh.type }];
      const pre = Piracy.preview(op);
      const robEnd = Piracy.robEndAt(op), duelOn = Piracy.duelAt(op), settle = Piracy.settleAt(op);
      // the boarding window
      if (op.verb !== "escort" && now >= op.resolveAt && now < robEnd) {
        const r = Piracy.previewReport(op);
        if (r) {
          const e = this.fromReport(r);
          if (e) { e.t0 = op.resolveAt; e.t1 = robEnd; e.op = op; out.push(e); }
        }
      }
      // the police waves, one after another on the wave clock
      if (pre.chase && now >= duelOn && now < settle) {
        const gap = (window.POLICECFG || {}).waveGapMs || 40000;
        const w = Math.min(pre.chase.waves.length - 1, Math.floor((now - duelOn) / gap));
        const wr = Police.previewWaveReport(op, sh, w);
        if (wr) {
          const e = this.fromReport(wr);
          if (e) { e.t0 = duelOn + w * gap; e.t1 = e.t0 + gap; e.op = op; out.push(e); }
        }
      }
      // the manhunt interception on the way out
      const mhAt = Piracy.manhuntAt(op);
      if (!op.mh && mhAt !== Infinity && now >= mhAt && now < Piracy.manhuntEndAt(op)) {
        const mr = Police.previewManhuntReport(op, sh);
        if (mr) {
          const e = this.fromReport(mr);
          if (e) { e.t0 = mhAt; e.t1 = Piracy.manhuntEndAt(op); e.kind = "manhunt"; e.op = op; out.push(e); }
        }
      }
    }
    return out;
  },

  // ---- the schedule: shields, hull and shots that land on the verdict ------
  // Pure of (encounter uid, ship index). Shield drains first, then hull, in
  // seeded steps timed so the END state is exactly the verdict — the bars are
  // theater with a fixed ending.
  _plan(enc, side, i) {
    const s = enc.sides[side][i];
    const D = enc.t1 - enc.t0;
    const rng = this._rng(enc.uid, side + i);
    const dead = s.fate === "dead";
    const hullEnd = dead ? 0 : (s.fate && s.fate.dmg ? Math.max(0.05, 1 - s.fate.dmg) : 1);
    const shEnd = (dead || hullEnd < 1) ? 0 : (s.convoy ? 1 : 0.25 + rng() * 0.5);
    const deathT = dead ? D * (0.55 + rng() * 0.3) : null;
    const end = deathT != null ? deathT : D * 0.9;
    const nHits = s.convoy ? 0 : (2 + Math.floor(rng() * 3) + (dead ? 2 : 0));
    const hits = Array.from({ length: nHits }, () => D * 0.1 + rng() * (end - D * 0.1)).sort((a, b) => a - b);
    // quanta: shields absorb the first hits, hull takes the rest
    const shDrop = (1 - shEnd), huDrop = (1 - hullEnd);
    const shHits = Math.ceil(nHits * (shDrop > 0 ? Math.min(0.6, shDrop) : 0));
    return { hits, deathT, shEnd, hullEnd, shHits };
  },
  // {sh, hull, dead} at local time t (0..D)
  _hp(plan, t) {
    let done = 0;
    for (const h of plan.hits) if (t >= h) done++;
    const shTaken = Math.min(done, plan.shHits);
    const huTaken = Math.max(0, done - plan.shHits);
    const nHu = Math.max(1, plan.hits.length - plan.shHits);
    const sh = plan.shHits ? 1 - (1 - plan.shEnd) * (shTaken / plan.shHits) : 1;
    const hull = 1 - (1 - plan.hullEnd) * Math.min(1, huTaken / nHu);
    const dead = plan.deathT != null && t >= plan.deathT;
    return { sh: dead ? 0 : sh, hull: dead ? 0 : hull, dead };
  },

  // ---- the renderable moment ----------------------------------------------
  // Unit square centred on 0.5/0.5. Renderers scale; identical for the scene
  // dot-fight, the zoom view and every spectating client.
  snapshot(enc, now) {
    const D = enc.t1 - enc.t0;
    const t = Math.max(0, Math.min(D, now - enc.t0));
    const turn = (window.POLICECFG || {}).duelTurnMs || 18000;
    const th = (now % turn) / turn * Math.PI * 2;
    const ships = [], shots = [], booms = [];
    const place = (side, i, n, entry) => {
      if (enc.kind === "boarding") {
        if (entry.convoy) return { x: 0.5, y: 0.5, ang: 0.3 };
        const base = side === "you" ? th : -th * 0.7 + Math.PI;
        const r = side === "you" ? 0.2 : 0.14 + i * 0.05;
        return { x: 0.5 + Math.cos(base + i) * r, y: 0.5 + Math.sin(base + i) * r,
          ang: Math.atan2(0.5 - (0.5 + Math.sin(base + i) * r), 0.5 - (0.5 + Math.cos(base + i) * r)) };
      }
      const arc = side === "you" ? th : th + Math.PI;
      const spread = (i - (n - 1) / 2) * 0.5;
      const r = 0.22;
      const x = 0.5 + Math.cos(arc + spread * 0.35) * r, y = 0.5 + Math.sin(arc + spread * 0.35) * r;
      return { x, y, ang: arc + Math.PI / 2 };
    };
    for (const side of ["you", "foe"]) {
      const list = enc.sides[side];
      list.forEach((s, i) => {
        const plan = s._plan || (s._plan = this._plan(enc, side, i));
        const hp = this._hp(plan, t);
        if (hp.dead) {
          const age = t - plan.deathT;
          if (age < 2600) booms.push({ ...place(side, i, list.length, s), age: age / 2600 });
          return;
        }
        // the hauler runs for its jump at the end, win or lose
        const pos = place(side, i, list.length, s);
        if (s.convoy && t > D * 0.8) {
          const f = (t - D * 0.8) / (D * 0.2);
          pos.x += f * 0.5; pos.ang = 0;
          if (f > 0.92) return;                         // jumped clear
        }
        ships.push({ side, name: s.name, sprite: s.sprite, size: s.size,
          convoy: !!s.convoy, police: !!s.police, x: pos.x, y: pos.y, ang: pos.ang,
          sh: hp.sh, hull: hp.hull });
        // a shot lands on each scheduled hit: draw the incoming beam briefly
        for (const h of plan.hits) {
          if (t >= h - 350 && t < h + 120) {
            const from = enc.sides[side === "you" ? "foe" : "you"].find(f2 => !f2.convoy);
            if (from) {
              const fi = enc.sides[side === "you" ? "foe" : "you"].indexOf(from);
              const fp = place(side === "you" ? "foe" : "you", fi, enc.sides[side === "you" ? "foe" : "you"].length, from);
              shots.push({ x1: fp.x, y1: fp.y, x2: pos.x, y2: pos.y, f: (t - (h - 350)) / 470 });
            }
          }
        }
      });
    }
    return { t, D, ships, shots, booms, done: t >= D };
  },
};

window.Encounters = Encounters;
