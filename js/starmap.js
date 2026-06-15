/* starmap.js — the navigable galaxy. Galaxy view (6 sectors, ~80 nodes that
   pulse with live local prices) → click a system → a big animated scene with a
   star, orbiting planets, a station, and tiny race-varied ships, plus planet
   industries, imports, and a local news feed. Pure rendering; logic is in
   galaxy.js / market.js.                                                       */

const StarMap = {
  refs: {},
  open: false,
  current: null,        // current system id when in system view
  raf: null,
  galaxyTimer: null,
  feedTimer: null,
  imgs: {},
  scene: null,

  s() { return window.Game.state; },

  img(src) {
    let im = this.imgs[src];
    if (!im) {
      im = new Image(); im.ok = false; im.bad = false;
      im.onload = () => { im.ok = true; };
      im.onerror = () => { im.bad = true; };
      im.src = src;
      this.imgs[src] = im;
    }
    return im;
  },

  init() {
    const $ = id => document.getElementById(id);
    this.refs = {
      overlay: $("starmap-overlay"), svg: $("galaxy-svg"), tip: $("galaxy-tip"),
      galaxyView: $("galaxy-view"), systemView: $("system-view"),
      canvas: $("system-canvas"), info: $("system-info"),
      title: $("sm-title"), crumbSys: $("sm-crumb-sys"),
      btnOpen: $("btn-starmap"), btnClose: $("sm-close"), toGalaxy: $("sm-to-galaxy"),
    };
    this.refs.btnOpen.onclick = () => this.openGalaxy();
    this.refs.btnClose.onclick = () => this.close();
    this.refs.toGalaxy.onclick = () => this.showGalaxy();
    document.addEventListener("keydown", e => { if (e.key === "Escape" && this.open) this.close(); });
  },

  // ===== open / close =====================================================
  openGalaxy() {
    this.open = true;
    this.refs.overlay.classList.remove("hidden");
    this.showGalaxy();
  },
  close() {
    this.open = false;
    this.refs.overlay.classList.add("hidden");
    this.stopSystem();
    clearInterval(this.galaxyTimer); this.galaxyTimer = null;
  },
  showGalaxy() {
    this.stopSystem();
    this.refs.systemView.classList.add("hidden");
    this.refs.galaxyView.classList.remove("hidden");
    this.refs.crumbSys.textContent = "";
    this.refs.title.textContent = "GALACTIC CHART";
    this.renderGalaxy();
    clearInterval(this.galaxyTimer);
    this.galaxyTimer = setInterval(() => this.updateGalaxyNodes(), CONFIG.marketTickMs);
  },

  // ===== galaxy view (SVG) ================================================
  renderGalaxy() {
    const svg = this.refs.svg;
    const W = 1000, H = 620;
    const ns = "http://www.w3.org/2000/svg";
    svg.innerHTML = "";
    const X = x => x * W, Y = y => y * H;

    // sector halos + labels + link lines to capital
    for (const sec of Galaxy.sectors) {
      const cx = X(sec.pos.x), cy = Y(sec.pos.y);
      const halo = document.createElementNS(ns, "circle");
      halo.setAttribute("cx", cx); halo.setAttribute("cy", cy); halo.setAttribute("r", 120);
      halo.setAttribute("class", "sector-halo"); halo.setAttribute("fill", RACES[sec.race].color);
      svg.appendChild(halo);
      const lbl = document.createElementNS(ns, "text");
      lbl.setAttribute("x", cx); lbl.setAttribute("y", cy - 96);
      lbl.setAttribute("class", "sector-label"); lbl.textContent = sec.name.toUpperCase();
      svg.appendChild(lbl);
      const cap = Galaxy.get(sec.capital);
      for (const id of sec.systems) {
        if (id === sec.capital) continue;
        const s = Galaxy.get(id);
        const ln = document.createElementNS(ns, "line");
        ln.setAttribute("x1", X(cap.pos.x)); ln.setAttribute("y1", Y(cap.pos.y));
        ln.setAttribute("x2", X(s.pos.x)); ln.setAttribute("y2", Y(s.pos.y));
        ln.setAttribute("class", "sector-link");
        svg.appendChild(ln);
      }
    }

    // system nodes
    this._nodeEls = {};
    for (const sys of Galaxy.list) {
      const g = document.createElementNS(ns, "g");
      g.setAttribute("class", "node" + (sys.capital ? " cap" : ""));
      g.setAttribute("transform", `translate(${X(sys.pos.x)},${Y(sys.pos.y)})`);
      g.style.cursor = "pointer";

      const ring = document.createElementNS(ns, "circle");
      ring.setAttribute("r", sys.capital ? 13 : 8);
      ring.setAttribute("class", "node-ring");
      g.appendChild(ring);

      const img = document.createElementNS(ns, "image");
      const sz = sys.capital ? 26 : 16;
      img.setAttributeNS("http://www.w3.org/1999/xlink", "href", ASSET.star(sys.star));
      img.setAttribute("href", ASSET.star(sys.star));
      img.setAttribute("x", -sz / 2); img.setAttribute("y", -sz / 2);
      img.setAttribute("width", sz); img.setAttribute("height", sz);
      g.appendChild(img);

      if (sys.capital) {
        const t = document.createElementNS(ns, "text");
        t.setAttribute("y", 26); t.setAttribute("class", "node-label");
        t.textContent = sys.name;
        g.appendChild(t);
      }

      g.addEventListener("click", () => this.openSystem(sys.id));
      g.addEventListener("mouseenter", e => this.showTip(sys, e));
      g.addEventListener("mousemove", e => this.moveTip(e));
      g.addEventListener("mouseleave", () => this.refs.tip.style.display = "none");
      svg.appendChild(g);
      this._nodeEls[sys.id] = { ring, g };
    }
    this.updateGalaxyNodes();
  },

  updateGalaxyNodes() {
    if (!this._nodeEls) return;
    for (const id in this._nodeEls) {
      const idx = Galaxy.localIndex(id);
      const evt = Galaxy.hasEvent(id);
      const ring = this._nodeEls[id].ring;
      ring.setAttribute("stroke", evt ? "#ffc24b" : idx > 0.06 ? "#46d39a" : idx < -0.06 ? "#ff5d73" : "#3a4560");
      ring.setAttribute("stroke-width", evt ? 3 : 2);
      ring.classList.toggle("pulse", evt);
      const docked = this.s().currentSystem === id;
      this._nodeEls[id].g.classList.toggle("docked", docked);
    }
  },

  showTip(sys, e) {
    const idx = Galaxy.localIndex(sys.id);
    const sec = Galaxy.sector(sys.sectorId);
    const evt = Market.activeLocal(sys.id);
    const dirTxt = idx > 0.06 ? `<span class="up">▲ rising</span>` : idx < -0.06 ? `<span class="down">▼ falling</span>` : "stable";
    this.refs.tip.innerHTML =
      `<b>${sys.name}</b> ${sys.capital ? '<span class="tip-cap">trade hub</span>' : ""}<br>` +
      `<span class="tip-dim">${sec.name} · ${RACES[sys.race].name}</span><br>` +
      `market: ${dirTxt}` + (evt.length ? `<br><span class="warn">⚠ local event active</span>` : "");
    this.refs.tip.style.display = "block";
    this.moveTip(e);
  },
  moveTip(e) {
    const r = this.refs.galaxyView.getBoundingClientRect();
    this.refs.tip.style.left = (e.clientX - r.left + 14) + "px";
    this.refs.tip.style.top = (e.clientY - r.top + 14) + "px";
  },

  // ===== system view ======================================================
  openSystem(id) {
    const sys = Galaxy.get(id);
    if (!sys) return;
    this.current = id;
    this.refs.galaxyView.classList.add("hidden");
    this.refs.systemView.classList.remove("hidden");
    this.refs.crumbSys.textContent = " ▸ " + sys.name;
    this.refs.title.textContent = sys.name.toUpperCase();
    this.renderInfo(sys);
    this.startScene(sys);
    this.startLocalFeed(sys);
  },

  renderInfo(sys) {
    const sec = Galaxy.sector(sys.sectorId);
    const race = RACES[sys.race];
    const s = this.s();
    const unlocked = s.unlockedSystems.includes(sys.id);
    const docked = s.currentSystem === sys.id;

    let trade = "";
    if (sys.tradeable) {
      if (docked) trade = `<span class="badge">you are docked here</span>`;
      else if (unlocked) trade = `<button class="btn btn-go" id="sm-dock">Dock here</button>`;
      else trade = `<button class="btn btn-go" id="sm-unlock">Unlock — ${Util.credits(sys.unlock)}c</button>`;
    } else {
      trade = `<span class="tip-dim">Not a trade hub · view-only outpost</span>`;
    }

    const active = Market.activeLocal(sys.id).map(e => {
      const comm = COMMODITIES.find(c => c.id === e.target);
      const label = comm ? comm.name : e.target;
      return `<div class="local-effect ${e.mult > 1 ? "up" : "down"}">⚠ ${label} ${e.mult > 1 ? "scarce — prices up" : "glut — prices down"} here</div>`;
    }).join("");

    const planets = sys.planets.map(p => {
      const im = ASSET.planet(p.type);
      return `<li class="planet">
        <img src="${im}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tintbox',textContent:'${p.type[0].toUpperCase()}'}))"/>
        <div><b>${p.name}</b><span class="ptype">${p.type.replace("_", " ")}</span>
        <div class="pind">${p.industry}</div>
        <div class="pimp">importing <b>${p.importing}</b></div></div></li>`;
    }).join("");

    this.refs.info.innerHTML =
      `<div class="si-head">
         <h3>${sys.name}</h3>
         <div class="si-sub" style="color:${race.color}">${sec.name} · ${race.name} space</div>
         <div class="si-trade">${trade}</div>
         ${active ? `<div class="si-effects">${active}</div>` : ""}
       </div>
       <h4>Planets &amp; industries</h4>
       <ul class="planet-list">${planets}</ul>
       <h4>Local feed <small>${sys.stationName}</small></h4>
       <ul class="local-feed" id="sm-local-feed"></ul>`;

    const dock = document.getElementById("sm-dock");
    if (dock) dock.onclick = () => {
      Economy.dockAt(sys.id); UI.updateExchange(); UI.updateHeader(); UI.renderSystems();
      window.Game.requestSave(); this.renderInfo(sys); this.updateGalaxyNodes();
      UI.toast(`Docked at ${sys.name}.`, "good");
    };
    const unlock = document.getElementById("sm-unlock");
    if (unlock) unlock.onclick = () => {
      const r = Economy.unlockSystem(sys.id);
      if (!r.ok) return UI.toast(r.msg, "warn");
      UI.toast(`Unlocked ${sys.name}!`, "good"); UI.renderSystems(); UI.refreshDispatch();
      window.Game.requestSave(); this.renderInfo(sys);
    };

    // backfill a little history, then render the persisted local log
    Galaxy.ensureSeeded(sys);
    this.renderFeedList(sys);
  },

  // Render the whole local feed (newest first) with relative timestamps.
  renderFeedList(sys) {
    const feed = document.getElementById("sm-local-feed");
    if (!feed) return;
    const items = Galaxy.newsFor(sys.id);
    if (!items.length) { feed.innerHTML = `<li class="lf">station channel quiet…</li>`; return; }
    feed.innerHTML = items.map(e => {
      const t = `<span class="lf-time">${Util.ago(e.ts)}</span>`;
      if (e.mechanical)
        return `<li class="lf mech ${e.dir}"><span class="lf-tag">BULLETIN</span>${t}<b>${e.headline}</b><span class="lf-body">${e.body}</span></li>`;
      return `<li class="lf"><span class="lf-text">${e.text}</span>${t}</li>`;
    }).join("");
  },

  // While a system is open it gets occasional fresh posts; we also re-render to
  // keep the "X ago" stamps current.
  startLocalFeed(sys) {
    clearInterval(this.feedTimer);
    const tick = () => {
      if (!this.open || this.current !== sys.id) return;
      if (Math.random() < 0.8) { Galaxy.flavorPost(sys); window.Game.requestSave(); }
      this.renderFeedList(sys);
    };
    this.feedTimer = setInterval(tick, Util.randInt(9000, 14000));
  },

  // Called by the slow background refresh so timestamps stay current.
  refreshFeed() {
    if (!this.open || this.refs.systemView.classList.contains("hidden") || !this.current) return;
    const sys = Galaxy.get(this.current);
    if (sys) this.renderFeedList(sys);
  },

  // ===== animated scene (canvas) =========================================
  startScene(sys) {
    this.stopScene();
    const canvas = this.refs.canvas;
    if (!canvas || !canvas.getContext || !canvas.getContext("2d")) return; // no-canvas env
    const reduced = this.s().settings.reduced;
    const resize = () => {
      const r = canvas.parentElement.getBoundingClientRect();
      canvas.width = Math.max(320, r.width); canvas.height = Math.max(260, r.height);
    };
    resize();
    this._onResize = resize;
    window.addEventListener("resize", resize);

    const W = () => canvas.width, H = () => canvas.height;
    const planets = sys.planets.map((p, i) => ({
      p, angle: (i * 2.39996) % (Math.PI * 2),
      orbit: 0.28 + (i / Math.max(1, sys.planets.length)) * 0.62,
      speed: (0.10 - i * 0.012) * 0.3, img: this.img(ASSET.planet(p.type)),
      size: 16 + (p.type === "gas_giant" || p.type === "ringed" ? 12 : 6),
    }));
    const station = { angle: 0, orbit: 0.16, speed: 0.25, img: this.img(ASSET.station(sys.race)) };
    const starImg = this.img(ASSET.star(sys.star));
    const neb = this.img(ASSET.nebula(sys.nebula));
    const aster = sys.asteroidBelt ? this.img(ASSET.asteroids()) : null;

    // ---- ambient ship traffic (with behaviour) ----
    const raceKeys = Object.keys(RACES);
    const targetPop = reduced ? 4 : 9;
    const ships = [];
    const particles = [];
    const raceImg = r => this.img(ASSET.raceship(r));

    const dockPoints = () => {
      const pts = planets.map((pl, i) => ({ x: pl._x ?? W() / 2, y: pl._y ?? H() / 2, kind: "planet", idx: i }));
      pts.push({ x: station._x ?? W() / 2, y: station._y ?? H() / 2, kind: "station" });
      return pts;
    };
    const targetPos = t => {
      if (!t) return { x: W() / 2, y: H() / 2 };
      if (t.kind === "planet") { const pl = planets[t.idx]; return { x: pl?._x ?? W() / 2, y: pl?._y ?? H() / 2 }; }
      if (t.kind === "station") return { x: station._x ?? W() / 2, y: station._y ?? H() / 2 };
      return { x: t.x, y: t.y };
    };
    const pickTarget = avoid => {
      const docks = dockPoints();
      let t = Util.pick(docks);
      if (avoid && t.kind === avoid.kind && t.idx === avoid.idx && docks.length > 1) t = Util.pick(docks);
      return t.kind === "planet" ? { kind: "planet", idx: t.idx } : { kind: "station" };
    };
    const spawnShip = () => {
      const d = Util.pick(dockPoints());
      const r = Util.pick(raceKeys);
      ships.push({ x: d.x, y: d.y, race: r, img: raceImg(r), alpha: 0, state: "spawn",
        spd: Util.randFloat(42, 90), ang: Math.random() * 6.28, target: null, dwell: 0 });
    };
    const explode = (x, y, color) => {
      for (let i = 0; i < 16; i++) {
        const a = Math.random() * 6.28, s = Util.randFloat(30, 130);
        particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: Util.randFloat(.4, .9), max: .9, color });
      }
    };
    const spark = (x, y) => {
      const a = Math.random() * 6.28, s = Util.randFloat(20, 60);
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: .25, max: .25, color: "rgba(255,220,140," });
    };
    for (let i = 0; i < targetPop; i++) {   // start with traffic already underway
      const r = Util.pick(raceKeys);
      ships.push({ x: Math.random() * W(), y: Math.random() * H(), race: r, img: raceImg(r),
        alpha: 1, state: "travel", spd: Util.randFloat(42, 90), ang: Math.random() * 6.28, target: null, dwell: 0 });
    }
    let combatCooldown = 5;

    const stars = [];
    for (let i = 0; i < 120; i++) stars.push({ x: Math.random(), y: Math.random(), b: Math.random() });

    let last = performance.now();
    const draw = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const w = W(), h = H(), cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.42;
      const ctx = canvas.getContext("2d");
      // background
      if (neb.ok) ctx.drawImage(neb, 0, 0, w, h); else { ctx.fillStyle = "#06080f"; ctx.fillRect(0, 0, w, h); }
      ctx.fillStyle = "#fff";
      for (const st of stars) { ctx.globalAlpha = 0.3 + st.b * 0.5; ctx.fillRect(st.x * w, st.y * h, 1.3, 1.3); }
      ctx.globalAlpha = 1;

      // orbits
      ctx.strokeStyle = "rgba(150,170,220,.12)"; ctx.lineWidth = 1;
      for (const pl of planets) { ctx.beginPath(); ctx.arc(cx, cy, pl.orbit * R, 0, Math.PI * 2); ctx.stroke(); }
      // asteroid belt ring
      if (aster && aster.ok) {
        for (let a = 0; a < Math.PI * 2; a += 0.5) {
          const rr = R * 0.95; ctx.globalAlpha = 0.5;
          ctx.drawImage(aster, cx + Math.cos(a) * rr - 16, cy + Math.sin(a) * rr - 16, 32, 32);
        }
        ctx.globalAlpha = 1;
      }

      // star
      const glow = ctx.createRadialGradient(cx, cy, 4, cx, cy, 70);
      glow.addColorStop(0, "rgba(255,240,200,.9)"); glow.addColorStop(1, "rgba(255,200,120,0)");
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, 70, 0, Math.PI * 2); ctx.fill();
      if (starImg.ok) ctx.drawImage(starImg, cx - 26, cy - 26, 52, 52);
      else { ctx.fillStyle = "#ffd86a"; ctx.beginPath(); ctx.arc(cx, cy, 18, 0, Math.PI * 2); ctx.fill(); }

      // planets
      for (const pl of planets) {
        if (!reduced) pl.angle += pl.speed * dt;
        const px = cx + Math.cos(pl.angle) * pl.orbit * R, py = cy + Math.sin(pl.angle) * pl.orbit * R;
        pl._x = px; pl._y = py;
        if (pl.img.ok) ctx.drawImage(pl.img, px - pl.size, py - pl.size, pl.size * 2, pl.size * 2);
        else { ctx.fillStyle = "#7aa0d0"; ctx.beginPath(); ctx.arc(px, py, pl.size, 0, Math.PI * 2); ctx.fill(); }
      }
      // station
      if (!reduced) station.angle += station.speed * dt;
      const sx = cx + Math.cos(station.angle) * station.orbit * R, sy = cy + Math.sin(station.angle) * station.orbit * R;
      if (station.img.ok) ctx.drawImage(station.img, sx - 16, sy - 16, 32, 32);
      else { ctx.fillStyle = "#9aa9c8"; ctx.fillRect(sx - 8, sy - 8, 16, 16); }

      // ---- ships: behaviour + render ----
      station._x = sx; station._y = sy;
      if (!reduced) {
        const alive = ships.reduce((n, s) => n + (s.state !== "dead" ? 1 : 0), 0);
        if (alive < targetPop && Math.random() < dt * 2.5) spawnShip();
        // occasionally a dogfight breaks out between two cruising ships
        combatCooldown -= dt;
        if (combatCooldown <= 0 && Math.random() < dt * 0.05) {
          const cand = ships.filter(s => s.state === "travel");
          if (cand.length >= 2) {
            const a = Util.pick(cand); let b = Util.pick(cand);
            if (b === a) b = cand[(cand.indexOf(a) + 1) % cand.length];
            const ccx = (a.x + b.x) / 2, ccy = (a.y + b.y) / 2;
            for (const s of [a, b]) { s.state = "combat"; s.foe = (s === a ? b : a); s.combatT = Util.randFloat(3, 6); s.cx = ccx; s.cy = ccy; s.orbA = Math.random() * 6.28; }
            const ally = ships.find(s => s.state === "travel" && (s.race === a.race || s.race === b.race));
            if (ally && Math.random() < 0.6) { ally.target = { kind: "roam", x: ccx, y: ccy }; ally._interfere = 2.5; }
            combatCooldown = Util.randFloat(14, 34);
          }
        }
      }
      const env = { targetPos, pickTarget, explode, spark, sx, sy };
      for (const sh of ships) {
        if (!reduced) this._stepShip(sh, dt, env);
        const a = Util.clamp(sh.alpha, 0, 1);
        if (a <= 0) continue;
        ctx.save(); ctx.globalAlpha = a; ctx.translate(sh.x, sh.y); ctx.rotate(sh.ang || 0);
        if (sh.img && sh.img.ok) ctx.drawImage(sh.img, -10, -6, 20, 12);
        else { ctx.fillStyle = RACES[sh.race] ? RACES[sh.race].color : "#cdd6f5"; ctx.fillRect(-4, -2, 8, 4); }
        ctx.restore();
      }
      for (let i = ships.length - 1; i >= 0; i--) if (ships[i].state === "dead") ships.splice(i, 1);
      // explosion / muzzle particles
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]; p.life -= dt;
        if (p.life <= 0) { particles.splice(i, 1); continue; }
        p.x += p.vx * dt; p.y += p.vy * dt;
        ctx.fillStyle = p.color + (p.life / p.max).toFixed(2) + ")";
        ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
      }

      if (!reduced) this.raf = requestAnimationFrame(draw);
    };
    if (reduced) { draw(performance.now()); }   // single static frame
    else this.raf = requestAnimationFrame(draw);
    this.scene = { canvas };
  },

  // One ship's behaviour for a frame. States: spawn → travel → (dock | land) →
  // travel … with rare combat. Docked ships linger; landed ships fade into a
  // planet and despawn; combat ends with one ship exploding.
  _stepShip(sh, dt, env) {
    const { targetPos, pickTarget, explode, spark, sx, sy } = env;
    const moveTo = (tx, ty, slow) => {
      const dx = tx - sh.x, dy = ty - sh.y, d = Math.hypot(dx, dy) || 1;
      const v = sh.spd * (slow ? 0.5 : 1) * dt;
      sh.x += dx / d * v; sh.y += dy / d * v; sh.ang = Math.atan2(dy, dx);
      return d;
    };
    switch (sh.state) {
      case "spawn":
        sh.alpha += dt * 0.8;
        if (sh.alpha >= 1) { sh.alpha = 1; sh.state = "travel"; sh.target = pickTarget(); }
        break;
      case "travel": {
        if (!sh.target) sh.target = pickTarget();
        const p = targetPos(sh.target);
        const d = moveTo(p.x, p.y);
        if (d < 8) {
          if (sh.target.kind === "station") { sh.state = "dock"; sh.dwell = Util.randFloat(2.5, 7); }
          else if (sh.target.kind === "planet") { sh.state = "land"; sh.landRef = sh.target; }
          else sh.target = pickTarget();   // roam point reached → new errand
        }
        break;
      }
      case "dock": {   // linger near the (moving) station
        sh.x += ((sx + 16) - sh.x) * Math.min(1, dt * 3);
        sh.y += ((sy + 16) - sh.y) * Math.min(1, dt * 3);
        sh.dwell -= dt;
        if (sh.dwell <= 0) { sh.state = "travel"; sh.target = pickTarget({ kind: "station" }); }
        break;
      }
      case "land": {   // settle onto the planet and fade out
        const p = targetPos(sh.landRef);
        moveTo(p.x, p.y, true);
        sh.alpha -= dt * 0.9;
        if (sh.alpha <= 0) sh.state = "dead";
        break;
      }
      case "combat": {   // orbit the fight, spit sparks, then resolve
        sh.orbA += dt * 3.2;
        const rr = 18 + Math.sin(sh.orbA * 1.7) * 8;
        sh.x = sh.cx + Math.cos(sh.orbA) * rr;
        sh.y = sh.cy + Math.sin(sh.orbA) * rr;
        sh.ang = sh.orbA + Math.PI / 2;
        if (Math.random() < dt * 4) spark(sh.x, sh.y);
        sh.combatT -= dt;
        if (sh.combatT <= 0) {
          if (sh.foe && sh.foe.state === "combat") {
            if (sh.x <= sh.foe.x) {   // left ship resolves the duel (once)
              const loser = Math.random() < 0.5 ? sh : sh.foe;
              const winner = loser === sh ? sh.foe : sh;
              explode(loser.x, loser.y, "rgba(255,150,70,");
              loser.state = "dead";
              winner.state = "travel"; winner.target = null; winner.foe = null;
            }
          } else { sh.state = "travel"; sh.target = null; sh.foe = null; }
        }
        break;
      }
    }
    if (sh._interfere != null) { sh._interfere -= dt; if (sh._interfere <= 0) sh._interfere = null; }
  },

  stopScene() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this._onResize) { window.removeEventListener("resize", this._onResize); this._onResize = null; }
  },
  stopSystem() {
    this.stopScene();
    clearInterval(this.feedTimer); this.feedTimer = null;
    this.current = null;
  },

  // live mechanical event landed: if its system view is open, show it; refresh nodes
  onLocalEvent(entry) {
    if (this.open && !this.refs.systemView.classList.contains("hidden") && this.current === entry.systemId) {
      const sys = Galaxy.get(entry.systemId);
      if (sys) this.renderInfo(sys);   // refreshes effects banner + feed list
    }
    if (this.open && !this.refs.galaxyView.classList.contains("hidden")) this.updateGalaxyNodes();
  },
};

window.StarMap = StarMap;
