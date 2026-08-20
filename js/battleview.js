/* battleview.js — canvas playback for Combat scripts (LIVING_GALAXY.md §5).
   Dumb renderer: reads the script, draws frames. All effects are canvas
   primitives — layered gradient beams, tracer flak, missiles with particle
   trails, expanding-ring deaths, arc shield hits and shield collapses, armor
   chunks knocked off on impacts, and wreck hulks that keep drifting after a
   kill. The scene plays over the system's own nebula backdrop with a seeded
   asteroid/dust field so space reads lived-in. No sprite sheets, no new art. */

const BattleView = {
  _imgs: {}, raf: null, script: null, report: null,

  s() { return window.Game.state; },
  img(url) {
    let im = this._imgs[url];
    if (!im) { im = new Image(); im.onload = () => { im.ok = true; }; im.src = url; this._imgs[url] = im; }
    return im;
  },
  _sprite(ref) {
    const [kind, id] = String(ref || "ship:shuttle").split(":");
    return this.img(kind === "race" ? ASSET.raceship(id) : ASSET.ship(id));
  },

  _els() {
    if (this._el) return this._el;
    this._el = {
      modal: document.getElementById("battle-modal"),
      title: document.getElementById("battle-title"),
      canvas: document.getElementById("battle-canvas"),
      skip: document.getElementById("battle-skip"),
    };
    this._el.skip.addEventListener("click", () => this.skip());
    this._el.modal.addEventListener("click", e => { if (e.target === this._el.modal) this.skip(); });
    return this._el;
  },

  // The engagement happened SOMEWHERE — use that system's own space backdrop
  // (admin spacebg override, else its sector nebula), falling back to a
  // seeded nebula so even unmapped fights get sky.
  _backdrop(report, seed) {
    const sys = (window.Galaxy && report.sysName)
      ? Galaxy.list.find(s => s.name === report.sysName) : null;
    if (sys) return { img: this.img(ASSET.spacebg(sys.id) || ASSET.nebula(sys.nebula)), belt: !!sys.asteroidBelt };
    const nebs = ["void", "blue", "green", "gold", "red", "purple"];
    return { img: this.img(ASSET.nebula(nebs[seed % nebs.length])), belt: (seed >> 3) % 2 === 0 };
  },

  // opts.offered: playback the game offered (not an explicit ▶ Replay click) —
  // skipping one of those early remembers the preference (§5.7).
  open(report, opts = {}) {
    if (!window.Combat || !Combat.replayable(report)) return;
    const el = this._els();
    this.report = report; this._offered = !!opts.offered;
    const seed = Combat.seedFrom(report.uid);
    this.script = Combat.script(report, report.roster);
    el.title.textContent = `⚔ ${report.title}`;
    el.skip.textContent = "Skip ▸";
    el.modal.classList.remove("hidden");

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = el.canvas.getBoundingClientRect();
    el.canvas.width = Math.max(320, Math.round(r.width * dpr));
    el.canvas.height = Math.max(240, Math.round(r.height * dpr));
    const ctx = el.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = el.canvas.width / dpr; this._h = el.canvas.height / dpr;

    // seeded scenery: stars, dust, asteroid field (denser on belt systems)
    const srng = Combat._mk(seed ^ 0x5ce7e);
    this._bg = this._backdrop(report, seed);
    this._asterImg = this.img(ASSET.asteroids());
    this._stars = Array.from({ length: 80 }, () => ({ x: srng(), y: srng(), b: srng() }));
    this._dust = Array.from({ length: 26 }, () => ({ x: srng(), y: srng(), vx: (srng() - 0.5) * 3, vy: (srng() - 0.5) * 3, a: 0.08 + srng() * 0.2, s: 1 + srng() * 1.6 }));
    const nRocks = (this._bg.belt ? 16 : 8) + Math.floor(srng() * 5);
    // Rocks hold station: they bob around a fixed home and tumble slowly
    // rather than translating off the field (drifting + wrapping read as
    // "flying away and popping back"). Weapons chip and shatter them below.
    this._rocks = Array.from({ length: nRocks }, () => {
      const s = 10 + srng() * 22;
      return { hx: srng() * this._w, hy: srng() * this._h, x: 0, y: 0,
        phase: srng() * 6.28, bob: 3 + srng() * 7,
        wx: 0.13 + srng() * 0.22, wy: 0.11 + srng() * 0.2,
        rot: srng() * 6.28, vr: (srng() - 0.5) * 0.22, s, a: 0.35 + srng() * 0.4,
        hp: Math.max(1, Math.round(s / 9)), flash: -9 };
    });

    this._beams = []; this._missiles = []; this._flak = []; this._rings = [];
    this._arcs = []; this._parts = []; this._fighters = []; this._wrecks = [];
    this._bubbles = []; this._collapses = [];
    this._evIdx = 0; this._done = false; this._byId = null; this._lastT = 0;
    this._hdg = {}; this._jumps = [];

    const reduced = !!(this.s().settings && this.s().settings.reduced);
    this._t0 = performance.now();
    if (reduced) { this._drawFrame(ctx, this.script.duration + 99); this._finish(); return; }
    const loop = now => {
      const t = (now - this._t0) / 1000;
      this._drawFrame(ctx, t);
      if (t > this.script.duration + 1.0 && !this._done) this._finish();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  },

  _finish() {
    this._done = true;
    this._els().skip.textContent = "Close";
  },

  skip() {
    const el = this._els();
    if (!el.modal.classList.contains("hidden")) {
      const t = (performance.now() - this._t0) / 1000;
      // an offered playback skipped early: remember, stop offering (§5.7)
      if (this._offered && !this._done && this.script && t < this.script.duration * 0.25) {
        (this.s().settings ||= {}).battleSkip = true;
        window.Game.requestSave();
      }
    }
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null; this.script = null;
    el.modal.classList.add("hidden");
  },

  _pos(s, t) { return Combat._at(s, Math.min(t, s.deathT || Infinity)); },
  _px(p) { const m = 26; return { x: m + p.x * (this._w - 2 * m), y: m + p.y * (this._h - 2 * m) }; },

  // First rock a shot's path runs into, if any: segment/circle test, nearest
  // to the muzzle. Only NEAR-MISS fire is tested (see the caller) so a shot
  // that carries damage can never be eaten by scenery — the movie stays
  // honest about the report.
  _rockHit(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    if (!len2) return null;
    let best = null;
    for (const r of this._rocks) {
      const rad = r.s * 0.42;
      let k = ((r.x - a.x) * dx + (r.y - a.y) * dy) / len2;
      if (k <= 0.04 || k >= 1) continue;                    // behind the muzzle / past the target
      const px = a.x + dx * k, py = a.y + dy * k;
      if (Math.hypot(r.x - px, r.y - py) > rad) continue;
      if (!best || k < best.k) best = { r, k, x: px, y: py };
    }
    return best;
  },

  // Chip a rock: sparks + dark shards at the impact, and if it's taken
  // enough it breaks into smaller fragments that keep floating.
  _hitRock(hit, t) {
    const r = hit.r;
    r.flash = t;
    for (let i = 0; i < 5; i++) {
      const an = Math.random() * 6.28, sp = 20 + Math.random() * 70;
      this._parts.push({ kind: "chunk", x: hit.x, y: hit.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp,
        rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 7,
        t0: t, life: 1 + Math.random(), s: 1.5 + Math.random() * 2 });
    }
    if (--r.hp > 0) return;
    // shatter: replace it with 2–3 smaller rocks holding station nearby
    const i = this._rocks.indexOf(r);
    if (i >= 0) this._rocks.splice(i, 1);
    for (let k = 0, n = 2 + (r.s > 22 ? 1 : 0); k < n && r.s > 11; k++) {
      const an = Math.random() * 6.28, off = r.s * 0.4;
      const s = r.s * (0.36 + Math.random() * 0.2);
      this._rocks.push({ hx: r.x + Math.cos(an) * off, hy: r.y + Math.sin(an) * off, x: 0, y: 0,
        phase: Math.random() * 6.28, bob: 3 + Math.random() * 6,
        wx: 0.15 + Math.random() * 0.25, wy: 0.13 + Math.random() * 0.22,
        rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.5, s, a: r.a,
        hp: Math.max(1, Math.round(s / 9)), flash: t });
    }
    for (let i2 = 0; i2 < 10; i2++) {   // dust puff off the break
      const an = Math.random() * 6.28, sp = 15 + Math.random() * 55;
      this._parts.push({ x: r.x, y: r.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, t0: t, life: 0.5 + Math.random() * 0.5 });
    }
  },

  _chunks(x, y, n) {   // armor knocked loose — slow, spinning, long-lived
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, sp = 15 + Math.random() * 55;
      this._parts.push({ kind: "chunk", x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 6,
        t0: this._nowT, life: 1.4 + Math.random() * 1.2, s: 2 + Math.random() * 3 });
    }
  },

  _drawFrame(ctx, t) {
    const sc = this.script; if (!sc) return;
    const w = this._w, h = this._h;
    const dt = Math.min(0.06, Math.max(0, t - this._lastT)); this._lastT = t; this._nowT = t;
    const byId = this._byId || (this._byId = Object.fromEntries(sc.ships.map(s => [s.id, s])));

    // consume events due by t → transient effects
    while (this._evIdx < sc.events.length && sc.events[this._evIdx].t <= t) {
      const e = sc.events[this._evIdx++];
      const from = byId[e.from], to = byId[e.to];
      if (!from) continue;
      const a = this._px(this._pos(from, e.t));
      if (e.kind === "say") {
        this._bubbles.push({ ship: from.id, text: e.text || "…", t0: e.t, life: 3, last: a });
        continue;
      }
      if (e.kind === "shielddown") {
        this._collapses.push({ ship: from.id, t0: e.t, size: (from.size || 10) + 8 });
        continue;
      }
      if (e.kind === "death") {
        this._rings.push({ x: a.x, y: a.y, t0: e.t, size: (from.size || 10) * 1.6 });
        for (let i = 0; i < 26; i++) {
          const an = Math.random() * 6.28, sp = 25 + Math.random() * 120;
          this._parts.push({ x: a.x, y: a.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, t0: e.t, life: 0.5 + Math.random() * 0.6 });
        }
        this._chunks(a.x, a.y, 6);
        // the hulk stays: a dark, slowly tumbling wreck drifting off the fight
        this._wrecks.push({ sprite: from.sprite, size: from.size, x: a.x, y: a.y,
          vx: (Math.random() - 0.5) * 8, vy: (Math.random() - 0.5) * 8,
          rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.5 });
        this._fighters = this._fighters.filter(f => f.carrier !== from.id);
        continue;
      }
      if (e.kind === "launch") {
        for (let i = 0, n = 3; i < n; i++) {   // a flight rolls off the deck
          const an = Math.random() * 6.28;
          this._fighters.push({ carrier: from.id, side: from.side, t0: e.t,
            x: a.x + Math.cos(an) * 12, y: a.y + Math.sin(an) * 12,
            hdg: an, cool: Math.random() * 0.6, target: null });
        }
        continue;
      }
      if (!to) continue;
      const bp = this._px(this._pos(to, e.t));
      // impact vs near-miss: the movie never shows an untouched ship hit
      const impact = e.dmg > 0 || to.side === "enemy" || !!to.deathT || e.kind === "shieldhit";
      let b = impact ? bp : { x: bp.x + (Math.random() < 0.5 ? -1 : 1) * (to.size + 14), y: bp.y + (Math.random() < 0.5 ? -1 : 1) * (to.size + 8) };
      if (e.kind === "shieldhit") { this._arcs.push({ x: bp.x, y: bp.y, t0: e.t, size: to.size + 6, a0: Math.atan2(a.y - bp.y, a.x - bp.x) }); continue; }
      if (impact && (e.dmg > 0 || to.deathT)) this._chunks(bp.x, bp.y, e.dmg > 0 ? 4 : 2);
      // stray fire hits the scenery: the shot stops at the rock and chips it.
      // Damage-carrying fire is never blocked, so the wallet still rules.
      let rockStop = false;
      if (!impact) {
        const hit = this._rockHit(a, b);
        if (hit) { b = { x: hit.x, y: hit.y }; this._hitRock(hit, e.t); rockStop = true; }
      }
      if (e.kind === "beam") this._beams.push({ a, b, t0: e.t, side: from.side, impact: rockStop });
      else if (e.kind === "missile") this._missiles.push({ a, b, t0: e.t, dur: 0.7, side: from.side, impact: rockStop });
      else this._flak.push({ a, b, t0: e.t, side: from.side, impact: rockStop });
    }

    // ---- backdrop: system nebula, stars, drifting dust + asteroid field ----
    if (this._bg.img.ok) {
      const im = this._bg.img, k = Math.max(w / im.width, h / im.height);
      ctx.drawImage(im, (w - im.width * k) / 2, (h - im.height * k) / 2, im.width * k, im.height * k);
      ctx.fillStyle = "rgba(4,6,12,.52)"; ctx.fillRect(0, 0, w, h);   // veil: keep the fight readable
    } else { ctx.fillStyle = "#05070e"; ctx.fillRect(0, 0, w, h); }
    ctx.fillStyle = "#fff";
    for (const st of this._stars) { ctx.globalAlpha = 0.2 + st.b * 0.4; ctx.fillRect(st.x * w, st.y * h, 1.2, 1.2); }
    for (const d of this._dust) {   // motes drift in place too — no edge wrap
      ctx.globalAlpha = d.a;
      ctx.fillRect((d.x + Math.cos(t * 0.09 + d.vx) * 0.012) * w,
                   (d.y + Math.sin(t * 0.08 + d.vy) * 0.012) * h, d.s, d.s);
    }
    ctx.globalAlpha = 1;
    for (const r of this._rocks) {
      r.x = r.hx + Math.cos(t * r.wx + r.phase) * r.bob;      // hold station, bobbing
      r.y = r.hy + Math.sin(t * r.wy + r.phase) * r.bob;
      r.rot += r.vr * dt;
      const hot = Math.max(0, 1 - (t - r.flash) / 0.3);       // struck a moment ago
      ctx.save(); ctx.translate(r.x, r.y); ctx.rotate(r.rot);
      ctx.globalAlpha = Math.min(1, r.a + hot * 0.5);
      if (this._asterImg.ok) ctx.drawImage(this._asterImg, -r.s / 2, -r.s / 2, r.s, r.s);
      else { ctx.fillStyle = "#3a3f4d"; ctx.beginPath(); ctx.arc(0, 0, r.s / 3, 0, 6.28); ctx.fill(); }
      if (hot > 0) {   // glowing scar where the shot bit
        ctx.globalAlpha = hot * 0.7; ctx.fillStyle = "#ffb266";
        ctx.beginPath(); ctx.arc(0, 0, r.s * 0.32, 0, 6.28); ctx.fill();
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    if (this.report && this.report.type === "smuggle") {   // the gate they're running for
      const g = this._px({ x: 0.95, y: 0.34 });
      ctx.strokeStyle = "rgba(150,210,255,.7)"; ctx.lineWidth = 2;
      for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.ellipse(g.x, g.y, 8 + k * 5, (8 + k * 5) * 0.42, t * (1.1 + k * 0.4), 0, Math.PI * 2); ctx.stroke(); }
    }

    // ---- wrecks drift under the living ----
    for (const wr of this._wrecks) {
      wr.x += wr.vx * dt; wr.y += wr.vy * dt; wr.rot += wr.vr * dt;
      const im = this._sprite(wr.sprite);
      ctx.save(); ctx.translate(wr.x, wr.y); ctx.rotate(wr.rot); ctx.globalAlpha = 0.42;
      if (im.ok) ctx.drawImage(im, -wr.size, -wr.size * 0.6, wr.size * 2, wr.size * 1.2);
      else { ctx.fillStyle = "#444"; ctx.fillRect(-wr.size * 0.6, -wr.size * 0.3, wr.size * 1.2, wr.size * 0.6); }
      ctx.restore(); ctx.globalAlpha = 1;
      if (Math.random() < dt * 2.5)   // embers off the hulk
        this._parts.push({ x: wr.x + (Math.random() - 0.5) * wr.size, y: wr.y + (Math.random() - 0.5) * wr.size,
          vx: (Math.random() - 0.5) * 10, vy: (Math.random() - 0.5) * 10, t0: t, life: 0.5 + Math.random() * 0.4 });
    }

    // ---- ships ----
    for (const s of sc.ships) {
      if (s.deathT && t >= s.deathT) continue;
      if (s.jumpT && t >= s.jumpT) {                       // gone to hyperspace
        if (!this._hdg["_j" + s.id]) {                     // fire the jump effect once
          this._hdg["_j" + s.id] = 1;
          const jp = this._px(this._pos(s, s.jumpT));
          this._jumps.push({ x: jp.x, y: jp.y, t0: s.jumpT, ang: this._hdg[s.id] || 0, size: s.size });
        }
        continue;
      }
      const p = this._px(this._pos(s, t));
      const q = this._px(this._pos(s, t + 0.2));
      const moving = (q.x !== p.x || q.y !== p.y);
      const want = moving ? Math.atan2(q.y - p.y, q.x - p.x) : (s.side === "player" ? 0 : Math.PI);
      // Mass has consequences: a hull swings onto a new heading at a limited
      // rate instead of snapping to it, so strafing runs bank and capitals
      // wallow. Facing therefore lags the velocity vector — as it should.
      const rate = { screen: 3.4, line: 1.9, carrier: 1.0, capital: 0.85, convoy: 1.3 }[s.role] || 1.8;
      let cur = this._hdg[s.id];
      if (cur == null) cur = want;
      else {
        let d = want - cur;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        cur += Math.max(-rate * dt, Math.min(rate * dt, d));
      }
      this._hdg[s.id] = cur;

      // throttle from real speed; the drive spools up before a jump
      const spd = Math.hypot(q.x - p.x, q.y - p.y) / 0.2;
      const charge = s.jumpT ? Math.max(0, 1 - (s.jumpT - t) / 1.4) : 0;
      const thr = Math.min(1.5, Math.min(1, spd / 55) * 0.85 + charge * 0.8);
      const im = this._sprite(s.sprite);
      const sz = s.size;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(cur);
      if (thr > 0.05) {                                     // thruster flare off the stern
        const len = sz * (0.6 + thr * 1.1), rad = sz * 0.3;
        const g = ctx.createLinearGradient(-sz * 0.85, 0, -sz * 0.85 - len, 0);
        const hot = charge > 0 ? "170,220,255" : "255,190,110";
        g.addColorStop(0, `rgba(${hot},${Math.min(0.95, 0.5 + thr * 0.5).toFixed(2)})`);
        g.addColorStop(1, `rgba(${hot},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(-sz * 0.85, -rad); ctx.lineTo(-sz * 0.85 - len, 0); ctx.lineTo(-sz * 0.85, rad);
        ctx.closePath(); ctx.fill();
      }
      if (im.ok) ctx.drawImage(im, -sz, -sz * 0.6, sz * 2, sz * 1.2);
      else { ctx.fillStyle = s.side === "player" ? "#7b8cff" : "#ff5d73"; ctx.fillRect(-sz * 0.6, -sz * 0.3, sz * 1.2, sz * 0.6); }
      ctx.restore();
      // exhaust trail: embers shed from the stern, denser under power
      if (thr > 0.25 && Math.random() < dt * (10 + thr * 26)) {
        const bx = p.x - Math.cos(cur) * sz, by = p.y - Math.sin(cur) * sz;
        this._parts.push({ kind: "trail", x: bx, y: by, hot: charge > 0,
          vx: -Math.cos(cur) * 14 + (Math.random() - 0.5) * 10,
          vy: -Math.sin(cur) * 14 + (Math.random() - 0.5) * 10,
          t0: t, life: 0.35 + Math.random() * 0.35, s: 1 + Math.random() * 1.5 });
      }
      if (s.side === "player") {   // faint friend-marker so sides read at a glance
        ctx.strokeStyle = "rgba(123,140,255,.35)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, sz + 3, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // ---- hyperdrive jumps: the streak and the flash it leaves behind ----
    this._jumps = this._jumps.filter(j => t - j.t0 < 0.55);
    for (const j of this._jumps) {
      const k = (t - j.t0) / 0.55, al = 1 - k;
      const len = j.size * (6 + k * 46);
      const g = ctx.createLinearGradient(j.x, j.y, j.x + Math.cos(j.ang) * len, j.y + Math.sin(j.ang) * len);
      g.addColorStop(0, `rgba(200,235,255,${(0.95 * al).toFixed(2)})`);
      g.addColorStop(1, "rgba(140,200,255,0)");
      ctx.strokeStyle = g; ctx.lineWidth = Math.max(1, j.size * 0.5 * al);
      ctx.beginPath(); ctx.moveTo(j.x, j.y);
      ctx.lineTo(j.x + Math.cos(j.ang) * len, j.y + Math.sin(j.ang) * len); ctx.stroke();
      ctx.fillStyle = `rgba(225,245,255,${(0.55 * al * al).toFixed(2)})`;   // collapse flash
      ctx.beginPath(); ctx.arc(j.x, j.y, j.size * (0.85 - k * 0.6), 0, Math.PI * 2); ctx.fill();
    }

    // Carrier fighters: they swarm out and actually fight. Each dart hunts a
    // live hostile, fires on its approach, blows through the pass and swings
    // back around for another run; with no target left it returns to the deck.
    // Purely cosmetic — fighter fire never carries report damage, so the swarm
    // can't contradict the wallet.
    const gone = s2 => !s2 || (s2.deathT && t >= s2.deathT) || (s2.jumpT && t >= s2.jumpT);
    const FSPD = 120, FTURN = 4.2;
    for (const f of this._fighters) {
      const c = byId[f.carrier];
      if (gone(c)) { f.done = true; continue; }          // deck's gone, so are they
      let tgt = f.target && byId[f.target];
      if (gone(tgt)) {                                    // acquire a new one
        const foes = sc.ships.filter(x => x.side !== f.side && !gone(x));
        tgt = foes.length ? foes[Math.floor(Math.random() * foes.length)] : null;
        f.target = tgt ? tgt.id : null;
      }
      let want = f.hdg;
      if (tgt) {
        const tp = this._px(this._pos(tgt, t));
        const d = Math.hypot(tp.x - f.x, tp.y - f.y);
        f.cool -= dt;
        if (d < 95 && f.cool <= 0) {                      // cannon burst on the run in
          this._flak.push({ a: { x: f.x, y: f.y }, b: { x: tp.x, y: tp.y }, t0: t, side: f.side, impact: true, light: true });
          f.cool = 0.75 + Math.random() * 0.7;
        }
        // inside knife range, hold heading and blow through instead of ramming
        if (d > 30) want = Math.atan2(tp.y - f.y, tp.x - f.x);
      } else {                                            // nothing left — return to the deck
        const cp = this._px(this._pos(c, t));
        want = Math.atan2(cp.y - f.y, cp.x - f.x);
      }
      let dd = want - f.hdg;
      while (dd > Math.PI) dd -= Math.PI * 2;
      while (dd < -Math.PI) dd += Math.PI * 2;
      f.hdg += Math.max(-FTURN * dt, Math.min(FTURN * dt, dd));
      f.x += Math.cos(f.hdg) * FSPD * dt; f.y += Math.sin(f.hdg) * FSPD * dt;
      ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.hdg);
      ctx.fillStyle = f.side === "player" ? "rgba(175,205,255,.95)" : "rgba(255,155,145,.95)";
      ctx.fillRect(-4, -1.6, 8, 3.2);
      ctx.fillStyle = f.side === "player" ? "rgba(120,170,255,.5)" : "rgba(255,110,100,.5)";
      ctx.fillRect(-6.5, -1, 2.5, 2);                     // exhaust nub
      ctx.restore();
      if (Math.random() < dt * 16)
        this._parts.push({ kind: "trail", x: f.x - Math.cos(f.hdg) * 5, y: f.y - Math.sin(f.hdg) * 5,
          vx: (Math.random() - 0.5) * 8, vy: (Math.random() - 0.5) * 8, t0: t, life: 0.22, s: 1 });
    }
    this._fighters = this._fighters.filter(f => !f.done);

    // ---- effects (each cleans itself up as it expires) ----
    this._beams = this._beams.filter(b => t - b.t0 < 0.3);
    for (const b of this._beams) {
      const al = 1 - (t - b.t0) / 0.3;
      const col = b.side === "player" ? "123,190,255" : "255,120,110";
      ctx.strokeStyle = `rgba(${col},${(0.18 * al).toFixed(2)})`; ctx.lineWidth = 7;   // outer glow
      ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
      const grad = ctx.createLinearGradient(b.a.x, b.a.y, b.b.x, b.b.y);
      grad.addColorStop(0, `rgba(${col},${(0.3 * al).toFixed(2)})`);
      grad.addColorStop(1, `rgba(255,255,255,${(0.95 * al).toFixed(2)})`);
      ctx.strokeStyle = grad; ctx.lineWidth = 2.2;                                      // hot core
      ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
      ctx.fillStyle = `rgba(${col},${(0.9 * al).toFixed(2)})`;                          // muzzle flash
      ctx.beginPath(); ctx.arc(b.a.x, b.a.y, 3, 0, Math.PI * 2); ctx.fill();
      if (b.impact) { ctx.fillStyle = `rgba(255,235,180,${(0.85 * al).toFixed(2)})`; ctx.beginPath(); ctx.arc(b.b.x, b.b.y, 4, 0, Math.PI * 2); ctx.fill(); }
    }
    this._missiles = this._missiles.filter(m => t - m.t0 < m.dur + 0.1);
    for (const m of this._missiles) {
      const k = Math.min(1, (t - m.t0) / m.dur);
      const x = m.a.x + (m.b.x - m.a.x) * k, y = m.a.y + (m.b.y - m.a.y) * k;
      if (k < 1) {
        ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(m.b.y - m.a.y, m.b.x - m.a.x));
        ctx.fillStyle = "#ffd9a0"; ctx.fillRect(-4, -1.5, 8, 3); ctx.restore();
        this._parts.push({ x, y, vx: (Math.random() - 0.5) * 14, vy: (Math.random() - 0.5) * 14, t0: t, life: 0.4 });
      } else if (m.impact && !m._boomed) {
        m._boomed = true;
        for (let i = 0; i < 12; i++) { const an = Math.random() * 6.28, sp = 20 + Math.random() * 80; this._parts.push({ x: m.b.x, y: m.b.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, t0: t, life: 0.5 }); }
      }
    }
    this._flak = this._flak.filter(f => t - f.t0 < 0.35);
    for (const f of this._flak) {
      const k = (t - f.t0) / 0.35;
      ctx.strokeStyle = `rgba(255,220,140,${(1 - k).toFixed(2)})`; ctx.lineWidth = f.light ? 1 : 1.6;
      for (let i = 0, n = f.light ? 2 : 5; i < n; i++) {
        const kk = Math.min(1, k * 1.4 + i * 0.1);
        const x = f.a.x + (f.b.x - f.a.x) * kk, y = f.a.y + (f.b.y - f.a.y) * kk;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - (f.b.x - f.a.x) * 0.045, y - (f.b.y - f.a.y) * 0.045); ctx.stroke();
      }
    }
    this._arcs = this._arcs.filter(a => t - a.t0 < 0.4);
    for (const a of this._arcs) {
      const al = 1 - (t - a.t0) / 0.4;
      ctx.strokeStyle = `rgba(120,220,255,${(0.85 * al).toFixed(2)})`; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(a.x, a.y, a.size, a.a0 - 0.7, a.a0 + 0.7); ctx.stroke();
    }
    // shield collapse: the whole envelope flares, shatters and dies
    this._collapses = this._collapses.filter(c => t - c.t0 < 0.7);
    for (const c of this._collapses) {
      const s = byId[c.ship]; if (!s) continue;
      const p = this._px(this._pos(s, t));
      const k = (t - c.t0) / 0.7;
      ctx.strokeStyle = `rgba(120,220,255,${(0.9 * (1 - k)).toFixed(2)})`;
      ctx.lineWidth = 2.5 * (1 - k) + 0.5;
      ctx.setLineDash(k > 0.3 ? [6, 5] : []);            // envelope breaks into fragments
      ctx.beginPath(); ctx.arc(p.x, p.y, c.size * (1 + k * 0.8), 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    this._rings = this._rings.filter(r => t - r.t0 < 0.9);
    for (const r of this._rings) {
      const k = (t - r.t0) / 0.9;
      ctx.strokeStyle = `rgba(255,170,90,${(1 - k).toFixed(2)})`; ctx.lineWidth = 2.5 * (1 - k) + 0.5;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.size * (0.4 + k * 1.8), 0, Math.PI * 2); ctx.stroke();
    }
    this._parts = this._parts.filter(p => t - p.t0 < p.life);
    for (const p of this._parts) {
      const k = (t - p.t0) / p.life, age = t - p.t0;
      if (p.kind === "chunk") {   // armor plate: dark shard with a cooling edge
        ctx.save(); ctx.translate(p.x + p.vx * age, p.y + p.vy * age); ctx.rotate(p.rot + p.vr * age);
        ctx.fillStyle = `rgba(70,76,92,${(1 - k).toFixed(2)})`; ctx.fillRect(-p.s, -p.s * 0.6, p.s * 2, p.s * 1.2);
        ctx.fillStyle = `rgba(255,160,80,${(0.6 * (1 - k) * (1 - k)).toFixed(2)})`; ctx.fillRect(-p.s, -p.s * 0.6, p.s * 0.7, p.s * 1.2);
        ctx.restore();
      } else if (p.kind === "trail") {
        const c = p.hot ? "160,215,255" : "255,170,90";
        ctx.fillStyle = `rgba(${c},${(0.55 * (1 - k)).toFixed(2)})`;
        const sz = p.s * (1 - k * 0.5);
        ctx.fillRect(p.x + p.vx * age - sz / 2, p.y + p.vy * age - sz / 2, sz, sz);
      } else {
        ctx.fillStyle = `rgba(255,200,130,${(1 - k).toFixed(2)})`;
        ctx.fillRect(p.x + p.vx * age - 1.2, p.y + p.vy * age - 1.2, 2.4, 2.4);
      }
    }

    // ---- radio bubbles ride above everything ----
    this._bubbles = this._bubbles.filter(b => t - b.t0 < b.life);
    for (const b of this._bubbles) {
      const s = byId[b.ship];
      if (s && !(s.deathT && t >= s.deathT)) b.last = this._px(this._pos(s, t));
      const al = Math.min(1, (b.life - (t - b.t0)) / 0.4);
      ctx.save();
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      const tw = ctx.measureText(b.text).width, padX = 6, bh = 18, bw = tw + padX * 2;
      let bx = b.last.x - bw / 2, by = b.last.y - 18 - bh;
      bx = Math.max(3, Math.min(w - bw - 3, bx)); by = Math.max(3, by);
      ctx.globalAlpha = 0.92 * al; ctx.fillStyle = "rgba(10,14,24,.92)";
      ctx.beginPath(); ctx.moveTo(b.last.x - 4, by + bh); ctx.lineTo(b.last.x + 4, by + bh);
      ctx.lineTo(b.last.x, Math.min(b.last.y - 12, by + bh + 7)); ctx.closePath(); ctx.fill();
      ctx.beginPath();   // manual round-rect: ctx.roundRect is too new for older Safari
      ctx.moveTo(bx + 5, by);
      ctx.arcTo(bx + bw, by, bx + bw, by + bh, 5);
      ctx.arcTo(bx + bw, by + bh, bx, by + bh, 5);
      ctx.arcTo(bx, by + bh, bx, by, 5);
      ctx.arcTo(bx, by, bx + bw, by, 5);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "#7b8cff"; ctx.lineWidth = 1; ctx.stroke();
      ctx.globalAlpha = al; ctx.fillStyle = "#e6ecff";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(b.text, bx + padX, by + bh / 2 + 0.5);
      ctx.restore();
    }

    // ---- end card ----
    if (t > sc.duration + 0.4) {
      const label = { flawless: "FLAWLESS VICTORY", pyrrhic: "VICTORY — AT A COST", loss: "CONTRACT FAILED", wipe: "FLEET LOST" }[sc.outcome] || "ENGAGEMENT OVER";
      ctx.fillStyle = "rgba(5,7,14,.55)"; ctx.fillRect(0, h / 2 - 26, w, 52);
      ctx.fillStyle = sc.outcome === "flawless" || sc.outcome === "pyrrhic" ? "#46d39a" : "#ff5d73";
      ctx.font = "700 20px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(label, w / 2, h / 2);
    }
  },
};

window.BattleView = BattleView;
