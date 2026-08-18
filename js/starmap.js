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
      title: $("sm-title"), crumbSys: $("sm-crumb-sys"), sceneHint: $("sm-scene-hint"),
      btnOpen: $("btn-starmap"), btnClose: $("sm-close"), toGalaxy: $("sm-to-galaxy"),
    };
    if (this.refs.btnOpen) this.refs.btnOpen.onclick = () => this.openGalaxy();   // legacy header button (now the nav "Star Map" tab)
    // Close / Escape: system → galaxy first; only leave the overlay from the chart.
    this.refs.btnClose.onclick = () => this.backOrClose();
    this.refs.toGalaxy.onclick = () => this.showGalaxy();
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape" || !this.open) return;
      const pm = window.PlanetView && PlanetView.refs().modal;
      if (pm && !pm.classList.contains("hidden")) return;   // let the planet popup take Escape first
      this.backOrClose();
    });
    if (window.PlanetView) PlanetView.init();
  },

  backOrClose() {
    if (this.current || (this.refs.systemView && !this.refs.systemView.classList.contains("hidden")))
      this.showGalaxy();
    else this.close();
  },

  // Re-render the currently open system's info panel (after build/close in the popup).
  refreshInfo() { if (this.current && !this.refs.systemView.classList.contains("hidden")) { const sys = Galaxy.get(this.current); if (sys) this.renderInfo(sys); } },

  // ===== open / close =====================================================
  openGalaxy() {
    this.open = true;
    this.refs.overlay.classList.remove("hidden");
    document.body.classList.add("starmap-open");   // floats the command dock above the overlay (see CSS)
    this.showGalaxy();
    if (window.UI) UI.updateNavIndicator();        // slide the dock glow onto Star Map
  },
  // Nav "Star Map" tab: open when closed, close when already open.
  toggle() { this.open ? this.close() : this.openGalaxy(); },
  close() {
    this.open = false;
    this.refs.overlay.classList.add("hidden");
    document.body.classList.remove("starmap-open");
    this.stopSystem();
    this.stopStars();
    clearInterval(this.galaxyTimer); this.galaxyTimer = null;
    if (window.UI) UI.updateNavIndicator();        // restore glow to the underlying page tab
  },
  showGalaxy() {
    this.stopSystem();
    this.refs.systemView.classList.add("hidden");
    this.refs.galaxyView.classList.remove("hidden");
    this.refs.crumbSys.textContent = "";
    this.refs.title.textContent = "GALACTIC CHART";
    // The command dock floats over the chart — it's how you leave, so no ✕.
    this.refs.btnClose.classList.add("hidden");
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
      // Sentiment tint: coarse public band (exact figures stay in Stations tab).
      if (window.Stock && Stock.sentiment[sec.id] != null) {
        const s = Stock.sentiment[sec.id];
        halo.setAttribute("opacity", s >= 60 ? "0.18" : s >= 40 ? "0.28" : s >= 20 ? "0.38" : "0.48");
        if (s < 40) halo.setAttribute("fill", s < 20 ? "#ff5d73" : "#ffc24b");
      }
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
      const st = (!sys.capital && window.Stations) ? Stations.get(sys.id) : null;
      const owned = st && Stations.ownerHeld(st);
      const auction = st && window.Stations && Stations.getAuction(sys.id);
      g.setAttribute("class", "node" + (sys.capital ? " cap" : "") + (owned ? " st-owned" : "") + (auction && auction.status === "open" ? " st-auction" : ""));
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
      const surv = window.Expeditions && Expeditions.activeFor(id);
      const ring = this._nodeEls[id].ring;
      ring.setAttribute("stroke", surv ? "#5fd7ff" : evt ? "#ffc24b" : idx > 0.06 ? "#46d39a" : idx < -0.06 ? "#ff5d73" : "#3a4560");
      ring.setAttribute("stroke-width", surv || evt ? 3 : 2);
      ring.classList.toggle("pulse", !!(surv || evt));
      const docked = this.s().currentSystem === id;
      this._nodeEls[id].g.classList.toggle("docked", docked);
    }
  },

  showTip(sys, e) {
    const idx = Galaxy.localIndex(sys.id);
    const sec = Galaxy.sector(sys.sectorId);
    const evt = Market.activeLocal(sys.id);
    const dirTxt = idx > 0.06 ? `<span class="up">▲ rising</span>` : idx < -0.06 ? `<span class="down">▼ falling</span>` : "stable";
    let extra = "";
    if (!sys.capital && window.Stations) {
      const local = Stations.get(sys.id);
      const st = Stations.view(sys.id);
      if (st) {
        const auc = Stations.getAuction(sys.id);
        const sent = window.Stock ? Stock.sentiment[st.sectorId] : null;
        const band = sent == null ? "" : sent >= 60 ? "Steady" : sent >= 40 ? "Uneasy" : sent >= 20 ? "Strained" : "Critical";
        const hallN = (st.modules.exchange_hall | 0) ? (st.hall || []).length : -1;
        const office = (st.modules.contract_office | 0);
        // Reliability is a running tally of *our* record of their postings —
        // meaningless for a station we only see published.
        const rel = office && !st.remote ? Stations.reliability(st) : null;
        const officeTxt = !office ? "" : ` · Contract Office${rel == null ? "" : ` ${Math.round(rel * 100)}%`}`;
        const scr = Stations.publicScrutiny(sys.id);
        const scrTxt = scr && scr.chanceHint != null ? ` · scrutiny ${scr.chanceHint}%` : "";
        extra = `<br><span class="tip-dim">${st.name} · ${st.tier}` +
          (st.remote ? ` · ${Stations.holderTag(local)}`
            : st.status === "owned" ? " · owned"
            : st.status === "refit" ? ` · owned · refit ${Util.duration(Stations.refitLeft(st))}`
            : auc && auc.status === "open" ? ` · auction ${Util.credits(auc.highBid)}`
            : ` · ${Stations.holderTag(local)}`) +
          (band ? ` · ${band}` : "") +
          (hallN >= 0 ? ` · Exchange Hall${hallN ? ` (${hallN})` : ""}` : "") +
          officeTxt + scrTxt +
          `</span>`;
      }
    }
    this.refs.tip.innerHTML =
      `<b>${sys.name}</b> ${sys.capital ? '<span class="tip-cap">trade hub</span>' : ""}<br>` +
      `<span class="tip-dim">${sec.name} · ${RACES[sys.race].name}</span><br>` +
      `market: ${dirTxt}` + (evt.length ? `<br><span class="warn">⚠ local event active</span>` : "") + extra;
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
    this.refs.btnClose.classList.remove("hidden");
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
    const isAdmin = !!(window.Cloud && Cloud.isAdmin());
    const hasBg = !!(window.ASSET_OVERRIDES && ASSET_OVERRIDES[`spacebg:${sys.id}`]);

    let trade = "";
    if (sys.tradeable) {
      if (docked) trade = `<span class="badge">you are docked here</span>`;
      else if (unlocked) trade = `<button class="btn btn-go" id="sm-dock">Dock here</button>`;
      else trade = `<button class="btn btn-go" id="sm-unlock">Unlock — ${Util.credits(sys.unlock)}c</button>`;
    } else if (!sys.capital && window.Stations && Stations.get(sys.id)) {
      // Claimable stations: dockable (commodity exchange stays capital-only).
      const gate = Stations.canDock(sys.id);
      const scr = Stations.publicScrutiny(sys.id);
      const scrTxt = scr && scr.chanceHint != null
        ? `<span class="tip-dim"> · scrutiny ${scr.chanceHint}% (${scr.label})</span>`
        : "";
      if (docked) trade = `<span class="badge">docked at station</span>${scrTxt}`;
      else if (!gate.ok) trade = `<span class="tip-dim">${gate.msg}</span>${scrTxt}`;
      else trade = `<button class="btn btn-go" id="sm-dock">Dock here</button>${scrTxt}`;
      if (window.Expeditions) {
        const exp = Expeditions.activeFor(sys.id), cd = Expeditions.cooldownLeft(sys.id);
        if (exp) trade += ` <span class="badge">🛰 surveying…</span>`;
        else if (cd <= 0) trade += ` <button class="btn btn-mini" id="sm-survey">Survey</button>`;
      }
    } else if (window.Expeditions) {
      // backdrop outpost — not a trade hub, but you can dispatch a survey here
      const exp = Expeditions.activeFor(sys.id), cd = Expeditions.cooldownLeft(sys.id);
      if (exp) trade = `<span class="badge">🛰 surveying… ETA ${Util.duration(Expeditions.remaining(exp))}</span>`;
      else if (cd > 0) trade = `<span class="tip-dim">surveyed · again in ${Util.duration(cd)}</span>`;
      else trade = `<button class="btn btn-go" id="sm-survey">🛰 Survey system</button> <span class="tip-dim">${Expeditions.isFar(sys.id) ? "far · rich but rough" : "nearby · safer"}</span>`;
    } else {
      trade = `<span class="tip-dim">Not a trade hub · view-only outpost</span>`;
    }

    // Claimable station / auction controls (non-capitals).
    let stationBlock = "";
    if (!sys.capital && window.Stations) {
      const st = Stations.get(sys.id) || (Stations.ensure(), Stations.get(sys.id));
      if (st) {
        const auc = Stations.getAuction(sys.id);
        const openMin = Stations.openingBid(st);
        if (Stations.ownerHeld(st) && st.ownerId === Stations.playerId()) {
          const left = Stations.refitLeft(st);
          stationBlock = `<div class="si-station"><b>${st.name}</b> · yours · standing ${st.standing.toFixed(0)}${left > 0 ? ` · <span class="tip-dim">refit ${Util.duration(left)}</span>` : ""}
            <button class="btn btn-mini" id="sm-st-manage">Manage</button>
            <button class="btn btn-mini btn-warn" id="sm-st-relinquish">Relinquish</button></div>`;
        } else if (auc && auc.status === "open") {
          const left = Math.max(0, auc.closesAt - Date.now());
          const min = auc.highBid + STATIONCFG.minBidIncrement;
          stationBlock = `<div class="si-station"><b>${st.name}</b> · auction
            <div class="tip-dim">high ${Util.credits(auc.highBid)} · closes ${Util.duration(left)}</div>
            <button class="btn btn-go" id="sm-st-bid" data-min="${min}">Bid ${Util.credits(min)}</button>
            ${isAdmin ? `<button class="btn btn-mini" id="sm-st-admin-claim">Admin claim</button>` : ""}</div>`;
        } else if (st.status === "npc" || (st.status === "cooldown" && Date.now() >= st.cooldownUntil)) {
          // Another baron may hold it even though our own save says NPC — the
          // published record is the only cross-player view of a station.
          const rem = Stations.remoteHolder(sys.id);
          if (rem) {
            const v = Stations.view(sys.id);
            const mods = Object.keys(v.modules || {}).length;
            const left = Stations.refitLeft(v);
            const comm = v.prodComm && COMMODITIES.find(c => c.id === v.prodComm);
            stationBlock = `<div class="si-station"><b>${st.name}</b> · ${v.tier} · Held by ${rem.display}
              <div class="tip-dim">standing ${Math.round(v.standing)} · ${mods} module${mods === 1 ? "" : "s"} installed`
              + (comm ? ` · producing ${comm.name}` : "")
              + (left > 0 ? ` · <span class="st-refit">refit ${Util.duration(left)}</span>` : "")
              + `</div>
              ${isAdmin ? `<button class="btn btn-mini" id="sm-st-admin-claim">Admin claim</button>` : ""}</div>`;
          } else {
            stationBlock = `<div class="si-station"><b>${st.name}</b> · ${st.tier} · NPC
              <button class="btn btn-go" id="sm-st-auction" data-min="${openMin}">Open auction · ${Util.credits(openMin)}</button>
              ${isAdmin ? `<button class="btn btn-mini" id="sm-st-admin-claim">Admin claim</button>` : ""}</div>`;
          }
        } else if (st.status === "cooldown") {
          stationBlock = `<div class="si-station"><b>${st.name}</b> · cooling down ${Util.duration(st.cooldownUntil - Date.now())}
            ${isAdmin ? `<button class="btn btn-mini" id="sm-st-admin-claim">Admin claim</button>` : ""}</div>`;
        }
        // Exchange Hall: visitors must be docked here; owners manage via Stations tab.
        const hallAccess = Stations.canUseHall(sys.id);
        if (hallAccess.ok && st.ownerId !== Stations.playerId()) {
          const listings = Stations.hallListings(sys.id);
          // The holder's rate, not our vacant copy's default.
          const tariff = (((hallAccess.st || st).saleTariffBps || 0) / 100).toFixed(0);
          const rows = listings.map(l => {
            const left = Math.max(0, l.expiresAt - Date.now());
            const mine = Stations.listingMine(l);
            const seller = mine ? "your stall" : l.shared ? l.sellerName : "house stall";
            return `<tr>
              <td>${l.name}<div class="tip-dim">${l.kind} · ${seller} · ${Util.duration(left)}</div></td>
              <td class="num">${Util.credits(l.price)}</td>
              <td>${mine
                ? `<button class="btn btn-mini" data-sm-hall-cancel="${l.id}">Cancel</button>`
                : `<button class="btn btn-mini btn-go" data-sm-hall-buy="${l.id}">Buy</button>`}</td>
            </tr>`;
          }).join("") || `<tr><td colspan="3" class="tip-dim">No listings</td></tr>`;
          const inv = (window.Bazaar ? Bazaar.inventoryItems() : []).map(it => {
            const kind = window.Items && Items.isBlackbox(it) ? "blackbox" : "gear";
            return `<option value="${kind}:${it.uid}">${it.name}</option>`;
          });
          const exs = (window.Extractors ? Extractors.unequipped() : []).map(ex =>
            `<option value="extractor:${ex.uid}">${ex.name}</option>`);
          const comps = (window.Components ? Components.unequipped() : []).map(c =>
            `<option value="component:${c.uid}">${c.name || c.uid}</option>`);
          const ships = (this.s().ships || []).filter(sh => sh.status === "idle" && !sh.mercenary).map(sh =>
            `<option value="ship:${sh.uid}">${sh.name || sh.type}</option>`);
          const bps = (this.s().knownRecipes || []).map(id => {
            const r = (typeof RECIPES !== "undefined" ? RECIPES : []).find(x => x.id === id);
            return r ? `<option value="blueprint:${id}">${r.name} Blueprint</option>` : "";
          }).filter(Boolean);
          const opts = [...inv, ...exs, ...comps, ...ships, ...bps].join("") || `<option value="">Nothing listable</option>`;
          stationBlock += `<div class="si-station si-hall"><b>Exchange Hall</b> · tariff ${tariff}%
            <div class="tip-dim">Crafted goods only · docked here</div>
            <div class="st-hall-list" style="margin-top:6px">
              <select id="sm-hall-item">${opts}</select>
              <input type="number" id="sm-hall-price" min="${STATIONCFG.hallMinPrice || 50}" value="500" aria-label="list price">
              <button class="btn btn-mini btn-go" id="sm-hall-list">List</button>
            </div>
            <div class="table-wrap" style="margin-top:6px"><table class="market">
              <thead><tr><th>Listing</th><th class="num">Price</th><th></th></tr></thead>
              <tbody>${rows}</tbody>
            </table></div></div>`;
        } else if (hallAccess.browse) {
          // Their shelf, read-only: signed out, or on a project where the hall
          // SQL isn't live. You see what's on it and what the tariff is.
          const v = hallAccess.st;
          const rows = Stations.hallListings(sys.id).map(l => `<tr>
              <td>${l.name}<div class="tip-dim">${l.kind}${l.shared ? ` · ${l.sellerName}` : ""}</div></td>
              <td class="num">${Util.credits(l.price)}</td>
            </tr>`).join("") || `<tr><td colspan="2" class="tip-dim">Shelf is empty</td></tr>`;
          stationBlock += `<div class="si-station si-hall"><b>Exchange Hall</b> · tariff ${((v.saleTariffBps || 0) / 100).toFixed(0)}%
            <div class="tip-dim">${hallAccess.msg}</div>
            <div class="table-wrap" style="margin-top:6px"><table class="market">
              <thead><tr><th>Listing</th><th class="num">Price</th></tr></thead>
              <tbody>${rows}</tbody>
            </table></div></div>`;
        } else if ((st.modules.exchange_hall | 0) && !hallAccess.ok && st.ownerId !== Stations.playerId()) {
          stationBlock += `<div class="si-station si-hall tip-dim">Exchange Hall — ${hallAccess.msg}</div>`;
        }
        // Visitor ransom offers for your seized cargo.
        if (docked && st.ownerId !== Stations.playerId()) {
          const mine = (st.impoundClaims || []).filter(c => !c.fromId || c.fromId === Stations.playerId());
          if (mine.length) {
            stationBlock += `<div class="si-station"><b>Impound ransom</b>` +
              mine.map(c => {
                const comm = COMMODITIES.find(x => x.id === c.commId);
                return `<div class="tip-dim">${c.qty}× ${comm ? comm.name : c.commId} · ${Util.credits(c.ransom)}
                  <button class="btn btn-mini btn-go" data-sm-ransom="${c.id}">Pay</button></div>`;
              }).join("") + `</div>`;
          }
        }
        // Services strip — what's online vs grayed at this dock.
        if (Stations.serviceList) {
          const svcs = Stations.serviceList(sys.id);
          stationBlock += `<div class="si-station si-services"><b>Station services</b>
            <div class="system-services">${svcs.map(r =>
              `<span class="svc-chip ${r.ok ? "on" : "off"}" title="${r.ok ? "Available" : (r.reason || "Unavailable")}">${r.label}</span>`
            ).join("")}</div></div>`;
        }
        // Visitor Production Hub bay leases (docs/STATIONS.md §8 / §14.1 phase C).
        // Shared floors use view(); guest-local other-owned stations use get().
        {
          const leaseSt = Stations.isRemote(sys.id) ? Stations.view(sys.id) : st;
          const canLeaseHere = leaseSt && leaseSt.status === "owned"
            && (leaseSt.modules.production_hub | 0) && leaseSt.prodComm
            && !(Stations.ownerHeld(st) && st.ownerId === Stations.playerId());
          if (canLeaseHere && (docked || Stations.isRemote(sys.id))) {
            const comm = COMMODITIES.find(c => c.id === leaseSt.prodComm);
            const taxPct = ((leaseSt.leaseTaxBps || 0) / 100).toFixed(0);
            const bays = leaseSt.remote
              ? (leaseSt.bays || [])
              : (Stations.syncBays(leaseSt), leaseSt.bays || []);
            const taken = bays.filter(b => b.lesseeId).length;
            const myBays = bays.map((b, i) => ({ b, i }))
              .filter(x => Stations.bayMine(x.b));
            // Remote bookkeeping may know an extractor the directory row doesn't.
            const remoteSlots = (Stations.remoteLeases && Stations.remoteLeases[sys.id]) || {};
            const vacant = docked ? Stations.leaseableBays(sys.id) : [];
            const freeEx = docked
              ? (window.Extractors ? Extractors.unequipped() : [])
                  .filter(ex => Extractors.canProduce(ex, leaseSt.prodComm))
              : [];
            const exOpts = freeEx.map(ex =>
              `<option value="${ex.uid}">${ex.name}</option>`).join("");
            let leaseHtml = `<div class="si-station si-lease"><b>Production bays</b> · ${comm ? comm.name : leaseSt.prodComm} · lease tax ${taxPct}%`;
            leaseHtml += `<div class="tip-dim">${taken} of ${bays.length} bays occupied</div>`;
            if (!docked && Stations.isRemote(sys.id)) {
              leaseHtml += `<div class="tip-dim">Dock here to lease a bay</div>`;
            }
            if (myBays.length) {
              leaseHtml += myBays.map(({ b, i }) => {
                const exUid = b.extractorId || remoteSlots[i];
                const ex = window.Extractors && Extractors.get(exUid);
                return `<div class="tip-dim">Bay ${i + 1} · yours · ${ex ? ex.name : "extractor"}
                  ${docked ? `<button class="btn btn-mini" data-sm-vacate="${i}">Leave</button>` : ""}</div>`;
              }).join("");
            }
            if (docked && vacant.length) {
              if (Stations.bayShared(sys.id) && !Stations._baysWritable()) {
                leaseHtml += `<div class="tip-dim">Sign in to lease a bay here</div>`;
              } else {
                leaseHtml += vacant.map(({ index }) =>
                  `<div class="st-hall-list" style="margin-top:6px">Bay ${index + 1}
                    <select data-sm-lease-ex="${index}" ${exOpts ? "" : "disabled"}>${exOpts || "<option>No free extractor</option>"}</select>
                    <button class="btn btn-mini btn-go" data-sm-lease="${index}" ${exOpts ? "" : "disabled"}>Lease</button>
                  </div>`).join("");
              }
            } else if (docked && !myBays.length && !vacant.length) {
              leaseHtml += `<div class="tip-dim">No vacant bays</div>`;
            }
            if (docked && !leaseSt.remote) {
              const pending = (st.pendingCargo && st.pendingCargo[Stations.playerId()]) || {};
              const pendN = Object.values(pending).reduce((a, q) => a + (q | 0), 0);
              if (pendN > 0) {
                leaseHtml += `<div class="tip-dim" style="margin-top:4px">${pendN} units parked — claiming…</div>`;
                Stations.claimPendingCargo(sys.id);
              }
            }
            leaseHtml += `</div>`;
            stationBlock += leaseHtml;
          }
        }
      }
    }

    const active = Market.activeLocal(sys.id).map(e => {
      const comm = COMMODITIES.find(c => c.id === e.target);
      const label = comm ? comm.name : e.target;
      return `<div class="local-effect ${e.mult > 1 ? "up" : "down"}">⚠ ${label} ${e.mult > 1 ? "scarce — prices up" : "glut — prices down"} here</div>`;
    }).join("");

    const planets = sys.planets.map((p, i) => {
      const im = (window.ASSET_OVERRIDES && ASSET_OVERRIDES[`planetimg:${sys.id}_${i}`]) || ASSET.planet(p.type);
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
         ${stationBlock}
         ${isAdmin ? `<div class="si-admin">
           <button class="btn btn-mini" id="sm-bg-upload" title="Upload PNG / JPG / GIF · suggested 1280×720 (16:9), GIFs animate">🖼 Set space background</button>
           ${hasBg ? `<button class="btn btn-mini admin-card-reset" id="sm-bg-reset">Reset</button>` : ""}
         </div>` : ""}
         ${active ? `<div class="si-effects">${active}</div>` : ""}
       </div>
       <h4>Planets &amp; industries</h4>
       <ul class="planet-list">${planets}</ul>
       <h4>Local feed <small>${sys.stationName}</small></h4>
       <ul class="local-feed" id="sm-local-feed"></ul>`;

    const dock = document.getElementById("sm-dock");
    if (dock) dock.onclick = async () => {
      if (Economy.busy()) return;
      const r = await Economy.dockAt(sys.id);
      if (!r || !r.ok) return UI.toast((r && r.msg) || "Couldn't reach the exchange — try again.", "warn");
      UI.updateExchange(); UI.updateHeader(); UI.renderSystems();
      window.Game.requestSave(); this.renderInfo(sys); this.updateGalaxyNodes();
      // Launch toast + hub transit status come from Bus.on("travelStart").
    };
    const unlock = document.getElementById("sm-unlock");
    if (unlock) unlock.onclick = async () => {
      if (Economy.busy()) return;
      const r = await Economy.unlockSystem(sys.id);
      if (!r || !r.ok) return UI.toast((r && r.msg) || "Couldn't reach the exchange — try again.", "warn");
      UI.toast(`Unlocked ${sys.name}!`, "good"); UI.renderSystems();
      window.Game.requestSave(); this.renderInfo(sys);
    };
    const survey = document.getElementById("sm-survey");
    if (survey) survey.onclick = () => UI.openSurvey(sys.id);

    const stAuction = document.getElementById("sm-st-auction");
    if (stAuction) stAuction.onclick = async () => {
      const r = await Stations.openAuction(sys.id, +stAuction.dataset.min);
      if (!r.ok) return UI.toast(r.msg, "warn");
      UI.flashCredits(); UI.updateHeader(); this.renderInfo(sys); this.updateGalaxyNodes();
    };
    const stBid = document.getElementById("sm-st-bid");
    if (stBid) stBid.onclick = async () => {
      const r = await Stations.bid(sys.id, +stBid.dataset.min);
      if (!r.ok) return UI.toast(r.msg, "warn");
      UI.toast(`Bid placed: ${Util.credits(r.auction.highBid)}`, "good");
      UI.flashCredits(); UI.updateHeader(); this.renderInfo(sys); this.updateGalaxyNodes();
    };
    const stAdminClaim = document.getElementById("sm-st-admin-claim");
    if (stAdminClaim) stAdminClaim.onclick = () => {
      const r = Stations.adminClaim(sys.id);
      if (!r.ok) return UI.toast(r.msg, "warn");
      UI.toast(`Claimed ${r.st.name} (admin).`, "good");
      UI.flashCredits(); UI.updateHeader(); this.renderInfo(sys); this.updateGalaxyNodes();
    };
    const stRelinquish = document.getElementById("sm-st-relinquish");
    if (stRelinquish) stRelinquish.onclick = async () => {
      const st0 = Stations.get(sys.id);
      const holdV = st0 ? Stations.holdValue(st0) : 0;
      const holdNote = holdV > 0
        ? `\nHold goods cashed out at ~${Util.credits(holdV)}c.`
        : "\nHold is empty.";
      if (!confirm(`Relinquish ${st0?.name || "this station"}? Modules stay for the next owner; treasury returns to you.${holdNote}`)) return;
      const r = await Stations.relinquish(sys.id);
      if (!r.ok) return UI.toast(r.msg, "warn");
      const bits = [];
      if (r.treasury) bits.push(`treasury ${Util.credits(r.treasury)}`);
      if (r.holdCredits) bits.push(`hold ${Util.credits(r.holdCredits)}`);
      UI.toast(bits.length ? `Station relinquished — returned ${bits.join(" + ")}.` : "Station relinquished.", "info");
      UI.flashCredits(); UI.updateHeader(); this.renderInfo(sys); this.updateGalaxyNodes();
      if (UI.page === "stations") UI.renderStations();
    };
    const stManage = document.getElementById("sm-st-manage");
    if (stManage) stManage.onclick = () => { this.close(); UI.showPage("stations"); };

    const smHallList = document.getElementById("sm-hall-list");
    if (smHallList) smHallList.onclick = async () => {
      const raw = document.getElementById("sm-hall-item")?.value || "";
      const price = +document.getElementById("sm-hall-price")?.value || 0;
      const [kind, ref] = raw.split(":");
      if (!kind || !ref) return UI.toast("Pick something to list.", "warn");
      const r = await Stations.listHallItem(sys.id, kind, ref, price);
      if (!r.ok) return UI.toast(r.msg, "warn");
      UI.toast(`Listed ${r.listing.name} for ${Util.credits(r.listing.price)}.`, "good");
      window.Game.requestSave(); this.renderInfo(sys); UI.updateHeader();
    };
    document.querySelectorAll("[data-sm-hall-cancel]").forEach(btn => {
      btn.onclick = async () => {
        const r = await Stations.cancelHallListing(sys.id, btn.dataset.smHallCancel);
        if (!r.ok) return UI.toast(r.msg, "warn");
        UI.toast(r.cleared ? "Stall cleared — the goods go back to its owner." : "Listing cancelled — item returned.", "info");
        this.renderInfo(sys); UI.updateHeader();
      };
    });
    document.querySelectorAll("[data-sm-hall-buy]").forEach(btn => {
      btn.onclick = async () => {
        const r = await Stations.buyHallListing(sys.id, btn.dataset.smHallBuy);
        if (!r.ok) return UI.toast(r.msg, "warn");
        UI.toast(`Bought ${r.listing.name} for ${Util.credits(r.paid)}.`, "good");
        UI.flashCredits(); this.renderInfo(sys); UI.updateHeader();
      };
    });
    document.querySelectorAll("[data-sm-ransom]").forEach(btn => {
      btn.onclick = () => {
        const r = Stations.payRansom(sys.id, btn.dataset.smRansom);
        if (!r.ok) return UI.toast(r.msg, "warn");
        UI.toast(`Ransom paid — recovered ${r.qty} units.`, "good");
        UI.flashCredits(); this.renderInfo(sys); UI.updateHeader();
      };
    });
    document.querySelectorAll("[data-sm-lease]").forEach(btn => {
      btn.onclick = async () => {
        const i = +btn.dataset.smLease;
        const sel = document.querySelector(`[data-sm-lease-ex="${i}"]`);
        const r = await Stations.leaseBay(sys.id, i, sel && sel.value);
        if (!r.ok) return UI.toast(r.msg, "warn");
        UI.toast(`Bay ${i + 1} leased — output after tax lands in your cargo.`, "good");
        window.Game.requestSave(); this.renderInfo(sys); UI.updateHeader();
      };
    });
    document.querySelectorAll("[data-sm-vacate]").forEach(btn => {
      btn.onclick = async () => {
        const r = await Stations.vacateBay(sys.id, +btn.dataset.smVacate);
        if (!r.ok) return UI.toast(r.msg, "warn");
        UI.toast("Left the bay — extractor returned.", "info");
        this.renderInfo(sys); UI.updateHeader();
      };
    });

    // admin-only: upload a custom space background for this system
    if (isAdmin) {
      const up = document.getElementById("sm-bg-upload");
      if (up) up.onclick = () => {
        const file = document.createElement("input");
        file.type = "file"; file.accept = "image/png,image/jpeg,image/gif";
        file.onchange = async () => {
          if (!file.files[0]) return;
          UI.toast("Uploading background…", "info");
          try {
            await AdminUI.uploadSprite("spacebg", sys.id, file.files[0]);
            UI.toast("Space background updated.", "good");
            this.startScene(sys); this.renderInfo(sys);
          } catch (e) {
            const msg = (e && e.message) || String(e);
            UI.toast(/bucket|not found/i.test(msg) ? "Create a public 'sprites' bucket first (see ADMIN_SETUP)." : "Upload failed: " + msg, "warn", 5000);
          }
        };
        file.click();
      };
      const rst = document.getElementById("sm-bg-reset");
      if (rst) rst.onclick = async () => {
        try { await AdminUI.resetSprite("spacebg", sys.id); UI.toast("Background reset to default.", "good"); this.startScene(sys); this.renderInfo(sys); }
        catch (e) { UI.toast("Reset failed: " + ((e && e.message) || e), "warn"); }
      };
    }

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
      const w = Math.max(320, Math.floor(r.width)), h = Math.max(260, Math.floor(r.height));
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w; canvas.height = h;
    };
    resize();
    this._onResize = resize;
    window.addEventListener("resize", resize);
    // device-mode / flex / overlay panel changes don't always fire window.resize
    if (typeof ResizeObserver !== "undefined") {
      this._sceneRO = new ResizeObserver(resize);
      this._sceneRO.observe(canvas.parentElement);
    }

    const W = () => canvas.width, H = () => canvas.height;

    // ---- pan / zoom camera: drag to pan, wheel / pinch to zoom -------------
    // screen = world × zoom + (x,y). Applied only to the SCENE content (star,
    // planets, station, ships), so the nebula backdrop + starfield stay put and
    // give a little parallax as you pan. Reset per system (fresh closure).
    const cam = { zoom: 1, x: 0, y: 0 };
    const MINZ = 0.7, MAXZ = 4;
    const clampCam = () => {
      cam.zoom = Util.clamp(cam.zoom, MINZ, MAXZ);
      const cxW = W() / 2, cyW = H() / 2;                 // keep the star (system centre) on-screen
      cam.x = Util.clamp(cam.x, -cxW * cam.zoom, W() - cxW * cam.zoom);
      cam.y = Util.clamp(cam.y, -cyW * cam.zoom, H() - cyW * cam.zoom);
    };
    // Squat map panes (mobile stack: short top strip) used to crush the system
    // into Math.min(w,h). Start cover-zoomed instead — same idea as galaxy
    // _fitGalaxy — so outer orbits crop and the user pans / zooms out.
    // Deferred one frame so canvas size matches the unhidden system-view.
    requestAnimationFrame(() => {
      resize();
      if (H() < W() * 0.95) {
        cam.zoom = 1.35;
        cam.x = W() / 2 * (1 - cam.zoom);
        cam.y = H() / 2 * (1 - cam.zoom);
        clampCam();
        redraw();
      }
    });
    // the live loop repaints itself; reduced-motion mode draws one frame so it needs a nudge
    const redraw = () => { if (reduced) draw(performance.now()); };
    let hintTimer = 0;
    const hideHint = () => { clearTimeout(hintTimer); if (this.refs.sceneHint) this.refs.sceneHint.classList.add("faded"); };
    const zoomAt = (fx, fy, factor) => {
      const wx = (fx - cam.x) / cam.zoom, wy = (fy - cam.y) / cam.zoom;
      cam.zoom = Util.clamp(cam.zoom * factor, MINZ, MAXZ);
      cam.x = fx - wx * cam.zoom; cam.y = fy - wy * cam.zoom;
      clampCam(); hideHint(); redraw();
    };
    const panBy = (dx, dy) => { cam.x += dx; cam.y += dy; clampCam(); hideHint(); redraw(); };

    // show the drag/zoom hint fresh each time a system opens; fade after a moment
    if (this.refs.sceneHint) {
      this.refs.sceneHint.classList.remove("faded");
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => { if (this.refs.sceneHint) this.refs.sceneHint.classList.add("faded"); }, 6000);
    }

    // input: 1 pointer drag = pan · wheel = zoom · 2 pointers = pinch-zoom
    const ptrs = new Map();
    let pinchPrev = null;
    const rectOf = () => canvas.getBoundingClientRect();
    const onDown = e => { ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); pinchPrev = null; };
    const onMove = e => {
      const p = ptrs.get(e.pointerId); if (!p) return;
      const px = p.x, py = p.y; p.x = e.clientX; p.y = e.clientY;
      if (ptrs.size >= 2) {                                // pinch: zoom around the midpoint, pan with it
        const pts = [...ptrs.values()], r = rectOf();
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const mid = { x: (pts[0].x + pts[1].x) / 2 - r.left, y: (pts[0].y + pts[1].y) / 2 - r.top };
        if (pinchPrev && dist > 0) { zoomAt(mid.x, mid.y, dist / pinchPrev.dist); panBy(mid.x - pinchPrev.mid.x, mid.y - pinchPrev.mid.y); }
        pinchPrev = { dist, mid };
        return;
      }
      panBy(e.clientX - px, e.clientY - py);
    };
    const onUp = e => { ptrs.delete(e.pointerId); pinchPrev = null; };
    const onWheel = e => { e.preventDefault(); const r = rectOf(); zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY > 0 ? 1 / 1.12 : 1.12); };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    this._sceneCtrlCleanup = () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      clearTimeout(hintTimer);
    };

    const planets = sys.planets.map((p, i) => ({
      p, angle: (i * 2.39996) % (Math.PI * 2),
      orbit: 0.28 + (i / Math.max(1, sys.planets.length)) * 0.62,
      speed: (0.10 - i * 0.012) * 0.3, img: this.img(ASSET.planet(p.type)),
      size: 16 + (p.type === "gas_giant" || p.type === "ringed" ? 12 : 6),
    }));
    const station = { angle: 0, orbit: 0.16, speed: 0.25, img: this.img(ASSET.station(sys.race)) };
    const starImg = this.img(ASSET.star(sys.star));
    // Admin-uploaded (or git-committed default) per-system space background
    // takes precedence over the sector nebula.
    const bgUrl = ASSET.spacebg(sys.id) || ASSET.nebula(sys.nebula);
    const neb = this.img(bgUrl);
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
      const w = W(), h = H(), cx = w / 2, cy = h / 2;
      // Cover on squat panes (mobile top strip): size orbits to the long axis so
      // the system isn't crushed into the short side. Desktop stays contain.
      const R = (h < w * 0.95 ? Math.max(w, h) : Math.min(w, h)) * 0.42;
      const ctx = canvas.getContext("2d");
      // background
      if (neb.ok) ctx.drawImage(neb, 0, 0, w, h); else { ctx.fillStyle = "#06080f"; ctx.fillRect(0, 0, w, h); }
      ctx.fillStyle = "#fff";
      for (const st of stars) { ctx.globalAlpha = 0.3 + st.b * 0.5; ctx.fillRect(st.x * w, st.y * h, 1.3, 1.3); }
      ctx.globalAlpha = 1;

      // everything below is scene content — apply the pan/zoom camera to it
      ctx.save();
      ctx.setTransform(cam.zoom, 0, 0, cam.zoom, cam.x, cam.y);

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

      ctx.restore();   // end camera transform

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
    if (this._sceneRO) { this._sceneRO.disconnect(); this._sceneRO = null; }
    if (this._sceneCtrlCleanup) { this._sceneCtrlCleanup(); this._sceneCtrlCleanup = null; }
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
    // The two intervals used to run straight through suspend. With a system
    // open, the 9–14s feed tick kept calling flavorPost + requestSave in a
    // hidden/idle tab — a localStorage write plus a debounced app_commit every
    // ~10s — and each save stamped lastSeenAt=now, so resume() saw ~10s elapsed
    // and skipped market/stock catch-up for the whole away period.
    if (this.feedTimer) { this._resumeFeed = true; clearInterval(this.feedTimer); this.feedTimer = null; }
    if (this.galaxyTimer) { this._resumeGalaxy = true; clearInterval(this.galaxyTimer); this.galaxyTimer = null; }
  },
  resume() {
    if (this._resumeStars) {
      this._resumeStars = false;
      if (this.open && !this.refs.galaxyView.classList.contains("hidden")) this.startStars();
    }
    if (this._resumeGalaxy) {
      this._resumeGalaxy = false;
      if (this.open && !this.refs.galaxyView.classList.contains("hidden")) {
        clearInterval(this.galaxyTimer);
        this.galaxyTimer = setInterval(() => this.updateGalaxyNodes(), CONFIG.marketTickMs);
      }
    }
    const sys = this.current && Galaxy.get(this.current);
    const sysOpen = this.open && sys && !this.refs.systemView.classList.contains("hidden");
    if (this._resumeFeed) { this._resumeFeed = false; if (sysOpen) this.startLocalFeed(sys); }
    if (!this._resumeScene) return;
    this._resumeScene = false;
    if (sysOpen) this.startScene(sys);
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
