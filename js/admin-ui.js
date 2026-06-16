/* admin-ui.js — the admin-only control panel. Reveals the dev toggles and the
   "Admin" button for admins (hidden for players/guests), and provides a content
   editor over the collections in content.js: pick a collection, edit its JSON,
   validate, save (to Supabase) or reset to default. Role comes from Cloud and is
   set server-side, so a player can't grant themselves access.                   */

const AdminUI = {
  r: {},
  key: null,

  init() {
    const $ = id => document.getElementById(id);
    this.r = {
      btn: $("btn-admin"), modal: $("admin-modal"), close: $("admin-close"),
      select: $("admin-collection"), editor: $("admin-json"),
      status: $("admin-status"), validate: $("admin-validate"),
      save: $("admin-save"), reset: $("admin-reset"),
      devToggles: $("dev-toggles"),
    };
    if (this.r.btn) this.r.btn.onclick = () => this.open();
    if (this.r.close) this.r.close.onclick = () => this.r.modal.classList.add("hidden");
    if (this.r.select) this.r.select.onchange = () => this.loadCollection(this.r.select.value);
    if (this.r.validate) this.r.validate.onclick = () => this.validate();
    if (this.r.save) this.r.save.onclick = () => this.doSave();
    if (this.r.reset) this.r.reset.onclick = () => this.doReset();

    if (window.Bus) Bus.on("auth", () => this.refresh());
    this.populate();
    this.refresh();
  },

  // Admin-only chrome: show/hide the Admin button + the dev toggles by role.
  refresh() {
    const admin = !!(window.Cloud && Cloud.isAdmin());
    if (this.r.btn) this.r.btn.classList.toggle("hidden", !admin);
    if (this.r.devToggles) this.r.devToggles.classList.toggle("hidden", !admin);
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

  open() {
    if (!window.Cloud || !Cloud.isAdmin()) return;
    this.r.modal.classList.remove("hidden");
    this.loadCollection(this.r.select.value || (Content.COLLECTIONS[0] && Content.COLLECTIONS[0].key));
  },

  loadCollection(key) {
    this.key = key;
    const val = Content.current(key);
    this.r.editor.value = JSON.stringify(val, null, 2);
    const m = Content.meta(key);
    this.setStatus(m && m.group === "data"
      ? "Tip: item/rule edits apply fully after a reload."
      : "Edits apply live once saved.", "");
  },

  parse() {
    try { return { ok: true, value: JSON.parse(this.r.editor.value) }; }
    catch (e) { return { ok: false, error: e.message }; }
  },
  validate() {
    const p = this.parse();
    this.setStatus(p.ok ? "✓ Valid JSON." : "✗ " + p.error, p.ok ? "good" : "bad");
    return p;
  },

  async doSave() {
    const p = this.validate(); if (!p.ok) return;
    this.setStatus("Saving…", "");
    try {
      await Content.save(this.key, p.value);
      const m = Content.meta(this.key);
      this.setStatus(m && m.group === "data"
        ? "✓ Saved. Reload to apply everywhere."
        : "✓ Saved & applied live.", "good");
      if (window.UI) UI.toast(`Saved "${m ? m.label : this.key}".`, "good");
    } catch (e) { this.setStatus("✗ " + (e.message || e), "bad"); }
  },

  async doReset() {
    if (!confirm("Reset this collection to the built-in default? Your saved override is removed.")) return;
    this.setStatus("Resetting…", "");
    try {
      await Content.reset(this.key);
      this.loadCollection(this.key);
      this.setStatus("✓ Reset to default.", "good");
    } catch (e) { this.setStatus("✗ " + (e.message || e), "bad"); }
  },

  setStatus(msg, kind) {
    if (!this.r.status) return;
    this.r.status.textContent = msg;
    this.r.status.className = "admin-status" + (kind ? " " + kind : "");
  },
};

window.AdminUI = AdminUI;
