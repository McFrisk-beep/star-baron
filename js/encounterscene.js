/* encounterscene.js — the one battle renderer (owner's direction).

   Draws an Encounters descriptor straight onto whatever canvas the caller is
   already painting — the system scene, the Hub Live View (which runs the
   scene), the tools/battle_demo.html bench. No modal, no zoom view: the
   fight IS the canvas. Everything visual derives from Encounters.snapshot
   plus the clock, so every watcher sees the identical moment and nothing
   here ever decides an outcome.

   The pretty layer lives here: layered glow beams with muzzle and impact
   flashes, tracer near-misses, shield arcs and hull sparks on the scheduled
   hits, thruster flares, seeded explosion fireballs with shrapnel, per-kind
   furniture (the smuggler's gate, the survey scan rings), shield/hull bars,
   name tags, seeded ship radio, and a caption naming the engagement.       */

const EncounterScene = {
  _imgs: {},
  img(ref) {
    const [kind, id] = String(ref || "ship:shuttle").split(":");
    const url = kind === "race" ? ASSET.raceship(id) : ASSET.ship(id);
    let im = this._imgs[url];
    if (!im) { im = new Image(); im.onload = () => { im.ok = true; }; im.src = url; this._imgs[url] = im; }
    return im;
  },

  CAPTION: {
    boarding: "⚔ BOARDING ACTION", toll: "🏴 SHAKEDOWN",
    wave: "🚨 SENATE RESPONSE", manhunt: "🚨 SENATE MANHUNT",
    combat: "⚔ FLEET ENGAGEMENT", escort: "🛡 CONVOY UNDER RAID",
    smuggle: "🛃 RUNNING THE GATE", assassinate: "⚔ DECAPITATION STRIKE",
    transport: "⚔ COLUMN AMBUSHED", survey: "🛰 SURVEY OPERATION",
  },
  _col(side, police) {
    return side === "you" ? "63,227,255" : police ? "143,180,255" : "255,138,96";
  },

  // ctx is already in the caller's space; o: { x, y, scale, now, sub?, label? }.
  // sub: caption suffix ("LIVE" default; the bench passes a replay clock).
  // Returns the snapshot so callers can read done/positions.
  draw(ctx, enc, o) {
    const snap = Encounters.snapshot(enc, o.now);
    const S = o.scale, ax = o.x, ay = o.y, now = o.now;
    const px = v => ax + (v - 0.5) * S, py = v => ay + (v - 0.5) * S;

    // a soft dark stage under the fight so it reads against busy scenery
    ctx.save();
    const halo = ctx.createRadialGradient(ax, ay, S * 0.1, ax, ay, S * 0.62);
    halo.addColorStop(0, "rgba(3,6,14,.42)"); halo.addColorStop(1, "rgba(3,6,14,0)");
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(ax, ay, S * 0.62, 0, 7); ctx.fill();
    ctx.restore();

    // per-kind furniture, under everything
    if (snap.kind === "smuggle") {                       // the gate they're running for
      const gx = px(0.97), gy = py(0.5);
      ctx.save(); ctx.strokeStyle = "rgba(150,210,255,.7)"; ctx.lineWidth = Math.max(1, S / 110);
      for (let k = 0; k < 3; k++) {
        ctx.beginPath();
        ctx.ellipse(gx, gy, S * (0.05 + k * 0.03), S * (0.05 + k * 0.03) * 0.42, now * 0.001 * (1.1 + k * 0.4), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (snap.kind === "survey") {                        // the scan sweeping the site
      const pr = (now % 2600) / 2600;
      ctx.save();
      ctx.strokeStyle = `rgba(63,227,255,${((1 - pr) * 0.45).toFixed(2)})`;
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(ax, ay, S * (0.03 + pr * 0.2), 0, 7); ctx.stroke();
      ctx.fillStyle = "rgba(63,227,255,.5)";
      ctx.beginPath(); ctx.arc(ax, ay, 2, 0, 7); ctx.fill();
      ctx.restore();
    }

    // ---- fire: layered glow beams, tracer near-misses ----------------------
    for (const sh of snap.shots) {
      const f = Math.max(0, Math.min(1, sh.f));
      const x1 = px(sh.x1), y1 = py(sh.y1), x2 = px(sh.x2), y2 = py(sh.y2);
      const ix = x1 + (x2 - x1) * f, iy = y1 + (y2 - y1) * f;
      const al = 1 - Math.abs(f - 0.6);
      const col = this._col(sh.side, false);
      ctx.save();
      if (sh.miss) {                                     // tracer: short bright dashes
        ctx.strokeStyle = `rgba(255,220,140,${(0.7 * al).toFixed(2)})`;
        ctx.lineWidth = 1.1;
        for (let i = 0; i < 3; i++) {
          const k = Math.min(1, f * 1.3 + i * 0.09);
          const tx = x1 + (x2 - x1) * k, ty = y1 + (y2 - y1) * k;
          ctx.beginPath(); ctx.moveTo(tx, ty);
          ctx.lineTo(tx - (x2 - x1) * 0.05, ty - (y2 - y1) * 0.05); ctx.stroke();
        }
      } else {                                           // beam: outer glow + hot core
        ctx.strokeStyle = `rgba(${col},${(0.16 * al).toFixed(2)})`; ctx.lineWidth = 6;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(ix, iy); ctx.stroke();
        const g = ctx.createLinearGradient(x1, y1, ix, iy);
        g.addColorStop(0, `rgba(${col},${(0.35 * al).toFixed(2)})`);
        g.addColorStop(1, `rgba(255,255,255,${(0.95 * al).toFixed(2)})`);
        ctx.strokeStyle = g; ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(ix, iy); ctx.stroke();
        ctx.fillStyle = `rgba(${col},${(0.9 * al).toFixed(2)})`;   // muzzle flash
        ctx.beginPath(); ctx.arc(x1, y1, 2.2, 0, 7); ctx.fill();
        if (f > 0.88) {                                  // impact flash at the far end
          ctx.fillStyle = `rgba(255,235,180,${(0.8 * al).toFixed(2)})`;
          ctx.beginPath(); ctx.arc(x2, y2, 3, 0, 7); ctx.fill();
        }
      }
      ctx.restore();
    }

    // ---- hulls -------------------------------------------------------------
    const nameScale = S >= 110;
    for (const s of snap.ships) {
      const x = px(s.x), y = py(s.y);
      const sz = Math.max(9, s.size * S * 1.1);
      const im = this.img(s.sprite);
      ctx.save(); ctx.translate(x, y); ctx.rotate(s.ang || 0);
      // thruster flare off the stern, flickering with the clock
      const fl2 = sz * (0.5 + Math.sin(now * 0.02 + x) * 0.15);
      const pg = ctx.createLinearGradient(-sz * 0.8, 0, -sz * 0.8 - fl2 * 1.6, 0);
      pg.addColorStop(0, "rgba(255,190,110,.55)"); pg.addColorStop(1, "rgba(255,190,110,0)");
      ctx.fillStyle = pg;
      ctx.beginPath(); ctx.moveTo(-sz * 0.75, -sz * 0.2); ctx.lineTo(-sz * 0.75 - fl2 * 1.6, 0);
      ctx.lineTo(-sz * 0.75, sz * 0.2); ctx.closePath(); ctx.fill();
      if (im.ok) ctx.drawImage(im, -sz, -sz * 0.6, sz * 2, sz * 1.2);
      else {
        ctx.fillStyle = s.side === "you" ? "#3fe3ff" : s.police ? "#8fb4ff" : "#b8a67f";
        ctx.beginPath(); ctx.moveTo(sz, 0); ctx.lineTo(-sz * 0.7, sz * 0.5); ctx.lineTo(-sz * 0.7, -sz * 0.5); ctx.closePath(); ctx.fill();
      }
      // a hit landing right now: shields arc cyan, bare hull sparks white-hot
      if (s.fl > 0) {
        if (s.flSh) {
          ctx.strokeStyle = `rgba(120,220,255,${(0.9 * s.fl).toFixed(2)})`;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(0, 0, sz + 3, -1.1, 1.1); ctx.stroke();
          ctx.beginPath(); ctx.arc(0, 0, sz + 3, Math.PI - 1.1, Math.PI + 1.1); ctx.stroke();
        } else {
          ctx.fillStyle = `rgba(255,235,200,${(0.45 * s.fl).toFixed(2)})`;
          ctx.beginPath(); ctx.arc(0, 0, sz * 0.7, 0, 7); ctx.fill();
          ctx.fillStyle = `rgba(255,180,90,${(0.85 * s.fl).toFixed(2)})`;
          for (let i = 0; i < 4; i++) {
            const a = i * 1.7 + x * 0.13, r = (1 - s.fl) * sz * 1.1 + 2;
            ctx.fillRect(Math.cos(a) * r - 1, Math.sin(a) * r - 1, 2, 2);
          }
        }
      }
      ctx.restore();
      if (s.police) {
        if (window.StarMap && StarMap._copLights) StarMap._copLights(ctx, x, y, sz * 0.7, now);
        else {                                           // bench fallback: bare blinkers
          const on = Math.floor(now / 320) % 2 === 0;
          ctx.fillStyle = on ? "#ff5d73" : "#7ba4ff";
          ctx.beginPath(); ctx.arc(x - 3, y - sz, 1.5, 0, 7); ctx.fill();
          ctx.fillStyle = on ? "#7ba4ff" : "#ff5d73";
          ctx.beginPath(); ctx.arc(x + 3, y - sz, 1.5, 0, 7); ctx.fill();
        }
      }
      if (s.side === "you") {                            // faint friend-marker
        ctx.strokeStyle = "rgba(63,227,255,.25)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, sz + 3, 0, Math.PI * 2); ctx.stroke();
      }
      // the bars: shield over hull — theater with a fixed ending
      const bw = Math.max(16, sz * 1.6), bx = x - bw / 2, by = y + sz * 0.72;
      ctx.fillStyle = "rgba(4,8,18,.72)"; ctx.fillRect(bx - 1, by - 1, bw + 2, 6);
      ctx.fillStyle = "rgba(63,227,255,.9)"; ctx.fillRect(bx, by, bw * Math.max(0, s.sh), 2);
      ctx.fillStyle = s.hull > 0.35 ? "rgba(120,220,120,.9)" : "rgba(255,93,115,.95)";
      ctx.fillRect(bx, by + 2.6, bw * Math.max(0, s.hull), 2.2);
      if (nameScale) {
        ctx.save();
        ctx.font = "9px system-ui, sans-serif"; ctx.textAlign = "center";
        ctx.lineWidth = 3; ctx.strokeStyle = "rgba(4,8,18,.9)";
        ctx.strokeText(s.name, x, y - sz * 0.85 - 3);
        ctx.fillStyle = s.side === "you" ? "#3fe3ff" : "#cfd8ef";
        ctx.fillText(s.name, x, y - sz * 0.85 - 3);
        ctx.restore();
      }
    }

    // ---- deaths: fireball, shock ring, seeded shrapnel ---------------------
    let bi = 0;
    for (const b of snap.booms) {
      const f = b.age, bx = px(b.x), by = py(b.y);
      const R = S * (0.03 + f * 0.16);
      ctx.save(); ctx.globalAlpha = 1 - f;
      const g = ctx.createRadialGradient(bx, by, 1, bx, by, R);
      g.addColorStop(0, "rgba(255,235,180,.95)"); g.addColorStop(0.45, "rgba(255,140,60,.8)");
      g.addColorStop(1, "rgba(255,90,40,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(bx, by, R, 0, 7); ctx.fill();
      ctx.strokeStyle = `rgba(255,170,90,${(0.8 * (1 - f)).toFixed(2)})`;
      ctx.lineWidth = 1.6 * (1 - f) + 0.4;
      ctx.beginPath(); ctx.arc(bx, by, S * f * 0.24 + 2, 0, 7); ctx.stroke();
      const rng = Combat._mk(Combat.seedFrom(enc.uid + "|boom" + bi++));
      for (let i = 0; i < 8; i++) {                      // shrapnel riding the blast
        const a = rng() * 6.28, sp = 0.08 + rng() * 0.2;
        const rx = bx + Math.cos(a) * f * sp * S, ry = by + Math.sin(a) * f * sp * S;
        ctx.fillStyle = i % 3 ? `rgba(255,200,130,${(1 - f).toFixed(2)})` : `rgba(90,96,112,${(1 - f).toFixed(2)})`;
        ctx.fillRect(rx - 1.1, ry - 1.1, 2.2, 2.2);
      }
      ctx.restore();
    }

    // ---- ship radio: seeded chatter at the open and the verdict ------------
    if (nameScale && window.Combat && Combat.LINES) {
      const seed = Combat.seedFrom(enc.uid);
      let text = null;
      if (snap.t > 600 && snap.t < 3800) {
        text = Combat.LINES.open[seed % Combat.LINES.open.length];
      } else if (snap.t > snap.D - 4200 && snap.t < snap.D - 900) {
        const dead = enc.sides.you.filter(s => s.fate === "dead").length;
        const pool = enc.success
          ? (dead ? Combat.LINES.pyrrhic : Combat.LINES.win)
          : (dead >= enc.sides.you.length ? Combat.LINES.wipe : Combat.LINES.retreat);
        text = pool[(seed >> 3) % pool.length];
      }
      const lead = text && snap.ships.find(s2 => s2.side === "you");
      if (lead) this._bubble(ctx, text, px(lead.x), py(lead.y) - Math.max(9, lead.size * S * 1.1) - 8);
    }

    // ---- caption: what this is, pulsing LIVE (or the caller's clock) -------
    if (o.label !== false) {
      const cap = this.CAPTION[snap.kind] || "⚔ ENGAGEMENT";
      const sub = o.sub || "LIVE";
      ctx.save();
      ctx.font = "600 10px system-ui, sans-serif"; ctx.textAlign = "center";
      const yb = ay + S * 0.62;
      const txt = cap + " · " + sub;
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(4,8,18,.9)";
      ctx.strokeText(txt, ax, yb);
      ctx.fillStyle = "rgba(255,194,75,.9)"; ctx.fillText(txt, ax, yb);
      if (!o.sub) {                                      // the pulsing live dot
        const pulse = 0.5 + Math.sin(now * 0.006) * 0.4;
        ctx.fillStyle = `rgba(255,80,90,${pulse.toFixed(2)})`;
        ctx.beginPath(); ctx.arc(ax - ctx.measureText(txt).width / 2 - 7, yb - 3.5, 2.6, 0, 7); ctx.fill();
      }
      ctx.restore();
    }
    return snap;
  },

  _bubble(ctx, text, tx, ty) {
    ctx.save();
    ctx.font = "9px system-ui, sans-serif";
    const tw = ctx.measureText(text).width, padX = 5, bh = 14, bw = tw + padX * 2;
    const bx = tx - bw / 2, by = ty - bh;
    ctx.globalAlpha = 0.92; ctx.fillStyle = "rgba(10,14,24,.92)";
    ctx.beginPath();                                     // manual round-rect (older Safari)
    ctx.moveTo(bx + 4, by);
    ctx.arcTo(bx + bw, by, bx + bw, by + bh, 4);
    ctx.arcTo(bx + bw, by + bh, bx, by + bh, 4);
    ctx.arcTo(bx, by + bh, bx, by, 4);
    ctx.arcTo(bx, by, bx + bw, by, 4);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#7b8cff"; ctx.lineWidth = 1; ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillStyle = "#e6ecff";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, tx, by + bh / 2 + 0.5);
    ctx.restore();
  },
};

window.EncounterScene = EncounterScene;
