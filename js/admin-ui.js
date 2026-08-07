/* admin-ui.js — admin-only control panel. Gates the dev toggles + "Admin" button
   by server role (Cloud.isAdmin), and provides two tools:
   • Content editor — renders each collection with the friendliest widget for its
     shape (table / line list / grouped lists / JSON fallback), with a raw-JSON
     escape hatch. Saves to Supabase via content.js (RLS = admin-only).
   • Image manager — a gallery of every sprite slot; upload a replacement to
     Supabase Storage and the game points at it (ASSET overrides).               */

const AdminUI = {
  r: {},
  key: null,
  kind: "json",
  view: "content",
  imgCat: 0,

  // ---- tiny DOM helper (createElement-based to avoid HTML-escaping user text) -
  el(tag, props = {}, kids = []) {
    const e = document.createElement(tag);
    for (const k in props) {
      if (k === "class") e.className = props[k];
      else if (k === "text") e.textContent = props[k];
      else if (k.startsWith("on")) e[k] = props[k];
      else if (k === "value") e.value = props[k];
      else if (k === "checked") e.checked = props[k];
      else e.setAttribute(k, props[k]);
    }
    for (const c of [].concat(kids)) if (c != null) e.append(c);
    return e;
  },

  init() {
    const $ = id => document.getElementById(id);
    this.r = {
      btn: $("btn-admin"), modal: $("admin-modal"),
      navs: document.querySelectorAll(".admin-navbtn"),
      vContent: $("admin-view-content"), vImages: $("admin-view-images"),
      select: $("admin-collection"), raw: $("admin-rawjson"),
      editor: $("admin-editor"), status: $("admin-status"),
      validate: $("admin-validate"), save: $("admin-save"), reset: $("admin-reset"),
      gallery: $("admin-gallery"), imgNote: $("admin-img-note"), imgTabs: $("admin-imgtabs"),
      vMissions: $("admin-view-missions"), mList: $("admin-mission-list"), mDetail: $("admin-mission-detail"),
      mStatus: $("admin-mission-status"), mNew: $("admin-mission-new"), mListActions: $("admin-mission-listactions"),
      vCraft: $("admin-view-craft"), cTabs: $("admin-craft-tabs"), cList: $("admin-craft-list"),
      cDetail: $("admin-craft-detail"), cStatus: $("admin-craft-status"), cNew: $("admin-craft-new"),
      cListActions: $("admin-craft-listactions"),
      vMusic: $("admin-view-music"), musicList: $("admin-music-list"), musicStatus: $("admin-music-status"),
      musicAdd: $("admin-music-add"),
      vDev: $("admin-view-dev"),
      devCredits: $("dev-credits"), devSet: $("dev-credits-set"), dev10k: $("dev-credits-10k"), dev1m: $("dev-credits-1m"),
      devTier: $("dev-tier"), devTierSet: $("dev-tier-set"),
      devLocalMode: $("dev-local-mode"),
      devSenateVote: $("dev-senate-vote"), devSenateNext: $("dev-senate-next"),
      devGlobalReset: $("dev-global-reset"), devResetStatus: $("dev-reset-status"),
      closes: document.querySelectorAll(".admin-close"),
    };
    if (this.r.btn) this.r.btn.onclick = () => this.open();
    this.r.closes.forEach(b => b.onclick = () => this.r.modal.classList.add("hidden"));
    this.r.navs.forEach(b => b.onclick = () => this.setView(b.dataset.view));
    if (this.r.select) this.r.select.onchange = () => this.openCollection(this.r.select.value);
    if (this.r.raw) this.r.raw.onchange = () => { const v = this.tryCollect(); this.renderEditor(v === undefined ? window[this.key] : v); };
    if (this.r.validate) this.r.validate.onclick = () => this.validate();
    if (this.r.save) this.r.save.onclick = () => this.doSave();
    if (this.r.reset) this.r.reset.onclick = () => this.doReset();

    // dev tools: credit / Baron-Tier cheats. When the economy is server-
    // authoritative AND you're an admin, these PERSIST via the app_admin_grant
    // RPC (see docs/sql/admin_grant.sql); otherwise they apply locally.
    const after = () => { if (window.Economy) Economy.refreshNetWorth(); if (window.UI) { UI.updateHeader(); UI.flashCredits(); } window.Game.requestSave(); };
    const localGrant = ({ credits, tier }) => {
      const s = window.Game && Game.state; if (!s) return;
      if (credits != null) s.credits = Math.max(0, Math.round(credits));
      if (tier != null) { s.prestige = s.prestige || { tier: 0, multiplier: 1 }; s.prestige.tier = Util.clamp(Math.round(tier), 0, 6); }
    };
    const grant = async ({ credits, tier, label }) => {
      const s = window.Game && Game.state; if (!s) return;
      const serverMode = !!(window.Cloud && Cloud.authoritative && Cloud.authoritative() && Cloud.isAdmin());
      if (serverMode) {
        try {
          const r = await Cloud.adminGrant(credits == null ? null : Math.round(credits), tier == null ? null : Math.round(tier));
          if (r && r.ok && r.state && window.Economy) { Economy.applyCommitState(r.state); if (window.UI) UI.toast(`${label} on the server ✓`, "good"); }
          else { if (window.UI) UI.toast("Server grant failed: " + ((r && r.error) || "unknown"), "warn", 6000); return; }
        } catch (e) {
          if (window.Cloud && Cloud._isMissingRpc && Cloud._isMissingRpc(e)) {
            localGrant({ credits, tier });
            if (window.UI) UI.toast("Server RPC not installed — applied locally only. Run docs/sql/admin_grant.sql in Supabase.", "warn", 8000);
          } else { if (window.UI) UI.toast("Server grant error: " + (e.message || e), "warn", 6000); return; }
        }
      } else {
        localGrant({ credits, tier });
        if (window.UI) UI.toast(`${label} (local${window.Cloud && Cloud.signedIn() ? " — enable Pause cloud sync to keep it, or apply the admin RPC" : ""})`, "good", 5000);
      }
      after();
    };
    const curCredits = () => (window.Game && Game.state ? Game.state.credits || 0 : 0);
    if (this.r.devSet) this.r.devSet.onclick = () => grant({ credits: +this.r.devCredits.value || 0, label: "Credits set" });
    if (this.r.dev10k) this.r.dev10k.onclick = () => grant({ credits: curCredits() + 10000, label: "+10,000c" });
    if (this.r.dev1m) this.r.dev1m.onclick = () => grant({ credits: curCredits() + 1000000, label: "+1,000,000c" });
    if (this.r.devTierSet) this.r.devTierSet.onclick = () => grant({ tier: +this.r.devTier.value || 0, label: "Baron Tier set" });
    // pause cloud authority so admin-set credits (and other local edits) stick
    // for testing instead of being overwritten by the next app_pull.
    if (this.r.devLocalMode) {
      this.r.devLocalMode.checked = !!(window.Cloud && Cloud._devLocal);
      this.r.devLocalMode.onchange = () => {
        if (!window.Cloud) return;
        Cloud._devLocal = this.r.devLocalMode.checked;
        if (window.UI) UI.toast(Cloud._devLocal
          ? "Cloud sync paused — local state is king (reload to re-sync)."
          : "Cloud sync resumed — the server is authoritative again.", "good", 5000);
        if (window.UI) UI.updateHeader();
      };
    }
    if (this.r.devSenateVote) this.r.devSenateVote.onclick = () => this.forceSenateVote();
    if (this.r.devGlobalReset) this.r.devGlobalReset.onclick = () => this.issueGlobalReset();
    if (this.r.mNew) this.r.mNew.onclick = () => this.newMission();
    if (this.r.cNew) this.r.cNew.onclick = () => this.newCraft();
    // Keep the file input attached (Images-tab pattern) — don't detach before the picker resolves.
    if (this.r.musicAdd && this.r.vMusic) {
      this._musicFile = this.el("input", {
        type: "file", class: "hidden",
        accept: "audio/mpeg,audio/mp3,audio/ogg,audio/wav,audio/webm,audio/*",
      });
      this._musicFile.onchange = () => {
        const f = this._musicFile.files && this._musicFile.files[0];
        this._musicFile.value = "";
        if (f) this.uploadMusicTrack(f);
      };
      this.r.vMusic.append(this._musicFile);
      this.r.musicAdd.onclick = () => { if (Cloud.isAdmin()) this._musicFile.click(); };
    }

    if (window.Bus) Bus.on("auth", () => this.refresh());
    this.populate();
    this.refresh();
  },

  refresh() {
    const admin = !!(window.Cloud && Cloud.isAdmin());
    if (this.r.btn) this.r.btn.classList.toggle("hidden", !admin);
  },

  open() {
    if (!window.Cloud || !Cloud.isAdmin()) return;
    this.r.modal.classList.remove("hidden");
    this.setView("content");
    this.openCollection(this.r.select.value || (Content.COLLECTIONS[0] && Content.COLLECTIONS[0].key));
  },
  setView(view) {
    this.view = view;
    this.r.navs.forEach(b => b.classList.toggle("active", b.dataset.view === view));
    this.r.vContent.classList.toggle("hidden", view !== "content");
    this.r.vImages.classList.toggle("hidden", view !== "images");
    if (this.r.vMissions) this.r.vMissions.classList.toggle("hidden", view !== "missions");
    if (this.r.vCraft) this.r.vCraft.classList.toggle("hidden", view !== "craft");
    if (this.r.vMusic) this.r.vMusic.classList.toggle("hidden", view !== "music");
    if (this.r.vDev) this.r.vDev.classList.toggle("hidden", view !== "dev");
    if (view === "images") this.buildGallery();
    if (view === "missions") this.buildMissions();
    if (view === "craft") this.buildCraft();
    if (view === "music") this.buildMusic();
    if (view === "dev") this.refreshSenateDev();
  },

  // dev: resolve the next senate bill now and watch it in the chamber
  refreshSenateDev() {
    const el = this.r.devSenateNext; if (!el) return;
    const b = window.Senate && Senate.nextBill();
    el.textContent = b ? `Next on the floor: ${b.title}` : "No bill on the floor yet.";
  },
  forceSenateVote() {
    if (!window.Senate) return;
    const bill = Senate.forceResolveNext();           // resolves now + emits "senateVote" (chamber is still closed → just a toast)
    if (!bill) { if (window.UI) UI.toast("No bill on the floor.", "warn"); return this.refreshSenateDev(); }
    this.r.modal.classList.add("hidden");             // get the panel out of the way
    Senate.openChamber();
    Senate._showVote(bill);                           // play the staggered roll-call for the bill we just resolved
    Senate._startLoop();
    this.refreshSenateDev();
  },

  // dev: bump the shared reset epoch — every player (guests included) wipes once on next load
  async issueGlobalReset() {
    if (!(window.Cloud && Cloud.isAdmin() && Cloud.client)) { if (window.UI) UI.toast("Cloud + admin required.", "warn"); return; }
    if (!confirm("Issue a GLOBAL reset to EVERY player (guests included)?\n\nOn their next load, everyone's credits become 5,000 and all owned assets (stocks, ships, industries, accessories) are wiped. The senate is kept. This cannot be undone.\n\nSigned-in players need docs/sql/reset_save.sql applied (app_world_reset_apply) — without it their authoritative save is left untouched and the reset re-tries on every load.")) return;
    const status = this.r.devResetStatus;
    if (status) status.textContent = "Issuing…";
    try {
      const { data, error } = await Cloud.client.from("world_reset").select("epoch").eq("id", 1).maybeSingle();
      if (error) throw error;
      const next = ((data && Number(data.epoch)) || 0) + 1;
      const up = await Cloud.client.from("world_reset")
        .upsert({ id: 1, epoch: next, note: "admin global reset", updated_at: new Date().toISOString() }, { onConflict: "id" });
      if (up.error) throw up.error;
      if (status) status.textContent = `✓ Global reset issued (epoch ${next}). Every player resets on their next load.`;
      if (window.UI) UI.toast(`Global reset issued (epoch ${next}).`, "good", 6000);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (status) status.textContent = "✗ " + msg;
      if (window.UI) UI.toast(/relation|does not exist|not found/i.test(msg) ? "Create the world_reset table first (docs/ADMIN_SETUP.md)." : "Reset failed: " + msg, "warn", 6000);
    }
  },

  populate() {
    if (!this.r.select || !window.Content) return;
    const groups = Content.COLLECTIONS.reduce((m, c) => ((m[c.group] ||= []).push(c), m), {});
    const labels = { flavor: "Flavor (text)", data: "Items & rules (data)" };
    this.r.select.innerHTML = Object.keys(groups).map(g =>
      `<optgroup label="${labels[g] || g}">` +
      groups[g].map(c => `<option value="${c.key}">${c.label}</option>`).join("") +
      `</optgroup>`).join("");
  },

  // ===== content editor ====================================================
  openCollection(key) {
    this.key = key;
    if (this.r.raw) this.r.raw.checked = false;
    this.renderEditor(window[key]);
    const m = Content.meta(key);
    this.setStatus(m && m.group === "data" ? "Item/rule edits apply after a reload." : "Flavor edits apply live once saved.", "");
  },

  // ---- shape detection ----
  isPlain(v) { return v && typeof v === "object" && !Array.isArray(v); },
  shapeOf(v) {
    if (Array.isArray(v)) {
      if (v.length && v.every(x => typeof x === "string")) return "lines";
      if (v.length && v.every(x => this.isPlain(x))) return "table";   // nested fields ok (rendered as JSON cells)
      return "json";
    }
    if (this.isPlain(v)) {
      const vals = Object.values(v);
      if (vals.length && vals.every(a => Array.isArray(a) && a.every(s => typeof s === "string"))) return "groups";
      if (vals.length && vals.every(a => Array.isArray(a) && a.length && a.every(o => this.isPlain(o)))) return "tables";
      return "json";
    }
    return "json";
  },

  renderEditor(value) {
    const host = this.r.editor; host.innerHTML = "";
    const kind = this.r.raw.checked ? "json" : this.shapeOf(value);
    this.kind = kind;
    if (kind === "json") return host.append(this.renderJSON(value));
    if (kind === "lines") return host.append(this.renderLines(value));
    if (kind === "groups") return host.append(this.renderGroups(value));
    if (kind === "table") return host.append(this.renderTable(value));
    if (kind === "tables") {
      for (const k of Object.keys(value)) {
        host.append(this.el("div", { class: "admin-subhead", text: k }));
        host.append(this.renderTable(value[k], k));
      }
    }
  },

  renderJSON(value) {
    return this.el("textarea", { class: "admin-json", id: "admin-json", spellcheck: "false", rows: 18, value: JSON.stringify(value, null, 2) });
  },

  renderLines(arr) {
    const wrap = this.el("div", { class: "admin-lines-wrap" });
    const ta = this.el("textarea", { class: "admin-json admin-lines", spellcheck: "false", rows: 16, value: arr.join("\n") });
    wrap.append(this.el("p", { class: "admin-hint", text: "One entry per line." }), ta);
    return wrap;
  },

  renderGroups(obj) {
    const wrap = this.el("div", { class: "admin-groups" });
    for (const k of Object.keys(obj)) {
      const ta = this.el("textarea", { class: "admin-json admin-group", spellcheck: "false", rows: 5, value: obj[k].join("\n") });
      ta.dataset.key = k;
      wrap.append(this.el("label", { class: "admin-group-label", text: k }), ta);
    }
    return wrap;
  },

  // one editable table for an array of flat objects
  renderTable(arr, shipKey) {
    const cols = [];
    for (const item of arr) for (const k of Object.keys(item)) if (!cols.find(c => c.name === k)) {
      const sample = arr.find(o => o[k] !== undefined)[k];
      const type = typeof sample === "number" ? "number"
        : typeof sample === "boolean" ? "boolean"
        : (sample !== null && typeof sample === "object") ? "json" : "string";
      cols.push({ name: k, type });
    }
    const table = this.el("table", { class: "admin-table" });
    table._cols = cols; table._shipKey = shipKey || "";
    const head = this.el("tr", {}, cols.map(c => this.el("th", { text: c.name })).concat(this.el("th", { text: "" })));
    table.append(this.el("thead", {}, head));
    const body = this.el("tbody");
    arr.forEach(item => body.append(this.tableRow(cols, item)));
    table.append(body);
    const add = this.el("button", { class: "btn btn-mini", text: "+ row", onclick: () => body.append(this.tableRow(cols, {})) });
    const box = this.el("div", { class: "admin-table-wrap" }, [table]);
    box.append(add);
    return box;
  },
  tableRow(cols, item) {
    const tr = this.el("tr");
    for (const c of cols) {
      const v = item[c.name];
      let input;
      if (c.type === "boolean") input = this.el("input", { type: "checkbox", checked: !!v });
      else if (c.type === "number") input = this.el("input", { type: "number", step: "any", value: v == null ? "" : v });
      else if (c.type === "json") input = this.el("textarea", { rows: 2, class: "admin-jsoncell", value: v == null ? "" : JSON.stringify(v) });
      else if (typeof v === "string" && v.length > 42) input = this.el("textarea", { rows: 2, value: v });
      else input = this.el("input", { type: "text", value: v == null ? "" : String(v) });
      input.dataset.col = c.name; input.dataset.type = c.type;
      tr.append(this.el("td", {}, input));
    }
    tr.append(this.el("td", {}, this.el("button", { class: "admin-x", text: "✕", onclick: () => tr.remove() })));
    return tr;
  },

  // ---- read the editor back into a JS value ----
  collect() {
    if (this.kind === "json") return JSON.parse(this.r.editor.querySelector("textarea").value);
    if (this.kind === "lines") return this.r.editor.querySelector(".admin-lines").value.split("\n").filter(s => s.trim().length);
    if (this.kind === "groups") {
      const out = {};
      this.r.editor.querySelectorAll(".admin-group").forEach(ta => { out[ta.dataset.key] = ta.value.split("\n").filter(s => s.trim().length); });
      return out;
    }
    if (this.kind === "table") return this.readTable(this.r.editor.querySelector(".admin-table"));
    if (this.kind === "tables") {
      const out = {};
      this.r.editor.querySelectorAll(".admin-table").forEach(t => { out[t._shipKey] = this.readTable(t); });
      return out;
    }
  },
  readTable(table) {
    const cols = table._cols;
    return [...table.querySelectorAll("tbody tr")].map(tr => {
      const obj = {};
      tr.querySelectorAll("[data-col]").forEach(inp => {
        const c = inp.dataset.col, t = inp.dataset.type;
        if (t === "boolean") obj[c] = inp.checked;
        else if (t === "number") { const n = parseFloat(inp.value); obj[c] = isNaN(n) ? 0 : n; }
        else if (t === "json") {
          const s = inp.value.trim();
          if (!s) obj[c] = null;
          else { try { obj[c] = JSON.parse(s); } catch (e) { throw new Error(`Row field "${c}": ${e.message}`); } }
        }
        else obj[c] = inp.value;
      });
      return obj;
    });
  },
  tryCollect() { try { return this.collect(); } catch (e) { this.setStatus("✗ " + e.message, "bad"); return undefined; } },

  validate() {
    try { const v = this.collect(); this.setStatus("✓ Valid (" + (Array.isArray(v) ? v.length + " entries" : "ok") + ").", "good"); return v; }
    catch (e) { this.setStatus("✗ " + e.message, "bad"); return undefined; }
  },

  async doSave() {
    let value; try { value = this.collect(); } catch (e) { return this.setStatus("✗ " + e.message, "bad"); }
    this.setStatus("Saving…", "");
    try {
      await Content.save(this.key, value);
      const m = Content.meta(this.key);
      this.setStatus(m && m.group === "data" ? "✓ Saved. Reload to apply everywhere." : "✓ Saved & applied live.", "good");
      if (window.UI) UI.toast(`Saved "${m ? m.label : this.key}".`, "good");
    } catch (e) { this.setStatus("✗ " + (e.message || e), "bad"); }
  },
  async doReset() {
    if (!confirm("Reset this collection to the built-in default? Your saved override is removed.")) return;
    try { await Content.reset(this.key); this.r.raw.checked = false; this.openCollection(this.key); this.setStatus("✓ Reset to default.", "good"); }
    catch (e) { this.setStatus("✗ " + (e.message || e), "bad"); }
  },

  setStatus(msg, kind) {
    if (!this.r.status) return;
    this.r.status.textContent = msg;
    this.r.status.className = "admin-status" + (kind ? " " + kind : "");
  },

  // ===== image manager =====================================================
  slots() {
    const races = Object.keys(RACES);
    const nebulae = [...new Set(SECTORS.map(s => s.nebula))];
    const range = n => Array.from({ length: n }, (_, i) => String(i));
    const escorts = (SHIP_CATALOG.escort || []).map(s => s.id);
    // Every fleet hull the player can end up owning (bought, hired or crafted) —
    // mains have their own "Ship hulls" slot and never appear in the yard.
    const yardHulls = [...(SHIP_CATALOG.transport || []), ...(SHIP_CATALOG.escort || []),
      ...(SHIP_CATALOG.survey || [])].map(s => s.id);
    return [
      { group: "Character portraits", cat: "portrait", items: range(CONFIG.portraitCount), url: i => ASSET.portrait(+i) },
      { group: "Ship hulls", cat: "ship", items: ["shuttle", "hauler", "freighter", "leviathan"], url: s => ASSET.ship(s) },
      { group: "Race ships (escorts)", cat: "raceship", items: races, url: r => ASSET.raceship(r) },
      { group: "Planets", cat: "planet", items: PLANET_TYPES, url: t => ASSET.planet(t) },
      { group: "Stars", cat: "star", items: STAR_TYPES, url: t => ASSET.star(t) },
      { group: "Stations", cat: "station", items: races, url: r => ASSET.station(r) },
      { group: "Commodities", cat: "commodity", items: COMMODITIES.map(c => c.id), url: id => ASSET.commodity(id) },
      { group: "Nebulae", cat: "nebula", items: nebulae, url: n => ASSET.nebula(n) },
      { group: "Broadcast screens (pools)", cat: "broadcast", items: ["news", "tv_drama", "tv_ads", "tv_weather"],
        url: n => ASSET.broadcast(n, "preview"), pool: true, flavored: true,
        hint: "Add PNG/JPG/GIF frames per channel. Optional title/caption override Alien TV defaults; GIFs animate on the Broadcast screen." },
      { group: "Page backgrounds (1920×1080)", cat: "pagebg",
        items: (window.PAGE_BG_PAGES || []).map(p => p.id),
        url: id => ASSET.pageBg(id) || "",
        label: id => ((window.PAGE_BG_PAGES || []).find(p => p.id === id) || {}).label || id,
        hint: "One image per nav tab. Stretched into a 1920×1080 frame behind that page's UI. Hub is background-only." },
      { group: "Hub — character & stations", cat: "hub", items: ["player"].concat((window.HUB_PROPS || []).map(p => p.id)), url: id => ASSET.hub(id) },
      // Bazaar content — pools for randomized gear; single PNG for fixed types.
      { group: "Gear kinds (pools)", cat: "accessory", items: Object.keys(ACCESSORY_KINDS),
        url: k => ASSET.accessory(k, "preview"), pool: true,
        hint: "Each reactor/shield/… rolls a random PNG from its pool." },
      { group: "Ships (pools)", cat: "shipart", items: yardHulls,
        url: id => ASSET.shipArt(id, "preview"), pool: true,
        label: id => ((window.ALL_SHIPS || []).find(s => s.id === id) || {}).name || id,
        hint: "Per-hull art for the Bazaar shelf and the Fleet card. Each ship on the shelf picks one image from its hull's pool and keeps it after you buy it. Empty pool = the shared class sprite, as before." },
      { group: "Blackboxes (pools)", cat: "blackbox", items: (window.BLACKBOX_EFFECTS || []).map(e => e.id),
        url: id => ASSET.blackbox(id, "preview"), pool: true,
        label: id => ((window.BLACKBOX_EFFECTS || []).find(e => e.id === id) || {}).name || id,
        hint: "One pool per blackbox effect — shown in the Bazaar and in Inventory. Empty pool falls back to the shared Gear-kind 'blackbox' art." },
      { group: "Blueprints (pools)", cat: "blueprint", items: (window.BLUEPRINTS || []).map(b => b.id),
        url: id => ASSET.blueprint(id, "preview"), pool: true,
        label: id => ((window.BLUEPRINTS || []).find(b => b.id === id) || {}).name || id,
        hint: "One pool per blueprint. Empty pool falls back to the shared Gear-kind 'blueprint' art." },
      { group: "Extractors (pools)", cat: "extractor", items: Object.keys(EXTRACTORCFG.types),
        url: t => ASSET.extractor(t, "preview"), pool: true },
      { group: "Components (pools)", cat: "component", items: Object.keys(COMPONENTCFG.kinds),
        url: k => ASSET.component(k, "preview"), pool: true },
      { group: "Contracts", cat: "contract",
        items: ["transport", "escort", "combat", "smuggle", "assassinate", "tip"],
        url: t => ASSET.contract(t) },
      { group: "Mercenaries (pools)", cat: "merc", items: escorts,
        url: t => ASSET.merc(t, "preview"), pool: true,
        hint: "Optional — falls back to the escort ship sprite when empty." },
    ];
  },

  buildGallery() {
    if (!this.r.gallery) return;
    if (this.imgCat == null) this.imgCat = 0;
    const slots = this.slots();
    if (this.imgCat >= slots.length) this.imgCat = 0;
    const active = slots[this.imgCat];
    this.r.imgNote.textContent = active.pool
      ? (active.flavored
        ? "Broadcast pools: add PNG/JPG/GIF frames. Leave flavor blank to use Alien TV Show defaults. Stored in Supabase 'sprites'."
        : "Pool slots: add multiple images — randomized items (reactors, etc.) pick one from the pool. Stored in Supabase 'sprites'.")
      : "Upload a PNG/JPG/GIF to replace any sprite (stored in your Supabase 'sprites' bucket — see docs/ADMIN_SETUP.md).";
    if (active.hint) this.r.imgNote.textContent += " " + active.hint;
    // category sub-tabs
    this.r.imgTabs.innerHTML = "";
    slots.forEach((slot, i) => {
      this.r.imgTabs.append(this.el("button", {
        class: "admin-imgtab" + (i === this.imgCat ? " active" : ""),
        text: slot.group, onclick: () => { this.imgCat = i; this.buildGallery(); },
      }));
    });
    // just the active category's grid (scrolls on its own)
    this.r.gallery.innerHTML = "";
    this.r.gallery.append(active.pool ? this.renderPoolGrid(active) : this.renderImageGrid(active));
  },

  renderImageGrid(slot) {
    const grid = this.el("div", { class: "admin-grid" });
    for (const item of slot.items) {
      const key = `${slot.cat}:${item}`;
      const overridden = !!ASSET_OVERRIDES[key];
      const name = slot.label ? slot.label(item) : String(item);
      const src = slot.url(item);
      const img = src
        ? this.el("img", { class: "admin-thumb", src, alt: name })
        : this.el("div", { class: "admin-thumb tintbox", text: "—" });
      if (src) img.onerror = () => { img.replaceWith(this.el("div", { class: "admin-thumb tintbox", text: String(name).slice(0, 2) })); };
      const file = this.el("input", { type: "file", accept: "image/*", class: "hidden" });
      file.onchange = () => { if (file.files[0]) this.upload(slot.cat, item, file.files[0]); };
      const card = this.el("div", { class: "admin-card" + (overridden ? " custom" : "") }, [
        img,
        this.el("div", { class: "admin-card-name", text: name }),
        this.el("button", { class: "btn btn-mini", text: overridden ? "Replace" : "Upload", onclick: () => file.click() }),
      ]);
      if (overridden) card.append(this.el("button", { class: "btn btn-mini admin-card-reset", text: "Reset", onclick: () => this.resetSlot(slot.cat, item) }));
      card.append(file);
      grid.append(card);
    }
    return grid;
  },

  // Pool slots: each kind (reactor, specialized, …) holds 0..N images.
  // Broadcast pools may store { url, title?, caption? }; gear pools stay URL strings.
  _poolEntries(key) {
    const cur = ASSET_OVERRIDES[key];
    if (Array.isArray(cur)) return cur.slice();
    if (typeof cur === "string" && cur) return [cur];
    if (cur && typeof cur === "object" && cur.url) return [cur];
    return [];
  },
  _poolUrl(entry) { return typeof entry === "string" ? entry : ((entry && entry.url) || ""); },
  renderPoolGrid(slot) {
    const grid = this.el("div", { class: "admin-grid admin-pool-grid" + (slot.flavored ? " admin-pool-flavored" : "") });
    for (const item of slot.items) {
      const key = `${slot.cat}:${item}`;
      const name = slot.label ? slot.label(item) : String(item);
      const entries = this._poolEntries(key);
      const thumbs = this.el("div", { class: "admin-pool-thumbs" });
      if (!entries.length) {
        const ph = this.el("div", { class: "admin-thumb tintbox", text: name.slice(0, 2) });
        thumbs.append(ph);
      } else {
        entries.forEach((entry, i) => {
          const url = this._poolUrl(entry);
          const meta = (typeof entry === "object" && entry) ? entry : { url };
          const wrap = this.el("div", { class: "admin-pool-one" + (slot.flavored ? " flavored" : "") });
          const img = this.el("img", { class: "admin-thumb", src: url, alt: `${item}-${i}` });
          img.onerror = () => { img.replaceWith(this.el("div", { class: "admin-thumb tintbox", text: "?" })); };
          wrap.append(img);
          wrap.append(this.el("button", {
            class: "btn btn-mini admin-card-reset", text: "✕",
            onclick: () => this.removeFromPool(slot.cat, item, i),
          }));
          if (slot.flavored) {
            const title = this.el("input", {
              class: "admin-pool-flavor", type: "text", placeholder: "Title (optional)",
              value: meta.title || "",
            });
            const caption = this.el("input", {
              class: "admin-pool-flavor", type: "text", placeholder: "Caption (optional — Alien TV default if blank)",
              value: meta.caption || "",
            });
            const save = () => this.savePoolFlavor(slot.cat, item, i, title.value, caption.value);
            title.onchange = save; caption.onchange = save;
            wrap.append(title, caption);
          }
          thumbs.append(wrap);
        });
      }
      const file = this.el("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp,image/*", class: "hidden", multiple: true });
      file.onchange = () => { if (file.files && file.files.length) this.uploadPool(slot.cat, item, file.files); };
      const card = this.el("div", { class: "admin-card admin-pool-card" + (entries.length ? " custom" : "") }, [
        thumbs,
        this.el("div", { class: "admin-card-name", text: `${name} (${entries.length} in pool)` }),
        this.el("button", { class: "btn btn-mini", text: slot.flavored ? "Add image" : "Add PNG", onclick: () => file.click() }),
      ]);
      if (entries.length) card.append(this.el("button", { class: "btn btn-mini admin-card-reset", text: "Clear pool", onclick: () => this.resetSlot(slot.cat, item) }));
      card.append(file);
      grid.append(card);
    }
    return grid;
  },

  async savePoolFlavor(cat, item, index, title, caption) {
    if (!Cloud.isAdmin()) return;
    const key = `${cat}:${item}`;
    const arr = this._poolEntries(key);
    if (index < 0 || index >= arr.length) return;
    const url = this._poolUrl(arr[index]); if (!url) return;
    const t = String(title || "").trim(), c = String(caption || "").trim();
    // Keep plain URL strings when there's no flavor (smaller save blob).
    arr[index] = (t || c) ? { url, title: t, caption: c } : url;
    ASSET_OVERRIDES[key] = arr;
    try {
      await Content.save("ASSET_OVERRIDES", { ...ASSET_OVERRIDES });
      UI.toast("Flavor saved.", "good");
    } catch (e) { UI.toast("Save failed: " + ((e && e.message) || e), "warn"); }
  },

  // Shared upload used by both the gallery and the in-context uploaders (planet
  // popup, system background). Uploads to the Supabase 'sprites' bucket, records
  // the URL in ASSET_OVERRIDES (key `cat:item`) and persists it. Returns the URL.
  async uploadSprite(cat, item, file) {
    if (!window.Cloud || !Cloud.isAdmin()) throw new Error("Admins only.");
    if (!(Cloud.client && Cloud.client.storage)) throw new Error("Storage SDK unavailable.");
    const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
    const path = `${cat}/${item}.${ext}`;
    const up = await Cloud.client.storage.from("sprites").upload(path, file, { upsert: true, contentType: file.type || "image/png" });
    if (up.error) throw up.error;
    const pub = Cloud.client.storage.from("sprites").getPublicUrl(path);
    const url = pub.data.publicUrl + "?t=" + Date.now();
    ASSET_OVERRIDES[`${cat}:${item}`] = url;
    await Content.save("ASSET_OVERRIDES", { ...ASSET_OVERRIDES });
    return url;
  },
  // Append one or more images to a pool key (array in ASSET_OVERRIDES).
  // Entries are URL strings; broadcast flavor is edited after upload.
  async uploadSpriteToPool(cat, item, file) {
    if (!window.Cloud || !Cloud.isAdmin()) throw new Error("Admins only.");
    if (!(Cloud.client && Cloud.client.storage)) throw new Error("Storage SDK unavailable.");
    const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
    const path = `${cat}/${item}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
    const up = await Cloud.client.storage.from("sprites").upload(path, file, { upsert: true, contentType: file.type || "image/png" });
    if (up.error) throw up.error;
    const pub = Cloud.client.storage.from("sprites").getPublicUrl(path);
    const url = pub.data.publicUrl + "?t=" + Date.now();
    const key = `${cat}:${item}`;
    const arr = this._poolEntries(key);
    arr.push(url);
    ASSET_OVERRIDES[key] = arr;
    await Content.save("ASSET_OVERRIDES", { ...ASSET_OVERRIDES });
    return url;
  },
  async resetSprite(cat, item) {
    if (!window.Cloud || !Cloud.isAdmin()) throw new Error("Admins only.");
    delete ASSET_OVERRIDES[`${cat}:${item}`];
    await Content.save("ASSET_OVERRIDES", { ...ASSET_OVERRIDES });
  },
  async removeFromPool(cat, item, index) {
    if (!Cloud.isAdmin()) return;
    const key = `${cat}:${item}`;
    const arr = this._poolEntries(key);
    if (index < 0 || index >= arr.length) return;
    arr.splice(index, 1);
    if (arr.length) ASSET_OVERRIDES[key] = arr; else delete ASSET_OVERRIDES[key];
    try {
      await Content.save("ASSET_OVERRIDES", { ...ASSET_OVERRIDES });
      UI.toast("Removed from pool.", "info");
      this.buildGallery();
    } catch (e) { UI.toast("Remove failed: " + ((e && e.message) || e), "warn"); }
  },

  async upload(cat, item, file) {
    if (!Cloud.isAdmin()) return;
    if (!Cloud.client.storage) return UI.toast("Storage SDK unavailable.", "warn");
    UI.toast("Uploading…", "info");
    try {
      await this.uploadSprite(cat, item, file);
      UI.toast(cat === "pagebg" ? "Page background updated." : "Sprite updated. Reload to see it everywhere.", "good");
      this.buildGallery();
      if (cat === "pagebg" && window.UI && typeof UI.applyPageBg === "function") UI.applyPageBg();
    } catch (e) {
      const msg = (e && e.message) || String(e);
      UI.toast(/bucket|not found/i.test(msg) ? "Create a public 'sprites' bucket first (see ADMIN_SETUP)." : "Upload failed: " + msg, "warn", 5000);
    }
  },
  async uploadPool(cat, item, files) {
    if (!Cloud.isAdmin()) return;
    if (!Cloud.client.storage) return UI.toast("Storage SDK unavailable.", "warn");
    UI.toast(`Uploading ${files.length}…`, "info");
    try {
      for (const f of files) await this.uploadSpriteToPool(cat, item, f);
      UI.toast("Added to pool.", "good");
      this.buildGallery();
    } catch (e) {
      const msg = (e && e.message) || String(e);
      UI.toast(/bucket|not found/i.test(msg) ? "Create a public 'sprites' bucket first (see ADMIN_SETUP)." : "Upload failed: " + msg, "warn", 5000);
    }
  },
  async resetSlot(cat, item) {
    try {
      await this.resetSprite(cat, item);
      UI.toast(cat === "pagebg" ? "Page background cleared." : "Reverted to default sprite. Reload to apply.", "good");
      this.buildGallery();
      if (cat === "pagebg" && window.UI && typeof UI.applyPageBg === "function") UI.applyPageBg();
    } catch (e) { UI.toast("Reset failed: " + ((e && e.message) || e), "warn"); }
  },

  // ===== background music ==================================================
  MAX_BGM_BYTES: 8 * 1024 * 1024,   // 8 MB — keeps first-load playlist light
  setMusicStatus(msg, kind) {
    const e = this.r.musicStatus; if (!e) return;
    e.textContent = msg || ""; e.className = "admin-status" + (kind ? " " + kind : "");
  },
  _musicList() {
    if (!Array.isArray(window.BGM_PLAYLIST)) window.BGM_PLAYLIST = [];
    return window.BGM_PLAYLIST;
  },
  buildMusic() {
    const host = this.r.musicList; if (!host) return;
    host.innerHTML = "";
    const list = this._musicList();
    if (!list.length) {
      host.append(this.el("p", { class: "admin-mhint", text: "No songs yet — click “+ Add song” to upload one." }));
      return;
    }
    list.forEach((track, i) => {
      const name = this.el("input", {
        class: "admin-music-name", type: "text", value: track.name || `Track ${i + 1}`,
        onchange: () => this.renameMusicTrack(i, name.value),
      });
      const row = this.el("div", { class: "admin-music-row" }, [
        this.el("span", { class: "admin-music-idx", text: String(i + 1) }),
        name,
        this.el("audio", { class: "admin-music-preview", controls: "controls", preload: "none", src: track.url || "" }),
        this.el("button", { class: "btn btn-mini", text: "↑", title: "Move up",
          onclick: () => this.moveMusicTrack(i, -1) }),
        this.el("button", { class: "btn btn-mini", text: "↓", title: "Move down",
          onclick: () => this.moveMusicTrack(i, 1) }),
        this.el("button", { class: "btn btn-mini admin-card-reset", text: "✕",
          onclick: () => this.removeMusicTrack(i) }),
      ]);
      host.append(row);
    });
  },
  // Save a NEW array only — never mutate the live list before Content.save resolves.
  // Content.apply (inside save) updates BGM_PLAYLIST + Bgm.sync().
  async _saveMusic(next) {
    await Content.save("BGM_PLAYLIST", next.slice());
  },
  async uploadMusicTrack(file) {
    if (!Cloud.isAdmin()) return;
    if (!(Cloud.client && Cloud.client.storage)) return this.setMusicStatus("Storage SDK unavailable.", "bad");
    if (file.size > this.MAX_BGM_BYTES) return this.setMusicStatus("File too large (max 8 MB).", "bad");
    this.setMusicStatus("Uploading…");
    try {
      const ext = (file.name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp3";
      const path = `bgm/${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
      const up = await Cloud.client.storage.from("sprites").upload(path, file, {
        upsert: false, contentType: file.type || "audio/mpeg",
      });
      if (up.error) throw up.error;
      const pub = Cloud.client.storage.from("sprites").getPublicUrl(path);
      const url = pub.data.publicUrl + "?t=" + Date.now();
      const name = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Track";
      await this._saveMusic(this._musicList().concat([{ url, name }]));
      this.setMusicStatus("Song added — all players will hear it.", "good");
      this.buildMusic();
    } catch (e) {
      const msg = (e && e.message) || String(e);
      this.setMusicStatus(/bucket|not found/i.test(msg)
        ? "Create a public 'sprites' bucket first (see ADMIN_SETUP)."
        : "Upload failed: " + msg, "bad");
    }
  },
  async renameMusicTrack(index, name) {
    if (!Cloud.isAdmin()) return;
    const list = this._musicList();
    if (index < 0 || index >= list.length) return;
    const next = list.map((t, i) => i === index
      ? { ...t, name: String(name || "").trim() || `Track ${index + 1}` } : t);
    try {
      await this._saveMusic(next);
      this.setMusicStatus("Renamed.", "good");
    } catch (e) { this.setMusicStatus("Save failed: " + ((e && e.message) || e), "bad"); this.buildMusic(); }
  },
  async moveMusicTrack(index, dir) {
    if (!Cloud.isAdmin()) return;
    const list = this._musicList();
    const j = index + dir;
    if (index < 0 || index >= list.length || j < 0 || j >= list.length) return;
    const next = list.slice();
    const tmp = next[index]; next[index] = next[j]; next[j] = tmp;
    try {
      await this._saveMusic(next);
      this.buildMusic();
      this.setMusicStatus("Order updated.", "good");
    } catch (e) { this.setMusicStatus("Save failed: " + ((e && e.message) || e), "bad"); }
  },
  async removeMusicTrack(index) {
    if (!Cloud.isAdmin()) return;
    const list = this._musicList();
    if (index < 0 || index >= list.length) return;
    if (!confirm(`Remove “${list[index].name || "this track"}” from the playlist?`)) return;
    const next = list.filter((_, i) => i !== index);
    try {
      await this._saveMusic(next);
      this.buildMusic();
      this.setMusicStatus("Removed.", "good");
    } catch (e) { this.setMusicStatus("Remove failed: " + ((e && e.message) || e), "bad"); }
  },

  // ===== missions editor ===================================================
  // Custom missions are full declarative data (STORY_CUSTOM). Built-ins keep
  // their JS triggers/flags but admins can overlay copy via STORY_OVERRIDES.
  setMStatus(msg, kind) { const e = this.r.mStatus; if (!e) return; e.textContent = msg; e.className = "admin-status" + (kind ? " " + kind : ""); },
  _customList() { if (!Array.isArray(window.STORY_CUSTOM)) window.STORY_CUSTOM = []; return window.STORY_CUSTOM; },
  _overrides() { if (!window.STORY_OVERRIDES || typeof window.STORY_OVERRIDES !== "object") window.STORY_OVERRIDES = {}; return window.STORY_OVERRIDES; },

  buildMissions() { this._showMissionList(); },
  _showMissionList() {
    this.mDraft = null; this.mIndex = -1; this.mBuiltinId = null;
    this.r.mDetail.classList.add("hidden"); this.r.mDetail.innerHTML = "";
    this.r.mList.classList.remove("hidden");
    if (this.r.mListActions) this.r.mListActions.classList.remove("hidden");
    this.setMStatus("", "");
    const list = this.r.mList; list.innerHTML = "";
    const custom = this._customList();
    list.append(this.el("h4", { class: "admin-subhead", text: "Your missions" }));
    if (!custom.length) list.append(this.el("p", { class: "admin-mhint", text: "None yet — click “+ New mission” below." }));
    custom.forEach((sl, i) => list.append(this._missionCard(sl, true, i)));
    list.append(this.el("h4", { class: "admin-subhead", text: "Built-in missions (edit text)" }));
    list.append(this.el("p", { class: "admin-mhint", text: "Triggers & branching stay in code — edit the dialogue copy here. Saves as STORY_OVERRIDES for every player." }));
    (window.STORYLINES || []).forEach(sl => list.append(this._missionCard(sl, false)));
  },
  _missionCard(sl, custom, i) {
    const steps = (sl.steps || []).length;
    const ov = !custom && this._overrides()[sl.id];
    const head = this.el("div", { class: "admin-mcard-head" }, [
      this.el("span", { class: "admin-mbadge", text: sl.kind === "arc" ? "ARC" : "JOB" }),
      this.el("strong", { text: (ov && ov.from) || sl.from || "(no sender)" }),
      this.el("span", { class: "admin-mtag " + (custom ? "is-custom" : "is-builtin"), text: custom ? "custom" : (ov ? "built-in · edited" : "built-in") }),
    ]);
    const meta = this.el("div", { class: "admin-mcard-meta", text: `id: ${sl.id} · ${steps} step${steps === 1 ? "" : "s"}` });
    const actions = this.el("div", { class: "admin-mcard-actions" });
    if (custom) {
      actions.append(this.el("button", { class: "btn btn-mini", text: "Edit", onclick: () => this.editMission(i) }));
      actions.append(this.el("button", { class: "btn btn-mini btn-danger", text: "Delete", onclick: () => this.deleteMission(i) }));
    } else {
      actions.append(this.el("button", { class: "btn btn-mini btn-go", text: "Edit text", onclick: () => this.editBuiltinText(sl.id) }));
      actions.append(this.el("button", { class: "btn btn-mini", text: "Preview", onclick: () => this.previewMission(Story.storyline(sl.id) || sl) }));
      if (ov) actions.append(this.el("button", { class: "btn btn-mini btn-danger", text: "Reset text", onclick: () => this.resetBuiltinText(sl.id) }));
    }
    return this.el("div", { class: "admin-mission-card" }, [head, meta, actions]);
  },

  newMission() { this.setView("missions"); this.mIndex = -1; this.mDraft = this._toDraft({ kind: "job" }); this._openEditor(); },
  editMission(i) { const sl = this._customList()[i]; if (!sl) return; this.mIndex = i; this.mDraft = this._toDraft(sl); this._openEditor(); },
  _openEditor() {
    this.r.mList.classList.add("hidden");
    if (this.r.mListActions) this.r.mListActions.classList.add("hidden");
    this.r.mDetail.classList.remove("hidden");
    this.setMStatus("", "");
    this.renderMissionEditor();
  },

  // ---- built-in text overlays (STORY_OVERRIDES) ---------------------------
  editBuiltinText(id) {
    const base = (window.STORYLINES || []).find(s => s.id === id); if (!base) return;
    const live = Story.storyline(id) || base;
    this.mBuiltinId = id;
    this.r.mList.classList.add("hidden");
    if (this.r.mListActions) this.r.mListActions.classList.add("hidden");
    const d = this.r.mDetail; d.classList.remove("hidden"); d.innerHTML = "";
    d.append(this.el("div", { class: "admin-mission-toolbar" }, [
      this.el("button", { class: "btn btn-mini", text: "← Back", onclick: () => this._showMissionList() }),
      this.el("strong", { text: `Edit text — ${id}` }),
    ]));
    d.append(this.el("p", { class: "admin-mhint", text: "Triggers, flags, and rewards stay in code. Change the words players read." }));

    const fromInp = this.el("input", { class: "admin-input", value: live.from || "" });
    const outroInp = this.el("textarea", { class: "admin-textarea", rows: 2 }); outroInp.value = live.outro || "";
    d.append(this.el("label", { class: "admin-field", text: "Sender name" })); d.append(fromInp);
    d.append(this.el("label", { class: "admin-field", text: "Outro" })); d.append(outroInp);

    const stepEditors = (live.steps || []).map((step, i) => {
      const box = this.el("div", { class: "admin-step" });
      box.append(this.el("div", { class: "admin-step-head" }, [
        this.el("span", { class: "admin-step-num", text: `Step ${i + 1}${step.key ? " · " + step.key : ""}${step.choices ? " · choice" : step.goal ? " · objective" : " · info"}` }),
      ]));
      const textA = this.el("textarea", { class: "admin-textarea", rows: 3 }); textA.value = step.text || "";
      box.append(this.el("label", { class: "admin-field", text: "Inbound message" })); box.append(textA);
      let goalInp = null;
      if (step.goal) {
        goalInp = this.el("input", { class: "admin-input", value: step.goal.desc || "" });
        box.append(this.el("label", { class: "admin-field", text: "Objective description" })); box.append(goalInp);
      }
      const choiceInps = [];
      if (step.choices) {
        step.choices.forEach((c, ci) => {
          const lab = this.el("input", { class: "admin-input", value: c.label || "" });
          const rep = this.el("input", { class: "admin-input", value: c.reply || "" });
          const ack = this.el("input", { class: "admin-input", value: c.ack || "" });
          box.append(this.el("label", { class: "admin-field", text: `Choice ${ci + 1} label` })); box.append(lab);
          box.append(this.el("label", { class: "admin-field", text: `Choice ${ci + 1} player reply` })); box.append(rep);
          box.append(this.el("label", { class: "admin-field", text: `Choice ${ci + 1} NPC ack` })); box.append(ack);
          choiceInps.push({ lab, rep, ack });
        });
      }
      const replyInps = [];
      (step.replies || []).forEach((r, ri) => {
        const label = typeof r === "string" ? r : (r.label || "");
        const ack = typeof r === "object" ? (r.ack || "") : "";
        const lab = this.el("input", { class: "admin-input", value: label });
        const ackI = this.el("input", { class: "admin-input", value: ack });
        box.append(this.el("label", { class: "admin-field", text: `Flavour reply ${ri + 1}` })); box.append(lab);
        if (ack || typeof r === "object") { box.append(this.el("label", { class: "admin-field", text: `Flavour ack ${ri + 1}` })); box.append(ackI); }
        replyInps.push({ lab, ackI, wasObj: typeof r === "object" });
      });
      d.append(box);
      return { i, key: step.key || String(i), textA, goalInp, choiceInps, replyInps, step };
    });

    const saveBtn = this.el("button", { class: "btn btn-go", text: "Save text overlay", onclick: async () => {
      const ov = { from: fromInp.value.trim(), outro: outroInp.value.trim(), steps: {} };
      for (const ed of stepEditors) {
        const sOv = { text: ed.textA.value };
        if (ed.goalInp) sOv.goal = { desc: ed.goalInp.value };
        if (ed.choiceInps.length) {
          sOv.choices = ed.choiceInps.map(c => ({ label: c.lab.value, reply: c.rep.value, ack: c.ack.value }));
        }
        if (ed.replyInps.length) {
          sOv.replies = ed.replyInps.map((r, ri) => {
            const base = ed.step.replies[ri];
            if (r.wasObj || (base && typeof base === "object")) {
              return { label: r.lab.value, reply: (base && base.reply) || r.lab.value, ack: r.ackI.value };
            }
            return r.lab.value;
          });
        }
        ov.steps[ed.key] = sOv;
      }
      const next = Object.assign({}, this._overrides(), { [id]: ov });
      this.setMStatus("Saving…", "");
      try {
        await Content.save("STORY_OVERRIDES", next);
        if (window.UI) UI.toast(`Text for “${ov.from || id}” saved.`, "good");
        this._showMissionList();
        this.setMStatus("✓ Text overlay live for every player.", "good");
      } catch (e) { this.setMStatus("✗ " + ((e && e.message) || e), "bad"); }
    }});
    d.append(this.el("div", { class: "settings-actions" }, [
      saveBtn,
      this.el("button", { class: "btn", text: "Cancel", onclick: () => this._showMissionList() }),
    ]));
  },
  async resetBuiltinText(id) {
    if (!confirm(`Reset text overrides for “${id}”? Built-in copy returns.`)) return;
    const next = Object.assign({}, this._overrides());
    delete next[id];
    try {
      await Content.save("STORY_OVERRIDES", next);
      if (window.UI) UI.toast("Built-in text restored.", "good");
      this._showMissionList();
    } catch (e) { this.setMStatus("✗ " + ((e && e.message) || e), "bad"); }
  },

  // read-only flow view for a built-in mission
  previewMission(sl) {
    this.r.mList.classList.add("hidden");
    if (this.r.mListActions) this.r.mListActions.classList.add("hidden");
    const d = this.r.mDetail; d.classList.remove("hidden"); d.innerHTML = "";
    d.append(this.el("div", { class: "admin-mission-toolbar" }, [
      this.el("button", { class: "btn btn-mini", text: "← Back", onclick: () => this._showMissionList() }),
      this.el("strong", { text: (sl.from || "") + " — " + sl.id }),
    ]));
    (sl.steps || []).forEach((s, i) => {
      const box = this.el("div", { class: "admin-step" });
      box.append(this.el("div", { class: "admin-step-head" }, [this.el("span", { class: "admin-step-num", text: "Step " + (i + 1) + (s.choices ? " · choice" : " · objective") })]));
      box.append(this.el("p", { class: "admin-mprev-text", text: s.text || "" }));
      if (s.goal) box.append(this.el("p", { class: "admin-mhint", text: "Objective: " + (s.goal.desc || "") }));
      if (s.choices) s.choices.forEach(c => box.append(this.el("p", { class: "admin-mhint", text: "▸ " + (c.label || "") + (c.reward ? "  → " + this._rewardSummary(c.reward) : "") })));
      if (s.reward) box.append(this.el("p", { class: "admin-mhint", text: "Reward: " + this._rewardSummary(s.reward) }));
      d.append(box);
    });
    d.append(this.el("div", { class: "settings-actions" }, [this.el("button", { class: "btn", text: "Back to list", onclick: () => this._showMissionList() })]));
  },
  _rewardSummary(r) {
    const b = []; if (r.credits) b.push("+" + r.credits + "c"); if (r.ship) b.push("ship:" + r.ship);
    if (r.component) b.push("component"); if (r.extractor) b.push("extractor");
    if (r.item) b.push("item:" + (r.item === true ? "random" : r.item));
    if (r.taxBreak) b.push("tax −" + Math.round((r.taxBreak.pct || 0) * 100) + "%");
    return b.join(", ") || "—";
  },

  // ---- draft model (adds UI-only helper fields _type/_gate; stripped on save)
  _blankChoice() { return { label: "", reply: "", cost: 0, reward: {}, end: true }; },
  _blankStep() {
    return { _type: "objective", _gate: false, key: "", text: "", replies: [],
      goal: { desc: "", cond: { metric: "", op: ">=", value: 0, delta: false } },
      reward: {}, accept: { label: "", reply: "", ack: "" }, decline: { label: "", reply: "", outro: "" },
      choices: [this._blankChoice()] };
  },
  _toDraft(m) {
    const d = JSON.parse(JSON.stringify(m || {}));
    d.id = d.id || ""; d.kind = d.kind === "arc" ? "arc" : "job"; d.from = d.from || ""; d.portrait = d.portrait || 0;
    d.triggerCond = d.triggerCond ? Object.assign({ metric: "", op: ">=", value: 0 }, d.triggerCond) : { metric: "", op: ">=", value: 0 };
    d.outro = d.outro || "";
    d.steps = (Array.isArray(d.steps) ? d.steps : []).map(s => this._toDraftStep(s));
    if (!d.steps.length) d.steps.push(this._blankStep());
    return d;
  },
  _toDraftStep(s) {
    s = s || {};
    const isChoice = Array.isArray(s.choices);
    const step = {
      _type: isChoice ? "choice" : "objective", _gate: !!s.accept,
      key: s.key || "", text: s.text || "",
      replies: (s.replies || []).map(r => typeof r === "string" ? r : (r.label || "")),
      goal: { desc: (s.goal && s.goal.desc) || "", cond: Object.assign({ metric: "", op: ">=", value: 0, delta: false }, s.goal && s.goal.cond) },
      reward: s.reward || {},
      accept: { label: (s.accept && s.accept.label) || "", reply: (s.accept && s.accept.reply) || "", ack: (s.accept && s.accept.ack) || "" },
      decline: { label: (s.decline && s.decline.label) || "", reply: (s.decline && s.decline.reply) || "", outro: (s.decline && s.decline.outro) || "" },
      choices: (s.choices || []).map(c => ({ label: c.label || "", reply: c.reply || "", cost: c.cost || 0, reward: c.reward || {}, end: c.end !== false })),
    };
    if (!step.choices.length) step.choices.push(this._blankChoice());
    return step;
  },

  // ---- normalize draft → clean, serializable mission ----
  _cleanCond(c) { if (!c || !c.metric) return undefined; const o = { metric: c.metric, op: c.op || ">=", value: +c.value || 0 }; if (c.delta) o.delta = true; return o; },
  _cleanReward(r) {
    if (!r) return undefined; const o = {};
    if (+r.credits) o.credits = Math.round(+r.credits);
    if (r.ship) o.ship = r.ship;
    if (r.component) o.component = true;
    if (r.extractor) o.extractor = true;
    if (r.item) o.item = (r.item === true || r.item === "true") ? true : r.item;
    if (r.taxBreak && +r.taxBreak.pct > 0) { o.taxBreak = { pct: +r.taxBreak.pct }; if (+r.taxBreak.ms > 0) o.taxBreak.ms = +r.taxBreak.ms; }
    return Object.keys(o).length ? o : undefined;
  },
  _normalizeDraft() {
    const d = this.mDraft;
    const m = { id: (d.id || "").trim(), kind: d.kind === "arc" ? "arc" : "job", from: (d.from || "").trim(), portrait: +d.portrait || 0 };
    const tc = this._cleanCond(d.triggerCond); if (tc) { delete tc.delta; m.triggerCond = tc; }
    if ((d.outro || "").trim()) m.outro = d.outro.trim();
    m.steps = d.steps.map(s => {
      const step = {};
      if ((s.key || "").trim()) step.key = s.key.trim();
      step.text = (s.text || "").trim();
      const replies = (s.replies || []).map(x => (x || "").trim()).filter(Boolean);
      if (replies.length) step.replies = replies;
      if (s._type === "choice") {
        step.choices = s.choices.map(c => {
          const ch = { label: (c.label || "").trim() };
          if ((c.reply || "").trim()) ch.reply = c.reply.trim();
          if (+c.cost) ch.cost = Math.round(+c.cost);
          const rw = this._cleanReward(c.reward); if (rw) ch.reward = rw;
          if (c.end) ch.end = true;
          return ch;
        }).filter(c => c.label);
      } else {
        step.goal = { desc: (s.goal.desc || "").trim() };
        const gc = this._cleanCond(s.goal.cond); if (gc) step.goal.cond = gc;
        const rw = this._cleanReward(s.reward); if (rw) step.reward = rw;
        if (s._gate) {
          step.accept = {}; if (s.accept.label.trim()) step.accept.label = s.accept.label.trim();
          if (s.accept.reply.trim()) step.accept.reply = s.accept.reply.trim();
          if (s.accept.ack.trim()) step.accept.ack = s.accept.ack.trim();
          step.decline = {}; if (s.decline.label.trim()) step.decline.label = s.decline.label.trim();
          if (s.decline.reply.trim()) step.decline.reply = s.decline.reply.trim();
          if (s.decline.outro.trim()) step.decline.outro = s.decline.outro.trim();
        }
      }
      return step;
    });
    return m;
  },
  _validateMission(m) {
    if (!m.id) return "Mission needs an id.";
    if (!/^[a-z0-9_]+$/i.test(m.id)) return "Id may only contain letters, numbers and underscores.";
    if ((window.STORYLINES || []).some(s => s.id === m.id)) return "That id belongs to a built-in mission — pick another.";
    if (this._customList().some((s, i) => s.id === m.id && i !== this.mIndex)) return "Another custom mission already uses that id.";
    if (!m.from) return "Give the sender a name.";
    if (!m.steps.length) return "Add at least one step.";
    for (let i = 0; i < m.steps.length; i++) {
      const s = m.steps[i];
      if (!s.text) return `Step ${i + 1}: needs an inbound message.`;
      if (s.choices) { if (!s.choices.length) return `Step ${i + 1}: add at least one choice with a label.`; }
      else if (!s.goal.desc) return `Step ${i + 1}: the objective needs a description.`;
    }
    return null;
  },

  async saveMission() {
    const m = this._normalizeDraft();
    const err = this._validateMission(m);
    if (err) return this.setMStatus("✗ " + err, "bad");
    const list = this._customList();
    const next = this.mIndex >= 0 ? list.map((s, j) => j === this.mIndex ? m : s) : list.concat([m]);
    this.setMStatus("Saving…", "");
    try {
      await Content.save("STORY_CUSTOM", next);       // applies to window.STORY_CUSTOM in place
      if (window.UI) UI.toast(`Mission “${m.from || m.id}” saved.`, "good");
      this._showMissionList();
      this.setMStatus("✓ Saved. Live for every player.", "good");
    } catch (e) { this.setMStatus("✗ " + ((e && e.message) || e), "bad"); }
  },
  async deleteMission(i) {
    const list = this._customList(); const sl = list[i]; if (!sl) return;
    if (!confirm(`Delete custom mission “${sl.from || sl.id}”? This removes it for every player.`)) return;
    const next = list.filter((_, j) => j !== i);
    try { await Content.save("STORY_CUSTOM", next); if (window.UI) UI.toast("Mission deleted.", "good"); this._showMissionList(); }
    catch (e) { this.setMStatus("✗ " + ((e && e.message) || e), "bad"); }
  },

  // ---- editor DOM ---------------------------------------------------------
  renderMissionEditor() {
    const d = this.mDraft; const host = this.r.mDetail; host.innerHTML = "";
    host.append(this.el("div", { class: "admin-mission-toolbar" }, [
      this.el("button", { class: "btn btn-mini", text: "← Back", onclick: () => this._showMissionList() }),
      this.el("strong", { text: this.mIndex >= 0 ? "Edit mission" : "New mission" }),
    ]));
    host.append(this.el("div", { class: "admin-mtop" }, [
      this.el("label", { class: "admin-mfield" }, ["Id (unique)", this._txt(d, "id", {})]),
      this.el("label", { class: "admin-mfield" }, ["Sender name", this._txt(d, "from", {})]),
      this.el("label", { class: "admin-mfield admin-mfield-sm" }, ["Portrait #", this._num(d, "portrait", { min: "0" })]),
      this.el("label", { class: "admin-mfield" }, ["Type", this._sel(d, "kind", [["job", "Job (one-off)"], ["arc", "Arc (series)"]])]),
    ]));
    host.append(this.el("div", { class: "admin-mfield" }, [
      this.el("span", { class: "admin-mlabel", text: "Arrives when… (leave blank = as soon as there’s a free inbox slot):" }),
      this._condEditor(d.triggerCond, false),
    ]));
    const steps = this.el("div", { class: "admin-steps" });
    d.steps.forEach((s, i) => steps.append(this._stepEditor(s, i)));
    host.append(steps);
    host.append(this.el("button", { class: "btn btn-mini", text: "+ Add step", onclick: () => { d.steps.push(this._blankStep()); this.renderMissionEditor(); } }));
    host.append(this.el("label", { class: "admin-mfield admin-mfield-wide" }, ["Sign-off posted when the mission ends (optional)", this._txt(d, "outro", { rows: 2 })]));
    host.append(this.el("div", { class: "settings-actions" }, [
      this.el("button", { class: "btn btn-go", text: "Save mission", onclick: () => this.saveMission() }),
      this.el("button", { class: "btn", text: "Cancel", onclick: () => this._showMissionList() }),
    ]));
  },
  _stepEditor(s, i) {
    const box = this.el("div", { class: "admin-step" });
    box.append(this.el("div", { class: "admin-step-head" }, [
      this.el("span", { class: "admin-step-num", text: "Step " + (i + 1) }),
      this._sel(s, "_type", [["objective", "Objective"], ["choice", "Choice / fork"]], () => this.renderMissionEditor()),
      this.el("button", { class: "admin-x", text: "✕", title: "Remove step", onclick: () => { this.mDraft.steps.splice(i, 1); if (!this.mDraft.steps.length) this.mDraft.steps.push(this._blankStep()); this.renderMissionEditor(); } }),
    ]));
    box.append(this.el("label", { class: "admin-mfield admin-mfield-wide" }, ["Inbound message (what the contact says)", this._txt(s, "text", { rows: 2 })]));
    if (s._type === "choice") {
      const cw = this.el("div", { class: "admin-choices" });
      s.choices.forEach((c, ci) => cw.append(this._choiceEditor(s, c, ci)));
      box.append(cw);
      box.append(this.el("button", { class: "btn btn-mini", text: "+ Add choice", onclick: () => { s.choices.push(this._blankChoice()); this.renderMissionEditor(); } }));
    } else {
      box.append(this.el("label", { class: "admin-mfield admin-mfield-wide" }, ["Objective (shown to the player)", this._txt(s.goal, "desc", {})]));
      box.append(this.el("div", { class: "admin-mfield" }, [this.el("span", { class: "admin-mlabel", text: "Completed when:" }), this._condEditor(s.goal.cond, true)]));
      box.append(this._chk(s, "_gate", "Ask the player to Accept / Decline before it tracks"));
      if (s._gate) box.append(this.el("div", { class: "admin-gate" }, [
        this.el("label", { class: "admin-mfield" }, ["Accept button", this._txt(s.accept, "label", {})]),
        this.el("label", { class: "admin-mfield" }, ["Reply on accept", this._txt(s.accept, "reply", {})]),
        this.el("label", { class: "admin-mfield" }, ["Sender’s ack after accept", this._txt(s.accept, "ack", {})]),
        this.el("label", { class: "admin-mfield" }, ["Decline button", this._txt(s.decline, "label", {})]),
        this.el("label", { class: "admin-mfield" }, ["Reply on decline", this._txt(s.decline, "reply", {})]),
        this.el("label", { class: "admin-mfield" }, ["Sign-off on decline", this._txt(s.decline, "outro", {})]),
      ]));
      box.append(this.el("div", { class: "admin-mfield admin-mfield-wide" }, [this.el("span", { class: "admin-mlabel", text: "Reward on completion:" }), this._rewardEditor(s.reward)]));
    }
    box.append(this.el("label", { class: "admin-mfield admin-mfield-wide" }, ["Flavour replies — one per line, pure colour", this._lines(s, "replies")]));
    return box;
  },
  _choiceEditor(step, c, ci) {
    const box = this.el("div", { class: "admin-choice" });
    box.append(this.el("div", { class: "admin-choice-head" }, [
      this.el("span", { class: "admin-mlabel", text: "Choice " + (ci + 1) }),
      this.el("button", { class: "admin-x", text: "✕", onclick: () => { step.choices.splice(ci, 1); if (!step.choices.length) step.choices.push(this._blankChoice()); this.renderMissionEditor(); } }),
    ]));
    box.append(this.el("label", { class: "admin-mfield" }, ["Button label", this._txt(c, "label", {})]));
    box.append(this.el("label", { class: "admin-mfield" }, ["Player’s reply", this._txt(c, "reply", {})]));
    box.append(this.el("label", { class: "admin-mfield admin-mfield-sm" }, ["Cost (credits)", this._num(c, "cost", { min: "0" })]));
    box.append(this.el("div", { class: "admin-mfield admin-mfield-wide" }, [this.el("span", { class: "admin-mlabel", text: "Reward:" }), this._rewardEditor(c.reward)]));
    box.append(this._chk(c, "end", "End the storyline after this choice"));
    return box;
  },

  // ===== crafting editor ===================================================
  // Recipes, their blueprints, and blackbox effects — saved as data (Content →
  // Supabase → every player). The generic Content tab can edit the same keys as
  // raw tables; this view knows the shapes, so ids and references stay valid.
  // Crafting is server-authoritative, hence the Server SQL tab (craftSQL()).
  craftTab: "recipes",
  CRAFT_TABS: [["recipes", "Recipes"], ["blackboxes", "Blackboxes"], ["sql", "Server SQL"]],
  CRAFT_SOURCES: [["auto", "Auto-unlock (Baron Tier)"], ["bazaar", "Bazaar stock"],
                  ["expedition", "Survey drop"], ["mission", "Mission reward"]],
  // Stats the game actually reads off an active boost (Boosts.mag) — anything
  // else would be a blackbox that does nothing.
  BOOST_STATS: [
    ["industryYield", "Extractor yield"], ["industryTax", "Industry tax"],
    ["customsSeize", "Customs seizure odds"], ["missionTransit", "Mission transit time"],
    ["missionDamage", "Mission hull damage"], ["contractReward", "Contract reward"],
    ["craftTime", "Workshop craft time"], ["surveyScan", "Survey success odds"],
  ],

  _recipes() { if (!Array.isArray(window.RECIPES)) window.RECIPES = []; return window.RECIPES; },
  _blueprints() { if (!Array.isArray(window.BLUEPRINTS)) window.BLUEPRINTS = []; return window.BLUEPRINTS; },
  _boxes() { if (!Array.isArray(window.BLACKBOX_EFFECTS)) window.BLACKBOX_EFFECTS = []; return window.BLACKBOX_EFFECTS; },
  _bpFor(recipeId) { return this._blueprints().find(b => b.recipeId === recipeId) || null; },
  setCStatus(msg, kind) { const e = this.r.cStatus; if (!e) return; e.textContent = msg; e.className = "admin-status" + (kind ? " " + kind : ""); },

  // Craftable hulls only: a Workshop job pushes onto the fleet, and a flagship
  // ("main") isn't a fleet ship.
  _craftShipOpts() {
    const sc = window.SHIP_CATALOG || {};
    return [].concat(sc.transport || [], sc.escort || [], sc.survey || [])
      .map(s => [s.id, `${s.name} (${s.cls}${s.craftOnly ? ", craft-only" : ""})`]);
  },
  _commodityOpts() { return (window.COMMODITIES || []).map(c => [c.id, `${c.name} (${c.cat})`]); },
  _catOpts() { return [...new Set((window.COMMODITIES || []).map(c => c.cat))].map(c => [c, c]); },

  buildCraft() { this.cDraft = null; this.bDraft = null; this._showCraftList(); },

  _showCraftList() {
    if (!this.r.cList || !this.r.cDetail || !this.r.cTabs) return;
    this.cDraft = null; this.bDraft = null;
    this.r.cDetail.classList.add("hidden"); this.r.cDetail.innerHTML = "";
    this.r.cList.classList.remove("hidden");
    this.setCStatus("", "");
    this.r.cTabs.innerHTML = "";
    for (const [id, label] of this.CRAFT_TABS) {
      this.r.cTabs.append(this.el("button", {
        class: "admin-imgtab" + (id === this.craftTab ? " active" : ""),
        text: label, onclick: () => { this.craftTab = id; this._showCraftList(); },
      }));
    }
    if (this.r.cListActions) this.r.cListActions.classList.remove("hidden");
    if (this.r.cNew) this.r.cNew.classList.toggle("hidden", this.craftTab === "sql");
    const list = this.r.cList; list.innerHTML = "";
    if (this.craftTab === "sql") return list.append(this._sqlPane());
    if (this.craftTab === "blackboxes") {
      list.append(this.el("p", { class: "admin-mhint", text: "Consumables that push a timed modifier onto the player. A recipe with output type “blackbox” mints one." }));
      this._boxes().forEach((e, i) => list.append(this._boxCard(e, i)));
      return;
    }
    const types = ["gear", "extractor", "ship", "blackbox"];
    const recipes = this._recipes();
    for (const t of types) {
      const rows = recipes.map((r, i) => ({ r, i })).filter(x => x.r.outputType === t);
      if (!rows.length) continue;
      list.append(this.el("h4", { class: "admin-subhead", text: t + ` (${rows.length})` }));
      rows.forEach(x => list.append(this._recipeCard(x.r, x.i)));
    }
    if (!recipes.length) list.append(this.el("p", { class: "admin-mhint", text: "No recipes — click “+ New”." }));
  },

  _recipeCard(r, i) {
    const bp = this._bpFor(r.id);
    const ings = (r.ingredients || []).map(x => `${x.qty}× ${x.id}`).join(", ") || "no ingredients";
    const mins = Math.round((r.craftMs || 0) / 60000);
    const head = this.el("div", { class: "admin-mcard-head" }, [
      this.el("span", { class: "admin-mbadge", text: (r.tier || r.outputType || "").slice(0, 10) }),
      this.el("strong", { text: r.name || r.id }),
      this.el("span", { class: "admin-mtag " + (bp && bp.destroyOnUse ? "is-custom" : "is-builtin"),
        text: bp ? (bp.destroyOnUse ? "one-of-a-kind" : bp.source || "blueprint") : "no blueprint" }),
    ]);
    const meta = this.el("div", { class: "admin-mcard-meta",
      text: `id: ${r.id} · ${mins} min${r.credits ? " · " + r.credits + "c" : ""} · ${ings}` });
    const actions = this.el("div", { class: "admin-mcard-actions" }, [
      this.el("button", { class: "btn btn-mini", text: "Edit", onclick: () => this.editRecipe(i) }),
      this.el("button", { class: "btn btn-mini btn-danger", text: "Delete", onclick: () => this.deleteRecipe(i) }),
    ]);
    return this.el("div", { class: "admin-mission-card" }, [head, meta, actions]);
  },
  _boxCard(e, i) {
    const head = this.el("div", { class: "admin-mcard-head" }, [
      this.el("span", { class: "admin-mbadge", text: "BOX" }),
      this.el("strong", { text: e.name || e.id }),
    ]);
    const meta = this.el("div", { class: "admin-mcard-meta",
      text: `id: ${e.id} · ${e.stat} ${e.mag > 0 ? "+" : ""}${Math.round((e.mag || 0) * 100)}% · ${Math.round((e.durationMs || 0) / 60000)} min` });
    const actions = this.el("div", { class: "admin-mcard-actions" }, [
      this.el("button", { class: "btn btn-mini", text: "Edit", onclick: () => this.editBox(i) }),
      this.el("button", { class: "btn btn-mini btn-danger", text: "Delete", onclick: () => this.deleteBox(i) }),
    ]);
    return this.el("div", { class: "admin-mission-card" }, [head, meta, actions]);
  },

  _openCraftEditor(render) {
    this.r.cList.classList.add("hidden");
    if (this.r.cListActions) this.r.cListActions.classList.add("hidden");
    this.r.cDetail.classList.remove("hidden");
    this.setCStatus("", "");
    render();
  },
  newCraft() {
    if (this.craftTab === "blackboxes") { this.bIndex = -1; this.bDraft = this._blankBox(); this._openCraftEditor(() => this.renderBoxEditor()); }
    else { this.craftTab = "recipes"; this.cIndex = -1; this.cDraft = this._blankRecipe(); this._openCraftEditor(() => this.renderRecipeEditor()); }
  },
  editRecipe(i) { const r = this._recipes()[i]; if (!r) return; this.cIndex = i; this.cDraft = this._toRecipeDraft(r); this._openCraftEditor(() => this.renderRecipeEditor()); },
  editBox(i) { const e = this._boxes()[i]; if (!e) return; this.bIndex = i; this.bDraft = JSON.parse(JSON.stringify(e)); this.bDraft.minutes = Math.round((e.durationMs || 0) / 60000); this._openCraftEditor(() => this.renderBoxEditor()); },

  // ---- recipe draft -------------------------------------------------------
  _blankRecipe() {
    return { id: "", name: "", outputType: "gear", tier: "", minutes: 30, credits: 0,
      ingredients: [{ id: (COMMODITIES[0] || {}).id || "", qty: 1 }], flavor: [],
      out: { kind: Object.keys(ACCESSORY_KINDS)[0], rarity: "common", effectId: ((this._boxes()[0] || {}).id) || "",
             extractorType: "jack", scope: "all", shipType: (this._craftShipOpts()[0] || [""])[0] },
      bp: { id: "", name: "", source: "bazaar", minBaronTier: 0, destroyOnUse: false } };
  },
  _toRecipeDraft(r) {
    const d = this._blankRecipe();
    const src = JSON.parse(JSON.stringify(r));
    d.id = src.id || ""; d.name = src.name || ""; d.outputType = src.outputType || "gear";
    d.tier = src.tier || ""; d.minutes = Math.round((src.craftMs || 0) / 60000); d.credits = src.credits || 0;
    d.ingredients = (src.ingredients || []).map(x => ({ id: x.id, qty: x.qty || 1 }));
    if (!d.ingredients.length) d.ingredients.push({ id: (COMMODITIES[0] || {}).id || "", qty: 1 });
    d.flavor = (src.flavor || []).map(x => ({ id: x.id, qty: x.qty || 1, scopeCat: x.scopeCat || "mineral" }));
    Object.assign(d.out, src.output || {});
    const bp = this._bpFor(src.id);
    if (bp) d.bp = { id: bp.id, name: bp.name || "", source: bp.source || "bazaar",
                     minBaronTier: bp.minBaronTier || 0, destroyOnUse: !!bp.destroyOnUse };
    return d;
  },
  _normalizeRecipe() {
    const d = this.cDraft;
    const id = (d.id || "").trim();
    const r = { id, name: (d.name || "").trim(), outputType: d.outputType,
      tier: (d.tier || "").trim() || d.outputType,
      ingredients: (d.ingredients || []).filter(x => x.id)
        .map(x => ({ id: x.id, qty: Math.max(1, Math.round(+x.qty || 1)) })),
      craftMs: Math.max(60000, Math.round((+d.minutes || 1) * 60000)),
      blueprintId: (d.bp.id || "").trim() || ("bp_" + id) };
    if (Math.round(+d.credits) > 0) r.credits = Math.round(+d.credits);
    if (d.outputType === "gear") r.output = { kind: d.out.kind, rarity: d.out.rarity };
    else if (d.outputType === "blackbox") r.output = { effectId: d.out.effectId };
    else if (d.outputType === "ship") r.output = { shipType: d.out.shipType };
    else {
      r.output = d.out.extractorType === "specialized"
        ? { extractorType: "specialized" }
        : { extractorType: d.out.extractorType, scope: d.out.scope || "all" };
      const fl = (d.flavor || []).filter(x => x.id)
        .map(x => ({ id: x.id, qty: Math.max(1, Math.round(+x.qty || 1)), scopeCat: x.scopeCat }));
      if (fl.length) r.flavor = fl;
    }
    const bp = { id: r.blueprintId, name: (d.bp.name || "").trim() || ("Blueprint: " + r.name),
      recipeId: id, outputType: r.outputType, source: d.bp.source,
      uses: d.bp.destroyOnUse ? 1 : Infinity, destroyOnUse: !!d.bp.destroyOnUse };
    if (d.bp.source === "auto") bp.minBaronTier = Math.max(0, Math.round(+d.bp.minBaronTier || 0));
    return { recipe: r, blueprint: bp };
  },
  _validateCraft(r, bp) {
    const has = (arr, id) => arr.some(x => x.id === id);
    if (!/^[a-z0-9_]+$/i.test(r.id)) return "Recipe id: letters, numbers and underscores only.";
    if (this._recipes().some((x, i) => x.id === r.id && i !== this.cIndex)) return "Another recipe already uses that id.";
    if (!r.name) return "Give the recipe a name.";
    if (!(r.craftMs > 0)) return "Craft time must be at least a minute.";
    if (!r.ingredients.length) return "Add at least one ingredient.";
    for (const ing of r.ingredients) if (!has(COMMODITIES, ing.id)) return `Unknown commodity “${ing.id}”.`;
    if (r.outputType === "gear") {
      if (!ACCESSORY_KINDS[r.output.kind]) return "Pick a gear kind.";
      if (!has(RARITIES, r.output.rarity)) return "Pick a rarity.";
    } else if (r.outputType === "blackbox") {
      if (!has(this._boxes(), r.output.effectId)) return "Pick a blackbox effect (add one on the Blackboxes tab first).";
    } else if (r.outputType === "ship") {
      if (!(window.ALL_SHIPS || []).some(s => s.id === r.output.shipType)) return "Pick a hull (add hulls in Content → Ships).";
    } else {
      if (!EXTRACTORCFG.types[r.output.extractorType]) return "Pick an extractor type.";
      if (r.output.extractorType === "specialized" && !(r.flavor || []).length) {
        return "A specialized extractor needs at least one category-flavor ingredient.";
      }
      for (const f of r.flavor || []) if (!has(COMMODITIES, f.id)) return `Unknown flavor commodity “${f.id}”.`;
    }
    if (!/^[a-z0-9_]+$/i.test(bp.id)) return "Blueprint id: letters, numbers and underscores only.";
    if (this._blueprints().some(x => x.id === bp.id && x.recipeId !== r.id)) return "Another blueprint already uses that id.";
    return null;
  },

  async saveRecipe() {
    const { recipe, blueprint } = this._normalizeRecipe();
    const err = this._validateCraft(recipe, blueprint);
    if (err) return this.setCStatus("✗ " + err, "bad");
    const recipes = this._recipes();
    const oldId = this.cIndex >= 0 ? recipes[this.cIndex].id : null;
    const nextR = this.cIndex >= 0 ? recipes.map((x, i) => i === this.cIndex ? recipe : x) : recipes.concat([recipe]);
    const nextB = this._blueprints().filter(b => b.recipeId !== recipe.id && b.recipeId !== oldId).concat([blueprint]);
    this.setCStatus("Saving…", "");
    try {
      await Content.save("RECIPES", nextR);
      await Content.save("BLUEPRINTS", nextB);
      if (window.UI) UI.toast(`Recipe “${recipe.name}” saved.`, "good");
      this._showCraftList();
      this.setCStatus("✓ Saved. Run Server SQL in Supabase so signed-in players can craft it.", "good");
    } catch (e) { this.setCStatus("✗ " + ((e && e.message) || e) + " — press Save again (recipes and blueprints save as two writes).", "bad"); }
  },
  async deleteRecipe(i) {
    const r = this._recipes()[i]; if (!r) return;
    if (!confirm(`Delete recipe “${r.name || r.id}”? It disappears from every player's Workshop; crafts already queued for it stay parked until you restore the id.`)) return;
    try {
      await Content.save("RECIPES", this._recipes().filter((_, j) => j !== i));
      await Content.save("BLUEPRINTS", this._blueprints().filter(b => b.recipeId !== r.id));
      if (window.UI) UI.toast("Recipe deleted.", "good");
      this._showCraftList();
      this.setCStatus("✓ Deleted. Run Server SQL in Supabase to match.", "good");
    } catch (e) { this.setCStatus("✗ " + ((e && e.message) || e), "bad"); }
  },

  renderRecipeEditor() {
    const d = this.cDraft, host = this.r.cDetail; host.innerHTML = "";
    const redraw = () => this.renderRecipeEditor();
    host.append(this.el("div", { class: "admin-mission-toolbar" }, [
      this.el("button", { class: "btn btn-mini", text: "← Back", onclick: () => this._showCraftList() }),
      this.el("strong", { text: this.cIndex >= 0 ? "Edit recipe" : "New recipe" }),
    ]));
    if (this.cIndex >= 0) host.append(this.el("p", { class: "admin-mhint",
      text: "Changing the id retires the old recipe: players who already earned its blueprint have to earn the new one, and crafts queued under the old id stay parked until it exists again." }));
    host.append(this.el("div", { class: "admin-mtop" }, [
      this.el("label", { class: "admin-mfield" }, ["Id (unique)", this._txt(d, "id", {})]),
      this.el("label", { class: "admin-mfield" }, ["Name", this._txt(d, "name", {})]),
      this.el("label", { class: "admin-mfield" }, ["Output", this._sel(d, "outputType",
        [["gear", "Gear"], ["extractor", "Extractor"], ["ship", "Ship"], ["blackbox", "Blackbox"]], redraw)]),
      this.el("label", { class: "admin-mfield admin-mfield-sm" }, ["Tier label", this._txt(d, "tier", {})]),
      this.el("label", { class: "admin-mfield admin-mfield-sm" }, ["Craft time (min)", this._num(d, "minutes", { min: "1" })]),
      this.el("label", { class: "admin-mfield admin-mfield-sm" }, ["Credits", this._num(d, "credits", { min: "0" })]),
    ]));

    // output
    const out = this.el("div", { class: "admin-mtop" });
    if (d.outputType === "gear") {
      out.append(this.el("label", { class: "admin-mfield" }, ["Gear kind",
        this._sel(d.out, "kind", Object.keys(ACCESSORY_KINDS).map(k => [k, ACCESSORY_KINDS[k].label || k]))]));
      out.append(this.el("label", { class: "admin-mfield" }, ["Rarity",
        this._sel(d.out, "rarity", RARITIES.map(r => [r.id, r.label || r.id]))]));
    } else if (d.outputType === "blackbox") {
      out.append(this.el("label", { class: "admin-mfield" }, ["Effect",
        this._sel(d.out, "effectId", this._boxes().map(e => [e.id, e.name || e.id]))]));
    } else if (d.outputType === "ship") {
      out.append(this.el("label", { class: "admin-mfield admin-mfield-wide" }, ["Hull",
        this._sel(d.out, "shipType", this._craftShipOpts())]));
    } else {
      out.append(this.el("label", { class: "admin-mfield" }, ["Extractor type",
        this._sel(d.out, "extractorType", Object.keys(EXTRACTORCFG.types).map(t => [t, t]), redraw)]));
      if (d.out.extractorType !== "specialized") {
        out.append(this.el("label", { class: "admin-mfield" }, ["Scope",
          this._sel(d.out, "scope", [["all", "all"]].concat(this._catOpts()))]));
      }
    }
    host.append(this.el("div", { class: "admin-mfield admin-mfield-wide" },
      [this.el("span", { class: "admin-mlabel", text: "Produces:" }), out]));

    host.append(this._ingredientBlock("Ingredients (spent on craft)", d.ingredients, false, redraw));
    if (d.outputType === "extractor" && d.out.extractorType === "specialized") {
      host.append(this._ingredientBlock("Category flavor — one is spent, and picks what the extractor mines", d.flavor, true, redraw));
    }

    // blueprint
    const bp = this.el("div", { class: "admin-mtop" }, [
      this.el("label", { class: "admin-mfield" }, ["Blueprint id", this._txt(d.bp, "id", {})]),
      this.el("label", { class: "admin-mfield" }, ["Blueprint name", this._txt(d.bp, "name", {})]),
      this.el("label", { class: "admin-mfield" }, ["How players get it", this._sel(d.bp, "source", this.CRAFT_SOURCES, redraw)]),
    ]);
    if (d.bp.source === "auto") bp.append(this.el("label", { class: "admin-mfield admin-mfield-sm" }, ["Baron Tier floor", this._num(d.bp, "minBaronTier", { min: "0" })]));
    bp.append(this._chk(d.bp, "destroyOnUse", "One-of-a-kind (blueprint burns on delivery)"));
    host.append(this.el("div", { class: "admin-mfield admin-mfield-wide" },
      [this.el("span", { class: "admin-mlabel", text: "Blueprint (leave id blank for bp_<recipe id>):" }), bp]));

    host.append(this.el("div", { class: "settings-actions" }, [
      this.el("button", { class: "btn btn-go", text: "Save recipe", onclick: () => this.saveRecipe() }),
      this.el("button", { class: "btn", text: "Cancel", onclick: () => this._showCraftList() }),
    ]));
  },
  _ingredientBlock(label, rows, withScope, redraw) {
    const wrap = this.el("div", { class: "admin-ings" });
    rows.forEach((row, i) => {
      const line = this.el("div", { class: "admin-ing" }, [
        this._sel(row, "id", this._commodityOpts()),
        this._num(row, "qty", { min: "1", class: "admin-cond-val" }),
      ]);
      if (withScope) line.append(this._sel(row, "scopeCat", this._catOpts()));
      line.append(this.el("button", { class: "admin-x", text: "✕", onclick: () => { rows.splice(i, 1); redraw(); } }));
      wrap.append(line);
    });
    wrap.append(this.el("button", { class: "btn btn-mini", text: "+ ingredient", onclick: () => {
      rows.push({ id: (COMMODITIES[0] || {}).id || "", qty: 1, scopeCat: (this._catOpts()[0] || [""])[0] });
      redraw();
    } }));
    return this.el("div", { class: "admin-mfield admin-mfield-wide" },
      [this.el("span", { class: "admin-mlabel", text: label }), wrap]);
  },

  // ---- blackbox effects ---------------------------------------------------
  _blankBox() { return { id: "", name: "", desc: "", stat: "industryYield", mag: 0.25, minutes: 120 }; },
  renderBoxEditor() {
    const d = this.bDraft, host = this.r.cDetail; host.innerHTML = "";
    host.append(this.el("div", { class: "admin-mission-toolbar" }, [
      this.el("button", { class: "btn btn-mini", text: "← Back", onclick: () => this._showCraftList() }),
      this.el("strong", { text: this.bIndex >= 0 ? "Edit blackbox effect" : "New blackbox effect" }),
    ]));
    host.append(this.el("p", { class: "admin-mhint", text: "Magnitude is a fraction: 0.25 = +25%, -0.5 = −50%. Item value is derived from magnitude × duration." }));
    host.append(this.el("div", { class: "admin-mtop" }, [
      this.el("label", { class: "admin-mfield" }, ["Id (unique)", this._txt(d, "id", {})]),
      this.el("label", { class: "admin-mfield" }, ["Name", this._txt(d, "name", {})]),
      this.el("label", { class: "admin-mfield" }, ["Affects", this._sel(d, "stat", this.BOOST_STATS)]),
      this.el("label", { class: "admin-mfield admin-mfield-sm" }, ["Magnitude", this._num(d, "mag", { step: "0.05" })]),
      this.el("label", { class: "admin-mfield admin-mfield-sm" }, ["Duration (min)", this._num(d, "minutes", { min: "1" })]),
    ]));
    host.append(this.el("label", { class: "admin-mfield admin-mfield-wide" }, ["Description shown to players", this._txt(d, "desc", {})]));
    host.append(this.el("div", { class: "settings-actions" }, [
      this.el("button", { class: "btn btn-go", text: "Save effect", onclick: () => this.saveBox() }),
      this.el("button", { class: "btn", text: "Cancel", onclick: () => this._showCraftList() }),
    ]));
  },
  async saveBox() {
    const d = this.bDraft;
    const e = { id: (d.id || "").trim(), name: (d.name || "").trim(), desc: (d.desc || "").trim(),
      stat: d.stat, mag: +d.mag || 0, durationMs: Math.max(60000, Math.round((+d.minutes || 1) * 60000)) };
    if (!/^[a-z0-9_]+$/i.test(e.id)) return this.setCStatus("✗ Id: letters, numbers and underscores only.", "bad");
    if (this._boxes().some((x, i) => x.id === e.id && i !== this.bIndex)) return this.setCStatus("✗ Another effect already uses that id.", "bad");
    if (!e.name) return this.setCStatus("✗ Give the effect a name.", "bad");
    if (!e.mag) return this.setCStatus("✗ Magnitude 0 would do nothing.", "bad");
    if (!this.BOOST_STATS.some(([s]) => s === e.stat)) return this.setCStatus("✗ Unknown stat.", "bad");
    const next = this.bIndex >= 0 ? this._boxes().map((x, i) => i === this.bIndex ? e : x) : this._boxes().concat([e]);
    this.setCStatus("Saving…", "");
    try {
      await Content.save("BLACKBOX_EFFECTS", next);
      if (window.UI) UI.toast(`Blackbox “${e.name}” saved.`, "good");
      this._showCraftList();
      this.setCStatus("✓ Saved. Run Server SQL in Supabase to match.", "good");
    } catch (err) { this.setCStatus("✗ " + ((err && err.message) || err), "bad"); }
  },
  async deleteBox(i) {
    const e = this._boxes()[i]; if (!e) return;
    const used = this._recipes().filter(r => r.outputType === "blackbox" && (r.output || {}).effectId === e.id);
    if (used.length) return this.setCStatus(`✗ ${used.map(r => r.name).join(", ")} still crafts this effect — delete or repoint the recipe first.`, "bad");
    if (!confirm(`Delete blackbox effect “${e.name || e.id}”? Boxes players already hold stop working.`)) return;
    try {
      await Content.save("BLACKBOX_EFFECTS", this._boxes().filter((_, j) => j !== i));
      this._showCraftList();
      this.setCStatus("✓ Deleted. Run Server SQL in Supabase to match.", "good");
    } catch (err) { this.setCStatus("✗ " + ((err && err.message) || err), "bad"); }
  },

  // ---- server fixture SQL -------------------------------------------------
  _sqlPane() {
    const wrap = this.el("div", { class: "admin-lines-wrap" });
    wrap.append(this.el("p", { class: "admin-mhint", text: "Crafting is server-authoritative: the database keeps its own copy of the recipe, blackbox and hull tables (docs/sql/workshop_craft.sql). Paste this into the Supabase SQL editor and run it after changing recipes, blackboxes or ships — otherwise signed-in players get “Unknown recipe.” Guests already use the edits above." }));
    const ta = this.el("textarea", { class: "admin-json", spellcheck: "false", rows: 18, value: this.craftSQL() });
    wrap.append(ta);
    wrap.append(this.el("div", { class: "settings-actions" }, [
      this.el("button", { class: "btn btn-go", text: "Copy SQL", onclick: () => {
        ta.select();
        const done = () => { if (window.UI) UI.toast("SQL copied — paste it into the Supabase SQL editor.", "good", 5000); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(done, () => document.execCommand("copy") && done());
        else if (document.execCommand("copy")) done();
      } }),
    ]));
    return wrap;
  },
  _sqs(v) { return "'" + String(v == null ? "" : v).replace(/'/g, "''") + "'"; },
  _sqj(v) { return "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb"; },

  // The DB fixtures, rebuilt from the live (admin-edited) tables. Same layout as
  // docs/sql/workshop_craft.sql so tools/check_craft_parity.js can read it back.
  craftSQL() {
    const R = this._recipes(), BB = this._boxes();
    const shipDef = id => (window.ALL_SHIPS || []).find(s => s.id === id) || null;
    const rrows = R.map(r => {
      const bp = this._bpFor(r.id) || {};
      const autoTier = bp.source === "auto" ? (bp.minBaronTier || 0) : null;
      const def = r.outputType === "ship" ? shipDef((r.output || {}).shipType) : null;
      const lines = [
        `    (${this._sqs(r.id)}, jsonb_build_object(`,
        `      'id',${this._sqs(r.id)},'name',${this._sqs(r.name)},'outputType',${this._sqs(r.outputType)},`,
        `      'craftMs', ${Math.round(r.craftMs || 0)}::bigint, 'credits', ${Math.round(r.credits || 0)},`,
        `      'ingredients', ${this._sqj(r.ingredients || [])},`,
      ];
      if (r.flavor && r.flavor.length) lines.push(`      'flavor', ${this._sqj(r.flavor)},`);
      lines.push(`      'output', ${this._sqj(r.output || {})},`);
      lines.push(`      'autoTier', ${autoTier == null ? "null" : autoTier}, 'destroyOnUse', ${!!bp.destroyOnUse}, 'unique', ${!!(def && def.unique)}))`);
      return lines.join("\n");
    }).join(",\n");
    const brows = BB.map(e =>
      `    (${this._sqs(e.id)}, jsonb_build_object('id',${this._sqs(e.id)},'name',${this._sqs(e.name)},`
      + `'stat',${this._sqs(e.stat)},'mag',${+e.mag || 0},'durationMs',${Math.round(e.durationMs || 0)}::bigint))`
    ).join(",\n");
    const sc = window.SHIP_CATALOG || {};
    const fleet = [].concat(...["transport", "escort", "survey"].map(k => sc[k] || []));
    const all = fleet.concat(sc.main || []);
    // Fitment table — mains never carry accessories, so fleet hulls only.
    const slotRows = [];
    for (let i = 0; i < fleet.length; i += 5) {
      slotRows.push("      " + fleet.slice(i, i + 5).map(s => `(${this._sqs(s.id)}, ${s.slots || 2})`).join(", "));
    }
    const srows = all.map((s, i) => {
      const main = s.cls === "main";
      const c = i === 0 ? "::float8" : "";
      return `    (${this._sqs(s.id)}, ${this._sqs(s.cls)}, ${s.price || 0}${c}, ${main ? 0 : (s.firepower || 0)}${c}, `
        + `${main ? 0 : (s.cargo || 0)}${c}, ${s.hull || 0}${c}, ${main ? (s.travelSpeed || 1) : (s.speed || 1)}${c})`;
    }).join(",\n");
    return [
      "-- GENERATED by the Cosmocrat admin console (Admin → 🔧 Crafting → Server SQL).",
      "-- Replaces the fixtures in docs/sql/workshop_craft.sql + phase2_missions_bazaar.sql",
      "-- with your edited tables. Safe to re-run.",
      "",
      "create or replace function app.craft_recipe(p_id text)",
      "returns jsonb",
      "language sql immutable as $$",
      "  select r.row from (values",
      rrows,
      "  ) as r(id, row)",
      "  where r.id = p_id;",
      "$$;",
      "",
      "create or replace function app.craft_blackbox(p_id text)",
      "returns jsonb",
      "language sql immutable as $$",
      "  select b.row from (values",
      brows,
      "  ) as b(id, row)",
      "  where b.id = p_id;",
      "$$;",
      "",
      "-- Hull stats (SHIP_CATALOG). Craft-only hulls must be here or a finished",
      "-- ship job has nothing to build.",
      "create or replace function app.ship_def(p_id text)",
      "returns table(",
      "  id text, cls text, price double precision, firepower double precision,",
      "  cargo double precision, hull double precision, speed double precision",
      ")",
      "language sql immutable as $$",
      "  select * from (values",
      srows,
      "  ) as s(id, cls, price, firepower, cargo, hull, speed)",
      "  where s.id = p_id;",
      "$$;",
      "",
      "-- Accessory slots per fleet hull. A hull missing here silently drops to 2",
      "-- slots, truncating everything fitted above that on the next commit.",
      "create or replace function app._ship_slots(p_type text)",
      "returns int",
      "language sql immutable as $$",
      "  select coalesce((",
      "    select t.slots from (values",
      slotRows.join(",\n"),
      "    ) as t(id, slots) where t.id = p_type",
      "  ), 2);",
      "$$;",
      "",
    ].join("\n");
  },

  // ---- small two-way-bound controls (mutate the draft object directly) ----
  _txt(obj, key, props) {
    props = props || {};
    const e = this.el(props.rows ? "textarea" : "input", props.rows ? { rows: props.rows } : { type: "text" });
    e.value = obj[key] == null ? "" : obj[key];
    e.oninput = () => { obj[key] = e.value; };
    return e;
  },
  _num(obj, key, props) {
    props = props || {};
    const e = this.el("input", { type: "number", step: props.step || "any" });
    if (props.min != null) e.min = props.min;
    if (props.class) e.className = props.class;
    e.value = (obj[key] == null || obj[key] === "") ? "" : obj[key];
    e.oninput = () => { obj[key] = e.value === "" ? 0 : parseFloat(e.value); };
    return e;
  },
  _chk(obj, key, label) {
    const box = this.el("input", { type: "checkbox" });
    box.checked = !!obj[key];
    box.onchange = () => { obj[key] = box.checked; if (key === "_gate") this.renderMissionEditor(); };
    const lab = this.el("label", { class: "admin-mchk" });
    lab.append(box, document.createTextNode(" " + label));
    return lab;
  },
  _sel(obj, key, options, onAfter) {
    const s = this.el("select");
    for (const [v, l] of options) s.append(this.el("option", { value: v, text: l }));
    s.value = obj[key] == null ? "" : String(obj[key]);
    s.onchange = () => { obj[key] = s.value; if (onAfter) onAfter(); };
    return s;
  },
  _lines(obj, key) {
    const ta = this.el("textarea", { rows: 2, class: "admin-mlines" });
    ta.value = (obj[key] || []).join("\n");
    ta.oninput = () => { obj[key] = ta.value.split("\n"); };
    return ta;
  },
  _shipOpts() {
    const sc = window.SHIP_CATALOG || {};
    return [].concat(sc.transport || [], sc.escort || [], sc.main || []).map(s => [s.id, s.name || s.id]);
  },
  _condEditor(cond, withDelta) {
    const metricOpts = [["", "— no condition —"]].concat((window.Story ? Story.METRICS : []).map(m => [m.id, m.label]));
    const opOpts = [[">=", "≥"], [">", ">"], ["<=", "≤"], ["<", "<"], ["==", "="]];
    const row = this.el("div", { class: "admin-cond" }, [
      this._sel(cond, "metric", metricOpts),
      this._sel(cond, "op", opOpts),
      this._num(cond, "value", { class: "admin-cond-val" }),
    ]);
    if (withDelta) row.append(this._chk(cond, "delta", "more (since this step began)"));
    return row;
  },
  _rewardEditor(reward) {
    reward.taxBreak = reward.taxBreak || { pct: 0, ms: 0 };
    const ships = [["", "— no ship —"]].concat(this._shipOpts());
    const items = [["", "— none —"], ["true", "Random item"]].concat((window.RARITIES || []).map(r => [r.id, r.label || r.id]));
    const tb = reward.taxBreak;
    const pct = this.el("input", { type: "number", step: "1", min: "0", max: "100" });
    pct.value = tb.pct ? Math.round(tb.pct * 100) : ""; pct.oninput = () => { tb.pct = (parseFloat(pct.value) || 0) / 100; };
    const min = this.el("input", { type: "number", step: "1", min: "0" });
    min.value = tb.ms ? Math.round(tb.ms / 60000) : ""; min.oninput = () => { tb.ms = (parseFloat(min.value) || 0) * 60000; };
    return this.el("div", { class: "admin-reward" }, [
      this.el("label", { class: "admin-mfield admin-mfield-sm" }, ["Credits", this._num(reward, "credits", { min: "0" })]),
      this.el("label", { class: "admin-mfield" }, ["Ship", this._sel(reward, "ship", ships)]),
      this.el("label", { class: "admin-mfield" }, ["Item", this._sel(reward, "item", items)]),
      this.el("label", { class: "admin-mfield admin-mfield-sm" }, ["Tax break %", pct]),
      this.el("label", { class: "admin-mfield admin-mfield-sm" }, ["…for minutes (0 = permanent)", min]),
      this._chk(reward, "component", "Component"),
      this._chk(reward, "extractor", "Extractor"),
    ]);
  },
};

window.AdminUI = AdminUI;
