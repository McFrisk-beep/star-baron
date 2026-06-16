/* ui.js — all DOM rendering across the tabbed pages (Exchange, Fleet, Star
   Systems, Bazaar, Milestones) plus the persistent broadcast/feed sidebar and
   the modals. No game logic here — it reads modules and writes the screen.     */

const UI = {
  refs: {},
  rows: {},
  lastPrice: {},
  feedPaused: false,
  page: "exchange",
  bazaarTab: "shipyard",
  bzSort: { contracts: "reward", gear: "value", mercs: "power" },
  bzFilt: { contracts: "all", gear: "all" },
  tutStep: 0,
  _missionSig: "",
  _reportSig: "",
  _pending: null,        // pending contract awaiting ship selection
  _equipItem: null,
  _routeShip: null,      // ship uid awaiting trade-route configuration

  s() { return window.Game.state; },
  el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; },
  sysName(id) { const s = SYSTEMS.find(x => x.id === id); return s ? s.name : (Galaxy.get(id)?.name || id); },
  rarityColor(id) { return (Items.rarity(id) || {}).color || "#9aa9c8"; },
  _titly(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; },
  // Render a Bazaar filter/sort toolbar from [label, "kind.tab", value, [[v,label]…]] rows.
  bzTools(rows) {
    return `<div class="bz-tools">` + rows.map(([label, name, value, opts]) =>
      `<label>${label} <select class="bz-filter" data-bzf="${name}">` +
      opts.map(([v, l]) => `<option value="${v}"${v === value ? " selected" : ""}>${l}</option>`).join("") +
      `</select></label>`).join("") + `</div>`;
  },

  init() {
    const $ = id => document.getElementById(id);
    this.refs = {
      credits: $("hud-credits"), networth: $("hud-networth"), system: $("hud-system"),
      sentiment: $("hud-sentiment-fill"), tier: $("hud-tier"), clock: $("hud-clock"),
      exchangeSub: $("exchange-sub"), marketBody: $("market-body"), transit: $("transit-overlay"), warBanner: $("war-banner"),
      tabs: $("tabs"), fleetBadge: $("tab-fleet-badge"),
      fleetMain: $("fleet-main"), fleetMissions: $("fleet-missions"),
      fleetRoutes: $("fleet-routes"), routesSub: $("routes-sub"),
      fleetReportsPanel: $("fleet-reports-panel"), fleetReports: $("fleet-reports"),
      fleetShips: $("fleet-ships"), fleetCount: $("fleet-count"),
      fleetInventory: $("fleet-inventory"), invCount: $("inv-count"),
      systemList: $("system-list"), bazaarBody: $("bazaar-body"),
      rank: $("hud-rank"), lbList: $("lb-list"), lbSub: $("lb-sub"),
      achList: $("ach-list"), achCount: $("ach-count"),
      bcFrame: $("bc-frame"), bcTitle: $("bc-title"), bcCaption: $("bc-caption"),
      tickerText: $("ticker-text"), newswireList: $("newswire-list"),
      feedList: $("feed-list"), toast: $("toast-stack"),
      colSide: document.querySelector(".col-side"), newswireDetails: $("newswire-details"),
      btnPrestige: $("btn-prestige"), btnSettings: $("btn-settings"), btnHelp: $("btn-help"),
      tutorial: $("tutorial-modal"), tutIcon: $("tut-icon"), tutTitle: $("tut-title"),
      tutBody: $("tut-body"), tutDots: $("tut-dots"), tutSkip: $("tut-skip"),
      tutBack: $("tut-back"), tutNext: $("tut-next"),
      wywa: $("wywa-modal"), wywaBody: $("wywa-body"), wywaClose: $("wywa-close"),
      mission: $("mission-modal"), mmTitle: $("mm-title"), mmBody: $("mm-body"),
      mmLaunch: $("mm-launch"), mmCancel: $("mm-cancel"),
      equip: $("equip-modal"), eqTitle: $("eq-title"), eqBody: $("eq-body"), eqCancel: $("eq-cancel"),
      route: $("route-modal"), rtTitle: $("rt-title"), rtBody: $("rt-body"), rtStart: $("rt-start"), rtCancel: $("rt-cancel"),
      incident: $("incident-modal"), incIcon: $("inc-icon"), incTitle: $("inc-title"), incText: $("inc-text"),
      incChoices: $("inc-choices"), incResult: $("inc-result"), incClose: $("inc-close"),
      ordComm: $("ord-comm"), ordKind: $("ord-kind"), ordPrice: $("ord-price"), ordQty: $("ord-qty"),
      ordAdd: $("ord-add"), ordersList: $("orders-list"),
      settings: $("settings-modal"), setMute: $("set-mute"), setReduced: $("set-reduced"),
      setFastNews: $("set-fastnews"), setFast: $("set-fast"), setReset: $("set-reset"), setClose: $("set-close"),
    };
    this.buildExchange();
    this.buildOrders();
    this.wireControls();
    this.wireBus();
    this.renderSystems();
    this.renderAchievements();
    this.applySettings();
  },

  // ===== tabs ==============================================================
  showPage(name) {
    this.page = name;
    for (const t of this.refs.tabs.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.page === name);
    for (const p of document.querySelectorAll(".page")) p.classList.toggle("hidden", p.id !== "page-" + name);
    if (name === "fleet") this.renderFleet();
    else if (name === "bazaar") this.renderBazaar();
    else if (name === "systems") this.renderSystems();
    else if (name === "barons") this.renderLeaderboard();
    else if (name === "ach") this.renderAchievements();
    else if (name === "exchange") this.renderOrders();
  },

  // ===== exchange ==========================================================
  buildExchange() {
    const body = this.refs.marketBody; body.innerHTML = ""; this.rows = {};
    for (const c of COMMODITIES) {
      const tr = this.el("tr"); tr.dataset.id = c.id;
      const icon = this.el("td", "ico");
      const img = new Image(); img.src = ASSET.commodity(c.id); img.alt = "";
      img.onerror = () => img.replaceWith(this.tintBox(c)); icon.appendChild(img);
      const name = this.el("td", "name", `${c.name}<span class="cat cat-${c.cat}">${c.cat}</span>`);
      const price = this.el("td", "num price"), chg = this.el("td", "num chg"), trend = this.el("td", "trend");
      const held = this.el("td", "num held"), pnl = this.el("td", "num pnl"), act = this.el("td", "actions");
      act.innerHTML = `<div class="qrow">
        <input type="number" class="qin" min="1" value="10" aria-label="qty ${c.name}" />
        <button class="btn btn-buy" data-act="buy">Buy</button>
        <button class="btn btn-sell" data-act="sell">Sell</button>
        <button class="btn btn-mini" data-act="max">Max</button>
        <button class="btn btn-mini" data-act="all">All</button></div>`;
      tr.append(icon, name, price, chg, trend, held, pnl, act);
      body.appendChild(tr);
      this.rows[c.id] = { tr, price, chg, trend, held, pnl, qin: act.querySelector(".qin") };
    }
    // assignment (not addEventListener) so re-building on prestige can't stack handlers
    body.onclick = e => {
      const btn = e.target.closest("button[data-act]"); if (!btn) return;
      const id = btn.closest("tr").dataset.id, qin = this.rows[id].qin, act = btn.dataset.act;
      if (act === "buy") this.doTrade("buy", id, parseInt(qin.value, 10) || 0);
      else if (act === "sell") this.doTrade("sell", id, parseInt(qin.value, 10) || 0);
      else if (act === "max") this.doTrade("buy", id, Economy.maxBuy(id));
      else if (act === "all") this.doTrade("sell", id, this.s().positions[id] || 0);
    };
  },
  tintBox(c) { const d = this.el("div", "tintbox"); d.textContent = (c.name || "?").slice(0, 2); return d; },

  doTrade(side, id, qty) {
    const r = side === "buy" ? Economy.buy(id, qty) : Economy.sell(id, qty);
    if (!r.ok) { this.toast(r.msg, "warn"); return; }
    const comm = COMMODITIES.find(c => c.id === id);
    if (side === "buy") this.toast(`Bought ${r.qty} ${comm.name} for ${Util.credits(r.cost)}c`, "buy");
    else this.toast(`Sold ${r.qty} ${comm.name} for ${Util.credits(r.proceeds)}c (${r.realized >= 0 ? "+" : ""}${Util.credits(r.realized)})`, r.realized >= 0 ? "good" : "bad");
    this.flashCredits(); window.Game.requestSave(); this.updateExchange();
  },

  updateExchange() {
    const sys = this.s().currentSystem;
    this.refs.exchangeSub.textContent = `· prices at ${this.sysName(sys)}`;
    // transit overlay
    if (this.s().travel) {
      const t = this.s().travel;
      this.refs.transit.classList.remove("hidden");
      this.refs.transit.innerHTML =
        `<div class="transit-card"><div class="transit-h">In transit</div>
         <div class="transit-sub">${this.sysName(t.from)} → <b>${this.sysName(t.to)}</b></div>
         <div class="bar"><span style="width:${(Economy.travelProgress() * 100).toFixed(1)}%"></span></div>
         <div class="transit-eta">arriving in ${Util.duration(Economy.travelRemaining())}</div>
         <div class="muted-note">the exchange opens when you dock</div></div>`;
    } else this.refs.transit.classList.add("hidden");

    for (const c of COMMODITIES) {
      const r = this.rows[c.id];
      const p = Market.systemPrice(c.id, sys), prev = this.lastPrice[c.id];
      r.price.textContent = Util.price(p);
      if (prev != null && Math.abs(p - prev) > 1e-6) { r.price.classList.remove("up", "down"); void r.price.offsetWidth; r.price.classList.add(p > prev ? "up" : "down"); }
      this.lastPrice[c.id] = p;
      const pct = Market.changePct(c.id);
      r.chg.textContent = (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%";
      r.chg.className = "num chg " + (pct > 0.1 ? "up" : pct < -0.1 ? "down" : "");
      r.trend.innerHTML = this.spark(Market.history(c.id), pct >= 0);
      const q = this.s().positions[c.id] || 0;
      r.held.textContent = q ? q : "·";
      if (q) { const cost = this.s().avgCost[c.id] || 0, upl = (p - cost) * q;
        r.pnl.textContent = (upl >= 0 ? "+" : "") + Util.credits(upl); r.pnl.className = "num pnl " + (upl >= 0 ? "up" : "down"); }
      else { r.pnl.textContent = "·"; r.pnl.className = "num pnl"; }
    }
    this.renderWarBanner();
  },

  renderWarBanner() {
    const b = this.refs.warBanner; if (!b) return;
    const w = window.Wars && Wars.active();
    if (!w) { b.classList.add("hidden"); return; }
    b.classList.remove("hidden");
    b.innerHTML = `<span class="war-mark">⚔</span> <b>${FACTIONS[w.a].name}</b> vs <b>${FACTIONS[w.b].name}</b> — ` +
      `<span class="up">${w.catA} spiking</span> · <span class="down">${w.catB} slumping</span> · ` +
      `<span class="war-eta">ends ${Util.duration(w.endsAt - Date.now())}</span>`;
  },

  spark(hist, up) {
    const w = 96, h = 24, n = hist.length; if (n < 2) return "";
    const min = Math.min(...hist), max = Math.max(...hist), span = max - min || 1;
    const pts = hist.map((v, i) => `${(i / (n - 1) * w).toFixed(1)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(1)}`).join(" ");
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${up ? "var(--up)" : "var(--down)"}" stroke-width="1.5"/></svg>`;
  },

  // ===== standing orders & alerts =========================================
  buildOrders() {
    this.refs.ordComm.innerHTML = COMMODITIES.map(c => `<option value="${c.id}">${c.name}</option>`).join("");
    this.refs.ordAdd.onclick = () => this.addOrder();
    this.renderOrders();
  },
  addOrder() {
    const commId = this.refs.ordComm.value, kindRaw = this.refs.ordKind.value;
    const price = parseFloat(this.refs.ordPrice.value);
    if (!(price > 0)) return this.toast("Enter a trigger price.", "warn");
    const order = kindRaw.startsWith("alert")
      ? { commId, kind: "alert", side: kindRaw.split("-")[1], price }
      : { commId, kind: kindRaw, price, qty: Math.max(1, parseInt(this.refs.ordQty.value, 10) || 0) };
    Orders.add(order);
    this.refs.ordPrice.value = "";
    window.Game.requestSave(); this.renderOrders();
    this.toast("Order set — it fires while you're docked.", "good");
  },
  renderOrders() {
    const list = Orders.list();
    if (!list.length) {
      this.refs.ordersList.innerHTML = `<li class="muted-note">No standing orders. Set a buy-below, sell-above, or price alert — they fire automatically while you're docked here.</li>`;
      this.refs.ordersList.onclick = null; return;
    }
    this.refs.ordersList.innerHTML = list.map(o => {
      const cn = (COMMODITIES.find(c => c.id === o.commId) || {}).name || o.commId;
      const now = `<span class="ord-now">now ${Util.price(Orders.priceNow(o.commId))}</span>`;
      const tag = o.kind === "alert"
        ? `<span class="ord-tag ord-alert">ALERT</span> ${cn} ${o.side === "below" ? "≤" : "≥"} <b>${Util.price(o.price)}</b>`
        : `<span class="ord-tag ord-${o.kind}">${o.kind.toUpperCase()}</span> ${o.qty} ${cn} ${o.kind === "buy" ? "≤" : "≥"} <b>${Util.price(o.price)}</b>`;
      return `<li class="ord">${tag} ${now}<button class="btn btn-mini" data-cancelord="${o.id}">✕</button></li>`;
    }).join("");
    this.refs.ordersList.onclick = e => {
      const c = e.target.closest("[data-cancelord]"); if (!c) return;
      Orders.remove(c.dataset.cancelord); window.Game.requestSave(); this.renderOrders();
    };
  },

  // ===== header ============================================================
  updateHeader() {
    const s = this.s();
    this.refs.credits.textContent = Util.credits(s.credits);
    this.refs.networth.textContent = Util.credits(Economy.netWorth());
    if (this.refs.rank && window.Rivals) this.refs.rank.textContent = `#${Rivals.rank()} / ${Rivals.count()}`;
    this.refs.system.textContent = s.travel ? `→ ${this.sysName(s.travel.to)} (${Util.duration(Economy.travelRemaining())})` : this.sysName(s.currentSystem);
    this.refs.tier.textContent = s.prestige.tier;
    const sent = Market.sentiment(), pct = (sent + 1) / 2 * 100;
    this.refs.sentiment.style.width = pct.toFixed(0) + "%";
    this.refs.sentiment.style.background = sent >= 0 ? "var(--up)" : "var(--down)";
    this.refs.btnPrestige.classList.toggle("hidden", !Economy.canPrestige());
    const missionsN = s.missions.length, reportsN = s.reports.length;
    const badge = this.refs.fleetBadge;
    if (missionsN + reportsN > 0) { badge.classList.remove("hidden"); badge.textContent = missionsN + reportsN; }
    else badge.classList.add("hidden");
  },
  flashCredits() { const e = this.refs.credits; e.classList.remove("flash"); void e.offsetWidth; e.classList.add("flash"); },
  updateClock() {
    const cycleMs = 5 * 60 * 1000, cycle = Math.floor(Date.now() / cycleMs), remain = cycleMs - (Date.now() % cycleMs);
    this.refs.clock.textContent = `${cycle % 10000} · ${Util.duration(remain)}`;
  },

  // ===== FLEET page ========================================================
  // symbol + readable label per ship stat, so chips read "⚔ Firepower 25"
  // rather than a bare glyph. Reused by ship cards, the shipyard, mercs & missions.
  STAT_META: {
    firepower: { sym: "⚔", label: "Firepower", cls: "sc-fp" },
    hull:      { sym: "❤", label: "Hull",      cls: "sc-hl" },
    armor:     { sym: "🛡", label: "Armor",     cls: "sc-ar" },
    shields:   { sym: "✦", label: "Shields",   cls: "sc-sh" },
    cargo:     { sym: "▣", label: "Cargo",     cls: "sc-cg" },
    speed:     { sym: "»", label: "Speed",     cls: "sc-sp" },
  },
  statChips(obj, keys = ["firepower", "hull", "armor", "shields", "cargo", "speed"]) {
    return keys.map(k => { const m = this.STAT_META[k];
      return `<span class="sc ${m.cls}" title="${m.label}">${m.sym} ${m.label} ${obj[k]}</span>`;
    }).join("");
  },

  renderFleet() {
    const s = this.s();
    // main ship
    const md = Fleet.mainDef();
    const pas = md.passive ? `+${(md.passive.pct * 100).toFixed(0)}% ${md.passive.stat} to fleet` : "—";
    this.refs.fleetMain.innerHTML =
      `<h2>Flagship</h2>
       <div class="mainship">
         <img src="${ASSET.ship(md.sprite)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tintbox',textContent:'★'}))"/>
         <div><div class="ship-name">${md.name}</div>
         <div class="ship-route">transfer speed ${md.travelSpeed} · passive: <b>${pas}</b></div>
         <div class="muted-note">your private ship — sets sector travel time. Upgrade in the Bazaar.</div></div>
       </div>`;
    // ships
    this.refs.fleetCount.textContent = `${s.ships.length}`;
    if (!s.ships.length) this.refs.fleetShips.innerHTML = `<p class="muted-note">No ships yet. Buy transports & escorts in the Bazaar.</p>`;
    else this.refs.fleetShips.innerHTML = s.ships.map(sh => this.shipCard(sh)).join("");
    this.refs.fleetShips.onclick = e => this.onFleetClick(e);
    // inventory
    this.renderInventory();
    // trade routes + missions + reports
    this.renderRoutes();
    this._missionSig = ""; this.renderMissions();
    this.renderReports();
  },

  // ---- trade routes -------------------------------------------------------
  renderRoutes() {
    const routes = Routes.active();
    this.refs.routesSub.textContent = routes.length ? `${routes.length} running` : "";
    if (!routes.length) {
      this.refs.fleetRoutes.innerHTML = `<p class="muted-note">No trade routes. Put an idle ship on a buy-low → sell-high loop with “⇄ Set route” — it banks the spread while you're away.</p>`;
      this.refs.fleetRoutes.onclick = null; return;
    }
    this.refs.fleetRoutes.innerHTML = routes.map(sh => {
      const r = sh.route, e = Routes.estimate(sh, r.comm, r.from, r.to);
      const cn = (COMMODITIES.find(c => c.id === r.comm) || {}).name || r.comm;
      const eta = Math.max(0, r.nextAt - Date.now());
      return `<div class="route"><div class="route-head"><b>${sh.name}</b>
          <span class="route-leg">${cn}: ${this.sysName(r.from)} → ${this.sysName(r.to)}</span>
          <button class="btn btn-mini" data-stoproute="${sh.uid}">Stop</button></div>
        <div class="route-foot"><b class="${e.profit > 0 ? "up" : "down"}">${Util.credits(e.profit)}c</b>/trip ·
          ~${Util.credits(Math.round(e.perHour))}c/hr · <span class="muted-note">next delivery ${Util.duration(eta)}</span></div></div>`;
    }).join("");
    this.refs.fleetRoutes.onclick = ev => {
      const st = ev.target.closest("[data-stoproute]"); if (!st) return;
      Routes.stop(st.dataset.stoproute); this.toast("Route stopped — ship is idle.", "info");
      window.Game.requestSave(); this.renderFleet();
    };
  },

  openRoute(shipUid) {
    const sh = Fleet.ship(shipUid); if (!sh) return;
    this._routeShip = shipUid;
    this.refs.rtTitle.textContent = "Trade route — " + sh.name;
    const unlocked = SYSTEMS.filter(s => this.s().unlockedSystems.includes(s.id));
    if (unlocked.length < 2) {
      this.refs.rtBody.innerHTML = `<p class="down">Unlock at least two systems first (Star Systems tab).</p>`;
      this.refs.rtStart.disabled = true; this.refs.route.classList.remove("hidden"); return;
    }
    const opts = (list, val, key = "id", label = "name") => list.map(o =>
      `<option value="${o[key]}"${o[key] === val ? " selected" : ""}>${o[label]}</option>`).join("");
    const from0 = unlocked[0].id, to0 = unlocked[1].id;
    this.refs.rtBody.innerHTML =
      `<div class="rt-form">
         <label>Commodity <select id="rt-comm">${opts(COMMODITIES, COMMODITIES[0].id)}</select></label>
         <label>Buy at <select id="rt-from">${opts(unlocked, from0)}</select></label>
         <label>Sell at <select id="rt-to">${opts(unlocked, to0)}</select></label>
       </div>
       <p class="muted-note">Cargo capacity <b>${Fleet.stats(sh).cargo}</b> — ${sh.name} runs the loop and banks the spread while you're away.</p>
       <div class="mm-calc" id="rt-calc"></div>`;
    this.refs.rtBody.querySelectorAll("select").forEach(s => s.onchange = () => this.updateRouteCalc());
    this.updateRouteCalc();
    this.refs.route.classList.remove("hidden");
  },
  _routeSel() {
    const q = id => (this.refs.rtBody.querySelector(id) || {}).value;
    return { comm: q("#rt-comm"), from: q("#rt-from"), to: q("#rt-to") };
  },
  updateRouteCalc() {
    const sh = Fleet.ship(this._routeShip); if (!sh) return;
    const { comm, from, to } = this._routeSel();
    const calc = document.getElementById("rt-calc"); if (!calc) return;
    if (from === to) { calc.innerHTML = `<span class="down">Pick two different systems.</span>`; this.refs.rtStart.disabled = true; return; }
    const e = Routes.estimate(sh, comm, from, to);
    const cn = (COMMODITIES.find(c => c.id === comm) || {}).name || comm;
    calc.innerHTML =
      `Buy ${cn} @ <b>${Util.price(e.buy)}</b> · sell @ <b>${Util.price(e.sell)}</b> · spread <b class="${e.spread > 0 ? "up" : "down"}">${Util.price(e.spread)}</b><br>` +
      `round trip ~${Util.duration(e.cycleMs)} · <b class="${e.profit > 0 ? "up" : "down"}">${Util.credits(e.profit)}c</b>/trip · ~<b>${Util.credits(Math.round(e.perHour))}c/hr</b>`;
    this.refs.rtStart.disabled = e.profit <= 0;
  },

  shipCard(sh) {
    const def = Fleet.shipDef(sh.type), st = Fleet.stats(sh);
    const slots = def.slots || 2, used = (sh.accessories || []).length;
    const acc = (sh.accessories || []).map(uid => {
      const it = this.s().items[uid]; if (!it) return "";
      return `<span class="acc-chip" style="border-color:${this.rarityColor(it.rarity)}">${it.name} <button class="x" data-unequip="${sh.uid}:${uid}">✕</button></span>`;
    }).join("");
    let status;
    if (sh.status === "mission") status = `<span class="badge">on mission</span>`;
    else if (sh.status === "impounded") status = `<span class="badge bad">impounded ${Util.credits(sh.retrieveCost)}c <button class="btn btn-mini" data-retrieve="${sh.uid}">Pay</button></span>`;
    else if (sh.status === "trading") status = `<span class="badge trade">trading</span>`;
    else status = `<span class="badge idle">idle</span>`;
    const merc = sh.mercenary ? `<span class="badge merc">merc · ${Util.duration((sh.expiresAt || 0) - Date.now())}</span>` : "";
    const sprite = def.cls === "escort" ? ASSET.raceship(def.sprite) : ASSET.ship(def.sprite);
    const equipBtn = sh.status === "idle" && used < slots
      ? `<button class="btn btn-mini" data-equip-ship="${sh.uid}">+ Equip</button>` : "";
    // idle, owned ships can be put on a trade route or sold (mercs are rented;
    // a busy ship can't do either mid-job)
    const routeBtn = sh.status === "idle" && !sh.mercenary
      ? `<button class="btn btn-mini" data-route-ship="${sh.uid}">⇄ Set route</button>` : "";
    const sellBtn = sh.status === "idle" && !sh.mercenary
      ? `<button class="btn btn-mini btn-sellship" data-sellship="${sh.uid}" title="sells with its equipped gear">Sell ${Util.credits(Bazaar.shipSaleValue(sh))}c</button>` : "";
    return `<div class="ship cls-${def.cls}">
      <img src="${sprite}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tintbox',textContent:'${def.name[0]}'}))"/>
      <div class="ship-info">
        <div class="ship-name">${sh.name} ${status} ${merc}</div>
        <div class="ship-route">${def.name} · <span class="cls-tag">${def.cls}</span> · slots ${used}/${slots}</div>
        <div class="statline">${this.statChips(st)}</div>
        <div class="acc-row">${acc}${equipBtn}${routeBtn}${sellBtn}</div>
      </div></div>`;
  },

  onFleetClick(e) {
    const un = e.target.closest("[data-unequip]"); const eq = e.target.closest("[data-equip-ship]");
    const rt = e.target.closest("[data-retrieve]"); const sl = e.target.closest("[data-sellship]");
    const ro = e.target.closest("[data-route-ship]");
    if (un) { const [shipU, itemU] = un.dataset.unequip.split(":"); Fleet.unequip(shipU, itemU); window.Game.requestSave(); this.renderFleet(); }
    else if (eq) { this.openEquipForShip(eq.dataset.equipShip); }
    else if (ro) { this.openRoute(ro.dataset.routeShip); }
    else if (rt) { const r = Fleet.retrieve(rt.dataset.retrieve); if (!r.ok) return this.toast(r.msg, "warn"); this.toast("Ship retrieved.", "good"); this.flashCredits(); window.Game.requestSave(); this.renderFleet(); }
    else if (sl) {
      const sh = Fleet.ship(sl.dataset.sellship); if (!sh) return;
      const val = Bazaar.shipSaleValue(sh), n = (sh.accessories || []).length, name = sh.name;
      const extra = n ? ` and its ${n} equipped item${n > 1 ? "s" : ""}` : "";
      if (!confirm(`Sell ${name}${extra} for ${Util.credits(val)}c? This can't be undone.`)) return;
      const r = Bazaar.sellShip(sl.dataset.sellship);
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast(`Sold ${name} for ${Util.credits(r.credits)}c`, "good");
      this.flashCredits(); window.Game.requestSave(); this.renderFleet(); this.updateHeader();
    }
  },

  renderInventory() {
    const inv = Bazaar.inventoryItems(), listed = this.s().listings;
    this.refs.invCount.textContent = `${Bazaar.inventoryUsed()}/${Bazaar.capacity()}`;
    let html = "";
    if (!inv.length && !listed.length) html = `<p class="muted-note">Empty. Buy accessories in the Bazaar, or win them from contracts.</p>`;
    html += inv.map(it => `<div class="item" style="border-left-color:${this.rarityColor(it.rarity)}">
        <div class="item-top"><b>${it.name}</b><span class="rar" style="color:${this.rarityColor(it.rarity)}">${(Items.rarity(it.rarity) || {}).label}</span></div>
        <div class="item-stat">${Items.label(it)}</div>
        <div class="item-acts">
          <span class="item-val">${Util.credits(it.value)}c</span>
          <button class="btn btn-mini" data-equip="${it.uid}">Equip</button>
          <button class="btn btn-mini" data-sellnow="${it.uid}">Sell ${Util.credits(Math.round(it.value * BAZAARCFG.itemResaleMult))}c</button>
        </div></div>`).join("");
    if (listed.length) {
      html += `<div class="inv-sub">Listed on the market</div>` + listed.map(l => {
        const it = this.s().items[l.itemUid]; if (!it) return "";
        return `<div class="item listed" style="border-left-color:${this.rarityColor(it.rarity)}">
          <div class="item-top"><b>${it.name}</b><span class="rar">listed · ${Util.credits(l.listPrice)}c</span></div>
          <div class="item-stat">${Items.label(it)} <span class="muted-note">— awaiting a buyer…</span></div>
          <div class="item-acts"><button class="btn btn-mini" data-cancel="${l.itemUid}">Cancel listing</button></div></div>`;
      }).join("");
    }
    this.refs.fleetInventory.innerHTML = html;
    this.refs.fleetInventory.onclick = e => {
      const eq = e.target.closest("[data-equip]"), sn = e.target.closest("[data-sellnow]"), ca = e.target.closest("[data-cancel]");
      if (eq) this.openEquipForItem(eq.dataset.equip);
      else if (sn) { const r = Bazaar.sellNow(sn.dataset.sellnow); if (!r.ok) return this.toast(r.msg || "Can't sell.", "warn"); this.toast(`Sold for ${Util.credits(r.credits)}c`, "good"); this.flashCredits(); window.Game.requestSave(); this.renderFleet(); }
      else if (ca) { Bazaar.cancelListing(ca.dataset.cancel); this.toast("Listing cancelled.", "info"); window.Game.requestSave(); this.renderInventory(); }
    };
  },

  // ---- missions -----------------------------------------------------------
  renderMissions() {
    const ms = this.s().missions;
    const sig = ms.map(m => m.uid).join(",");
    if (sig === this._missionSig) { this.updateMissions(); return; }
    this._missionSig = sig;
    if (!ms.length) { this.refs.fleetMissions.innerHTML = `<p class="muted-note">No active missions. Take a contract in the Bazaar.</p>`; return; }
    this.refs.fleetMissions.innerHTML = ms.map(m => {
      const icons = m.shipUids.map(u => { const sh = Fleet.ship(u); if (!sh) return ""; const def = Fleet.shipDef(sh.type); const sprite = def.cls === "escort" ? ASSET.raceship(def.sprite) : ASSET.ship(def.sprite); return `<img class="mi" src="${sprite}" alt="" title="${sh.name}" onerror="this.style.display='none'"/>`; }).join("");
      return `<div class="mission" data-m="${m.uid}">
        <div class="m-head"><b>${m.title}</b><span class="m-chance">${(m.successChance * 100).toFixed(0)}% success</span></div>
        <div class="m-ships">${icons}</div>
        <div class="mbar"><span class="mbar-fill"></span></div>
        <div class="m-foot"><span class="m-phase"></span><span class="m-eta"></span></div>
      </div>`;
    }).join("");
    this.updateMissions();
  },

  updateMissions() {
    for (const m of this.s().missions) {
      const node = this.refs.fleetMissions.querySelector(`[data-m="${m.uid}"]`); if (!node) continue;
      const ph = Missions.phaseAt(m);
      const fill = node.querySelector(".mbar-fill"), bar = node.querySelector(".mbar");
      bar.classList.toggle("work", ph.dir === "work");
      bar.classList.toggle("rtl", ph.dir === "in");
      let w = ph.dir === "out" ? ph.phaseProgress * 100 : ph.dir === "in" ? (1 - ph.phaseProgress) * 100 : 100;
      fill.style.width = w.toFixed(1) + "%";
      node.querySelector(".m-phase").textContent = (ph.dir === "out" ? "▸ " : ph.dir === "in" ? "◂ " : "● ") + ph.label;
      node.querySelector(".m-eta").textContent = "ETA " + Util.duration(ph.remaining);
    }
  },

  renderReports() {
    const reps = this.s().reports;
    if (!reps.length) { this.refs.fleetReportsPanel.classList.add("hidden"); return; }
    this.refs.fleetReportsPanel.classList.remove("hidden");
    this.refs.fleetReports.innerHTML = reps.map(r => {
      let detail = "";
      if (r.success) {
        detail = `<span class="up">SUCCESS</span> · +${Util.credits(r.credits)}c`;
        if (r.stock) detail += ` · +${r.stock.qty} ${r.stock.name}`;
        if (r.items.length) detail += ` · ${r.items.length} item${r.items.length > 1 ? "s" : ""} won`;
      } else {
        detail = `<span class="down">FAILED</span>`;
        if (r.lost.length) detail += ` · lost ${r.lost.map(x => x.name).join(", ")}`;
        if (r.impounded.length) detail += ` · ${r.impounded.length} ship(s) impounded — pay in Owned Ships to retrieve`;
        if (!r.lost.length && !r.impounded.length) detail += ` · ships returned safely`;
      }
      return `<div class="report ${r.success ? "ok" : "bad"}"><div><b>${r.title}</b><div class="rep-detail">${detail}</div></div>
        <button class="btn btn-mini" data-dismiss="${r.uid}">Dismiss</button></div>`;
    }).join("");
    this.refs.fleetReports.onclick = e => {
      const d = e.target.closest("[data-dismiss]"); if (!d) return;
      this.s().reports = this.s().reports.filter(r => r.uid !== d.dataset.dismiss);
      window.Game.requestSave(); this.renderReports(); this.updateHeader();
    };
  },

  // ===== modals: mission launch & equip ===================================
  openMission(contract) {
    this._pending = contract;
    this.refs.mmTitle.textContent = contract.title;
    const idle = Fleet.idle();
    const danger = DANGER.find(d => d.id === contract.danger);
    let head = `<div class="mm-req"><span>Danger: <b class="dgr-${contract.danger}">${danger.label}</b></span>`;
    if (contract.minFirepower) head += `<span>Min firepower: <b>${contract.minFirepower}</b></span>`;
    if (contract.cargoRequired) head += `<span>Cargo needed: <b>${contract.cargoRequired}</b></span>`;
    head += `<span>Reward: <b>${Util.credits(contract.reward.credits)}c</b></span></div>`;
    head += `<p class="muted-note">${contract.desc}${contract.impound ? " Failure risks impound." : ""}</p>`;
    if (!idle.length) head += `<p class="down">No idle ships available.</p>`;
    const list = idle.map(sh => { const st = Fleet.stats(sh); const def = Fleet.shipDef(sh.type);
      return `<label class="mm-ship"><input type="checkbox" data-ship="${sh.uid}"/> <b>${sh.name}</b> <span class="cls-tag">${def.cls}</span> ${this.statChips(st, ["firepower", "cargo"])}</label>`;
    }).join("");
    this.refs.mmBody.innerHTML = head + `<div class="mm-list">${list}</div><div class="mm-calc" id="mm-calc"></div>`;
    this.refs.mmBody.querySelectorAll("input[data-ship]").forEach(cb => cb.onchange = () => this.updateMissionCalc());
    this.updateMissionCalc();
    this.refs.mission.classList.remove("hidden");
  },
  selectedShipUids() { return [...this.refs.mmBody.querySelectorAll("input[data-ship]:checked")].map(c => c.dataset.ship); },
  updateMissionCalc() {
    const c = this._pending; if (!c) return;
    const uids = this.selectedShipUids();
    const fp = Fleet.power(uids), cap = Fleet.cargoCap(uids);
    const chance = uids.length ? Missions.successChance(c, uids) : 0;
    const dur = uids.length ? c.durationMs / (window.Game.timeScale || 1) : c.durationMs;
    document.getElementById("mm-calc").innerHTML =
      `Selected firepower <b>${fp}</b>${c.cargoRequired ? ` · cargo <b class="${cap >= c.cargoRequired ? "up" : "down"}">${cap}</b>/${c.cargoRequired}` : ""} · ` +
      `success <b class="${chance > 0.6 ? "up" : chance < 0.4 ? "down" : ""}">${(chance * 100).toFixed(0)}%</b> · ETA ~${Util.duration(dur)}`;
    this.refs.mmLaunch.disabled = !uids.length;
  },
  launchMission() {
    const c = this._pending; if (!c) return;
    const r = Missions.launch(c, this.selectedShipUids());
    if (!r.ok) return this.toast(r.msg, "warn");
    this.toast("Mission launched ▸", "good");
    this._pending = null; this.refs.mission.classList.add("hidden");
    window.Game.requestSave(); this.renderFleet(); this.renderBazaar(); this.updateHeader();
  },

  openEquipForItem(itemUid) {
    this._equipItem = itemUid; this._equipShip = null;
    const it = this.s().items[itemUid];
    this.refs.eqTitle.textContent = "Equip: " + it.name;
    const cands = Fleet.idle().filter(sh => (sh.accessories || []).length < (Fleet.shipDef(sh.type).slots || 2));
    this.refs.eqBody.innerHTML = it
      ? `<p class="muted-note">${Items.label(it)}</p>` + (cands.length
        ? cands.map(sh => `<button class="btn eq-pick" data-ship="${sh.uid}">${sh.name} <span class="cls-tag">${Fleet.shipDef(sh.type).cls}</span> (${(sh.accessories || []).length}/${Fleet.shipDef(sh.type).slots} slots)</button>`).join("")
        : `<p class="down">No idle ship with a free slot.</p>`)
      : "";
    this.refs.eqBody.querySelectorAll(".eq-pick").forEach(b => b.onclick = () => {
      const r = Fleet.equip(b.dataset.ship, itemUid);
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast("Equipped.", "good"); this.refs.equip.classList.add("hidden");
      window.Game.requestSave(); this.renderFleet();
    });
    this.refs.equip.classList.remove("hidden");
  },
  openEquipForShip(shipUid) {
    const inv = Bazaar.inventoryItems();
    this.refs.eqTitle.textContent = "Equip a slot — " + Fleet.ship(shipUid).name;
    this.refs.eqBody.innerHTML = inv.length
      ? inv.map(it => `<button class="btn eq-pick" data-item="${it.uid}" style="border-left:3px solid ${this.rarityColor(it.rarity)}">${it.name} — ${Items.label(it)}</button>`).join("")
      : `<p class="muted-note">No accessories in inventory. Buy some in the Bazaar.</p>`;
    this.refs.eqBody.querySelectorAll(".eq-pick").forEach(b => b.onclick = () => {
      const r = Fleet.equip(shipUid, b.dataset.item);
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast("Equipped.", "good"); this.refs.equip.classList.add("hidden");
      window.Game.requestSave(); this.renderFleet();
    });
    this.refs.equip.classList.remove("hidden");
  },

  // ===== BAZAAR page =======================================================
  renderBazaar() {
    if (this.page !== "bazaar") return;
    const b = this.s().bazaar;
    const shipCardBuy = (def, sprite) => `<div class="buy-card">
      <img src="${sprite}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tintbox',textContent:'${def.name[0]}'}))"/>
      <div class="bc-name">${def.name} <span class="cls-tag">${def.cls}</span></div>
      <div class="statline bc-statline">${this.statChips(def)}</div>
      <button class="btn btn-go" data-buyship="${def.id}">${def.price ? Util.credits(def.price) + "c" : "Free"}</button></div>`;

    // The free starter ship only shows when the player has no ships at all
    // (the flagship doesn't count).
    const noShips = this.s().ships.length === 0;
    const yard = [...SHIP_CATALOG.transport, ...SHIP_CATALOG.escort]
      .filter(d => d.price > 0 || noShips)
      .map(d => shipCardBuy(d, d.cls === "escort" ? ASSET.raceship(d.sprite) : ASSET.ship(d.sprite))).join("");

    const mains = SHIP_CATALOG.main.map(d => {
      const owned = this.s().mainShip.type === d.id;
      const pas = d.passive ? `+${(d.passive.pct * 100).toFixed(0)}% ${d.passive.stat}` : "";
      return `<div class="buy-card">
        <img src="${ASSET.ship(d.sprite)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tintbox',textContent:'★'}))"/>
        <div class="bc-name">${d.name}</div>
        <div class="bc-stats" title="sector transfer speed — sets how fast you dock between systems">» Transfer speed ${d.travelSpeed} · ${pas}</div>
        ${owned ? `<span class="badge">current flagship</span>` : `<button class="btn btn-go" data-buymain="${d.id}">${d.price ? Util.credits(d.price) + "c" : "Free"}</button>`}</div>`;
    }).join("");

    const mercSorters = {
      power: (a, z) => z.firepower - a.firepower,
      cost: (a, z) => a.hireCost - z.hireCost,
      expiry: (a, z) => a.availUntil - z.availUntil,
    };
    const mercTools = this.bzTools([["Sort", "sort.mercs", this.bzSort.mercs,
      [["power", "Firepower"], ["cost", "Cost"], ["expiry", "Offer ending"]]]]);
    const mercs = [...(b.mercs || [])].sort(mercSorters[this.bzSort.mercs] || mercSorters.power)
      .map(m => `<div class="buy-card merc">
        <div class="bc-name">${m.name} <span class="cls-tag">merc</span></div>
        <div class="bc-stats">${Fleet.shipDef(m.shipType).name}</div>
        <div class="statline bc-statline">${this.statChips(m, ["firepower", "hull"])}</div>
        <div class="muted-note">serves ${Util.duration(m.serviceMs)} · offer ends ${Util.duration(m.availUntil - Date.now())}</div>
        <button class="btn btn-go" data-hire="${m.id}">Hire ${Util.credits(m.hireCost)}c</button></div>`).join("") || `<p class="muted-note">No mercenaries on offer right now.</p>`;

    const idlePower = Fleet.power(Fleet.idle().map(s => s.uid));
    const sponChip = f => { const fac = FACTIONS[f]; if (!fac) return ""; const t = Rep.tierOf(f);
      return `<span class="c-spon" style="color:${fac.color}">◆ ${fac.name}</span><span class="c-stand" style="color:${t.color}">${t.label}</span>`; };
    const typeOf = c => c.kind === "tip" ? "tip" : c.type;
    const openC = (b.contracts || []).filter(c => c.status === "open");
    const takenC = (b.contracts || []).filter(c => c.status === "taken_npc");
    const dIdx = c => DANGER.findIndex(d => d.id === c.danger);
    const cSorters = {
      reward: (a, z) => (z.reward?.credits || 0) - (a.reward?.credits || 0),
      danger: (a, z) => dIdx(z) - dIdx(a),
      expiry: (a, z) => a.expiresAt - z.expiresAt,
    };
    const cFilt = this.bzFilt.contracts;
    const cTypes = [...new Set(openC.map(typeOf))];
    if (cFilt !== "all" && !cTypes.includes(cFilt)) this.bzFilt.contracts = "all";  // reset if the filtered type churned away
    const shownC = [...(this.bzFilt.contracts === "all" ? openC : openC.filter(c => typeOf(c) === this.bzFilt.contracts))]
      .sort(cSorters[this.bzSort.contracts] || cSorters.reward);
    const contractTools = this.bzTools([
      ["Type", "filt.contracts", this.bzFilt.contracts,
        [["all", "All"], ...cTypes.map(t => [t, t === "tip" ? "Insider tips" : this._titly(t)])]],
      ["Sort", "sort.contracts", this.bzSort.contracts,
        [["reward", "Reward"], ["danger", "Danger"], ["expiry", "Expiring soon"]]],
    ]);
    const tipCard = c => `<div class="contract tip"><div class="c-head"><b>${c.title}</b><span class="ctype">insider tip</span></div>
        <div class="c-desc">${c.desc}</div>
        <div class="c-tags">${sponChip(c.faction)}</div>
        <div class="c-foot"><span class="muted-note">expires ${Util.duration(c.expiresAt - Date.now())}</span>
        <button class="btn btn-go" data-take="${c.id}">Buy tip ${Util.credits(c.cost)}c</button></div></div>`;
    const jobCard = c => {
      const danger = DANGER.find(d => d.id === c.danger);
      const ok = idlePower >= (c.minFirepower || 0);
      const bonus = c.faction ? (Rep.rewardMult(c.faction) - 1) : 0;
      return `<div class="contract"><div class="c-head"><b>${c.title}</b><span class="ctype ct-${c.type}">${c.type}</span></div>
        <div class="c-desc">${c.desc}</div>
        <div class="c-tags">${sponChip(c.faction)}${c.warEffort ? `<span class="war-effort">⚔ war effort</span>` : ""}<span class="dgr-${c.danger}">${danger.label}</span>
          ${c.minFirepower ? `<span class="${ok ? "" : "down"}">⚔ need ${c.minFirepower}</span>` : `<span class="up">no escort needed</span>`}
          ${c.cargoRequired ? `<span>▣ ${c.cargoRequired}</span>` : ""}
          <span>⌁ ${Util.duration(c.durationMs / (window.Game.timeScale || 1))}</span>
          <span class="up">${Util.credits(c.reward.credits)}c${bonus > 0.001 ? ` <span class="rep-bonus">+${(bonus * 100).toFixed(0)}%</span>` : ""}</span></div>
        <div class="c-foot"><span class="muted-note">expires ${Util.duration(c.expiresAt - Date.now())}</span>
          <button class="btn btn-go" data-take="${c.id}">Take contract</button></div></div>`;
    };
    const contracts = (shownC.map(c => c.kind === "tip" ? tipCard(c) : jobCard(c)).join("")
      + takenC.map(c => `<div class="contract taken"><div class="c-head"><b>${c.title}</b><span class="badge bad">Contract taken</span></div></div>`).join(""))
      || `<p class="muted-note">${openC.length ? "No contracts match this filter." : "The contract board is quiet…"}</p>`;

    const fmtPct = (n, dp) => (n >= 0 ? "+" : "") + n.toFixed(dp) + "%";
    const repLegend = `<div class="rep-legend">
        <p class="muted-note">Standing runs <b>−100 to +100</b> with each faction. Raise it by completing their
          contracts and trading their goods. It spends as the perks listed under each faction below; your best ally
          also gives <b>${(Rep.discount() * 100).toFixed(0)}% off</b> ships &amp; gear right now. Top jobs (assassinate /
          extreme danger) need <b>Friendly+</b> with the sponsor, and helping a faction annoys its rival.</p>
        <div class="rep-tiers">${REP.tiers.map(t =>
          `<span class="rep-tierchip" style="color:${t.color}">${t.label}<span class="rt-at">${t.at > 0 ? "+" : ""}${t.at}</span></span>`).join("")}</div>
      </div>`;
    const standing = `<div class="panel"><h2>Faction Standing <small>what your reputation buys you</small></h2>${repLegend}<div class="rep-grid">` +
      Rep.ids().map(f => { const fac = FACTIONS[f], v = Rep.get(f), t = Rep.tier(v);
        const edge = Rep.edge(f) * 100, reward = (Rep.rewardMult(f) - 1) * 100, succ = Rep.successBonus(f) * 100;
        const rival = fac.rival ? FACTIONS[fac.rival].name : "—";
        return `<div class="rep-row"><div class="rep-head"><b style="color:${fac.color}">${fac.name}</b>
          <span class="rep-tier" style="color:${t.color}">${t.label} ${v >= 0 ? "+" : ""}${Math.round(v)}</span></div>
          <div class="rep-bar"><span class="rep-mid"></span><span class="rep-fill" style="width:${((v - REP.min) / (REP.max - REP.min) * 100).toFixed(0)}%;background:${t.color}"></span></div>
          <ul class="rep-eff">
            <li><span>Exchange edge · ${fac.domain.join(", ")}</span><b class="${edge >= 0 ? "up" : "down"}">${fmtPct(edge, 1)}</b></li>
            <li><span>Contract rewards</span><b class="${reward > 0 ? "up" : ""}">${fmtPct(reward, 0)}</b></li>
            <li><span>Mission success</span><b class="${succ >= 0 ? "up" : "down"}">${fmtPct(succ, 0)}</b></li>
          </ul>
          <div class="muted-note">controls ${fac.domain.join(" · ")} · rival: ${rival}</div></div>`; }).join("") + `</div></div>`;

    const rIdx = id => RARITIES.findIndex(r => r.id === id);
    const accSorters = {
      value: (a, z) => z.item.value - a.item.value,
      price: (a, z) => a.price - z.price,
      rarity: (a, z) => rIdx(z.item.rarity) - rIdx(a.item.rarity),
    };
    const allAcc = b.accessories || [];
    const gFilt = this.bzFilt.gear;
    const gearTools = this.bzTools([
      ["Rarity", "filt.gear", gFilt, [["all", "All"], ...RARITIES.map(r => [r.id, r.label])]],
      ["Sort", "sort.gear", this.bzSort.gear, [["value", "Value"], ["price", "Price"], ["rarity", "Rarity"]]],
    ]);
    const acc = [...(gFilt === "all" ? allAcc : allAcc.filter(a => a.item.rarity === gFilt))]
      .sort(accSorters[this.bzSort.gear] || accSorters.value)
      .map(a => {
        const it = a.item;
        return `<div class="item buy" style="border-left-color:${this.rarityColor(it.rarity)}">
        <div class="item-top"><b>${it.name}</b><span class="rar" style="color:${this.rarityColor(it.rarity)}">${(Items.rarity(it.rarity) || {}).label}</span></div>
        <div class="item-stat">${Items.label(it)}</div>
        <div class="item-acts"><span class="item-val">${Util.credits(a.price)}c</span>
        <button class="btn btn-mini" data-buyacc="${a.id}">Buy</button></div></div>`;
      }).join("") || `<p class="muted-note">${allAcc.length ? "No gear matches this filter." : "Restocking the accessory stalls…"}</p>`;

    const invCost = Bazaar.upgradeInventoryCost();
    const openContracts = (b.contracts || []).filter(c => c.status === "open").length;

    // Each Bazaar area is its own sub-tab so the page never grows past one screen.
    const sections = {
      shipyard: `<div class="panel"><h2>Shipyard <small>transports & escort warships</small></h2><div class="buy-grid">${yard}</div></div>`,
      flagships: `<div class="panel"><h2>Flagships <small>your private main ship</small></h2><div class="buy-grid">${mains}</div></div>`,
      mercs: `<div class="panel"><h2>Mercenaries <small>rented firepower, time-limited</small></h2>${mercTools}<div class="buy-grid">${mercs}</div></div>`,
      contracts: `<div class="panel"><h2>Contract Board</h2>${contractTools}<div class="contract-list">${contracts}</div></div>`,
      gear: `<div class="panel"><h2>Accessory Market <small>names & stats vary — grab the good ones fast</small></h2>${gearTools}<div class="item-grid">${acc}</div></div>
             <div class="panel"><h2>Inventory Bay</h2><p>Capacity <b>${Bazaar.inventoryUsed()}/${Bazaar.capacity()}</b>. Expand by ${BAZAARCFG.inventoryUpgradeStep} slots.</p>
               <button class="btn btn-go" id="buy-inv">Upgrade — ${Util.credits(invCost)}c</button></div>`,
      standing,
    };
    const tabs = [["shipyard", "Shipyard"], ["flagships", "Flagships"], ["mercs", "Mercenaries"],
      ["contracts", "Contracts"], ["gear", "Gear"], ["standing", "Standing"]];
    if (!sections[this.bazaarTab]) this.bazaarTab = "shipyard";
    const subtabs = tabs.map(([k, label]) =>
      `<button class="subtab ${k === this.bazaarTab ? "active" : ""}" data-bz="${k}">${label}` +
      `${k === "contracts" && openContracts ? ` <span class="tab-badge">${openContracts}</span>` : ""}</button>`).join("");

    // preserve scroll position across the frequent re-renders (tick / purchases)
    const prev = this.refs.bazaarBody.querySelector(".bz-scroll");
    const keep = prev ? prev.scrollTop : 0;
    this.refs.bazaarBody.innerHTML =
      `<nav class="subtabs bz-subtabs">${subtabs}</nav>
       <div class="bz-scroll">${sections[this.bazaarTab]}</div>`;
    const ns = this.refs.bazaarBody.querySelector(".bz-scroll"); if (ns) ns.scrollTop = keep;
    this.refs.bazaarBody.onclick = e => this.onBazaarClick(e);
    this.refs.bazaarBody.onchange = e => this.onBazaarFilter(e);
  },

  // Bazaar filter/sort selects. data-bzf = "sort.<tab>" | "filt.<tab>".
  onBazaarFilter(e) {
    const sel = e.target.closest("[data-bzf]"); if (!sel) return;
    const [kind, tab] = sel.dataset.bzf.split(".");
    (kind === "sort" ? this.bzSort : this.bzFilt)[tab] = sel.value;
    this.renderBazaar();
  },

  onBazaarClick(e) {
    const t = e.target;
    const sub = t.closest("[data-bz]");
    if (sub) {
      this.bazaarTab = sub.dataset.bz; this.renderBazaar();
      const sc = this.refs.bazaarBody.querySelector(".bz-scroll"); if (sc) sc.scrollTop = 0;
      return;
    }
    const map = [["buyship", id => Bazaar.buyShip(id), "Ship purchased."],
      ["buymain", id => Bazaar.buyMain(id), "Flagship acquired."],
      ["hire", id => Bazaar.hireMerc(id), "Mercenary hired."],
      ["buyacc", id => Bazaar.buyAccessory(id), "Accessory bought."]];
    for (const [attr, fn, msg] of map) {
      const el = t.closest(`[data-${attr}]`);
      if (el) { const r = fn(el.dataset[attr.replace("buy", "buy")] || el.getAttribute(`data-${attr}`)); if (!r.ok) return this.toast(r.msg, "warn"); this.toast(msg, "good"); this.flashCredits(); window.Game.requestSave(); this.renderBazaar(); this.updateHeader(); return; }
    }
    const take = t.closest("[data-take]");
    if (take) {
      const r = Bazaar.takeContract(take.dataset.take);
      if (!r.ok) return this.toast(r.msg, "warn");
      if (r.tip) { this.toast("Insider tip secured 👀", "good"); this.flashCredits(); window.Game.requestSave(); this.renderBazaar(); return; }
      if (r.contract) { this.renderBazaar(); this.openMission(r.contract); }
      return;
    }
    if (t.closest("#buy-inv")) { const r = Bazaar.buyInventoryUpgrade(); if (!r.ok) return this.toast(r.msg, "warn"); this.toast("Inventory expanded.", "good"); this.flashCredits(); window.Game.requestSave(); this.renderBazaar(); }
  },

  // ===== systems ===========================================================
  renderSystems() {
    const s = this.s(); const ul = this.refs.systemList; ul.innerHTML = "";
    for (const sys of SYSTEMS) {
      const unlocked = s.unlockedSystems.includes(sys.id), here = s.currentSystem === sys.id && !s.travel;
      const li = this.el("li", "system" + (here ? " here" : "") + (unlocked ? "" : " locked"));
      const mods = Object.entries(sys.mods).map(([k, v]) => {
        const tip = v < 1 ? `${k}: ${((1 - v) * 100).toFixed(0)}% cheaper to buy here`
          : v > 1 ? `${k}: ${((v - 1) * 100).toFixed(0)}% pricier — good to sell here`
          : `${k}: average price`;
        return `<span class="mod ${v < 1 ? "cheap" : v > 1 ? "dear" : ""}" title="${tip}">${k} ${v.toFixed(2)}</span>`;
      }).join("");
      let action;
      if (!unlocked) action = `<button class="btn btn-mini" data-unlock="${sys.id}">Unlock ${Util.credits(sys.unlock)}c</button>`;
      else if (here) action = `<span class="badge">docked</span>`;
      else if (s.travel && s.travel.to === sys.id) action = `<span class="badge">arriving ${Util.duration(Economy.travelRemaining())}</span>`;
      else action = `<button class="btn btn-mini" data-dock="${sys.id}" ${s.travel ? "disabled" : ""}>Dock (${Util.duration(Fleet.dockTravelMs(s.currentSystem, sys.id))})</button>`;
      li.innerHTML = `<div class="system-head"><b>${sys.name}</b><span class="dist" title="distance from Navos Junction — sets docking travel time">dist ${sys.distance}</span>${action}</div><div class="mods">${mods}</div>`;
      ul.appendChild(li);
    }
    ul.onclick = e => {
      const u = e.target.closest("[data-unlock]"), d = e.target.closest("[data-dock]");
      if (u) { const r = Economy.unlockSystem(u.dataset.unlock); if (!r.ok) return this.toast(r.msg, "warn"); this.toast(`Unlocked ${this.sysName(u.dataset.unlock)}!`, "good"); this.flashCredits(); window.Game.requestSave(); this.renderSystems(); }
      else if (d) { const r = Economy.dockAt(d.dataset.dock); if (!r.ok) return this.toast(r.msg, "warn"); this.toast(`Departing for ${this.sysName(d.dataset.dock)} — ETA ${Util.duration(r.etaMs)}`, "good"); window.Game.requestSave(); this.renderSystems(); this.updateHeader(); this.updateExchange(); }
    };
  },

  // ===== milestones ========================================================
  renderAchievements() {
    const got = this.s().achievements;
    this.refs.achCount.textContent = `${got.length}/${ACHIEVEMENTS.length}`;
    this.refs.achList.innerHTML = ACHIEVEMENTS.map(a => { const have = got.includes(a.id);
      return `<li class="ach ${have ? "got" : ""}"><b>${have ? "★" : "☆"} ${a.name}</b><span>${a.desc}</span></li>`; }).join("");
  },

  // ===== BARONS / leaderboard ==============================================
  renderLeaderboard() {
    if (this.page !== "barons") return;
    const board = Rivals.board();
    const snap = (this.s().rivalsMeta || {}).snap;
    const rank = board.findIndex(r => r.you) + 1;
    this.refs.lbSub.textContent = `you sit #${rank} of ${board.length} — net worth is the only score that counts`;
    this.refs.lbList.innerHTML = board.map(r => {
      const fac = r.faction ? FACTIONS[r.faction] : null;
      const was = snap && snap.ranks ? snap.ranks[r.id] : null;
      const d = was == null ? 0 : was - r.rank;
      const arrow = d > 0 ? `<span class="lb-delta up">▲${d}</span>`
        : d < 0 ? `<span class="lb-delta down">▼${-d}</span>`
        : `<span class="lb-delta">·</span>`;
      const who = r.you
        ? `<b class="lb-name">You</b>`
        : `<b class="lb-name">${r.name}</b> <span class="lb-ep">${r.epithet}</span>`;
      const chip = fac ? `<span class="lb-fac" style="color:${fac.color}">◆ ${fac.name}</span>` : `<span class="lb-fac you">◆ your empire</span>`;
      return `<li class="lb-row ${r.you ? "lb-you" : ""}">
        <span class="lb-rank">#${r.rank}</span>
        <span class="lb-who">${who}${chip}</span>
        ${arrow}
        <span class="lb-nw">${Util.credits(r.netWorth)}c</span></li>`;
    }).join("");
  },

  // ===== broadcast / feed ==================================================
  setBroadcast({ channel, title, caption }) {
    const img = this.refs.bcFrame; img.onerror = () => { img.style.visibility = "hidden"; };
    img.style.visibility = "visible"; img.src = ASSET.broadcast(channel);
    this.refs.bcTitle.textContent = title; this.refs.bcCaption.textContent = caption;
  },
  showNews(entry) {
    this.setBroadcast({ channel: "news", title: entry.headline, caption: entry.body });
    const scr = document.getElementById("broadcast-screen");
    scr.classList.remove("klaxon"); void scr.offsetWidth; scr.classList.add("klaxon");
    this.refs.tickerText.textContent = `${(FACTIONS[entry.faction]?.name || "GBN")}: ${entry.headline} — ${entry.body}`;
    this.renderNewswire(); window.Game.audio("news");
  },
  renderNewswire() {
    this.refs.newswireList.innerHTML = this.s().newswire.map(n => { const f = FACTIONS[n.faction];
      return `<li class="wire ${n.dir}"><span class="wire-time">${Util.ago(n.ts)}</span>
        <span class="wire-faction" style="color:${f ? f.color : "#9aa"}">${f ? f.name : "GBN"}</span>
        <b>${n.headline}</b><span class="wire-body">${n.body}</span></li>`; }).join("") || "<li class='muted-note'>No bulletins yet.</li>";
  },
  addChat({ portrait, handle, text, kind }) {
    const ul = this.refs.feedList; const li = this.el("li", "msg msg-" + kind);
    const img = new Image(); img.src = ASSET.portrait(portrait); img.alt = ""; img.className = "pfp";
    img.onerror = () => { const b = this.el("div", "pfp tintbox", handle.slice(0, 1).toUpperCase()); img.replaceWith(b); };
    const body = this.el("div", "msg-body");
    const tag = kind === "omen" ? `<span class="tag tag-omen">tip</span>` : kind === "scam" ? `<span class="tag tag-scam">tip</span>` : kind === "reaction" ? `<span class="tag tag-react">live</span>` : kind === "rival" ? `<span class="tag tag-rival">rival</span>` : "";
    body.innerHTML = `<div class="msg-head"><span class="msg-handle">${handle}</span>${tag}</div><div class="msg-text"></div>`;
    body.querySelector(".msg-text").textContent = text;
    li.append(img, body); ul.appendChild(li);
    while (ul.children.length > CONFIG.chatMaxMessages) ul.removeChild(ul.firstChild);
    if (!this.feedPaused) ul.scrollTop = ul.scrollHeight;
  },

  toast(text, kind = "info", ms = 3200) {
    const t = this.el("div", "toast toast-" + kind, text); this.refs.toast.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, ms);
  },

  // ===== incidents =========================================================
  showIncident(incident) {
    this._incident = incident;
    this.refs.incIcon.textContent = incident.icon || "!";
    this.refs.incTitle.textContent = incident.title;
    this.refs.incText.textContent = (incident.text || "").replace(/\{SYS\}/g, this.sysName(this.s().currentSystem));
    this.refs.incChoices.innerHTML = incident.choices.map((c, i) =>
      `<button class="btn inc-choice" data-choice="${i}">${c.label}${c.chance != null ? ` <span class="inc-odds">${Math.round(c.chance * 100)}%</span>` : ""}</button>`).join("");
    this.refs.incChoices.classList.remove("hidden");
    this.refs.incResult.classList.add("hidden"); this.refs.incResult.innerHTML = "";
    this.refs.incClose.classList.add("hidden");
    this.refs.incChoices.onclick = e => { const b = e.target.closest("[data-choice]"); if (b) this.resolveIncident(parseInt(b.dataset.choice, 10)); };
    this.refs.incident.classList.remove("hidden");
  },
  resolveIncident(i) {
    const out = Incidents.resolve(this._incident, i);
    this.refs.incChoices.classList.add("hidden");
    const head = out.gamble ? `<b class="${out.won ? "up" : "down"}">${out.won ? "Success" : "Trouble"}</b> — ` : "";
    this.refs.incResult.innerHTML = head + out.summary;
    this.refs.incResult.classList.remove("hidden");
    this.refs.incClose.classList.remove("hidden");
    this.flashCredits(); window.Game.requestSave();
    if (this.page === "fleet") this.renderFleet();
    this.updateHeader();
  },

  // ===== while you were away ==============================================
  // Returns true if the modal was actually shown (so boot can sequence the
  // first-run tutorial after it).
  showWYWA({ elapsedMs, reports, sold, routed, orders }) {
    const routeTotal = (routed && routed.total) || 0;
    const fills = (orders || []).filter(e => e.type === "filled");
    if (elapsedMs < 60000 && !reports.length && !sold.length && !routeTotal && !fills.length) return false;
    let html = `<p>You were away <b>${Util.duration(elapsedMs)}</b>.</p>`;
    if (reports.length) {
      html += `<ul class="wywa-runs">` + reports.map(r => r.success
        ? `<li>${r.title}: <span class="up">success</span> +${Util.credits(r.credits)}c${r.items.length ? ` · ${r.items.length} item(s)` : ""}</li>`
        : `<li>${r.title}: <span class="down">failed</span>${r.lost.length ? ` · lost ${r.lost.length} ship(s)` : r.impounded.length ? ` · ${r.impounded.length} impounded` : ""}</li>`).join("") + `</ul>`;
    }
    if (routeTotal) html += `<p>Trade routes banked <b class="up">+${Util.credits(routeTotal)}c</b> across ${routed.runs.reduce((n, r) => n + r.cycles, 0)} deliveries.</p>`;
    if (fills.length) html += `<p>Standing orders filled: ${fills.map(f => `${f.side} ${f.qty} ${f.comm.name}`).join(", ")}.</p>`;
    if (sold.length) html += `<p>Market sales: ${sold.map(s => `${s.name} (+${Util.credits(s.price)}c)`).join(", ")}</p>`;
    if (!reports.length && !sold.length && !routeTotal && !fills.length) html += `<p>The market drifted while you were gone.</p>`;
    this.refs.wywaBody.innerHTML = html; this.refs.wywa.classList.remove("hidden");
    return true;
  },

  // ===== tutorial / help ===================================================
  openTutorial() {
    this.tutStep = 0;
    this.refs.tutorial.classList.remove("hidden");
    this.renderTutorial();
  },
  renderTutorial() {
    const steps = window.TUTORIAL_STEPS || [];
    const i = Util.clamp(this.tutStep, 0, steps.length - 1);
    const step = steps[i]; if (!step) return;
    this.refs.tutIcon.textContent = step.icon;
    this.refs.tutTitle.textContent = step.title;
    this.refs.tutBody.innerHTML = step.body;
    this.refs.tutDots.innerHTML = steps.map((_, k) =>
      `<span class="tut-dot ${k === i ? "on" : ""}"></span>`).join("");
    this.refs.tutBack.disabled = i === 0;
    const last = i === steps.length - 1;
    this.refs.tutNext.textContent = last ? "Got it ✓" : "Next ▸";
    this.refs.tutSkip.classList.toggle("hidden", last);
  },
  tutorialNext() {
    const steps = window.TUTORIAL_STEPS || [];
    if (this.tutStep >= steps.length - 1) return this.closeTutorial();
    this.tutStep++; this.renderTutorial();
  },
  tutorialBack() { if (this.tutStep > 0) { this.tutStep--; this.renderTutorial(); } },
  closeTutorial() {
    this.refs.tutorial.classList.add("hidden");
    if (!this.s().settings.tutorialSeen) { this.s().settings.tutorialSeen = true; window.Game.requestSave(); }
  },

  // ===== settings ==========================================================
  applySettings() {
    const set = this.s().settings;
    document.body.classList.toggle("muted", !!set.muted);
    document.body.classList.toggle("reduced", !!set.reduced);
    this.refs.setMute.checked = !!set.muted; this.refs.setReduced.checked = !!set.reduced;
    this.refs.setFastNews.checked = !!CONFIG.fastNews; this.refs.setFast.checked = (window.Game.timeScale || 1) > 1;
  },

  wireControls() {
    const r = this.refs;
    this.refs.tabs.onclick = e => { const t = e.target.closest(".tab"); if (t) this.showPage(t.dataset.page); };
    r.btnSettings.onclick = () => r.settings.classList.remove("hidden");
    r.setClose.onclick = () => r.settings.classList.add("hidden");
    r.btnHelp.onclick = () => this.openTutorial();
    r.tutNext.onclick = () => this.tutorialNext();
    r.tutBack.onclick = () => this.tutorialBack();
    r.tutSkip.onclick = () => this.closeTutorial();
    r.wywaClose.onclick = () => {
      r.wywa.classList.add("hidden");
      // first-run tutorial waits for the welcome-back modal to clear
      if (window.Game._tutorialPending) { window.Game._tutorialPending = false; this.openTutorial(); }
    };
    r.mmCancel.onclick = () => { this._pending = null; r.mission.classList.add("hidden"); };
    r.mmLaunch.onclick = () => this.launchMission();
    r.eqCancel.onclick = () => r.equip.classList.add("hidden");
    r.rtCancel.onclick = () => { this._routeShip = null; r.route.classList.add("hidden"); };
    r.incClose.onclick = () => r.incident.classList.add("hidden");
    r.rtStart.onclick = () => {
      const { comm, from, to } = this._routeSel();
      const res = Routes.start(this._routeShip, comm, from, to);
      if (!res.ok) return this.toast(res.msg, "warn");
      this.toast("Trade route started ▸", "good");
      this._routeShip = null; r.route.classList.add("hidden");
      window.Game.requestSave(); this.renderFleet();
    };

    r.setMute.onchange = () => { this.s().settings.muted = r.setMute.checked; this.applySettings(); window.Game.requestSave(); };
    r.setReduced.onchange = () => { this.s().settings.reduced = r.setReduced.checked; this.applySettings(); window.Game.requestSave(); };
    r.setFastNews.onchange = () => { CONFIG.fastNews = r.setFastNews.checked; Broadcast.start(); window.Game.scheduleLocalEvent(); window.Game.scheduleLocalFlavor(); };
    r.setFast.onchange = () => { window.Game.timeScale = r.setFast.checked ? 60 : 1; Broadcast.start(); window.Game.scheduleLocalEvent(); window.Game.scheduleLocalFlavor(); };
    r.setReset.onclick = () => { if (confirm("Wipe your Star Baron save and start over?")) window.Game.reset(); };

    r.btnPrestige.onclick = () => {
      if (!Economy.canPrestige()) return;
      if (!confirm(`Retire and sell the empire? You'll reset to Baron Tier ${this.s().prestige.tier + 1} with a permanent +${((this.s().prestige.tier + 1) * PRESTIGE.bonusPerTier * 100).toFixed(0)}% edge.`)) return;
      const res = Economy.prestige();
      if (res.ok) { this.toast(`Empire sold. Welcome to Baron Tier ${res.tier}.`, "good", 5000); this.fullRender(); }
    };

    this.refs.feedList.addEventListener("scroll", () => {
      const el = this.refs.feedList; this.feedPaused = el.scrollHeight - el.scrollTop - el.clientHeight > 40;
    });

    // Expanding the GBN newswire log takes over the sidebar and hides the chat.
    if (r.newswireDetails && r.colSide) {
      r.newswireDetails.addEventListener("toggle", () => {
        r.colSide.classList.toggle("news-open", r.newswireDetails.open);
      });
    }
  },

  wireBus() {
    Bus.on("chat", m => this.addChat(m));
    Bus.on("tv", m => { if (!Broadcast.newsLive()) this.setBroadcast(m); });
    Bus.on("news", n => this.showNews(n));
    Bus.on("achievement", a => { this.toast(`★ ${a.name} — ${a.desc}`, "good", 4500); if (this.page === "ach") this.renderAchievements(); window.Game.audio("good"); });
    Bus.on("missionDone", r => {
      if (window.Game._booting) return;
      this.toast(`${r.title}: ${r.success ? "SUCCESS +" + Util.credits(r.credits) + "c" : "FAILED"}`, r.success ? "good" : "bad", 5000);
      if (this.page === "fleet") this.renderFleet(); this.updateHeader(); this.audioSafe(r.success ? "good" : "news");
    });
    Bus.on("listingSold", sl => { this.toast(`Sold ${sl.name} on the market: +${Util.credits(sl.price)}c`, "buy"); if (this.page === "fleet") this.renderInventory(); });
    Bus.on("dock", d => { if (d.arrived) { this.toast(`Docked at ${this.sysName(d.sysId)}.`, "good"); this.updateExchange(); this.updateHeader(); this.renderSystems(); } });
    Bus.on("order", e => {
      if (e.type === "alert") this.toast(`⚐ ${e.comm.name} ${e.side === "below" ? "dropped to" : "rose to"} ${Util.price(e.price)}`, "info", 4500);
      else this.toast(`Order filled — ${e.side === "buy" ? "bought" : "sold"} ${e.qty} ${e.comm.name} @ ${Util.price(e.price)}`, e.side === "buy" ? "buy" : "good", 4500);
      if (this.page === "exchange") { this.renderOrders(); this.updateExchange(); }
      this.updateHeader();
    });
    Bus.on("war", e => {
      if (e.kind === "start") this.toast(`⚔ War breaks out: ${FACTIONS[e.war.a].name} vs ${FACTIONS[e.war.b].name}`, "warn", 5000);
      else if (e.kind === "end" && e.winner) this.toast(`Peace settles — ${FACTIONS[e.winner].name} prevailed.`, "info", 4500);
      this.renderWarBanner();
      if (this.page === "bazaar") this.renderBazaar();
    });
    Bus.on("rivalPass", e => {
      const r = Rivals.data(e.rival); if (!r) return;
      if (e.dir === "up") this.toast(`You overtook ${r.name} — now #${e.rank} on the board.`, "good", 4500);
      else this.toast(`${r.name} just passed you — down to #${e.rank}.`, "warn", 4500);
      this.updateHeader();
      if (this.page === "barons") this.renderLeaderboard();
    });
  },
  audioSafe(t) { try { window.Game.audio(t); } catch (e) {} },

  // ===== composite =========================================================
  tick() {
    this.updateExchange();
    this.updateHeader();
    this.updateClock();
    if (this.page === "fleet") { this.renderMissions(); this.renderRoutes(); }
    if (this.page === "exchange" && Orders.list().length) this.renderOrders();
    // skip the periodic re-render while a filter <select> is focused, so an open dropdown isn't nuked
    if (this.page === "bazaar") { const a = document.activeElement; if (!(a && a.classList && a.classList.contains("bz-filter"))) this.renderBazaar(); }
    if (this.page === "barons") this.renderLeaderboard();
    if (this.page === "systems" && this.s().travel) this.renderSystems();
  },

  fullRender() {
    this.buildExchange(); this.updateExchange(); this.updateHeader();
    this.renderSystems(); this.renderAchievements(); this.renderNewswire(); this.applySettings();
    if (this.page === "fleet") this.renderFleet();
    if (this.page === "bazaar") this.renderBazaar();
    if (this.page === "barons") this.renderLeaderboard();
  },
};

window.UI = UI;
