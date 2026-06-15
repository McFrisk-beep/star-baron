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

    // seed local feed with recent mechanical events for this system
    const feed = document.getElementById("sm-local-feed");
    for (const e of Galaxy.eventsFor(sys.id).slice(0, 6).reverse()) this.addLocalLine(feed, e, true);
  },

  addLocalLine(feed, entry, mechanical) {
    if (!feed) return;
    const li = document.createElement("li");
    if (mechanical) {
      li.className = "lf mech " + entry.dir;
      li.innerHTML = `<span class="lf-tag">BULLETIN</span><b>${entry.headline}</b><span class="lf-body">${entry.body}</span>`;
    } else {
      li.className = "lf";
      li.textContent = entry;
    }
    feed.appendChild(li);
    while (feed.children.length > 24) feed.removeChild(feed.firstChild);
    feed.scrollTop = feed.scrollHeight;
  },

  startLocalFeed(sys) {
    clearInterval(this.feedTimer);
    const tick = () => {
      if (!this.open || this.current !== sys.id) return;
      const feed = document.getElementById("sm-local-feed");
      this.addLocalLine(feed, Galaxy.flavorLine(sys), false);
    };
    this.feedTimer = setInterval(tick, Util.randInt(4500, 8000));
    setTimeout(tick, 1500);
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

    const targets = () => {
      const cx = W() / 2, cy = H() / 2, R = Math.min(W(), H()) * 0.42;
      const pts = planets.map(pl => ({ x: cx + Math.cos(pl.angle) * pl.orbit * R, y: cy + Math.sin(pl.angle) * pl.orbit * R }));
      pts.push({ x: cx + Math.cos(station.angle) * station.orbit * R, y: cy + Math.sin(station.angle) * station.orbit * R });
      return pts;
    };
    const ships = [];
    const nShips = reduced ? 4 : 9;
    for (let i = 0; i < nShips; i++) {
      ships.push({ x: Math.random() * W(), y: Math.random() * H(), tx: 0, ty: 0,
        spd: Util.randFloat(0.6, 1.4), img: this.img(ASSET.raceship(Util.pick(Object.keys(RACES)))), retarget: true });
    }

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

      // ships
      const tg = targets();
      for (const sh of ships) {
        if (sh.retarget) { const t = Util.pick(tg); sh.tx = t.x; sh.ty = t.y; sh.retarget = false; }
        const dx = sh.tx - sh.x, dy = sh.ty - sh.y, d = Math.hypot(dx, dy);
        if (d < 6) { sh.retarget = true; }
        else if (!reduced) { const v = sh.spd * 60 * dt; sh.x += dx / d * v; sh.y += dy / d * v; sh._ang = Math.atan2(dy, dx); }
        ctx.save(); ctx.translate(sh.x, sh.y); ctx.rotate(sh._ang || 0);
        if (sh.img.ok) ctx.drawImage(sh.img, -10, -6, 20, 12);
        else { ctx.fillStyle = "#cdd6f5"; ctx.fillRect(-4, -2, 8, 4); }
        ctx.restore();
      }

      if (!reduced) this.raf = requestAnimationFrame(draw);
    };
    if (reduced) { draw(performance.now()); }   // single static frame
    else this.raf = requestAnimationFrame(draw);
    this.scene = { canvas };
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
      this.addLocalLine(document.getElementById("sm-local-feed"), entry, true);
      const sys = Galaxy.get(entry.systemId);
      if (sys) this.renderInfo(sys);
    }
    if (this.open && !this.refs.galaxyView.classList.contains("hidden")) this.updateGalaxyNodes();
  },
};

window.StarMap = StarMap;
