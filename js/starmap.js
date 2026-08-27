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
      galaxyView: $("galaxy-view"), hud: $("chart-hud"), systemView: $("system-view"),
      canvas: $("system-canvas"), info: $("system-info"), planetTip: $("planet-tip"),
      poiTip: $("poi-tip"),
      title: $("sm-title"), crumbSys: $("sm-crumb-sys"), sceneHint: $("sm-scene-hint"),
      btnOpen: $("btn-starmap"), btnClose: $("sm-close"), toGalaxy: $("sm-to-galaxy"),
      infoToggle: $("sm-info-toggle"),
    };
    // Collapse the info panel so the scene gets the whole overlay — worth a
    // real toggle on a phone, where the panel takes over half the screen. The
    // choice rides settings (client-owned, already on the wire), and the
    // scene's draw loop re-fits the camera on the resize by itself.
    if (this.refs.infoToggle) {
      this.refs.infoToggle.onclick = () => {
        const s = this.s().settings;
        s.sysInfoHidden = !s.sysInfoHidden;
        this.applyInfoHidden();
        window.Game.requestSave();
      };
    }
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

  // Paint the collapsed/expanded state onto the view + button. Safe before a
  // save exists (init runs early), and idempotent.
  applyInfoHidden() {
    const { systemView, infoToggle } = this.refs;
    if (!systemView || !infoToggle) return;
    const st = (window.Game && Game.state && Game.state.settings) || null;
    const hidden = !!(st && st.sysInfoHidden);
    systemView.classList.toggle("info-hidden", hidden);
    infoToggle.textContent = hidden ? "Show info" : "Hide info";
    infoToggle.setAttribute("aria-expanded", hidden ? "false" : "true");
    infoToggle.title = hidden
      ? "Show this system's details" : "Collapse the panel and give the scene the full screen";
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
    this._stopVoyageLayer();
    clearInterval(this.galaxyTimer); this.galaxyTimer = null;
    if (window.UI) UI.updateNavIndicator();        // restore glow to the underlying page tab
    if (window.Voyages) Voyages.hubSync();         // the Hub Live View paused while the map covered it
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
    this._startVoyageLayer();
    clearInterval(this.galaxyTimer);
    this.galaxyTimer = setInterval(() => this.updateGalaxyNodes(), CONFIG.marketTickMs);
  },

  // ===== voyage markers on the chart (LIVING_GALAXY.md §3) =================
  // Every active voyage renders as a moving marker on its lane polyline —
  // flying is arithmetic on the clock, so this just repaints Voyages.markers().
  // Flagships (yours + other barons') carry the owner's name.
  _startVoyageLayer() {
    this._stopVoyageLayer();
    if (!window.Voyages) return;
    void Voyages.refreshPresence();
    const ns = "http://www.w3.org/2000/svg";
    const layer = document.createElementNS(ns, "g");
    layer.setAttribute("pointer-events", "none");
    this.refs.svg.appendChild(layer);
    this._voyLayer = layer; this._voyEls = {};
    const reduced = !!(this.s().settings && this.s().settings.reduced);
    const W = 1000, H = 620;
    const tick = () => {
      if (!this.open || this.refs.galaxyView.classList.contains("hidden")) { this._stopVoyageLayer(); return; }
      const now = Date.now();
      const live = new Set();
      for (const v of Voyages.markers()) {
        live.add(v.id);
        const el = this._voyEls[v.id] || (this._voyEls[v.id] = this._mkVoyEl(layer, v));
        el.g.setAttribute("transform", `translate(${(v.at.x * W).toFixed(1)},${(v.at.y * H).toFixed(1)})`);
        // A wreck is a fireball, not a ship: it has no hull to turn or plume
        // to flicker. Expand and fade over POLICECFG.wreckMs, then the live
        // set drops it.
        if (el.boom) {
          const f = Util.clamp((now - el.t0) / ((window.POLICECFG || {}).wreckMs || 3000), 0, 1);
          el.boom.setAttribute("r", (3 + f * 16).toFixed(1));
          el.boom.setAttribute("opacity", (1 - f).toFixed(2));
          if (el.ring) {
            el.ring.setAttribute("r", (5 + f * 26).toFixed(1));
            el.ring.setAttribute("opacity", ((1 - f) * 0.5).toFixed(2));
          }
          continue;
        }
        // Duel: guns working between two hulls holding station. The flash is
        // a sawtooth on a fixed beat, jittered per marker so the two sides
        // don't fire in lockstep.
        if (el.flash) {
          const beat = 640, k = ((now + el.jit) % beat) / beat;
          el.flash.setAttribute("opacity", k < 0.32 ? (0.9 - k * 2.2).toFixed(2) : "0");
          el.flash.setAttribute("r", (2.2 + k * 5).toFixed(1));
        }
        // flown turns: ease the drawn heading toward the route bearing
        if (el.hdg == null) el.hdg = v.at.heading;
        const diff = Math.atan2(Math.sin(v.at.heading - el.hdg), Math.cos(v.at.heading - el.hdg));
        el.hdg += reduced ? diff : diff * 0.12;
        el.hull.setAttribute("transform", `rotate(${(el.hdg * 180 / Math.PI).toFixed(1)})`);
        // exhaust flicker, stretched to a streak mid-lane (hyperspace)
        const ph = Voyages.legPhase(v.at.legP);
        const fl = (ph.mode === "hyper" ? 16 : ph.mode === "gate" ? 3 : 7) + Math.sin(now * 0.02 + v.at.x * 40) * 2;
        el.plume.setAttribute("points", `${-el.tail},2 ${-el.tail - fl},0 ${-el.tail},-2`);
        // Raid state is per-LOOP, the element is per-flight and outlives it, so
        // repaint on change (and only on change — this runs every frame).
        // Patrol strobes: alternate red/blue on the same 320ms beat the scene
        // uses, and only write on the flip — this runs every frame.
        if (el.lights) {
          const on = Math.floor(now / 320) % 2 === 0;
          if (el.lit !== on) {
            el.lit = on;
            el.lights[0].setAttribute("opacity", on ? 1 : 0.25);
            el.lights[1].setAttribute("opacity", on ? 0.25 : 1);
          }
        }
        const robbed = !!v.raided;
        if (el.robbed !== robbed) {
          el.robbed = robbed;
          el.poly.classList.toggle("raided", robbed);
          // A glyph as well as a colour: the map must still read for someone
          // who can't tell the red hull from the tan one.
          if (el.name) el.name.textContent = (robbed ? "☠ " : "") + (v.name || "");
        }
      }
      for (const id in this._voyEls) if (!live.has(id)) { this._voyEls[id].g.remove(); delete this._voyEls[id]; }
      // reduced motion: step once a second instead of every frame
      this._voyRaf = reduced ? setTimeout(tick, 1000) : requestAnimationFrame(tick);
      this._voyRafIsTimer = reduced;
    };
    tick();
  },
  _mkVoyEl(layer, v) {
    const ns = "http://www.w3.org/2000/svg";
    const g = document.createElementNS(ns, "g");
    // A wreck: the fireball a lost duel leaves behind. No hull, no plume —
    // the tick expands and fades it, then it is gone.
    if (v.boom) {
      const ring = document.createElementNS(ns, "circle");
      ring.setAttribute("class", "voy-boom-ring");
      g.appendChild(ring);
      const core = document.createElementNS(ns, "circle");
      core.setAttribute("class", "voy-boom");
      g.appendChild(core);
      if (v.label) {
        const t = document.createElementNS(ns, "text");
        t.setAttribute("class", "voy-name boom");
        t.setAttribute("y", -14);
        t.textContent = v.label;
        g.appendChild(t);
      }
      g.setAttribute("class", "voy " + (v.you ? "voy-fleets" : "voy-law"));
      layer.appendChild(g);
      return { g, boom: core, ring, t0: Date.now() };
    }
    const hullG = document.createElementNS(ns, "g");   // rotates: plume + hull together
    const plume = document.createElementNS(ns, "polygon");
    plume.setAttribute("class", "voy-plume");
    hullG.appendChild(plume);
    const hull = document.createElementNS(ns, "polygon");
    let tail;
    if (v.kind === "flagship") {
      hull.setAttribute("points", "9,0 -7,5.5 -3.5,0 -7,-5.5");
      hull.setAttribute("class", "voy-hull-flag" + (v.you ? "" : " other"));
      tail = 6;
    } else if (v.kind === "freighter") {
      // NPC supply hauler — boxy hull, flavor name over the top. Whether the
      // corsairs already emptied this run is set per-frame in the tick, not
      // baked in here: elements are cached by flight id and outlive a loop.
      hull.setAttribute("points", "7,0 3,3.6 -6,3.6 -6,-3.6 3,-3.6");
      hull.setAttribute("class", "voy-hull-npc");
      tail = 5;
    } else if (v.kind === "trader") {
      hull.setAttribute("points", "4,0 -3,2.2 -3,-2.2");
      hull.setAttribute("class", "voy-hull-trader");
      tail = 3;
    } else if (v.police) {
      // A Senate patrol reads as a PAIR on the chart, the way it does in the
      // scene: lead hull plus a wingman in trailing echelon, with the strobes
      // over the lead. Both ride the rotating group, so the formation turns
      // with the patrol instead of sliding around it.
      hull.setAttribute("points", "6,0 -4,3 -1.5,0 -4,-3");
      hull.setAttribute("class", "voy-hull-police");
      const wing = document.createElementNS(ns, "polygon");
      wing.setAttribute("points", "6,0 -4,3 -1.5,0 -4,-3");
      wing.setAttribute("class", "voy-hull-police wing");
      wing.setAttribute("transform", "translate(-7,5) scale(.8)");
      hullG.appendChild(wing);
      tail = 4;
    } else {
      hull.setAttribute("points", "5.5,0 -4.5,3.2 -4.5,-3.2");
      hull.setAttribute("class", v.kind === "courier" ? "voy-hull-courier" : "voy-hull-fleet");
      tail = 4;
    }
    hullG.appendChild(hull);
    g.appendChild(hullG);
    // Strobes ride OUTSIDE the rotating group — a light doesn't bank with the
    // hull, and this keeps them legible at any heading. The tick alternates
    // them; `lights` is the handle it toggles.
    let lights = null;
    if (v.police) {
      lights = [];
      for (const [dx, cls] of [[-3.5, "pc-red"], [3.5, "pc-blue"]]) {
        const d = document.createElementNS(ns, "circle");
        d.setAttribute("cx", dx); d.setAttribute("cy", -7); d.setAttribute("r", 1.9);
        d.setAttribute("class", cls);
        g.appendChild(d);
        lights.push(d);
      }
    }
    let nameEl = null;
    if (v.police && v.name) {
      nameEl = document.createElementNS(ns, "text");
      nameEl.setAttribute("class", "voy-name police");
      nameEl.setAttribute("y", -12);
      nameEl.textContent = v.name;
      g.appendChild(nameEl);
    }
    if (v.kind === "freighter" && v.name) {
      nameEl = document.createElementNS(ns, "text");
      nameEl.setAttribute("class", "voy-name npc");
      nameEl.setAttribute("y", -9);
      nameEl.textContent = v.name;
      g.appendChild(nameEl);
    }
    if (v.kind === "flagship" && v.name) {
      const t = document.createElementNS(ns, "text");
      t.setAttribute("class", "voy-name" + (v.you ? " you" : ""));
      t.setAttribute("y", -11);
      // textContent — other barons' names are untrusted text
      t.textContent = v.name + (v.you && v.tag ? " · " + v.tag.label : "");
      if (v.you && v.tag) t.setAttribute("fill", v.tag.color);
      g.appendChild(t);
      nameEl = t;
    }
    // A baron's own hull flies its crime tag over it once the record leaves
    // clean — Watchlisted, then Barred, then Criminal. The law reads it off
    // the transponder; so should the player (js/crime.js tag()).
    if (v.you && v.tag && !nameEl) {
      const t = document.createElementNS(ns, "text");
      t.setAttribute("class", "voy-name you crime");
      t.setAttribute("fill", v.tag.color);
      t.setAttribute("y", -11);
      t.textContent = v.name ? v.name + " · " + v.tag.label : v.tag.label;
      g.appendChild(t);
      nameEl = t;
    }
    // Muzzle flash for a hull locked in a duel, animated by the tick.
    let flash = null, jit = 0;
    if (v.duel) {
      flash = document.createElementNS(ns, "circle");
      flash.setAttribute("class", "voy-duel-flash");
      flash.setAttribute("cx", 6); flash.setAttribute("cy", 0);
      flash.setAttribute("opacity", 0);
      g.appendChild(flash);
      jit = v.police ? 320 : 0;
    }
    // Layer class: LAW covers the Senate's own hulls, TRAFFIC the NPC economy,
    // FLEETS anything crewed by a baron. The CSS hides the whole group, names
    // and strobes included.
    g.setAttribute("class", "voy " + (v.police ? "voy-law" : v.npc ? "voy-traffic" : "voy-fleets")
      + (v.duel ? " voy-duel" : ""));
    layer.appendChild(g);
    return { g, hull: hullG, poly: hull, name: nameEl, plume, tail, lights, flash, jit };
  },
  _stopVoyageLayer() {
    if (this._voyRaf) (this._voyRafIsTimer ? clearTimeout : cancelAnimationFrame)(this._voyRaf);
    this._voyRaf = null;
    if (this._voyLayer) { this._voyLayer.remove(); this._voyLayer = null; }
    this._voyEls = {};
  },

  // ===== galaxy view (SVG) ================================================
  // ---- chart layers (player-controlled) ----------------------------------
  // The galactic chart carries six independent readings at once and they used
  // to all be on, always. Each is a layer the player can switch off, and the
  // key for a layer lives ON its row — so the legend can only ever describe
  // what is actually drawn. Everything hides through a class on the <svg>
  // root, so toggling is a repaint, not a re-render.
  LAYERS: [
    { id: "lanes",      label: "Lanes",      hint: "hyperspace routes between systems" },
    { id: "security",   label: "Security",   hint: "how much law a region carries (§5.3)" },
    { id: "allegiance", label: "Allegiance", hint: "which faction a system's economy answers to" },
    { id: "markets",    label: "Markets",    hint: "price direction, local events and trade hubs" },
    { id: "traffic",    label: "Traffic",    hint: "NPC haulers, and the ones corsairs emptied" },
    { id: "law",        label: "Law",        hint: "Senate precincts and the patrol pairs they fly" },
    { id: "fleets",     label: "Fleets",     hint: "your ships, rival barons, survey sites" },
  ],
  // Saved per player. Anything absent defaults ON, so a new layer added later
  // shows up rather than silently hiding for everyone with an older save.
  // Pure read — updateGalaxyNodes calls this on a timer, so it must not write.
  layers() {
    const saved = ((this.s().settings || {}).mapLayers) || {};
    const out = {};
    for (const l of this.LAYERS) out[l.id] = saved[l.id] !== false;
    return out;
  },
  setLayer(id, on) {
    const s = this.s();
    if (!s.settings) s.settings = {};
    const m = s.settings.mapLayers || (s.settings.mapLayers = {});
    m[id] = !!on;
    window.Game.requestSave();
    this._applyLayers();
    this._renderHud();
  },
  _applyLayers() {
    const svg = this.refs.svg; if (!svg) return;
    const on = this.layers();
    for (const l of this.LAYERS) svg.classList.toggle("lay-off-" + l.id, !on[l.id]);
    this.updateGalaxyNodes();   // markets/fleets drive node rings in JS, not CSS
  },

  renderGalaxy() {
    const svg = this.refs.svg;
    const W = 1000, H = 620;
    const ns = "http://www.w3.org/2000/svg";
    svg.innerHTML = "";
    const X = x => x * W, Y = y => y * H;

    // Region blobs: a hull drawn round the sector's actual systems, tinted by
    // its SECURITY band (§5.3) rather than by race — the map's job is to tell
    // you where the law is before you fly a fat hold there. Civil unrest
    // (Stock.sentiment) rides a dashed edge, a separate channel so it can
    // never be misread as a security colour.
    this._blobEls = {};
    for (const sec of Galaxy.sectors) {
      const cx = X(sec.pos.x), cy = Y(sec.pos.y);
      const blob = document.createElementNS(ns, "path");
      blob.setAttribute("class", "sector-blob");
      blob.setAttribute("d", this._sectorBlobPath(sec, X, Y));
      svg.appendChild(blob);
      const lbl = document.createElementNS(ns, "text");
      lbl.setAttribute("x", cx); lbl.setAttribute("y", cy - 96);
      lbl.setAttribute("class", "sector-label"); lbl.textContent = sec.name.toUpperCase();
      svg.appendChild(lbl);
      const sub = document.createElementNS(ns, "text");
      sub.setAttribute("x", cx); sub.setAttribute("y", cy - 80);
      sub.setAttribute("class", "sector-band");
      svg.appendChild(sub);
      this._blobEls[sec.id] = { blob, sub };
    }

    // hyperspace lanes (Lanes.build from the same seed): bright trunk highways
    // on the capital ring, faint intra-sector lanes — replaces the old
    // capital-spoke decoration with the graph travel actually follows
    for (const lane of (window.Lanes ? Lanes.list : [])) {
      const a = Galaxy.get(lane.a), b = Galaxy.get(lane.b);
      const ln = document.createElementNS(ns, "line");
      ln.setAttribute("x1", X(a.pos.x)); ln.setAttribute("y1", Y(a.pos.y));
      ln.setAttribute("x2", X(b.pos.x)); ln.setAttribute("y2", Y(b.pos.y));
      ln.setAttribute("class", lane.trunk ? "lane-trunk" : "lane");
      svg.appendChild(ln);
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

      // Faction aura: who this system's economy answers to (Galaxy.factionOf,
      // tallied off its planets). Its own element, drawn behind, so the
      // node-ring keeps carrying market direction / events / surveys — two
      // signals, two channels, neither one clobbering the other.
      const fac = document.createElementNS(ns, "circle");
      const fcol = Galaxy.factionColor(sys);
      fac.setAttribute("r", sys.capital ? 18 : 12);
      fac.setAttribute("class", "node-faction");
      fac.setAttribute("fill", fcol); fac.setAttribute("stroke", fcol);
      g.appendChild(fac);

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

      // Precinct badge: the seat of this sector's law (police.js). Its own
      // element under the Law layer, so switching the layer off takes the
      // stations and their patrols together.
      if (window.Police && Police.hasPrecinct(sys.id)) {
        const p = document.createElementNS(ns, "g");
        p.setAttribute("class", "node-precinct");
        p.setAttribute("transform", "translate(0,-16)");
        for (const [dx, cls] of [[-3, "pc-red"], [3, "pc-blue"]]) {
          const d = document.createElementNS(ns, "circle");
          d.setAttribute("cx", dx); d.setAttribute("cy", 0); d.setAttribute("r", 2);
          d.setAttribute("class", cls);
          p.appendChild(d);
        }
        g.appendChild(p);
      }

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
    this._renderHud();
    this._applyLayers();
    this.updateGalaxyNodes();
    this._fitGalaxy();
    this._initPanZoom();
  },

  // The chart HUD: one row per layer, carrying that layer's own key. Toggling a
  // row hides the layer AND its key, so the legend can never describe something
  // that isn't on screen. Every swatch is read from the data it labels
  // (SECURITYCFG.bands, FACTIONS, the CSS traffic hues), so there is no second
  // copy of a colour to forget about when one is retuned.
  _layerKeys(id) {
    const dot = (c, t, title) =>
      `<span class="hud-key"${title ? ` title="${Util.esc(title)}"` : ""}><i style="--kc:${c}"></i>${Util.esc(t)}</span>`;
    switch (id) {
      case "lanes": return [
        `<span class="hud-key"><i class="bar" style="--kc:rgba(130,200,255,.85)"></i>trunk</span>`,
        `<span class="hud-key"><i class="bar thin" style="--kc:rgba(120,150,200,.5)"></i>local</span>`];
      case "security":
        return ((window.SECURITYCFG || {}).bands || []).slice().reverse()
          .map(b => dot(b.color, b.label, b.blurb));
      case "allegiance":
        return Object.values(window.FACTIONS || {}).map(f => dot(f.color, f.name));
      case "markets": return [
        dot("var(--up)", "rising"), dot("var(--down)", "falling"),
        dot("var(--warn)", "local event"), dot("var(--accent)", "trade hub")];
      case "traffic": return [
        dot("var(--voy-npc)", "hauler", "an NPC supply hauler with its cargo aboard"),
        dot("var(--voy-raided)", "raided", "corsairs out of a pirate den took this run's manifest — the hull flies on, the hold is empty")];
      case "law": return [
        dot("#8fb4ff", "patrol pair", "a Senate patrol — always two hulls, sweeping its sector out of the capital"),
        dot("#ff4d5e", "precinct", "the seat of a sector's law: a police station at the capital, where the patrols fly from")];
      case "fleets": return [
        dot("var(--accent)", "yours"), dot("#ffd9a0", "rivals"), dot("#5fd7ff", "survey")];
      default: return [];
    }
  },

  _renderHud() {
    const el = this.refs.hud; if (!el) return;
    const on = this.layers();
    const collapsed = !!((this.s().settings || {}).mapHudShut);
    el.classList.toggle("shut", collapsed);
    const nOff = this.LAYERS.filter(l => !on[l.id]).length;
    el.innerHTML =
      `<button class="hud-head" id="hud-toggle" aria-expanded="${!collapsed}">
         <span class="hud-tick"></span>
         <span class="hud-title">Chart layers</span>
         <span class="hud-count">${nOff ? `${this.LAYERS.length - nOff}/${this.LAYERS.length}` : "all"}</span>
       </button>
       <div class="hud-rows">` +
      this.LAYERS.map(l => `
        <button class="hud-row${on[l.id] ? " on" : ""}" data-layer="${l.id}"
                aria-pressed="${on[l.id]}" title="${Util.esc(l.hint)}">
          <span class="hud-lamp"></span>
          <span class="hud-label">${Util.esc(l.label)}</span>
          <span class="hud-keys">${this._layerKeys(l.id).join("")}</span>
        </button>`).join("") +
      `</div>`;
    el.querySelector("#hud-toggle").onclick = () => {
      const st = this.s(); if (!st.settings) st.settings = {};
      st.settings.mapHudShut = !st.settings.mapHudShut;
      window.Game.requestSave();
      this._renderHud();
    };
    for (const b of el.querySelectorAll(".hud-row")) {
      b.onclick = () => this.setLayer(b.dataset.layer, !on[b.dataset.layer]);
    }
  },

  // A closed blob hugging a sector's systems: convex hull, pushed out from the
  // centroid so it clears the stars, then run through a closed Catmull-Rom
  // spline so the territory reads as an organic region rather than a polygon.
  // Pure geometry off seeded positions — same shape on every client, and it
  // scales cleanly under the viewBox zoom (no filters, no raster).
  _sectorBlobPath(sec, X, Y, pad = 38) {
    const pts = sec.systems.map(id => Galaxy.get(id)).filter(Boolean)
      .map(sys => ({ x: X(sys.pos.x), y: Y(sys.pos.y) }));
    if (!pts.length) return "";
    const cx = pts.reduce((n, p) => n + p.x, 0) / pts.length;
    const cy = pts.reduce((n, p) => n + p.y, 0) / pts.length;
    // A sector too small to hull (or all-collinear) still deserves a blob.
    let hull = pts.length >= 3 ? this._hull(pts) : [];
    if (hull.length < 3) {
      const r = pts.reduce((n, p) => Math.max(n, Math.hypot(p.x - cx, p.y - cy)), 0) + pad;
      hull = [0, 1, 2, 3, 4, 5].map(i => {
        const a = i / 6 * Math.PI * 2;
        return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
      });
    } else {
      hull = hull.map(p => {
        const d = Math.hypot(p.x - cx, p.y - cy) || 1;
        return { x: p.x + (p.x - cx) / d * pad, y: p.y + (p.y - cy) / d * pad };
      });
    }
    return this._closedSpline(hull);
  },

  // Andrew's monotone chain — counter-clockwise hull of a point set.
  _hull(pts) {
    const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const half = src => {
      const out = [];
      for (const q of src) {
        while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
        out.push(q);
      }
      out.pop();
      return out;
    };
    return half(p).concat(half(p.slice().reverse()));
  },

  // Closed Catmull-Rom → cubic beziers. The standard 1/6 tangent gives a curve
  // that passes through every hull vertex, so the blob still contains its
  // systems after smoothing.
  _closedSpline(p) {
    const n = p.length, at = i => p[(i % n + n) % n];
    let d = `M${at(0).x.toFixed(1)},${at(0).y.toFixed(1)}`;
    for (let i = 0; i < n; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    return d + "Z";
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
    // Pad past the outermost star far enough to clear the region blobs drawn
    // round it (_sectorBlobPath's outward pad, plus the spline's overshoot);
    // extra on top for the sector name and its band label.
    const bp = 52;
    minX -= bp; maxX += bp; minY -= 90; maxY += bp + 30;
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
    this._updateSectorBlobs();
    if (!this._nodeEls) return;
    const on = this.layers();
    for (const id in this._nodeEls) {
      const idx = Galaxy.localIndex(id);
      const evt = Galaxy.hasEvent(id);
      // A ring carries two readings from two different layers: your survey
      // (FLEETS) and the market's mood (MARKETS). Neither is CSS-hideable —
      // the stroke is set here — so the switch has to happen here too.
      const surv = on.fleets && window.Expeditions && Expeditions.activeFor(id);
      const mkt = on.markets;
      const ring = this._nodeEls[id].ring;
      ring.setAttribute("stroke", surv ? "#5fd7ff"
        : mkt && evt ? "#ffc24b"
        : mkt && idx > 0.06 ? "#46d39a"
        : mkt && idx < -0.06 ? "#ff5d73" : "#3a4560");
      ring.setAttribute("stroke-width", surv || (mkt && evt) ? 3 : 2);
      ring.classList.toggle("pulse", !!(surv || (mkt && evt)));
      const docked = this.s().currentSystem === id;
      this._nodeEls[id].g.classList.toggle("docked", docked);
    }
  },

  // Security bands are derived (§5.3), so they move while you play: claim a
  // station and fit a Customs House, pass an edict, start a war — the region
  // repaints on the next tick without anything being stored.
  _updateSectorBlobs() {
    if (!this._blobEls || !window.Security) return;
    for (const sec of Galaxy.sectors) {
      const el = this._blobEls[sec.id]; if (!el) continue;
      const band = Security.sectorBand(sec.id);
      el.blob.setAttribute("fill", band.color);
      el.blob.setAttribute("stroke", band.color);
      // Civil unrest is a separate reading from lawfulness — a dashed edge, so
      // an angry-but-policed sector can never be misread as a lawless one.
      const sent = window.Stock ? Stock.sentiment[sec.id] : null;
      el.blob.classList.toggle("unrest", sent != null && sent < 40);
      el.sub.setAttribute("fill", band.color);
      el.sub.textContent = band.label.toUpperCase()
        + (sent != null && sent < 40 ? " · UNREST" : "");
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
      this._tipFaction(sys) + this._tipSecurity(sys) +
      `market: ${dirTxt}` + (evt.length ? `<br><span class="warn">⚠ local event active</span>` : "") + extra;
    this.refs.tip.style.display = "block";
    this.moveTip(e);
  },
  // Who the system answers to — the colour of its aura, named.
  _tipFaction(sys) {
    const f = window.Galaxy && Galaxy.factionOf(sys);
    const def = f && (window.FACTIONS || {})[f];
    if (!def) return "";
    return `<span style="color:${def.color}">●</span> ${def.name}<br>`;
  },

  // The band, plus the derivation that produced it. Showing the working is the
  // point of §5.3: a band is something the world did, not something authored,
  // and a player who fits a Customs House should see their own line in it.
  _tipSecurity(sys) {
    if (!window.Security) return "";
    const band = Security.bandOf(sys.id);
    const parts = Security.factors(sys.id).filter(f => !f.base && Math.abs(f.v) >= 0.005)
      .map(f => `${f.v > 0 ? "+" : "−"}${f.label}`);
    return `<span style="color:${band.color}">◆</span> ${band.label}`
      + (parts.length ? ` <span class="tip-dim">(${parts.join(", ")})</span>` : "")
      + `<br><span class="tip-dim">${band.blurb || ""}</span><br>`;
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
    this._stopVoyageLayer();
    if (window.Voyages) void Voyages.refreshPresence();
    this.refs.galaxyView.classList.add("hidden");
    this.refs.systemView.classList.remove("hidden");
    this.refs.btnClose.classList.remove("hidden");
    this.refs.crumbSys.textContent = " ▸ " + sys.name;
    this.refs.title.textContent = sys.name.toUpperCase();
    this.applyInfoHidden();      // restore the panel's collapsed state
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
      // Same launch-clearance beat as the Star Systems list; on "go" it closes
      // the map and lands on the Hub so you watch the run.
      // Launch toast + hub transit status come from Bus.on("travelStart").
      if (!await UI.launchTo(sys.id)) { this.renderInfo(sys); this.updateGalaxyNodes(); }
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
  // startScene(sys, opts) — the living system scene. Default: the star-map
  // overlay canvas with drag/zoom input. With opts it also powers the Hub
  // Live View: { canvas, followVoy: <voyage id>, zoom, overlay(ctx,w,h,now) }
  // renders the SAME scene onto another canvas — nebula, planets, gates,
  // ambient traffic and all — with the camera gliding after that voyage and
  // no pointer input. Returns a { stop() } handle; an opts.canvas scene never
  // touches the overlay scene's lifecycle fields, so both can coexist.
  startScene(sys, opts = {}) {
    const ext = !!opts.canvas;
    if (!ext) this.stopScene();
    const voyFx = { hdg: {}, mode: {}, parts: [], last: 0, pos: {} };   // per-scene voyager view state
    const canvas = opts.canvas || this.refs.canvas;
    if (!canvas || !canvas.getContext || !canvas.getContext("2d")) return null; // no-canvas env
    const handle = { sysId: sys.id, stopped: false, raf: null, stop: null };
    const cleanups = [];
    const reduced = this.s().settings.reduced;
    // How much of the canvas's bottom edge the floating command dock covers.
    // Measured rather than assumed — the dock is fixed-position and its height
    // varies with the device — and only ever non-zero when the scene runs to
    // the foot of the screen (info panel collapsed on a phone).
    let dockInset = 0;
    const measureDock = () => {
      dockInset = 0;
      const nav = document.getElementById("tabs");
      if (!nav || ext) return;
      const nr = nav.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
      if (!nr.height || !cr.height) return;
      dockInset = Util.clamp(cr.bottom - nr.top + 8, 0, cr.height * 0.4);
    };
    const resize = () => {
      const r = canvas.parentElement.getBoundingClientRect();
      const w = Math.max(320, Math.floor(r.width)), h = Math.max(260, Math.floor(r.height));
      if (canvas.width === w && canvas.height === h) return measureDock();
      canvas.width = w; canvas.height = h;
      measureDock();
    };
    resize();
    window.addEventListener("resize", resize);
    cleanups.push(() => window.removeEventListener("resize", resize));
    // device-mode / flex / overlay panel changes don't always fire window.resize
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(resize);
      ro.observe(canvas.parentElement);
      cleanups.push(() => ro.disconnect());
    }

    const W = () => canvas.width, H = () => canvas.height;

    // ---- §6.1 world space -------------------------------------------------
    // The scene lives in FIXED world coordinates (WORLD × WORLD, star at the
    // centre) — identical on every client, so shared positions no longer
    // depend on per-client canvas size, and widening WORLD keeps every existing
    // position valid. The camera maps world → screen; only
    // the nebula backdrop, starfield and Live View overlay stay in screen
    // space (which is what gives the parallax as you pan).
    // CORE is the inner system box; the star, planets, station and asteroid
    // belt are laid out inside it and are NOT affected by WORLD. WORLD is the
    // full playable box — the ring between CORE and WORLD is reserved open
    // space (mission instances, surveys, pirate encounters) and is where the
    // lane gates sit, so a run from the docks to a gate crosses it.
    // R stays CORE-relative: widening WORLD must never resize the system.
    const CORE = SYSTEMVIEW.coreSpan || 1000;
    const WORLD = Math.max(CORE, SYSTEMVIEW.worldSpan || CORE);
    const wcx = WORLD / 2, wcy = WORLD / 2, R = CORE * 0.42;

    // ---- pan / zoom camera: drag to pan, wheel / pinch to zoom -------------
    // screen = world × cam.zoom + (cam.x, cam.y). cam.zoom carries the canvas
    // fit (cover on squat mobile panes so orbits crop, contain otherwise —
    // the same rule the canvas-space scene used) × the user's pinch/wheel
    // zoom. A re-fit (resize, rotate, panel change) re-centres the view.
    // Default framing fits the CORE, so opening a system looks exactly as it
    // did before WORLD grew around it. Zooming out from there reveals the ring.
    const fitZoom = () => {
      const cw = W(), ch = H();
      return (ch < cw * 0.95 ? Math.max(cw, ch) : Math.min(cw, ch)) / CORE;
    };
    // Pull-back limit: far enough that the whole WORLD fits on the short axis.
    const minZoom = () => Math.min(fitZoom(), Math.min(W(), H()) / WORLD);
    const cam = { zoom: 1, x: 0, y: 0, _fit: 0 };
    const refit = () => {
      const f = fitZoom();
      cam.zoom = f; cam._fit = f;
      cam.x = W() / 2 - wcx * f; cam.y = H() / 2 - wcy * f;
    };
    refit();
    // Keep the VIEWPORT inside the world (the same rule the galaxy chart's
    // _clampVB uses), not the world's centre inside the viewport — pinning the
    // centre meant every zoomed-in view had to contain the star, so the station
    // and the edge gates became unreachable (and eventually invisible) the
    // further you zoomed in. An axis smaller than the viewport centres instead.
    const clampCam = () => {
      cam.zoom = Util.clamp(cam.zoom, minZoom(), fitZoom() * 4);
      const span = WORLD * cam.zoom;
      cam.x = span <= W() ? (W() - span) / 2 : Util.clamp(cam.x, W() - span, 0);
      cam.y = span <= H() ? (H() - span) / 2 : Util.clamp(cam.y, H() - span, 0);
    };
    // Chase cam (Hub Live View): glide the camera onto the followed voyage —
    // its world position is recorded by _drawVoyagers into voyFx.pos.
    const followCam = () => {
      if (!opts.followVoy) return;
      cam.zoom = (opts.zoom || 1.7) * fitZoom();
      const fp = voyFx.pos[opts.followVoy];
      if (!fp) return;
      const tx = W() / 2 - fp.x * cam.zoom, ty = H() / 2 - fp.y * cam.zoom;
      cam.x += (tx - cam.x) * (cam._snapped ? 0.08 : 1);
      cam.y += (ty - cam.y) * (cam._snapped ? 0.08 : 1);
      cam._snapped = true;
    };
    // canvas can get its real size a frame after un-hiding — re-fit then
    if (!ext) requestAnimationFrame(() => { resize(); redraw(); });
    // the live loop repaints itself; reduced-motion mode draws one frame so it needs a nudge
    const redraw = () => { if (reduced) draw(performance.now()); };
    let hintTimer = 0;
    const hideHint = () => { clearTimeout(hintTimer); if (this.refs.sceneHint) this.refs.sceneHint.classList.add("faded"); };
    const hidePoiTip = () => { if (this.refs.poiTip) this.refs.poiTip.style.display = "none"; };
    const zoomAt = (fx, fy, factor) => {
      const wx = (fx - cam.x) / cam.zoom, wy = (fy - cam.y) / cam.zoom;
      cam.zoom = Util.clamp(cam.zoom * factor, minZoom(), fitZoom() * 4);
      cam.x = fx - wx * cam.zoom; cam.y = fy - wy * cam.zoom;
      clampCam(); hideHint(); hidePoiTip(); redraw();
    };
    const panBy = (dx, dy) => { cam.x += dx; cam.y += dy; clampCam(); hideHint(); hidePoiTip(); redraw(); };

    // show the drag/zoom hint fresh each time a system opens; fade after a moment
    if (!ext && this.refs.sceneHint) {
      this.refs.sceneHint.classList.remove("faded");
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => { if (this.refs.sceneHint) this.refs.sceneHint.classList.add("faded"); }, 6000);
    }

    // input: 1 pointer drag = pan · wheel = zoom · 2 pointers = pinch-zoom.
    // Chase-cam scenes take no input — the camera belongs to the followed ship.
    if (!ext) {
      const ptrs = new Map();
      let pinchPrev = null;
      let dragAcc = 0;   // pixels moved since pointerdown — >4 suppresses the click
      const rectOf = () => canvas.getBoundingClientRect();
      const inMini = (mx, my) => mini && mx >= mini.x && mx <= mini.x + mini.s && my >= mini.y && my <= mini.y + mini.s;
      const onDown = e => { ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); pinchPrev = null; dragAcc = 0; };
      const onMove = e => {
        const p = ptrs.get(e.pointerId);
        if (!p) {   // no button down: POI / minimap hover cursor
          const r = rectOf(), mx = e.clientX - r.left, my = e.clientY - r.top;
          const wx = (mx - cam.x) / cam.zoom, wy = (my - cam.y) / cam.zoom;
          const hot = inMini(mx, my) || (window.POIs && POIs.at(sys.id, wx, wy, 12 / cam.zoom))
            || !!this._npcPosAt(voyFx, wx, wy, 12 / cam.zoom);
          canvas.style.cursor = hot ? "pointer" : "";
          return;
        }
        const px = p.x, py = p.y; p.x = e.clientX; p.y = e.clientY;
        dragAcc += Math.abs(e.clientX - px) + Math.abs(e.clientY - py);
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
      // Tap (not drag): minimap jumps the camera; a POI opens its info card.
      const onClick = e => {
        if (dragAcc > 4) return;
        const r = rectOf(), mx = e.clientX - r.left, my = e.clientY - r.top;
        if (inMini(mx, my)) {
          cam.x = W() / 2 - ((mx - mini.x) / mini.scale) * cam.zoom;
          cam.y = H() / 2 - ((my - mini.y) / mini.scale) * cam.zoom;
          clampCam(); hidePoiTip(); redraw();
          return;
        }
        const wx = (mx - cam.x) / cam.zoom, wy = (my - cam.y) / cam.zoom;
        const hit = window.POIs && POIs.at(sys.id, wx, wy, 16 / cam.zoom);
        if (hit) { this._showPoiTip(hit, mx, my); return; }
        // An NPC hauler is a contact (§4): click it for the intercept card.
        const fl = this._npcFlightAt(sys.id, voyFx, wx, wy, 16 / cam.zoom);
        if (fl) this._showFlightTip(fl, sys.id, mx, my); else hidePoiTip();
      };
      canvas.addEventListener("pointerdown", onDown);
      canvas.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      canvas.addEventListener("wheel", onWheel, { passive: false });
      canvas.addEventListener("click", onClick);
      cleanups.push(() => {
        canvas.removeEventListener("pointerdown", onDown);
        canvas.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        canvas.removeEventListener("wheel", onWheel);
        canvas.removeEventListener("click", onClick);
        canvas.style.cursor = "";
        hidePoiTip();
        clearTimeout(hintTimer);
      });
      this._sceneCtrlCleanup = () => cleanups.forEach(f => f());
    }

    const planets = sys.planets.map((p, i) => ({
      p, angle: (i * 2.39996) % (Math.PI * 2),
      orbit: 0.28 + (i / Math.max(1, sys.planets.length)) * 0.62,
      speed: (0.10 - i * 0.012) * 0.3, img: this.img(ASSET.planet(p.type)),
      size: 16 + (p.type === "gas_giant" || p.type === "ringed" ? 12 : 6),
    }));
    // Stations hold station — they're parked, not in orbit. A fixed berth
    // angle, seeded per system so no two sit the same way, out far enough that
    // ships leaving the dock aren't swallowed by the star's glare.
    const berth = window.Combat ? (Combat.seedFrom("berth:" + sys.id) % 628) / 100 : 0;
    const station = { angle: berth, orbit: 0.36, speed: 0, img: this.img(ASSET.station(sys.race)) };
    const starImg = this.img(ASSET.star(sys.star));
    // Admin-uploaded (or git-committed default) per-system space background
    // takes precedence over the sector nebula.
    const bgUrl = ASSET.spacebg(sys.id) || ASSET.nebula(sys.nebula);
    const neb = this.img(bgUrl);
    const aster = sys.asteroidBelt ? this.img(ASSET.asteroids()) : null;

    // One hyperspace gate per lane, at the system's edge on the true bearing
    // toward the connected system (LIVING_GALAXY.md §2.4) — the gate to Navos
    // points at Navos. World-space (§6.1): a pure function of the lane graph,
    // identical on every client — computed once.
    let gateCache = null;
    const gates = () => {
      if (gateCache) return gateCache;
      // The gate ring sits on the CORE's inset edge, NOT the world rim — it
      // stays exactly where it was before WORLD grew, so the enlarged space is
      // the open ring OUTSIDE the gates (deep space beyond the system's civil
      // zone) rather than a gap opened up inside it.
      const m = 64, half = CORE / 2 - m;
      const gl = window.Lanes ? Lanes.gates(sys.id) : [];
      gateCache = !gl.length ? [{ to: null, name: "", x: wcx + half, y: wcy - CORE * 0.2 }] : gl.map(g => {
        const dx = Math.cos(g.angle), dy = Math.sin(g.angle);
        // project the bearing from the centre onto that inset edge
        const k = half / Math.max(Math.abs(dx), Math.abs(dy), 1e-9);
        const dest = Galaxy.get(g.to);
        return { to: g.to, name: dest ? dest.name : "", x: wcx + dx * k, y: wcy + dy * k };
      });
      return gateCache;
    };

    // Deep-space POIs (docs/SPACE_INTERACTIVITY.md §2, step 1): seeded places
    // in the reserved ring — no state, identical on every client. Art comes
    // from ASSET.poi when an admin uploaded some; otherwise _drawPOI falls
    // back to canvas primitives, the same pattern planets and stations use.
    // Sites churn on the clock (POICFG), so the list is read every frame —
    // POIs.list() is cached and only rebuilds when a slot actually rolls.
    // Art is keyed by type, and a slot's type never changes.
    const poiList = () => (window.POIs ? POIs.list(sys.id) : []);
    const poiImgs = {};
    for (const p of (window.POIs ? POIs.slots(sys.id) : [])) {
      if (poiImgs[p.type] !== undefined) continue;
      const u = ASSET.poi(p.type);
      poiImgs[p.type] = u ? this.img(u) : null;
    }
    let mini = null;   // minimap rect, refreshed each frame — click jumps the cam

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
      const pts = planets.map((pl, i) => ({ x: pl._x ?? wcx, y: pl._y ?? wcy, kind: "planet", idx: i }));
      pts.push({ x: station._x ?? wcx, y: station._y ?? wcy, kind: "station" });
      return pts;
    };
    const targetPos = t => {
      if (!t) return { x: wcx, y: wcy };
      if (t.kind === "planet") { const pl = planets[t.idx]; return { x: pl?._x ?? wcx, y: pl?._y ?? wcy }; }
      if (t.kind === "station") return { x: station._x ?? wcx, y: station._y ?? wcy };
      if (t.kind === "gate") { const gl = gates(); return gl[(t.idx ?? 0) % gl.length]; }
      return { x: t.x, y: t.y };
    };
    // Ships mostly shuttle between docks, but sometimes choose the gate (leave).
    const pickTarget = (avoid, noGate) => {
      if (!noGate && Math.random() < SYSTEMVIEW.gateLeaveChance)
        return { kind: "gate", idx: Math.floor(Math.random() * gates().length) };
      const docks = dockPoints();
      let t = Util.pick(docks);
      if (avoid && t.kind === avoid.kind && t.idx === avoid.idx && docks.length > 1) t = Util.pick(docks);
      return t.kind === "planet" ? { kind: "planet", idx: t.idx } : { kind: "station" };
    };
    const warpFlash = (x, y) => this._gateBurst(particles, x, y);
    // New ships arrive through the gate (warp-in), then go about their errands.
    const spawnShip = () => {
      const g = Util.pick(gates());   // ambient traffic warps in through any gate
      const r = Util.pick(raceKeys);
      ships.push({ x: g.x, y: g.y, race: r, img: raceImg(r), alpha: 0, scale: 0.3, state: "warpIn",
        spd: shipSpeed(), ang: Math.atan2(wcy - g.y, wcx - g.x), target: null, dwell: 0 });
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
      // seeded inside the CORE — traffic already underway belongs at the docks,
      // not scattered across the reserved ring
      ships.push({ x: wcx + (Math.random() - 0.5) * CORE, y: wcy + (Math.random() - 0.5) * CORE,
        race: r, img: raceImg(r), scale: 1,
        alpha: 1, state: "travel", spd: shipSpeed(), ang: Math.random() * 6.28, target: null, dwell: 0 });
    }
    // ---- planet cargo shuttles: the in-system leg of NPC supply ----------
    // One hauler per industry planet, looping planet ↔ station with the
    // planet's REAL goods — its export out, its listed import back. Names are
    // seeded like traffic.js; the station's freighter (traffic.js) then runs
    // the capital leg, so the whole chain is visible: planet → station → exchange.
    if (!reduced) {
      const cargoImg = this.img(ASSET.ship("hauler"));
      sys.planets.forEach((pl, idx) => {
        const comm = (COMMODITIES.find(c => c.id === pl.commodity) || {}).name || "cargo";
        const name = window.Traffic ? Traffic._name("p:" + sys.id + ":" + idx) : "Shuttle " + (idx + 1);
        const fillCargo = t => t.replace(/\{NAME\}/g, name).replace(/\{PLANET\}/g, pl.name)
          .replace(/\{COMM\}/g, comm).replace(/\{IMP\}/g, pl.importing);
        ships.push({
          x: wcx, y: wcy, img: cargoImg, alpha: 0, scale: 0.85, kind: "cargo",
          state: "haulWait", dwell: Util.randFloat(1, 10), spd: shipSpeed() * 0.8,
          ang: 0, target: null, haulIdx: idx,
          sayOut: (window.CARGO_RADIO ? CARGO_RADIO.out : []).map(fillCargo),
          sayBack: (window.CARGO_RADIO ? CARGO_RADIO.back : []).map(fillCargo),
        });
      });
    }
    let combatCooldown = 5;
    let lastChatterAt = 0;

    const stars = [];
    for (let i = 0; i < 120; i++) stars.push({ x: Math.random(), y: Math.random(), b: Math.random() });

    let last = performance.now();
    const draw = (now) => {
      if (handle.stopped) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (cam._fit !== fitZoom()) refit();   // canvas re-sized → re-fit the view
      followCam();
      const w = W(), h = H(), cx = wcx, cy = wcy;   // scene content draws in world space
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
      // station — fixed in space (speed 0); sx/sy stay put frame to frame
      const sx = cx + Math.cos(station.angle) * station.orbit * R, sy = cy + Math.sin(station.angle) * station.orbit * R;
      if (station.img.ok) ctx.drawImage(station.img, sx - 16, sy - 16, 32, 32);
      else { ctx.fillStyle = "#9aa9c8"; ctx.fillRect(sx - 8, sy - 8, 16, 16); }
      // precinct — the seat of the law in a top-band system (police.js).
      // Derived like the band itself: lift the system into POLICECFG.stationBand
      // and the precinct opens; drop it and the lights go out.
      if (window.Police && Police.hasPrecinct(sys.id)) {
        const pa = berth + 2.3;
        this._drawPrecinct(ctx, cx + Math.cos(pa) * 0.55 * R, cy + Math.sin(pa) * 0.55 * R, now, cam.zoom);
      }

      // hyperspace gates at the system edge — one per lane, ships warp in/out
      for (const gp of gates()) this._drawGate(ctx, gp.x, gp.y, now * 0.001, gp.name, cam.zoom);

      // deep-space POIs — out in the ring beyond the gates (§2 step 1)
      const pois = poiList();
      for (const p of pois) this._drawPOI(ctx, p, poiImgs[p.type], now, cam.zoom);
      // seeded NPC barges working the richer seams (§3 — belts look worked
      // before players arrive), then your own parked mining ops
      for (const p of pois) if (p.ore) this._drawBeltWork(ctx, p, now);
      if (window.Mining && window.Fleet) this._drawMiningOps(ctx, sys, now, cam.zoom);

      // ---- ships: behaviour + render ----
      station._x = sx; station._y = sy;
      if (!reduced) {
        // cargo shuttles are permanent residents — don't let them crowd out ambient spawns
        const alive = ships.reduce((n, s) => n + (s.state !== "dead" && s.kind !== "cargo" ? 1 : 0), 0);
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
            if (b && bd < CORE * 0.7) lastChatterAt = startDialogue(a, b, now);   // multi-turn exchange
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
      const env = { targetPos, pickTarget, explode, spark, say, warpFlash, sx, sy };
      for (const sh of ships) {
        if (!reduced) this._stepShip(sh, dt, env);
        const a = Util.clamp(sh.alpha, 0, 1);
        if (a <= 0) continue;
        const sc = sh.scale ?? 1;
        ctx.save(); ctx.globalAlpha = a; ctx.translate(sh.x, sh.y); ctx.rotate(sh.ang || 0);
        // exhaust plume — every hull under thrust trails engine wash
        if (sh.state !== "dock" && sh.state !== "haulDock") {
          const fl = (5 + Math.sin(now * 0.02 + sh.x * 0.7) * 2) * sc * (sh.state === "warpOut" ? 1.8 : 1);
          const g2 = ctx.createLinearGradient(-9 * sc, 0, -9 * sc - fl * 2, 0);
          g2.addColorStop(0, "rgba(140,195,255,.6)"); g2.addColorStop(1, "rgba(140,195,255,0)");
          ctx.fillStyle = g2;
          ctx.beginPath(); ctx.moveTo(-8 * sc, -1.8 * sc); ctx.lineTo(-8 * sc - fl * 2, 0); ctx.lineTo(-8 * sc, 1.8 * sc); ctx.closePath(); ctx.fill();
        }
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
      // speech bubbles ride on top of everything (clamped to world bounds)
      for (const sh of ships) this._drawBubble(ctx, sh, WORLD, WORLD);

      // purposeful ships (projections of real state): your flagship + other
      // barons' flagships with the owner's name on top, mission convoys in
      // formation, couriers — crossing between the gates their route actually
      // uses — and survey hulls parked at their seeded work-site (§6.2).
      this._drawVoyagers(ctx, sys, gates(), sx, sy, voyFx, opts.followVoy, { cx, cy, R });
      if (window.Piracy && window.Fleet) this._drawPiracyScene(ctx, sys, voyFx, { cx, cy, R });

      ctx.restore();   // end camera transform

      // minimap (screen space): the widened world stays navigable — §2 step 1.
      // Chase-cam (Hub Live View) scenes skip it; their camera isn't yours.
      mini = ext ? null : this._drawMinimap(ctx, w, h, cam, { CORE, WORLD, wcx, wcy, gates: gates(), pois: poiList() }, dockInset);

      if (opts.overlay) opts.overlay(ctx, w, h, now);   // Hub Live View chrome (chart inset, flashes)

      if (!reduced) {
        if (ext) handle.raf = requestAnimationFrame(draw);
        else this.raf = requestAnimationFrame(draw);
      }
    };
    if (reduced) { draw(performance.now()); }   // single static frame
    else if (ext) handle.raf = requestAnimationFrame(draw);
    else this.raf = requestAnimationFrame(draw);
    if (!ext) this.scene = { canvas };
    handle.stop = () => {
      if (handle.stopped) return;
      handle.stopped = true;
      if (handle.raf) cancelAnimationFrame(handle.raf);
      if (ext) cleanups.forEach(f => f());   // default scene cleans up via stopScene()
    };
    return handle;
  },

  // One ship's behaviour for a frame. States: warpIn → travel → (dock | land |
  // warpOut) → travel … with rare combat. Ships arrive through the hyperspace
  // gate, run errands between docks, and either land (fade into a planet),
  // jump out through the gate, or get caught in a dogfight. Speech bubbles and
  // delayed replies tick down here too.
  _stepShip(sh, dt, env) {
    const { targetPos, pickTarget, explode, spark, say, warpFlash, sx, sy } = env;
    // Inertial flight: the hull steers toward the target at a bounded turn
    // rate and thrusts along its own heading, so course changes are flown as
    // banking arcs instead of instant snaps.
    const moveTo = (tx, ty, slow) => {
      const dx = tx - sh.x, dy = ty - sh.y, d = Math.hypot(dx, dy) || 1;
      const want = Math.atan2(dy, dx);
      if (sh.ang == null) sh.ang = want;
      let diff = Math.atan2(Math.sin(want - sh.ang), Math.cos(want - sh.ang));
      const turn = 2.4 * dt;                       // rad/s — tight enough to never orbit
      sh.ang += Util.clamp(diff, -turn, turn);
      const v = sh.spd * (slow ? 0.5 : 1) * dt;
      sh.x += Math.cos(sh.ang) * v; sh.y += Math.sin(sh.ang) * v;
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
      // ---- planet cargo shuttles (kind "cargo"): planet ↔ station loop ----
      case "haulWait": {   // parked on the pad, invisible, waiting out the turnaround
        const p = targetPos({ kind: "planet", idx: sh.haulIdx });
        sh.x = p.x; sh.y = p.y; sh.alpha = 0;
        sh.dwell -= dt;
        if (sh.dwell <= 0) {
          sh.state = "haulOut";
          if (sh.sayOut.length && Math.random() < 0.5)
            sh.bubble = { text: Util.pick(sh.sayOut), t: SYSTEMVIEW.bubbleMs / 1000 };
        }
        break;
      }
      case "haulOut": {    // lift off and run the export to the station
        sh.alpha = Math.min(1, sh.alpha + dt * 1.6);
        if (moveTo(sx, sy) < 10) { sh.state = "haulDock"; sh.dwell = Util.randFloat(2.5, 6); }
        break;
      }
      case "haulDock": {   // unload at the docks (opposite berth from the idlers)
        sh.x += ((sx - 16) - sh.x) * Math.min(1, dt * 3);
        sh.y += ((sy - 16) - sh.y) * Math.min(1, dt * 3);
        sh.dwell -= dt;
        if (sh.dwell <= 0) {
          sh.state = "haulBack";
          if (sh.sayBack.length && Math.random() < 0.5)
            sh.bubble = { text: Util.pick(sh.sayBack), t: SYSTEMVIEW.bubbleMs / 1000 };
        }
        break;
      }
      case "haulBack": {   // haul the planet's imports home
        const p = targetPos({ kind: "planet", idx: sh.haulIdx });
        if (moveTo(p.x, p.y) < 8) sh.state = "haulLand";
        break;
      }
      case "haulLand": {   // settle onto the pad and start the next turnaround
        const p = targetPos({ kind: "planet", idx: sh.haulIdx });
        moveTo(p.x, p.y, true);
        sh.alpha -= dt * 1.2;
        if (sh.alpha <= 0) { sh.state = "haulWait"; sh.dwell = Util.randFloat(6, 14); }
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

  // Real fleets visible in this system (Voyages.inSystem). A docked flagship
  // is berthed inside the station and not drawn; mission/survey fleets loiter
  // on site "working". Transits fly station ↔ the correct gate for their
  // route, holding at the gate while the hyperdrive spools (gateOut) or just
  // after drop-out (gateIn) — with a warp burst on the jump itself. Headings
  // are smoothed so course changes read as flown maneuvers. Names use
  // fillText, so other barons' display names stay plain text.
  _drawVoyagers(ctx, sys, gateAt, sx, sy, fx, followId, geom) {
    if (!window.Voyages) return;
    geom = geom || { cx: 500, cy: 500, R: 420 };   // §6.1 world space defaults
    fx = fx || (this._voyFx || (this._voyFx = { hdg: {}, mode: {}, parts: [], last: 0, pos: {} }));
    fx.pos = fx.pos || {};
    const now = Date.now();
    // The berth↔gate corridor. Cruise legs run station ↔ holdPoint and the gate
    // hold sits exactly ON holdPoint, so a ship never teleports between the two
    // stages — it flies in, stops, spools, and jumps from where it stopped.
    const holdOf = g => {
      const a = Math.atan2(sy - g.y, sx - g.x);
      return { x: g.x + Math.cos(a) * 26, y: g.y + Math.sin(a) * 26 };
    };
    const dt = Math.min(0.1, (now - (fx.last || now)) / 1000); fx.last = now;
    let list;
    try { list = Voyages.inSystem(sys.id, now); } catch (e) { return; }
    const seen = new Set();
    for (const v of list) {
      // A hauler mid-boarding is held at the intercept point — the piracy
      // scene pass draws it there; its lane position resumes when it breaks
      // away (the run continues, emptied or saved).
      if (window.Piracy && v.npc && !v.police && Piracy.opOnFlight) {
        const bop = Piracy.opOnFlight(v.id, v.loop);
        if (bop && !bop.resolved && now >= bop.resolveAt && now < Piracy.robEndAt(bop)) continue;
      }
      seen.add(v.id);
      let x, y, want, thrust = 1;
      const gp = gateAt.find(g => g.to === v.gate) || gateAt[0];
      if (v.mode === "working" && v.kind === "survey") {
        // §6.2: the survey hull parks at a seeded work-site out in the system
        // — derelict hulk, abandoned outpost or anomaly, hashed from system +
        // survey uid — and sweeps it with the scan pulse.
        const hs = window.Combat ? Combat.seedFrom("site:" + sys.id + ":" + v.id) : 1;
        const sr = geom.R * (0.55 + (hs % 20) / 100);
        const sa = ((hs >> 5) % 628) / 100;
        const stx = geom.cx + Math.cos(sa) * sr, sty = geom.cy + Math.sin(sa) * sr;
        this._drawSite(ctx, stx, sty, hs % 3, now);
        const a = (hs % 628) / 100 + now * 0.00015;
        x = stx + Math.cos(a) * 24; y = sty + Math.sin(a) * 24;
        want = a + Math.PI / 2; thrust = 0.25;
        const pr = (now % 2400) / 2400;              // scan pulse over the site
        ctx.strokeStyle = `rgba(95,215,255,${((1 - pr) * 0.45).toFixed(2)})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(stx, sty, 8 + pr * 40, 0, 7); ctx.stroke();
      } else if (v.mode === "working") {
        const h = window.Combat ? Combat.seedFrom(v.id) : 1;
        const rr = 34 + (h % 3) * 9;
        const a = (h % 628) / 100 + now * 0.00012;
        x = sx + Math.cos(a) * rr; y = sy + Math.sin(a) * rr;
        want = a + Math.PI / 2; thrust = 0.3;
        const pr = (now % 2400) / 2400;              // scan pulse — visibly at work
        ctx.strokeStyle = `rgba(95,215,255,${((1 - pr) * 0.45).toFixed(2)})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(x, y, 8 + pr * 40, 0, 7); ctx.stroke();
      } else if (v.mode === "gateOut" || v.mode === "gateIn") {
        if (!gp) continue;
        const hold = holdOf(gp);
        x = hold.x; y = hold.y;
        // outbound holds facing the gate it's about to enter; inbound has just
        // come through and is already turning for the station
        want = v.mode === "gateOut"
          ? Math.atan2(gp.y - hold.y, gp.x - hold.x)
          : Math.atan2(sy - hold.y, sx - hold.x);
        thrust = 0.15;
        if (v.mode === "gateOut") {                   // hyperdrive spooling — charge glow
          const g = ctx.createRadialGradient(x, y, 2, x, y, 24 + v.f * 22);
          g.addColorStop(0, `rgba(150,215,255,${(0.25 + v.f * 0.45).toFixed(2)})`);
          g.addColorStop(1, "rgba(150,215,255,0)");
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 24 + v.f * 22, 0, 7); ctx.fill();
        }
      } else {
        if (!gp) continue;
        const hold = holdOf(gp);                       // same endpoint the gate hold uses
        const from = v.mode === "departing" ? { x: sx, y: sy } : hold;
        const to = v.mode === "departing" ? hold : { x: sx, y: sy };
        x = from.x + (to.x - from.x) * v.frac;
        y = from.y + (to.y - from.y) * v.frac;
        want = Math.atan2(to.y - from.y, to.x - from.x);
        thrust = 0.4 + 2.4 * v.f * (1 - v.f);        // accelerate, then brake
      }
      // warp burst on drop-out (ship appears at the arrival gate from nowhere)
      const prev = fx.mode[v.id];
      if (gp && v.mode === "gateIn" && !prev) this._gateBurst(fx.parts, gp.x, gp.y);
      fx.mode[v.id] = { mode: v.mode, gx: gp ? gp.x : x, gy: gp ? gp.y : y };
      fx.pos[v.id] = { x, y };   // scene position — the Live View chase cam reads this
      // flown turns: heading eases toward the wanted bearing
      if (fx.hdg[v.id] == null) fx.hdg[v.id] = want;
      const diff = Math.atan2(Math.sin(want - fx.hdg[v.id]), Math.cos(want - fx.hdg[v.id]));
      fx.hdg[v.id] += Util.clamp(diff, -2.2 * dt, 2.2 * dt);
      const ang = fx.hdg[v.id];

      const [kind, id] = String(v.sprite || "ship:shuttle").split(":");
      const im = this.img(kind === "race" ? ASSET.raceship(id) : ASSET.ship(id));
      const flag = v.kind === "flagship";
      const followed = !!followId && v.id === followId;
      const sz = (flag ? 15 : 11) * (followed ? 1.3 : 1);
      // §6.2: convoys fly in formation — up to three wingmen in trailing
      // echelon behind the lead hull, each wearing its own sprite. Pure
      // projection of the voyage's shipUids; nothing simulated.
      if (v.uids && v.uids.length > 1) {
        for (let i = 0; i < Math.min(3, v.uids.length - 1); i++) {
          const side = i % 2 ? -1 : 1, rank = 1 + (i >> 1);
          const wref = String(Voyages._fleetSprite([v.uids[i + 1]])).split(":");
          const wim = this.img(wref[0] === "race" ? ASSET.raceship(wref[1]) : ASSET.ship(wref[1]));
          const wx = x - Math.cos(ang) * sz * 1.7 * rank + Math.cos(ang + Math.PI / 2) * side * sz * 1.15;
          const wy = y - Math.sin(ang) * sz * 1.7 * rank + Math.sin(ang + Math.PI / 2) * side * sz * 1.15;
          const wsz = sz * 0.75;
          ctx.save(); ctx.globalAlpha = 0.9; ctx.translate(wx, wy); ctx.rotate(ang);
          if (wim.ok) ctx.drawImage(wim, -wsz, -wsz * 0.6, wsz * 2, wsz * 1.2);
          else {
            ctx.fillStyle = "#7b8cff";
            ctx.beginPath(); ctx.moveTo(wsz, 0); ctx.lineTo(-wsz * 0.7, wsz * 0.5); ctx.lineTo(-wsz * 0.7, -wsz * 0.5);
            ctx.closePath(); ctx.fill();
          }
          ctx.restore();
        }
      }
      // Tracking reticle on the ship the Live View is following, so it never
      // gets lost among ambient traffic or washed out against the star.
      if (followed) {
        const rr = sz + 10 + Math.sin(now * 0.004) * 1.5;
        ctx.save();
        ctx.strokeStyle = "rgba(63,227,255,.85)"; ctx.lineWidth = 1.5;
        for (let k = 0; k < 4; k++) {
          const a0 = k * Math.PI / 2 + 0.35;
          ctx.beginPath(); ctx.arc(x, y, rr, a0, a0 + 0.55); ctx.stroke();
        }
        ctx.restore();
      }
      // Robbed by corsairs on this run (Traffic._robbed): a distress pulse, so
      // NPC piracy is visible in space rather than a hidden subtraction.
      if (v.raided) {
        const pr = (now % 1600) / 1600;
        ctx.strokeStyle = `rgba(255,93,115,${((1 - pr) * 0.5).toFixed(2)})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(x, y, sz + pr * 18, 0, 7); ctx.stroke();
      }
      // Senate patrols fly in PAIRS with the lights on (police.js): the
      // wingman holds trailing echelon, and both strobe red/blue so the law
      // reads at a glance from anywhere on the map.
      if (v.police) {
        const wx = x - Math.cos(ang) * sz * 2.1 + Math.cos(ang + Math.PI / 2) * sz * 1.35;
        const wy = y - Math.sin(ang) * sz * 2.1 + Math.sin(ang + Math.PI / 2) * sz * 1.35;
        ctx.save(); ctx.globalAlpha = 0.95; ctx.translate(wx, wy); ctx.rotate(ang);
        if (im.ok) ctx.drawImage(im, -sz * 0.9, -sz * 0.54, sz * 1.8, sz * 1.08);
        else {
          ctx.fillStyle = "#8fb4ff";
          ctx.beginPath(); ctx.moveTo(sz * 0.9, 0); ctx.lineTo(-sz * 0.6, sz * 0.45); ctx.lineTo(-sz * 0.6, -sz * 0.45);
          ctx.closePath(); ctx.fill();
        }
        ctx.restore();
        this._copLights(ctx, x, y, sz, now);
        this._copLights(ctx, wx, wy, sz * 0.9, now + 320);
      }
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      const fl = (5 + Math.sin(now * 0.02 + x * 0.5) * 2) * (0.3 + thrust);   // exhaust plume
      const pg = ctx.createLinearGradient(-sz * 0.8, 0, -sz * 0.8 - fl * 2, 0);
      pg.addColorStop(0, "rgba(130,195,255,.65)"); pg.addColorStop(1, "rgba(130,195,255,0)");
      ctx.fillStyle = pg;
      ctx.beginPath(); ctx.moveTo(-sz * 0.75, -sz * 0.22); ctx.lineTo(-sz * 0.75 - fl * 2, 0); ctx.lineTo(-sz * 0.75, sz * 0.22); ctx.closePath(); ctx.fill();
      if (im.ok) ctx.drawImage(im, -sz, -sz * 0.6, sz * 2, sz * 1.2);
      else {
        ctx.fillStyle = flag ? (v.you ? "#3fe3ff" : "#ffd9a0") : "#7b8cff";
        ctx.beginPath(); ctx.moveTo(sz, 0); ctx.lineTo(-sz * 0.7, sz * 0.5); ctx.lineTo(-sz * 0.7, -sz * 0.5);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      const label = flag ? v.name : v.label;
      if (!label) continue;
      ctx.save();
      ctx.font = flag ? "600 11px system-ui, sans-serif" : "10px system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(4,8,18,.9)";
      const ly = y - sz - (followed ? 16 : 8);   // clear of the reticle
      ctx.strokeText(label, x, ly);
      ctx.fillStyle = flag ? (v.you ? "#3fe3ff" : "#ffd9a0") : (followed ? "#cfe3ff" : "rgba(170,185,220,.9)");
      ctx.fillText(label, x, ly);
      ctx.restore();
    }
    // ships that left the scene: a hull that was spooling at a gate just
    // jumped — flash the burst it vanished with, then forget it
    for (const id in fx.mode) if (!seen.has(id)) {
      const m = fx.mode[id];
      if (m && m.mode === "gateOut") this._gateBurst(fx.parts, m.gx, m.gy);
      delete fx.mode[id]; delete fx.hdg[id]; delete fx.pos[id];
    }
    // warp-burst particles
    for (let i = fx.parts.length - 1; i >= 0; i--) {
      const p = fx.parts[i]; p.life -= dt;
      if (p.life <= 0) { fx.parts.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      ctx.fillStyle = p.color + (p.life / p.max).toFixed(2) + ")";
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }
  },

  // ---- scene draw helpers (hyperspace gate + speech bubbles) ----
  // Text drawn inside the camera transform shrinks with it, so a name that
  // reads at the default framing is an unreadable smudge once you pull back
  // to see the deep-space ring. Scaling the glyphs by 1/zoom keeps every
  // world label the same size on screen at any zoom; the anchor stays in
  // world units so the label still hugs the thing it names.
  _labelFont(zoom) { return `${(9 / (zoom || 1)).toFixed(1)}px ui-monospace, monospace`; },

  // Red/blue strobes over a patrol hull — alternating, with a soft glow when
  // lit. The second ship of the pair calls this with a phase offset so the
  // two never flash in step.
  _copLights(ctx, x, y, sz, now) {
    const on = Math.floor(now / 320) % 2 === 0;
    const dot = (dx, color, lit) => {
      ctx.save();
      const dy = y - sz * 0.95;
      if (lit) {
        const g = ctx.createRadialGradient(x + dx, dy, 0.5, x + dx, dy, 7);
        g.addColorStop(0, color); g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.globalAlpha = 0.5; ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x + dx, dy, 7, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = lit ? 0.95 : 0.25;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x + dx, dy, lit ? 2 : 1.3, 0, 7); ctx.fill();
      ctx.restore();
    };
    dot(-3, "#ff4d5e", on);
    dot(3, "#3f8cff", !on);
  },

  // Precinct station (police.js): canvas primitive in the fallback style —
  // an armored hub, two docking pylons, and the rotating red/blue beacon
  // that says the law lives here.
  _drawPrecinct(ctx, x, y, now, zoom) {
    ctx.save();
    ctx.translate(x, y);
    // hub
    ctx.fillStyle = "#2b3752";
    ctx.strokeStyle = "#8fa4cc"; ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3 + 0.26;
      ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * 11, Math.sin(a) * 11);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // docking pylons
    ctx.fillStyle = "#42527a";
    ctx.fillRect(-19, -2.5, 8, 5); ctx.fillRect(11, -2.5, 8, 5);
    // rotating beacon: a red and a blue lamp sweep the ring in opposition
    const a = now * 0.003;
    for (const [off, color] of [[0, "#ff4d5e"], [Math.PI, "#3f8cff"]]) {
      const bx = Math.cos(a + off) * 14, by = Math.sin(a + off) * 14;
      const g = ctx.createRadialGradient(bx, by, 0.5, bx, by, 6);
      g.addColorStop(0, color); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalAlpha = 0.6; ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(bx, by, 6, 0, 7); ctx.fill();
      ctx.globalAlpha = 1; ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(bx, by, 1.6, 0, 7); ctx.fill();
    }
    // label, screen-fixed size like every world label
    ctx.globalAlpha = 0.85;
    ctx.font = this._labelFont(zoom);
    ctx.textAlign = "center"; ctx.fillStyle = "#9fb4d8";
    ctx.fillText("PRECINCT", 0, 22 / (zoom || 1) + 8);
    ctx.restore();
  },

  _gateBurst(particles, x, y) {
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2, s = Util.randFloat(40, 110);
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: Util.randFloat(.3, .7), max: .7, color: "rgba(130,200,255," });
    }
  },

  // §6.2 survey work-sites — canvas primitives, no sprites (LIVING_GALAXY.md
  // §5.6): 0 = derelict hulk, 1 = abandoned outpost, 2 = anomaly.
  _drawSite(ctx, x, y, type, now) {
    ctx.save();
    if (type === 0) {           // derelict hulk: dark broken hull + drifting debris
      ctx.translate(x, y); ctx.rotate(0.6);
      ctx.fillStyle = "rgba(90,100,120,.85)";
      ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-6, -6); ctx.lineTo(-6, 6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgba(70,78,95,.8)";
      ctx.fillRect(-16, -3, 7, 6);                       // sheared-off stern
      ctx.fillStyle = "rgba(120,130,150,.5)";
      for (let i = 0; i < 4; i++) {
        const a = i * 1.7 + now * 0.0002, r = 12 + i * 4;
        ctx.fillRect(Math.cos(a) * r, Math.sin(a) * r, 1.6, 1.6);
      }
    } else if (type === 1) {    // abandoned outpost: module + panel + cold beacon
      ctx.fillStyle = "rgba(110,120,140,.85)";
      ctx.fillRect(x - 6, y - 6, 12, 12);
      ctx.strokeStyle = "rgba(90,110,160,.7)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x - 14, y); ctx.lineTo(x - 6, y); ctx.moveTo(x + 6, y); ctx.lineTo(x + 14, y); ctx.stroke();
      ctx.strokeStyle = "rgba(150,160,180,.6)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x, y - 14); ctx.stroke();
      const blink = (Math.sin(now * 0.004) + 1) / 2;
      ctx.fillStyle = `rgba(255,120,90,${(0.25 + blink * 0.6).toFixed(2)})`;
      ctx.beginPath(); ctx.arc(x, y - 15, 1.8, 0, 7); ctx.fill();
    } else {                    // anomaly: slow violet swirl
      const glow = ctx.createRadialGradient(x, y, 2, x, y, 26);
      glow.addColorStop(0, "rgba(190,120,255,.5)"); glow.addColorStop(1, "rgba(190,120,255,0)");
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, 26, 0, 7); ctx.fill();
      ctx.lineWidth = 1.6;
      for (let k = 0; k < 3; k++) {
        ctx.strokeStyle = `rgba(210,160,255,${(0.7 - k * 0.18).toFixed(2)})`;
        const r = 7 + k * 5;
        ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.5, now * 0.0006 * (1 + k * 0.6), 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  },

  _drawGate(ctx, gx, gy, t, destName, zoom) {
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
    ctx.fillStyle = "rgba(170,210,255,.75)"; ctx.font = this._labelFont(zoom);
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    // generated names can already end in "Gate" (Daxor Gate) — don't double it
    const label = destName ? destName.toUpperCase().replace(/ GATE$/, "") + " GATE" : "HYPERSPACE GATE";
    ctx.fillText("⇋ " + label, gx, gy + 30);
    ctx.restore();
  },

  // Deep-space POI (docs/SPACE_INTERACTIVITY.md §2 step 1): admin art when
  // uploaded (ASSET.poi), else a seeded canvas primitive per type — the same
  // image-or-fallback pattern as planets and stations. Derelicts and
  // listening posts reuse the survey work-site shapes.
  _drawPOI(ctx, poi, img, now, zoom) {
    const { x, y, r, seed } = poi;
    ctx.save();
    if (img && img.ok) {
      ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
    } else switch (poi.type) {
      case "belt": {      // tumbling rock cluster — seeded scatter, slow drift
        const rot = now * 0.00004;
        for (let k = 0; k < 9; k++) {
          const h = (seed ^ Math.imul(k + 1, 0x9E3779B1)) >>> 0;
          const a = (h % 628) / 100 + rot, rr = r * (0.25 + ((h >> 9) % 80) / 100);
          const s = 2 + ((h >> 17) % 5);
          ctx.fillStyle = `rgba(${150 + (h % 40)},${125 + (h % 30)},95,.85)`;
          ctx.fillRect(x + Math.cos(a) * rr - s / 2, y + Math.sin(a) * rr - s / 2, s, s);
        }
        break;
      }
      case "debris": {    // slowly turning hull shards
        for (let k = 0; k < 8; k++) {
          const h = (seed ^ Math.imul(k + 1, 0x85EBCA6B)) >>> 0;
          const a = (h % 628) / 100, rr = r * (0.2 + ((h >> 8) % 75) / 100);
          ctx.save();
          ctx.translate(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
          ctx.rotate(((h >> 16) % 628) / 100 + now * 0.0001);
          ctx.fillStyle = "rgba(140,150,170,.7)";
          ctx.fillRect(-3, -1, 6, 2);
          ctx.restore();
        }
        break;
      }
      case "gas": {       // sensor-shadow nebula puff with drifting wisps
        const puls = 0.85 + Math.sin(now * 0.0006 + seed) * 0.15;
        const g = ctx.createRadialGradient(x, y, 2, x, y, r * puls);
        g.addColorStop(0, "rgba(104,214,178,.3)"); g.addColorStop(1, "rgba(104,214,178,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * puls, 0, 7); ctx.fill();
        ctx.strokeStyle = "rgba(140,230,200,.25)"; ctx.lineWidth = 1.2;
        for (let k = 0; k < 3; k++) {
          ctx.beginPath();
          ctx.ellipse(x, y, r * (0.4 + k * 0.2), r * (0.2 + k * 0.12), (seed % 314) / 100 + k + now * 0.00008, 0, 7);
          ctx.stroke();
        }
        break;
      }
      case "derelict": this._drawSite(ctx, x, y, 0, now); break;
      case "post": this._drawSite(ctx, x, y, 1, now); break;
      case "rig": {       // gantry hull, drill boom, blinking work light
        ctx.fillStyle = "rgba(120,110,90,.9)";
        ctx.fillRect(x - 8, y - 5, 16, 10);
        ctx.strokeStyle = "rgba(150,140,110,.8)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, y + 5); ctx.lineTo(x, y + 14); ctx.stroke();
        ctx.fillStyle = Math.sin(now * 0.003 + seed) > 0 ? "rgba(255,194,75,.9)" : "rgba(255,194,75,.25)";
        ctx.beginPath(); ctx.arc(x + 5, y - 7, 1.6, 0, 7); ctx.fill();
        break;
      }
      case "buoy": {      // nav diamond with a strobing lane light
        ctx.strokeStyle = "rgba(120,180,230,.8)"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 5, y); ctx.closePath(); ctx.stroke();
        const blink = (now * 0.001 + (seed % 10)) % 1.6 < 0.12;
        ctx.fillStyle = blink ? "rgba(95,215,255,.95)" : "rgba(95,215,255,.3)";
        ctx.beginPath(); ctx.arc(x, y, 1.8, 0, 7); ctx.fill();
        break;
      }
      case "den": {       // dark angular hab with flickering red windows
        ctx.save();
        ctx.translate(x, y); ctx.rotate((seed % 628) / 100);
        ctx.fillStyle = "rgba(52,48,66,.95)";
        ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(2, -9); ctx.lineTo(-12, -5); ctx.lineTo(-12, 5); ctx.lineTo(2, 9); ctx.closePath(); ctx.fill();
        const flick = Math.sin(now * 0.005 + seed) * 0.5 + 0.5;
        ctx.fillStyle = `rgba(255,93,115,${(0.35 + flick * 0.45).toFixed(2)})`;
        ctx.fillRect(-7, -2, 2, 2); ctx.fillRect(-2, -1, 2, 2); ctx.fillRect(4, -3, 2, 2);
        ctx.restore();
        break;
      }
    }
    // label under it, the same idiom as the gates but dimmer
    ctx.fillStyle = "rgba(170,195,235,.55)"; ctx.font = this._labelFont(zoom);
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.fillText(poi.name.toUpperCase(), x, y + r + 12);
    ctx.restore();
  },

  // Seeded NPC mining barges orbiting a belt with ore — no state, pure
  // dressing so belts look worked before players arrive (§3, step 2).
  _drawBeltWork(ctx, poi, now) {
    // Once the seam is worked out the crews have moved on — an empty rock
    // should look empty until it rolls over into a fresh one.
    if (window.Mining && Mining.poolLeft(poi) <= 0) return;
    const n = poi.ore.rich >= 1 ? 1 + (poi.seed % 2) : (poi.seed >> 3) % 2;
    if (!n) return;
    const img = this.img(ASSET.ship("hauler"));
    for (let k = 0; k < n; k++) {
      const h = (poi.seed ^ Math.imul(k + 1, 0xC2B2AE35)) >>> 0;
      const a = (h % 628) / 100 + now * 0.00003 * ((h & 1) ? 1 : -1);
      const rr = poi.r * 0.8 + 12 + (h % 9);
      const x = poi.x + Math.cos(a) * rr, y = poi.y + Math.sin(a) * rr;
      ctx.save(); ctx.translate(x, y); ctx.rotate(a + Math.PI / 2); ctx.globalAlpha = 0.9;
      if (img.ok) ctx.drawImage(img, -7, -4, 14, 8);
      else { ctx.fillStyle = "#b9a27a"; ctx.fillRect(-5, -2.5, 10, 5); }
      ctx.restore();
      if (Math.sin(now * 0.004 + h) > 0.3) {   // drill flare, strobing
        const tx = poi.x + Math.cos(a) * poi.r * 0.4, ty = poi.y + Math.sin(a) * poi.r * 0.4;
        ctx.strokeStyle = "rgba(255,200,120,.55)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tx, ty); ctx.stroke();
        ctx.fillStyle = "rgba(255,220,150,.8)"; ctx.fillRect(tx - 1, ty - 1, 2, 2);
      }
    }
  },

  // Your parked mining ops in this system: the hull at its rock with a work
  // pulse and its name — the stationary target, visibly yours. Transits keep
  // to the fleet badge for now (chart markers are a later step).
  // ---- piracy in the scene (docs/SPACE_INTERACTIVITY.md §4/§5.2) ----------
  // The intercept plays out IN the system view, not just as chart dots: the
  // raider holds the hauler at a seeded intercept point out in the system,
  // guns working; the hauler breaks away when the window closes; the police
  // pair arrives, the two circle each other trading fire, and the loser goes
  // up in a fireball. All timing is the derived stage clock (Piracy.robEndAt
  // / duelAt / settleAt), so every watcher sees the same scene and a closed
  // tab misses only the movie. Transits in and out ride the generic voyager
  // pipeline — this pass owns only the engagement itself.
  _drawPiracyScene(ctx, sys, fx, geom) {
    const now = Date.now();
    const ops = (window.Game && Game.state.piracy) || [];
    const wreckMs = (window.POLICECFG || {}).wreckMs || 3000;
    for (const op of ops) {
      if (op.sysId !== sys.id || now < op.resolveAt) continue;
      const robEnd = Piracy.robEndAt(op), duelOn = Piracy.duelAt(op), settle = Piracy.settleAt(op);
      if (now >= settle + wreckMs) continue;
      const pre = Piracy.preview(op);
      const sh = window.Fleet ? Fleet.ship(op.shipUid) : null;
      // The intercept point: seeded from the op, out in the system — the same
      // idiom as survey work-sites, so it never collides with the star.
      const hs = window.Combat ? Combat.seedFrom("prx:" + op.id) : 1;
      const r = geom.R * (0.45 + (hs % 25) / 100);
      const aa = ((hs >> 5) % 628) / 100;
      const ax = geom.cx + Math.cos(aa) * r, ay = geom.cy + Math.sin(aa) * r;
      const shipImg = sh ? this.img(ASSET.shipArt(sh.type, sh.uid)) : null;
      const drawShip = (img, x, y, ang, sz, fallback) => {
        ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
        if (img && img.ok) ctx.drawImage(img, -sz, -sz * 0.6, sz * 2, sz * 1.2);
        else {
          ctx.fillStyle = fallback || "#7b8cff";
          ctx.beginPath(); ctx.moveTo(sz, 0); ctx.lineTo(-sz * 0.7, sz * 0.5); ctx.lineTo(-sz * 0.7, -sz * 0.5);
          ctx.closePath(); ctx.fill();
        }
        ctx.restore();
      };
      const beam = (x1, y1, x2, y2, col) => {
        ctx.save();
        ctx.strokeStyle = col; ctx.lineWidth = 1.6;
        ctx.shadowColor = col; ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.restore();
      };
      const label = (text, x, y, col) => {
        ctx.save();
        ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "center";
        ctx.lineWidth = 3; ctx.strokeStyle = "rgba(4,8,18,.9)";
        ctx.strokeText(text, x, y); ctx.fillStyle = col; ctx.fillText(text, x, y);
        ctx.restore();
      };
      if (now < robEnd) {
        // THE BOARDING: the hauler held at the point, the raider alongside.
        const hImg = this.img(ASSET.ship(op.kind === "freighter" ? "freighter" : "shuttle"));
        drawShip(hImg, ax, ay, aa + Math.PI / 2, 13, "#b8a67f");
        const off = 26, ra = aa + Math.PI / 2;
        const rx = ax + Math.cos(ra + 2.4) * off, ry = ay + Math.sin(ra + 2.4) * off;
        drawShip(shipImg, rx, ry, Math.atan2(ay - ry, ax - rx), 11, "#3fe3ff");
        // guns on a beat for a rob; a toll is menace, a warning shot only;
        // an escort flies formation with nothing to say
        const k = (now % 900) / 900;
        if (op.verb === "rob" && k < 0.35)
          beam(rx, ry, ax + Math.cos(k * 9) * 4, ay + Math.sin(k * 9) * 4, "rgba(255,120,90,.85)");
        else if (op.verb === "toll" && k < 0.10)
          beam(rx, ry, ax + 14, ay - 10, "rgba(255,194,75,.7)");
        label(op.verb === "escort" ? "escorting" : op.verb === "toll" ? "shakedown" : "boarding action",
          ax, ay - 22, "#ffc24b");
        fx.pos["pr:" + op.id] = { x: rx, y: ry };   // the Live View chase cam
      } else if (now < settle && pre.chase) {
        // THE LAW: closing from the nearest gate until duelOn, then the duel —
        // two hulls circling a common point, guns working both ways.
        const turn = (window.POLICECFG || {}).duelTurnMs || 18000;
        const polImg = this.img(ASSET.raceship("voidkin"));
        if (now < duelOn) {
          const f = (now - robEnd) / Math.max(1, duelOn - robEnd);
          const gx = geom.cx + (ax - geom.cx) * -0.2, gy = geom.cy + (ay - geom.cy) * -0.2;
          const px = gx + (ax - gx) * f, py = gy + (ay - gy) * f;
          const pa = Math.atan2(ay - py, ax - px);
          drawShip(polImg, px, py, pa, 11, "#8fb4ff");
          drawShip(polImg, px - Math.cos(pa) * 20 + Math.cos(pa + 1.6) * 12,
            py - Math.sin(pa) * 20 + Math.sin(pa + 1.6) * 12, pa, 9, "#8fb4ff");
          this._copLights(ctx, px, py, 10, now);
          drawShip(shipImg, ax, ay, pa + Math.PI, 11, "#3fe3ff");
          label("patrol closing", ax, ay - 22, "#ff9a4b");
        } else {
          const th = (now % turn) / turn * Math.PI * 2;
          const rad = 30;
          const rx = ax + Math.cos(th) * rad, ry = ay + Math.sin(th) * rad;
          const px = ax + Math.cos(th + Math.PI) * rad, py = ay + Math.sin(th + Math.PI) * rad;
          drawShip(shipImg, rx, ry, th + Math.PI / 2, 11, "#3fe3ff");
          drawShip(polImg, px, py, th + Math.PI / 2 + Math.PI, 11, "#8fb4ff");
          this._copLights(ctx, px, py, 10, now);
          const k = (now % 700) / 700;
          if (k < 0.3) beam(rx, ry, px, py, "rgba(63,227,255,.8)");
          const k2 = ((now + 350) % 700) / 700;
          if (k2 < 0.3) beam(px, py, rx, ry, "rgba(255,120,90,.8)");
          // sparks where fire lands
          if (k < 0.08) { ctx.fillStyle = "rgba(255,216,160,.9)"; ctx.beginPath(); ctx.arc(px, py, 3, 0, 7); ctx.fill(); }
          if (k2 < 0.08) { ctx.fillStyle = "rgba(255,216,160,.9)"; ctx.beginPath(); ctx.arc(rx, ry, 3, 0, 7); ctx.fill(); }
          label(sh ? sh.name + " — under fire" : "under fire", ax, ay - rad - 14, "#ff5d73");
          fx.pos["pr:" + op.id] = { x: rx, y: ry };
        }
      } else if (now >= settle && pre.chase) {
        // THE FIREBALL: whoever lost burns at the point for a beat. The
        // survivor's exit rides the generic voyager pipeline.
        const f = Util.clamp((now - settle) / wreckMs, 0, 1);
        const caught = pre.chase.caught;
        ctx.save();
        ctx.globalAlpha = 1 - f;
        const g = ctx.createRadialGradient(ax, ay, 1, ax, ay, 8 + f * 34);
        g.addColorStop(0, "rgba(255,230,170,.95)");
        g.addColorStop(0.4, "rgba(255,140,60,.8)");
        g.addColorStop(1, "rgba(255,90,40,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ax, ay, 8 + f * 34, 0, 7); ctx.fill();
        ctx.strokeStyle = "rgba(255,122,61,.8)"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(ax, ay, 10 + f * 46, 0, 7); ctx.stroke();
        ctx.restore();
        label(caught ? (sh ? sh.name : "your hull") + " — lost with all hands" : "Senate patrol — destroyed",
          ax, ay - 26, caught ? "#ff5d73" : "#3ad6a0");
      }
    }
  },

  _drawMiningOps(ctx, sys, now, zoom) {
    const wall = Date.now();
    for (const op of Mining.atSystem(sys.id)) {
      if (op.returnAt || wall < op.arriveAt) continue;
      const poi = window.POIs ? POIs.get(op.poiId) : null;
      const sh = Fleet.ship(op.shipUid);
      if (!poi || !sh) continue;
      const h = (poi.seed ^ 0x5bd1) >>> 0;
      const a = (h % 628) / 100 + now * 0.00005;
      const rr = poi.r + 22;
      const x = poi.x + Math.cos(a) * rr, y = poi.y + Math.sin(a) * rr;
      const img = this.img(ASSET.shipArt(sh.type, sh.uid));
      ctx.save(); ctx.translate(x, y); ctx.rotate(a + Math.PI / 2);
      if (img.ok) ctx.drawImage(img, -9, -5.5, 18, 11);
      else { ctx.fillStyle = "#3fe3ff"; ctx.fillRect(-6, -3, 12, 6); }
      ctx.restore();
      const pr = (now % 2600) / 2600;   // work pulse, same idiom as survey sites
      ctx.strokeStyle = `rgba(63,227,255,${((1 - pr) * 0.4).toFixed(2)})`;
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(poi.x, poi.y, 8 + pr * poi.r, 0, 7); ctx.stroke();
      // The guard wing flies a wider, slower ring than the hull it is sitting
      // on — the escort's standing job, visible on the claim (§3.5).
      Mining.guardsOf(op).forEach((g, gi) => {
        const ga = a + Math.PI * (0.7 + gi * 0.8) - now * 0.00002;
        const grr = poi.r + 42 + gi * 9;
        const gx = poi.x + Math.cos(ga) * grr, gy = poi.y + Math.sin(ga) * grr;
        const gim = this.img(ASSET.shipArt(g.type, g.uid));
        ctx.save(); ctx.translate(gx, gy); ctx.rotate(ga + Math.PI / 2);
        if (gim.ok) ctx.drawImage(gim, -8, -5, 16, 10);
        else { ctx.fillStyle = "#9fd45e"; ctx.fillRect(-5, -3, 10, 6); }
        ctx.restore();
      });
      ctx.save();
      const k = 1 / (zoom || 1);
      ctx.font = `600 ${(10 * k).toFixed(1)}px system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      ctx.lineWidth = 3 * k; ctx.strokeStyle = "rgba(4,8,18,.9)";
      ctx.strokeText(sh.name, x, y - 14 * k);
      ctx.fillStyle = "#3fe3ff"; ctx.fillText(sh.name, x, y - 14 * k);
      ctx.restore();
    }
  },

  // Minimap inset (screen space, bottom-right): world box, core outline,
  // star, gates and POI dots, plus the current viewport rectangle. Returns
  // its rect so the scene's click handler can jump the camera.
  // bottomInset: px of the canvas's bottom edge covered by the floating
  // command dock. With the info panel collapsed the scene runs to the foot of
  // the screen, and without this the minimap's corner hides under the dock.
  _drawMinimap(ctx, w, h, cam, g, bottomInset = 0) {
    const s = Util.clamp(Math.round(Math.min(w, h) * 0.24), 90, 150);
    const x = w - s - 10, y = h - s - 10 - Math.max(0, bottomInset), k = s / g.WORLD;
    ctx.save();
    ctx.fillStyle = "rgba(6,10,20,.72)";
    this._roundRect(ctx, x, y, s, s, 6); ctx.fill();
    ctx.strokeStyle = "rgba(120,150,200,.35)"; ctx.lineWidth = 1; ctx.stroke();
    this._roundRect(ctx, x, y, s, s, 6); ctx.clip();
    const off = ((g.WORLD - g.CORE) / 2) * k;             // core box, centred
    ctx.strokeStyle = "rgba(120,150,200,.25)";
    ctx.strokeRect(x + off, y + off, g.CORE * k, g.CORE * k);
    ctx.fillStyle = "#ffd86a";
    ctx.beginPath(); ctx.arc(x + g.wcx * k, y + g.wcy * k, 2, 0, 7); ctx.fill();
    ctx.fillStyle = "rgba(150,210,255,.9)";
    for (const gp of g.gates) ctx.fillRect(x + gp.x * k - 1, y + gp.y * k - 1, 2, 2);
    for (const p of g.pois) {
      const def = (window.POI_TYPES || {})[p.type];
      ctx.fillStyle = (def && def.color) || "#9aa4b8";
      ctx.fillRect(x + p.x * k - 1.2, y + p.y * k - 1.2, 2.4, 2.4);
    }
    ctx.strokeStyle = "rgba(63,227,255,.8)";              // current viewport
    ctx.strokeRect(x + (-cam.x / cam.zoom) * k, y + (-cam.y / cam.zoom) * k,
      (w / cam.zoom) * k, (h / cam.zoom) * k);
    ctx.restore();
    return { x, y, s, scale: k };
  },

  // POI info card — reuses the planet-tip styling; canvas-relative click
  // coordinates are mapped into the system-view box the tip is absolute in.
  // Belts grow a mining block (§3): the seam, your op, and dispatch/recall
  // controls — so the whole mining loop lives on the rock itself.
  _showPoiTip(poi, mx, my) {
    const tip = this.refs.poiTip;
    if (!tip) return;
    this._poiTipAt = { mx, my };
    const def = POI_TYPES[poi.type] || {};
    let html = `<b>${poi.name}</b>
      <div class="pt-sub"><span style="color:${def.color || "var(--ink-dim)"}">●</span> ${def.label || poi.type} · deep-space ring</div>
      <div class="pt-sub">${def.blurb || ""}</div>`;
    // Wrecks and scrap get hauled away; geography and dens stay put.
    if (def.churn && !poi.ore && window.Mining) {
      html += `<div class="pt-sub tip-dim">Salvage crews clear this in ~${Util.duration(Mining.rollsIn(poi))}.</div>`;
    }
    if (poi.ore && window.Mining && window.Fleet) html += this._poiOreBlock(poi);
    tip.innerHTML = html;
    tip.style.pointerEvents = "auto";   // the belt card has buttons; planet-tip CSS says none
    tip.style.display = "block";        // lay it out first — a belt card's height varies a lot
    const cr = this.refs.canvas.getBoundingClientRect();
    const vr = this.refs.systemView.getBoundingClientRect();
    const tw = tip.offsetWidth || 240, th = tip.offsetHeight || 90;
    tip.style.left = Math.max(6, Math.min(cr.left - vr.left + mx + 14, vr.width - tw - 6)) + "px";
    tip.style.top = Math.max(6, Math.min(cr.top - vr.top + my + 14, vr.height - th - 6)) + "px";
    this._wirePoiTip(poi);
  },

  _poiOreBlock(poi) {
    const comm = COMMODITIES.find(c => c.id === poi.ore.commId);
    const commName = comm ? comm.name : poi.ore.commId;
    const left = Mining.poolLeft(poi), npc = Mining.npcTaken(poi);
    const rollIn = Mining.rollsIn(poi);
    const richLbl = poi.ore.rich >= 1.3 ? "prime" : poi.ore.rich >= 1.0 ? "rich" : poi.ore.rich >= 0.8 ? "fair" : "lean";
    let html = `<div class="pt-sub">⛏ <b>${commName}</b> seam · ${richLbl} (${poi.ore.rich}×) · <b>${left}</b>/${poi.ore.pool} left`
      + (npc > 0 ? ` <span class="tip-dim">(crews took ${npc})</span>` : "") + `</div>`
      + `<div class="pt-sub">${left <= 0
        ? `Worked out — the crews move on in ${Util.duration(rollIn)}, and a fresh rock takes the slot.`
        : `NPC crews are working it out — nothing left in ~${Util.duration(rollIn)}.`}</div>`;
    html += this._poiThreatLine(poi);
    const op = Mining.opAt(poi.id);
    if (op) {
      const sh = Fleet.ship(op.shipUid);
      const now = Date.now();
      const stat = op.returnAt ? `returning ~${Util.duration(Math.max(0, op.returnAt - now))}`
        : now < op.arriveAt ? `en route ~${Util.duration(op.arriveAt - now)}`
          : `mining · ${op.mined || 0} banked`;
      html += `<div class="pt-sub">🛰 ${Util.esc(sh ? sh.name : "Your miner")} — ${stat} `
        + (op.returnAt ? "" : `<button class="btn btn-mini" id="poi-recall">Recall</button>`) + `</div>`;
      const guards = Mining.guardsOf(op);
      if (guards.length) {
        html += `<div class="pt-sub">🛡 Guard: ${guards.map(g => Util.esc(g.name)).join(", ")}`
          + ` <span class="tip-dim">— repels ${Math.round(Mining.repel(op.shipUid, Mining.guardUids(op)) * 100)}% of raids</span></div>`;
      }
      if (op.raids) {
        html += `<div class="pt-sub down">☠ ${op.raids} raid${op.raids === 1 ? "" : "s"}`
          + (op.lost ? ` · ${op.lost} ore taken` : " · all driven off") + `</div>`;
      }
      return html;
    }
    if (!Mining.serverOwned() && window.Economy && !Economy.softIncomeLocal())
      return html + `<div class="pt-sub">Mining settles on the local ledger for now — signed-in dispatch needs <code>docs/sql/mining_rpcs.sql</code> applied to this project.</div>`;
    if (left <= 0) return html;
    const miners = Fleet.idle().filter(sh => (Fleet.shipDef(sh.type) || {}).cls === "miner" && !sh.mercenary);
    if (!miners.length)
      return html + `<div class="pt-sub">No idle miner — the Bazaar shipyard stocks Prospector-class hulls.</div>`;
    const ships = miners.map(sh => `<option value="${sh.uid}">${Util.esc(sh.name)} · ⛏ ${Fleet.stats(sh).mine.toFixed(1)}</option>`).join("");
    const rigs = Mining.rigsFor(poi).map(ex => `<option value="${ex.uid}">${Util.esc(ex.name)}</option>`).join("");
    // Escort hulls can sit the claim (§3.5). Native multi-select — the cap is
    // enforced in Mining.canGuard, so nothing here has to police it.
    const escorts = Mining.guardCandidates();
    const gmax = (window.RAIDCFG || {}).guardMax || 0;
    const guardPick = escorts.length && gmax
      ? `<div class="pt-sub" style="margin-top:6px">🛡 Guard the claim <span class="tip-dim">(pick up to ${gmax}; ctrl-click for two)</span></div>
         <select id="poi-mn-guard" multiple size="${Math.min(3, escorts.length)}">`
        + escorts.map(g => `<option value="${g.uid}">${Util.esc(g.name)} · ✦ ${Fleet.stats(g).firepower}</option>`).join("")
        + `</select>`
      : `<div class="pt-sub tip-dim" style="margin-top:6px">🛡 No idle escort to guard the claim — a parked miner defends itself badly.</div>`;
    return html + guardPick + `<div class="st-hall-list" style="margin-top:6px">
        <select id="poi-mn-ship">${ships}</select>
        <select id="poi-mn-rig"><option value="">No rig</option>${rigs}</select>
        <button class="btn btn-mini btn-go" id="poi-mn-go">Dispatch</button>
      </div>
      <div class="pt-sub" id="poi-mn-est">${this._poiEstText(poi, miners[0].uid, null)}</div>`;
  },

  // Corsair pressure on this rock, straight off Raiders.claimChance — the same
  // number the resolver rolls against, so the card never flatters the odds.
  _poiThreatLine(poi) {
    if (!window.Raiders) return "";
    const p = Raiders.claimChance(poi);
    if (!(p > 0)) return "";
    const band = Raiders.band(p);
    const den = Raiders.hasDen(poi.sysId) ? " · a den works this system" : "";
    return `<div class="pt-sub">☠ Corsair pressure <b style="color:${band.color}">${band.label}</b>`
      + ` <span class="tip-dim">— ~${Math.round(p * 100)}% per batch${den}</span></div>`;
  },

  // A specialized rig can lift the take by half again, so quoting the
  // bare-hull number while a rig is picked would just be wrong. _wirePoiTip
  // re-runs this on every change of either picker.
  _poiEstText(poi, shipUid, rigUid, guardUids = []) {
    const comm = COMMODITIES.find(c => c.id === poi.ore.commId);
    const guard = window.Raiders && shipUid
      ? ` · 🛡 repels ${Math.round(Mining.repel(shipUid, guardUids) * 100)}% of raids` : "";
    return `≈${Mining.batchQty(poi, shipUid, rigUid)} ${comm ? comm.name : poi.ore.commId}`
      + ` / ${Util.duration(MININGCFG.cycleMs)} · untaxed · lands at this system's bay${guard}`;
  },

  _wirePoiTip(poi) {
    const tip = this.refs.poiTip;
    const refresh = () => {
      window.Game.requestSave();
      const at = this._poiTipAt || { mx: 20, my: 20 };
      this._showPoiTip(poi, at.mx, at.my);
      if (UI.page === "fleet") UI.renderFleet();
    };
    const shipSel = tip.querySelector("#poi-mn-ship"), rigSel = tip.querySelector("#poi-mn-rig");
    const guardSel = tip.querySelector("#poi-mn-guard");
    const picked = () => guardSel ? [...guardSel.selectedOptions].map(o => o.value) : [];
    const est = tip.querySelector("#poi-mn-est");
    if (est && shipSel) {
      const sync = () => { est.textContent = this._poiEstText(poi, shipSel.value, (rigSel && rigSel.value) || null, picked()); };
      shipSel.onchange = sync;
      if (rigSel) rigSel.onchange = sync;
      if (guardSel) guardSel.onchange = sync;
      sync();
    }
    const go = tip.querySelector("#poi-mn-go");
    if (go) go.onclick = () => {
      const shipU = (tip.querySelector("#poi-mn-ship") || {}).value;
      const rigU = (tip.querySelector("#poi-mn-rig") || {}).value || null;
      const r = Mining.start(poi.id, shipU, rigU, picked());
      if (!r.ok) return UI.toast(r.msg, "warn");
      const wing = Mining.guardsOf(r.op).length;
      UI.toast(`Miner dispatched to ${poi.name}${wing ? ` with ${wing} escort${wing === 1 ? "" : "s"}` : ""}`
        + ` — first ore in ~${Util.duration(Math.max(0, r.op.nextAt - Date.now()))}.`, "good");
      refresh();
    };
    const rec = tip.querySelector("#poi-recall");
    if (rec) rec.onclick = () => {
      const op = Mining.opAt(poi.id);
      if (!op) return;
      const r = Mining.recall(op.id);
      if (!r.ok) return UI.toast(r.msg, "warn");
      UI.toast(`Recalled — home in ~${Util.duration(op.travelMs)}.`, "info");
      refresh();
    };
  },

  // ---- NPC hauler intercept card (docs/SPACE_INTERACTIVITY.md §4, step 4) --
  // Nearest NPC hauler to a world point, via the positions _drawVoyagers
  // recorded this frame (fx.pos) — no re-simulation, and own fleets don't hit.
  _npcPosAt(fx, wx, wy, r) {
    if (!window.Piracy || !fx || !fx.pos) return null;
    let best = null, bd = r;
    for (const id in fx.pos) {
      if (id.indexOf("npc:") !== 0) continue;
      const p = fx.pos[id];
      const d = Math.hypot(p.x - wx, p.y - wy);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  },
  _npcFlightAt(sysId, fx, wx, wy, r) {
    const id = this._npcPosAt(fx, wx, wy, r);
    if (!id || !window.Voyages) return null;
    return Voyages.inSystem(sysId).find(v => v.id === id) || null;
  },

  // Same shell as the POI card: the contact, its run, and the verbs on it —
  // rob / toll / escort, quoted with the odds and the crime you'd carry.
  _showFlightTip(v, sysId, mx, my) {
    const tip = this.refs.poiTip;
    if (!tip || !window.Piracy) return;
    this._poiTipAt = { mx, my };
    const from = Galaxy.get(Piracy.fromSysOf(v)), to = Galaxy.get(Piracy.toSysOf(v));
    // A patrol pair is a contact with nothing on offer — the card says who
    // they are and what they answer to, and pointedly lists no verbs.
    if (v.police) {
      tip.innerHTML = `<b>${Util.esc(v.name)}</b>
        <div class="pt-sub">🚨 Senate patrol · always in pairs · ${from ? from.name : "?"} → ${to ? to.name : "?"}</div>
        <div class="pt-sub tip-dim">Carrying nothing you can take — and hoping you try. Patrols answer robberies worked in their sector.</div>`;
      this._placeTip(tip, mx, my);
      return;
    }
    const kindLbl = v.kind === "freighter" ? "NPC freighter" : v.relief ? "relief trader" : "NPC trader";
    const docksIn = Util.duration(Math.max(0, Piracy.landsAt(v) - Date.now()));
    let html = `<b>${Util.esc(v.name)}</b>
      <div class="pt-sub">🚚 ${kindLbl} · ${from ? from.name : "?"} → ${to ? to.name : "?"} · docks in ~${docksIn}</div>`;
    if (v.raided) {
      html += `<div class="pt-sub tip-dim">Hold empty — this run was already robbed.</div>`;
    } else {
      const names = v.manifest.map(id => (COMMODITIES.find(c => c.id === id) || { name: id }).name);
      html += `<div class="pt-sub">📦 Manifest: ${names.join(", ") || "—"}</div>`;
    }
    if (window.Security) {
      const band = Security.bandOf(sysId);
      html += `<div class="pt-sub">⚖ Law here: <b style="color:${band.color}">${band.label}</b></div>`;
    }
    html += this._flightVerbBlock(v, sysId);
    tip.innerHTML = html;
    this._placeTip(tip, mx, my);
    this._wireFlightTip(v, sysId);
  },

  // Shared card layout: lay it out first (heights vary), then clamp into view.
  _placeTip(tip, mx, my) {
    tip.style.pointerEvents = "auto";
    tip.style.display = "block";
    const cr = this.refs.canvas.getBoundingClientRect();
    const vr = this.refs.systemView.getBoundingClientRect();
    const tw = tip.offsetWidth || 240, th = tip.offsetHeight || 90;
    tip.style.left = Math.max(6, Math.min(cr.left - vr.left + mx + 14, vr.width - tw - 6)) + "px";
    tip.style.top = Math.max(6, Math.min(cr.top - vr.top + my + 14, vr.height - th - 6)) + "px";
  },

  _flightVerbBlock(v, sysId) {
    const op = Piracy.opOnFlight(v.id, v.loop);
    if (op) {
      const now = Date.now();
      const stat = !op.resolved ? `closing in ~${Util.duration(Math.max(0, op.resolveAt - now))}`
        : `returning ~${Util.duration(Math.max(0, op.returnAt - now))}`;
      const sh = Fleet.ship(op.shipUid);
      return `<div class="pt-sub">🏴 ${Util.esc(sh ? sh.name : "Your hull")} — ${op.verb} · ${stat}</div>`;
    }
    const verbs = Piracy.verbs(v, sysId);
    if (!verbs.length)
      return `<div class="pt-sub tip-dim">${v.raided ? "Nothing left to take."
        : "The Senate writ runs here — the verb is not offered."}</div>`;
    if (!Piracy.canSettle())
      return `<div class="pt-sub">Piracy settles on the local ledger for now — signed-in dispatch waits on a piracy SQL surface.</div>`;
    const hulls = Fleet.idle().filter(sh => !sh.mercenary && Fleet.stats(sh).firepower >= 1)
      .sort((a, b) => Fleet.stats(b).firepower - Fleet.stats(a).firepower);
    if (!hulls.length) return `<div class="pt-sub">No idle armed hull — guns make the argument out here.</div>`;
    const ships = hulls.map(sh => `<option value="${sh.uid}">${Util.esc(sh.name)} · ✦ ${Fleet.stats(sh).firepower}</option>`).join("");
    const label = { rob: "Rob", toll: "Toll", escort: "Escort" };
    const btns = verbs.map(vb =>
      `<button class="btn btn-mini${vb === "escort" ? " btn-go" : ""}" data-verb="${vb}">${label[vb]}</button>`).join(" ");
    return `<div class="st-hall-list" style="margin-top:6px"><select id="poi-pr-ship">${ships}</select> ${btns}</div>
      <div class="pt-sub" id="poi-pr-est">${this._flightEstText(v, sysId, hulls[0].uid)}</div>`;
  },

  // The quote, per verb, for the picked hull — the same numbers the resolver
  // stamps on the op, so the card never flatters the odds.
  _flightEstText(v, sysId, shipUid) {
    const g = (window.CRIMECFG || {}).gain || {}, parts = [];
    for (const vb of Piracy.verbs(v, sysId)) {
      if (vb === "escort") {
        const r = (window.PIRACYCFG || {}).escortPayFrac || [0.1, 0.16];
        parts.push(`escort ≈${Util.credits(Piracy.manifestValue(v) * (r[0] + r[1]) / 2)}c · lawful`);
      } else {
        parts.push(`${vb} ${Math.round(Piracy.chance(shipUid, v, sysId, vb) * 100)}% · +${vb === "rob" ? g.piracy : g.toll} crime`);
      }
    }
    // The other half of the quote (police.js): whether the law is on station
    // HERE, right now. The response is certain when a patrol is present —
    // the risk you can read is whether one is, and how many.
    if (window.Police && window.Security && Piracy.verbs(v, sysId).includes("rob")) {
      const n = Police.patrolsIn(sysId, Security.score(sysId), Date.now());
      parts.push(n ? `🚨 ${n} patrol${n === 1 ? "" : "s"} on station — the law WILL answer`
        : "🌑 no patrols on station");
    }
    return parts.join(" · ");
  },

  _wireFlightTip(v, sysId) {
    const tip = this.refs.poiTip;
    const refresh = () => {
      window.Game.requestSave();
      const at = this._poiTipAt || { mx: 20, my: 20 };
      this._showFlightTip(v, sysId, at.mx, at.my);
      if (UI.page === "fleet") UI.renderFleet();
    };
    const shipSel = tip.querySelector("#poi-pr-ship");
    const est = tip.querySelector("#poi-pr-est");
    if (shipSel && est) shipSel.onchange = () => { est.textContent = this._flightEstText(v, sysId, shipSel.value); };
    for (const b of tip.querySelectorAll("[data-verb]")) b.onclick = () => {
      const r = Piracy.start(v, b.dataset.verb, shipSel ? shipSel.value : null, sysId);
      if (!r.ok) return UI.toast(r.msg, "warn");
      const what = { rob: "Intercept", toll: "Shakedown", escort: "Escort" }[r.op.verb];
      UI.toast(`${what} dispatched — on ${v.name} in ~${Util.duration(r.op.travelMs)}.`,
        r.op.verb === "escort" ? "good" : "info");
      refresh();
    };
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
    if (this.open && !this.refs.galaxyView.classList.contains("hidden")) { this._resumeStars = true; this.stopStars(); this._stopVoyageLayer(); }
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
      if (this.open && !this.refs.galaxyView.classList.contains("hidden")) { this.startStars(); this._startVoyageLayer(); }
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
