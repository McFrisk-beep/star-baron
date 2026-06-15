/* ui.js — all DOM rendering. Reads game state + modules, writes the screen.
   Static structure lives in index.html; this builds the dynamic bits and
   updates them each tick. No game logic here.                                 */

const UI = {
  refs: {},
  rows: {},          // commodity id -> {tr, cells...} for cheap per-tick updates
  lastPrice: {},     // for flash coloring
  feedPaused: false, // true when user scrolls up

  s() { return window.Game.state; },

  el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  },

  sysName(id) { const s = SYSTEMS.find(x => x.id === id); return s ? s.name : id; },

  // ---- bootstrap ----------------------------------------------------------
  init() {
    const $ = id => document.getElementById(id);
    this.refs = {
      credits: $("hud-credits"), networth: $("hud-networth"), system: $("hud-system"),
      sentiment: $("hud-sentiment-fill"), tier: $("hud-tier"), clock: $("hud-clock"),
      exchangeSub: $("exchange-sub"), marketBody: $("market-body"),
      dShip: $("d-ship"), dComm: $("d-comm"), dQty: $("d-qty"), dDest: $("d-dest"),
      dHint: $("d-hint"), shipList: $("ship-list"), systemList: $("system-list"),
      achList: $("ach-list"), achCount: $("ach-count"),
      bcFrame: $("bc-frame"), bcTitle: $("bc-title"), bcCaption: $("bc-caption"),
      tickerText: $("ticker-text"), newswireList: $("newswire-list"),
      feedList: $("feed-list"), toast: $("toast-stack"),
      btnPrestige: $("btn-prestige"), btnSettings: $("btn-settings"),
      wywa: $("wywa-modal"), wywaBody: $("wywa-body"), wywaClose: $("wywa-close"),
      settings: $("settings-modal"),
      setMute: $("set-mute"), setReduced: $("set-reduced"),
      setFastNews: $("set-fastnews"), setFast: $("set-fast"),
      setReset: $("set-reset"), setClose: $("set-close"),
    };
    this.buildExchange();
    this.wireControls();
    this.wireBus();
    this.refreshDispatch();
    this.renderSystems();
    this.renderAchievements();
    this.applySettings();
  },

  // ---- exchange -----------------------------------------------------------
  buildExchange() {
    const body = this.refs.marketBody;
    body.innerHTML = "";
    this.rows = {};
    for (const c of COMMODITIES) {
      const tr = this.el("tr");
      tr.dataset.id = c.id;
      const icon = this.el("td", "ico");
      const img = new Image();
      img.src = ASSET.commodity(c.id);
      img.alt = "";
      img.onerror = () => { img.replaceWith(this.tintBox(c)); };
      icon.appendChild(img);
      const name = this.el("td", "name", `${c.name}<span class="cat cat-${c.cat}">${c.cat}</span>`);
      const price = this.el("td", "num price");
      const chg = this.el("td", "num chg");
      const trend = this.el("td", "trend");
      const held = this.el("td", "num held");
      const pnl = this.el("td", "num pnl");
      const act = this.el("td", "actions");
      act.innerHTML =
        `<div class="qrow">
           <input type="number" class="qin" min="1" value="10" aria-label="quantity for ${c.name}" />
           <button class="btn btn-buy" data-act="buy">Buy</button>
           <button class="btn btn-sell" data-act="sell">Sell</button>
           <button class="btn btn-mini" data-act="max">Max</button>
           <button class="btn btn-mini" data-act="all">All</button>
         </div>`;
      tr.append(icon, name, price, chg, trend, held, pnl, act);
      body.appendChild(tr);
      this.rows[c.id] = { tr, price, chg, trend, held, pnl, qin: act.querySelector(".qin") };
    }
    // one delegated handler for all trade buttons
    body.addEventListener("click", e => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const id = btn.closest("tr").dataset.id;
      const qin = this.rows[id].qin;
      const act = btn.dataset.act;
      if (act === "buy") this.doTrade("buy", id, parseInt(qin.value, 10) || 0);
      else if (act === "sell") this.doTrade("sell", id, parseInt(qin.value, 10) || 0);
      else if (act === "max") this.doTrade("buy", id, Economy.maxBuy(id));
      else if (act === "all") this.doTrade("sell", id, this.s().positions[id] || 0);
    });
  },

  tintBox(c) {
    const d = this.el("div", "tintbox");
    d.textContent = c.name.slice(0, 2);
    return d;
  },

  doTrade(side, id, qty) {
    const r = side === "buy" ? Economy.buy(id, qty) : Economy.sell(id, qty);
    if (!r.ok) { this.toast(r.msg, "warn"); return; }
    const comm = COMMODITIES.find(c => c.id === id);
    if (side === "buy") this.toast(`Bought ${r.qty} ${comm.name} for ${Util.credits(r.cost)}c`, "buy");
    else this.toast(`Sold ${r.qty} ${comm.name} for ${Util.credits(r.proceeds)}c (${r.realized >= 0 ? "+" : ""}${Util.credits(r.realized)})`, r.realized >= 0 ? "good" : "bad");
    this.flashCredits();
    window.Game.requestSave();
    this.updateExchange();
    this.refreshDispatch();
  },

  updateExchange() {
    const sys = this.s().currentSystem;
    this.refs.exchangeSub.textContent = `· prices at ${this.sysName(sys)}`;
    for (const c of COMMODITIES) {
      const r = this.rows[c.id];
      const p = Market.systemPrice(c.id, sys);
      const prev = this.lastPrice[c.id];
      r.price.textContent = Util.price(p);
      if (prev != null && Math.abs(p - prev) > 1e-6) {
        r.price.classList.remove("up", "down");
        void r.price.offsetWidth;
        r.price.classList.add(p > prev ? "up" : "down");
      }
      this.lastPrice[c.id] = p;

      const pct = Market.changePct(c.id);
      r.chg.textContent = (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%";
      r.chg.className = "num chg " + (pct > 0.1 ? "up" : pct < -0.1 ? "down" : "");

      r.trend.innerHTML = this.spark(Market.history(c.id), pct >= 0);

      const q = this.s().positions[c.id] || 0;
      r.held.textContent = q ? q : "·";
      if (q) {
        const cost = this.s().avgCost[c.id] || 0;
        const upl = (p - cost) * q;
        r.pnl.textContent = (upl >= 0 ? "+" : "") + Util.credits(upl);
        r.pnl.className = "num pnl " + (upl >= 0 ? "up" : "down");
      } else {
        r.pnl.textContent = "·";
        r.pnl.className = "num pnl";
      }
    }
  },

  spark(hist, up) {
    const w = 96, h = 24, n = hist.length;
    if (n < 2) return "";
    const min = Math.min(...hist), max = Math.max(...hist), span = max - min || 1;
    const pts = hist.map((v, i) =>
      `${(i / (n - 1) * w).toFixed(1)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(1)}`).join(" ");
    const col = up ? "var(--up)" : "var(--down)";
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none">
      <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5"/></svg>`;
  },

  // ---- header -------------------------------------------------------------
  updateHeader() {
    const s = this.s();
    this.refs.credits.textContent = Util.credits(s.credits);
    this.refs.networth.textContent = Util.credits(Economy.netWorth());
    this.refs.system.textContent = this.sysName(s.currentSystem);
    this.refs.tier.textContent = s.prestige.tier;
    const sent = Market.sentiment();
    const pct = (sent + 1) / 2 * 100;
    this.refs.sentiment.style.width = pct.toFixed(0) + "%";
    this.refs.sentiment.style.background = sent >= 0 ? "var(--up)" : "var(--down)";
    this.refs.btnPrestige.classList.toggle("hidden", !Economy.canPrestige());
  },

  flashCredits() {
    const el = this.refs.credits;
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  },

  // galactic clock: 5-min cycles. Shows cycle # and progress.
  updateClock() {
    const cycleMs = 5 * 60 * 1000;
    const cycle = Math.floor(Date.now() / cycleMs);
    const into = Date.now() % cycleMs;
    const remain = cycleMs - into;
    this.refs.clock.textContent = `${cycle % 10000} · ${Util.duration(remain)}`;
  },

  // ---- fleet --------------------------------------------------------------
  refreshDispatch() {
    const s = this.s();
    const idle = Fleet.idleShips();
    const dShip = this.refs.dShip, dComm = this.refs.dComm, dDest = this.refs.dDest;
    const keepShip = dShip.value, keepComm = dComm.value, keepDest = dDest.value;

    dShip.innerHTML = idle.length
      ? idle.map(sh => {
          const t = Fleet.shipType(sh.type);
          return `<option value="${sh.uid}">${t.name} · hold ${t.hold} · @ ${this.sysName(sh.at)}</option>`;
        }).join("")
      : `<option value="">— no idle ships —</option>`;
    dComm.innerHTML = COMMODITIES.map(c => `<option value="${c.id}">${c.name}</option>`).join("");
    dDest.innerHTML = s.unlockedSystems.map(id =>
      `<option value="${id}">${this.sysName(id)}</option>`).join("");

    if ([...dShip.options].some(o => o.value === keepShip)) dShip.value = keepShip;
    if (keepComm) dComm.value = keepComm;
    if ([...dDest.options].some(o => o.value === keepDest)) dDest.value = keepDest;
    this.updateDispatchHint();
  },

  updateDispatchHint() {
    const ship = this.s().ships.find(x => x.uid === this.refs.dShip.value);
    if (!ship) { this.refs.dHint.textContent = "Buy or free up a ship to run cargo."; return; }
    const t = Fleet.shipType(ship.type);
    const commId = this.refs.dComm.value, destId = this.refs.dDest.value;
    if (!destId || destId === ship.at) {
      this.refs.dHint.textContent = `Loading at ${this.sysName(ship.at)}. Choose a different destination.`;
      return;
    }
    const buy = Market.systemPrice(commId, ship.at);
    const sell = Market.systemPrice(commId, destId);
    const eta = Fleet.travelMs(ship.at, destId, t);
    const per = sell - buy;
    const comm = COMMODITIES.find(c => c.id === commId);
    this.refs.dHint.innerHTML =
      `Buy ${comm.name} @ <b>${Util.price(buy)}</b> → sell @ <b>${Util.price(sell)}</b> ` +
      `(<span class="${per >= 0 ? "up" : "down"}">${per >= 0 ? "+" : ""}${Util.price(per)}/unit</span>) · ETA ${Util.duration(eta)}`;
  },

  fillMaxQty() {
    const ship = this.s().ships.find(x => x.uid === this.refs.dShip.value);
    if (!ship) return;
    const t = Fleet.shipType(ship.type);
    const buy = Market.systemPrice(this.refs.dComm.value, ship.at);
    const afford = buy > 0 ? Math.floor(this.s().credits / buy) : 0;
    this.refs.dQty.value = Math.max(1, Math.min(t.hold, afford));
    this.updateDispatchHint();
  },

  doDispatch() {
    const uid = this.refs.dShip.value;
    if (!uid) { this.toast("No idle ship selected.", "warn"); return; }
    const r = Fleet.dispatch(uid, this.refs.dComm.value, parseInt(this.refs.dQty.value, 10) || 0, this.refs.dDest.value);
    if (!r.ok) { this.toast(r.msg, "warn"); return; }
    this.toast("Ship dispatched. Timer running ▸", "good");
    this.flashCredits();
    window.Game.requestSave();
    this.refreshDispatch();
    this.renderShips();
  },

  renderShips() {
    const s = this.s();
    const ul = this.refs.shipList;
    ul.innerHTML = "";
    for (const ship of s.ships) {
      const t = Fleet.shipType(ship.type);
      const li = this.el("li", "ship " + ship.status);
      const img = new Image(); img.src = ASSET.ship(t.sprite); img.alt = "";
      img.onerror = () => { img.replaceWith(this.el("div", "tintbox", t.name.slice(0, 1))); };
      const info = this.el("div", "ship-info");
      if (ship.status === "transit") {
        const p = Fleet.progress(ship) * 100;
        const comm = COMMODITIES.find(c => c.id === ship.cargo.id);
        info.innerHTML =
          `<div class="ship-name">${t.name} <span class="badge">in transit</span></div>
           <div class="ship-route">${this.sysName(ship.from)} → ${this.sysName(ship.to)} · ${ship.cargo.qty} ${comm.name}</div>
           <div class="bar"><span style="width:${p.toFixed(1)}%"></span></div>
           <div class="ship-eta">ETA ${Util.duration(Fleet.etaRemaining(ship))}</div>`;
      } else {
        info.innerHTML =
          `<div class="ship-name">${t.name} <span class="badge idle">idle</span></div>
           <div class="ship-route">docked @ ${this.sysName(ship.at)} · hold ${t.hold} · speed ${t.speed}</div>`;
      }
      li.append(img, info);
      ul.appendChild(li);
    }
  },

  updateShipProgress() {
    // cheap per-tick update of transit bars/etas without full rebuild
    const lis = this.refs.shipList.children;
    let i = 0;
    for (const ship of this.s().ships) {
      const li = lis[i++];
      if (!li || ship.status !== "transit") continue;
      const bar = li.querySelector(".bar span");
      const eta = li.querySelector(".ship-eta");
      if (bar) bar.style.width = (Fleet.progress(ship) * 100).toFixed(1) + "%";
      if (eta) eta.textContent = "ETA " + Util.duration(Fleet.etaRemaining(ship));
    }
  },

  // ---- systems ------------------------------------------------------------
  renderSystems() {
    const s = this.s();
    const ul = this.refs.systemList;
    ul.innerHTML = "";
    for (const sys of SYSTEMS) {
      const unlocked = s.unlockedSystems.includes(sys.id);
      const here = s.currentSystem === sys.id;
      const li = this.el("li", "system" + (here ? " here" : "") + (unlocked ? "" : " locked"));
      const mods = Object.entries(sys.mods)
        .map(([k, v]) => `<span class="mod ${v < 1 ? "cheap" : v > 1 ? "dear" : ""}">${k} ${v.toFixed(2)}</span>`)
        .join("");
      let action;
      if (!unlocked) action = `<button class="btn btn-mini" data-unlock="${sys.id}">Unlock ${Util.credits(sys.unlock)}c</button>`;
      else if (here) action = `<span class="badge">docked</span>`;
      else action = `<button class="btn btn-mini" data-dock="${sys.id}">Dock here</button>`;
      li.innerHTML =
        `<div class="system-head"><b>${sys.name}</b><span class="dist">dist ${sys.distance}</span>${action}</div>
         <div class="mods">${mods}</div>`;
      ul.appendChild(li);
    }
    ul.onclick = e => {
      const u = e.target.closest("[data-unlock]"); const d = e.target.closest("[data-dock]");
      if (u) {
        const r = Economy.unlockSystem(u.dataset.unlock);
        if (!r.ok) return this.toast(r.msg, "warn");
        this.toast(`Unlocked ${this.sysName(u.dataset.unlock)}!`, "good");
        this.flashCredits(); window.Game.requestSave();
        this.renderSystems(); this.refreshDispatch();
      } else if (d) {
        Economy.dockAt(d.dataset.dock);
        this.toast(`Docked at ${this.sysName(d.dataset.dock)}.`, "good");
        window.Game.requestSave();
        this.renderSystems(); this.updateExchange(); this.updateHeader();
      }
    };
  },

  // ---- achievements -------------------------------------------------------
  renderAchievements() {
    const got = this.s().achievements;
    this.refs.achCount.textContent = `${got.length}/${ACHIEVEMENTS.length}`;
    this.refs.achList.innerHTML = ACHIEVEMENTS.map(a => {
      const have = got.includes(a.id);
      return `<li class="ach ${have ? "got" : ""}"><b>${have ? "★" : "☆"} ${a.name}</b><span>${a.desc}</span></li>`;
    }).join("");
  },

  // ---- broadcast / feed ---------------------------------------------------
  setBroadcast({ channel, title, caption }) {
    const img = this.refs.bcFrame;
    img.onerror = () => { img.style.visibility = "hidden"; };
    img.style.visibility = "visible";
    img.src = ASSET.broadcast(channel);
    this.refs.bcTitle.textContent = title;
    this.refs.bcCaption.textContent = caption;
  },

  showNews(entry) {
    this.setBroadcast({ channel: "news", title: entry.headline, caption: entry.body });
    const scr = document.getElementById("broadcast-screen");
    scr.classList.remove("klaxon"); void scr.offsetWidth; scr.classList.add("klaxon");
    this.refs.tickerText.textContent = `${(FACTIONS[entry.faction]?.name || "GBN")}: ${entry.headline} — ${entry.body}`;
    this.renderNewswire();
    window.Game.audio("news");
  },

  renderNewswire() {
    this.refs.newswireList.innerHTML = this.s().newswire.map(n => {
      const f = FACTIONS[n.faction];
      return `<li class="wire ${n.dir}"><span class="wire-time">${Util.ago(n.ts)}</span>
        <span class="wire-faction" style="color:${f ? f.color : "#9aa"}">${f ? f.name : "GBN"}</span>
        <b>${n.headline}</b><span class="wire-body">${n.body}</span></li>`;
    }).join("") || "<li class='muted-note'>No bulletins yet.</li>";
  },

  addChat({ portrait, handle, text, kind }) {
    const ul = this.refs.feedList;
    const li = this.el("li", "msg msg-" + kind);
    const img = new Image(); img.src = ASSET.portrait(portrait); img.alt = "";
    img.className = "pfp";
    img.onerror = () => { const b = this.el("div", "pfp tintbox", handle.slice(0, 1).toUpperCase()); img.replaceWith(b); };
    const body = this.el("div", "msg-body");
    const tag = kind === "omen" ? `<span class="tag tag-omen">tip</span>`
      : kind === "scam" ? `<span class="tag tag-scam">tip</span>`
      : kind === "reaction" ? `<span class="tag tag-react">live</span>` : "";
    body.innerHTML = `<div class="msg-head"><span class="msg-handle">${handle}</span>${tag}</div><div class="msg-text"></div>`;
    body.querySelector(".msg-text").textContent = text;
    li.append(img, body);
    ul.appendChild(li);
    while (ul.children.length > CONFIG.chatMaxMessages) ul.removeChild(ul.firstChild);
    if (!this.feedPaused) ul.scrollTop = ul.scrollHeight;
  },

  // ---- toasts -------------------------------------------------------------
  toast(text, kind = "info", ms = 3200) {
    const t = this.el("div", "toast toast-" + kind, text);
    this.refs.toast.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, ms);
  },

  // ---- while you were away ------------------------------------------------
  showWYWA({ elapsedMs, runs }) {
    if (elapsedMs < 60000 && runs.length === 0) return; // not worth a modal
    const total = runs.reduce((a, r) => a + r.proceeds, 0);
    const profit = runs.reduce((a, r) => a + r.profit, 0);
    let html = `<p>You were away <b>${Util.duration(elapsedMs)}</b>.</p>`;
    if (runs.length) {
      html += `<ul class="wywa-runs">` + runs.map(r =>
        `<li>${r.shipName}: <b>${r.qty} ${r.commName}</b> → ${r.toName} for <b>${Util.credits(r.proceeds)}c</b> ` +
        `(<span class="${r.profit >= 0 ? "up" : "down"}">${r.profit >= 0 ? "+" : ""}${Util.credits(r.profit)}</span>)</li>`
      ).join("") + `</ul>`;
      html += `<p class="wywa-total">Collected <b>${Util.credits(total)}c</b> · profit ` +
        `<span class="${profit >= 0 ? "up" : "down"}">${profit >= 0 ? "+" : ""}${Util.credits(profit)}c</span></p>`;
    } else {
      html += `<p>The market drifted while you were gone. No ships had returned yet.</p>`;
    }
    this.refs.wywaBody.innerHTML = html;
    this.refs.wywa.classList.remove("hidden");
  },

  // ---- settings -----------------------------------------------------------
  applySettings() {
    const set = this.s().settings;
    document.body.classList.toggle("muted", !!set.muted);
    document.body.classList.toggle("reduced", !!set.reduced);
    this.refs.setMute.checked = !!set.muted;
    this.refs.setReduced.checked = !!set.reduced;
    this.refs.setFastNews.checked = !!CONFIG.fastNews;
    this.refs.setFast.checked = (window.Game.timeScale || 1) > 1;
  },

  // ---- wiring -------------------------------------------------------------
  wireControls() {
    const r = this.refs;
    r.dShip.onchange = () => this.updateDispatchHint();
    r.dComm.onchange = () => this.updateDispatchHint();
    r.dDest.onchange = () => this.updateDispatchHint();
    document.getElementById("d-go").onclick = () => this.doDispatch();
    document.getElementById("d-max").onclick = () => this.fillMaxQty();

    r.btnSettings.onclick = () => r.settings.classList.remove("hidden");
    r.setClose.onclick = () => r.settings.classList.add("hidden");
    r.wywaClose.onclick = () => r.wywa.classList.add("hidden");

    r.setMute.onchange = () => { this.s().settings.muted = r.setMute.checked; this.applySettings(); window.Game.requestSave(); };
    r.setReduced.onchange = () => { this.s().settings.reduced = r.setReduced.checked; this.applySettings(); window.Game.requestSave(); };
    r.setFastNews.onchange = () => { CONFIG.fastNews = r.setFastNews.checked; Broadcast.start(); window.Game.scheduleLocalEvent(); window.Game.scheduleLocalFlavor(); };
    r.setFast.onchange = () => { window.Game.timeScale = r.setFast.checked ? 60 : 1; Broadcast.start(); window.Game.scheduleLocalEvent(); window.Game.scheduleLocalFlavor(); this.refreshDispatch(); };
    r.setReset.onclick = () => {
      if (confirm("Wipe your Star Baron save and start over?")) window.Game.reset();
    };

    r.btnPrestige.onclick = () => {
      if (!Economy.canPrestige()) return;
      if (!confirm(`Retire and sell the empire? You'll reset to Baron Tier ${this.s().prestige.tier + 1} with a permanent +${((this.s().prestige.tier + 1) * PRESTIGE.bonusPerTier * 100).toFixed(0)}% edge.`)) return;
      const res = Economy.prestige();
      if (res.ok) {
        this.toast(`Empire sold. Welcome to Baron Tier ${res.tier}.`, "good", 5000);
        this.fullRender();
      }
    };

    // feed auto-scroll pause when user scrolls up
    this.refs.feedList.addEventListener("scroll", () => {
      const el = this.refs.feedList;
      this.feedPaused = el.scrollHeight - el.scrollTop - el.clientHeight > 40;
    });
  },

  wireBus() {
    Bus.on("chat", m => this.addChat(m));
    Bus.on("tv", m => { if (!Broadcast.newsLive()) this.setBroadcast(m); });
    Bus.on("news", n => this.showNews(n));
    Bus.on("achievement", a => { this.toast(`★ ${a.name} — ${a.desc}`, "good", 4500); this.renderAchievements(); window.Game.audio("good"); });
    Bus.on("runDone", d => { /* live arrivals (not offline) toast via main */ });
    Bus.on("dispatch", () => this.renderShips());
  },

  // ---- composite renders --------------------------------------------------
  tick() {
    this.updateExchange();
    this.updateHeader();
    this.updateClock();
    this.updateShipProgress();
  },

  fullRender() {
    this.buildExchange();
    this.updateExchange();
    this.updateHeader();
    this.renderShips();
    this.refreshDispatch();
    this.renderSystems();
    this.renderAchievements();
    this.renderNewswire();
    this.applySettings();
  },
};

window.UI = UI;
