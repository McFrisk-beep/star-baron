/* encounters.js — canvas-first engagements (owner's direction).

   An ENCOUNTER is a deterministic description of a fight: who is on the
   field, where, over what window, and a shield/hull/projectile schedule that
   lands EXACTLY on the pre-rolled verdict. The canvas renders it; it never
   decides it — offline equals online and the server stays authoritative.

   Two ways in, one model:
     • LIVE — Encounters.active(now) derives fights from the piracy ops'
       stage clocks (boarding, shakedowns, police waves, the manhunt) and
       from mid-flight voyage events (raids, ambushes, gate runs, the
       arrival engagement of a combat contract), synced to the wall clock.
       The system scene draws them where they happen; there is no modal —
       miss it live and the dispatch/fleet report is the record.
     • REPLAY — Encounters.fromReport(r) rebuilds the identical fight from
       the report ALONE: the uid is the seed, the roster is your side,
       hauler/wave/enemyCount/faction/danger name theirs, and
       success/lost/damaged fix the verdict. Nothing new is stored anywhere.

   Every action renders through this one model: rob boardings, toll
   shakedowns, Senate patrol waves and manhunts, fleet combat, escort raids,
   smuggling gate runs, assassinations, transport ambushes, charters (which
   fight with the freight templates) and survey hazards.

   Snapshot space is a unit square around the fight's own centre; renderers
   scale it to pixels. All times are ms on whatever clock the caller uses. */

const Encounters = {
  s() { return window.Game && Game.state; },

  DUR: { boarding: 30000, wave: 40000, manhunt: 40000, toll: 24000,
    combat: 42000, escort: 38000, smuggle: 32000, assassinate: 44000,
    transport: 34000, survey: 30000 },

  // ---- descriptors ---------------------------------------------------------
  // {: uid, kind, sysId, t0, t1, sides: {you:[...], foe:[...]}, verdict }
  // A side entry: { name, type, sprite, size, hull, sh, convoy, runs, fate }
  // fate: "ok" | {dmg} | "dead"; runs: leaves the field near the end (a
  // convoy jump, a gate run, a survivor breaking off).
  _def(type) {
    const all = (typeof ALL_SHIPS !== "undefined") ? ALL_SHIPS : [];
    return all.find(d => d.id === type)
      || { id: type, cls: "escort", firepower: 20, hull: 110, armor: 20, shields: 10, speed: 1.6, sprite: "voidkin" };
  },
  _rng(uid, salt) { return Combat._mk(Combat.seedFrom(uid + "|" + salt)); },
  _size(hull) { return Math.max(0.05, Math.min(0.12, Math.sqrt(hull || 100) / 190)); },
  // The race hulls live under assets/raceships/, everything else under
  // assets/ships/ — pick the right prefix by name, not by caller guesswork.
  _races: { aurelian: 1, glorthi: 1, krell: 1, mechanim: 1, syndics: 1, voidkin: 1 },
  _spriteRef(sprite) { return (this._races[sprite] ? "race:" : "ship:") + (sprite || "shuttle"); },
  // Enemy flavour from the report's sponsor (same read combat scripts used).
  _flavour(faction) {
    if (faction === "police") return "police";
    if (faction === "syndicate") return "syndicate";
    if (faction === "free_trade" || faction === "mining_combine" || faction === "agri_collective") return "corporate";
    return "pirate";
  },
  _tier(danger) { return { safe: 0, low: 1, moderate: 2, high: 3, extreme: 4 }[danger] ?? 1; },

  _youSide(roster) {
    return (roster || []).slice(0, 6).map(p => {
      const d = this._def(p.type);
      return { name: p.name, type: p.type,
        sprite: (d.cls === "escort" ? "race:" : "ship:") + d.sprite,
        size: this._size(d.hull), hull: d.hull || 100, sh: d.shields || 0,
        convoy: d.cls === "transport" || d.cls === "survey" || d.cls === "miner",
        fate: "ok" };
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
      hull: hk ? 300 : 140, sh: 0, convoy: true, runs: true, fate: "ok" }];
    const guns = ((typeof ENEMY_CATALOG !== "undefined") ? ENEMY_CATALOG.corporate : []).filter(e => e.tier <= 1);
    const rng = this._rng(uid, "guns");
    for (let i = 1; i < count; i++) {
      const e = guns.length ? guns[Math.floor(rng() * guns.length)] : { id: "gun", name: "Escort", hull: 120, shields: 20, sprite: "mechanim" };
      side.push({ name: e.name, type: e.id, sprite: this._spriteRef(e.sprite),
        size: this._size(e.hull), hull: e.hull, sh: e.shields || 0, fate: "ok" });
    }
    return side;
  },
  // The opposition for a mission-shaped report, seeded from its uid: flavour
  // pool by sponsor, hulls capped at the danger band's tier.
  _foeSide(r) {
    const cat = (typeof ENEMY_CATALOG !== "undefined") ? ENEMY_CATALOG : {};
    const tier = this._tier(r.danger);
    const pool = (cat[this._flavour(r.faction)] || []).filter(e => e.tier <= tier);
    if (!pool.length) pool.push({ id: "raider", name: "Raider", hull: 90, shields: 5, sprite: "mechanim", tier: 0 });
    const rng = this._rng(r.uid, "foes");
    const n = Math.min(6, Math.max(1, r.enemyCount || ([2, 2, 3, 4, 5][tier] + Math.floor(rng() * 2))));
    return Array.from({ length: n }, () => {
      const e = pool[Math.floor(rng() * pool.length)];
      return { name: e.name, type: e.id, sprite: this._spriteRef(e.sprite),
        size: this._size(e.hull), hull: e.hull, sh: e.shields || 0,
        police: r.faction === "police", fate: "ok" };
    });
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
      kind = r.toll ? "toll" : "boarding";
      foe = this._haulerSide(r.hauler, Math.max(1, r.enemyCount || 2), r.uid);
      // hired guns die on a successful strip (seeded count, at least one);
      // a shakedown never kills anyone — the captain pays or you break off
      if (!r.toll && r.success && foe.length > 1) {
        const rng = this._rng(r.uid, "fates");
        for (let i = 1; i < foe.length; i++) if (i === 1 || rng() < 0.6) foe[i].fate = "dead";
      }
      if (r.toll && !r.success) for (const y of you) if (y.fate !== "dead") y.runs = true;
    } else if (r.police) {
      kind = "wave";
      foe = this._police(Math.max(2, r.enemyCount || 2), Math.min(r.wave || 0, 3));
      // success = the pairs broke; failure = they hold the field and you burn
      for (const f of foe) f.fate = r.success ? "dead" : "ok";
    } else {
      // mission / charter / survey shapes — charters fight with the freight
      // templates (smuggle heat on the risky bands, plain transport otherwise)
      const type = r.type === "charter"
        ? ((r.danger === "high" || r.danger === "extreme") ? "smuggle" : "transport")
        : r.type;
      if (!this.DUR[type] || type === "boarding" || type === "wave" || type === "manhunt") return null;
      kind = type;
      if (kind === "survey") {
        // a clean chart has no opposition; a hazard report fields the raider
        const rough = !r.success || (r.lost || []).length || (r.damaged || []).length;
        foe = rough ? this._foeSide({ ...r, enemyCount: r.enemyCount || 1, faction: null }) : [];
        for (const f2 of foe) if (r.success) f2.runs = true;
      } else {
        foe = this._foeSide(r);
        if (kind === "assassinate") {
          // the mark: the pool's biggest hull, ringed by the rest
          const cat = (typeof ENEMY_CATALOG !== "undefined") ? ENEMY_CATALOG : {};
          const pool = cat[this._flavour(r.faction)] || [];
          const big = pool[pool.length - 1] || { id: "mark", name: "Flag Cruiser", hull: 460, shields: 60, sprite: "leviathan" };
          foe.unshift({ name: big.name, type: big.id, sprite: this._spriteRef(big.sprite),
            size: this._size(big.hull), hull: big.hull, sh: big.shields || 0, target: true, fate: "ok" });
        }
        if (kind === "smuggle") {
          // a chase, not a brawl: cutters neither die nor let you kill them —
          // win and you jump the gate, lose and you're boarded where you drift
          if (r.success) for (const y of you) if (y.fate !== "dead") y.runs = true;
        } else if (r.success) {
          const rng = this._rng(r.uid, "fates");
          foe.forEach((f2, i) => { f2.fate = (i === 0 || rng() < 0.75) ? "dead" : "ok"; if (f2.fate === "ok") f2.runs = true; });
        } else {
          // the line breaks: your survivors burn for the jump point
          for (const y of you) if (y.fate !== "dead") y.runs = true;
        }
      }
    }
    return { uid: r.uid, kind, sysId: r.sysId || this._sysIdByName(r.sysName), t0: 0,
      t1: this.DUR[kind] || 30000, sides: { you, foe }, success: !!r.success };
  },
  _sysIdByName(name) {
    if (!name || !window.Galaxy || !Galaxy.list) return null;
    const sys = Galaxy.list.find(s => s.name === name);
    return sys ? sys.id : null;
  },

  // ---- live descriptors from the piracy stage clocks -----------------------
  active(now = Date.now()) {
    const out = [];
    const st = this.s();
    if (!st) return out;
    if (window.Piracy && window.Police) for (const op of st.piracy || []) {
      const sh = window.Fleet && Fleet.ship(op.shipUid);
      if (!sh) continue;
      const pre = Piracy.preview(op);
      const robEnd = Piracy.robEndAt(op), duelOn = Piracy.duelAt(op), settle = Piracy.settleAt(op);
      // the boarding / shakedown window
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
    // Mid-flight voyage events (§4): every fired, watchable event is a fight
    // window in the scene — a raid on an escort run, a transport ambush, a
    // gate run, a combat contract's arrival engagement. Non-decisive theater
    // with the run's own verdict; the settle still writes the only ledger.
    if (window.Voyages && Voyages.allEvents) for (const e of Voyages.allEvents()) {
      if (!e.watch || now < e.t || now >= e.t + 45000) continue;   // 45s ≥ every DUR — skip the cast build cheaply
      const r = this.skirmishReport(e);
      if (!r) continue;
      const enc = this.fromReport(r);
      if (!enc) continue;
      const D = enc.t1 - enc.t0;
      if (now >= e.t + D) continue;
      enc.t0 = e.t; enc.t1 = e.t + D;
      enc.sysId = this._eventSysId(e, now);
      if (enc.sysId) out.push(enc);
    }
    return out;
  },
  // A voyage event as a report shape (§4.4): the roster is the fleet, the
  // verdict is the run's own pre-rolled outcome, losses stay empty — the
  // skirmish is never decisive, the settle writes the ledger.
  skirmishReport(e) {
    const src = e.m || e.c;
    if (!src || !window.Fleet) return null;
    const uids = e.m ? e.m.shipUids : (window.Charters ? Charters.shipUids(e.c) : []);
    const roster = (uids || []).map(u => {
      const sh = Fleet.ship(u);
      return sh ? { uid: sh.uid, name: sh.name, type: sh.type } : null;
    }).filter(Boolean).slice(0, 6);
    if (!roster.length) return null;
    const type = e.m
      ? (e.kind === "toll" || e.kind === "customs" ? "smuggle"
        : e.kind === "raid" ? "escort" : e.kind === "ambush" ? "transport" : e.m.type)
      : ((e.c.band === "high" || e.c.band === "extreme") ? "smuggle" : "transport");
    const success = e.m
      ? (window.Missions && Missions.rolledSuccess ? Missions.rolledSuccess(e.m) : true)
      : (window.Charters && Charters.predictClean ? Charters.predictClean(e.c) : true);
    return { uid: "sk:" + e.id, skirmish: true, type,
      danger: e.m ? e.m.danger : e.c.band, faction: src.faction || null,
      success, lost: [], damaged: [], roster };
  },
  // Where the voyage is at the event's moment — the system the scene should
  // field the fight in (null mid-hyperspace: nowhere to draw it).
  _eventSysId(e, now) {
    if (!window.Voyages) return null;
    const src = e.m || e.c;
    const v = Voyages.active(Math.min(e.t, now)).find(x => x.mission === src || x.charter === src);
    if (v && v.at && v.at.a != null) {
      const ph = Voyages.legPhase(v.at.legP);
      if (ph.mode !== "hyper") return v.at.legP < 0.5 ? v.at.a : v.at.b;
      return null;
    }
    if (v && v.sysId) return v.sysId;
    return null;
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
    // stand-offs stay bloodless: an untouched hull in a shakedown, a chart
    // run or a gate chase takes no hits at all — the tension is the theater
    const bloodless = (enc.kind === "toll" || enc.kind === "survey") && !dead && hullEnd === 1;
    const shEnd = (dead || hullEnd < 1) ? 0 : ((s.convoy || bloodless) ? 1 : 0.25 + rng() * 0.5);
    const deathT = dead ? D * (0.55 + rng() * 0.3) : null;
    const end = deathT != null ? deathT : D * 0.9;
    const nHits = (s.convoy || bloodless) ? 0 : (2 + Math.floor(rng() * 3) + (dead ? 2 : 0));
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
  // Seeded near-miss fire so even a bloodless field reads as contested:
  // warning shots across a shaken-down bow, flak on a gate run, the escorts'
  // suppression fire. Cosmetic — misses by construction, never damage.
  _ambient(enc) {
    if (enc._amb) return enc._amb;
    const D = enc.t1 - enc.t0;
    const rng = this._rng(enc.uid, "amb");
    const out = [];
    const hasFoe = enc.sides.foe.some(f => !f.convoy);
    const wantFire = enc.kind === "toll" || hasFoe;
    const sparse = { toll: 2.6, survey: 2.2 }[enc.kind] || 1;
    if (wantFire) for (let t2 = D * 0.08; t2 < D * 0.85; t2 += (1100 + rng() * 2100) * sparse) {
      out.push({ t: t2, from: enc.kind === "toll" || !hasFoe ? "you" : (rng() < 0.5 ? "you" : "foe"),
        fi: Math.floor(rng() * 6), ti: Math.floor(rng() * 6),
        off: (rng() < 0.5 ? -1 : 1) * (0.05 + rng() * 0.08) });
    }
    return (enc._amb = out);
  },

  // ---- the renderable moment ----------------------------------------------
  // Unit square centred on 0.5/0.5. Renderers scale; identical for the scene
  // fight, the bench and every spectating client. Per-kind layouts: each
  // action reads as itself — a boarding ring, a duel arc, a convoy huddle, a
  // gate chase, a strike spiral, an ambushed column, a survey orbit.
  snapshot(enc, now) {
    const D = enc.t1 - enc.t0;
    const t = Math.max(0, Math.min(D, now - enc.t0));
    const f = D > 0 ? t / D : 0;
    const turn = (window.POLICECFG || {}).duelTurnMs || 18000;
    const th = (now % turn) / turn * Math.PI * 2;
    const K = enc.kind;
    const ships = [], shots = [], booms = [];
    const TAU = Math.PI * 2;
    const place = (side, i, n, entry) => {
      if (K === "toll") {
        // the shakedown: your hull rides the mark's flank; its guns hang back
        if (entry.convoy) return { x: 0.44 + f * 0.1, y: 0.52, ang: 0 };
        if (side === "you") return { x: 0.36 + f * 0.1, y: 0.33 + Math.sin(th * 2) * 0.015, ang: 0 };
        return { x: 0.3 - i * 0.07, y: 0.6 + i * 0.06, ang: 0.15 };
      }
      if (K === "boarding") {
        if (entry.convoy) return { x: 0.5, y: 0.5, ang: 0.3 };
        const base = side === "you" ? th : -th * 0.7 + Math.PI;
        const r = side === "you" ? 0.2 : 0.14 + i * 0.05;
        return { x: 0.5 + Math.cos(base + i) * r, y: 0.5 + Math.sin(base + i) * r,
          ang: Math.atan2(0.5 - (0.5 + Math.sin(base + i) * r), 0.5 - (0.5 + Math.cos(base + i) * r)) };
      }
      if (K === "escort") {
        if (entry.convoy) {
          const a = th * 0.5 + i * 2.4;
          return { x: 0.5 + Math.cos(a) * 0.06, y: 0.5 + Math.sin(a) * 0.05, ang: a + Math.PI / 2 };
        }
        if (side === "you") {
          const a = th + i * (TAU / Math.max(1, n));
          return { x: 0.5 + Math.cos(a) * 0.16, y: 0.5 + Math.sin(a) * 0.16, ang: a + Math.PI / 2 };
        }
        const a = -th * 0.8 + i * (TAU / Math.max(1, n));
        const r = 0.32 - f * 0.1;
        const x = 0.5 + Math.cos(a) * r, y = 0.5 + Math.sin(a) * r;
        return { x, y, ang: Math.atan2(0.5 - y, 0.5 - x) };
      }
      if (K === "smuggle") {
        // a running fight for the gate on the right; a failed run dies
        // mid-field and the cutters close on the drifting hulls
        const stop = enc.success ? 1 : 0.55;
        const lead = 0.1 + 0.75 * Math.min(f, stop);
        if (side === "you") {
          const y = 0.42 + (i - (n - 1) / 2) * 0.14;
          if (f >= stop) return { x: 0.1 + 0.75 * stop, y, ang: 0.4 + i };
          return { x: lead, y: y + Math.sin(t * 0.0016 + i * 2) * 0.05, ang: 0 };
        }
        const close = enc.success ? 0 : Math.max(0, f - stop) * 0.35;
        return { x: lead - 0.15 - i * 0.055 + close,
          y: 0.42 + (i - (n - 1) / 2) * 0.2 * (1 - close), ang: 0 };
      }
      if (K === "assassinate") {
        if (entry.target) return { x: 0.5 + Math.cos(th * 0.6) * 0.03, y: 0.5 + Math.sin(th * 0.6) * 0.03, ang: th * 0.6 };
        if (side === "foe") {
          const a = th * 0.9 + i * (TAU / Math.max(1, n - 1));
          return { x: 0.5 + Math.cos(a) * 0.15, y: 0.5 + Math.sin(a) * 0.15, ang: a + Math.PI / 2 };
        }
        // the strike spirals in through the screen toward the mark
        const a = -th * 0.7 + i * 0.9;
        const r = 0.36 - 0.22 * f;
        const x = 0.5 + Math.cos(a) * r, y = 0.5 + Math.sin(a) * r;
        return { x, y, ang: Math.atan2(0.5 - y, 0.5 - x) };
      }
      if (K === "transport") {
        if (side === "you") return { x: 0.12 + 0.6 * f, y: 0.34 + i * 0.12, ang: 0 };
        const a = -th + i * (TAU / Math.max(1, n));
        return { x: 0.55 + Math.cos(a) * 0.34, y: 0.38 + Math.sin(a) * 0.24, ang: a - Math.PI / 2 };
      }
      if (K === "survey") {
        if (side === "you") {
          const a = th * 0.6 + i * 1.5;
          return { x: 0.5 + Math.cos(a) * 0.16, y: 0.5 + Math.sin(a) * 0.13, ang: a + Math.PI / 2 };
        }
        const a = -th * 1.2 + i * 2.5;
        return { x: 0.5 + Math.cos(a) * 0.38, y: 0.5 + Math.sin(a) * 0.18, ang: a - Math.PI / 2 };
      }
      // wave / manhunt / combat: the duel arc — two lines circling the field,
      // fanned wide enough that a four-hull line reads as a line
      const arc = side === "you" ? th : th + Math.PI;
      const off = n > 1 ? (i - (n - 1) / 2) * Math.min(0.5, 1.6 / (n - 1)) : 0;
      const r = 0.24 + (i % 2) * 0.06;
      const x = 0.5 + Math.cos(arc + off) * r, y = 0.5 + Math.sin(arc + off) * r;
      return { x, y, ang: arc + Math.PI / 2 };
    };
    for (const side of ["you", "foe"]) {
      const list = enc.sides[side];
      list.forEach((s, i) => {
        const plan = s._plan || (s._plan = this._plan(enc, side, i));
        const hp = this._hp(plan, t);
        if (hp.dead) {
          const age = t - plan.deathT;
          if (age < 2600) booms.push({ ...place(side, i, list.length, s), age: age / 2600, size: s.size });
          return;
        }
        const pos = place(side, i, list.length, s);
        // runners break for their jump at the end (the hauler always, others
        // only when the verdict says they got away)
        if (s.runs && t > D * 0.8) {
          const g = (t - D * 0.8) / (D * 0.2);
          pos.x += g * 0.5; pos.ang = 0;
          if (g > 0.92) return;                         // jumped clear
        }
        // recent-hit heat for the renderer: shield arcs vs hull sparks
        let lastHit = -1, done = 0;
        for (const h of plan.hits) if (t >= h) { done++; lastHit = h; }
        const fl = lastHit >= 0 ? Math.max(0, 1 - (t - lastHit) / 320) : 0;
        ships.push({ side, name: s.name, sprite: s.sprite, size: s.size,
          convoy: !!s.convoy, police: !!s.police, target: !!s.target,
          x: pos.x, y: pos.y, ang: pos.ang,
          sh: hp.sh, hull: hp.hull, fl, flSh: fl > 0 && done <= plan.shHits && hp.sh > 0 });
        // a shot lands on each scheduled hit: draw the incoming beam briefly
        for (const h of plan.hits) {
          if (t >= h - 350 && t < h + 120) {
            const other = side === "you" ? "foe" : "you";
            const from = enc.sides[other].find(f2 => !f2.convoy);
            if (from) {
              const fi = enc.sides[other].indexOf(from);
              const fp = place(other, fi, enc.sides[other].length, from);
              shots.push({ x1: fp.x, y1: fp.y, x2: pos.x, y2: pos.y,
                side: other, f: (t - (h - 350)) / 470 });
            }
          }
        }
      });
    }
    // seeded near-misses keep the field loud even when nobody is bleeding
    for (const a of this._ambient(enc)) {
      if (t < a.t - 350 || t >= a.t + 120) continue;
      const from = enc.sides[a.from], to = enc.sides[a.from === "you" ? "foe" : "you"];
      if (!from.length || !to.length) continue;
      const shoot = from.filter(s => !s.convoy);
      const su = shoot.length ? shoot[a.fi % shoot.length] : null;
      const tu = to[a.ti % to.length];
      if (!su || !tu) continue;
      const sp = su._plan, tp = tu._plan;
      if ((sp && sp.deathT != null && t >= sp.deathT) || (tp && tp.deathT != null && t >= tp.deathT)) continue;
      const p1 = place(a.from, enc.sides[a.from].indexOf(su), from.length, su);
      const p2 = place(a.from === "you" ? "foe" : "you", to.indexOf(tu), to.length, tu);
      shots.push({ x1: p1.x, y1: p1.y, x2: p2.x + a.off, y2: p2.y - a.off,
        side: a.from, miss: true, f: (t - (a.t - 350)) / 470 });
    }
    return { t, D, f, kind: K, success: enc.success, ships, shots, booms, done: t >= D };
  },

  // ---- cross-player fights (docs/sql/encounter_presence.sql) ---------------
  // Fights are deterministic, so a spectator needs only the DESCRIPTION. A
  // baron's client posts one row per engagement window IN ADVANCE (everything
  // is pre-rolled), other clients poll about once a minute and replay the
  // identical fight from the seed when the clock enters the window. No table
  // → feature quietly off, like flagship presence.
  _remote: [], _remAt: 0, _remMissing: false, _pub: {},
  _mpOn() {
    return !!(window.Cloud && Cloud.enabled && Cloud.client
      && Cloud.signedIn && Cloud.signedIn()) && !this._remMissing;
  },
  // Report-shaped params, with roster uids anonymised (r0, r1…) so nothing
  // internal leaks; lost/damaged remap onto the same fake uids.
  _params(r) {
    const map = {};
    const roster = (r.roster || []).slice(0, 6).map((p, i) => {
      map[p.uid] = "r" + i;
      return { uid: "r" + i, name: String(p.name || "Hull").slice(0, 24), type: p.type };
    });
    return {
      police: !!r.police, wave: r.wave || 0, hauler: r.hauler || null, toll: !!r.toll,
      enemyCount: r.enemyCount || 2, success: !!r.success, wipe: !!r.wipe,
      roster,
      lost: (r.lost || []).map(x => ({ uid: map[x.uid] || "r0", name: String(x.name || "").slice(0, 24) })),
      damaged: (r.damaged || []).map(x => ({ uid: map[x.uid] || "r0", name: String(x.name || "").slice(0, 24), pct: x.pct || 0 })),
    };
  },
  // Every window one of my ops will fight — pre-rolled, so postable at dispatch.
  _windowsFor(op) {
    const sh = window.Fleet && Fleet.ship(op.shipUid);
    if (!sh || !window.Piracy || !window.Police) return [];
    const out = [];
    const pre = Piracy.preview(op);
    const robEnd = Piracy.robEndAt(op), duelOn = Piracy.duelAt(op);
    if (op.verb !== "escort") {
      const r = Piracy.previewReport(op);
      // ponytail: the table's kind check only knows boarding/wave/manhunt —
      // a shakedown posts as "boarding" and params.toll carries the truth,
      // so deployed tables keep working without a migration.
      if (r) out.push({ enc_id: r.uid, kind: "boarding", t0: op.resolveAt, t1: robEnd, params: this._params(r) });
    }
    if (pre.chase) {
      const gap = (window.POLICECFG || {}).waveGapMs || 40000;
      pre.chase.waves.forEach((w, i) => {
        if (!w.destroyed && !w.caught) return;
        const wr = Police.previewWaveReport(op, sh, i);
        if (wr) out.push({ enc_id: wr.uid, kind: "wave", t0: duelOn + i * gap, t1: duelOn + (i + 1) * gap, params: this._params(wr) });
      });
    }
    const mhAt = Piracy.manhuntAt(op);
    if (!op.mh && mhAt !== Infinity) {
      const mr = Police.previewManhuntReport(op, sh);
      if (mr) out.push({ enc_id: mr.uid, kind: "manhunt", t0: mhAt, t1: Piracy.manhuntEndAt(op), params: this._params(mr) });
    }
    return out.map(w => ({ ...w, sys_id: op.sysId }));
  },
  // Publish + poll, self-throttled to about a minute — call from the main
  // loop; it is safe to call every tick.
  async sync(now = Date.now()) {
    if (!this._mpOn() || now - this._remAt < 60000) return;
    this._remAt = now;
    try {
      const me = Cloud.user() ? String(Cloud.user().id) : null;
      // publish my windows (once per enc id per session)
      const rows = [];
      for (const op of (this.s() || {}).piracy || []) {
        for (const w of this._windowsFor(op)) {
          if (this._pub[w.enc_id]) continue;
          this._pub[w.enc_id] = true;
          rows.push({ user_id: me, enc_id: w.enc_id, kind: w.kind, sys_id: w.sys_id,
            t0: Math.round(w.t0), t1: Math.round(w.t1), params: w.params,
            display: (window.Voyages ? Voyages.playerName() : "Baron").slice(0, 24),
            updated_at: new Date().toISOString() });
        }
      }
      if (rows.length) await Cloud.client.from("encounter_presence").upsert(rows);
      // sweep my finished rows
      await Cloud.client.from("encounter_presence").delete()
        .eq("user_id", me).lt("t1", now - 60000);
      // fetch everyone's live-or-upcoming windows
      const { data, error } = await Cloud.client.from("encounter_presence")
        .select("user_id,enc_id,display,kind,sys_id,t0,t1,params")
        .gt("t1", now - 5000).limit(200);
      if (error) throw error;
      this._remote = (data || []).filter(r => String(r.user_id) !== me);
    } catch (e) {
      const msg = String((e && (e.message || e)) || e);
      if (/encounter_presence|does not exist|relation|PGRST/i.test(msg)) this._remMissing = true;
    }
  },
  // Other barons' fights whose window the clock is inside — the same
  // descriptor shape active() yields, tagged remote with the baron's name.
  remoteActive(now = Date.now()) {
    const out = [];
    for (const r of this._remote) {
      if (now < r.t0 || now >= r.t1) continue;
      const p = r.params || {};
      const rep = { uid: String(r.enc_id), sysId: r.sys_id, police: p.police, wave: p.wave,
        hauler: p.hauler, toll: p.toll, enemyCount: p.enemyCount, success: p.success, wipe: p.wipe,
        roster: p.roster, lost: p.lost, damaged: p.damaged };
      const e = this.fromReport(rep);
      if (!e) continue;
      e.t0 = r.t0; e.t1 = r.t1; e.sysId = r.sys_id;
      e.remote = true; e.display = String(r.display || "Baron").slice(0, 24);
      e.kind = r.kind === "manhunt" ? "manhunt" : e.kind;
      // the scene anchors fights by the op id — strip the stage suffix
      e.anchorSeed = String(r.enc_id).replace(/(rob|w\d+|mh\d+)$/, "");
      out.push(e);
    }
    return out;
  },
};

window.Encounters = Encounters;
