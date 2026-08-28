/* encounterview.js — the magnifying glass (owner's direction).

   A fight lives in the system scene at map scale; clicking it — or pressing
   ▶ Replay on a report — opens THIS: the same encounter drawn big enough to
   read. Same Encounters.snapshot every client renders, so the zoom can never
   field a different fight from the world.

   Two clocks, one renderer: LIVE tracks the wall clock (close it and the
   fight is still ticking in the scene, exactly where you left it); REPLAY
   runs the encounter on its own clock from t0. Nothing here decides
   anything — the bars land where the verdict already put them.             */

const EncounterView = {
  s() { return window.Game.state; },
  _el: null,
  _els() {
    if (this._el) return this._el;
    this._el = {
      modal: document.getElementById("enc-modal"),
      title: document.getElementById("enc-title"),
      sub: document.getElementById("enc-sub"),
      canvas: document.getElementById("enc-canvas"),
      close: document.getElementById("enc-close"),
    };
    this._el.close.addEventListener("click", () => this.close());
    this._el.modal.addEventListener("click", e => { if (e.target === this._el.modal) this.close(); });
    return this._el;
  },
  isOpen() {
    try { const el = this._els(); return !!(el.modal && !el.modal.classList.contains("hidden")); }
    catch (e) { return false; }
  },
  img(ref) {
    this._imgs = this._imgs || {};
    if (!this._imgs[ref]) { const im = new Image(); im.src = ref; im.onload = () => { im.ok = true; }; this._imgs[ref] = im; }
    return this._imgs[ref];
  },

  // enc: an Encounters descriptor. live: sync to the wall clock; else replay
  // from the encounter's own t0.
  open(enc, opts = {}) {
    if (!enc || !window.Encounters) return;
    const el = this._els();
    if (!el.modal) return;
    this.enc = enc; this.live = !!opts.live;
    this._t0 = performance.now();
    const sysName = enc.sysId && window.Galaxy && Galaxy.get(enc.sysId) ? Galaxy.get(enc.sysId).name : null;
    el.title.textContent = (enc.kind === "boarding" ? "⚔ Boarding action"
      : enc.kind === "manhunt" ? "🚨 Manhunt" : "🚨 Patrol engagement")
      + (sysName ? " — " + sysName : "");
    el.modal.classList.remove("hidden");

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = el.canvas.getBoundingClientRect();
    el.canvas.width = Math.max(320, Math.round(r.width * dpr));
    el.canvas.height = Math.max(240, Math.round(r.height * dpr));
    const ctx = el.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = el.canvas.width / dpr; this._h = el.canvas.height / dpr;
    const srng = Combat._mk(Combat.seedFrom(enc.uid) ^ 0x51ee7);
    this._stars = Array.from({ length: 90 }, () => ({ x: srng() * this._w, y: srng() * this._h, b: 0.2 + srng() * 0.7 }));

    const reduced = !!(this.s().settings && this.s().settings.reduced);
    const loop = () => {
      const now = this.live ? Date.now() : this.enc.t0 + (performance.now() - this._t0);
      const snap = Encounters.snapshot(this.enc, now);
      this._draw(ctx, snap);
      if (snap.done && !this.live) { el.close.textContent = "Close"; }
      if (this.live && snap.done) { this.close(); return; }   // the scene took over (settle passed)
      this.raf = requestAnimationFrame(loop);
    };
    if (reduced) {   // one final frame, no animation
      this._draw(ctx, Encounters.snapshot(enc, enc.t1 - 1));
      el.close.textContent = "Close";
      return;
    }
    el.close.textContent = this.live ? "Close (fight continues)" : "Skip ▸";
    loop();
  },
  // Replay straight from a Fleet-tab report.
  replay(report) {
    const enc = window.Encounters && Encounters.fromReport(report);
    if (enc) this.open(enc, { live: false });
  },
  close() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null; this.enc = null;
    const el = this._els();
    if (el.modal) el.modal.classList.add("hidden");
  },

  _draw(ctx, snap) {
    const W = this._w, H = this._h;
    ctx.fillStyle = "#05070f"; ctx.fillRect(0, 0, W, H);
    for (const st of this._stars) {
      ctx.fillStyle = `rgba(200,215,255,${st.b.toFixed(2)})`;
      ctx.fillRect(st.x, st.y, 1.4, 1.4);
    }
    const S = Math.min(W, H) * 0.92, ox = (W - S) / 2, oy = (H - S) / 2;
    const px = v => ox + v * S, py = v => oy + v * S;
    // shots first, under the hulls
    for (const sh of snap.shots) {
      const f = Math.max(0, Math.min(1, sh.f));
      ctx.save();
      ctx.strokeStyle = `rgba(255,160,110,${(0.85 * (1 - Math.abs(f - 0.6))).toFixed(2)})`;
      ctx.lineWidth = 2; ctx.shadowColor = "#ffb04b"; ctx.shadowBlur = 8;
      const ix = px(sh.x1) + (px(sh.x2) - px(sh.x1)) * f, iy = py(sh.y1) + (py(sh.y2) - py(sh.y1)) * f;
      ctx.beginPath(); ctx.moveTo(px(sh.x1), py(sh.y1)); ctx.lineTo(ix, iy); ctx.stroke();
      ctx.restore();
    }
    for (const b of snap.booms) {
      const f = b.age;
      ctx.save(); ctx.globalAlpha = 1 - f;
      const g = ctx.createRadialGradient(px(b.x), py(b.y), 2, px(b.x), py(b.y), 14 + f * 90);
      g.addColorStop(0, "rgba(255,230,170,.95)"); g.addColorStop(0.4, "rgba(255,140,60,.8)"); g.addColorStop(1, "rgba(255,90,40,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px(b.x), py(b.y), 14 + f * 90, 0, 7); ctx.fill();
      ctx.restore();
    }
    for (const s of snap.ships) {
      const x = px(s.x), y = py(s.y);
      const sz = Math.max(22, s.size * S * 0.9);
      const [kind, id] = String(s.sprite || "ship:shuttle").split(":");
      const im = this.img(kind === "race" ? ASSET.raceship(id) : ASSET.ship(id));
      ctx.save(); ctx.translate(x, y); ctx.rotate(s.ang || 0);
      if (im.ok) ctx.drawImage(im, -sz, -sz * 0.6, sz * 2, sz * 1.2);
      else {
        ctx.fillStyle = s.side === "you" ? "#3fe3ff" : s.police ? "#8fb4ff" : "#b8a67f";
        ctx.beginPath(); ctx.moveTo(sz, 0); ctx.lineTo(-sz * 0.7, sz * 0.5); ctx.lineTo(-sz * 0.7, -sz * 0.5); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      if (s.police) { StarMap._copLights && StarMap._copLights(ctx, x, y, sz * 0.6, Date.now()); }
      // the bars: shield over hull, wide enough to read — the whole point
      const bw = Math.max(46, sz * 1.6), bx = x - bw / 2, by = y + sz * 0.75;
      ctx.fillStyle = "rgba(4,8,18,.75)"; ctx.fillRect(bx - 1, by - 1, bw + 2, 9);
      ctx.fillStyle = "rgba(63,227,255,.9)"; ctx.fillRect(bx, by, bw * Math.max(0, s.sh), 3);
      ctx.fillStyle = s.hull > 0.35 ? "rgba(120,220,120,.9)" : "rgba(255,93,115,.95)";
      ctx.fillRect(bx, by + 4, bw * Math.max(0, s.hull), 4);
      ctx.font = "11px system-ui, sans-serif"; ctx.textAlign = "center";
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(4,8,18,.9)";
      ctx.strokeText(s.name, x, y - sz * 0.8);
      ctx.fillStyle = s.side === "you" ? "#3fe3ff" : "#cfe3ff";
      ctx.fillText(s.name, x, y - sz * 0.8);
    }
    const el = this._els();
    if (el.sub) el.sub.textContent = this.live ? "LIVE" : `replay · ${Math.min(snap.t, snap.D) / 1000 | 0}s / ${snap.D / 1000 | 0}s`;
  },
};

window.EncounterView = EncounterView;
