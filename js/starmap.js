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
      stars: $("galaxy-stars"),
      galaxyView: $("galaxy-view"), systemView: $("system-view"),
      canvas: $("system-canvas"), info: $("system-info"), planetTip: $("planet-tip"),
      title: $("sm-title"), crumbSys: $("sm-crumb-sys"),
      btnOpen: $("btn-starmap"), btnClose: $("sm-close"), toGalaxy: $("sm-to-galaxy"),
    };
    this.refs.btnOpen.onclick = () => this.openGalaxy();
    this.refs.btnClose.onclick = () => this.close();
    this.refs.toGalaxy.onclick = () => this.showGalaxy();
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape" || !this.open) return;
      const pm = window.PlanetView && PlanetView.refs().modal;
      if (pm && !pm.classList.contains("hidden")) return;   // let the planet popup take Escape first
      this.close();
    });
    if (window.PlanetView) PlanetView.init();
  },

  // Re-render the currently open system's info panel (after build/close in the popup).
  refreshInfo() { if (this.current && !this.refs.systemView.classList.contains("hidden")) { const sys = Galaxy.get(this.current); if (sys) this.renderInfo(sys); } },

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
    this.stopStars();
    clearInterval(this.galaxyTimer); this.galaxyTimer = null;
  },
  showGalaxy() {
    this.stopSystem();
    this.refs.systemView.classList.add("hidden");
    this.refs.galaxyView.classList.remove("hidden");
    this.refs.crumbSys.textContent = "";
    this.refs.title.textContent = "GALACTIC CHART";
    this.renderGalaxy();
    this.startStars();
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

      g.addEventListener("click", () => { if (this._dragged) return; this.openSystem(sys.id); });
      g.addEventListener("mouseenter", e => this.showTip(sys, e));
      g.addEventListener("mousemove", e => this.moveTip(e));
      g.addEventListener("mouseleave", () => this.refs.tip.style.display = "none");
      svg.appendChild(g);
      this._nodeEls[sys.id] = { ring, g };
    }
    this.updateGalaxyNodes();
    this._fitGalaxy();
    this._initPanZoom();
  },

  // ===== galaxy pan / zoom =================================================
  // The galaxy is drawn in a fixed 1000×620 coordinate space; we pan & zoom by
  // mutating the SVG viewBox. getScreenCTM() handles the pixel↔user conversion,
  // so this stays correct under preserveAspectRatio letterboxing.
  _setVB(v) { this.gz = v; this.refs.svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`); },
  _toSVG(cx, cy) {
    const m = this.refs.svg.getScreenCTM(); if (!m) return { x: 0, y: 0 };
    const p = this.refs.svg.createSVGPoint(); p.x = cx; p.y = cy;
    const q = p.matrixTransform(m.inverse()); return { x: q.x, y: q.y };
  },
  // Keep the viewBox at the screen's aspect ratio (so it always fills, no
  // letterbox), clamp the zoom range, and keep the view over the content.
  _clampVB(v) {
    const AR = this._gAR, B = this._gB;
    const w = Util.clamp(v.w, this._gMinW, this._gMaxW), h = w / AR;
    const rw = B.x1 - B.x0, rh = B.y1 - B.y0;
    const x = w >= rw ? (B.x0 + B.x1 - w) / 2 : Util.clamp(v.x, B.x0, B.x1 - w);
    const y = h >= rh ? (B.y0 + B.y1 - h) / 2 : Util.clamp(v.y, B.y0, B.y1 - h);
    return { x, y, w, h };
  },
  // "Cover" fit: size the viewBox to the screen's aspect ratio and zoom so the
  // cluster of systems FILLS the view (cropping the long axis) instead of
  // floating tiny in a mostly-empty 1000×620 frame. The user pans (drag /
  // swipe) to reach cropped edges and pinches / scrolls to zoom out for the
  // whole galaxy.
  _fitGalaxy() {
    const W = 1000, H = 620;
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const sys of Galaxy.list) {
      const x = sys.pos.x * W, y = sys.pos.y * H;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = W; maxY = H; }
    minX -= 60; maxX += 60; minY -= 90; maxY += 70;    // extra top pad for sector labels
    const cw = maxX - minX, ch = maxY - minY;
    const r = this.refs.galaxyView.getBoundingClientRect();
    const AR = (r.width > 0 && r.height > 0) ? r.width / r.height : cw / ch;
    this._gAR = AR;
    this._gB = { x0: minX - cw * 0.18, y0: minY - ch * 0.18, x1: maxX + cw * 0.18, y1: maxY + ch * 0.18 };
    this._gMaxW = Math.max(cw, ch * AR) * 1.12;        // zoom-out reveals the whole cluster
    this._gMinW = Math.max(120, Math.min(cw, ch * AR) * 0.3);
    let w, h;                                          // cover: fill the short axis
    if (cw / ch > AR) { h = ch; w = h * AR; } else { w = cw; h = w / AR; }
    this._setVB(this._clampVB({ x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - h / 2, w, h }));
  },
  _zoomAt(cx, cy, factor) {
    const b = this._toSVG(cx, cy);
    const fx = (b.x - this.gz.x) / this.gz.w, fy = (b.y - this.gz.y) / this.gz.h;
    const w = this.gz.w * factor, h = w / this._gAR;
    this._setVB(this._clampVB({ x: b.x - fx * w, y: b.y - fy * h, w, h }));
  },
  _panBy(dxPx, dyPx) {
    const m = this.refs.svg.getScreenCTM(); if (!m || !m.a) return;
    this._setVB(this._clampVB({ x: this.gz.x - dxPx / m.a, y: this.gz.y - dyPx / m.d, w: this.gz.w, h: this.gz.h }));
  },
  _initPanZoom() {
    if (this._pzReady) return; this._pzReady = true;
    const svg = this.refs.svg;
    this._ptrs = new Map();
    // No pointer capture: it can swallow the tap→click that opens a system on
    // touch. Releases are caught on window so a finger leaving the svg can't
    // strand a drag. The _dragged flag suppresses the click after a real pan.
    svg.addEventListener("pointerdown", e => {
      this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this._dragged = false; this._pinchPrev = null;
      svg.classList.add("grabbing");
    });
    svg.addEventListener("pointermove", e => {
      const p = this._ptrs.get(e.pointerId); if (!p) return;
      const px = p.x, py = p.y; p.x = e.clientX; p.y = e.clientY;
      if (this._ptrs.size >= 2) { this._pinch(); return; }
      if (Math.abs(e.clientX - px) + Math.abs(e.clientY - py) > 2) this._dragged = true;
      this._panBy(e.clientX - px, e.clientY - py);
    });
    const up = e => {
      if (!this._ptrs.delete(e.pointerId)) return;
      this._pinchPrev = null;
      if (!this._ptrs.size) svg.classList.remove("grabbing");
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    svg.addEventListener("wheel", e => {
      e.preventDefault();
      this._zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });
  },
  _pinch() {
    const [a, b] = [...this._ptrs.values()];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (this._pinchPrev && dist > 0) {
      this._zoomAt(mid.x, mid.y, this._pinchPrev.dist / dist);
      this._panBy(mid.x - this._pinchPrev.mid.x, mid.y - this._pinchPrev.mid.y);
    }
    this._pinchPrev = { dist, mid }; this._dragged = true;
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
    this.stopStars();
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

    const planets = sys.planets.map((p, i) => {
      const im = ASSET.planet(p.type);
      const ind = window.Industries && Industries.at(sys.id, i);
      let tag = `<span class="p-open">▸ click to open</span>`;
      if (ind) { const st = Industries.status(ind); const comm = COMMODITIES.find(c => c.id === p.commodity);
        tag = `<span class="ind-stat ind-${st}">${st}</span> <span class="p-open">${comm ? comm.name : p.commodity}</span>`; }
      return `<li class="planet planet-open" data-planet="${i}">
        <img src="${im}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tintbox',textContent:'${p.type[0].toUpperCase()}'}))"/>
        <div><b>${p.name}</b><span class="ptype">${p.type.replace("_", " ")}</span>
        <div class="pind">${p.industry} · <span class="cat cat-${p.cat}">${p.cat}</span></div>
        <div class="pimp">importing <b>${p.importing}</b></div>
        <div class="p-ind">${tag}</div></div></li>`;
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
      UI.toast(`Unlocked ${sys.name}!`, "good"); UI.renderSystems();
      window.Game.requestSave(); this.renderInfo(sys);
    };

    // planet list: hover for a quick-view card, click to open the planet popup
    const tip = this.refs.planetTip;
    this.refs.info.querySelectorAll(".planet-open").forEach(li => {
      const idx = +li.dataset.planet, p = sys.planets[idx];
      li.onclick = () => { if (window.PlanetView) PlanetView.open(sys, idx); };
      if (!tip) return;
      li.onmouseenter = () => {
        const fac = FACTIONS[CATEGORY_FACTION[p.cat]] || {};
        tip.innerHTML = `<b>${p.name}</b><div class="pt-sub">${p.type.replace("_", " ")} · <span style="color:${fac.color || "var(--ink-dim)"}">${fac.name || ""}</span></div><div class="pt-go">▸ click to open industries</div>`;
        tip.style.display = "block";
      };
      li.onmousemove = e => { const r = this.refs.systemView.getBoundingClientRect(); tip.style.left = (e.clientX - r.left + 14) + "px"; tip.style.top = (e.clientY - r.top + 14) + "px"; };
      li.onmouseleave = () => { tip.style.display = "none"; };
    });

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

    // The hyperspace gate sits at the system's edge: ships warp in here from
    // other systems, and ships heading "out" jump away through it.
    const gatePos = () => ({ x: W() - 64, y: H() * 0.3 });

    // ---- ambient ship traffic (with behaviour) ----
    const raceKeys = Object.keys(RACES);
    const targetPop = reduced ? 4 : 9;
    const ships = [];
    const particles = [];
    const raceImg = r => this.img(ASSET.raceship(r));
    const shipSpeed = () => Util.randFloat(SYSTEMVIEW.shipSpeedMin, SYSTEMVIEW.shipSpeedMax);
    const fillShip = t => t
      .replace(/\{SYS\}/g, sys.name)
      .replace(/\{RACE\}/g, RACES[Util.pick(raceKeys)].name)
      .replace(/\{COMM\}/g, Util.pick(COMMODITIES).name)
      .replace(/\{PLANET\}/g, sys.planets.length ? Util.pick(sys.planets).name : sys.name);
    const say = (sh, pool) => { const lines = SHIP_RADIO[pool]; if (lines) sh.bubble = { text: fillShip(Util.pick(lines)), t: SYSTEMVIEW.bubbleMs / 1000 }; };
    // Queued multi-turn conversations: each entry is one utterance due at `at`.
    const convo = [];
    const startDialogue = (a, b, baseNow) => {
      const lines = Util.pick(SHIP_DIALOGUES);
      let at = baseNow;
      lines.forEach((ln, i) => { convo.push({ sh: (i % 2 === 0) ? a : b, text: fillShip(ln), at }); at += Util.randFloat(1500, 2300); });
      return at;   // when the exchange wraps (used to gate the next one)
    };

    const dockPoints = () => {
      const pts = planets.map((pl, i) => ({ x: pl._x ?? W() / 2, y: pl._y ?? H() / 2, kind: "planet", idx: i }));
      pts.push({ x: station._x ?? W() / 2, y: station._y ?? H() / 2, kind: "station" });
      return pts;
    };
    const targetPos = t => {
      if (!t) return { x: W() / 2, y: H() / 2 };
      if (t.kind === "planet") { const pl = planets[t.idx]; return { x: pl?._x ?? W() / 2, y: pl?._y ?? H() / 2 }; }
      if (t.kind === "station") return { x: station._x ?? W() / 2, y: station._y ?? H() / 2 };
      if (t.kind === "gate") return gatePos();
      return { x: t.x, y: t.y };
    };
    // Ships mostly shuttle between docks, but sometimes choose the gate (leave).
    const pickTarget = (avoid, noGate) => {
      if (!noGate && Math.random() < SYSTEMVIEW.gateLeaveChance) return { kind: "gate" };
      const docks = dockPoints();
      let t = Util.pick(docks);
      if (avoid && t.kind === avoid.kind && t.idx === avoid.idx && docks.length > 1) t = Util.pick(docks);
      return t.kind === "planet" ? { kind: "planet", idx: t.idx } : { kind: "station" };
    };
    const warpFlash = (x, y) => this._gateBurst(particles, x, y);
    // New ships arrive through the gate (warp-in), then go about their errands.
    const spawnShip = () => {
      const g = gatePos();
      const r = Util.pick(raceKeys);
      ships.push({ x: g.x, y: g.y, race: r, img: raceImg(r), alpha: 0, scale: 0.3, state: "warpIn",
        spd: shipSpeed(), ang: Math.atan2(H() / 2 - g.y, W() / 2 - g.x), target: null, dwell: 0 });
      warpFlash(g.x, g.y);
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
      ships.push({ x: Math.random() * W(), y: Math.random() * H(), race: r, img: raceImg(r), scale: 1,
        alpha: 1, state: "travel", spd: shipSpeed(), ang: Math.random() * 6.28, target: null, dwell: 0 });
    }
    let combatCooldown = 5;
    let lastChatterAt = 0;

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

      // hyperspace gate at the system edge — ships warp in/out through it
      const gp = gatePos();
      this._drawGate(ctx, gp.x, gp.y, now * 0.001);

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
            say(a, "combat"); b._replyIn = Util.randFloat(0.4, 0.9); b._replyPool = "combat";
            const ally = ships.find(s => s.state === "travel" && (s.race === a.race || s.race === b.race));
            if (ally && Math.random() < 0.6) { ally.target = { kind: "roam", x: ccx, y: ccy }; ally._interfere = 2.5; }
            combatCooldown = Util.randFloat(14, 34);
          }
        }
        // ambient radio: a ship strikes up a conversation with a nearby ship
        if (now - lastChatterAt > SYSTEMVIEW.chatterMinGapMs && Math.random() < dt * SYSTEMVIEW.chatterRate) {
          const talkers = ships.filter(s => (s.state === "travel" || s.state === "dock") && !s.bubble);
          if (talkers.length) {
            const a = Util.pick(talkers);
            let b = null, bd = 1e9;
            for (const o of ships) {
              if (o === a || o.bubble || o.state === "dead" || o.state === "warpOut" || o.state === "warpIn") continue;
              const dd = Math.hypot(o.x - a.x, o.y - a.y); if (dd < bd) { bd = dd; b = o; }
            }
            if (b && bd < Math.min(w, h) * 0.7) lastChatterAt = startDialogue(a, b, now);  // multi-turn exchange
            else { say(a, "hail"); lastChatterAt = now; }                                   // solo radio call
          }
        }
        // deliver any queued conversation turns whose moment has arrived
        for (let i = convo.length - 1; i >= 0; i--) {
          const u = convo[i];
          if (now < u.at) continue;
          if (u.sh.state !== "dead" && u.sh.state !== "warpOut") u.sh.bubble = { text: u.text, t: SYSTEMVIEW.bubbleMs / 1000 };
          convo.splice(i, 1);
        }
      }
      const env = { targetPos, pickTarget, explode, spark, say, warpFlash, gatePos, sx, sy };
      for (const sh of ships) {
        if (!reduced) this._stepShip(sh, dt, env);
        const a = Util.clamp(sh.alpha, 0, 1);
        if (a <= 0) continue;
        const sc = sh.scale ?? 1;
        ctx.save(); ctx.globalAlpha = a; ctx.translate(sh.x, sh.y); ctx.rotate(sh.ang || 0);
        if (sh.img && sh.img.ok) ctx.drawImage(sh.img, -10 * sc, -6 * sc, 20 * sc, 12 * sc);
        else { ctx.fillStyle = RACES[sh.race] ? RACES[sh.race].color : "#cdd6f5"; ctx.fillRect(-4 * sc, -2 * sc, 8 * sc, 4 * sc); }
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
      // speech bubbles ride on top of everything
      for (const sh of ships) this._drawBubble(ctx, sh, w, h);

      if (!reduced) this.raf = requestAnimationFrame(draw);
    };
    if (reduced) { draw(performance.now()); }   // single static frame
    else this.raf = requestAnimationFrame(draw);
    this.scene = { canvas };
  },

  // One ship's behaviour for a frame. States: warpIn → travel → (dock | land |
  // warpOut) → travel … with rare combat. Ships arrive through the hyperspace
  // gate, run errands between docks, and either land (fade into a planet),
  // jump out through the gate, or get caught in a dogfight. Speech bubbles and
  // delayed replies tick down here too.
  _stepShip(sh, dt, env) {
    const { targetPos, pickTarget, explode, spark, say, warpFlash, gatePos, sx, sy } = env;
    const moveTo = (tx, ty, slow) => {
      const dx = tx - sh.x, dy = ty - sh.y, d = Math.hypot(dx, dy) || 1;
      const v = sh.spd * (slow ? 0.5 : 1) * dt;
      sh.x += dx / d * v; sh.y += dy / d * v; sh.ang = Math.atan2(dy, dx);
      return d;
    };
    // voice-line bubble lifetime + any pending reply
    if (sh.bubble) { sh.bubble.t -= dt; if (sh.bubble.t <= 0) sh.bubble = null; }
    if (sh._replyIn != null) {
      sh._replyIn -= dt;
      if (sh._replyIn <= 0) { if (sh.state !== "dead" && sh.state !== "warpOut") say(sh, sh._replyPool || "reply"); sh._replyIn = null; sh._replyPool = null; }
    }
    switch (sh.state) {
      case "warpIn": {   // materialize at the gate and drift inward
        sh.alpha = Math.min(1, sh.alpha + dt * 1.8);
        sh.scale = Math.min(1, (sh.scale ?? 0.3) + dt * 1.8);
        sh.x += Math.cos(sh.ang) * sh.spd * 0.5 * dt; sh.y += Math.sin(sh.ang) * sh.spd * 0.5 * dt;
        if (sh.alpha >= 1) { sh.alpha = 1; sh.scale = 1; sh.state = "travel"; sh.target = pickTarget(null, true); if (Math.random() < 0.55) say(sh, "warpIn"); }
        break;
      }
      case "travel": {
        if (!sh.target) sh.target = pickTarget();
        const p = targetPos(sh.target);
        const d = moveTo(p.x, p.y);
        if (d < 8) {
          if (sh.target.kind === "station") { sh.state = "dock"; sh.dwell = Util.randFloat(2.5, 7); }
          else if (sh.target.kind === "planet") { sh.state = "land"; sh.landRef = sh.target; }
          else if (sh.target.kind === "gate") { sh.state = "warpOut"; sh.warpT = Util.randFloat(0.7, 1.1); if (Math.random() < 0.7) say(sh, "warpOut"); }
          else sh.target = pickTarget();   // roam point reached → new errand
        }
        break;
      }
      case "warpOut": {   // charge at the gate, then blink out of the system
        sh.warpT -= dt;
        sh.alpha = Math.max(0, sh.alpha - dt * 1.3);
        sh.scale = Math.max(0.12, (sh.scale ?? 1) - dt * 1.1);
        if (sh.warpT <= 0) { warpFlash(sh.x, sh.y); sh.state = "dead"; }
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
      case "combat": {   // orbit the fight, spit sparks, bark, then resolve
        sh.orbA += dt * 3.2;
        const rr = 18 + Math.sin(sh.orbA * 1.7) * 8;
        sh.x = sh.cx + Math.cos(sh.orbA) * rr;
        sh.y = sh.cy + Math.sin(sh.orbA) * rr;
        sh.ang = sh.orbA + Math.PI / 2;
        if (Math.random() < dt * 4) spark(sh.x, sh.y);
        if (!sh.bubble && sh._replyIn == null && Math.random() < dt * 0.4) say(sh, "combat");
        sh.combatT -= dt;
        if (sh.combatT <= 0) {
          if (sh.foe && sh.foe.state === "combat") {
            if (sh.x <= sh.foe.x) {   // left ship resolves the duel (once)
              const loser = Math.random() < 0.5 ? sh : sh.foe;
              const winner = loser === sh ? sh.foe : sh;
              explode(loser.x, loser.y, "rgba(255,150,70,");
              loser.state = "dead";
              winner.state = "travel"; winner.target = null; winner.foe = null;
              if (Math.random() < 0.7) say(winner, "win");
            }
          } else { sh.state = "travel"; sh.target = null; sh.foe = null; }
        }
        break;
      }
    }
    if (sh._interfere != null) { sh._interfere -= dt; if (sh._interfere <= 0) sh._interfere = null; }
  },

  // ---- scene draw helpers (hyperspace gate + speech bubbles) ----
  _gateBurst(particles, x, y) {
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2, s = Util.randFloat(40, 110);
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: Util.randFloat(.3, .7), max: .7, color: "rgba(130,200,255," });
    }
  },

  _drawGate(ctx, gx, gy, t) {
    ctx.save();
    const glow = ctx.createRadialGradient(gx, gy, 2, gx, gy, 34);
    glow.addColorStop(0, "rgba(130,200,255,.5)"); glow.addColorStop(1, "rgba(130,200,255,0)");
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(gx, gy, 34, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2;
    for (let k = 0; k < 3; k++) {
      ctx.strokeStyle = `rgba(150,210,255,${(0.8 - k * 0.18).toFixed(2)})`;
      const r = 9 + k * 5;
      ctx.beginPath(); ctx.ellipse(gx, gy, r, r * 0.42, t * (1.1 + k * 0.5), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = "rgba(210,238,255,.95)"; ctx.beginPath(); ctx.arc(gx, gy, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(170,210,255,.75)"; ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.fillText("⇋ HYPERSPACE GATE", gx, gy + 30);
    ctx.restore();
  },

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  },

  _drawBubble(ctx, sh, w, h) {
    const b = sh.bubble;
    if (!b || b.t <= 0 || (sh.alpha ?? 1) <= 0.05) return;
    ctx.save();
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    const tw = ctx.measureText(b.text).width;
    const padX = 6, bh = 18, bw = tw + padX * 2;
    let bx = sh.x - bw / 2, by = sh.y - 16 - bh;
    bx = Util.clamp(bx, 3, w - bw - 3); by = Util.clamp(by, 3, h - bh - 3);
    const al = Util.clamp(b.t, 0, 1);
    ctx.globalAlpha = 0.92 * al; ctx.fillStyle = "rgba(10,14,24,.92)";
    // pointer tail toward the ship
    ctx.beginPath(); ctx.moveTo(sh.x - 4, by + bh); ctx.lineTo(sh.x + 4, by + bh);
    ctx.lineTo(sh.x, Math.min(sh.y - 11, by + bh + 7)); ctx.closePath(); ctx.fill();
    this._roundRect(ctx, bx, by, bw, bh, 5); ctx.fill();
    ctx.strokeStyle = (RACES[sh.race] && RACES[sh.race].color) || "#7b8cff"; ctx.lineWidth = 1; ctx.stroke();
    ctx.globalAlpha = al; ctx.fillStyle = "#e6ecff";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(b.text, bx + padX, by + bh / 2 + 0.5);
    ctx.restore();
  },

  stopScene() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this._onResize) { window.removeEventListener("resize", this._onResize); this._onResize = null; }
  },

  // ===== galaxy starfield =================================================
  // A twinkling, mouse-parallax starfield behind the galactic chart — a vanilla
  // adaptation of the bundui "Stars" interactive background. Respects reduced
  // motion (single static frame) and the tab-hidden suspend/resume lifecycle.
  startStars() {
    const cv = this.refs.stars; if (!cv || !cv.getContext) return;
    this.stopStars();
    const reduced = !!(this.s().settings && this.s().settings.reduced);
    const ctx = cv.getContext("2d");
    this._starMouse = { x: 0, y: 0 };

    const seed = () => {
      const r = this.refs.galaxyView.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._starW = r.width; this._starH = r.height;
      const area = r.width * r.height;
      const n = Math.max(50, Math.min(reduced ? 110 : 230, Math.round(area / 4600)));
      const stars = [];
      for (let i = 0; i < n; i++) {
        const depth = Math.random();                 // 0 far … 1 near (drives size + parallax)
        stars.push({
          x: Math.random(), y: Math.random(),
          r: 0.35 + depth * 0.85,                    // tiny — well under system-node size
          depth,
          a: 0.22 + Math.random() * 0.4,             // dim base brightness
          tw: 0.6 + Math.random() * 2.4,             // twinkle speed
          ph: Math.random() * Math.PI * 2,           // twinkle phase
          hue: Math.random() < 0.14 ? (Math.random() < 0.5 ? "#9fb4ff" : "#ffd9a0") : "#eaf0ff",
        });
      }
      this._stars = stars;
      this._shooters = [];
    };
    seed();

    // mouse parallax (canvas is pointer-events:none, so listen on the container)
    this._onStarMove = e => {
      const r = this.refs.galaxyView.getBoundingClientRect();
      this._starMouse.x = ((e.clientX - r.left) / Math.max(1, r.width)) - 0.5;
      this._starMouse.y = ((e.clientY - r.top) / Math.max(1, r.height)) - 0.5;
    };
    if (!reduced) this.refs.galaxyView.addEventListener("pointermove", this._onStarMove);

    this._onStarsResize = () => seed();
    window.addEventListener("resize", this._onStarsResize);

    const draw = now => {
      const W = this._starW, H = this._starH;
      ctx.clearRect(0, 0, W, H);
      const mx = this._starMouse.x, my = this._starMouse.y;
      for (const s of this._stars) {
        const px = mx * s.depth * 20, py = my * s.depth * 20;   // near stars drift a touch more
        const x = s.x * W + px, y = s.y * H + py;
        const tw = reduced ? 0.85 : 0.72 + 0.28 * Math.sin(now / 1000 * s.tw + s.ph);
        ctx.globalAlpha = Math.max(0, Math.min(1, s.a * tw));
        ctx.fillStyle = s.hue;
        ctx.beginPath(); ctx.arc(x, y, s.r, 0, Math.PI * 2); ctx.fill();
      }
      // occasional shooting star
      if (!reduced) {
        if (Math.random() < 0.009 && this._shooters.length < 2) {
          const fromLeft = Math.random() < 0.5;
          this._shooters.push({
            x: fromLeft ? -0.05 * W : 1.05 * W, y: Math.random() * H * 0.6,
            vx: (fromLeft ? 1 : -1) * (5 + Math.random() * 4), vy: 2 + Math.random() * 2, life: 1,
          });
        }
        for (const sh of this._shooters) {
          sh.x += sh.vx; sh.y += sh.vy; sh.life -= 0.012;
          const len = 14;
          const g = ctx.createLinearGradient(sh.x, sh.y, sh.x - sh.vx * len / 4, sh.y - sh.vy * len / 4);
          g.addColorStop(0, `rgba(200,220,255,${Math.max(0, sh.life)})`);
          g.addColorStop(1, "rgba(200,220,255,0)");
          ctx.globalAlpha = 1; ctx.strokeStyle = g; ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.moveTo(sh.x, sh.y);
          ctx.lineTo(sh.x - sh.vx * len / 4, sh.y - sh.vy * len / 4); ctx.stroke();
        }
        this._shooters = this._shooters.filter(s => s.life > 0 && s.x > -0.1 * W && s.x < 1.1 * W);
      }
      ctx.globalAlpha = 1;
      if (!reduced) this.starRaf = requestAnimationFrame(draw);
    };
    if (reduced) draw(0); else this.starRaf = requestAnimationFrame(draw);
  },
  stopStars() {
    if (this.starRaf) cancelAnimationFrame(this.starRaf);
    this.starRaf = null;
    if (this._onStarsResize) { window.removeEventListener("resize", this._onStarsResize); this._onStarsResize = null; }
    if (this._onStarMove && this.refs.galaxyView) { this.refs.galaxyView.removeEventListener("pointermove", this._onStarMove); this._onStarMove = null; }
  },

  // Pause the animation when the tab is backgrounded; rebuild it on return.
  suspend() {
    if (this.raf && this.current) { this._resumeScene = true; this.stopScene(); }
    if (this.open && !this.refs.galaxyView.classList.contains("hidden")) { this._resumeStars = true; this.stopStars(); }
  },
  resume() {
    if (this._resumeStars) {
      this._resumeStars = false;
      if (this.open && !this.refs.galaxyView.classList.contains("hidden")) this.startStars();
    }
    if (!this._resumeScene) return;
    this._resumeScene = false;
    const sys = this.current && Galaxy.get(this.current);
    if (this.open && sys && !this.refs.systemView.classList.contains("hidden")) this.startScene(sys);
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
