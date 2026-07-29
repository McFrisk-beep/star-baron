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
      vDev: $("admin-view-dev"),
      devCredits: $("dev-credits"), devSet: $("dev-credits-set"), dev10k: $("dev-credits-10k"), dev1m: $("dev-credits-1m"),
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

    // dev tools: credit cheats (admin-gated by the whole panel)
    const adjust = fn => { const s = window.Game && Game.state; if (!s) return; fn(s); if (window.Economy) Economy.refreshNetWorth(); if (window.UI) { UI.updateHeader(); UI.flashCredits(); } window.Game.requestSave();
      // Authoritative economy → the server owns credits; a local set is overwritten
      // on the next app_pull unless "Pause cloud sync" is on. Nudge the admin.
      if (window.Cloud && Cloud.authoritative() && window.UI) UI.toast("Cloud sync is authoritative — tick “Pause cloud sync (local test)” above or this resets on the next server sync.", "warn", 6000);
    };
    if (this.r.devSet) this.r.devSet.onclick = () => adjust(s => { s.credits = Math.max(0, Math.round(+this.r.devCredits.value || 0)); UI.toast(`Credits set to ${Util.creditsFull(s.credits)}.`, "good"); });
    if (this.r.dev10k) this.r.dev10k.onclick = () => adjust(s => { s.credits += 10000; UI.toast("+10,000c (dev)", "good"); });
    if (this.r.dev1m) this.r.dev1m.onclick = () => adjust(s => { s.credits += 1000000; UI.toast("+1,000,000c (dev)", "good"); });
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
    if (this.r.vDev) this.r.vDev.classList.toggle("hidden", view !== "dev");
    if (view === "images") this.buildGallery();
    if (view === "missions") this.buildMissions();
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
    if (!confirm("Issue a GLOBAL reset to EVERY player (guests included)?\n\nOn their next load, everyone's credits become 5,000 and all owned assets (stocks, ships, industries, accessories) are wiped. The senate is kept. This cannot be undone.")) return;
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
      { group: "Hub — character & stations", cat: "hub", items: ["player"].concat((window.HUB_PROPS || []).map(p => p.id)), url: id => ASSET.hub(id) },
      // Bazaar content — pools for randomized gear; single PNG for fixed types.
      { group: "Gear kinds (pools)", cat: "accessory", items: Object.keys(ACCESSORY_KINDS),
        url: k => ASSET.accessory(k, "preview"), pool: true,
        hint: "Each reactor/shield/… rolls a random PNG from its pool." },
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
      const img = this.el("img", { class: "admin-thumb", src: slot.url(item), alt: item });
      img.onerror = () => { img.replaceWith(this.el("div", { class: "admin-thumb tintbox", text: String(item).slice(0, 2) })); };
      const file = this.el("input", { type: "file", accept: "image/*", class: "hidden" });
      file.onchange = () => { if (file.files[0]) this.upload(slot.cat, item, file.files[0]); };
      const card = this.el("div", { class: "admin-card" + (overridden ? " custom" : "") }, [
        img,
        this.el("div", { class: "admin-card-name", text: String(item) }),
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
      const entries = this._poolEntries(key);
      const thumbs = this.el("div", { class: "admin-pool-thumbs" });
      if (!entries.length) {
        const ph = this.el("div", { class: "admin-thumb tintbox", text: String(item).slice(0, 2) });
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
        this.el("div", { class: "admin-card-name", text: `${item} (${entries.length} in pool)` }),
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
      UI.toast("Sprite updated. Reload to see it everywhere.", "good");
      this.buildGallery();
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
      UI.toast("Reverted to default sprite. Reload to apply.", "good");
      this.buildGallery();
    } catch (e) { UI.toast("Reset failed: " + ((e && e.message) || e), "warn"); }
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
