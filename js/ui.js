/* ui.js — all DOM rendering across the tabbed pages (Hub, Exchange, Fleet, Star
   Systems, Bazaar, Milestones) plus the persistent broadcast/feed sidebar and
   the modals. No game logic here — it reads modules and writes the screen.     */

const UI = {
  refs: {},
  rows: {},
  lastPrice: {},
  feedPaused: false,
  page: "exchange",
  bazaarTab: "shipyard",
  fleetTab: "logistics",
  industriesTab: "permits",
  workshopTab: "gear",
  bzSort: { contracts: "reward", gear: "value", mercs: "power" },
  bzFilt: { contracts: "all", gear: "all" },
  fleetSort: { ships: "name", inv: "value" },
  tutStep: 0,
  _missionSig: "",
  _reportSig: "",
  _pending: null,        // pending contract awaiting ship selection
  _equipItem: null,
  charterPick: { shipUid: null, durationMin: 60, band: "safe" },
  lbOffset: null,        // Barons page start index; null = center on you

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
      fleetCharters: $("fleet-charters"), chartersSub: $("charters-sub"),
      fleetReportsPanel: $("fleet-reports-panel"), fleetReports: $("fleet-reports"),
      fleetShips: $("fleet-ships"), fleetCount: $("fleet-count"),
      fleetInventory: $("fleet-inventory"), invCount: $("inv-count"),
      systemList: $("system-list"), bazaarBody: $("bazaar-body"),
      rank: $("hud-rank"), lbList: $("lb-list"), lbSub: $("lb-sub"), baronTrack: $("baron-track"),
      lbPrev: $("lb-prev"), lbNext: $("lb-next"), lbPageLabel: $("lb-page-label"),
      achList: $("ach-list"), achCount: $("ach-count"),
      indList: $("industry-list"), indCount: $("ind-count"),
      indExList: $("industry-extractors"), indExCount: $("ind-ex-count"),
      indCompList: $("industry-components"), indCompCount: $("ind-comp-count"),
      senateBody: $("senate-body"),
      senatorModal: $("senator-modal"), senatorCard: $("senator-card"), senatorClose: $("senator-close"),
      bcFrame: $("bc-frame"), bcTitle: $("bc-title"), bcCaption: $("bc-caption"),
      tickerText: $("ticker-text"), newswireList: $("newswire-list"),
      feedList: $("feed-list"), toast: $("toast-stack"),
      commsBadge: $("tab-comms-badge"),
      dispatchBody: $("dispatch-body"),
      pendingBody: $("pending-body"),
      btnPrestige: $("btn-prestige"), btnMute: $("btn-mute"), btnSettings: $("btn-settings"), btnHelp: $("btn-help"),
      topbar: document.querySelector(".topbar"), btnMenu: $("btn-menu"), topmenu: $("topmenu"),
      tutorial: $("tutorial-modal"), tutIcon: $("tut-icon"), tutTitle: $("tut-title"),
      tutBody: $("tut-body"), tutDots: $("tut-dots"), tutSkip: $("tut-skip"),
      tutBack: $("tut-back"), tutNext: $("tut-next"),
      wywa: $("wywa-modal"), wywaBody: $("wywa-body"), wywaClose: $("wywa-close"),
      mission: $("mission-modal"), mmTitle: $("mm-title"), mmBody: $("mm-body"),
      mmLaunch: $("mm-launch"), mmCancel: $("mm-cancel"),
      equip: $("equip-modal"), eqTitle: $("eq-title"), eqBody: $("eq-body"), eqCancel: $("eq-cancel"),
      baronRanks: $("baron-ranks-modal"), baronRanksBody: $("baron-ranks-body"), baronRanksClose: $("baron-ranks-close"),
      survey: $("survey-modal"), svTitle: $("sv-title"), svBody: $("sv-body"), svStart: $("sv-start"), svCancel: $("sv-cancel"),
      incident: $("incident-modal"), incIcon: $("inc-icon"), incTitle: $("inc-title"), incText: $("inc-text"),
      incChoices: $("inc-choices"), incResult: $("inc-result"), incClose: $("inc-close"),
      ordComm: $("ord-comm"), ordKind: $("ord-kind"), ordPrice: $("ord-price"), ordQty: $("ord-qty"),
      ordAdd: $("ord-add"), ordersList: $("orders-list"),
      boostBar: $("boost-bar"), boostEmpty: $("boost-empty"),
      workshopSlots: $("workshop-slots"), workshopQueue: $("workshop-queue"),
      workshopRecipes: $("workshop-recipes"), workshopUpgrade: $("workshop-upgrade"),
      workshopTabs: $("workshop-tabs"),
      tabStations: $("tab-stations"), stationsTabs: $("stations-tabs"), stationsBody: $("stations-body"),
      settings: $("settings-modal"), setVolume: $("set-volume"), setVolumeVal: $("set-volume-val"),
      setReduced: $("set-reduced"),
      setFastNews: $("set-fastnews"), setFast: $("set-fast"), setReset: $("set-reset"), setClose: $("set-close"),
      setRestore: $("set-restore"), setRestoreNote: $("set-restore-note"),
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
    this.showPage("hub");
  },

  // ===== tabs ==============================================================
  showPage(name) {
    if (name === "starmap") { if (window.StarMap) StarMap.toggle(); return; }   // star map is an overlay, not a page
    if (window.StarMap && StarMap.open) StarMap.close();                        // picking any section leaves the star map
    this.page = name;
    for (const t of this.refs.tabs.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.page === name);
    for (const p of document.querySelectorAll(".page")) p.classList.toggle("hidden", p.id !== "page-" + name);
    this.updateNavIndicator();
    this.applyPageBg(name);
    if (name === "fleet") { this.showFleetTab(this.fleetTab || "logistics"); this.renderFleet(); }
    else if (name === "bazaar") this.renderBazaar();
    else if (name === "systems") this.renderSystems();
    else if (name === "barons") {
      this.lbOffset = null;
      this.renderLeaderboard();
      if (window.Barons) {
        Barons.refresh().then(() => {
          if (Cloud.signedIn && Cloud.signedIn()) return Barons.publish();
        }).finally(() => { if (this.page === "barons") this.renderLeaderboard(); this.updateHeader(); });
      }
    }
    else if (name === "ach") this.renderAchievements();
    else if (name === "industries") { this.showIndustriesTab(this.industriesTab || "permits"); this.renderIndustries(); }
    else if (name === "workshop") this.renderWorkshop();
    else if (name === "stations") this.renderStations();
    else if (name === "senate") this.renderSenate();
    else if (name === "exchange") this.renderOrders();
    else if (name === "hub") this.renderBoostBar();
    else if (name === "comms") {
      this.clearCommsBadge();
      this.showCommsTab(this.commsTab || "dispatches");
    }
  },

  // Hub buff bar — icon + countdown + tooltip from activeBoosts (read-time clock).
  renderBoostBar(now = Date.now()) {
    const bar = this.refs.boostBar, empty = this.refs.boostEmpty;
    if (!bar) return;
    const list = window.Boosts ? Boosts.active(now) : [];
    if (empty) empty.classList.toggle("hidden", list.length > 0);
    bar.innerHTML = list.map(b => {
      const e = Boosts.effect(b.effectId); if (!e) return "";
      const left = Math.max(0, b.expiresAt - now);
      const letters = (e.name || "?").split(/\s+/).map(w => w[0]).join("").slice(0, 2);
      return `<div class="boost-chip" title="${e.desc.replace(/"/g, "&quot;")}">
        <span class="boost-ico" aria-hidden="true">${letters}</span>
        <span class="boost-meta"><span class="boost-name">${e.name}</span>
        <span class="boost-cd">${Util.duration(left)}</span></span></div>`;
    }).join("");
  },

  // ---- Fleet subtabs (Logistics / Owned Ships / Inventory) ----------------
  // Logistics keeps flagship, missions (+ reports) and charters together so a
  // finished mission report is one click from the page you land on.
  showFleetTab(name) {
    const ok = { logistics: 1, ships: 1, inventory: 1 };
    this.fleetTab = ok[name] ? name : "logistics";
    this._syncSubtabs("fleet-tabs", "fleet", "#page-fleet [data-fleet-pane]", "fleetPane", this.fleetTab);
  },

  // ---- Industries subtabs (Permits / Extractors / Components) --------------
  showIndustriesTab(name) {
    const ok = { permits: 1, extractors: 1, components: 1 };
    this.industriesTab = ok[name] ? name : "permits";
    this._syncSubtabs("industries-tabs", "ind", "#page-industries [data-ind-pane]", "indPane", this.industriesTab);
  },

  // Light up one subtab button + show its pane. aria-current is what tells a
  // screen reader which tab is active — the .active class is only paint.
  _syncSubtabs(navId, attr, paneSel, paneKey, tab) {
    const nav = document.getElementById(navId);
    if (nav) for (const b of nav.querySelectorAll(`[data-${attr}]`)) {
      const on = b.dataset[attr] === tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-current", on ? "page" : "false");
    }
    for (const pane of document.querySelectorAll(paneSel))
      pane.classList.toggle("hidden", pane.dataset[paneKey] !== tab);
  },

  // Per-tab background (admin Images → Page backgrounds). Fixed full-viewport
  // <img id="page-bg-img"> cover+center behind page UI (mobile crops sides). No URL → hide.
  applyPageBg(name) {
    const img = document.getElementById("page-bg-img");
    if (!img) return;
    const page = name || this.page;
    const url = (window.ASSET && typeof ASSET.pageBg === "function") ? ASSET.pageBg(page) : "";
    if (!url) { img.classList.add("hidden"); img.removeAttribute("src"); return; }
    if (img.getAttribute("src") !== url) img.src = url;
    img.classList.remove("hidden");
  },

  // Pin the chat to the newest message (the feed lives in a hidden tab until
  // opened, so scrollHeight is only correct once it's visible — hence the rAF).
  scrollFeedBottom() {
    const el = this.refs.feedList; if (!el) return;
    this.feedPaused = false;
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  },

  // ---- Comms subtabs (Dispatches / Pending / Broadcast / Chat) ------------
  showCommsTab(name) {
    const tab = (name === "broadcast" || name === "chat" || name === "pending") ? name : "dispatches";
    this.commsTab = tab;
    const nav = document.getElementById("comms-tabs");
    if (nav) for (const b of nav.querySelectorAll("[data-comms]")) {
      b.classList.toggle("active", b.dataset.comms === tab);
      if (b.dataset.comms === tab) b.classList.remove("ping");
    }
    for (const pane of document.querySelectorAll("#page-comms [data-comms-pane]"))
      pane.classList.toggle("hidden", pane.dataset.commsPane !== tab);
    if (tab === "dispatches") this.renderDispatches();
    else if (tab === "pending") this.renderPendingContracts();
    else if (tab === "chat") this.scrollFeedBottom();
  },
  // Soft ping on a Comms subtab when something arrives while you're on another.
  pingCommsTab(name) {
    const nav = document.getElementById("comms-tabs"); if (!nav) return;
    const b = nav.querySelector(`[data-comms="${name}"]`);
    if (b && !b.classList.contains("active")) b.classList.add("ping");
  },

  t(key, fallback) { return window.I18n ? I18n.t(key) : fallback; },

  // Pending (taken, not launched) + active charters.
  renderPendingContracts() {
    const el = this.refs.pendingBody; if (!el) return;
    const list = this.s().pendingContracts || [];
    const charters = window.Charters ? Charters.active() : [];
    el.onclick = e => this.onPendingClick(e);
    let html = `<h3 class="pending-h">${this.t("comms.contractsInHand", "Contracts in hand")}</h3>`;
    if (!list.length) {
      html += `<p class="muted-note">${this.t("comms.noPending", "No held contracts. View a job on the Bazaar board and Launch to take it.")}</p>`
        + `<p class="muted-note">${this.t("comms.cancelFeeNote", "Cancellation fee scales with your Baron title.")}</p>`;
    } else {
      html += `<div class="contract-list">` + list.map(c => this._pendingCardHtml(c)).join("") + `</div>`
        + `<p class="muted-note" style="margin-top:8px">${this.t("comms.cancelFeeNote", "Cancellation fee scales with your Baron title.")}</p>`;
    }
    html += `<h3 class="pending-h" style="margin-top:18px">${this.t("comms.activeCharters", "Active charters")}</h3>`;
    if (!charters.length) {
      html += `<p class="muted-note">${this.t("comms.noCharters", "No hulls on charter. Dispatch one from the Bazaar → Charters tab.")}</p>`;
    } else {
      html += `<div class="contract-list">` + charters.map(c => this._charterCardHtml(c)).join("") + `</div>`;
    }
    el.innerHTML = html;
  },
  _charterCardHtml(c) {
    const sh = Fleet.ship(c.shipUid);
    const danger = (DANGER.find(d => d.id === c.band) || {}).label || c.band;
    const left = Math.max(0, c.startedAt + c.durationMs - Date.now());
    const val = Charters.cancelValue(c);
    const btnLabel = val < 0
      ? `${this.t("comms.cancelCharter", "Cancel")} — ${Util.credits(-val)}c`
      : `${this.t("comms.buyoutCharter", "Buy out")} +${Util.credits(val)}c`;
    const btnCls = val < 0 ? "btn btn-mini btn-cancel-fee" : "btn btn-mini btn-go";
    return `<div class="contract pending-card">
      <div class="c-head"><b>${sh ? sh.name : "Unknown hull"}</b><span class="ctype dgr-${c.band}">${danger}</span></div>
      <div class="c-meta">Payout <b class="up">${Util.credits(c.reward)}c</b> · loss ${((c.destroyChance || 0) * 100).toFixed(0)}% · returns ${Util.duration(left)}</div>
      <div class="c-actions"><button class="${btnCls}" data-charter-cancel="${c.id}">${btnLabel}</button></div>
    </div>`;
  },
  _pendingCardHtml(c) {
    const fee = Bazaar.cancelFee(c);
    const danger = (DANGER.find(d => d.id === c.danger) || {}).label || c.danger;
    const fac = c.faction && FACTIONS[c.faction];
    const reward = Util.credits((c.reward && c.reward.credits) || 0);
    return `<div class="contract pending-card">
      <div class="c-head"><b>${c.title}</b><span class="ctype">${c.type || "job"}</span></div>
      <div class="c-meta">${c.sysName || "—"} · ${danger}${fac ? ` · ${fac.name}` : ""}</div>
      <div class="c-reward">Reward <b>${reward}c</b> · Cancel fee <b class="down">${Util.credits(fee)}c</b></div>
      <div class="c-actions">
        <button class="btn btn-go btn-mini" data-pend-launch="${c.id}">${this.t("comms.launch", "Launch")}</button>
        <button class="btn btn-mini" data-pend-cancel="${c.id}">${this.t("comms.cancelContract", "Cancel")}</button>
      </div>
    </div>`;
  },
  async onPendingClick(e) {
    const launch = e.target.closest("[data-pend-launch]");
    if (launch) {
      const c = (this.s().pendingContracts || []).find(x => x.id === launch.dataset.pendLaunch);
      if (!c) return this.toast("Contract not in hand.", "warn");
      this.openMission(c);
      return;
    }
    const cancel = e.target.closest("[data-pend-cancel]");
    if (cancel) {
      if (Economy.busy()) return;
      const id = cancel.dataset.pendCancel;
      const c = (this.s().pendingContracts || []).find(x => x.id === id);
      if (!c) return this.toast("Contract not in hand.", "warn");
      const fee = Bazaar.cancelFee(c);
      if (!confirm(`Cancel "${c.title}"?\nFee: ${Util.credits(fee)}c`)) return;
      const r = await Bazaar.cancelPending(id);
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast(`Contract cancelled (−${Util.credits(r.fee)}c)`, "warn");
      this.flashCredits(); window.Game.requestSave();
      this.renderPendingContracts(); this.renderBazaar(); this.updateHeader();
      return;
    }
    const chCancel = e.target.closest("[data-charter-cancel]");
    if (chCancel) this.cancelCharter(chCancel.dataset.charterCancel);
  },
  cancelCharter(id) {
    if (Economy.busy()) return;
    const c = Charters.active().find(x => x.id === id);
    if (!c) return this.toast("Charter not found.", "warn");
    const val = Charters.cancelValue(c);
    const sh = Fleet.ship(c.shipUid);
    const msg = val < 0
      ? `Abort charter for ${sh ? sh.name : "hull"}?\nAbort fee: ${Util.credits(-val)}c`
      : `Buy out charter for ${sh ? sh.name : "hull"}?\nYou receive ${Util.credits(val)}c`;
    if (!confirm(msg)) return;
    const r = Charters.cancel(c.id);
    if (!r.ok) return this.toast(r.msg, "warn");
    const toast = r.value < 0
      ? `Charter aborted (−${Util.credits(-r.value)}c)`
      : `Charter bought out (+${Util.credits(r.value)}c)`;
    this.toast(toast, r.value < 0 ? "warn" : "good");
    this.flashCredits(); window.Game.requestSave();
    this.renderPendingContracts(); this.renderFleet(); this.renderBazaar(); this.updateHeader();
  },

  // Active mission cards (Dispatches strip + Fleet) — standing hit if faction, no fee.
  _missionCancelHtml(m) {
    const fac = m.faction && FACTIONS[m.faction];
    const note = fac ? ` · −standing w/ ${fac.name}` : "";
    return `<button class="btn btn-mini" data-mission-cancel="${m.uid}">${this.t("comms.cancelMission", "Cancel mission")}</button>`
      + (note ? `<span class="muted-note mission-cancel-note">${note}</span>` : "");
  },
  _activeMissionsStripHtml() {
    const ms = this.s().missions || [];
    if (!ms.length) return "";
    return `<div class="disp-missions"><div class="disp-missions-h">${this.t("comms.activeMissions", "Active missions")}</div>`
      + ms.map(m => {
        const fac = m.faction && FACTIONS[m.faction];
        return `<div class="disp-mission" data-m="${m.uid}">
          <div class="disp-mission-main"><b>${m.title}</b>
            <span class="muted-note">${m.sysName || ""}${fac ? ` · ${fac.name}` : ""} · ${(m.successChance * 100).toFixed(0)}%</span>
          </div>
          <div class="disp-mission-act">${this._missionCancelHtml(m)}</div>
        </div>`;
      }).join("") + `</div>`;
  },
  async cancelMission(uid) {
    if (Economy.busy()) return;
    const m = (this.s().missions || []).find(x => x.uid === uid);
    if (!m) return this.toast("Mission not found.", "warn");
    const fac = m.faction && FACTIONS[m.faction];
    const msg = fac
      ? `Abort "${m.title}"?\n${fac.name} standing will drop. No credit fee.`
      : `Abort "${m.title}"?\nShips return idle. No fee.`;
    if (!confirm(msg)) return;
    const r = await Missions.abandon(uid);
    if (!r.ok) return this.toast(r.msg, "warn");
    const hit = r.repHit || 0;
    this.toast(hit ? `Mission aborted (−${hit} ${fac ? fac.name : "standing"})` : "Mission aborted", "warn");
    this._missionSig = "";
    window.Game.requestSave();
    this.renderMissions(); this.renderFleet(); this.renderDispatches();
    if (this.commsTab === "pending") this.renderPendingContracts();
    this.updateHeader();
  },

  // ---- Dispatches: chat-style (preview list + open thread) ----------------
  // Left: conversation previews. Right: open thread (or empty prompt).
  // UI._dispatchArc null = nothing open; else = that contact's thread.
  renderDispatches() {
    const el = this.refs.dispatchBody; if (!window.Story || !el) return;
    el.onclick = e => this.onDispatchClick(e);
    if (this._dispatchArc && !Story.thread(this._dispatchArc).length) this._dispatchArc = null;
    const listHtml = this._dispatchListHtml();
    const paneHtml = this._dispatchArc
      ? this._threadHtml(this._dispatchArc)
      : `<div class="disp-empty"><p data-i18n="comms.clickOpen">${window.I18n ? I18n.t("comms.clickOpen") : "Click a message to open the conversation"}</p></div>`;
    el.classList.toggle("thread-open", !!this._dispatchArc);
    el.innerHTML = `<aside class="disp-sidebar">${this._activeMissionsStripHtml()}${listHtml}</aside><div class="disp-pane">${paneHtml}</div>`;
    if (this._dispatchArc) {
      // Stick to latest; older messages stay reachable by scrolling up.
      const pin = () => {
        const t = el.querySelector(".dispatch-thread");
        if (t) t.scrollTop = t.scrollHeight;
      };
      requestAnimationFrame(() => {
        pin();
        // Mobile: keep the open thread (and choice chips) above the floatnav.
        if (window.matchMedia && matchMedia("(max-width: 720px)").matches)
          el.scrollIntoView({ block: "start", behavior: "instant" in window ? "instant" : "auto" });
        requestAnimationFrame(pin);
      });
    }
  },

  _avatar(portrait) {
    return (portrait != null && window.ASSET)
      ? `<img class="disp-av" src="${ASSET.portrait(portrait)}" alt="" onerror="this.style.visibility='hidden'">`
      : `<span class="disp-av disp-av-blank"></span>`;
  },

  _dispatchListHtml() {
    const rows = Story.conversations();
    if (!rows.length) {
      return `<p class="muted-note disp-list-empty">No dispatches yet. Keep trading and building — someone always wants a word with a rising baron.</p>`;
    }
    return `<ul class="disp-list">` + rows.map(c => {
      const open = c.arc === this._dispatchArc;
      const dot = c.unread ? `<span class="disp-dot">${c.unread}</span>` : (c.action ? `<span class="disp-dot act">●</span>` : "");
      const tag = c.status === "active" ? (c.kind === "arc" ? "story" : "job") : c.status;
      return `<li class="disp-row${c.unread ? " unread" : ""}${open ? " open" : ""}" data-open="${c.arc}">${this._avatar(c.portrait)}` +
             `<div class="disp-row-main"><div class="disp-row-top"><b>${c.from}</b> <span class="disp-kind">${tag}</span>` +
             `<span class="disp-time">${Util.ago(c.ts)}</span></div><div class="disp-snip">${c.snippet}</div></div>${dot}</li>`;
    }).join("") + `</ul>`;
  },

  _threadHtml(arc) {
    const sv = Story.stepView(arc);
    const msgs = Story.thread(arc).map(m => {
      const side = m.type === "out" ? "out" : "in";
      const cls = m.type === "reward" ? "disp-msg reward" : "disp-msg " + side;
      const who = m.type === "out" ? "You" : m.from;
      return `<li class="${cls}">${side === "in" ? this._avatar(m.portrait) : ""}<div class="disp-bub">` +
             `<div class="disp-who">${who} <span class="disp-time">${Util.ago(m.ts)}</span></div>` +
             `<div class="disp-text">${m.text}</div></div></li>`;
    }).join("");

    let actions = "";
    if (sv && sv.type === "gate") {
      actions = `<div class="disp-obj">▸ ${sv.desc}</div><div class="disp-choices">` +
        `<button class="btn btn-mini btn-go" data-act="${arc}:accept">${sv.accept.label}</button>` +
        (sv.decline ? `<button class="btn btn-mini" data-act="${arc}:decline">${sv.decline.label}</button>` : "") + `</div>`;
    } else if (sv && sv.type === "objective") {
      actions = `<div class="disp-obj${sv.done ? " done" : ""}">${sv.done ? "✓ objective met — reward incoming" : "▸ " + sv.desc}</div>`;
    } else if (sv && sv.type === "choice") {
      actions = `<div class="disp-choices">` + sv.buttons.map(b =>
        `<button class="btn btn-mini" data-act="${arc}:choice:${b.i}" ${b.ok ? "" : "disabled"}>${b.label}${b.cost ? ` (−${Util.credits(b.cost)})` : ""}</button>`
      ).join("") + `</div>`;
    } else if (sv && sv.type === "info") {
      actions = `<div class="disp-choices"><button class="btn btn-mini btn-go" data-act="${arc}:continue">${sv.continueLabel || "Continue"}</button></div>`;
    } else {
      actions = `<div class="muted-note">Conversation closed.</div>`;
    }
    if (sv && sv.replies && sv.replies.length) {
      actions += `<div class="disp-replies">` + sv.replies.map(r =>
        `<button class="chip" data-act="${arc}:reply:${r.i}">${r.label}</button>`).join("") + `</div>`;
    }

    return `<div class="disp-thread-head"><b>${sv ? sv.from : arc}</b>` +
      `<button class="btn btn-mini" data-back="1" title="Close conversation">✕</button></div>` +
      `<ul class="dispatch-thread">${msgs}</ul>` +
      `<div class="disp-actions">${actions}</div>`;
  },

  onDispatchClick(e) {
    const abort = e.target.closest("[data-mission-cancel]");
    if (abort) { this.cancelMission(abort.dataset.missionCancel); return; }
    const back = e.target.closest("[data-back]");
    if (back) { this._dispatchArc = null; this.renderDispatches(); return; }
    const row = e.target.closest("[data-open]");
    if (row) {
      this._dispatchArc = row.dataset.open;
      Story.openConversation(this._dispatchArc);
      this.clearCommsBadge();
      this.renderDispatches();
      return;
    }
    const b = e.target.closest("[data-act]"); if (!b || b.disabled) return;
    const [arc, ...rest] = b.dataset.act.split(":");
    b.disabled = true;   // prevent double-tap while Phase 3 survey RPC settles
    Promise.resolve(Story.act(arc, rest.join(":"))).then(r => {
      if (r && !r.ok && r.msg) this.toast(r.msg, "warn");
      this.renderDispatches(); this.updateHeader();
      if (this.page === "fleet") this.renderFleet();
    }).catch(() => { this.renderDispatches(); });
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
    // Star Map is an overlay, so point the glow at its tab while it's open
    // instead of leaving the underlying page (e.g. Exchange) lit.
    const active = (window.StarMap && StarMap.open)
      ? track.querySelector('.tab[data-page="starmap"]')
      : track.querySelector(".tab.active");
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
        <button class="btn btn-mini" data-act="all">${T("btn.sellAll")}</button></div>
        <div class="ban-edict muted-note hidden" data-ban></div>`;
      tr.append(icon, name, price, chg, trend, held, pnl, act);
      body.appendChild(tr);
      const qin = act.querySelector(".qin");
      qin.addEventListener("input", () => this.updateAfford(c.id));
      this.rows[c.id] = { tr, name, price, chg, trend, held, pnl, qin,
        buyBtn: act.querySelector('[data-act="buy"]'), maxBtn: act.querySelector('[data-act="max"]'),
        sellBtn: act.querySelector('[data-act="sell"]'), allBtn: act.querySelector('[data-act="all"]'),
        banNote: act.querySelector("[data-ban]") };
    }
    // assignment (not addEventListener) so re-building on prestige can't stack handlers
    body.onclick = e => {
      const btn = e.target.closest("button[data-act]"); if (!btn) return;
      const id = btn.closest("tr").dataset.id, qin = this.rows[id].qin, act = btn.dataset.act;
      if (act === "buy") this.doTrade("buy", id, parseInt(qin.value, 10) || 0);
      else if (act === "sell") this.doTrade("sell", id, parseInt(qin.value, 10) || 0);
      else if (act === "max") this.doTrade("buy", id, Infinity);       // "as much as allowed"
      else if (act === "all") this.doTrade("sell", id, Infinity);
    };
  },
  tintBox(c) { const d = this.el("div", "tintbox"); d.textContent = (c.name || "?").slice(0, 2); return d; },

  // Clamp what the player asked for to what's actually possible — the smaller of
  // affordability/holdings and the tier trade cap — then reflect the real amount
  // back into the qty box so it never over-promises.
  async doTrade(side, id, want) {
    const tm = document.getElementById("trade-modal");
    if (tm && !tm.classList.contains("hidden")) return;   // terminal already open → ignore (anti-spam)
    if (Economy.busy()) return;                           // Phase 1 RPC still in flight
    want = Math.max(0, Math.floor(want || 0));
    const maxN = side === "buy" ? Economy.maxBuy(id) : Economy.maxSell(id);
    const capN = side === "buy" ? Economy.buyCapQty(id) : Economy.sellCapQty(id);
    const qty = Math.min(want, maxN);
    const row = this.rows[id];
    if (row && row.qin) row.qin.value = qty > 0 ? qty : 1;             // show the true amount that will trade
    if (qty <= 0) {
      const cat = (COMMODITIES.find(c => c.id === id) || {}).cat;
      const ban = window.Senate && Senate.banInfo(id, cat);
      if (ban) return this.toast(`${ban.name} has been banned due to ${ban.title}.`, "warn");
      this.toast(side === "buy" ? "Can't afford any here." : "Nothing to sell here.", "warn"); return;
    }
    const r = await (side === "buy" ? Economy.buy(id, qty) : Economy.sell(id, qty));
    if (!r.ok) { this.toast(r.msg, "warn"); this.updateHeader(); this.updateExchange(); return; }
    r.capped = want > maxN && capN <= maxN;   // the CAP (not funds/holdings) was the binding limit
    if (row && row.buyBtn) this.updateAfford(id);
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
      // Named edict lines before the money moves — duties / price props / earnings taxes.
      for (const ln of this._tradeEdictLines(isBuy, r)) this._tradeLine(log, ln);
      this._tradeLine(log, isBuy ? `▸ Transferring ${Util.credits(total)}c…` : `▸ Settling ${Util.credits(total)}c in proceeds…`);
      barWrap.classList.remove("hidden");
      requestAnimationFrame(() => { bar.style.width = "100%"; });
    }, t));
    t += reduced ? 320 : 900;
    this._tradeTimers.push(setTimeout(() => {
      this._tradeLine(log, `✓ ${isBuy ? "Purchase" : "Sale"} complete.`);
      const pnl = (!isBuy && typeof r.realized === "number")
        ? ` · <span class="${r.realized >= 0 ? "up" : "down"}">${r.realized >= 0 ? "+" : ""}${Util.credits(r.realized)}c</span>` : "";
      const taxNote = (!isBuy && r.tax) ? ` · <span class="down">−${Util.credits(r.tax)}c tax</span>` : "";
      const capNote = r.capped ? ` · <span class="down">tier trade cap hit — ${Util.credits(Economy.depth())}c/trade</span>` : "";
      const list = this._tradeEdictSummaryHtml(isBuy, r);
      result.innerHTML = `<b>${isBuy ? "Bought" : "Sold"} ${r.qty} ${comm.name}</b> @ avg ${Util.price(r.price)}c = <b>${Util.credits(total)}c</b>${pnl}${taxNote}${capNote}` +
        (list ? `<div class="trade-edicts">${list}</div>` : "") +
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
  // Clean named list of senate / tier taxes affecting this fill (log lines).
  _tradeEdictLines(isBuy, r) {
    const out = [];
    for (const d of (r.duties || [])) {
      const pct = `${d.rate >= 0 ? "+" : ""}${(d.rate * 100).toFixed(0)}%`;
      out.push(`▸ Duty — ${d.title} (${pct} on ${isBuy ? "ask" : "bid"})`);
    }
    for (const m of (r.marketEdicts || [])) {
      const pct = `${((m.mult - 1) * 100).toFixed(0)}%`;
      const how = m.type === "priceCap" ? "capped" : m.type === "ration" ? "propped (rationing)" : "propped";
      out.push(`▸ Market — ${m.title} (${how} ${pct.startsWith("-") ? pct : "+" + pct})`);
    }
    if (!isBuy && r.tax) {
      const lines = (r.taxLines && r.taxLines.length) ? r.taxLines : Economy.baronTaxLines();
      if (lines.length) {
        out.push(`▸ Taxes withheld (${Util.credits(r.tax)}c):`);
        for (const l of lines) out.push(`  · ${l.title} — ${(l.rate * 100).toFixed(0)}%`);
      } else {
        out.push(`▸ Baron tax withheld: ${Util.credits(r.tax)}c (${(Economy.baronTax() * 100).toFixed(0)}%)`);
      }
    }
    return out;
  },
  _tradeEdictSummaryHtml(isBuy, r) {
    const items = [];
    for (const d of (r.duties || []))
      items.push(`<li><b>${d.title}</b> — ${d.rate >= 0 ? "+" : ""}${(d.rate * 100).toFixed(0)}% duty</li>`);
    for (const m of (r.marketEdicts || []))
      items.push(`<li><b>${m.title}</b> — market ×${Number(m.mult).toFixed(2)}</li>`);
    if (!isBuy && r.tax) {
      const lines = (r.taxLines && r.taxLines.length) ? r.taxLines : Economy.baronTaxLines();
      for (const l of lines) items.push(`<li><b>${l.title}</b> — ${(l.rate * 100).toFixed(0)}% of profit</li>`);
    }
    return items.length ? `<ul class="edict-tax-list">${items.join("")}</ul>` : "";
  },

  updateExchange() {
    const sys = this.s().currentSystem;
    const sysName = this.sysName(sys);
    const pricesAt = (window.I18n && I18n.lang === "jp")
      ? `· ${sysName} ${I18n.t("exchange.pricesAt")}` : `· ${window.I18n ? I18n.t("exchange.pricesAt") : "prices at"} ${sysName}`;
    this.refs.exchangeSub.textContent = `${pricesAt} · trade cap ${Util.credits(Economy.depth())}c/order`;
    const note = document.getElementById("exchange-note");
    if (note) note.innerHTML =
      `<b>How trading works:</b> each sector capital has a <b>finite stock</b> of commodities. ` +
      `Buying depletes the shelf and scarcity pushes the price up; selling restocks it and eases the price. ` +
      `Stations across the sector feed the capital — starve a region and sentiment collapses. ` +
      `Each order is capped at <b>${Util.credits(Economy.depth())}c</b> ` +
      `(your <b>${Economy.tierTitle()}</b> tier), and <b>Buy Max</b> also clamps to units on the shelf.`;
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
      const r = this.rows[c.id]; if (!r) continue;
      const q = this.s().positions[c.id] || 0;
      const stocked = Market.stocks(c.id, sys);
      const shelf = window.Stock ? Stock.availableHere(sys, c.id) : null;
      // Hide unstocked rows unless you hold some (so you can still sell).
      r.tr.classList.toggle("hidden", !stocked && !q);
      if (!stocked && !q) continue;
      const p = Market.systemPrice(c.id, sys), prev = this.lastPrice[c.id];
      r.price.textContent = Util.price(p);
      if (shelf != null) r.price.title = `Sector stock: ${shelf} units`;
      if (prev != null && Math.abs(p - prev) > 1e-6) { r.price.classList.remove("up", "down"); void r.price.offsetWidth; r.price.classList.add(p > prev ? "up" : "down"); }
      this.lastPrice[c.id] = p;
      const pct = Market.changePct(c.id);
      r.chg.textContent = (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%";
      r.chg.className = "num chg " + (pct > 0.1 ? "up" : pct < -0.1 ? "down" : "");
      r.trend.innerHTML = this.spark(Market.history(c.id), pct >= 0);
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
  // Senate bans also lock Sell and show "[resource] has been banned due to [bill]".
  updateAfford(id) {
    const r = this.rows[id]; if (!r || !r.buyBtn) return;
    const c = COMMODITIES.find(x => x.id === id);
    const ban = window.Senate && c ? Senate.banInfo(id, c.cat) : null;
    if (r.banNote) {
      if (ban) { r.banNote.textContent = `${ban.name} has been banned due to ${ban.title}.`; r.banNote.classList.remove("hidden"); }
      else { r.banNote.textContent = ""; r.banNote.classList.add("hidden"); }
    }
    if (ban) {
      r.buyBtn.disabled = true; r.maxBtn.disabled = true;
      if (r.sellBtn) r.sellBtn.disabled = true;
      if (r.allBtn) r.allBtn.disabled = true;
      return;
    }
    const affordN = Economy.maxBuy(id);
    const qty = Math.floor(parseInt(r.qin.value, 10) || 0);
    r.buyBtn.disabled = !(qty > 0 && affordN >= qty);
    r.maxBtn.disabled = affordN < 1;
    if (r.sellBtn) r.sellBtn.disabled = Economy.maxSell(id) < 1;
    if (r.allBtn) r.allBtn.disabled = Economy.maxSell(id) < 1;
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
    this.refs.ordComm.innerHTML = Market.tradeable().map(c => `<option value="${c.id}">${c.name}</option>`).join("");
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
    if (this.refs.rank && window.Barons) {
      const r = Barons.rank(), n = Barons.count();
      this.refs.rank.textContent = r != null && n ? `#${r} / ${n}` : (n ? `— / ${n}` : "—");
    } else if (this.refs.rank) {
      this.refs.rank.textContent = "—";
    }
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
    // Stations tab appears once you own at least one (docs/STATIONS.md §5.3).
    if (this.refs.tabStations && window.Stations) {
      const n = Stations.ownedCount();
      this.refs.tabStations.classList.toggle("hidden", n < 1);
      if (n < 1 && this.page === "stations") this.showPage("hub");
    }
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
    scan:      { sym: "🔭", label: "Scan",      cls: "sc-sp" },
    endure:    { sym: "⚙", label: "Endure",    cls: "sc-ar" },
  },
  statChips(obj, keys = ["firepower", "hull", "armor", "shields", "cargo", "speed"]) {
    return keys.map(k => { const m = this.STAT_META[k]; if (!m || obj[k] == null) return "";
      return `<span class="sc ${m.cls}" title="${m.label}">${m.sym} ${m.label} ${obj[k]}</span>`;
    }).join("");
  },

  renderFleet() {
    const s = this.s();
    // main ship
    const md = Fleet.mainDef();
    const pas = Fleet.mainEffectsLabel();
    this.refs.fleetMain.innerHTML =
      `<h2>Flagship</h2>
       <div class="mainship">
         <img src="${ASSET.ship(md.sprite)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tintbox',textContent:'★'}))"/>
         <div><div class="ship-name">${md.name}${md.rarity ? ` <span class="cls-tag">${md.rarity}</span>` : ""}</div>
         <div class="ship-route">transfer speed ${md.travelSpeed} · <b>${pas}</b></div>
         <div class="muted-note">your private ship — sets sector travel time + empire bonuses. Upgrade in the Bazaar.</div></div>
       </div>`;
    // ships
    this.refs.fleetCount.textContent = `${s.ships.length}`;
    if (!s.ships.length) this.refs.fleetShips.innerHTML = `<p class="muted-note">No ships yet. Buy transports & escorts in the Bazaar.</p>`;
    else {
      const tools = s.ships.length > 1 ? this.bzTools([["Sort", "sort.ships", this.fleetSort.ships,
        [["name", "Name"], ["cls", "Class"], ["status", "Status"], ["firepower", "Firepower"], ["cargo", "Cargo"]]]]) : "";
      this.refs.fleetShips.innerHTML = tools +
        [...s.ships].sort(this.shipSorter(this.fleetSort.ships)).map(sh => this.shipCard(sh)).join("");
    }
    this.refs.fleetShips.onclick = e => this.onFleetClick(e);
    this.refs.fleetShips.onchange = e => this.onFleetSort(e);
    // inventory
    this.renderInventory();
    // charters + missions + reports
    this.renderCharters();
    this._missionSig = ""; this.renderMissions();
    this.renderReports();
  },

  // ---- fleet sorting ------------------------------------------------------
  // ponytail: Fleet.stats() re-runs per comparison over a fleet cap of ~24
  // ships; precompute a keyed array if hulls ever run into the hundreds.
  shipSorter(key) {
    const byName = (a, z) => a.name.localeCompare(z.name);
    const stat = f => (a, z) => f(Fleet.stats(z)) - f(Fleet.stats(a)) || byName(a, z);
    return {
      name: byName,
      cls: (a, z) => Fleet.shipDef(a.type).cls.localeCompare(Fleet.shipDef(z.type).cls) || byName(a, z),
      status: (a, z) => (a.status || "").localeCompare(z.status || "") || byName(a, z),
      firepower: stat(st => st.firepower),
      cargo: stat(st => st.cargo),
    }[key] || byName;
  },
  invSorter(key) {
    const rIdx = id => RARITIES.findIndex(r => r.id === id);
    const byName = (a, z) => a.name.localeCompare(z.name);
    return {
      value: (a, z) => z.value - a.value || byName(a, z),
      rarity: (a, z) => rIdx(z.rarity) - rIdx(a.rarity) || byName(a, z),
      kind: (a, z) => (a.kind || "").localeCompare(z.kind || "") || byName(a, z),
      name: byName,
    }[key] || byName;
  },
  // Reuses the Bazaar toolbar markup, so the selects carry data-bzf="sort.<key>".
  onFleetSort(e) {
    const sel = e.target.closest("[data-bzf]"); if (!sel) return;
    this.fleetSort[sel.dataset.bzf.split(".")[1]] = sel.value;
    this.renderFleet();
  },

  // ---- active charters (Fleet → Logistics) --------------------------------
  renderCharters() {
    const el = this.refs.fleetCharters; if (!el) return;
    const list = window.Charters ? Charters.active() : [];
    if (this.refs.chartersSub) this.refs.chartersSub.textContent = list.length ? `${list.length} running` : "";
    if (!list.length) {
      el.innerHTML = `<p class="muted-note">No charters running. Dispatch a hull from the Bazaar → Charters tab — the ship is locked until it returns.</p>`;
      el.onclick = null; return;
    }
    el.innerHTML = `<div class="contract-list">` + list.map(c => this._charterCardHtml(c)).join("") + `</div>`;
    el.onclick = e => {
      const btn = e.target.closest("[data-charter-cancel]"); if (!btn) return;
      this.cancelCharter(btn.dataset.charterCancel);
    };
  },

  // ---- anomaly survey (Star Map) -----------------------------------------
  openSurvey(sysId) {
    this._surveySys = sysId;
    const sys = Galaxy.get(sysId);
    this.refs.svTitle.textContent = `Survey ${sys ? sys.name : "system"}`;
    const idle = Fleet.idle().filter(sh => !sh.mercenary)
      .sort((a, b) => (Fleet.stats(b).scan || 0) - (Fleet.stats(a).scan || 0));
    if (!idle.length) {
      this.refs.svBody.innerHTML = `<p class="down">No idle ships — recall one from a mission or charter, or repair it first.</p>`;
      this.refs.svStart.disabled = true; this.refs.survey.classList.remove("hidden"); return;
    }
    const far = Expeditions.isFar(sysId);
    const rows = idle.map((sh, i) => {
      const def = Fleet.shipDef(sh.type), st = Fleet.stats(sh), eta = Expeditions.durationFor(sysId, sh.uid);
      const surveyTag = def.cls === "survey" ? ` <span class="up">survey hull</span>` : "";
      const warp = window.Senate ? Senate.travelEdictNote(eta) : "";
      return `<label class="rt-ship"><input type="radio" name="sv-ship" data-svship="${sh.uid}"${i === 0 ? " checked" : ""}/> <b>${sh.name}</b> <span class="cls-tag">${def.cls}</span>${surveyTag} · 🔭 scan ${st.scan.toFixed(1)} · endure ${st.endure.toFixed(1)} · ETA ~${Util.duration(eta)}${warp}</label>`;
    }).join("");
    this.refs.svBody.innerHTML =
      `<p class="muted-note">Dispatch a ship to chart this outpost. When it returns, a <b>Dispatches</b> debrief opens — choices, scan odds, and loot. Survey hulls + Deep Scanners push success %.</p>
       <p class="si-effects"><span class="local-effect ${far ? "down" : "up"}">${far ? "⚠ Far & rough — richer finds, steeper failure odds on risky pushes." : "Nearby — modest finds, kinder odds."}</span></p>
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
    else if (sh.status === "charter") status = `<span class="badge trade">on charter</span>`;
    else if (sh.status === "surveying") status = `<span class="badge">surveying</span>`;
    else if (sh.status === "debrief") status = `<span class="badge">debrief</span>`;
    else status = `<span class="badge idle">idle</span>`;
    const dmg = sh.dmg || 0;
    const hullPct = Math.round((1 - dmg) * 100);
    if (dmg) status += ` <span class="badge ${hullPct < 40 ? "bad" : "merc"}" title="damaged — firepower & speed suffer until repaired">hull ${hullPct}%</span>`;
    const merc = sh.mercenary ? `<span class="badge merc">merc · ${Util.duration((sh.expiresAt || 0) - Date.now())}</span>` : "";
    const sprite = ASSET.shipArt(sh.type, sh.uid);
    const variant = Fleet.variantFor(sh);
    const refit = variant && variant.id !== "stock"
      ? ` · <span class="bc-variant">${variant.name} <span class="muted-note">${Fleet.variantEffects(variant)}</span></span>` : "";
    const equipBtn = sh.status === "idle" && used < slots
      ? `<button class="btn btn-mini" data-equip-ship="${sh.uid}">+ Equip</button>` : "";
    const sellBtn = sh.status === "idle" && !sh.mercenary
      ? `<button class="btn btn-mini btn-sellship" data-sellship="${sh.uid}" title="sells with its equipped gear">Sell ${Util.credits(Bazaar.shipSaleValue(sh))}c</button>` : "";
    const repairBtn = sh.status === "idle" && dmg
      ? `<button class="btn btn-mini" data-repair="${sh.uid}" title="restores hull, firepower and speed">🔧 Repair ${Util.credits(Fleet.repairCost(sh))}c</button>` : "";
    return `<div class="ship cls-${def.cls}">
      <img src="${sprite}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tintbox',textContent:'${def.name[0]}'}))"/>
      <div class="ship-info">
        <div class="ship-name">${sh.name} ${status} ${merc}</div>
        <div class="ship-route">${def.name} · <span class="cls-tag">${def.cls}</span> · slots ${used}/${slots}${refit}</div>
        <div class="statline">${this.statChips(st, def.cls === "survey" ? ["scan", "endure", "speed", "hull", "cargo", "firepower"] : undefined)}</div>
        <div class="acc-row">${acc}${equipBtn}${repairBtn}${sellBtn}</div>
      </div></div>`;
  },

  // Repair / equip / unequip are RPCs when the server owns the fleet, so every
  // one of these is awaited — a sync read of the result would show `undefined`
  // for .ok and swallow the server's error message.
  async onFleetClick(e) {
    const un = e.target.closest("[data-unequip]"); const eq = e.target.closest("[data-equip-ship]");
    const rt = e.target.closest("[data-retrieve]"); const sl = e.target.closest("[data-sellship]");
    const rp = e.target.closest("[data-repair]");
    if ((un || rp) && Economy.busy()) return;
    if (un) {
      const [shipU, itemU] = un.dataset.unequip.split(":");
      const r = await Fleet.unequip(shipU, itemU);
      if (r && !r.ok && r.msg) return this.toast(r.msg, "warn");
      window.Game.requestSave(); this.renderFleet();
    }
    else if (eq) { this.openEquipForShip(eq.dataset.equipShip); }
    else if (rp) { const r = await Fleet.repair(rp.dataset.repair); if (!r.ok) return this.toast(r.msg, "warn"); this.toast(`Hull patched for ${Util.credits(r.cost)}c.`, "good"); this.flashCredits(); window.Game.requestSave(); this.renderFleet(); this.updateHeader(); }
    else if (rt) { const r = Fleet.retrieve(rt.dataset.retrieve); if (!r.ok) return this.toast(r.msg, "warn"); this.toast("Ship retrieved.", "good"); this.flashCredits(); window.Game.requestSave(); this.renderFleet(); }
    else if (sl) {
      void this._sellShipClick(sl.dataset.sellship);
    }
  },
  async _sellShipClick(uid) {
    const sh = Fleet.ship(uid); if (!sh) return;
    const val = Bazaar.shipSaleValue(sh), n = (sh.accessories || []).length, name = sh.name;
    const extra = n ? ` and its ${n} equipped item${n > 1 ? "s" : ""}` : "";
    if (!confirm(`Sell ${name}${extra} for ${Util.credits(val)}c? This can't be undone.`)) return;
    if (Economy.busy()) return;
    const r = await Bazaar.sellShip(uid);
    if (!r.ok) return this.toast(r.msg, "warn");
    this.toast(`Sold ${name} for ${Util.credits(r.credits)}c`, "good");
    this.flashCredits(); window.Game.requestSave(); this.renderFleet(); this.updateHeader();
  },

  // Tiny art tag for gear/extractor cards — tintbox letter if the PNG is missing.
  _art(src, letter) {
    const L = (letter || "?").toString().slice(0, 1).replace(/'/g, "");
    return `<img class="item-art" src="${src}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tintbox item-art',textContent:'${L}'}))"/>`;
  },

  renderInventory() {
    const inv = Bazaar.inventoryItems(), listed = this.s().listings;
    this.refs.invCount.textContent = `${Bazaar.inventoryUsed()}/${Bazaar.capacity()}`;
    let html = "";
    if (!inv.length && !listed.length) html = `<p class="muted-note">Empty. Buy accessories or blackboxes in the Bazaar, or win them from contracts &amp; surveys.</p>`;
    if (inv.length > 1) html += this.bzTools([["Sort", "sort.inv", this.fleetSort.inv,
      [["value", "Value"], ["rarity", "Rarity"], ["kind", "Type"], ["name", "Name"]]]]);
    if (inv.length) {
      html += `<div class="buy-grid">` + [...inv].sort(this.invSorter(this.fleetSort.inv)).map(it => {
        const box = Items.isBlackbox(it);
        const kind = ACCESSORY_KINDS[it.kind], letter = box ? "B" : ((kind && kind.label) || it.kind || "?");
        const art = box ? this._art(ASSET.blackbox(it.effectId, it.uid), letter)
          : this._art(ASSET.accessory(it.kind, it.uid), letter);
        const rarLabel = box ? "consumable" : ((Items.rarity(it.rarity) || {}).label || "");
        const act = box
          ? `<button class="btn btn-mini btn-go" data-use="${it.uid}">Use</button>`
          : `<button class="btn btn-mini" data-equip="${it.uid}">Equip</button>`;
        return `<div class="buy-card inv-card" style="border-color:${this.rarityColor(it.rarity)}">
          ${art}
          <div class="bc-name">${it.name}</div>
          <div class="rar" style="color:${this.rarityColor(it.rarity)}">${rarLabel}</div>
          <div class="bc-stats">${Items.label(it)}</div>
          <div class="item-acts inv-acts">
            <span class="item-val">${Util.credits(it.value)}c</span>
            ${act}
            <button class="btn btn-mini" data-sellnow="${it.uid}">Sell ${Util.credits(Math.round(it.value * BAZAARCFG.itemResaleMult))}c</button>
          </div></div>`;
      }).join("") + `</div>`;
    }
    if (listed.length) {
      html += `<div class="inv-sub">Listed on the market</div><div class="buy-grid">` + listed.map(l => {
        const it = this.s().items[l.itemUid]; if (!it) return "";
        const kind = ACCESSORY_KINDS[it.kind], letter = (kind && kind.label) || it.kind || "?";
        return `<div class="buy-card inv-card listed" style="border-color:${this.rarityColor(it.rarity)}">
          ${this._art(ASSET.accessory(it.kind, it.uid), letter)}
          <div class="bc-name">${it.name}</div>
          <div class="rar">listed · ${Util.credits(l.listPrice)}c</div>
          <div class="bc-stats">${Items.label(it)}</div>
          <div class="item-acts inv-acts"><button class="btn btn-mini" data-cancel="${l.itemUid}">Cancel listing</button></div></div>`;
      }).join("") + `</div>`;
    }
    this.refs.fleetInventory.innerHTML = html;
    this.refs.fleetInventory.onchange = e => this.onFleetSort(e);
    this.refs.fleetInventory.onclick = e => {
      const eq = e.target.closest("[data-equip]"), use = e.target.closest("[data-use]");
      const sn = e.target.closest("[data-sellnow]"), ca = e.target.closest("[data-cancel]");
      if (use) this._useBlackbox(use.dataset.use);
      else if (eq) this.openEquipForItem(eq.dataset.equip);
      else if (sn) { void this._sellItemClick(sn.dataset.sellnow); }
      else if (ca) { Bazaar.cancelListing(ca.dataset.cancel); this.toast("Listing cancelled.", "info"); window.Game.requestSave(); this.renderInventory(); }
    };
  },
  _useBlackbox(uid) {
    if (!window.Boosts) return;
    const r = Boosts.use(uid);
    if (!r.ok) return this.toast(r.msg || "Can't use.", "warn");
    this.toast(`${r.effect.name} active — ${r.effect.desc}`, "good");
    window.Game.requestSave();
    this.renderInventory();
    this.renderBoostBar();
  },
  async _sellItemClick(uid) {
    if (Economy.busy()) return;
    const r = await Bazaar.sellNow(uid);
    if (!r.ok) return this.toast(r.msg || "Can't sell.", "warn");
    this.toast(`Sold for ${Util.credits(r.credits)}c`, "good");
    this.flashCredits(); window.Game.requestSave(); this.renderFleet();
  },

  // ---- missions -----------------------------------------------------------
  renderMissions() {
    const ms = this.s().missions;
    const sig = ms.map(m => m.uid).join(",");
    if (sig === this._missionSig) { this.updateMissions(); return; }
    this._missionSig = sig;
    if (!ms.length) { this.refs.fleetMissions.innerHTML = `<p class="muted-note">No active missions. Take a contract in the Bazaar.</p>`; return; }
    this.refs.fleetMissions.innerHTML = ms.map(m => {
      const icons = m.shipUids.map(u => { const sh = Fleet.ship(u); if (!sh) return ""; const sprite = ASSET.shipArt(sh.type, sh.uid); return `<img class="mi" src="${sprite}" alt="" title="${sh.name}" onerror="this.style.display='none'"/>`; }).join("");
      return `<div class="mission" data-m="${m.uid}">
        <div class="m-head"><b>${m.title}</b><span class="m-chance">${(m.successChance * 100).toFixed(0)}% success</span></div>
        <div class="m-ships">${icons}</div>
        <div class="mbar"><span class="mbar-fill"></span></div>
        <div class="m-foot"><span class="m-phase"></span><span class="m-eta"></span></div>
        <div class="m-cancel">${this._missionCancelHtml(m)}</div>
      </div>`;
    }).join("");
    this.refs.fleetMissions.onclick = e => {
      const b = e.target.closest("[data-mission-cancel]");
      if (b) this.cancelMission(b.dataset.missionCancel);
    };
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
        if (r.blueprint) detail += ` · blueprint: ${r.blueprint}`;
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
    const list = idle.map(sh => {
      const st = Fleet.stats(sh), def = Fleet.shipDef(sh.type);
      const ban = window.Senate ? Senate.shipBanInfo(def.cls) : null;
      if (ban) {
        return `<label class="mm-ship locked"><input type="checkbox" data-ship="${sh.uid}" disabled/> <b>${sh.name}</b> <span class="cls-tag">${def.cls}</span> <span class="down">${def.cls}-class ships banned due to ${ban.title}</span></label>`;
      }
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
  async launchMission() {
    const c = this._pending; if (!c) return;
    if (Economy.busy()) return;
    const r = await Missions.launch(c, this.selectedShipUids());
    if (!r.ok) return this.toast(r.msg, "warn");
    this.toast("Mission launched ▸", "good");
    this._pending = null; this.refs.mission.classList.add("hidden");
    this._missionSig = "";
    window.Game.requestSave(); this.renderFleet(); this.renderBazaar(); this.renderDispatches();
    if (this.commsTab === "pending") this.renderPendingContracts();
    this.updateHeader();
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
    this.refs.eqBody.querySelectorAll(".eq-pick").forEach(b => b.onclick = async () => {
      if (Economy.busy()) return;
      const r = await Fleet.equip(b.dataset.ship, itemUid);
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast("Equipped.", "good"); this.refs.equip.classList.add("hidden");
      window.Game.requestSave(); this.renderFleet();
    });
    this.refs.equip.classList.remove("hidden");
  },
  openEquipForShip(shipUid) {
    const inv = Bazaar.inventoryItems().filter(it => !Items.isBlackbox(it));
    this.refs.eqTitle.textContent = "Equip a slot — " + Fleet.ship(shipUid).name;
    this.refs.eqBody.innerHTML = inv.length
      ? inv.map(it => `<button class="btn eq-pick" data-item="${it.uid}" style="border-left:3px solid ${this.rarityColor(it.rarity)}">${it.name} — ${Items.label(it)}</button>`).join("")
      : `<p class="muted-note">No accessories in inventory. Buy some in the Bazaar.</p>`;
    this.refs.eqBody.querySelectorAll(".eq-pick").forEach(b => b.onclick = async () => {
      if (Economy.busy()) return;
      const r = await Fleet.equip(shipUid, b.dataset.item);
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
    // The shipyard is a rotating shelf of named, refitted second-hand hulls —
    // not the catalog. The free starter ship is the one exception: it's shown
    // whenever the player has no ships at all (the flagship doesn't count), so a
    // wiped-out player is never stranded waiting for the shelf to turn.
    const noShips = this.s().ships.length === 0;
    const starterDef = SHIP_CATALOG.transport.find(d => d.price === 0 && !d.craftOnly);
    const starter = (noShips && starterDef) ? `<div class="buy-card">
      <img src="${ASSET.ship(starterDef.sprite)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tintbox',textContent:'${starterDef.name[0]}'}))"/>
      <div class="bc-name">${starterDef.name} <span class="cls-tag">${starterDef.cls}</span></div>
      <div class="bc-variant">yard loaner · always available</div>
      <div class="statline bc-statline">${this.statChips(starterDef, ["firepower", "hull", "armor", "shields", "cargo", "speed"])}</div>
      <button class="btn btn-go" data-buyship="${starterDef.id}" data-cost="0">Free</button></div>` : "";
    const yardOffers = (b.yard || []).map(o => {
      const d = Fleet.shipDef(o.shipType); if (!d) return "";
      const v = Fleet.variantDef(o.variantId);
      const sprite = ASSET.shipArt(o.shipType, o.id);
      const keys = d.cls === "survey" ? ["scan", "endure", "speed", "hull", "cargo"] : ["firepower", "hull", "armor", "shields", "cargo", "speed"];
      // Preview the refitted numbers, not the catalog ones — otherwise the card
      // advertises stats the ship won't have once it's in the fleet.
      const st = {};
      for (const k of keys.concat(["slots"])) {
        const base = d[k] || 0, mod = (v && v.mods[k]) || 0;
        st[k] = k === "speed" ? +(base * (1 + mod)).toFixed(2)
          : k === "scan" || k === "endure" ? +(base * (1 + mod)).toFixed(1)
            : Math.round(base * (1 + mod));
      }
      const cost = Math.round((d.price || 0) * (1 - Rep.discount()));
      return `<div class="buy-card">
      <img src="${sprite}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tintbox',textContent:'${o.name[0]}'}))"/>
      <div class="bc-name">${o.name} <span class="cls-tag">${d.cls}</span></div>
      <div class="bc-variant">${d.name}${v && v.id !== "stock" ? ` · <b>${v.name}</b> ${v.tag}` : ` · ${v ? v.tag : "stock"}`}</div>
      <div class="statline bc-statline">${this.statChips(st, keys)}</div>
      <div class="muted-note">${Fleet.variantEffects(v)} · ${d.slots} slot${d.slots === 1 ? "" : "s"}</div>
      <button class="btn btn-go" data-buyyard="${o.id}" data-cost="${cost}">${Util.credits(cost)}c</button></div>`;
    }).join("");
    const yard = starter + (yardOffers
      || `<p class="muted-note">The yard is between deliveries — check back shortly.</p>`);

    // Flagships: CURRENT always first (compare), then rotating bazaar offers.
    const curMain = Fleet.mainDef();
    const curCard = `<div class="buy-card current-flag">
        <img src="${ASSET.ship(curMain.sprite)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tintbox',textContent:'★'}))"/>
        <div class="bc-name">${curMain.name} <span class="cls-tag">${curMain.rarity || "flagship"}</span></div>
        <div class="bc-stats">» Transfer ${curMain.travelSpeed} · ${Fleet.mainEffectsLabel()}</div>
        <span class="badge">current flagship</span></div>`;
    const flagOffers = (b.flagships || []).map(o => {
      const d = SHIP_CATALOG.main.find(x => x.id === o.shipType); if (!d) return "";
      const effects = (d.effects || []).map(e => {
        const meta = (FLAGSHIP_EFFECTS && FLAGSHIP_EFFECTS[e.type]) || { label: e.type };
        return `+${Math.round(e.pct * 100)}% ${meta.label}`;
      }).join(" · ");
      const cost = Math.round(o.price * (1 - Rep.discount()));
      return `<div class="buy-card">
        <img src="${ASSET.ship(d.sprite)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tintbox',textContent:'★'}))"/>
        <div class="bc-name">${d.name} <span class="cls-tag">${d.rarity || o.rarity}</span></div>
        <div class="bc-stats">» Transfer ${d.travelSpeed} · ${effects}</div>
        <div class="muted-note">${(d.effects || []).length} effect${(d.effects || []).length === 1 ? "" : "s"} · compare with current ↑</div>
        <button class="btn btn-go" data-buymain="${d.id}" data-offer="${o.id}" data-cost="${cost}">${Util.credits(cost)}c</button></div>`;
    }).join("") || `<p class="muted-note">No flagship offers right now — the yard rotates.</p>`;
    const mains = curCard + flagOffers;

    const mercSorters = {
      power: (a, z) => z.firepower - a.firepower,
      cost: (a, z) => a.hireCost - z.hireCost,
      expiry: (a, z) => a.availUntil - z.availUntil,
    };
    const mercTools = this.bzTools([["Sort", "sort.mercs", this.bzSort.mercs,
      [["power", "Firepower"], ["cost", "Cost"], ["expiry", "Offer ending"]]]]);
    const mercs = [...(b.mercs || [])].sort(mercSorters[this.bzSort.mercs] || mercSorters.power)
      .map(m => {
        const def = Fleet.shipDef(m.shipType) || { name: m.shipType };
        return `<div class="buy-card merc">
        ${this._art(ASSET.merc(m.shipType, m.id), (def.name || "M")[0])}
        <div class="bc-name">${m.name} <span class="cls-tag">merc</span></div>
        <div class="bc-stats">${def.name}</div>
        <div class="statline bc-statline">${this.statChips(m, ["firepower", "hull"])}</div>
        <div class="muted-note">serves ${Util.duration(m.serviceMs)} · offer ends ${Util.duration(m.availUntil - Date.now())}</div>
        <button class="btn btn-go" data-hire="${m.id}" data-cost="${m.hireCost}">Hire ${Util.credits(m.hireCost)}c</button></div>`;
      }).join("") || `<p class="muted-note">No mercenaries on offer right now.</p>`;

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
    const tipCard = c => `<div class="contract tip">${this._art(ASSET.contract("tip"), "T")}
        <div class="c-head"><b>${c.title}</b><span class="ctype">insider tip</span></div>
        <div class="c-desc">${c.desc}</div>
        <div class="c-tags">${sponChip(c.faction)}</div>
        <div class="c-foot"><span class="muted-note">expires ${Util.duration(c.expiresAt - Date.now())}</span>
        <button class="btn btn-go" data-take="${c.id}" data-cost="${c.cost}">Buy tip ${Util.credits(c.cost)}c</button></div></div>`;
    const jobCard = c => {
      const danger = DANGER.find(d => d.id === c.danger);
      const ok = idlePower >= (c.minFirepower || 0);
      const bonus = c.faction ? (Rep.rewardMult(c.faction) - 1) : 0;
      const stationTag = c.source === "station"
        ? `<span class="c-station" title="Station haul">◈ ${c.stationName || "Station"} · ${c.ownerHandle || "Baron"}</span>`
        : "";
      return `<div class="contract${c.source === "station" ? " contract-station" : ""}">${this._art(ASSET.contract(c.type), (c.type || "C")[0])}
        <div class="c-head"><b>${c.title}</b><span class="ctype ct-${c.type}">${c.type}</span></div>
        <div class="c-desc">${c.desc}</div>
        <div class="c-tags">${stationTag}${sponChip(c.faction)}${c.warEffort ? `<span class="war-effort">⚔ war effort</span>` : ""}<span class="dgr-${c.danger}">${danger.label}</span>
          ${c.minFirepower ? `<span class="${ok ? "" : "down"}">⚔ need ${c.minFirepower}</span>` : `<span class="up">no escort needed</span>`}
          ${c.cargoRequired ? `<span>▣ ${c.cargoRequired}</span>` : ""}
          <span>⌁ ${Util.duration(c.durationMs / (window.Game.timeScale || 1))}</span>
          <span class="up">${Util.credits(c.reward.credits)}c${bonus > 0.001 && c.source !== "station" ? ` <span class="rep-bonus">+${(bonus * 100).toFixed(0)}%</span>` : ""}</span></div>
        <div class="c-foot"><span class="muted-note">expires ${Util.duration(c.expiresAt - Date.now())}</span>
          <button class="btn btn-go" data-view="${c.id}">${this.t("comms.viewContract", "View Contract")}</button></div></div>`;
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
        const letter = ((ACCESSORY_KINDS[it.kind] || {}).label || it.kind || "?")[0];
        return `<div class="item buy" style="border-left-color:${this.rarityColor(it.rarity)}">
        ${this._art(ASSET.accessory(it.kind, it.uid), letter)}
        <div class="item-top"><b>${it.name}</b><span class="rar" style="color:${this.rarityColor(it.rarity)}">${(Items.rarity(it.rarity) || {}).label}</span></div>
        <div class="item-stat">${Items.label(it)}</div>
        <div class="item-acts"><span class="item-val">${Util.credits(a.price)}c</span>
        <button class="btn btn-mini" data-buyacc="${a.id}" data-cost="${Math.round(a.price * (1 - Rep.discount()))}">Buy</button></div></div>`;
      }).join("") || `<p class="muted-note">${allAcc.length ? "No gear matches this filter." : "Restocking the accessory stalls…"}</p>`;

    const boxes = (b.blackboxes || []).map(a => {
      const it = a.item, price = Math.round(a.price * (1 - Rep.discount()));
      const e = BLACKBOX_EFFECTS.find(x => x.id === it.effectId);
      return `<div class="item buy" style="border-left-color:${this.rarityColor(it.rarity)}">
        ${this._art(ASSET.blackbox(it.effectId, it.uid), "B")}
        <div class="item-top"><b>${it.name}</b><span class="rar" style="color:${this.rarityColor(it.rarity)}">blackbox</span></div>
        <div class="item-stat">${e ? e.desc : Items.label(it)} · ${e ? Util.duration(e.durationMs) : ""}</div>
        <div class="item-acts"><span class="item-val">${Util.credits(price)}c</span>
        <button class="btn btn-mini" data-buyblackbox="${a.id}" data-cost="${price}">Buy</button></div></div>`;
    }).join("") || `<p class="muted-note">No blackboxes in stock — check back soon.</p>`;

    const bps = (b.blueprints || []).map(a => {
      const price = Math.round(a.price * (1 - Rep.discount()));
      return `<div class="item buy" style="border-left-color:#5aa9ff">
        ${this._art(ASSET.blueprint(a.blueprintId, a.id), "P")}
        <div class="item-top"><b>${a.name}</b><span class="rar" style="color:#5aa9ff">${a.outputType}</span></div>
        <div class="item-stat">Unlocks a Workshop recipe permanently</div>
        <div class="item-acts"><span class="item-val">${Util.credits(price)}c</span>
        <button class="btn btn-mini" data-buyblueprint="${a.id}" data-cost="${price}">Buy</button></div></div>`;
    }).join("") || `<p class="muted-note">No blueprints in stock — check back soon.</p>`;

    const exo = (b.extractors || []).map(o => {
      const t = EXTRACTORCFG.types[o.ex.type], price = Math.round(o.price * (1 - Rep.discount()));
      return `<div class="item buy ext-${o.ex.type}">
        ${this._art(ASSET.extractor(o.ex.type, o.ex.uid), (t.label || "E")[0])}
        <div class="item-top"><b>${o.ex.name}</b><span class="rar">${t.label} ×${t.yieldMult}</span></div>
        <div class="item-stat">${Extractors.describe(o.ex)}</div>
        <div class="item-acts"><span class="item-val">${Util.credits(price)}c</span>
        <button class="btn btn-mini" data-buyextractor="${o.id}" data-cost="${price}">Buy</button></div></div>`;
    }).join("") || `<p class="muted-note">No extractors in stock — check back soon.</p>`;

    const comp = (b.components || []).map(o => {
      const col = this.rarityColor(o.comp.rarity), price = Math.round(o.price * (1 - Rep.discount()));
      const label = (COMPONENTCFG.kinds[o.comp.kind] || {}).label || o.comp.kind;
      return `<div class="item buy" style="border-left-color:${col}">
        ${this._art(ASSET.component(o.comp.kind, o.comp.uid), (label || "C")[0])}
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
    const activeCharters = window.Charters ? Charters.active().length : 0;
    // Blackboxes/blueprints are one shelf per day — say so, or an empty grid just
    // looks broken to someone who bought both slots this morning.
    const restockNote = `<p class="muted-note">Restocks in <b>${Util.duration(Bazaar.slowRestockMs())}</b> — one shelf per day.</p>`;

    // Each Bazaar area is its own sub-tab so the page never grows past one screen.
    const sections = {
      shipyard: `<div class="panel"><h2>Shipyard <small>named hulls, each with its own yard refit</small></h2>
             <p class="muted-note">Every ship on the shelf is a one-off refit — a hauler that traded speed for hold space, a runner that traded hold space for speed. The shelf turns over in <b>${Util.duration(Bazaar.yardRestockMs())}</b>; what you see now won't be here after that.</p>
             <div class="buy-grid">${yard}</div></div>`,
      flagships: `<div class="panel"><h2>Flagships <small>current ship pinned · offers rotate</small></h2><div class="buy-grid">${mains}</div></div>`,
      mercs: `<div class="panel"><h2>Mercenaries <small>rented firepower, time-limited</small></h2>${mercTools}<div class="buy-grid">${mercs}</div></div>`,
      contracts: `<div class="panel"><h2>Contract Board</h2>${contractTools}<div class="contract-list">${contracts}</div></div>`
        + `<div class="panel"><h2>Senator Dossiers <small>unlock hidden stances &amp; voting records</small></h2><div class="contract-list">${dossiers}</div></div>`,
      charters: this._charterPanelHtml(),
      gear: `<div class="panel"><h2>Accessory Market <small>names & stats vary — grab the good ones fast</small></h2>${gearTools}<div class="item-grid">${acc}</div></div>
             <div class="panel"><h2>Blackboxes <small>consumable timed buffs — Use from Inventory</small></h2>${restockNote}<div class="item-grid">${boxes}</div></div>
             <div class="panel"><h2>Blueprints <small>unlock Workshop recipes</small></h2>${restockNote}<div class="item-grid">${bps}</div></div>
             <div class="panel"><h2>Inventory Bay</h2><p>Capacity <b>${Bazaar.inventoryUsed()}/${Bazaar.capacity()}</b>. Expand by ${BAZAARCFG.inventoryUpgradeStep} slots.</p>
               <button class="btn btn-go" id="buy-inv" data-cost="${invCost}">Upgrade — ${Util.credits(invCost)}c</button></div>`,
      extractors: `<div class="panel"><h2>Extractors <small>install on a planet permit (Industries) to mine &amp; manufacture</small></h2><div class="item-grid">${exo}</div></div>
             <div class="panel"><h2>Components <small>fit into an extractor to boost yield / cut cycle time</small></h2><div class="item-grid">${comp}</div></div>`,
      standing,
    };
    const tabs = [["shipyard", "Shipyard"], ["flagships", "Flagships"], ["mercs", "Mercenaries"],
      ["contracts", "Contracts"], ["charters", "Charters"], ["gear", "Gear"], ["extractors", "Extractors"], ["standing", "Standing"]];
    if (!sections[this.bazaarTab]) this.bazaarTab = "shipyard";
    const subtabs = tabs.map(([k, label]) =>
      `<button class="subtab ${k === this.bazaarTab ? "active" : ""}" data-bz="${k}">${label}` +
      `${k === "contracts" && openContracts ? ` <span class="tab-badge">${openContracts}</span>` : ""}` +
      `${k === "charters" && activeCharters ? ` <span class="tab-badge">${activeCharters}</span>` : ""}</button>`).join("");

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
    if (e.target && e.target.id === "ch-ship") {
      this.charterPick.shipUid = e.target.value; this.renderBazaar(); return;
    }
    const sel = e.target.closest("[data-bzf]"); if (!sel) return;
    const [kind, tab] = sel.dataset.bzf.split(".");
    (kind === "sort" ? this.bzSort : this.bzFilt)[tab] = sel.value;
    this.renderBazaar();
  },

  _fmtDurMin(m) {
    if (m < 60) return m + "m";
    const h = m / 60;
    return (h === (h | 0) ? h : h.toFixed(1)) + "h";
  },
  _charterPanelHtml() {
    const idle = Fleet.idle().filter(sh => !sh.mercenary);
    const pick = this.charterPick;
    if (!idle.length) {
      return `<div class="panel"><h2>Charter a hull</h2>
        <p class="muted-note">No idle ships. Finish a mission or wait for a charter to return.</p></div>`;
    }
    if (!pick.shipUid || !idle.some(sh => sh.uid === pick.shipUid)) pick.shipUid = idle[0].uid;
    if (!CHARTERCFG.durations.includes(pick.durationMin)) pick.durationMin = 60;
    if (!CHARTER_BANDS[pick.band]) pick.band = "safe";
    const sh = Fleet.ship(pick.shipUid);
    const st = Fleet.stats(sh);
    const durationMs = pick.durationMin * 60000;
    const reward = Charters.quote(sh, pick.band, durationMs);
    const afterTax = Economy.afterTax(reward);
    const lose = Charters.destroyChance(sh, pick.band, durationMs);
    const abortFee = -Charters.cancelPreview(reward, lose, durationMs, 0);
    const buyout = Charters.cancelPreview(reward, lose, durationMs, durationMs * CHARTERCFG.bailoutAt);
    const bailMin = Math.round(pick.durationMin * CHARTERCFG.bailoutAt);
    const bandInfo = CHARTER_BANDS[pick.band] || {};
    const freeLeft = idle.filter(x => x.uid !== pick.shipUid).length;
    const stranded = freeLeft === 0 && this.s().credits <= 0;
    const atCap = Charters.active().length >= CHARTERCFG.maxActive;
    const shipOpts = idle.map(s => {
      const sst = Fleet.stats(s);
      return `<option value="${s.uid}"${s.uid === pick.shipUid ? " selected" : ""}>${s.name} · ▣ ${sst.cargo} ⚔ ${sst.firepower}</option>`;
    }).join("");
    const durBtns = CHARTERCFG.durations.map(m =>
      `<button type="button" class="btn btn-mini ch-dur ${m === pick.durationMin ? "active" : ""}" data-ch-dur="${m}">${this._fmtDurMin(m)}</button>`).join("");
    const bandBtns = DANGER.map(d =>
      `<button type="button" class="btn btn-mini ch-band dgr-${d.id} ${d.id === pick.band ? "active" : ""}" data-ch-band="${d.id}">${d.label}</button>`).join("");
    let disableReason = "";
    if (atCap) disableReason = `Already running ${CHARTERCFG.maxActive} charters.`;
    else if (stranded) disableReason = "Can't charter your last hull with no credits — you'd be stranded.";
    return `<div class="panel"><h2>Charter a hull <small>stake a ship, not credits</small></h2>
      <p class="muted-note">Pick how long and how dangerous. Safe runs pay steadily; smuggling runs pay far more and sometimes don't come back. The hull is locked until return — buy it back early for a fee.</p>
      <div class="rt-form ch-form">
        <label>Ship <select id="ch-ship">${shipOpts}</select></label>
        <div class="ch-stats">▣ ${st.cargo} · ⚔ ${st.firepower} · ♥ ${Math.round(st.hull * (1 - (sh.dmg || 0)))}/${st.hull}</div>
      </div>
      <div class="ch-row"><span class="ch-label">Duration</span><div class="ch-btns">${durBtns}</div></div>
      <div class="ch-row"><span class="ch-label">Risk</span><div class="ch-btns">${bandBtns}</div></div>
      <p class="muted-note">${bandInfo.blurb || ""}</p>
      <div class="mm-calc ch-quote">
        <div>Payout <b class="up">${Util.credits(reward)}c</b> <span class="muted-note">(after tax: ${Util.credits(afterTax)}c)</span></div>
        <div>Ship loss <b class="${lose > 0.05 ? "down" : ""}">${(lose * 100).toFixed(0)}%</b> · Returns in <b>${Util.duration(durationMs)}</b></div>
        <div>Cancel now <b class="down">−${Util.credits(abortFee)}c</b> · buys out at <b class="up">+${Util.credits(buyout)}c</b> after ${this._fmtDurMin(bailMin)}</div>
      </div>
      ${disableReason ? `<p class="down">${disableReason}</p>` : ""}
      <button class="btn btn-go btn-cta" id="ch-dispatch" ${disableReason ? "disabled" : ""}>Dispatch charter</button>
    </div>`;
  },

  async onBazaarClick(e) {
    const t = e.target;
    const sub = t.closest("[data-bz]");
    if (sub) {
      this.bazaarTab = sub.dataset.bz; this.renderBazaar();
      const sc = this.refs.bazaarBody.querySelector(".bz-scroll"); if (sc) sc.scrollTop = 0;
      return;
    }
    // Charter picker (live quote — no economy spend until Dispatch).
    const chDur = t.closest("[data-ch-dur]");
    if (chDur) { this.charterPick.durationMin = +chDur.dataset.chDur; this.renderBazaar(); return; }
    const chBand = t.closest("[data-ch-band]");
    if (chBand) { this.charterPick.band = chBand.dataset.chBand; this.renderBazaar(); return; }
    if (t.id === "ch-dispatch" || t.closest("#ch-dispatch")) {
      if (Economy.busy()) return;
      const r = Charters.dispatch(this.charterPick.shipUid, this.charterPick.band, this.charterPick.durationMin);
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast(`Charter dispatched — ${Util.credits(r.charter.reward)}c locked in.`, "good");
      window.Game.requestSave(); this.renderBazaar(); this.renderFleet();
      if (this.commsTab === "pending") this.renderPendingContracts();
      this.updateHeader();
      return;
    }
    if (Economy.busy()) return;
    const mainBtn = t.closest("[data-buymain]");
    if (mainBtn) {
      const r = await Bazaar.buyMain(mainBtn.dataset.buymain, mainBtn.dataset.offer);
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast("Flagship acquired.", "good"); this.flashCredits(); window.Game.requestSave(); this.renderBazaar(); this.renderFleet(); this.updateHeader();
      return;
    }
    const map = [["buyyard", id => Bazaar.buyYardShip(id), "Ship purchased — find it in your Fleet."],
      ["buyship", id => Bazaar.buyShip(id), "Ship purchased."],
      ["hire", id => Bazaar.hireMerc(id), "Mercenary hired."],
      ["buyacc", id => Bazaar.buyAccessory(id), "Accessory bought."],
      ["buyblackbox", id => Bazaar.buyBlackbox(id), "Blackbox acquired — Use it from Inventory."],
      ["buyblueprint", id => Bazaar.buyBlueprint(id), "Blueprint filed — check the Workshop."],
      ["buyextractor", id => Bazaar.buyExtractor(id), "Extractor acquired — see Industries → storage (then install on a planet)."],
      ["buycomponent", id => Bazaar.buyComponent(id), "Component acquired — fit it on an extractor in Industries."],
      ["buydossier", id => Bazaar.buyDossier(id), "Dossier filed — read it in the Senate roster."]];
    for (const [attr, fn, msg] of map) {
      const el = t.closest(`[data-${attr}]`);
      if (el) {
        const id = el.getAttribute(`data-${attr}`);
        const r = await fn(id);
        if (!r.ok) return this.toast(r.msg, "warn");
        this.toast(msg, "good"); this.flashCredits(); window.Game.requestSave(); this.renderBazaar(); this.updateHeader();
        return;
      }
    }
    const view = t.closest("[data-view]");
    if (view) {
      const id = view.dataset.view;
      const c = (this.s().bazaar.contracts || []).find(x => x.id === id && x.status === "open");
      if (!c || c.kind === "tip") return this.toast("Contract no longer available.", "warn");
      this.openMission(c);
      return;
    }
    const take = t.closest("[data-take]");
    if (take) {
      // Tips only — jobs use View Contract → Launch (claim at launch).
      const r = await Bazaar.takeContract(take.dataset.take);
      if (!r.ok) return this.toast(r.msg, "warn");
      if (r.tip) { this.toast("Insider tip secured 👀", "good"); this.flashCredits(); window.Game.requestSave(); this.renderBazaar(); return; }
      if (r.preview && r.contract) { this.openMission(r.contract); return; }
      if (r.contract) this.openMission(r.contract);
      return;
    }
    if (t.closest("#buy-inv")) {
      const r = await Bazaar.buyInventoryUpgrade();
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast("Inventory expanded.", "good"); this.flashCredits(); window.Game.requestSave(); this.renderBazaar();
    }
  },

  // ===== systems ===========================================================
  renderSystems() {
    const ul = this.refs.systemList; if (!ul) return;
    const s = this.s(); ul.innerHTML = "";
    // live intro: post-compression multipliers, the per-trade cap, and the slippage rule
    const intro = document.getElementById("sys-intro");
    if (intro) intro.innerHTML =
      `Each tag is the <b>local price multiplier</b> for a goods category: ` +
      `<span class="mod cheap">&lt;1.00 = cheaper to buy here</span> ` +
      `<span class="mod dear">&gt;1.00 = sells for more here</span> ` +
      `<span class="mod">1.00 = average</span>. ` +
      `Gaps are deliberately modest — and <b>your own trades move the local price</b> (and it lingers), ` +
      `so arbitrage is a skill loop, not a printer. Per-trade cap at your tier: <b>${Util.credits(Economy.depth())}c/order</b>. ` +
      `<b>dist</b> sets docking time.`;
    for (const sys of SYSTEMS) {
      const unlocked = s.unlockedSystems.includes(sys.id), here = s.currentSystem === sys.id && !s.travel;
      const li = this.el("li", "system" + (here ? " here" : "") + (unlocked ? "" : " locked"));
      const mods = Object.keys(sys.mods).map(k => {
        const v = window.Market ? Market._mod(k, sys.id) : sys.mods[k];   // the compressed multiplier actually charged
        const tip = v < 1 ? `${k}: ${((1 - v) * 100).toFixed(0)}% cheaper to buy here`
          : v > 1 ? `${k}: ${((v - 1) * 100).toFixed(0)}% pricier — good to sell here`
          : `${k}: average price`;
        return `<span class="mod ${v < 0.995 ? "cheap" : v > 1.005 ? "dear" : ""}" title="${tip}">${k} ${v.toFixed(2)}</span>`;
      }).join("");
      let action;
      if (!unlocked) action = `<button class="btn btn-mini" data-unlock="${sys.id}" data-cost="${sys.unlock}">Unlock ${Util.credits(sys.unlock)}c</button>`;
      else if (here) action = `<span class="badge">docked</span>`;
      else if (s.travel && s.travel.to === sys.id) action = `<span class="badge">arriving ${Util.duration(Economy.travelRemaining())}</span>`;
      else {
        const eta = Fleet.dockTravelMs(s.currentSystem, sys.id);
        const warp = window.Senate ? Senate.travelEdictNote(eta) : "";
        action = `<button class="btn btn-mini" data-dock="${sys.id}" ${s.travel ? "disabled" : ""}>Dock (${Util.duration(eta)}${warp})</button>`;
      }
      li.innerHTML = `<div class="system-head"><b>${sys.name}</b><span class="dist" title="distance from Navos Junction — sets docking travel time">dist ${sys.distance}</span>${action}</div><div class="mods">${mods}</div>`;
      ul.appendChild(li);
    }
    this.markUnaffordable(ul);
    ul.onclick = async e => {
      const u = e.target.closest("[data-unlock]"), d = e.target.closest("[data-dock]");
      if (u) {
        if (Economy.busy()) return;
        const r = await Economy.unlockSystem(u.dataset.unlock);
        if (!r.ok) return this.toast(r.msg, "warn");
        this.toast(`Unlocked ${this.sysName(u.dataset.unlock)}!`, "good");
        this.flashCredits(); window.Game.requestSave(); this.renderSystems();
      } else if (d) {
        if (Economy.busy()) return;
        const r = await Economy.dockAt(d.dataset.dock);
        if (!r.ok) return this.toast(r.msg, "warn");
        const warp = window.Senate ? Senate.travelEdictNote(r.etaMs) : "";
        this.toast(`Departing for ${this.sysName(d.dataset.dock)} — ETA ${Util.duration(r.etaMs)}${warp}`, "good");
        window.Game.requestSave(); this.renderSystems(); this.updateHeader(); this.updateExchange();
      }
    };
  },

  // ===== milestones ========================================================
  renderAchievements() {
    const got = this.s().achievements;
    this.refs.achCount.textContent = `${got.length}/${ACHIEVEMENTS.length}`;
    this.refs.achList.innerHTML = ACHIEVEMENTS.map(a => { const have = got.includes(a.id);
      return `<li class="ach ${have ? "got" : ""}"><b>${have ? "★" : "☆"} ${a.name}</b><span>${a.desc}</span></li>`; }).join("");
  },

  // ===== workshop ==========================================================
  renderWorkshop(now = Date.now()) {
    if (!window.Workshop || !this.refs.workshopRecipes) return;
    Workshop.ensureAutoUnlocks();
    Workshop.resolve(now); // deliver anything that's ready before paint
    const q = Workshop.meta().queue;
    const slots = Workshop.slots(), free = Workshop.freeSlots();
    if (this.refs.workshopSlots) {
      this.refs.workshopSlots.textContent = `${q.length}/${slots} slots used · ${free} free`;
    }
    if (this.refs.workshopQueue) {
      this.refs.workshopQueue.innerHTML = q.length
        ? q.map(job => {
            const recipe = Workshop.recipe(job.recipeId);
            const left = Math.max(0, job.readyAt - now);
            const total = Math.max(1, job.readyAt - job.startedAt);
            const pct = Util.clamp(1 - left / total, 0, 1) * 100;
            return `<div class="ws-job">
              <div class="ws-job-top"><b>${recipe ? recipe.name : job.recipeId}</b>
                <span class="muted-note">${left > 0 ? Util.duration(left) : "ready"}</span></div>
              <div class="bar"><span style="width:${pct.toFixed(1)}%"></span></div>
            </div>`;
          }).join("")
        : `<p class="muted-note">No crafts in progress. Queue a recipe below.</p>`;
    }
    if (this.refs.workshopUpgrade) {
      if (slots >= WORKSHOPCFG.maxSlots) {
        this.refs.workshopUpgrade.innerHTML = `<span class="muted-note">Workshop fully expanded (${slots} slots).</span>`;
      } else {
        const cost = Workshop.upgradeCost();
        this.refs.workshopUpgrade.innerHTML =
          `<button class="btn btn-go" id="ws-buy-slot" data-cost="${cost}">Add slot — ${Util.credits(cost)}c</button>`;
      }
      this.markUnaffordable(this.refs.workshopUpgrade);
      const btn = this.refs.workshopUpgrade.querySelector("#ws-buy-slot");
      // buySlot is a promise on the server ledger, plain object for guests.
      if (btn) btn.onclick = () => Promise.resolve(Workshop.buySlot()).then(r => {
        if (!r || !r.ok) return this.toast((r && r.msg) || "Couldn't expand the Workshop.", "warn");
        this.toast(`Workshop expanded to ${r.slots} slots.`, "good");
        this.flashCredits(); window.Game.requestSave(); this.renderWorkshop();
      });
    }
    if (this.refs.workshopTabs) {
      for (const t of this.refs.workshopTabs.querySelectorAll("[data-ws]")) {
        t.classList.toggle("active", t.dataset.ws === this.workshopTab);
      }
    }
    const list = Workshop.visible(this.workshopTab);
    const senateUnlocks = Workshop.senateRecipes();
    const edictBits = [];
    if (window.Senate) {
      const ct = Senate.craftTimeAdd(), cc = Senate.craftCostAdd();
      if (ct) edictBits.push(`${ct < 0 ? "" : "+"}${Math.round(ct * 100)}% craft time`);
      if (cc) edictBits.push(`${cc < 0 ? "" : "+"}${Math.round(cc * 100)}% craft cost`);
      for (const g of Senate.blueprintGrants()) {
        if (senateUnlocks.has(g.recipeId)) {
          const r = Workshop.recipe(g.recipeId);
          edictBits.push(`Fabrication Rights: ${r ? r.name : g.recipeId}`);
        }
      }
    }
    const edictNote = edictBits.length
      ? `<p class="muted-note ws-edict">Senate: ${edictBits.join(" · ")}</p>` : "";
    const ingHtml = (recipe) => (recipe.ingredients || []).map(ing => {
      const c = COMMODITIES.find(x => x.id === ing.id);
      const need = Workshop.ingQty(ing);
      const have = Workshop.haveQty(ing.id);
      const ok = have >= need;
      return `<span class="ws-ing ${ok ? "ok" : "short"}" title="${c ? c.name : ing.id}">${c ? c.name : ing.id} ${have}/${need}</span>`;
    }).join("");
    this.refs.workshopRecipes.innerHTML = edictNote + (list.length
      ? `<div class="ws-grid">` + list.map(recipe => {
          const flavs = recipe.flavor || [];
          const flavSel = flavs.length
            ? `<label class="ws-flav">Flavor <select data-flavor-for="${recipe.id}">` +
              flavs.map(f => {
                const c = COMMODITIES.find(x => x.id === f.id);
                const need = Workshop.ingQty(f);
                const have = Workshop.haveQty(f.id);
                return `<option value="${f.id}" ${have < need ? "disabled" : ""}>${c ? c.name : f.id} (${have}/${need})</option>`;
              }).join("") + `</select></label>`
            : "";
          const cred = Workshop.creditCost(recipe);
          const creditBit = cred ? `<span class="ws-ing">${Util.credits(cred)}c</span>` : "";
          const chk = Workshop.canCraft(recipe.id);
          const viaSenate = senateUnlocks.has(recipe.id) && !(this.s().knownRecipes || []).includes(recipe.id);
          return `<div class="ws-card">
            <div class="ws-card-top"><b>${recipe.name}</b><span class="cls-tag">${viaSenate ? "senate" : (recipe.tier || recipe.outputType)}</span></div>
            <div class="ws-ings">${ingHtml(recipe)}${creditBit}</div>
            ${flavSel}
            <div class="ws-foot">
              <span class="muted-note">${Util.duration(Workshop.craftMs(recipe, now))}</span>
              <button class="btn btn-mini btn-go" data-craft="${recipe.id}" ${chk.ok ? "" : "disabled"}>Craft</button>
            </div>
          </div>`;
        }).join("") + `</div>`
      : `<p class="muted-note">No ${this.workshopTab} recipes unlocked yet. Buy blueprints in the Bazaar, find them on surveys and high-danger contracts, or watch for Fabrication Rights in the Senate.</p>`);

    this.refs.workshopRecipes.onclick = e => {
      const btn = e.target.closest("[data-craft]"); if (!btn) return;
      const id = btn.dataset.craft;
      const sel = this.refs.workshopRecipes.querySelector(`select[data-flavor-for="${id}"]`);
      const flavorId = sel ? sel.value : null;
      if (btn.disabled) return;
      btn.disabled = true;   // the RPC round-trip is not instant — no double-craft
      Promise.resolve(Workshop.craft(id, flavorId)).then(r => {
        if (!r || !r.ok) return this.toast((r && r.msg) || "Couldn't start that craft.", "warn");
        this.toast(`Crafting ${r.recipe ? r.recipe.name : "job"}…`, "good");
        this.flashCredits(); window.Game.requestSave(); this.updateHeader();
      }).finally(() => this.renderWorkshop());
    };
  },

  // ===== industries ========================================================
  // Component chips + optional Fit control for one extractor (storage or installed).
  _exCompRow(ex) {
    if (!ex) return "";
    const fitted = Extractors.componentsOf(ex), slots = Extractors.componentSlots(), avail = Components.unequipped();
    const chips = fitted.map(c =>
      `<span class="acc-chip" style="border-color:${Components.rarity(c.rarity).color}">${c.name} <span class="muted-note">${Components.describe(c)}</span> <button class="x" data-ind-detach="${ex.uid}:${c.uid}">✕</button></span>`
    ).join("");
    let row = `<div class="ind-foot">Components ${fitted.length}/${slots}</div><div class="acc-row">${chips || `<span class="muted-note">none fitted</span>`}</div>`;
    if (fitted.length < slots && avail.length) {
      row += `<div class="rt-form"><label>Fit <select data-comp-sel="${ex.uid}">${
        avail.map(c => `<option value="${c.uid}">${c.name} — ${Components.describe(c)}</option>`).join("")
      }</select></label><button class="btn btn-mini" data-ind-attach="${ex.uid}">Fit</button></div>`;
    } else if (fitted.length < slots) {
      row += `<p class="muted-note">Buy components in the <b>Bazaar → Extractors</b> to boost this extractor.</p>`;
    }
    return row;
  },

  renderIndustries() {
    const list = Industries.list();
    const spareEx = Extractors.unequipped();
    const spareComp = Components.unequipped();
    const ownedEx = Object.keys(Extractors.pool()).length;
    const ownedComp = Object.keys(Components.pool()).length;
    this.refs.indCount.textContent = `${list.length}/${INDUSTRYCFG.maxPerPlayer} permits`;
    if (this.refs.indExCount) this.refs.indExCount.textContent = ownedEx ? `${spareEx.length} in storage · ${ownedEx} owned` : "";
    if (this.refs.indCompCount) this.refs.indCompCount.textContent = ownedComp ? `${spareComp.length} free · ${ownedComp} owned` : "";

    let permitsHtml = "";
    if (!list.length) {
      permitsHtml = `<p class="muted-note">No permits yet. Open the <b>Star Map</b>, click a planet, buy a permit, then install an extractor (from the Bazaar) — it produces into your tradeable stock while you're away.</p>`;
    } else {
      permitsHtml = list.map(ind => {
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
        const edictNote = (b.edicts && b.edicts.length)
          ? ` <span class="muted-note">· ${b.edicts.map(e => `${e.title} (${e.rate >= 0 ? "+" : ""}${(e.rate * 100).toFixed(0)}%)`).join("; ")}</span>` : "";
        return `<div class="industry">${head}<div class="ind-foot">${ex ? ex.name + " → " : ""}≈ <b>${b.net}</b> ${name}/12h <span class="muted-note">(${(b.rate * 100).toFixed(0)}% tax)</span>${edictNote} · next ${next} · ${owner}</div>${warn}${this._exCompRow(ex)}</div>`;
      }).join("");
    }
    this.refs.indList.innerHTML = permitsHtml;

    let exHtml = "";
    if (!ownedEx) {
      exHtml = `<p class="muted-note">No extractors owned. Buy them in the <b>Bazaar → Extractors</b>.</p>`;
    } else if (!spareEx.length) {
      exHtml = `<p class="muted-note">All extractors are installed. Fit components on a permit, or remove one from a planet to free it.</p>`;
    } else {
      exHtml = spareEx.map(ex =>
        `<div class="industry"><div class="ind-head"><b>${ex.name}</b><span class="ind-stat">in storage</span></div>
          <div class="ind-foot">${Extractors.describe(ex)}</div>${this._exCompRow(ex)}
          <div class="ind-foot">Install on a planet permit via the <b>Star Map</b>.</div></div>`
      ).join("");
    }
    if (this.refs.indExList) this.refs.indExList.innerHTML = exHtml;

    let compHtml = "";
    if (!ownedComp) {
      compHtml = `<p class="muted-note">No components owned. Buy them in the <b>Bazaar → Extractors</b>, then fit them to an extractor.</p>`;
    } else if (!spareComp.length) {
      compHtml = `<p class="muted-note">All components are fitted. Detach one (✕) to free a slot.</p>`;
    } else {
      compHtml = spareComp.map(c =>
        `<div class="item" style="border-left-color:${Components.rarity(c.rarity).color}">
          <div class="item-top"><b>${c.name}</b><span class="rar" style="color:${Components.rarity(c.rarity).color}">${Components.rarity(c.rarity).label}</span></div>
          <div class="item-stat">${Components.describe(c)}</div>
          <div class="item-acts"><span class="muted-note">use Fit on an extractor</span></div></div>`
      ).join("");
    }
    if (this.refs.indCompList) this.refs.indCompList.innerHTML = compHtml;

    const onInd = e => this.onIndustriesClick(e);
    this.refs.indList.onclick = onInd;
    if (this.refs.indExList) this.refs.indExList.onclick = onInd;
    if (this.refs.indCompList) this.refs.indCompList.onclick = onInd;
  },

  onIndustriesClick(e) {
    const d = e.target.closest("[data-demolish]");
    if (d) {
      Industries.demolish(d.dataset.demolish); this.toast("Permit closed.", "info");
      window.Game.requestSave(); this.renderIndustries(); this.updateHeader();
      return;
    }
    const att = e.target.closest("[data-ind-attach]");
    if (att) {
      const exUid = att.dataset.indAttach;
      const sel = document.querySelector(`#page-industries select[data-comp-sel="${exUid}"]`);
      if (!sel) return;
      const r = Extractors.attachComponent(exUid, sel.value);
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast("Component fitted.", "good");
      window.Game.requestSave(); this.renderIndustries(); this.updateHeader();
      return;
    }
    const det = e.target.closest("[data-ind-detach]");
    if (det) {
      const [exu, cu] = det.dataset.indDetach.split(":");
      Extractors.detachComponent(exu, cu);
      this.toast("Component removed to storage.", "info");
      window.Game.requestSave(); this.renderIndustries(); this.updateHeader();
    }
  },

  // ===== STATIONS ==========================================================
  renderStations() {
    const body = this.refs.stationsBody, tabs = this.refs.stationsTabs;
    if (!body || !window.Stations) return;
    const owned = Stations.ownedBy();
    if (!owned.length) {
      body.innerHTML = `<h2>Stations</h2><p class="muted-note">You don't own a station yet. Open a non-capital system on the Star Map and start an auction.</p>`;
      if (tabs) tabs.innerHTML = "";
      return;
    }
    if (!this.stationsTab || !owned.some(st => st.systemId === this.stationsTab))
      this.stationsTab = owned[0].systemId;
    if (tabs) {
      tabs.innerHTML = owned.map(st =>
        `<button type="button" class="subtab${st.systemId === this.stationsTab ? " active" : ""}" data-st="${st.systemId}" aria-current="${st.systemId === this.stationsTab ? "page" : "false"}">${st.name}</button>`
      ).join("");
      tabs.onclick = e => {
        const b = e.target.closest("[data-st]"); if (!b) return;
        this.stationsTab = b.dataset.st; this.renderStations();
      };
    }
    const st = Stations.get(this.stationsTab); if (!st) return;
    const sys = Galaxy.get(st.systemId);
    const sent = (window.Stock && Stock.sentiment[st.sectorId]) ?? STATIONCFG.sentimentStart;
    const free = Stations.powerFree(st), budget = Stations.powerBudget(st), used = Stations.powerUsed(st);
    const upkeep = Stations.upkeepPerCycle(st);
    const holdRows = Object.entries(st.hold || {}).filter(([, q]) => q > 0)
      .map(([id, q]) => {
        const c = COMMODITIES.find(x => x.id === id);
        return `<li class="st-hold-row"><b>${c ? c.name : id}</b> ×${q}
          <button class="btn btn-mini" data-st-deliver="${id}">Deliver all</button></li>`;
      }).join("") || `<li class="muted-note">Hold empty — assign a Production Hub commodity.</li>`;

    const modRows = Object.keys(STATION_MODULES).map(id => {
      const def = STATION_MODULES[id];
      const lvl = id === "reactor" ? (st.reactorLevel | 0) : (st.modules[id] | 0);
      const check = Stations.canInstall(st, id);
      const lvlTxt = lvl ? "I".repeat(lvl) : "—";
      const installBtn = lvl < def.max
        ? `<button class="btn btn-mini" data-st-install="${id}" ${check.ok ? "" : "disabled"} title="${check.msg || ""}">Install ${"I".repeat(lvl + 1)} · ${Util.credits(def.cost[lvl] || 0)}</button>`
        : "";
      const removeBtn = lvl > 0
        ? `<button class="btn btn-mini btn-warn" data-st-uninstall="${id}">Uninstall</button>` : "";
      return `<tr><td>${def.name}</td><td class="num">${lvlTxt}</td><td class="num">${id === "reactor" ? "+" + ((STATIONCFG.reactor[lvl - 1] || {}).power || 0) : (def.power[Math.max(0, lvl - 1)] || def.power[0] || 0)}pwr</td>
        <td class="actions">${installBtn} ${removeBtn}</td></tr>`;
    }).join("");

    const prodOpts = Stations.produceable(st.systemId).map(c =>
      `<option value="${c.id}" ${st.prodComm === c.id ? "selected" : ""}>${c.name}</option>`).join("");

    Stations.syncBays(st);
    const freeEx = (window.Extractors ? Extractors.unequipped() : []).filter(ex =>
      !st.prodComm || Extractors.canProduce(ex, st.prodComm));
    const exOpts = freeEx.map(ex =>
      `<option value="${ex.uid}">${ex.name} (${EXTRACTORCFG.types[ex.type]?.label || ex.type})</option>`).join("");
    const bayRows = (st.bays || []).map((bay, i) => {
      let who, acts;
      if (!bay.lesseeId) {
        who = `<span class="muted-note">Vacant — open to lease @ ${((st.leaseTaxBps || 0) / 100).toFixed(0)}%</span>`;
        acts = st.prodComm
          ? `<select data-st-bay-ex="${i}" ${exOpts ? "" : "disabled"}>${exOpts || "<option>No free extractor</option>"}</select>
             <button class="btn btn-mini" data-st-occupy="${i}" ${exOpts ? "" : "disabled"}>Occupy</button>`
          : "";
      } else if (bay.npc) {
        who = `<span class="tip-dim">NPC tenant</span> · tax in`;
        acts = `<button class="btn btn-mini btn-warn" data-st-vacate="${i}">Evict</button>`;
      } else if (bay.lesseeId === st.ownerId) {
        const ex = window.Extractors && Extractors.get(bay.extractorId);
        who = `<b>You</b> · ${ex ? ex.name : "extractor"}`;
        acts = `<button class="btn btn-mini" data-st-vacate="${i}">Remove</button>`;
      } else {
        who = `<b>Lessee</b> ${bay.lesseeId}`;
        acts = `<button class="btn btn-mini btn-warn" data-st-vacate="${i}">Evict</button>`;
      }
      const y = bay.lesseeId ? Stations._bayGross(st, bay) : 0;
      return `<tr><td>Bay ${i + 1}</td><td>${who}</td><td class="num">${y ? y + "/h" : "—"}</td><td class="actions">${acts}</td></tr>`;
    }).join("") || `<tr><td colspan="4" class="muted-note">Install a Production Hub to open bays.</td></tr>`;

    const band = sent >= 60 ? "Steady" : sent >= 40 ? "Uneasy" : sent >= 20 ? "Strained" : "Critical";
    body.innerHTML = `
      <h2>${st.name} <small>${st.tier} · ${sys ? sys.name : st.systemId} · ${st.status}</small></h2>
      <div class="st-meters">
        <div>Power <b>${used}/${budget}</b> <span class="muted-note">(${free} free)</span></div>
        <div>Standing <b>${st.standing.toFixed(0)}</b>/100</div>
        <div>Sector sentiment <b title="${sent.toFixed(1)}">${band}</b></div>
        <div>Treasury <b>${Util.credits(st.treasury)}</b>
          <button class="btn btn-mini" data-st-withdraw ${st.treasury < 1 ? "disabled" : ""}>Withdraw all</button></div>
        <div>Upkeep <b>${Util.credits(upkeep)}</b>/cycle</div>
      </div>
      <div class="st-grid">
        <section>
          <h3>Production Hub</h3>
          <p class="muted-note">Owner bays pay into the station hold. Lessees keep their share and pay your lease tax into the hold. Haul deliveries to the sector capital.</p>
          <label>Commodity <select id="st-prod">${prodOpts || "<option value=''>—</option>"}</select></label>
          <button class="btn btn-go" id="st-set-prod" ${(st.modules.production_hub | 0) ? "" : "disabled"}>Assign</button>
          <label>Lease tax % <input type="number" id="st-lease" min="0" max="40" value="${((st.leaseTaxBps || 0) / 100).toFixed(0)}"></label>
          <button class="btn btn-mini" id="st-set-lease">Set</button>
          <div class="table-wrap" style="margin-top:10px"><table class="market st-bays"><thead><tr><th>Bay</th><th>Occupant</th><th class="num">Yield</th><th></th></tr></thead>
          <tbody>${bayRows}</tbody></table></div>
          <ul class="st-hold">${holdRows}</ul>
        </section>
        <section>
          <h3>Modules</h3>
          <div class="table-wrap"><table class="market st-mods"><thead><tr><th>Module</th><th class="num">Lvl</th><th class="num">Power</th><th></th></tr></thead>
          <tbody>${modRows}</tbody></table></div>
          <p class="muted-note">Uninstall refunds 50% of component cost and starts a 6h refit (no production).</p>
        </section>
      </div>
      ${this._renderHallPanel(st)}
      ${this._renderContractOfficePanel(st)}
      ${this._renderCustomsPanel(st)}`;

    body.querySelector("#st-set-prod")?.addEventListener("click", () => {
      const id = body.querySelector("#st-prod")?.value;
      const r = Stations.setProduction(st.systemId, id);
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast("Production retooling…", "good"); this.renderStations(); this.updateHeader();
    });
    body.querySelector("#st-set-lease")?.addEventListener("click", () => {
      const pct = +body.querySelector("#st-lease")?.value || 0;
      Stations.setLeaseTax(st.systemId, pct * 100);
      this.toast(`Lease tax set to ${pct}%.`, "good"); this.renderStations();
    });
    body.querySelector("[data-st-withdraw]")?.addEventListener("click", () => {
      const r = Stations.withdraw(st.systemId, st.treasury);
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast(`Withdrew ${Util.credits(r.amount)}.`, "good"); this.flashCredits(); this.renderStations(); this.updateHeader();
    });
    body.querySelectorAll("[data-st-deliver]").forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.stDeliver;
        const r = Stations.deliver(st.systemId, id, st.hold[id] | 0);
        if (!r.ok) return this.toast(r.msg, "warn");
        this.toast(`Delivered ${r.qty} for ${Util.credits(r.proceeds)}.`, "good");
        this.flashCredits(); this.renderStations(); this.updateHeader(); this.updateExchange();
      };
    });
    body.querySelectorAll("[data-st-occupy]").forEach(btn => {
      btn.onclick = () => {
        const i = +btn.dataset.stOccupy;
        const sel = body.querySelector(`[data-st-bay-ex="${i}"]`);
        const r = Stations.occupyBay(st.systemId, i, sel && sel.value);
        if (!r.ok) return this.toast(r.msg, "warn");
        this.toast("Extractor installed in bay.", "good"); this.renderStations();
      };
    });
    body.querySelectorAll("[data-st-vacate]").forEach(btn => {
      btn.onclick = () => {
        const r = Stations.vacateBay(st.systemId, +btn.dataset.stVacate);
        if (!r.ok) return this.toast(r.msg, "warn");
        this.toast("Bay cleared.", "info"); this.renderStations();
      };
    });
    body.querySelectorAll("[data-st-install]").forEach(btn => {
      btn.onclick = () => {
        const r = Stations.install(st.systemId, btn.dataset.stInstall);
        if (!r.ok) return this.toast(r.msg, "warn");
        this.toast(`Installed. −${Util.credits(r.cost)}`, "good");
        this.flashCredits(); this.renderStations(); this.updateHeader();
      };
    });
    body.querySelectorAll("[data-st-uninstall]").forEach(btn => {
      btn.onclick = () => {
        const r = Stations.uninstall(st.systemId, btn.dataset.stUninstall);
        if (!r.ok) return this.toast(r.msg, "warn");
        this.toast(`Uninstalled. Refit underway. +${Util.credits(r.refund)}`, "warn");
        this.flashCredits(); this.renderStations(); this.updateHeader();
      };
    });
    this._wireHallPanel(body, st);
    this._wireContractOfficePanel(body, st);
    this._wireCustomsPanel(body, st);
  },

  _renderCustomsPanel(st) {
    const hasCustoms = !!(st.modules.customs_house | 0);
    const hasFree = !!(st.modules.free_port | 0);
    if (!hasCustoms && !hasFree) {
      return `<div class="panel" style="margin-top:14px"><h3>Customs / Free Port</h3>
        <p class="muted-note">Install a Customs House (Clean flag, scrutiny dial, impound &amp; ransom) or a Free Port (low scrutiny, illicit traffic). They conflict. Scrutiny is always public on the star map.</p></div>`;
    }
    if (hasFree) {
      const scr = Stations.publicScrutiny(st.systemId);
      return `<div class="panel" style="margin-top:14px"><h3>Free Port <small>scrutiny ~${scr ? scr.chanceHint : "?"}%</small></h3>
        <p class="muted-note">Border edicts are softened here. Syndicate likes you; lawful factions don't. No impound — seizures stay rare.</p></div>`;
    }
    const claims = st.impoundClaims || [];
    const holdRows = Object.keys(st.impoundHold || {}).filter(id => (st.impoundHold[id] | 0) > 0).map(id => {
      const c = COMMODITIES.find(x => x.id === id);
      return `<tr><td>${c ? c.name : id}</td><td class="num">${st.impoundHold[id]}</td>
        <td class="actions"><button class="btn btn-mini" data-st-impound-sell="${id}">Sell at capital</button></td></tr>`;
    }).join("") || `<tr><td colspan="3" class="muted-note">Impound empty — seizures appear when smugglers dock.</td></tr>`;
    const claimRows = claims.map(c => {
      const comm = COMMODITIES.find(x => x.id === c.commId);
      return `<tr><td>${c.qty}× ${comm ? comm.name : c.commId}<div class="tip-dim">ransom ${Util.credits(c.ransom)} · from ${c.fromId || "?"}</div></td>
        <td class="actions"><button class="btn btn-mini" data-st-impound-drop="${c.id}">Drop</button></td></tr>`;
    }).join("");
    const access = Object.entries(this.accessRoles(st.systemId));
    const accessRows = access.map(([pid, role]) =>
      `<tr><td>${pid}</td><td>${role}</td>
        <td class="actions"><button class="btn btn-mini" data-st-role-clear="${pid}">Guest</button></td></tr>`
    ).join("") || `<tr><td colspan="3" class="muted-note">No special roles — Allied skips Customs scans.</td></tr>`;
    return `<div class="panel st-customs" style="margin-top:14px">
      <h3>Customs House <small>Clean · scrutiny ${st.scrutiny | 0}%</small></h3>
      <p class="muted-note">Public seize chance shown on the map before anyone undocks. Allied / Partner / you are exempt.</p>
      <label>Scrutiny % <input type="number" id="st-scrutiny" min="0" max="85" value="${st.scrutiny | 0}"></label>
      <button class="btn btn-mini" id="st-set-scrutiny">Set</button>
      <div class="st-hall-list" style="margin-top:10px">
        <input type="text" id="st-role-pid" placeholder="player id" aria-label="player id">
        <select id="st-role-val"><option value="allied">Allied</option><option value="partner">Partner</option><option value="barred">Barred</option></select>
        <button class="btn btn-mini" id="st-set-role">Set role</button>
      </div>
      <div class="table-wrap" style="margin-top:10px"><table class="market">
        <thead><tr><th>Access</th><th>Role</th><th></th></tr></thead><tbody>${accessRows}</tbody></table></div>
      <h4 style="margin-top:12px">Impound</h4>
      <div class="table-wrap"><table class="market">
        <thead><tr><th>Goods</th><th class="num">Qty</th><th></th></tr></thead><tbody>${holdRows}</tbody></table></div>
      ${claimRows ? `<div class="table-wrap" style="margin-top:8px"><table class="market"><tbody>${claimRows}</tbody></table></div>` : ""}
    </div>`;
  },

  accessRoles(systemId) {
    return (window.Stations && Stations.access[systemId]) || {};
  },

  _wireCustomsPanel(body, st) {
    body.querySelector("#st-set-scrutiny")?.addEventListener("click", () => {
      const pct = +body.querySelector("#st-scrutiny")?.value || 0;
      const r = Stations.setScrutiny(st.systemId, pct);
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast(`Scrutiny set to ${r.scrutiny}%.`, "good"); this.renderStations();
    });
    body.querySelector("#st-set-role")?.addEventListener("click", () => {
      const pid = body.querySelector("#st-role-pid")?.value;
      const role = body.querySelector("#st-role-val")?.value;
      const r = Stations.setRole(st.systemId, pid, role);
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast(`${pid} → ${role}.`, "good"); this.renderStations();
    });
    body.querySelectorAll("[data-st-role-clear]").forEach(btn => {
      btn.onclick = () => {
        Stations.setRole(st.systemId, btn.dataset.stRoleClear, "guest");
        this.renderStations();
      };
    });
    body.querySelectorAll("[data-st-impound-sell]").forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.stImpoundSell;
        const r = Stations.sellImpound(st.systemId, id, st.impoundHold[id] | 0);
        if (!r.ok) return this.toast(r.msg, "warn");
        this.toast(`Fenced ${r.qty} for ${Util.credits(r.proceeds)} → treasury.`, "good");
        this.renderStations(); this.updateHeader();
      };
    });
    body.querySelectorAll("[data-st-impound-drop]").forEach(btn => {
      btn.onclick = () => {
        Stations.dropImpoundClaim(st.systemId, btn.dataset.stImpoundDrop);
        this.renderStations();
      };
    });
  },

  _renderContractOfficePanel(st) {
    if (!(st.modules.contract_office | 0)) {
      return `<div class="panel" style="margin-top:14px"><h3>Contract Office</h3>
        <p class="muted-note">Install a Contract Office to post escrowed haul jobs from your station hold onto the Bazaar board. NPC haulers fill slowly; players clear them faster.</p></div>`;
    }
    const rel = Stations.reliability(st);
    const relTxt = rel == null ? "unrated" : `${Math.round(rel * 100)}% fulfilled`;
    const holdIds = Object.keys(st.hold || {}).filter(id => (st.hold[id] | 0) > 0);
    const opts = holdIds.map(id => {
      const c = COMMODITIES.find(x => x.id === id);
      return `<option value="${id}">${c ? c.name : id} (${st.hold[id]})</option>`;
    }).join("") || `<option value="">Hold empty</option>`;
    const rows = (st.contracts || []).map(c => {
      const comm = COMMODITIES.find(x => x.id === c.commId);
      const left = Math.max(0, c.expiresAt - Date.now());
      return `<tr>
        <td>${c.qty}× ${comm ? comm.name : c.commId}<div class="tip-dim">${c.status} · ${c.rate}c/u · ${Util.duration(left)}</div></td>
        <td class="num">${Util.credits(c.escrow)}</td>
        <td class="actions">${c.status === "open"
          ? `<button class="btn btn-mini" data-st-haul-cancel="${c.id}">Cancel</button>`
          : `<span class="tip-dim">in flight</span>`}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="3" class="muted-note">No haul postings — escrow a bounty from the hold.</td></tr>`;
    const feePct = ((STATIONCFG.contractPostFeeBps || 0) / 100).toFixed(0);
    return `<div class="panel st-haul" style="margin-top:14px">
      <h3>Contract Office <small>${relTxt}</small></h3>
      <p class="muted-note">Post haul orders to the Bazaar Contracts board. Bounty is escrowed at post (${feePct}% faction fee). Goods leave the hold until filled, expired, or cancelled.</p>
      <div class="st-hall-list" style="margin-top:10px">
        <select id="st-haul-comm">${opts}</select>
        <input type="number" id="st-haul-qty" min="1" value="20" aria-label="quantity">
        <input type="number" id="st-haul-rate" min="${STATIONCFG.contractMinRate || 5}" value="40" aria-label="credits per unit">
        <button class="btn btn-go" id="st-haul-post">Post haul</button>
      </div>
      <div class="table-wrap" style="margin-top:10px"><table class="market">
        <thead><tr><th>Posting</th><th class="num">Escrow</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  },

  _wireContractOfficePanel(body, st) {
    body.querySelector("#st-haul-post")?.addEventListener("click", () => {
      const commId = body.querySelector("#st-haul-comm")?.value;
      const qty = +body.querySelector("#st-haul-qty")?.value || 0;
      const rate = +body.querySelector("#st-haul-rate")?.value || 0;
      const r = Stations.postHaul(st.systemId, commId, qty, rate);
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast(`Haul posted — escrowed ${Util.credits(r.contract.escrow)} (+${Util.credits(r.fee)} fee).`, "good");
      this.flashCredits(); this.renderStations(); this.updateHeader();
      if (this.page === "bazaar") this.renderBazaar();
    });
    body.querySelectorAll("[data-st-haul-cancel]").forEach(btn => {
      btn.onclick = () => {
        const r = Stations.cancelHaul(st.systemId, btn.dataset.stHaulCancel);
        if (!r.ok) return this.toast(r.msg, "warn");
        this.toast("Haul cancelled — goods and bounty returned.", "info");
        this.flashCredits(); this.renderStations(); this.updateHeader();
      };
    });
  },

  _renderHallPanel(st) {
    if (!(st.modules.exchange_hall | 0)) {
      return `<div class="panel" style="margin-top:14px"><h3>Exchange Hall</h3>
        <p class="muted-note">Install an Exchange Hall to open a player marketplace for gear, ships, extractors, components, blackboxes, and blueprints (not commodities).</p></div>`;
    }
    const listings = Stations.hallListings(st.systemId);
    const inv = (window.Bazaar ? Bazaar.inventoryItems() : []).map(it => {
      const kind = window.Items && Items.isBlackbox(it) ? "blackbox" : "gear";
      return `<option value="${kind}:${it.uid}">${it.name} (${kind})</option>`;
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
    const rows = listings.map(l => {
      const mine = l.sellerId === Stations.playerId();
      const left = Math.max(0, l.expiresAt - Date.now());
      return `<tr>
        <td>${l.name}<div class="tip-dim">${l.kind} · ${Util.duration(left)} left</div></td>
        <td class="num">${Util.credits(l.price)}</td>
        <td class="actions">${mine
          ? `<button class="btn btn-mini" data-hall-cancel="${l.id}">Cancel</button>`
          : `<button class="btn btn-mini btn-go" data-hall-buy="${l.id}" data-cost="${l.price}">Buy</button>`}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="3" class="muted-note">No listings — be the first stall.</td></tr>`;
    return `<div class="panel st-hall" style="margin-top:14px">
      <h3>Exchange Hall <small>sale tariff ${((st.saleTariffBps || 0) / 100).toFixed(0)}%</small></h3>
      <p class="muted-note">Crafted goods only — commodities stay on the capital exchange. Visitors must dock here. NPC traders sometimes clear stalls in guest mode.</p>
      <label>Tariff % <input type="number" id="st-tariff" min="0" max="15" value="${((st.saleTariffBps || 0) / 100).toFixed(0)}"></label>
      <button class="btn btn-mini" id="st-set-tariff">Set</button>
      <div class="st-hall-list" style="margin-top:10px">
        <select id="st-hall-item">${opts}</select>
        <input type="number" id="st-hall-price" min="${STATIONCFG.hallMinPrice || 50}" value="500" aria-label="list price">
        <button class="btn btn-go" id="st-hall-list">List</button>
      </div>
      <div class="table-wrap" style="margin-top:10px"><table class="market">
        <thead><tr><th>Listing</th><th class="num">Price</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  },

  _wireHallPanel(body, st) {
    body.querySelector("#st-set-tariff")?.addEventListener("click", () => {
      const pct = +body.querySelector("#st-tariff")?.value || 0;
      Stations.setSaleTariff(st.systemId, pct * 100);
      this.toast(`Sale tariff set to ${pct}%.`, "good"); this.renderStations();
    });
    body.querySelector("#st-hall-list")?.addEventListener("click", () => {
      const raw = body.querySelector("#st-hall-item")?.value || "";
      const price = +body.querySelector("#st-hall-price")?.value || 0;
      const [kind, ref] = raw.split(":");
      if (!kind || !ref) return this.toast("Pick something to list.", "warn");
      const r = Stations.listHallItem(st.systemId, kind, ref, price);
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast(`Listed ${r.listing.name} for ${Util.credits(r.listing.price)}.`, "good");
      this.renderStations(); this.updateHeader();
    });
    body.querySelectorAll("[data-hall-cancel]").forEach(btn => {
      btn.onclick = () => {
        const r = Stations.cancelHallListing(st.systemId, btn.dataset.hallCancel);
        if (!r.ok) return this.toast(r.msg, "warn");
        this.toast("Listing cancelled — item returned.", "info");
        this.renderStations(); this.updateHeader();
      };
    });
    body.querySelectorAll("[data-hall-buy]").forEach(btn => {
      btn.onclick = () => {
        const r = Stations.buyHallListing(st.systemId, btn.dataset.hallBuy);
        if (!r.ok) return this.toast(r.msg, "warn");
        this.toast(`Bought ${r.listing.name} for ${Util.credits(r.paid)}.`, "good");
        this.flashCredits(); this.renderStations(); this.updateHeader();
      };
    });
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
    const me = (window.Cloud && Cloud.signedIn() && Cloud.user()) ? Cloud.user().id : null;
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    // Public handle for ballot badges — same rules as the Barons leaderboard
    // (username → Baron #N → "Baron"). Never show an email local-part.
    const ballotWho = b => {
      if (!b) return "Baron";
      const mine = b.proposedBy === "you" || (me && String(b.proposedBy) === String(me));
      if (mine && window.Cloud && Cloud.displayName) return Cloud.displayName() || "Baron";
      const label = (b.proposedLabel && String(b.proposedLabel).trim()) || "";
      // Stale rows may still hold an email local-part from an older SQL; if it
      // matches the signed-in account, substitute the live display name.
      const emailLocal = (window.Cloud && Cloud.email && (Cloud.email() || "").split("@")[0]) || "";
      if (label && emailLocal && label === emailLocal && Cloud.displayName)
        return Cloud.displayName() || "Baron";
      if (label && label.includes("@")) return "Baron";
      return label || "Baron";
    };
    const propBadge = b => {
      if (!b || !(b.proposedBy || b.proposedLabel)) return "";
      if (b.proposedBy === "you" || (me && String(b.proposedBy) === String(me)))
        return `<span class="bill-tabled" title="you tabled this bill">✎ Your ballot initiative</span>`;
      // Own bill with mismatched proposedBy (legacy): still prefer "Your …" when label is our email.
      const emailLocal = (window.Cloud && Cloud.email && (Cloud.email() || "").split("@")[0]) || "";
      if (me && emailLocal && b.proposedLabel === emailLocal)
        return `<span class="bill-tabled" title="you tabled this bill">✎ Your ballot initiative</span>`;
      const who = esc(ballotWho(b));
      return `<span class="bill-tabled" title="tabled by ${who}">✎ ${who}'s ballot</span>`;
    };

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
        <div class="bill-head"><b>${next.title}</b>${propBadge(next)}<span class="bill-eta">votes in ${Util.duration(Math.max(0, next.votesAt - now))}</span></div>
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
      (active.length ? active.map(b => `<div class="edict"><div class="edict-head"><b>${b.title}</b>${propBadge(b)}${b.endsAt ? `<span class="edict-eta">expires ${Util.duration(b.endsAt - now)}</span>` : ""}</div><div class="edict-blurb">${b.blurb}</div></div>`).join("")
        : `<p class="muted-note">No edicts in force — the markets are free… for now.</p>`) + `</div>`;

    // ---- upcoming legislation ----
    const upPanel = `<div class="panel"><h2>Upcoming Legislation <small>preview the docket</small></h2>` +
      upcoming.map((b, i) => `<div class="bill upcoming"><div class="bill-head"><b>${b.title}</b>${propBadge(b)}<span class="bill-eta">${i === 0 ? "on the floor · " : ""}votes in ${Util.duration(Math.max(0, b.votesAt - now))}</span></div><div class="bill-blurb">${b.blurb}</div></div>`).join("") + `</div>`;

    // ---- ballot initiative (own tab) ----
    this.ballotForm ||= { pick: "", factor: 1, days: SENATECFG.ballotDaysDefault || 3 };
    const optsList = Senate.ballotOptions();
    if (!this.ballotForm.pick && optsList.length) this.ballotForm.pick = optsList[0].value;
    const pick = this.ballotForm.pick || (optsList[0] && optsList[0].value) || "";
    const [pickId] = String(pick).split("|");
    const pickTpl = SENATE_EDICTS.find(t => t.id === pickId && t.ballot);
    const hasStr = Senate.ballotHasStrength(pickTpl);
    const factor = hasStr ? (Number(this.ballotForm.factor) || 1) : 1;
    const days = Util.clamp(Math.round(Number(this.ballotForm.days) || 3), SENATECFG.ballotDaysMin || 1, SENATECFG.ballotDaysMax || 10);
    const binary = !hasStr;
    const costNow = Senate.canBallot() ? Senate.ballotCostFor(factor, days, binary) : Senate.ballotCost();
    const leanNow = Senate.ballotLean(factor, days, binary);
    const odds = pickTpl ? Senate.ballotOddsLabel(Senate.ballotPassChance(pickTpl.issue, leanNow)) : null;
    const strOpts = Senate.ballotStrengthOptions(pick);
    const dayOpts = Array.from({ length: (SENATECFG.ballotDaysMax || 10) - (SENATECFG.ballotDaysMin || 1) + 1 }, (_, i) => {
      const d = (SENATECFG.ballotDaysMin || 1) + i;
      return `<option value="${d}"${d === days ? " selected" : ""}>${d} day${d === 1 ? "" : "s"}</option>`;
    }).join("");
    const quota = Senate.ballotWeekQuota(), used = Senate.ballotWeekUsed();
    const quotaNote = Senate.isBallotAdmin()
      ? `Admin — unlimited ballots this week.`
      : `This week: <b>${used}/${isFinite(quota) ? quota : "—"}</b> used (Tier ${tier} → ${isFinite(quota) ? quota : 0}/week).`;
    let ballotPanel;
    if (!Senate.canBallot()) {
      const why = Senate.shared && !(window.Cloud && Cloud.signedIn())
        ? `Sign in to table legislation onto the galaxy-wide agenda (Baron Tier <b>${SENATECFG.ballotMinTier}</b>+).`
        : `Table your own legislation at Baron Tier <b>${SENATECFG.ballotMinTier}</b> — you're Tier <b>${tier}</b>. Ascend to earn a seat at the rostrum.`;
      ballotPanel = `<div class="panel"><h2>Ballot Initiative <small>set the agenda</small></h2><p class="muted-note">${why}</p></div>`;
    } else {
      const strengthRow = hasStr
        ? `<label class="ballot-field">Effect strength
            <select data-ballot="factor" aria-label="Effect strength">${strOpts.map(o =>
              `<option value="${o.factor}"${Number(o.factor) === Number(factor) ? " selected" : ""}>${o.label}</option>`).join("")}</select></label>`
        : `<p class="muted-note">Prohibitions are all-or-nothing — no percentage dial. Duration still scales the fee and the chamber's resistance.</p>`;
      const preview = strOpts.find(o => Number(o.factor) === Number(factor));
      const blurb = preview ? preview.blurb
        : (pickTpl ? Senate._instantiate(pickTpl, { factor: 1, label: "" },
            pickTpl.scope === "cat" ? { cat: pick.split("|")[1] }
              : pickTpl.scope === "comm" ? { comm: pick.split("|")[1] }
              : pickTpl.scope === "faction" ? { faction: pick.split("|")[1] } : {}).blurb : "");
      ballotPanel = `<div class="panel"><h2>Ballot Initiative <small>set the agenda</small></h2>
        <p class="muted-note">${Senate.shared ? "Galaxy-wide docket — every baron faces your bill." : "Table onto your local docket."}
          Fee scales with strength and duration. Stronger / longer bills are harder to pass. ${quotaNote}</p>
        <div class="ballot-form">
          <label class="ballot-field">Measure
            <select data-ballot="pick" aria-label="Bill to table">${optsList.map(o =>
              `<option value="${o.value}"${o.value === pick ? " selected" : ""}>${o.label}</option>`).join("")}</select></label>
          ${strengthRow}
          <label class="ballot-field">Duration in force
            <select data-ballot="days" aria-label="Edict duration">${dayOpts}</select></label>
        </div>
        <p class="ballot-preview muted-note">${blurb || ""}</p>
        <div class="ballot-meta">
          <span class="ballot-odds ${odds ? odds.cls : ""}">Chamber sentiment: <b>${odds ? odds.text : "—"}</b>
            ${odds ? `(~${Math.round(odds.pct * 100)}% lean to pass)` : ""}</span>
          <span class="muted-note">Fee <b>${Util.credits(costNow)}c</b> · resistance ${(Math.round((1 - leanNow) * 100))}%</span>
        </div>
        <div class="ballot-row">
          <button class="btn btn-go" data-sn="ballot">Table it · ${Util.credits(costNow)}c</button>
        </div></div>`;
    }
    const mine = Senate.myUpcomingBallots(now);
    const upAll = upcoming;
    const minePanel = `<div class="panel"><h2>Your Ballots <small>on the docket</small></h2>` +
      (mine.length ? `<div class="ballot-mine">${mine.map(b => {
        const idx = upAll.findIndex(x => x.id === b.id);
        const canBump = idx > 0;
        return `<div class="bill upcoming">
          <div class="bill-head"><b>${b.title}</b>${propBadge(b)}
            <span class="bill-eta">${idx === 0 ? "on the floor · " : `#${idx + 1} · `}votes in ${Util.duration(Math.max(0, b.votesAt - now))}</span></div>
          <div class="bill-blurb">${b.blurb}</div>
          <div class="ballot-bump-row">
            ${canBump
              ? `<button class="btn btn-mini" data-sn="bump" data-id="${b.id}">Move up · ${Util.credits(Senate.ballotBumpCost())}c</button>`
              : `<span class="muted-note">Already first on the docket</span>`}
            ${b.ballotDays ? `<span class="muted-note">${b.ballotDays}d edict</span>` : (b.edictMs ? `<span class="muted-note">${Math.round(b.edictMs / Senate.ballotDayMs())}d edict</span>` : "")}
          </div></div>`;
      }).join("")}</div>`
        : `<p class="muted-note">No ballot initiatives of yours on the docket yet.</p>`) + `</div>`;
    if (Senate.canBallot()) ballotPanel = (ballotPanel || "") + minePanel;

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
        <div class="vh-item-head"><b>${b.title}</b>${propBadge(b)}<span class="vh-badge ${cls}">${label}</span></div>
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
    const tabs = [["overview", "Overview"], ["ballot", "Ballot"], ["edicts", "Active Edicts"], ["reps", "Representatives"], ["history", "Voting History"]];
    const nav = `<nav class="subtabs senate-subtabs">${tabs.map(([k, l]) =>
      `<button class="subtab${this.senateTab === k ? " active" : ""}" data-sntab="${k}">${l}</button>`).join("")}</nav>`;
    const body = this.senateTab === "ballot" ? ballotPanel
      : this.senateTab === "edicts" ? edictPanel
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
    if (act === "ballot") {
      const root = this.refs.senateBody;
      const pick = (root.querySelector('[data-ballot="pick"]') || {}).value || "";
      const factorEl = root.querySelector('[data-ballot="factor"]');
      const daysEl = root.querySelector('[data-ballot="days"]');
      const factor = factorEl ? factorEl.value : 1;
      const days = daysEl ? daysEl.value : (SENATECFG.ballotDaysDefault || 3);
      const btn = b; btn.disabled = true;
      const finish = r => {
        btn.disabled = false;
        if (!r || !r.ok) return this.toast((r && r.msg) || "Could not table that bill.", "warn");
        this.toast(`Tabled: ${r.bill.title}`, "good"); this.flashCredits(); window.Game.requestSave(); this.updateHeader(); this.renderSenate();
      };
      const r = Senate.proposeBill(pick, factor, days);
      if (r && typeof r.then === "function") { r.then(finish).catch(e => finish({ ok: false, msg: e.message || "Could not table that bill." })); return; }
      finish(r);
      return;
    }
    if (act === "bump") {
      const btn = b; btn.disabled = true;
      const finish = r => {
        btn.disabled = false;
        if (!r || !r.ok) return this.toast((r && r.msg) || "Could not move that bill up.", "warn");
        this.toast("Ballot moved up the docket.", "good"); this.flashCredits(); window.Game.requestSave(); this.updateHeader(); this.renderSenate();
      };
      const r = Senate.bumpBill(b.dataset.id);
      if (r && typeof r.then === "function") { r.then(finish).catch(e => finish({ ok: false, msg: e.message || "Could not move that bill up." })); return; }
      finish(r);
      return;
    }
    if (act === "lobby") {
      const r = Senate.lobby(b.dataset.v);
      if (!r.ok) return this.toast(r.msg, "warn");
      this.toast("Lobbying campaign funded.", "good"); this.flashCredits(); window.Game.requestSave(); this.updateHeader(); this.renderSenate();
    }
  },
  onSenateFilter(e) {
    const ball = e.target.closest("[data-ballot]");
    if (ball) {
      this.ballotForm ||= { pick: "", factor: 1, days: SENATECFG.ballotDaysDefault || 3 };
      const key = ball.dataset.ballot;
      if (key === "pick" || key === "factor" || key === "days") {
        this.ballotForm[key] = ball.value;
        if (key === "pick") this.ballotForm.factor = 1;   // reset strength when measure changes
        this.renderSenate();
      }
      return;
    }
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

  // ===== BARONS / leaderboard (human players only) =========================
  renderLeaderboard() {
    if (this.page !== "barons") return;
    this.renderBaronTrack();
    if (!window.Barons) {
      this.refs.lbList.innerHTML = `<li class="muted-note">Leaderboard unavailable.</li>`;
      return;
    }
    const page = Barons.pageWindow(this.lbOffset);
    this.lbOffset = page.start;
    const signed = !!(window.Cloud && Cloud.signedIn && Cloud.signedIn());
    if (Barons.missing) {
      this.refs.lbSub.textContent = "board offline — run docs/sql/baron_board.sql on Supabase";
    } else if (!signed) {
      this.refs.lbSub.textContent = page.total
        ? `${page.total} barons online — sign in to take your seat`
        : "sign in to join the Baron Leaderboard";
    } else if (page.youRank != null) {
      this.refs.lbSub.textContent = `you sit #${page.youRank} of ${page.total} — rival piles update once a day`;
    } else {
      this.refs.lbSub.textContent = page.total ? `${page.total} barons on the board` : "no barons published yet";
    }
    if (this.refs.lbPageLabel) {
      this.refs.lbPageLabel.textContent = page.total
        ? `Ranks #${page.start + 1}–#${page.end}`
        : "—";
    }
    if (this.refs.lbPrev) this.refs.lbPrev.disabled = !page.hasPrev;
    if (this.refs.lbNext) this.refs.lbNext.disabled = !page.hasNext;
    if (!page.rows.length) {
      const tip = Barons.missing
        ? "Install the baron board SQL to go live."
        : signed
          ? "You're first — keep trading and your daily worth will post here."
          : "Sign in to claim a seat among the barons.";
      this.refs.lbList.innerHTML = `<li class="muted-note">${tip}</li>`;
      return;
    }
    this.refs.lbList.innerHTML = page.rows.map(r => {
      const title = r.title ? `<span class="lb-title">${r.title}</span>` : "";
      const who = r.you
        ? `<b class="lb-name">${r.name || "You"}</b> ${title}<span class="lb-fac you">◆ you</span>`
        : `<b class="lb-name">${r.name}</b> ${title}`;
      return `<li class="lb-row ${r.you ? "lb-you" : ""}">
        <span class="lb-rank">#${r.rank}</span>
        <span class="lb-who">${who}</span>
        <span class="lb-nw">${Util.credits(r.netWorth)}c</span></li>`;
    }).join("");
  },
  lbPage(dir) {
    if (!window.Barons) return;
    const cur = Barons.pageWindow(this.lbOffset);
    this.lbOffset = dir < 0 ? cur.prevStart : cur.nextStart;
    this.renderLeaderboard();
  },
  async refreshBarons() {
    if (!window.Barons) return;
    await Barons.refresh();
    if (this.page === "barons") this.renderLeaderboard();
    this.updateHeader();
  },

  // the Baron Tier "ascension" track: current title + perks, and the next tier
  renderBaronTrack() {
    const el = this.refs.baronTrack; if (!el) return;
    const cur = Economy.tierInfo(), next = Economy.nextTier(), nw = Economy.netWorth();
    const perks = this.tierPerks(cur);
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
    el.innerHTML = `<h2 class="bt-title-row"><span>${this.t("barons.yourTitle", "Your Title")} <small>${cur.title}</small></span>
      <button type="button" class="btn btn-mini" id="baron-ranks-btn">${this.t("barons.ranksBtn", "All ranks")}</button></h2>
      <p class="muted-note">Ascending a tier keeps everything you own — stocks, industries, ships, senator ties — and grants a bigger empire, at the price of a steeper tax on all earnings.</p>
      ${perks}${nextHtml}`;
    const btn = el.querySelector("#baron-ascend");
    if (btn) btn.onclick = () => this.doAscend();
    const ranksBtn = el.querySelector("#baron-ranks-btn");
    if (ranksBtn) ranksBtn.onclick = () => this.openBaronRanks();
  },
  // one perk row, shared by the ascension track and the All-ranks modal
  tierPerks(t) {
    return `<div class="bt-perks">
      <span>${this.t("barons.tax")} <b class="${t.tax ? "down" : "up"}">${(t.tax * 100).toFixed(0)}%</b></span>
      <span>${this.t("barons.permits")} <b>${t.permits}</b></span>
      <span>${this.t("barons.fleetCap")} <b>${t.fleet}</b></span>
      <span>${this.t("barons.tradeCap")} <b>${Util.credits(t.cap)}c</b></span>
    </div>`;
  },
  openBaronRanks() {
    const body = this.refs.baronRanksBody, modal = this.refs.baronRanks;
    if (!body || !modal) return;
    const curIdx = Economy.tier();
    body.innerHTML = `<div class="baron-ranks-list">` + BARON_TIERS.map((t, i) => {
      const mine = i === curIdx;
      const gate = t.threshold
        ? this.t("barons.fromNetWorth").replace("{c}", Util.credits(t.threshold))
        : this.t("barons.startTitle");
      return `<div class="baron-rank-row${mine ? " current" : ""}">
        <div class="baron-rank-head"><b>${t.title}</b>${mine ? `<span class="baron-rank-you">${this.t("barons.ranksYou")}</span>` : ""}
          <span class="muted-note">${gate}</span></div>
        ${this.tierPerks(t)}
      </div>`;
    }).join("") + `</div>`;
    modal.classList.remove("hidden");
  },
  async doAscend() {
    if (!Economy.canPrestige()) return;
    const next = Economy.nextTier();
    if (!confirm(`Ascend to ${next.title}? You keep your entire empire — stocks, industries, ships and senator ties — and gain ${next.permits} industry permits + a fleet cap of ${next.fleet}. The price: a permanent ${(next.tax * 100).toFixed(0)}% tax on all earnings (it never goes back down).`)) return;
    const res = await Promise.resolve(Economy.prestige());
    if (res && res.ok) { this.toast(`Ascended — you are now a ${res.title || next.title}.`, "good", 5000); this.fullRender(); }
    else if (res && res.msg) this.toast(res.msg, "bad");
  },

  // ===== broadcast / feed ==================================================
  // `url` optional — when set (pool pick / GIF), skip the default PNG path.
  setBroadcast({ channel, title, caption, url }) {
    const img = this.refs.bcFrame; img.onerror = () => { img.style.visibility = "hidden"; };
    img.style.visibility = "visible";
    img.src = url || ASSET.broadcast(channel, Date.now());
    this.refs.bcTitle.textContent = title; this.refs.bcCaption.textContent = caption;
  },
  showNews(entry) {
    const pick = ASSET.broadcastEntry("news", Date.now() + ":" + (entry.id || ""));
    this.setBroadcast({
      channel: "news", url: pick.url,
      title: entry.headline, caption: entry.body,
    });
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
    // ponytail: chat is ambient chatter — no Comms badge. Dispatches + Broadcast still bump.
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
  showWYWA({ elapsedMs, reports, sold, chartered, orders, industry, mercs, recap }) {
    const fills = (orders || []).filter(e => e.type === "filled");
    const made = industry || [], merced = mercs || [], rc = recap || {};
    const seized = rc.seized || [], movers = rc.movers || [];
    const senateChanged = rc.senate && (rc.senate.passed.length || rc.senate.repealed.length);
    const anything = reports.length || sold.length || fills.length || made.length
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
        if (r.type === "charter") return `<li>📜 <span class="${r.success ? "up" : "down"}">${r.summary || r.title}</span></li>`;
        return r.success
          ? `<li>${r.title}: <span class="up">success</span> +${Util.credits(r.credits)}c${r.items.length ? ` · ${r.items.length} item(s)` : ""}${r.lost.length ? ` · lost ${r.lost.length} ship(s)` : ""}${wear}</li>`
          : `<li>${r.title}: <span class="down">failed</span>${r.lost.length ? ` · lost ${r.lost.length} ship(s)` : r.impounded.length ? ` · ${r.impounded.length} impounded` : ""}${wear}</li>`;
      }).join("") + `</ul>`;
    }
    if (fills.length) html += `<p>Standing orders filled: ${fills.map(f => `${f.side} ${f.qty} ${f.comm.name}`).join(", ")}.</p>`;
    if (made.length) {
      const agg = {}, taxAgg = {}, edictTitles = new Set();
      for (const m of made) {
        agg[m.commodity] = (agg[m.commodity] || 0) + m.qty;
        if (m.tax) taxAgg[m.commodity] = (taxAgg[m.commodity] || 0) + m.tax;
        for (const e of (m.edicts || [])) edictTitles.add(`${e.title} (${e.rate >= 0 ? "+" : ""}${(e.rate * 100).toFixed(0)}%)`);
      }
      const bits = Object.entries(agg).map(([id, q]) => {
        const nm = (COMMODITIES.find(c => c.id === id) || {}).name || id;
        const t = taxAgg[id];
        return t ? `${q} ${nm} <span class="muted-note">(−${t} tax)</span>` : `${q} ${nm}`;
      });
      html += `<p>Industries produced: ${bits.join(", ")} (now in your stock).</p>`;
      if (edictTitles.size) html += `<ul class="edict-tax-list wywa-edicts">${[...edictTitles].map(t => `<li><b>Senate</b> — ${t}</li>`).join("")}</ul>`;
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
  _volumePct() {
    const v = this.s().settings.volume;
    const n = v == null ? 0.25 : +v;
    return Math.round(Util.clamp(Number.isFinite(n) ? n : 0.25, 0, 1) * 100);
  },
  applySettings() {
    const set = this.s().settings;
    if (set.volume == null || !Number.isFinite(+set.volume)) set.volume = 0.25;
    set.volume = Util.clamp(+set.volume, 0, 1);
    document.body.classList.toggle("muted", !!set.muted);
    document.body.classList.toggle("reduced", !!set.reduced);
    if (this.refs.setReduced) this.refs.setReduced.checked = !!set.reduced;
    if (this.refs.setVolume) this.refs.setVolume.value = String(this._volumePct());
    if (this.refs.setVolumeVal) this.refs.setVolumeVal.textContent = `${this._volumePct()}%`;
    if (this.refs.btnMute) {
      const on = !set.muted;
      this.refs.btnMute.textContent = on ? "🔊" : "🔇";
      const tip = on
        ? (window.I18n ? I18n.t("btn.audioOn") : "Audio on")
        : (window.I18n ? I18n.t("btn.audioOff") : "Audio off");
      this.refs.btnMute.title = tip;
      this.refs.btnMute.setAttribute("aria-label", tip);
      this.refs.btnMute.setAttribute("aria-pressed", on ? "false" : "true");
      this.refs.btnMute.classList.toggle("is-muted", !on);
    }
    if (this.refs.setFastNews) this.refs.setFastNews.checked = !!CONFIG.fastNews;
    if (this.refs.setFast) this.refs.setFast.checked = (window.Game.timeScale || 1) > 1;
    if (this.refs.langToggle) {
      const lang = window.I18n ? I18n.lang : (set.lang || "en");
      for (const b of this.refs.langToggle.querySelectorAll(".lang-btn")) b.classList.toggle("active", b.dataset.lang === lang);
    }
    // Wiped-save backup — presence check only (don't JSON.parse on every fullRender).
    const hasBak = !!(window.Game && Game.hasCorruptBackup && Game.hasCorruptBackup());
    if (this.refs.setRestore) this.refs.setRestore.classList.toggle("hidden", !hasBak);
    if (this.refs.setRestoreNote) this.refs.setRestoreNote.classList.toggle("hidden", !hasBak);
    if (window.Bgm) Bgm.applyVolume();
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
    this.refs.tabs.onclick = e => {
      const t = e.target.closest(".tab"); if (!t) return;
      if (t.dataset.page === "starmap") { if (window.StarMap) StarMap.toggle(); return; }   // overlay, not a page — leaves the underlying page active
      this.showPage(t.dataset.page);
    };
    const commsTabs = document.getElementById("comms-tabs");
    if (commsTabs) commsTabs.onclick = e => {
      const b = e.target.closest("[data-comms]"); if (!b) return;
      this.showCommsTab(b.dataset.comms);
    };
    const fleetTabs = document.getElementById("fleet-tabs");
    if (fleetTabs) fleetTabs.onclick = e => {
      const b = e.target.closest("[data-fleet]"); if (!b) return;
      this.showFleetTab(b.dataset.fleet);
    };
    const indTabs = document.getElementById("industries-tabs");
    if (indTabs) indTabs.onclick = e => {
      const b = e.target.closest("[data-ind]"); if (!b) return;
      this.showIndustriesTab(b.dataset.ind);
    };
    if (this.refs.workshopTabs) this.refs.workshopTabs.onclick = e => {
      const b = e.target.closest("[data-ws]"); if (!b) return;
      this.workshopTab = b.dataset.ws;
      this.renderWorkshop();
    };
    window.addEventListener("resize", () => this.updateNavIndicator());
    requestAnimationFrame(() => this.updateNavIndicator());
    // Mobile hamburger. The drawer's open/closed paint is pure CSS (.menu-open);
    // this only flips the class, keeps aria-expanded honest, and closes on
    // outside tap / Escape / picking anything inside.
    if (r.btnMenu && r.topbar) {
      const setMenu = on => {
        r.topbar.classList.toggle("menu-open", on);
        r.btnMenu.setAttribute("aria-expanded", on ? "true" : "false");
      };
      r.btnMenu.onclick = () => setMenu(!r.topbar.classList.contains("menu-open"));
      if (r.topmenu) r.topmenu.addEventListener("click", e => { if (e.target.closest(".btn")) setMenu(false); });
      document.addEventListener("click", e => { if (!r.topbar.contains(e.target)) setMenu(false); });
      document.addEventListener("keydown", e => { if (e.key === "Escape") setMenu(false); });
    }
    r.btnSettings.onclick = () => r.settings.classList.remove("hidden");
    r.setClose.onclick = () => r.settings.classList.add("hidden");
    if (r.btnMute) r.btnMute.onclick = () => {
      this.s().settings.muted = !this.s().settings.muted;
      this.applySettings(); window.Game.requestSave();
    };
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
    if (r.baronRanksClose) r.baronRanksClose.onclick = () => r.baronRanks.classList.add("hidden");
    if (r.baronRanks) {
      r.baronRanks.onclick = e => { if (e.target === r.baronRanks) r.baronRanks.classList.add("hidden"); };
      document.addEventListener("keydown", e => {
        if (e.key === "Escape" && r.baronRanks && !r.baronRanks.classList.contains("hidden"))
          r.baronRanks.classList.add("hidden");
      });
    }
    r.incClose.onclick = () => r.incident.classList.add("hidden");
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
    if (r.setVolume) {
      const applyVol = () => {
        const pct = Util.clamp(+r.setVolume.value || 0, 0, 100);
        this.s().settings.volume = pct / 100;
        // Dragging volume up while muted is a clear intent to hear sound again.
        if (pct > 0 && this.s().settings.muted) this.s().settings.muted = false;
        this.applySettings(); window.Game.requestSave();
      };
      r.setVolume.oninput = applyVol;
      r.setVolume.onchange = applyVol;
    }
    r.setReduced.onchange = () => { this.s().settings.reduced = r.setReduced.checked; this.applySettings(); window.Game.requestSave(); };
    r.setFastNews.onchange = () => { CONFIG.fastNews = r.setFastNews.checked; Broadcast.start(); window.Game.scheduleLocalEvent(); window.Game.scheduleLocalFlavor(); };
    r.setFast.onchange = () => { window.Game.timeScale = r.setFast.checked ? 60 : 1; Broadcast.start(); window.Game.scheduleLocalEvent(); window.Game.scheduleLocalFlavor(); };
    r.setReset.onclick = () => { if (confirm("Wipe your Cosmocrat save and start over?")) window.Game.reset(); };
    if (r.setRestore) r.setRestore.onclick = () => {
      const bak = window.Game && Game.readCorruptBackup && Game.readCorruptBackup();
      if (!bak) return this.toast("No wiped-save backup in this browser.", "warn");
      const summary = Game.corruptBackupSummary(bak);
      const richer = Game.corruptBackupIsRicher(bak);
      // Soft-merge recovers Workshop / inventory without discarding current progress.
      // Full replace is offered when the backup isn't "richer" in those slices (or
      // the player wants the whole old save back).
      if (richer) {
        if (!confirm(`Recover missing Workshop gear from the wipe backup?\n\nBackup has: ${summary}\n\nThis keeps your current credits and adds anything the backup still has that this save lost.`)) return;
        const r0 = Game.mergeCorruptClientSlices(bak);
        if (!r0.ok) return this.toast(r0.msg, "warn");
        this.toast(`Recovered ${r0.added} missing piece${r0.added === 1 ? "" : "s"} from the wipe backup.`, "good", 6000);
        this.applySettings(); this.fullRender(); this.updateHeader();
        return;
      }
      if (!confirm(`Replace this save with the wipe backup?\n\nBackup has: ${summary}\n\nThis reloads the game from that backup.`)) return;
      Game.restoreCorruptBackup().then(r0 => { if (r0 && !r0.ok) this.toast(r0.msg, "warn"); });
    };

    r.btnPrestige.onclick = () => this.doAscend();
    if (r.lbPrev) r.lbPrev.onclick = () => this.lbPage(-1);
    if (r.lbNext) r.lbNext.onclick = () => this.lbPage(1);

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
      this.toast(`${r.title}: ${r.success ? "SUCCESS +" + Util.credits(r.credits) + "c" : "FAILED"} — report in Dispatches ▸`, r.success ? "good" : "bad", 5000);
      if (this.page === "fleet") this.renderFleet();
      if (this.page === "comms" && this.commsTab === "dispatches") this.renderDispatches();
      this.updateHeader(); this.audioSafe(r.success ? "good" : "news");
    });
    Bus.on("missionDebrief", () => {
      if (window.Game._booting) return;
      this.bumpComms();
      if (this.page === "comms") this.showCommsTab("dispatches");
    });
    Bus.on("surveyDebrief", () => {
      if (window.Game._booting) return;
      this.toast("Survey debrief waiting in Dispatches ▸", "good");
      this.bumpComms();
      if (this.page === "fleet") this.renderFleet();
      if (this.page === "comms") this.showCommsTab("dispatches");
    });
    Bus.on("surveyDone", r => {
      if (window.Game._booting) return;   // offline surveys land in the "while you were away" recap
      if (r.awaitingDebrief) return;     // surveyDebrief already toasted the inbox ping
      this.toast(`🛰 ${r.summary}`, r.success ? "good" : "bad", 6000);
      if (this.page === "fleet") this.renderFleet();
      if (this.page === "comms" && this.commsTab === "dispatches") this.renderDispatches();
      if (window.StarMap) { StarMap.updateGalaxyNodes(); StarMap.refreshInfo(); }
      this.updateHeader(); this.audioSafe(r.success ? "good" : "news");
    });
    Bus.on("charterDone", r => {
      if (window.Game._booting) return;   // offline charters land in the "while you were away" recap
      this.toast(r.summary || r.title, r.success ? "good" : "bad", 6000);
      if (this.page === "fleet") this.renderFleet();
      if (this.page === "bazaar" && this.bazaarTab === "charters") this.renderBazaar();
      if (this.commsTab === "pending") this.renderPendingContracts();
      this.updateHeader(); this.audioSafe(r.success ? "good" : "news");
    });
    // Server-side craft delivery lands asynchronously (Workshop.claimDue), so
    // the goods announce themselves instead of appearing during a render.
    Bus.on("crafted", done => {
      for (const d of done) this.toast(`Workshop finished ${d.name}.`, "good", 5000);
      this.updateHeader();
      if (this.page === "workshop") this.renderWorkshop();
      if (this.page === "fleet") this.renderInventory();
    });
    Bus.on("listingSold", sl => { this.toast(`Sold ${sl.name} on the market: +${Util.credits(sl.price)}c`, "buy"); if (this.page === "fleet") this.renderInventory(); });
    Bus.on("dock", d => { if (d.arrived) { this.toast(`Docked at ${this.sysName(d.sysId)}.`, "good"); this.updateExchange(); this.updateHeader(); this.renderSystems(); } });
    Bus.on("customs", ev => {
      if (window.Game._booting) return;   // offline seizures are shown in the "while you were away" recap
      const where = this.sysName(ev.sysId);
      if (ev.impoundedTo) {
        this.toast(`⚠ Customs seized ${ev.qty} ${ev.name} at ${where} — held in station impound (ransom available).`, "bad", 7000);
        if (window.Feed) Feed.emit(`customs locked a baron's ${ev.name.toLowerCase()} in the ${where} impound 🚨`, { kind: "reaction" });
      } else {
        this.toast(`⚠ Customs seized ${ev.qty} ${ev.name} (${Util.credits(ev.value)}c) at the ${where} gate.`, "bad", 6000);
        if (window.Feed) Feed.emit(`customs pulled a baron's ${ev.name.toLowerCase()} at ${where} — ${ev.qty} units gone 🚨`, { kind: "reaction" });
      }
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
    if (this.page === "hub") this.renderBoostBar();
    if (this.page === "workshop") this.renderWorkshop();
    if (this.page === "stations") this.renderStations();
    if (this.page === "fleet") { this.renderMissions(); this.renderCharters(); }
    if (this.commsTab === "pending" && this.page === "comms") this.renderPendingContracts();
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
    if (this.page === "stations") this.renderStations();
  },
};

window.UI = UI;
