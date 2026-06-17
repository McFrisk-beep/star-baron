/* planetview.js — the planet popup. Opened from the star-map system view (hover
   a planet for a quick-view, click to open). Shows a big procedural, animated
   planet (atmosphere glow, drifting satellites, a pixel "space-highway" of
   civilian traffic, lava shimmer for molten worlds), an About tab with unique
   per-planet lore, and an Industries tab.

   The lore is deterministic from the planet name, so each world reads the same
   every visit but differs from its neighbours. Pure canvas — no art to load. */

// base / light / dark tints per planet type
const PLANET_PAL = {
  rocky:     ["#8a7a66", "#b8a585", "#46392c"],
  terran:    ["#3a8f5a", "#7fd09a", "#1d4a33"],
  ocean:     ["#2a6cb0", "#62a6e6", "#123763"],
  ice:       ["#a9d2ea", "#eaf6ff", "#6f9bbb"],
  lava:      ["#b5371c", "#ff8a3a", "#4f1408"],
  gas_giant: ["#c9a36a", "#ecd2a0", "#7a5a30"],
  barren:    ["#9a9488", "#c6c1b4", "#545047"],
  ringed:    ["#b89a6a", "#e8d3a0", "#6f5a32"],
  toxic:     ["#8fae3a", "#c8e26c", "#46571c"],
};
const PLANET_LORE_TYPE = {
  rocky:     ["{P} is a cratered rock world, its bedrock cracked by aeons of micrometeor rain.", "{P} is a dusty, tectonically dead sphere mapped centuries ago by {RACE} prospectors."],
  terran:    ["{P} is a rare temperate world, blue-green and breathable, prized across {SEC}.", "{P} is a garden world whose mild seasons drew {RACE} settlers generations back."],
  ocean:     ["{P} is a drowned world of endless swell, dotted with floating {RACE} platforms.", "{P} is one vast ocean, its trade run entirely from anchored sea-rigs."],
  ice:       ["{P} is a frozen world of blue glaciers and creaking ice plains.", "{P} is a rime-locked planet where {RACE} crews carve tunnels through kilometre-thick ice."],
  lava:      ["{P} is a molten world, its crust forever splitting into rivers of fire.", "{P} glows from orbit — a volcanic forge of a planet that never cools."],
  gas_giant: ["{P} is a banded gas giant, skimmed from cloud-cities riding its upper winds.", "{P} is a storm-wracked giant whose squalls swallow whole skimmer fleets."],
  barren:    ["{P} is a barren, airless rock — useful mostly for what lies beneath it.", "{P} is a sun-bleached husk of a world, valued only for its ores."],
  ringed:    ["{P} wears a brilliant ring of ice and shattered moonlet, a wonder of {SEC}.", "{P} is a ringed jewel whose halo lights its night side silver."],
  toxic:     ["{P} is a toxic world wrapped in acid haze; everyone topside lives sealed.", "{P} is a poison-shrouded planet where a breath of raw air is a death sentence."],
};
const PLANET_LORE_SIG = [
  "Its economy turns on {IND.l}, and {COMM} flows out by the freighter-load.",
  "Locals make their living from {IND.l} — {COMM} is the world's lifeblood.",
  "The {IND.l} trade keeps it on the charts; it ships {COMM} and hungers for {IMP}.",
  "It runs hot on {IND.l}, exporting {COMM} while importing every gram of {IMP} it can get.",
];
const PLANET_LORE_FEAT = {
  lava:      ["From orbit the nightside pulses red and orange as fresh magma seams open and crust over."],
  ice:       ["Auroras sheet across its poles, and its rings of frost glitter in the long dark."],
  gas_giant: ["Lightning the size of continents flickers in its cloud bands."],
  ringed:    ["Shepherd moons carve crisp gaps in its glittering ring."],
  ocean:     ["Bioluminescent blooms streak its night oceans in slow, turning spirals."],
  terran:    ["Weather systems swirl over green continents; it looks, from orbit, almost alive."],
  toxic:     ["Sickly green storm-cells churn endlessly beneath its smog."],
  _default:  ["A thin halo of dust and traffic hazes the line where its atmosphere meets the black."],
};
const PLANET_LORE_QUIP = [
  "The {RACE} who hold it have a saying: nothing here is free, least of all the air.",
  "Spacers reckon a stopover here is good for the cargo and bad for the liver.",
  "Ask any {RACE} dockhand and they'll swear it's the finest port in {SEC} — for a price.",
  "It keeps a low profile on the newswire, which suits the {RACE} just fine.",
];

const PlanetView = {
  cur: null, tab: "about", raf: null, _onResize: null, _refs: null,
  s() { return window.Game.state; },

  refs() {
    if (this._refs) return this._refs;
    const $ = id => document.getElementById(id);
    this._refs = { modal: $("planet-modal"), title: $("pm-title"), subtitle: $("pm-subtitle"),
      canvas: $("pm-canvas"), tabbody: $("pm-tabbody"), tabs: $("pm-tabs"), close: $("pm-close") };
    return this._refs;
  },
  init() {
    const r = this.refs(); if (!r.modal) return;
    r.close.onclick = () => this.close();
    r.tabs.onclick = e => { const b = e.target.closest("[data-pm]"); if (b) this.showTab(b.dataset.pm); };
    r.modal.addEventListener("click", e => { if (e.target === r.modal) this.close(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !r.modal.classList.contains("hidden")) this.close(); });
  },

  open(sys, idx) {
    const planet = sys && sys.planets[idx]; if (!planet) return;
    this.cur = { sys, idx, planet }; this.tab = "about";
    const r = this.refs();
    const sec = Galaxy.sector(sys.sectorId), race = RACES[sys.race];
    r.title.textContent = planet.name;
    r.subtitle.textContent = `${planet.type.replace("_", " ")} · ${sec ? sec.name : ""} · ${race ? race.name : ""} space`;
    this.showTab("about");
    r.modal.classList.remove("hidden");
    this.startScene(planet);
  },
  close() {
    this.stopScene();
    const r = this.refs(); if (r.modal) r.modal.classList.add("hidden");
    const had = this.cur; this.cur = null;
    if (had && window.StarMap) StarMap.refreshInfo();   // reflect any build/close back in the system list
  },

  showTab(name) {
    if (!this.cur) return;
    this.tab = name;
    for (const b of this.refs().tabs.querySelectorAll(".subtab")) b.classList.toggle("active", b.dataset.pm === name);
    if (name === "about") this.renderAbout(); else this.renderIndustries();
  },

  renderAbout() {
    const { sys, planet } = this.cur;
    const facId = Industries.planetFaction(sys, planet);
    const fac = facId ? FACTIONS[facId] : null;
    this.refs().tabbody.innerHTML =
      `<p class="pm-lore">${this.flavor(sys, planet)}</p>
       <div class="pm-facts">
         <div><label>Type</label><span>${planet.type.replace("_", " ")}</span></div>
         <div><label>Primary trade</label><span>${planet.industry}</span></div>
         <div><label>Imports</label><span>${planet.importing}</span></div>
         <div><label>Controlled by</label><span style="color:${fac ? fac.color : "var(--accent2)"}">${fac ? fac.name : "Navos (neutral)"}</span></div>
       </div>`;
  },

  renderIndustries() {
    const { sys, idx, planet } = this.cur;
    const facId = Industries.planetFaction(sys, planet);
    const facName = facId ? FACTIONS[facId].name : "Navos (neutral)";
    const facColor = facId ? FACTIONS[facId].color : "var(--accent2)";
    const ind = Industries.at(sys.id, idx);
    const r = this.refs();
    let body;
    if (!ind) {                                   // no permit yet
      const chk = Industries.canBuild(sys, idx), cost = Industries.permitCost(sys, planet), rate = Industries.taxRate(sys, planet);
      body = `<p class="muted-note">Buy a permit to operate on <b>${planet.name}</b>, then install an extractor (from the <b>Bazaar → Extractors</b>) to mine or manufacture into your tradeable stock. Owner: <span style="color:${facColor}">${facName}</span> · tax ${(rate * 100).toFixed(0)}%.</p>` +
        (chk.ok
          ? `<div class="settings-actions"><button class="btn btn-go" data-pm-build="${sys.id}:${idx}">${cost > 0 ? `Buy permit — ${Util.credits(cost)}c` : "Claim permit — free (neutral)"}</button></div>`
          : `<p class="down">🔒 ${chk.msg}</p>`);
    } else if (!ind.extractorUid) {               // permit held, no extractor
      const avail = Extractors.unequipped();
      if (!avail.length) {
        body = `<p class="muted-note">Permit held on <b>${planet.name}</b>. You own no spare extractors — buy one in the <b>Bazaar → Extractors</b>, then install it here.</p>`;
      } else {
        body = `<p class="muted-note">Permit held on <b>${planet.name}</b>. Install an extractor and pick what to produce — yield scales with this planet's suitability for that good.</p>
          <div class="rt-form">
            <label>Extractor <select id="pm-ex">${avail.map(e => `<option value="${e.uid}">${e.name}</option>`).join("")}</select></label>
            <label>Produce <select id="pm-target"></select></label>
          </div>
          <p class="muted-note" id="pm-exdesc"></p><div class="mm-calc" id="pm-calc"></div>`;
      }
      body += `<div class="settings-actions">${avail.length ? `<button class="btn btn-go" id="pm-install">Install</button>` : ""}<button class="btn btn-danger" data-pm-demolish="${ind.id}">Give up permit</button></div>`;
    } else {                                       // extractor installed
      const ex = Extractors.get(ind.extractorUid), st = Industries.status(ind), b = Industries.batch(ind);
      const comm = COMMODITIES.find(c => c.id === ind.commodity), name = comm ? comm.name : ind.commodity;
      const halted = st === "struck" || st === "disrupted";
      const next = halted ? `<span class="down">halted</span>` : Util.duration(Math.max(0, ind.nextAt - Date.now()));
      const warn = st === "at risk" ? `<p class="down">⚠ Standing with ${facName} is collapsing — at ${INDUSTRYCFG.destroyRep} they seize the works.</p>` : "";
      const fitted = Extractors.componentsOf(ex), slots = Extractors.componentSlots(), avail = Components.unequipped();
      const chips = fitted.map(c => `<span class="acc-chip" style="border-color:${Components.rarity(c.rarity).color}">${c.name} <span class="muted-note">${Components.describe(c)}</span> <button class="x" data-pm-detach="${ex.uid}:${c.uid}">✕</button></span>`).join("");
      let compUI = `<div class="ind-foot">Components ${fitted.length}/${slots}</div><div class="acc-row">${chips || `<span class="muted-note">none fitted</span>`}</div>`;
      if (fitted.length < slots && avail.length) compUI += `<div class="rt-form"><label>Fit <select id="pm-comp">${avail.map(c => `<option value="${c.uid}">${c.name} — ${Components.describe(c)}</option>`).join("")}</select></label></div><div class="settings-actions"><button class="btn" id="pm-attach">Fit component</button></div>`;
      else if (fitted.length < slots) compUI += `<p class="muted-note">Buy components in the <b>Bazaar → Extractors</b> to boost this extractor.</p>`;
      body = `<div class="industry"><div class="ind-head"><b>${name} works</b><span class="ind-stat ind-${st.replace(/ /g, "-")}">${st}</span></div>
        <div class="ind-foot">${ex ? ex.name : "extractor"} · ≈ <b>${b.net}</b> ${name} every ${Util.duration(b.cycleMs)} <span class="muted-note">(gross ${b.gross} − ${(b.rate * 100).toFixed(0)}% tax)</span> · next ${next}</div>
        <div class="ind-foot">suitability <b>${b.suit.toFixed(2)}×</b> · owner <span style="color:${facColor}">${facName}</span></div></div>
        ${warn}${compUI}
        <div class="settings-actions"><button class="btn" data-pm-remove="${ind.id}">Remove extractor</button><button class="btn btn-danger" data-pm-demolish="${ind.id}">Give up permit</button></div>`;
    }
    r.tabbody.innerHTML = body;

    const bbtn = r.tabbody.querySelector("[data-pm-build]");
    if (bbtn) bbtn.onclick = () => {
      const [sid, i] = bbtn.dataset.pmBuild.split(":");
      const res = Industries.build(sid, +i);
      if (!res.ok) return UI.toast(res.msg, "warn");
      UI.toast(res.cost > 0 ? `Permit bought — ${Util.credits(res.cost)}c.` : "Permit claimed.", "good"); UI.flashCredits();
      window.Game.requestSave(); UI.updateHeader(); this.showTab("industries");
    };
    const exSel = r.tabbody.querySelector("#pm-ex"), tSel = r.tabbody.querySelector("#pm-target");
    if (exSel && tSel) {
      const fill = () => {
        const ex = Extractors.get(exSel.value);
        tSel.innerHTML = Extractors.targets(ex).map(cid => `<option value="${cid}">${(COMMODITIES.find(c => c.id === cid) || {}).name || cid}</option>`).join("");
        const d = r.tabbody.querySelector("#pm-exdesc"); if (d) d.textContent = ex ? Extractors.describe(ex) : "";
        this._pmCalc();
      };
      exSel.onchange = fill; tSel.onchange = () => this._pmCalc(); fill();
    }
    const inst = r.tabbody.querySelector("#pm-install");
    if (inst) inst.onclick = () => {
      const res = Industries.installExtractor(ind.id, exSel.value, tSel.value);
      if (!res.ok) return UI.toast(res.msg, "warn");
      UI.toast("Extractor installed — production online.", "good"); window.Game.requestSave(); UI.updateHeader(); this.showTab("industries");
    };
    const rem = r.tabbody.querySelector("[data-pm-remove]");
    if (rem) rem.onclick = () => { Industries.removeExtractor(rem.dataset.pmRemove); UI.toast("Extractor moved to storage.", "info"); window.Game.requestSave(); this.showTab("industries"); };
    const att = r.tabbody.querySelector("#pm-attach");
    if (att) att.onclick = () => {
      const sel = r.tabbody.querySelector("#pm-comp"); if (!sel) return;
      const res = Extractors.attachComponent(ind.extractorUid, sel.value);
      if (!res.ok) return UI.toast(res.msg, "warn");
      UI.toast("Component fitted.", "good"); window.Game.requestSave(); UI.updateHeader(); this.showTab("industries");
    };
    r.tabbody.querySelectorAll("[data-pm-detach]").forEach(b => b.onclick = () => {
      const [exu, cu] = b.dataset.pmDetach.split(":");
      Extractors.detachComponent(exu, cu); UI.toast("Component removed to storage.", "info");
      window.Game.requestSave(); UI.updateHeader(); this.showTab("industries");
    });
    const d = r.tabbody.querySelector("[data-pm-demolish]");
    if (d) d.onclick = () => { Industries.demolish(d.dataset.pmDemolish); UI.toast("Permit given up.", "info"); window.Game.requestSave(); UI.updateHeader(); this.showTab("industries"); };
  },
  _pmCalc() {
    const { sys, planet } = this.cur, r = this.refs();
    const exSel = r.tabbody.querySelector("#pm-ex"), tSel = r.tabbody.querySelector("#pm-target"), calc = r.tabbody.querySelector("#pm-calc");
    if (!exSel || !tSel || !calc) return;
    const ex = Extractors.get(exSel.value), commId = tSel.value;
    const suit = Industries.suitabilityFor(planet.type, commId), rate = Industries.taxRate(sys, planet);
    const gross = Math.round(INDUSTRYCFG.baseYield * suit * Extractors.yieldMult(ex)), net = gross > 0 ? Math.max(1, gross - Math.ceil(gross * rate)) : 0;
    const cn = (COMMODITIES.find(c => c.id === commId) || {}).name || commId;
    calc.innerHTML = `${cn}: suitability <b>${suit.toFixed(2)}×</b> · ≈ <b class="${net > 0 ? "up" : "down"}">${net}</b>/12h after ${(rate * 100).toFixed(0)}% tax`;
  },

  // ---- deterministic per-planet lore -------------------------------------
  flavor(sys, planet) {
    let a = 2166136261; for (let i = 0; i < planet.name.length; i++) { a ^= planet.name.charCodeAt(i); a = Math.imul(a, 16777619); }
    a >>>= 0;
    const rng = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = arr => arr[Math.floor(rng() * arr.length)];
    const sec = Galaxy.sector(sys.sectorId), race = RACES[sys.race];
    const comm = (COMMODITIES.find(c => c.id === planet.commodity) || {}).name || planet.cat;
    const parts = [pick(PLANET_LORE_TYPE[planet.type] || PLANET_LORE_TYPE.rocky), pick(PLANET_LORE_SIG),
      pick(PLANET_LORE_FEAT[planet.type] || PLANET_LORE_FEAT._default), pick(PLANET_LORE_QUIP)];
    const fill = t => t.replace(/\{P\}/g, planet.name).replace(/\{RACE\}/g, race ? race.name : "settlers")
      .replace(/\{SEC\}/g, sec ? sec.name : "the frontier").replace(/\{IND\.l\}/g, (planet.industry || "trade").toLowerCase())
      .replace(/\{IND\}/g, planet.industry).replace(/\{COMM\}/g, comm).replace(/\{IMP\}/g, planet.importing);
    return parts.map(fill).join(" ");
  },

  // ---- canvas helpers -----------------------------------------------------
  _rgb(hex) { hex = hex.replace("#", ""); return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]; },
  _hexA(hex, al) { const c = this._rgb(hex); return `rgba(${c[0]},${c[1]},${c[2]},${al})`; },
  _mix(h1, h2, t) { const a = this._rgb(h1), b = this._rgb(h2); return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`; },

  // ---- animated scene -----------------------------------------------------
  startScene(planet) {
    this.stopScene();
    const canvas = this.refs().canvas;
    if (!canvas || !canvas.getContext || !canvas.getContext("2d")) return;
    const ctx = canvas.getContext("2d");
    const reduced = this.s().settings.reduced;
    const resize = () => { const r = canvas.parentElement.getBoundingClientRect(); canvas.width = Math.max(260, r.width); canvas.height = Math.max(220, r.height); };
    resize(); this._onResize = resize; window.addEventListener("resize", resize);
    const pal = PLANET_PAL[planet.type] || PLANET_PAL.rocky;
    const stars = []; for (let i = 0; i < 90; i++) stars.push({ x: Math.random(), y: Math.random(), b: Math.random() });
    const sats = []; const nsat = 1 + (planet.name.length % 3);
    for (let i = 0; i < nsat; i++) sats.push({ ang: Math.random() * 6.28, rr: 1.32 + i * 0.26, spd: (0.35 + i * 0.12) * (i % 2 ? -1 : 1), size: 1.6 + Math.random() * 1.8 });
    const lanes = [{ off: -0.16, dir: 1, col: "rgba(150,200,255,.9)" }, { off: 0.22, dir: -1, col: "rgba(255,210,150,.85)" }];
    const ang = Math.PI * 0.13, nx = Math.cos(ang), ny = Math.sin(ang);

    let last = performance.now();
    const draw = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const w = canvas.width, h = canvas.height, cx = w / 2, cy = h / 2, pr = Math.min(w, h) * 0.32, m = Math.min(w, h);
      ctx.fillStyle = "#05070e"; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#fff";
      for (const st of stars) { ctx.globalAlpha = 0.22 + st.b * 0.5; ctx.fillRect(st.x * w, st.y * h, 1.2, 1.2); }
      ctx.globalAlpha = 1;
      // space-highway: evenly spaced civilian pixels gliding in two lanes
      for (const lane of lanes) {
        const bx = cx - ny * lane.off * m, by = cy + nx * lane.off * m;
        ctx.fillStyle = lane.col;
        for (let i = 0; i < 20; i++) {
          let t = (i / 20 + (reduced ? 0 : now / 1000 * 0.045 * lane.dir)) % 1; if (t < 0) t += 1;
          const al = (t - 0.5) * 1.7 * w;
          ctx.fillRect(bx + nx * al, by + ny * al, 1.7, 1.7);
        }
      }
      // atmosphere glow
      const pulse = reduced ? 0.16 : 0.16 + Math.sin(now / 700) * 0.05;
      const glow = ctx.createRadialGradient(cx, cy, pr * 0.72, cx, cy, pr * 1.5);
      glow.addColorStop(0, this._hexA(pal[1], 0)); glow.addColorStop(0.62, this._hexA(pal[1], pulse)); glow.addColorStop(1, this._hexA(pal[1], 0));
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, pr * 1.5, 0, 6.28); ctx.fill();
      this._drawBody(ctx, cx, cy, pr, planet, pal, now, reduced);
      // satellites (tilted orbits)
      for (const sa of sats) {
        if (!reduced) sa.ang += sa.spd * dt;
        const x = cx + Math.cos(sa.ang) * pr * sa.rr, y = cy + Math.sin(sa.ang) * pr * sa.rr * 0.4;
        ctx.fillStyle = "#cfd6e6"; ctx.beginPath(); ctx.arc(x, y, sa.size, 0, 6.28); ctx.fill();
      }
      if (!reduced) this.raf = requestAnimationFrame(draw);
    };
    if (reduced) draw(performance.now()); else this.raf = requestAnimationFrame(draw);
  },
  _drawBody(ctx, cx, cy, pr, planet, pal, now, reduced) {
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, pr, 0, 6.28); ctx.clip();
    let mid = pal[0];
    if (planet.type === "lava" && !reduced) mid = this._mix(pal[1], pal[2], (Math.sin(now / 600) + 1) / 2 * 0.6 + 0.2);
    const g = ctx.createRadialGradient(cx - pr * 0.35, cy - pr * 0.4, pr * 0.2, cx, cy, pr);
    g.addColorStop(0, pal[1]); g.addColorStop(0.55, mid); g.addColorStop(1, pal[2]);
    ctx.fillStyle = g; ctx.fillRect(cx - pr, cy - pr, pr * 2, pr * 2);
    if (planet.type === "gas_giant" || planet.type === "ringed") {
      ctx.globalAlpha = 0.16;
      for (let i = -pr, k = 0; i < pr; i += Math.max(6, pr * 0.15), k++) { ctx.fillStyle = k % 2 ? pal[1] : pal[2]; ctx.fillRect(cx - pr, cy + i, pr * 2, Math.max(3, pr * 0.08)); }
      ctx.globalAlpha = 1;
    }
    if (planet.type === "lava") {
      ctx.globalAlpha = 0.55; ctx.strokeStyle = this._mix(pal[1], "#ffffff", 0.25); ctx.lineWidth = 1.3;
      for (let i = 0; i < 5; i++) { ctx.beginPath(); const yy = cy - pr + (i + 0.5) / 5 * pr * 2; for (let x = -pr; x <= pr; x += 10) ctx.lineTo(cx + x, yy + Math.sin(x / 22 + i + (reduced ? 0 : now / 700)) * 5); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
    if (planet.type === "ice") { ctx.globalAlpha = 0.5; ctx.fillStyle = "#fff"; for (let i = 0; i < 26; i++) ctx.fillRect(cx - pr + ((i * 53) % 100) / 100 * pr * 2, cy - pr + ((i * 31) % 100) / 100 * pr * 2, 2, 2); ctx.globalAlpha = 1; }
    ctx.restore();
    const sh = ctx.createRadialGradient(cx - pr * 0.4, cy - pr * 0.45, pr * 0.3, cx, cy, pr * 1.05);
    sh.addColorStop(0, "rgba(0,0,0,0)"); sh.addColorStop(1, "rgba(0,0,0,.5)");
    ctx.fillStyle = sh; ctx.beginPath(); ctx.arc(cx, cy, pr, 0, 6.28); ctx.fill();
    if (planet.type === "ringed") {
      ctx.save(); ctx.translate(cx, cy); ctx.scale(1, 0.32);
      ctx.strokeStyle = this._hexA(pal[1], 0.6); ctx.lineWidth = Math.max(3, pr * 0.12);
      ctx.beginPath(); ctx.arc(0, 0, pr * 1.5, 0, 6.28); ctx.stroke(); ctx.restore();
    }
  },
  stopScene() {
    if (this.raf) cancelAnimationFrame(this.raf); this.raf = null;
    if (this._onResize) { window.removeEventListener("resize", this._onResize); this._onResize = null; }
  },
};

window.PlanetView = PlanetView;
