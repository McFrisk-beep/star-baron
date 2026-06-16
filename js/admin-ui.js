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
      devToggles: $("dev-toggles"),
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

    if (window.Bus) Bus.on("auth", () => this.refresh());
    this.populate();
    this.refresh();
  },

  refresh() {
    const admin = !!(window.Cloud && Cloud.isAdmin());
    if (this.r.btn) this.r.btn.classList.toggle("hidden", !admin);
    if (this.r.devToggles) this.r.devToggles.classList.toggle("hidden", !admin);
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
    if (view === "images") this.buildGallery();
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
    return [
      { group: "Character portraits", cat: "portrait", items: range(CONFIG.portraitCount), url: i => ASSET.portrait(+i) },
      { group: "Ship hulls", cat: "ship", items: ["shuttle", "hauler", "freighter", "leviathan"], url: s => ASSET.ship(s) },
      { group: "Race ships (escorts)", cat: "raceship", items: races, url: r => ASSET.raceship(r) },
      { group: "Planets", cat: "planet", items: PLANET_TYPES, url: t => ASSET.planet(t) },
      { group: "Stars", cat: "star", items: STAR_TYPES, url: t => ASSET.star(t) },
      { group: "Stations", cat: "station", items: races, url: r => ASSET.station(r) },
      { group: "Commodities", cat: "commodity", items: COMMODITIES.map(c => c.id), url: id => ASSET.commodity(id) },
      { group: "Nebulae", cat: "nebula", items: nebulae, url: n => ASSET.nebula(n) },
      { group: "Broadcast screens", cat: "broadcast", items: ["news", "tv_drama", "tv_ads", "tv_weather"], url: n => ASSET.broadcast(n) },
    ];
  },

  buildGallery() {
    if (!this.r.gallery) return;
    if (this.imgCat == null) this.imgCat = 0;
    const slots = this.slots();
    if (this.imgCat >= slots.length) this.imgCat = 0;
    this.r.imgNote.textContent = "Upload a PNG/JPG to replace any sprite (stored in your Supabase 'sprites' bucket — see docs/ADMIN_SETUP.md). Changes show on reload.";
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
    this.r.gallery.append(this.renderImageGrid(slots[this.imgCat]));
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

  async upload(cat, item, file) {
    if (!Cloud.isAdmin()) return;
    if (!Cloud.client.storage) return UI.toast("Storage SDK unavailable.", "warn");
    UI.toast("Uploading…", "info");
    try {
      const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
      const path = `${cat}/${item}.${ext}`;
      const up = await Cloud.client.storage.from("sprites").upload(path, file, { upsert: true, contentType: file.type || "image/png" });
      if (up.error) throw up.error;
      const pub = Cloud.client.storage.from("sprites").getPublicUrl(path);
      const url = pub.data.publicUrl + "?t=" + Date.now();
      ASSET_OVERRIDES[`${cat}:${item}`] = url;
      await Content.save("ASSET_OVERRIDES", { ...ASSET_OVERRIDES });
      UI.toast("Sprite updated. Reload to see it everywhere.", "good");
      this.buildGallery();
    } catch (e) {
      const msg = (e && e.message) || String(e);
      UI.toast(/bucket|not found/i.test(msg) ? "Create a public 'sprites' bucket first (see ADMIN_SETUP)." : "Upload failed: " + msg, "warn", 5000);
    }
  },
  async resetSlot(cat, item) {
    try {
      delete ASSET_OVERRIDES[`${cat}:${item}`];
      await Content.save("ASSET_OVERRIDES", { ...ASSET_OVERRIDES });
      UI.toast("Reverted to default sprite. Reload to apply.", "good");
      this.buildGallery();
    } catch (e) { UI.toast("Reset failed: " + ((e && e.message) || e), "warn"); }
  },
};

window.AdminUI = AdminUI;
