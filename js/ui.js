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
      navTrack: $("floatnav-track"), navIndicator: $("floatnav-indicator"),
      fleetMain: $("fleet-main"), fleetMissions: $("fleet-missions"),
      fleetRoutes: $("fleet-routes"), routesSub: $("routes-sub"),
      fleetReportsPanel: $("fleet-reports-panel"), fleetReports: $("fleet-reports"),
      fleetShips: $("fleet-ships"), fleetCount: $("fleet-count"),
      fleetInventory: $("fleet-inventory"), invCount: $("inv-count"),
      systemList: $("system-list"), bazaarBody: $("bazaar-body"),
      rank: $("hud-rank"), lbList: $("lb-list"), lbSub: $("lb-sub"), baronTrack: $("baron-track"),
      achList: $("ach-list"), achCount: $("ach-count"),
      indList: $("industry-list"), indCount: $("ind-count"),
      senateBody: $("senate-body"),
      senatorModal: $("senator-modal"), senatorCard: $("senator-card"), senatorClose: $("senator-close"),
      bcFrame: $("bc-frame"), bcTitle: $("bc-title"), bcCaption: $("bc-caption"),
      tickerText: $("ticker-text"), newswireList: $("newswire-list"),
      feedList: $("feed-list"), toast: $("toast-stack"),
      commsBadge: $("tab-comms-badge"),
      btnPrestige: $("btn-prestige"), btnSettings: $("btn-settings"), btnHelp: $("btn-help"),
      tutorial: $("tutorial-modal"), tutIcon: $("tut-icon"), tutTitle: $("tut-title"),
      tutBody: $("tut-body"), tutDots: $("tut-dots"), tutSkip: $("tut-skip"),
      tutBack: $("tut-back"), tutNext: $("tut-next"),
      wywa: $("wywa-modal"), wywaBody: $("wywa-body"), wywaClose: $("wywa-close"),
      mission: $("mission-modal"), mmTitle: $("mm-title"), mmBody: $("mm-body"),
      mmLaunch: $("mm-launch"), mmCancel: $("mm-cancel"),
      equip: $("equip-modal"), eqTitle: $("eq-title"), eqBody: $("eq-body"), eqCancel: $("eq-cancel"),
      route: $("route-modal"), rtTitle: $("rt-title"), rtBody: $("rt-body"), rtStart: $("rt-start"), rtCancel: $("rt-cancel"),
      survey: $("survey-modal"), svTitle: $("sv-title"), svBody: $("sv-body"), svStart: $("sv-start"), svCancel: $("sv-cancel"),
      incident: $("incident-modal"), incIcon: $("inc-icon"), incTitle: $("inc-title"), incText: $("inc-text"),
      incChoices: $("inc-choices"), incResult: $("inc-result"), incClose: $("inc-close"),
      ordComm: $("ord-comm"), ordKind: $("ord-kind"), ordPrice: $("ord-price"), ordQty: $("ord-qty"),
      ordAdd: $("ord-add"), ordersList: $("orders-list"),
      settings: $("settings-modal"), setMute: $("set-mute"), setReduced: $("set-reduced"),
      setFastNews: $("set-fastnews"), setFast: $("set-fast"), setReset: $("set-reset"), setClose: $("set-close"),
      langToggle: $("settings-modal") && $("settings-modal").querySelector(".lang-toggle"),
    };
    if (window.I18n) I18n.init();
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
    this.updateNavIndicator();
    if (name === "fleet") this.renderFleet();
    else if (name === "bazaar") this.renderBazaar();
    else if (name === "systems") this.renderSystems();
    else if (name === "barons") this.renderLeaderboard();
    else if (name === "ach") this.renderAchievements();
    else if (name === "industries") this.renderIndustries();
    else if (name === "senate") this.renderSenate();
    else if (name === "exchange") this.renderOrders();
    else if (name === "comms") { this.clearCommsBadge(); this.scrollFeedBottom(); }
  },

  // Pin the chat to the newest message (the feed lives in a hidden tab until
  // opened, so scrollHeight is only correct once it's visible — hence the rAF).
  scrollFeedBottom() {
    const el = this.refs.feedList; if (!el) return;
    this.feedPaused = false;
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  },

  // Unread indicator on the Comms tab (chat + news arrive while you're elsewhere).
  bumpComms() {
    if (this.page === "comms" || !this.refs.commsBadge) return;
    this._commsUnread = Math.min((this._commsUnread || 0) + 1, 99);
    this.refs.commsBadge.textContent = this._commsUnread;
    this.refs.commsBadge.classList.remove("hidden");
  },
  clearCommsBadge() {
    this._commsUnread = 0;
    if (this.refs.commsBadge) this.refs.commsBadge.classList.add("hidden");
  },

  // Slide the floating-nav indicator under the active tab and keep it in view
  // when the pill bar has to scroll horizontally (phones).
  updateNavIndicator() {
    const track = this.refs.navTrack, ind = this.refs.navIndicator;
    if (!track || !ind) return;
    const active = track.querySelector(".tab.active");
    if (!active) return;
    ind.style.width = active.offsetWidth + "px";
    ind.style.transform = `translateX(${active.offsetLeft}px)`;
    const target = active.offsetLeft - (track.clientWidth - active.offsetWidth) / 2;
    const max = track.scrollWidth - track.clientWidth;
    if (max > 0) {
      const reduced = !!(this.s().settings && this.s().settings.reduced);
      track.scrollTo({ left: Math.max(0, Math.min(target, max)), behavior: reduced ? "auto" : "smooth" });
    }
  },

  // ===== exchange ==========================================================
  buildExchange() {
    const body = this.refs.marketBody; body.innerHTML = ""; this.rows = {};
    for (const c of COMMODITIES) {
      const tr = this.el("tr"); tr.dataset.id = c.id;
      const icon = this.el("td", "ico");
      const img = new Image(); img.src = ASSET.commodity(c.id); img.alt = "";
      img.onerror = () => img.replaceWith(this.tintBox(c)); icon.appendChild(img);
      const risk = c.cat === "illicit" ? `<span class="risk-flag" title="illicit — customs may seize this if you dock while holding it">⚠</span>` : "";
      const name = this.el("td", "name", `${c.name}<span class="cat cat-${c.cat}">${c.cat}</span>${risk}`);
      const price = this.el("td", "num price"), chg = this.el("td", "num chg"), trend = this.el("td", "trend");
      const held = this.el("td", "num held"), pnl = this.el("td", "num pnl"), act = this.el("td", "actions");
      const T = k => (window.I18n ? I18n.t(k) : k);
      act.innerHTML = `<div class="qrow">
        <input type="number" class="qin" min="1" value="10" aria-label="qty ${c.name}" />
        <button class="btn btn-buy" data-act="buy">${T("btn.buy")}</button>
        <button class="btn btn-sell" data-act="sell">${T("btn.sell")}</button>
        <button class="btn btn-mini" data-act="max">${T("btn.buyMax")}</button>
        <button class="btn btn-mini" data-act="all">${T("btn.sellAll")}</button></div>`;
      tr.append(icon, name, price, chg, trend, held, pnl, act);
      body.appendChild(tr);
      const qin = act.querySelector(".qin");
      qin.addEventListener("input", () => this.updateAfford(c.id));
      this.rows[c.id] = { tr, price, chg, trend, held, pnl, qin,
        buyBtn: act.querySelector('[data-act="buy"]'), maxBtn: act.querySelector('[data-act="max"]') };
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
    const tm = document.getElementById("trade-modal");
    if (tm && !tm.classList.contains("hidden")) return;   // terminal already open → ignore (anti-spam)
    const r = side === "buy" ? Economy.buy(id, qty) : Economy.sell(id, qty);
    if (!r.ok) { this.toast(r.msg, "warn"); return; }
    window.Game.save();                               // the trade is committed — persist to storage immediately
    this.playTradeAnim(side, COMMODITIES.find(c => c.id === id), r);
  },

  // a deliberately-paced "trade terminal" — flavour + an anti-spam gate: the modal
  // backdrop blocks the buy/sell buttons until the player closes it.
  playTradeAnim(side, comm, r) {
    const $ = id => document.getElementById(id);
    const modal = $("trade-modal"), log = $("trade-log"), barWrap = $("trade-bar-wrap"),
      bar = $("trade-bar"), result = $("trade-result"), close = $("trade-close"), title = $("trade-title");
    const refresh = () => { this.flashCredits(); this.updateHeader(); this.updateExchange(); };
    if (!modal || !log) { refresh(); return; }        // no terminal in DOM → just settle silently
    (this._tradeTimers || []).forEach(clearTimeout); this._tradeTimers = [];
    const isBuy = side === "buy", total = isBuy ? r.cost : r.proceeds, unit = r.qty === 1 ? "share" : "shares";
    title.textContent = isBuy ? "Purchase Order" : "Sell Order";
    log.innerHTML = ""; result.innerHTML = ""; result.classList.add("hidden");
    barWrap.classList.add("hidden"); bar.style.width = "0%"; close.classList.add("hidden");
    modal.classList.remove("hidden");
    const reduced = !!(this.s().settings && this.s().settings.reduced), step = reduced ? 220 : 600;
    const lines = [
      `▸ Opening secure channel to the ${comm.name} exchange…`,
      `▸ Sending request to ${isBuy ? "purchase" : "sell"} ${r.qty} ${unit} of ${comm.name}…`,
      `▸ Locking in ${isBuy ? "ask" : "bid"} price at ${Util.price(r.price)}c / share…`,
    ];
    let t = 0;
    for (const ln of lines) { const at = t; this._tradeTimers.push(setTimeout(() => this._tradeLine(log, ln), at)); t += step; }
    this._tradeTimers.push(setTimeout(() => {
      this._tradeLine(log, isBuy ? `▸ Transferring ${Util.credits(total)}c…` : `▸ Settling ${Util.credits(total)}c in proceeds…`);
      barWrap.classList.remove("hidden");
      requestAnimationFrame(() => { bar.style.width = "100%"; });
    }, t));
    t += reduced ? 320 : 900;
    this._tradeTimers.push(setTimeout(() => {
      if (!isBuy && r.tax) this._tradeLine(log, `▸ Baron tax withheld: ${Util.credits(r.tax)}c (${(Economy.baronTax() * 100).toFixed(0)}%)…`);
      this._tradeLine(log, `✓ ${isBuy ? "Purchase" : "Sale"} complete.`);
      const pnl = (!isBuy && typeof r.realized === "number")
        ? ` · <span class="${r.realized >= 0 ? "up" : "down"}">${r.realized >= 0 ? "+" : ""}${Util.credits(r.realized)}c</span>` : "";
      const taxNote = (!isBuy && r.tax) ? ` · <span class="down">−${Util.credits(r.tax)}c tax</span>` : "";
      result.innerHTML = `<b>${isBuy ? "Bought" : "Sold"} ${r.qty} ${comm.name}</b> @ ${Util.price(r.price)}c = <b>${Util.credits(total)}c</b>${pnl}${taxNote}` +
        `<br><span class="muted-note">New balance: ${Util.creditsFull(this.s().credits)}c</span>`;
      result.classList.remove("hidden"); close.classList.remove("hidden");
      refresh();                                       // reveal the new balance at the "complete" beat
    }, t));
    close.onclick = () => modal.classList.add("hidden");
  },
  _tradeLine(log, text) {
    const div = document.createElement("div"); div.className = "tt-line"; div.textContent = text;
    log.appendChild(div); log.scrollTop = log.scrollHeight;
  },

  updateExchange() {
    const sys = this.s().currentSystem;
    const sysName = this.sysName(sys);
    this.refs.exchangeSub.textContent = (window.I18n && I18n.lang === "jp")
      ? `· ${sysName} ${I18n.t("exchange.pricesAt")}` : `· ${window.I18n ? I18n.t("exchange.pricesAt") : "prices at"} ${sysName}`;
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
      this.updateAfford(c.id);
    }
    this.renderWarBanner();
  },

  // Disable Buy when you can't afford the requested quantity, and Buy Max when
  // you can't afford a single share (also covers negative credits and bans —
  // maxBuy returns 0 in those cases). maxBuy>=qty is exactly Economy.buy's guard.
  updateAfford(id) {
    const r = this.rows[id]; if (!r || !r.buyBtn) return;
    const affordN = Economy.maxBuy(id);
    const qty = Math.floor(parseInt(r.qin.value, 10) || 0);
    r.buyBtn.disabled = !(qty > 0 && affordN >= qty);
    r.maxBtn.disabled = affordN < 1;
  },

  // Disable any purchase button (marked with data-cost) the player can't afford.
  markUnaffordable(container) {
    if (!container) return;
    const credits = this.s().credits;
    for (const btn of container.querySelectorAll("[data-cost]")) btn.disabled = (+btn.dataset.cost || 0) > credits;
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
      this.refs.ordersList.innerHTML = `<li class="muted-note">${window.I18n ? I18n.t("orders.empty") : "No standing orders. Set a buy-below, sell-above, or price alert — they fire automatically while you're docked here."}</li>`;
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
    this.refs.credits.textContent = Util.creditsFull(s.credits);
    this.refs.networth.textContent = Util.creditsFull(Economy.netWorth());
    if (this.refs.rank && window.Rivals) this.refs.rank.textContent = `#${Rivals.rank()} / ${Rivals.count()}`;
    this.refs.system.textContent = s.travel ? `→ ${this.sysName(s.travel.to)} (${Util.duration(Economy.travelRemaining())})` : this.sysName(s.currentSystem);
    this.refs.tier.textContent = Economy.tierTitle();
    const sent = Market.sentiment(), pct = (sent + 1) / 2 * 100;
    this.refs.sentiment.style.width = pct.toFixed(0) + "%";
    this.refs.sentiment.style.background = sent >= 0 ? "var(--up)" : "var(--down)";
    const canAscend = Economy.canPrestige(), nextT = Economy.nextTier();
    this.refs.btnPrestige.classList.toggle("hidden", !canAscend);
    if (canAscend && nextT) this.refs.btnPrestige.textContent = `Ascend ▸ ${nextT.title}`;
    const missionsN = s.missions.length, reportsN = s.reports.length;
    const badge = this.refs.fleetBadge;
    if (missionsN + reportsN > 0) { badge.classList.remove("hidden"); badge.textContent = missionsN + reportsN; }
    else badge.classList.add("hidden");
    if (this.page === "fleet") this.updateNavIndicator();   // badge changes the active pill's width
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
    const routes = Routes.list();
    this.refs.routesSub.textContent = routes.length ? `${routes.length} running` : "";
    if (!routes.length) {
      this.refs.fleetRoutes.innerHTML = `<p class="muted-note">No trade routes. Put one or more idle ships on a buy-low → sell-high loop with “⇄ Set route” — they pool cargo and bank the spread while you're away.</p>`;
      this.refs.fleetRoutes.onclick = null; return;
    }
    this.refs.fleetRoutes.innerHTML = routes.map(route => {
      const e = Routes.estimate(route), ships = Routes.shipsOf(route);
      const cn = (COMMODITIES.find(c => c.id === route.comm) || {}).name || route.comm;
      const eta = Math.max(0, route.nextAt - Date.now());
      return `<div class="route"><div class="route-head"><b>${ships.length} ship${ships.length > 1 ? "s" : ""}</b>
          <span class="route-leg">${cn}: ${this.sysName(route.from)} → ${this.sysName(route.to)}</span>
          <button class="btn btn-mini" data-stoproute="${route.id}">Stop</button></div>
        <div class="route-ships">${ships.map(s => s.name).join(", ")}</div>
        <div class="route-foot"><b class="${e.profit > 0 ? "up" : "down"}">${Util.credits(e.profit)}c</b>/trip ·
          ~${Util.credits(Math.round(e.perHour))}c/hr · cargo ${e.cargo} · <span class="muted-note">next ${Util.duration(eta)}</span></div></div>`;
    }).join("");
    this.refs.fleetRoutes.onclick = ev => {
      const st = ev.target.closest("[data-stoproute]"); if (!st) return;
      Routes.stop(st.dataset.stoproute); this.toast("Route stopped — ships idle.", "info");
      window.Game.requestSave(); this.renderFleet();
    };
  },

  openRoute(shipUid) {
    this.refs.rtTitle.textContent = "New trade route";
    const unlocked = SYSTEMS.filter(s => this.s().unlockedSystems.includes(s.id));
    const idle = Fleet.idle().filter(sh => !sh.mercenary);
    if (unlocked.length < 2) {
      this.refs.rtBody.innerHTML = `<p class="down">Unlock at least two systems first (Star Systems tab).</p>`;
      this.refs.rtStart.disabled = true; this.refs.route.classList.remove("hidden"); return;
    }
    if (!idle.length) {
      this.refs.rtBody.innerHTML = `<p class="down">No idle ships available.</p>`;
      this.refs.rtStart.disabled = true; this.refs.route.classList.remove("hidden"); return;
    }
    const opts = (list, val) => list.map(o => `<option value="${o.id}"${o.id === val ? " selected" : ""}>${o.name}</option>`).join("");
    const from0 = unlocked[0].id, to0 = unlocked[1].id;
    const shipRows = idle.map(sh => { const st = Fleet.stats(sh);
      return `<label class="rt-ship"><input type="checkbox" data-rtship="${sh.uid}"${sh.uid === shipUid ? " checked" : ""}/> <b>${sh.name}</b> <span class="cls-tag">${Fleet.shipDef(sh.type).cls}</span> ▣ ${st.cargo} » ${st.speed}</label>`;
    }).join("");
    this.refs.rtBody.innerHTML =
      `<div class="rt-form">
         <label>Commodity <select id="rt-comm">${opts(COMMODITIES, COMMODITIES[0].id)}</select></label>
         <label>Buy at <select id="rt-from">${opts(unlocked, from0)}</select></label>
         <label>Sell at <select id="rt-to">${opts(unlocked, to0)}</select></label>
       </div>
       <p class="muted-note">Pick the ships to run this loop — their cargo pools and they move at the slowest one's speed.</p>
       <div class="rt-ships">${shipRows}</div>
       <div class="mm-calc" id="rt-calc"></div>`;
    this.refs.rtBody.querySelectorAll("select, input[data-rtship]").forEach(el => el.onchange = () => this.updateRouteCalc());
    this.updateRouteCalc();
    this.refs.route.classList.remove("hidden");
  },
  selectedRouteShips() { return [...this.refs.rtBody.querySelectorAll("input[data-rtship]:checked")].map(c => c.dataset.rtship); },
  _routeSel() {
    const q = id => (this.refs.rtBody.querySelector(id) || {}).value;
    return { comm: q("#rt-comm"), from: q("#rt-from"), to: q("#rt-to") };
  },
  updateRouteCalc() {
    const calc = document.getElementById("rt-calc"); if (!calc) return;
    const { comm, from, to } = this._routeSel();
    const ships = this.selectedRouteShips();
    if (from === to) { calc.innerHTML = `<span class="down">Pick two different systems.</span>`; this.refs.rtStart.disabled = true; return; }
    if (!ships.length) { calc.innerHTML = `<span class="down">Select at least one ship.</span>`; this.refs.rtStart.disabled = true; return; }
    const e = Routes.preview(ships, comm, from, to);
    const cn = (COMMODITIES.find(c => c.id === comm) || {}).name || comm;
    calc.innerHTML =
      `Pooled cargo <b>${e.cargo}</b> · buy ${cn} @ <b>${Util.price(e.buy)}</b> · sell @ <b>${Util.price(e.sell)}</b> · spread <b class="${e.spread > 0 ? "up" : "down"}">${Util.price(e.spread)}</b><br>` +
      `round trip ~${Util.duration(e.cycleMs)} · <b class="${e.profit > 0 ? "up" : "down"}">${Util.credits(e.profit)}c</b>/trip · ~<b>${Util.credits(Math.round(e.perHour))}c/hr</b>`;
    this.refs.rtStart.disabled = e.profit <= 0;
  },

  // ---- anomaly survey (Star Map) -----------------------------------------
  openSurvey(sysId) {
    this._surveySys = sysId;
    const sys = Galaxy.get(sysId);
    this.refs.svTitle.textContent = `Survey ${sys ? sys.name : "system"}`;
    const idle = Fleet.idle().filter(sh => !sh.mercenary);
    if (!idle.length) {
      this.refs.svBody.innerHTML = `<p class="down">No idle ships — recall one from a mission, route, or repair it first.</p>`;
      this.refs.svStart.disabled = true; this.refs.survey.classList.remove("hidden"); return;
    }
    const far = Expeditions.isFar(sysId);
    const rows = idle.map((sh, i) => {
      const st = Fleet.stats(sh), eta = Expeditions.durationFor(sysId, sh.uid);
      return `<label class="rt-ship"><input type="radio" name="sv-ship" data-svship="${sh.uid}"${i === 0 ? " checked" : ""}/> <b>${sh.name}</b> <span class="cls-tag">${Fleet.shipDef(sh.type).cls}</span> » ${st.speed} · ETA ~${Util.duration(eta)}</label>`;
    }).join("");
    this.refs.svBody.innerHTML =
      `<p class="muted-note">Dispatch one ship to survey this uncharted outpost. It resolves on its own — even while you're away — into salvage, gear, a tradeable price tip, or trouble.</p>
       <p class="si-effects"><span class="local-effect ${far ? "down" : "up"}">${far ? "⚠ Far & rough — better finds, but real hazard to the hull (rarely fatal)." : "Nearby — modest finds, low hazard."}</span></p>
       <div class="rt-ships">${rows}</div>`;
    this.refs.svStart.disabled = false;
    this.refs.survey.classList.remove("hidden");
  },
  selectedSurveyShip() { const el = this.refs.svBody.querySelector("input[data-svship]:checked"); return el ? el.dataset.svship : null; },

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
    else if (sh.status === "surveying") status = `<span class="badge">surveying</span>`;
    else status = `<span class="badge idle">idle</span>`;
    const dmg = sh.dmg || 0;
    const hullPct = Math.round((1 - dmg) * 100);
    if (dmg) status += ` <span class="badge ${hullPct < 40 ? "bad" : "merc"}" title="damaged — firepower & speed suffer until repaired">hull ${hullPct}%</span>`;
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
    const repairBtn = sh.status === "idle" && dmg
      ? `<button class="btn btn-mini" data-repair="${sh.uid}" title="restores hull, firepower and speed">🔧 Repair ${Util.credits(Fleet.repairCost(sh))}c</button>` : "";
    return `<div class="ship cls-${def.cls}">
      <img src="${sprite}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tintbox',textContent:'${def.name[0]}'}))"/>
      <div class="ship-info">
        <div class="ship-name">${sh.name} ${status} ${merc}</div>
        <div class="ship-route">${def.name} · <span class="cls-tag">${def.cls}</span> · slots ${used}/${slots}</div>
        <div class="statline">${this.statChips(st)}</div>
        <div class="acc-row">${acc}${equipBtn}${repairBtn}${routeBtn}${sellBtn}</div>
      </div></div>`;
  },

  onFleetClick(e) {
    const un = e.target.closest("[data-unequip]"); const eq = e.target.closest("[data-equip-ship]");
    const rt = e.target.closest("[data-retrieve]"); const sl = e.target.closest("[data-sellship]");
    const ro = e.target.closest("[data-route-ship]"); const rp = e.target.closest("[data-repair]");
    if (un) { const [shipU, itemU] = un.dataset.unequip.split(":"); Fleet.unequip(shipU, itemU); window.Game.requestSave(); this.renderFleet(); }
    else if (eq) { this.openEquipForShip(eq.dataset.equipShip); }
    else if (ro) { this.openRoute(ro.dataset.routeShip); }
    else if (rp) { const r = Fleet.repair(rp.dataset.repair); if (!r.ok) return this.toast(r.msg, "warn"); this.toast(`Hull patched for ${Util.credits(r.cost)}c.`, "good"); this.flashCredits(); window.Game.requestSave(); this.renderFleet(); }
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
      if (r.type === "survey") {
        detail = `<span class="${r.success ? "up" : "down"}">🛰 ${r.summary}</span>`;
        if ((r.damaged || []).length) detail += ` · 🔧 ${r.damaged.map(x => `${x.name} −${x.pct}%`).join(", ")}`;
        return `<div class="report ${r.success ? "ok" : "bad"}"><div><b>${r.title}</b><div class="rep-detail">${detail}</div></div>
          <button class="btn btn-mini" data-dismiss="${r.uid}">Dismiss</button></div>`;
      }
      if (r.success) {
        detail = `<span class="up">SUCCESS</span> · +${Util.credits(r.credits)}c`;
        if (r.stock) detail += ` · +${r.stock.qty} ${r.stock.name}`;
        if (r.items.length) detail += ` · ${r.items.length} item${r.items.length > 1 ? "s" : ""} won`;
        if (r.lost.length) detail += ` · <span class="down">lost ${r.lost.map(x => x.name).join(", ")}</span>`;
      } else {
        detail = r.wipe ? `<span class="down">FAILED — all ships destroyed</span>` : `<span class="down">FAILED</span>`;
        if (r.lost.length && !r.wipe) detail += ` · lost ${r.lost.map(x => x.name).join(", ")}`;
        if (r.impounded.length) detail += ` · ${r.impounded.length} ship(s) impounded — pay in Owned Ships to retrieve`;
        if (!r.lost.length && !r.impounded.length) detail += ` · ships returned safely`;
      }
      if ((r.damaged || []).length) detail += ` · 🔧 ${r.damaged.map(x => `${x.name} −${x.pct}%`).join(", ")}`;
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
      <button class="btn btn-go" data-buyship="${def.id}" data-cost="${Math.round((def.price || 0) * (1 - Rep.discount()))}">${def.price ? Util.credits(def.price) + "c" : "Free"}</button></div>`;

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
        ${owned ? `<span class="badge">current flagship</span>` : `<button class="btn btn-go" data-buymain="${d.id}" data-cost="${Math.round((d.price || 0) * (1 - Rep.discount()))}">${d.price ? Util.credits(d.price) + "c" : "Free"}</button>`}</div>`;
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
        <button class="btn btn-go" data-hire="${m.id}" data-cost="${m.hireCost}">Hire ${Util.credits(m.hireCost)}c</button></div>`).join("") || `<p class="muted-note">No mercenaries on offer right now.</p>`;

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
        <button class="btn btn-go" data-take="${c.id}" data-cost="${c.cost}">Buy tip ${Util.credits(c.cost)}c</button></div></div>`;
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
        <button class="btn btn-mini" data-buyacc="${a.id}" data-cost="${Math.round(a.price * (1 - Rep.discount()))}">Buy</button></div></div>`;
      }).join("") || `<p class="muted-note">${allAcc.length ? "No gear matches this filter." : "Restocking the accessory stalls…"}</p>`;

    const exo = (b.extractors || []).map(o => {
      const t = EXTRACTORCFG.types[o.ex.type], price = Math.round(o.price * (1 - Rep.discount()));
      return `<div class="item buy ext-${o.ex.type}">
        <div class="item-top"><b>${o.ex.name}</b><span class="rar">${t.label} ×${t.yieldMult}</span></div>
        <div class="item-stat">${Extractors.describe(o.ex)}</div>
        <div class="item-acts"><span class="item-val">${Util.credits(price)}c</span>
        <button class="btn btn-mini" data-buyextractor="${o.id}" data-cost="${price}">Buy</button></div></div>`;
    }).join("") || `<p class="muted-note">No extractors in stock — check back soon.</p>`;

    const comp = (b.components || []).map(o => {
      const col = this.rarityColor(o.comp.rarity), price = Math.round(o.price * (1 - Rep.discount()));
      return `<div class="item buy" style="border-left-color:${col}">
        <div class="item-top"><b>${o.comp.name}</b><span class="rar" style="color:${col}">${(Items.rarity(o.comp.rarity) || {}).label}</span></div>
        <div class="item-stat">${Components.describe(o.comp)}</div>
        <div class="item-acts"><span class="item-val">${Util.credits(price)}c</span>
        <button class="btn btn-mini" data-buycomponent="${o.id}" data-cost="${price}">Buy</button></div></div>`;
    }).join("") || `<p class="muted-note">No components in stock.</p>`;

    const dossiers = !window.Senate ? "" : ((b.dossiers || []).map(d => {
      const price = Math.round(d.price * (1 - Rep.discount()));
      return `<div class="contract tip"><div class="c-head"><b>${d.name}</b><span class="ctype">dossier</span></div>
        <div class="c-desc">${d.title} · <span style="color:${Senate.blocColor(d.bloc)}">◆ ${Senate.blocName(d.bloc)}</span> · ${d.systemName}</div>
        <div class="c-foot"><span class="muted-note">unlocks their stances &amp; voting record</span>
        <button class="btn btn-go" data-buydossier="${d.id}" data-cost="${price}">Buy dossier ${Util.credits(price)}c</button></div></div>`;
    }).join("") || `<p class="muted-note">No dossiers for sale right now.</p>`);

    const invCost = Bazaar.upgradeInventoryCost();
    const openContracts = (b.contracts || []).filter(c => c.status === "open").length;

    // Each Bazaar area is its own sub-tab so the page never grows past one screen.
    const sections = {
      shipyard: `<div class="panel"><h2>Shipyard <small>transports & escort warships</small></h2><div class="buy-grid">${yard}</div></div>`,
      flagships: `<div class="panel"><h2>Flagships <small>your private main ship</small></h2><div class="buy-grid">${mains}</div></div>`,
      mercs: `<div class="panel"><h2>Mercenaries <small>rented firepower, time-limited</small></h2>${mercTools}<div class="buy-grid">${mercs}</div></div>`,
      contracts: `<div class="panel"><h2>Contract Board</h2>${contractTools}<div class="contract-list">${contracts}</div></div>`
        + `<div class="panel"><h2>Senator Dossiers <small>unlock hidden stances &amp; voting records</small></h2><div class="contract-list">${dossiers}</div></div>`,
      gear: `<div class="panel"><h2>Accessory Market <small>names & stats vary — grab the good ones fast</small></h2>${gearTools}<div class="item-grid">${acc}</div></div>
             <div class="panel"><h2>Inventory Bay</h2><p>Capacity <b>${Bazaar.inventoryUsed()}/${Bazaar.capacity()}</b>. Expand by ${BAZAARCFG.inventoryUpgradeStep} slots.</p>
               <button class="btn btn-go" id="buy-inv" data-cost="${invCost}">Upgrade — ${Util.credits(invCost)}c</button></div>`,
      extractors: `<div class="panel"><h2>Extractors <small>install on a planet permit (Industries) to mine &amp; manufacture</small></h2><div class="item-grid">${exo}</div></div>
             <div class="panel"><h2>Components <small>fit into an extractor to boost yield / cut cycle time</small></h2><div class="item-grid">${comp}</div></div>`,
      standing,
    };
    const tabs = [["shipyard", "Shipyard"], ["flagships", "Flagships"], ["mercs", "Mercenaries"],
      ["contracts", "Contracts"], ["gear", "Gear"], ["extractors", "Extractors"], ["standing", "Standing"]];
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
    this.markUnaffordable(this.refs.bazaarBody);
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
      ["buyacc", id => Bazaar.buyAccessory(id), "Accessory bought."],
      ["buyextractor", id => Bazaar.buyExtractor(id), "Extractor acquired — install it in Industries."],
      ["buycomponent", id => Bazaar.buyComponent(id), "Component acquired — fit it to an extractor in Industries."],
      ["buydossier", id => Bazaar.buyDossier(id), "Dossier filed — read it in the Senate roster."]];
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
    const ul = this.refs.systemList; if (!ul) return;   // Star Systems tab removed — travel/unlock live in the Star Map
    const s = this.s(); ul.innerHTML = "";
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
      if (!unlocked) action = `<button class="btn btn-mini" data-unlock="${sys.id}" data-cost="${sys.unlock}">Unlock ${Util.credits(sys.unlock)}c</button>`;
      else if (here) action = `<span class="badge">docked</span>`;
      else if (s.travel && s.travel.to === sys.id) action = `<span class="badge">arriving ${Util.duration(Economy.travelRemaining())}</span>`;
      else action = `<button class="btn btn-mini" data-dock="${sys.id}" ${s.travel ? "disabled" : ""}>Dock (${Util.duration(Fleet.dockTravelMs(s.currentSystem, sys.id))})</button>`;
      li.innerHTML = `<div class="system-head"><b>${sys.name}</b><span class="dist" title="distance from Navos Junction — sets docking travel time">dist ${sys.distance}</span>${action}</div><div class="mods">${mods}</div>`;
      ul.appendChild(li);
    }
    this.markUnaffordable(ul);
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

  // ===== industries ========================================================
  renderIndustries() {
    const list = Industries.list();
    const storage = Extractors.unequipped().length;
    this.refs.indCount.textContent = `${list.length}/${INDUSTRYCFG.maxPerPlayer} permits${storage ? ` · ${storage} extractor${storage > 1 ? "s" : ""} in storage` : ""}`;
    if (!list.length) {
      this.refs.indList.innerHTML = `<p class="muted-note">No permits yet. Open the <b>Star Map</b>, click a planet, buy a permit, then install an extractor (from the Bazaar) — it produces into your tradeable stock while you're away.</p>`;
      this.refs.indList.onclick = null; return;
    }
    this.refs.indList.innerHTML = list.map(ind => {
      const sys = Galaxy.get(ind.systemId), planet = sys && sys.planets[ind.planetIdx];
      const where = planet ? planet.name : ind.systemId;
      const st = Industries.status(ind);
      const facId = planet ? Industries.planetFaction(sys, planet) : null, fac = facId ? FACTIONS[facId] : null;
      const owner = `<span class="ind-fac" style="color:${fac ? fac.color : "var(--accent2)"}">◆ ${fac ? fac.name : "Navos"}</span>`;
      const head = `<div class="ind-head"><b>${where}</b><span class="ind-stat ind-${st.replace(/ /g, "-")}">${st}${st === "boom" ? ` ×${INDUSTRYCFG.warBoost}` : ""}</span><button class="btn btn-mini" data-demolish="${ind.id}">Close</button></div>`;
      if (!ind.extractorUid) {
        return `<div class="industry">${head}<div class="ind-foot">permit held — open the planet (Star Map) to install an extractor · ${owner}</div></div>`;
      }
      const comm = COMMODITIES.find(c => c.id === ind.commodity), name = comm ? comm.name : ind.commodity;
      const b = Industries.batch(ind), ex = Extractors.get(ind.extractorUid);
      const halted = st === "struck" || st === "disrupted";
      const next = halted ? `<span class="down">halted</span>` : Util.duration(Math.max(0, ind.nextAt - Date.now()));
      const warn = st === "at risk" ? `<div class="ind-warn">⚠ standing collapsing — works seized at ${INDUSTRYCFG.destroyRep}</div>` : "";
      return `<div class="industry">${head}<div class="ind-foot">${ex ? ex.name + " → " : ""}≈ <b>${b.net}</b> ${name}/12h <span class="muted-note">(${(b.rate * 100).toFixed(0)}% tax)</span> · next ${next} · ${owner}</div>${warn}</div>`;
    }).join("");
    this.refs.indList.onclick = e => {
      const d = e.target.closest("[data-demolish]"); if (!d) return;
      Industries.demolish(d.dataset.demolish); this.toast("Permit closed.", "info");
      window.Game.requestSave(); this.renderIndustries(); this.updateHeader();
    };
  },

  // ===== SENATE / space politics ===========================================
  issueLabel(key) { return (SENATE_ISSUES.find(i => i.key === key) || {}).label || key; },

  renderSenate() {
    if (!window.Senate) { this.refs.senateBody.innerHTML = `<div class="panel"><p class="muted-note">Senate unavailable.</p></div>`; return; }
    this.senateFilt ||= { sector: "all", bloc: "all", q: "" };
    const now = Date.now();
    const roster = Senate.roster(), active = Senate.activeEdicts(now), upcoming = Senate.upcomingBills(now);
    const next = upcoming[0] || null, p = Senate.pending(), tier = Senate.tier();
    const senate = Senate.sen();

    // ---- floor / influence ----
    const lobbyGated = !Senate.can("lobby");
    let floor = `<button class="btn btn-go" data-sn="chamber">🏛 Enter the Chamber</button>`;
    if (next) {
      const facBtns = Object.keys(FACTIONS).map(f =>
        `<button class="btn btn-mini" data-sn="lobby" data-v="${f}" ${lobbyGated ? "disabled" : ""} title="rallies ${FACTIONS[f].name}; hardens ${FACTIONS[FACTIONS[f].rival].name} against you">Lobby ${FACTIONS[f].name} · ${Util.credits(Senate._lobbyCost(f))}c</button>`).join("");
      const tu = Senate.targetsUsed(p), mt = Senate.maxTargets();
      const queued = [];
      if (Object.keys(p.pushFac).length) queued.push(`lobbied ${Object.keys(p.pushFac).length} bloc(s)`);
      if (Object.keys(p.pushSen).length) queued.push(`bribed ${Object.keys(p.pushSen).length}`);
      if (Object.keys(p.coerce).length) queued.push(`coerced ${Object.keys(p.coerce).length}`);
      floor += `<div class="bill on-floor">
        <div class="bill-head"><b>${next.title}</b><span class="bill-eta">votes in ${Util.duration(Math.max(0, next.votesAt - now))}</span></div>
        <div class="bill-blurb">${next.blurb}</div>
        <div class="bill-issue muted-note">issue: ${this.issueLabel(next.issue)}</div>
        <div class="influence">
          <div class="want-row"><span>Your position:</span>
            <button class="btn btn-mini ${p.want === "pass" ? "sel up" : ""}" data-sn="want" data-v="pass">Back it</button>
            <button class="btn btn-mini ${p.want === "block" ? "sel down" : ""}" data-sn="want" data-v="block">Block it</button>
            ${p.want ? `<span class="muted-note">you want this to <b>${p.want === "pass" ? "pass" : "fail"}</b></span>` : `<span class="muted-note">declare a side to lobby or bribe</span>`}</div>
          <div class="lobby-row">
            ${facBtns}
            ${lobbyGated ? `<span class="muted-note">lobbying unlocks at Baron Tier ${SENATECFG.lobbyMinTier}</span>` : `<span class="muted-note">cost scales with your standing; each repeat lobby sways less, and rallying a bloc hardens its rival against you</span>`}</div>
          ${queued.length ? `<div class="pending-row muted-note">Queued: ${queued.join(" · ")} (${tu}/${mt} senators worked) — ${Senate.shared ? "pooled with every baron's, applied galaxy-wide when the vote lands." : "applied when the vote lands."}</div>` : ""}
        </div></div>`;
    }
    const headPanel = `<div class="panel senate-head">
      <h2>The Senate <small>session ${senate.cycle || 0} · ${roster.length} senators · ${next ? `next vote ${Util.duration(Math.max(0, next.votesAt - now))}` : "in recess"}</small></h2></div>`;
    const floorPanel = `<div class="panel senate-floor">
      <p class="muted-note">Edicts reshape the markets ~daily. Tier <b>${tier}</b> unlocks lobbying, bribes, and coercion — up to <b>${Senate.maxTargets()}</b> senator(s) per vote.</p>
      ${floor}</div>`;

    // ---- active edicts ----
    const edictPanel = `<div class="panel"><h2>Active Edicts <small>${active.length} in force</small></h2>` +
      (active.length ? active.map(b => `<div class="edict"><div class="edict-head"><b>${b.title}</b>${b.endsAt ? `<span class="edict-eta">expires ${Util.duration(b.endsAt - now)}</span>` : ""}</div><div class="edict-blurb">${b.blurb}</div></div>`).join("")
        : `<p class="muted-note">No edicts in force — the markets are free… for now.</p>`) + `</div>`;

    // ---- upcoming legislation ----
    const upPanel = `<div class="panel"><h2>Upcoming Legislation <small>preview the docket</small></h2>` +
      upcoming.map((b, i) => `<div class="bill upcoming"><div class="bill-head"><b>${b.title}</b><span class="bill-eta">${i === 0 ? "on the floor · " : ""}votes in ${Util.duration(Math.max(0, b.votesAt - now))}</span></div><div class="bill-blurb">${b.blurb}</div></div>`).join("") + `</div>`;

    // ---- roster ----
    const f = this.senateFilt, q = (f.q || "").toLowerCase();
    const shown = roster.filter(sn =>
      (f.sector === "all" || sn.sectorId === f.sector) &&
      (f.bloc === "all" || Senate.blocNow(sn) === f.bloc) &&
      (!q || sn.name.toLowerCase().includes(q) || sn.systemName.toLowerCase().includes(q)));
    const issueKey = next ? next.issue : "trade";
    const rows = shown.map(sn => {
      const revealed = Senate.revealed(sn.id), rel = Senate.relationship(sn.id), bloc = Senate.blocNow(sn);
      const hist = Senate.senatorHistory(sn.id, 8).map(h => `<i class="vh vh-${h.vote}"></i>`).join("");
      const stance = revealed ? `${this.issueLabel(issueKey)}: <b>${Senate.stanceLabel(Senate.stanceNow(sn, issueKey))}</b>` : `<span class="muted-note">${SENATECFG.stanceUnknown}</span>`;
      return `<div class="sen-row${revealed ? "" : " locked"}" data-sn="card" data-id="${sn.id}">
        <span class="sen-name"><img class="sen-av" src="${ASSET.portrait(sn.portrait)}" alt="" onerror="this.style.display='none'" /><span class="sen-nm"><b>${sn.name}</b> <span class="sen-title">${sn.title}</span></span></span>
        <span class="sen-bloc" style="color:${Senate.blocColor(bloc)}">◆ ${Senate.blocName(bloc)}${bloc !== sn.bloc ? " ⇄" : ""}</span>
        <span class="sen-where">${sn.systemName} · ${sn.sectorName}</span>
        <span class="sen-stance">${stance}</span>
        <span class="sen-hist" title="recent votes">${hist}</span>
        ${rel ? `<span class="sen-rel ${rel > 0 ? "up" : "down"}">${rel > 0 ? "ally" : "wary"}</span>` : ""}</div>`;
    }).join("") || `<p class="muted-note">No senators match your filter.</p>`;
    const secOpts = `<option value="all">All sectors</option>` + SECTORS.map(s => `<option value="${s.id}"${f.sector === s.id ? " selected" : ""}>${s.name}</option>`).join("");
    const blocOpts = `<option value="all">All blocs</option>` + Object.keys(FACTIONS).map(b => `<option value="${b}"${f.bloc === b ? " selected" : ""}>${FACTIONS[b].name}</option>`).join("") + `<option value="independent"${f.bloc === "independent" ? " selected" : ""}>Independent</option>`;
    const rosterPanel = `<div class="panel"><h2>Representatives <small>${shown.length}/${roster.length} senators · click for a dossier</small></h2>
      <div class="senate-filters">
        <label>Sector <select data-snf="sector">${secOpts}</select></label>
        <label>Bloc <select data-snf="bloc">${blocOpts}</select></label>
        <input type="search" data-snf="q" placeholder="search name / system…" value="${f.q || ""}" />
      </div>
      <div class="senate-roster">${rows}</div></div>`;

    // ---- voting history ----
    const past = Senate.history(24);
    const histItems = past.map(b => {
      const r = b.result || {}, carried = Senate._carried(b);
      const cls = b.status === "repealed" ? "repealed" : (carried ? "passed" : "failed");
      const label = b.repealOf ? (carried ? "REPEAL PASSED" : "REPEAL FAILED")
        : b.status === "repealed" ? "PASSED · LATER REPEALED"
        : b.status === "expired" ? "PASSED · EXPIRED"
        : carried ? "PASSED" : "FAILED";
      const inForce = b.status === "passed" && b.effect && (!b.endsAt || b.endsAt > now);
      const when = b.votesAt ? `${Util.duration(Math.max(0, now - b.votesAt))} ago` : "";
      return `<div class="vh-item ${cls}">
        <div class="vh-item-head"><b>${b.title}</b><span class="vh-badge ${cls}">${label}</span></div>
        <div class="vh-effect muted-note">${b.blurb}</div>
        <div class="vh-tally"><span class="up">Aye ${r.aye || 0}</span> · <span class="down">Nay ${r.nay || 0}</span> · <span class="tip-dim">Abstain ${r.abstain || 0}</span>${when ? ` · <span class="muted-note">${when}</span>` : ""}${inForce ? ` · <span class="vh-active">in force${b.endsAt ? `, ${Util.duration(b.endsAt - now)} left` : ""}</span>` : ""}</div>
        <div class="vh-actions">
          <button class="btn btn-mini" data-sn="seevote" data-id="${b.id}">See voting results</button>
          <button class="btn btn-mini" data-sn="watchvote" data-id="${b.id}">▶ Watch the voting session</button>
        </div></div>`;
    }).join("") || `<p class="muted-note">No votes have been held yet — check back after the next session.</p>`;
    const historyPanel = `<div class="panel"><h2>Voting History <small>${past.length} past session(s)</small></h2>
      <p class="muted-note">Each entry shows the legislation's effect and how it landed. “See voting results” snaps the chamber to the final tally; “Watch the voting session” replays the speaker's roll-call seat by seat.</p>
      <div class="senate-history-list">${histItems}</div></div>`;

    // ---- sub-tabs ----
    this.senateTab ||= "overview";
    const tabs = [["overview", "Overview"], ["edicts", "Active Edicts"], ["reps", "Representatives"], ["history", "Voting History"]];
    const nav = `<nav class="subtabs senate-subtabs">${tabs.map(([k, l]) =>
      `<button class="subtab${this.senateTab === k ? " active" : ""}" data-sntab="${k}">${l}</button>`).join("")}</nav>`;
    const body = this.senateTab === "edicts" ? edictPanel
      : this.senateTab === "reps" ? rosterPanel
      : this.senateTab === "history" ? historyPanel
      : floorPanel + upPanel;

    this.refs.senateBody.innerHTML = headPanel + nav + body;
    this.refs.senateBody.onclick = e => this.onSenateClick(e);
    this.refs.senateBody.onchange = e => this.onSenateFilter(e);
  },

  onSenateClick(e) {
    const tab = e.target.closest("[data-sntab]");
    if (tab) { this.senateTab = tab.dataset.sntab; this.renderSenate(); return; }
    const b = e.target.closest("[data-sn]"); if (!b) return;
    const act = b.dataset.sn;
    if (act === "chamber") { Senate.openChamber(); return; }
    if (act === "seevote") { Senate.openVote(b.dataset.id, false); return; }
    if (act === "watchvote") { Senate.openVote(b.dataset.id, true); return; }
    if (act === "card") { this.openSenatorCard(b.dataset.id); return; }
    if (act === "want") { Senate.setWant(b.dataset.v); window.Game.requestSave(); this.renderSenate(); return; }
    if (act === "lobby") {
      const r = Senate.lobby(b.dataset.v);
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast("Lobbying campaign funded.", "good"); this.flashCredits(); window.Game.requestSave(); this.updateHeader(); this.renderSenate();
    }
  },
  onSenateFilter(e) {
    const sel = e.target.closest("[data-snf]"); if (!sel) return;
    this.senateFilt ||= { sector: "all", bloc: "all", q: "" };
    this.senateFilt[sel.dataset.snf] = sel.value;
    this.renderSenate();
  },

  openSenatorCard(id) {
    if (!window.Senate) return;
    const sn = Senate.byId(id); if (!sn) return;
    const revealed = Senate.revealed(id), rel = Senate.relationship(id), p = Senate.pending(), next = Senate.nextBill();
    const curBloc = Senate.blocNow(sn);
    const stances = SENATE_ISSUES.map(iss => `<li><span>${iss.label}</span><b>${revealed ? Senate.stanceLabel(Senate.stanceNow(sn, iss.key)) : SENATECFG.stanceUnknown}</b></li>`).join("");
    const hist = Senate.senatorHistory(id, 12);
    const histHTML = hist.length ? hist.map(h => `<div class="sh-row"><i class="vh vh-${h.vote}"></i> <span>${h.bill.title}</span> <span class="muted-note">${h.vote === "a" ? "aye" : h.vote === "n" ? "nay" : "abstained"}</span></div>`).join("") : `<p class="muted-note">No votes on record yet.</p>`;
    const canB = Senate.can("bribe"), canS = Senate.can("scandal");
    const bribed = !!p.pushSen[id], coerced = !!p.coerce[id], worked = bribed || coerced;
    const lockNote = canB && canS ? "" : `<span class="muted-note">${canB ? "" : `bribery unlocks at Baron Tier ${SENATECFG.bribeMinTier}. `}${canS ? "" : `coercion at Baron Tier ${SENATECFG.scandalMinTier}.`}</span>`;
    const actions = next ? `<div class="sen-actions">
        <button class="btn btn-mini" data-sncard="bribe" data-id="${id}" ${(!canB || worked) ? "disabled" : ""}>${bribed ? "Bribed ✓" : `Bribe · ${Util.credits(Senate._bribeCost(sn))}c`}</button>
        <button class="btn btn-mini btn-sell" data-sncard="scandal" data-id="${id}" ${(!canS || worked) ? "disabled" : ""}>${coerced ? "Coerced ✓" : `Coerce · ${Util.credits(Senate._scandalCost(sn))}c`}</button>
        ${lockNote}</div>
        <p class="muted-note"><b>Bribe</b> nudges them toward your position and warms relations (cheaper with allies). <b>Coerce</b> forces their vote to your position regardless of stance but burns relations (cheaper on senators who dislike you). Declare a position first.</p>` : `<p class="muted-note">No bill on the floor to influence.</p>`;
    this.refs.senatorCard.innerHTML = `
      <div class="sen-card-head">
        <img class="sen-portrait" src="${ASSET.portrait(sn.portrait)}" alt="" onerror="this.style.visibility='hidden'" />
        <div class="sen-card-id"><h3>${sn.name}</h3>
          <div class="sen-card-sub">${sn.title} · <span style="color:${Senate.blocColor(curBloc)}">◆ ${Senate.blocName(curBloc)}</span>${curBloc !== sn.bloc ? ` <span class="muted-note">(crossed the floor from ${Senate.blocName(sn.bloc)})</span>` : ""}</div>
          <div class="muted-note">${sn.raceName} · represents ${sn.systemName}, ${sn.sectorName} · seat weight ${sn.weight}${rel ? ` · relationship <b class="${rel > 0 ? "up" : "down"}">${rel > 0 ? "+" : ""}${rel}</b>` : ""}</div></div></div>
      ${revealed ? `<p class="muted-note">Positions shift slowly over time — a dossier always shows their current stance.</p>` : `<p class="locked-note">⚠ ${SENATECFG.stanceUnknown}. Buy this senator's dossier in the <b>Bazaar → Contracts</b> to reveal their positions and full voting record.</p>`}
      <h4>Positions</h4><ul class="sen-stances">${stances}</ul>
      <h4>Voting record</h4><div class="sen-history">${histHTML}</div>
      ${actions}`;
    this.refs.senatorCard.onclick = e => {
      const btn = e.target.closest("[data-sncard]"); if (!btn) return;
      const r = btn.dataset.sncard === "bribe" ? Senate.bribe(btn.dataset.id) : Senate.scandal(btn.dataset.id);
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast(btn.dataset.sncard === "bribe" ? "Senator bribed — they'll lean your way." : "Senator coerced — they'll vote your position.", "good");
      this.flashCredits(); window.Game.requestSave(); this.updateHeader();
      this.openSenatorCard(id); if (this.page === "senate") this.renderSenate();
    };
    this.refs.senatorClose.onclick = () => this.refs.senatorModal.classList.add("hidden");
    this.refs.senatorModal.onclick = e => { if (e.target === this.refs.senatorModal) this.refs.senatorModal.classList.add("hidden"); };
    this.refs.senatorModal.classList.remove("hidden");
  },

  // ===== BARONS / leaderboard ==============================================
  renderLeaderboard() {
    if (this.page !== "barons") return;
    this.renderBaronTrack();
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

  // the Baron Tier "ascension" track: current title + perks, and the next tier
  renderBaronTrack() {
    const el = this.refs.baronTrack; if (!el) return;
    const cur = Economy.tierInfo(), next = Economy.nextTier(), nw = Economy.netWorth();
    const taxPct = (cur.tax * 100).toFixed(0);
    const perks = `<div class="bt-perks"><span>Earnings tax <b class="${cur.tax ? "down" : "up"}">${taxPct}%</b></span><span>Industry permits <b>${cur.permits}</b></span><span>Fleet cap <b>${cur.fleet}</b></span></div>`;
    let nextHtml;
    if (!next) {
      nextHtml = `<p class="muted-note">You've reached the apex — there is no higher office than <b>${cur.title}</b>.</p>`;
    } else {
      const ready = nw >= next.threshold, pct = Math.min(100, nw / next.threshold * 100);
      nextHtml = `<div class="bt-next">
        <div class="bt-next-head">Next: <b>${next.title}</b> <span class="muted-note">at ${Util.credits(next.threshold)}c net worth</span></div>
        <div class="bt-bar"><span style="width:${pct.toFixed(1)}%"></span></div>
        <div class="muted-note">Keeps your whole empire. Unlocks ${next.permits} permits · fleet ${next.fleet} · costs a permanent ${(next.tax * 100).toFixed(0)}% earnings tax.</div>
        <button class="btn ${ready ? "btn-go" : ""}" id="baron-ascend" ${ready ? "" : "disabled"}>${ready ? `Ascend to ${next.title} ▸` : `${Util.credits(Math.max(0, next.threshold - nw))}c to go`}</button>
      </div>`;
    }
    el.innerHTML = `<h2>Your Title <small>${cur.title}</small></h2>
      <p class="muted-note">Ascending a tier keeps everything you own — stocks, industries, ships, senator ties — and grants a bigger empire, at the price of a steeper tax on all earnings.</p>
      ${perks}${nextHtml}`;
    const btn = el.querySelector("#baron-ascend");
    if (btn) btn.onclick = () => this.doAscend();
  },
  doAscend() {
    if (!Economy.canPrestige()) return;
    const next = Economy.nextTier();
    if (!confirm(`Ascend to ${next.title}? You keep your entire empire — stocks, industries, ships and senator ties — and gain ${next.permits} industry permits + a fleet cap of ${next.fleet}. The price: a permanent ${(next.tax * 100).toFixed(0)}% tax on all earnings (it never goes back down).`)) return;
    const res = Economy.prestige();
    if (res.ok) { this.toast(`Ascended — you are now a ${res.title}.`, "good", 5000); this.fullRender(); }
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
    this.renderNewswire(); window.Game.audio("news"); this.bumpComms();
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
    this.bumpComms();
  },

  toast(text, kind = "info", ms = 3200) {
    const stack = this.refs.toast;
    // ponytail: cap at 3 — drop the oldest so bursts don't bury the screen
    while (stack.children.length >= 3) stack.firstChild.remove();
    const t = this.el("div", "toast toast-" + kind, text);
    stack.appendChild(t);
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
  showWYWA({ elapsedMs, reports, sold, routed, orders, industry, mercs, recap }) {
    const routeTotal = (routed && routed.total) || 0;
    const fills = (orders || []).filter(e => e.type === "filled");
    const made = industry || [], merced = mercs || [], rc = recap || {};
    const seized = rc.seized || [], movers = rc.movers || [];
    const senateChanged = rc.senate && (rc.senate.passed.length || rc.senate.repealed.length);
    const anything = reports.length || sold.length || routeTotal || fills.length || made.length
      || merced.length || seized.length || movers.length || rc.war || rc.warEnded || senateChanged || rc.customs;
    if (elapsedMs < 60000 && !anything) return false;

    let html = `<p>You were away <b>${Util.duration(elapsedMs)}</b>.</p>`;
    // headline: net worth then → now
    if (rc.nwAfter != null) {
      const d = Math.round(rc.nwDelta || 0), cls = d > 0 ? "up" : d < 0 ? "down" : "";
      html += `<p class="wywa-net">Net worth <b>${Util.credits(rc.nwBefore)}c</b> → <b>${Util.credits(rc.nwAfter)}c</b>`
        + `${d ? ` <span class="${cls}">(${d > 0 ? "+" : "−"}${Util.credits(Math.abs(d))}c)</span>` : ""}</p>`;
    }
    // world events worth flagging up top
    if (rc.war) html += `<p class="wywa-war">⚔ ${rc.war.aggressor} at war with ${rc.war.defender} — ${rc.war.hot} prices spiking, ${rc.war.cold} slumping.</p>`;
    else if (rc.warEnded) html += `<p class="wywa-war">⚔ The ${rc.warEnded} war ended while you were away.</p>`;
    if (seized.length) html += `<p class="down">⚠ Seized for low standing: ${seized.join(", ")} (rebuild from the Star Map).</p>`;
    if (rc.customs) html += `<p class="down">⚠ Customs seized ${rc.customs.qty} ${rc.customs.name} (${Util.credits(rc.customs.value)}c) as you docked.</p>`;

    if (reports.length) {
      html += `<ul class="wywa-runs">` + reports.map(r => {
        const wear = (r.damaged || []).length ? ` · 🔧 ${r.damaged.length} damaged` : "";
        if (r.type === "survey") return `<li>🛰 <span class="${r.success ? "up" : "down"}">${r.summary}</span></li>`;
        return r.success
          ? `<li>${r.title}: <span class="up">success</span> +${Util.credits(r.credits)}c${r.items.length ? ` · ${r.items.length} item(s)` : ""}${r.lost.length ? ` · lost ${r.lost.length} ship(s)` : ""}${wear}</li>`
          : `<li>${r.title}: <span class="down">failed</span>${r.lost.length ? ` · lost ${r.lost.length} ship(s)` : r.impounded.length ? ` · ${r.impounded.length} impounded` : ""}${wear}</li>`;
      }).join("") + `</ul>`;
    }
    if (routeTotal) html += `<p>Trade routes banked <b class="up">+${Util.credits(routeTotal)}c</b> across ${routed.runs.reduce((n, r) => n + r.cycles, 0)} deliveries.</p>`;
    if (fills.length) html += `<p>Standing orders filled: ${fills.map(f => `${f.side} ${f.qty} ${f.comm.name}`).join(", ")}.</p>`;
    if (made.length) {
      const agg = {};
      for (const m of made) agg[m.commodity] = (agg[m.commodity] || 0) + m.qty;
      html += `<p>Industries produced: ${Object.entries(agg).map(([id, q]) => `${q} ${(COMMODITIES.find(c => c.id === id) || {}).name || id}`).join(", ")} (now in your stock).</p>`;
    }
    if (rc.senate) {
      const sp = rc.senate;
      if (sp.passed.length) html += `<p class="wywa-war">🏛 Senate passed: ${sp.passed.map(b => b.title).join("; ")}. <span class="muted-note">(active edicts — see the Senate tab)</span></p>`;
      if (sp.repealed.length) html += `<p>🏛 Senate repealed ${sp.repealed.length} edict(s).</p>`;
      if (sp.failed.length) html += `<p class="muted-note">🏛 Senate rejected ${sp.failed.length} bill(s).</p>`;
    }
    if (sold.length) html += `<p>Market sales: ${sold.map(s => `${s.name} (+${Util.credits(s.price)}c)`).join(", ")}</p>`;
    if (merced.length) html += `<p>Mercenaries stood down: ${merced.map(m => m.name).join(", ")} (their contracts lapsed).</p>`;
    if (movers.length) html += `<p>Market swings: ${movers.map(m => `${m.name} <span class="${m.pct > 0 ? "up" : "down"}">${m.pct > 0 ? "+" : ""}${m.pct.toFixed(0)}%</span>`).join(", ")}.</p>`;

    if (!anything) html += `<p>The market drifted while you were gone.</p>`;
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
    if (this.refs.langToggle) {
      const lang = window.I18n ? I18n.lang : (set.lang || "en");
      for (const b of this.refs.langToggle.querySelectorAll(".lang-btn")) b.classList.toggle("active", b.dataset.lang === lang);
    }
  },

  // Refresh JS-generated labels after a language switch (static HTML is handled
  // by I18n.apply via data-i18n). Called from I18n.apply once the UI is ready.
  onLangChange() {
    this.buildExchange();       // Buy/Sell/Buy Max/Sell All labels
    this.updateExchange();      // refreshes the "prices at …" sub-label too
    this.renderOrders();        // standing-orders empty-state text
    this.updateNavIndicator();  // JP labels are a different width
    this.applySettings();       // reflect the active language button
  },

  wireControls() {
    const r = this.refs;
    this.refs.tabs.onclick = e => { const t = e.target.closest(".tab"); if (t) this.showPage(t.dataset.page); };
    window.addEventListener("resize", () => this.updateNavIndicator());
    requestAnimationFrame(() => this.updateNavIndicator());
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
      const res = Routes.start(this.selectedRouteShips(), comm, from, to);
      if (!res.ok) return this.toast(res.msg, "warn");
      this.toast("Trade route started ▸", "good");
      r.route.classList.add("hidden");
      window.Game.requestSave(); this.renderFleet();
    };
    r.svCancel.onclick = () => { this._surveySys = null; r.survey.classList.add("hidden"); };
    r.svStart.onclick = () => {
      const res = Expeditions.start(this._surveySys, this.selectedSurveyShip());
      if (!res.ok) return this.toast(res.msg, "warn");
      this.toast("Survey dispatched ▸", "good");
      r.survey.classList.add("hidden");
      window.Game.requestSave(); this.renderFleet();
      if (window.StarMap) { StarMap.refreshInfo(); StarMap.updateGalaxyNodes(); }
    };

    if (r.langToggle) r.langToggle.onclick = e => {
      const b = e.target.closest(".lang-btn"); if (!b || !window.I18n) return;
      I18n.set(b.dataset.lang); window.Game.requestSave();
    };
    r.setMute.onchange = () => { this.s().settings.muted = r.setMute.checked; this.applySettings(); window.Game.requestSave(); };
    r.setReduced.onchange = () => { this.s().settings.reduced = r.setReduced.checked; this.applySettings(); window.Game.requestSave(); };
    r.setFastNews.onchange = () => { CONFIG.fastNews = r.setFastNews.checked; Broadcast.start(); window.Game.scheduleLocalEvent(); window.Game.scheduleLocalFlavor(); };
    r.setFast.onchange = () => { window.Game.timeScale = r.setFast.checked ? 60 : 1; Broadcast.start(); window.Game.scheduleLocalEvent(); window.Game.scheduleLocalFlavor(); };
    r.setReset.onclick = () => { if (confirm("Wipe your Cosmocrat save and start over?")) window.Game.reset(); };

    r.btnPrestige.onclick = () => this.doAscend();

    this.refs.feedList.addEventListener("scroll", () => {
      const el = this.refs.feedList; this.feedPaused = el.scrollHeight - el.scrollTop - el.clientHeight > 40;
    });
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
    Bus.on("surveyDone", r => {
      if (window.Game._booting) return;   // offline surveys land in the "while you were away" recap
      this.toast(`🛰 ${r.summary}`, r.success ? "good" : "bad", 6000);
      if (this.page === "fleet") this.renderFleet();
      if (window.StarMap) { StarMap.updateGalaxyNodes(); StarMap.refreshInfo(); }
      this.updateHeader(); this.audioSafe(r.success ? "good" : "news");
    });
    Bus.on("listingSold", sl => { this.toast(`Sold ${sl.name} on the market: +${Util.credits(sl.price)}c`, "buy"); if (this.page === "fleet") this.renderInventory(); });
    Bus.on("dock", d => { if (d.arrived) { this.toast(`Docked at ${this.sysName(d.sysId)}.`, "good"); this.updateExchange(); this.updateHeader(); this.renderSystems(); } });
    Bus.on("customs", ev => {
      if (window.Game._booting) return;   // offline seizures are shown in the "while you were away" recap
      this.toast(`⚠ Customs seized ${ev.qty} ${ev.name} (${Util.credits(ev.value)}c) at the ${this.sysName(ev.sysId)} gate.`, "bad", 6000);
      if (window.Feed) Feed.emit(`customs pulled a baron's ${ev.name.toLowerCase()} at ${this.sysName(ev.sysId)} — ${ev.qty} units gone 🚨`, { kind: "reaction" });
      this.audioSafe("news"); this.updateHeader();
      if (this.page === "exchange") this.updateExchange();
    });
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
    Bus.on("industryLost", e => {
      this.toast(`⚠ ${(FACTIONS[e.faction] || {}).name || "A faction"} seized your works on ${e.name}.`, "bad", 5500);
      if (this.page === "industries") this.renderIndustries();
      this.updateHeader();
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
    if (this.page === "industries") this.renderIndustries();
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
    if (this.page === "senate") this.renderSenate();
  },
};

window.UI = UI;
