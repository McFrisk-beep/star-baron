/* battleview.js — canvas playback for Combat scripts (LIVING_GALAXY.md §5).
   Dumb renderer: reads the script, draws frames. All effects are canvas
   primitives — gradient beams, tracer flak, missiles with particle trails,
   expanding-ring deaths, arc shield hits. No sprite sheets, no new art:
   ships draw with the same top-down assets/ships + assets/raceships sprites
   the system view already rotates.                                            */

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

  // opts.offered: playback the game offered (not an explicit ▶ Replay click) —
  // skipping one of those early remembers the preference (§5.7).
  open(report, opts = {}) {
    if (!window.Combat || !Combat.replayable(report)) return;
    const el = this._els();
    this.report = report; this._offered = !!opts.offered;
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

    this._stars = Array.from({ length: 90 }, () => ({ x: Math.random(), y: Math.random(), b: Math.random() }));
    this._beams = []; this._missiles = []; this._flak = []; this._rings = [];
    this._arcs = []; this._parts = []; this._fighters = [];
    this._evIdx = 0; this._done = false; this._byId = null;

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
    const el = this._els();
    el.skip.textContent = "Close";
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

  _drawFrame(ctx, t) {
    const sc = this.script; if (!sc) return;
    const w = this._w, h = this._h;
    const byId = this._byId || (this._byId = Object.fromEntries(sc.ships.map(s => [s.id, s])));

    // consume events due by t → transient effects
    while (this._evIdx < sc.events.length && sc.events[this._evIdx].t <= t) {
      const e = sc.events[this._evIdx++];
      const from = byId[e.from], to = byId[e.to];
      if (!from) continue;
      const a = this._px(this._pos(from, e.t));
      if (e.kind === "death") {
        this._rings.push({ x: a.x, y: a.y, t0: e.t, size: (from.size || 10) * 1.6 });
        for (let i = 0; i < 22; i++) {
          const an = Math.random() * 6.28, sp = 25 + Math.random() * 110;
          this._parts.push({ x: a.x, y: a.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, t0: e.t, life: 0.5 + Math.random() * 0.5 });
        }
        this._fighters = this._fighters.filter(f => f.carrier !== from.id);
        continue;
      }
      if (e.kind === "launch") {
        for (let i = 0; i < 2; i++) this._fighters.push({ carrier: from.id, t0: e.t, phase: Math.random() * 6.28, r: 16 + Math.random() * 14, spd: 2 + Math.random() * 1.5 });
        continue;
      }
      if (!to) continue;
      const bp = this._px(this._pos(to, e.t));
      // impact vs near-miss: the movie never shows an untouched ship hit
      const impact = e.dmg > 0 || to.side === "enemy" || !!to.deathT || e.kind === "shieldhit";
      const b = impact ? bp : { x: bp.x + (Math.random() < 0.5 ? -1 : 1) * (to.size + 14), y: bp.y + (Math.random() < 0.5 ? -1 : 1) * (to.size + 8) };
      if (e.kind === "shieldhit") { this._arcs.push({ x: bp.x, y: bp.y, t0: e.t, size: to.size + 6, a0: Math.atan2(a.y - bp.y, a.x - bp.x) }); continue; }
      if (e.kind === "beam") this._beams.push({ a, b, t0: e.t, side: from.side, impact });
      else if (e.kind === "missile") this._missiles.push({ a, b, t0: e.t, dur: 0.55, side: from.side, impact });
      else this._flak.push({ a, b, t0: e.t, side: from.side, impact });
    }

    // ---- backdrop ----
    ctx.fillStyle = "#05070e"; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#fff";
    for (const st of this._stars) { ctx.globalAlpha = 0.25 + st.b * 0.45; ctx.fillRect(st.x * w, st.y * h, 1.2, 1.2); }
    ctx.globalAlpha = 1;
    if (this.report && this.report.type === "smuggle") {   // the gate they're running for
      const g = this._px({ x: 0.95, y: 0.34 });
      ctx.strokeStyle = "rgba(150,210,255,.7)"; ctx.lineWidth = 2;
      for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.ellipse(g.x, g.y, 8 + k * 5, (8 + k * 5) * 0.42, t * (1.1 + k * 0.4), 0, Math.PI * 2); ctx.stroke(); }
    }

    // ---- ships ----
    for (const s of sc.ships) {
      if (s.deathT && t >= s.deathT) continue;
      const p = this._px(this._pos(s, t));
      const q = this._px(this._pos(s, t + 0.2));
      const ang = (q.x !== p.x || q.y !== p.y) ? Math.atan2(q.y - p.y, q.x - p.x)
        : (s.side === "player" ? 0 : Math.PI);
      const im = this._sprite(s.sprite);
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(ang);
      const sz = s.size;
      if (im.ok) ctx.drawImage(im, -sz, -sz * 0.6, sz * 2, sz * 1.2);
      else { ctx.fillStyle = s.side === "player" ? "#7b8cff" : "#ff5d73"; ctx.fillRect(-sz * 0.6, -sz * 0.3, sz * 1.2, sz * 0.6); }
      ctx.restore();
      if (s.side === "player") {   // faint friend-marker so sides read at a glance
        ctx.strokeStyle = "rgba(123,140,255,.35)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, sz + 3, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // fighters: cosmetic darts orbiting their carrier
    for (const f of this._fighters) {
      const c = byId[f.carrier]; if (!c || (c.deathT && t >= c.deathT)) continue;
      const p = this._px(this._pos(c, t));
      const a = f.phase + (t - f.t0) * f.spd;
      const x = p.x + Math.cos(a) * f.r, y = p.y + Math.sin(a) * f.r;
      ctx.save(); ctx.translate(x, y); ctx.rotate(a + Math.PI / 2);
      ctx.fillStyle = "rgba(160,190,255,.9)"; ctx.fillRect(-3, -1.5, 6, 3);
      ctx.restore();
    }

    // ---- effects (each cleans itself up as it expires) ----
    this._beams = this._beams.filter(b => t - b.t0 < 0.25);
    for (const b of this._beams) {
      const al = 1 - (t - b.t0) / 0.25;
      const grad = ctx.createLinearGradient(b.a.x, b.a.y, b.b.x, b.b.y);
      const col = b.side === "player" ? "123,190,255" : "255,120,110";
      grad.addColorStop(0, `rgba(${col},${(0.15 * al).toFixed(2)})`);
      grad.addColorStop(1, `rgba(${col},${(0.9 * al).toFixed(2)})`);
      ctx.strokeStyle = grad; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
      if (b.impact) { ctx.fillStyle = `rgba(255,235,180,${(0.8 * al).toFixed(2)})`; ctx.beginPath(); ctx.arc(b.b.x, b.b.y, 3.5, 0, Math.PI * 2); ctx.fill(); }
    }
    this._missiles = this._missiles.filter(m => t - m.t0 < m.dur + 0.1);
    for (const m of this._missiles) {
      const k = Math.min(1, (t - m.t0) / m.dur);
      const x = m.a.x + (m.b.x - m.a.x) * k, y = m.a.y + (m.b.y - m.a.y) * k;
      if (k < 1) {
        ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(m.b.y - m.a.y, m.b.x - m.a.x));
        ctx.fillStyle = "#ffd9a0"; ctx.fillRect(-4, -1.5, 8, 3); ctx.restore();
        this._parts.push({ x, y, vx: (Math.random() - 0.5) * 12, vy: (Math.random() - 0.5) * 12, t0: t, life: 0.35 });
      } else if (m.impact && !m._boomed) {
        m._boomed = true;
        for (let i = 0; i < 10; i++) { const an = Math.random() * 6.28, sp = 20 + Math.random() * 70; this._parts.push({ x: m.b.x, y: m.b.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, t0: t, life: 0.45 }); }
      }
    }
    this._flak = this._flak.filter(f => t - f.t0 < 0.3);
    for (const f of this._flak) {
      const k = (t - f.t0) / 0.3;
      ctx.strokeStyle = `rgba(255,220,140,${(1 - k).toFixed(2)})`; ctx.lineWidth = 1.4;
      for (let i = 0; i < 3; i++) {
        const kk = Math.min(1, k * 1.4 + i * 0.12);
        const x = f.a.x + (f.b.x - f.a.x) * kk, y = f.a.y + (f.b.y - f.a.y) * kk;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - (f.b.x - f.a.x) * 0.04, y - (f.b.y - f.a.y) * 0.04); ctx.stroke();
      }
    }
    this._arcs = this._arcs.filter(a => t - a.t0 < 0.4);
    for (const a of this._arcs) {
      const al = 1 - (t - a.t0) / 0.4;
      ctx.strokeStyle = `rgba(120,220,255,${(0.85 * al).toFixed(2)})`; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(a.x, a.y, a.size, a.a0 - 0.7, a.a0 + 0.7); ctx.stroke();
    }
    this._rings = this._rings.filter(r => t - r.t0 < 0.9);
    for (const r of this._rings) {
      const k = (t - r.t0) / 0.9;
      ctx.strokeStyle = `rgba(255,170,90,${(1 - k).toFixed(2)})`; ctx.lineWidth = 2.5 * (1 - k) + 0.5;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.size * (0.4 + k * 1.8), 0, Math.PI * 2); ctx.stroke();
    }
    this._parts = this._parts.filter(p => t - p.t0 < p.life);
    for (const p of this._parts) {
      const k = (t - p.t0) / p.life;
      ctx.fillStyle = `rgba(255,200,130,${(1 - k).toFixed(2)})`;
      ctx.fillRect(p.x + p.vx * (t - p.t0) - 1.2, p.y + p.vy * (t - p.t0) - 1.2, 2.4, 2.4);
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
