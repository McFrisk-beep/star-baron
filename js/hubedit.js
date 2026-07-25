/* hubedit.js — admin-only visual editor for the walkable hub map.

   Toggled from an "✎ Edit map" button on the hub (admins only). In edit mode the
   player is parked (Hub.editing) and the canvas becomes a paint surface:
     • Brushes — Floor / Wall / Door / Erase(void): click-drag to paint tiles.
       Non-rectangular rooms come free (erase to void; out-of-grid is solid).
     • Prop — drop a station on a tile; "solid" makes it block the player.
     • Select — click a prop to delete it or toggle its solid flag.
     • Room — switch / add / rename; Size — grow/shrink the grid; Background — a
       colour (#123 / rgb()) or a sprite key; Door target — where a placed door
       leads.
   Save persists the whole map to the `content` table (admin-write, public-read),
   so edits go live for everyone on reload — same mechanism as the rest of the
   admin content. Revert drops the override and restores the built-in map.

   The map data lives in window.HUB_ROOMS (see data.js); this module just mutates
   it in place and asks Hub to keep rendering.                                    */

const HubEdit = {
  tool: "floor", solid: false, doorTarget: null, sel: null, painting: false,
  bar: null, btn: null, status: null, on: false,

  el(tag, props = {}, kids = []) {
    const e = document.createElement(tag);
    for (const k in props) {
      if (k === "class") e.className = props[k];
      else if (k === "text") e.textContent = props[k];
      else if (k.startsWith("on")) e[k] = props[k];
      else e.setAttribute(k, props[k]);
    }
    for (const c of [].concat(kids)) if (c != null) e.append(c);
    return e;
  },

  init() {
    const scene = document.getElementById("hub-scene");
    if (!scene || this.btn) return;
    this.btn = this.el("button", { class: "hub-edit-btn", type: "button", text: "✎ Edit map", onclick: () => this.toggle(true) });
    scene.append(this.btn);
    this.refresh();
    if (window.Bus) Bus.on("auth", () => this.refresh());
  },
  admin() { return !!(window.Cloud && Cloud.isAdmin()); },
  refresh() { if (this.btn) this.btn.classList.toggle("hidden", !this.admin()); },

  toggle(on) {
    if (on && !this.admin()) return;
    this.on = on;
    if (on) { if (window.Hub) { Hub.editing = true; Hub._near = null; if (Hub.prompt) Hub.prompt.classList.add("hidden"); } this.buildBar(); this.bindCanvas(); }
    else { if (window.Hub) { Hub.editing = false; Hub._hoverTile = null; } this.unbindCanvas(); if (this.bar) { this.bar.remove(); this.bar = null; } }
    if (this.btn) this.btn.classList.toggle("hidden", on || !this.admin());
  },

  room() { return (window.HUB_ROOMS || {})[window.Hub && Hub.roomId] || null; },

  // ---- toolbar -------------------------------------------------------------
  buildBar() {
    const scene = document.getElementById("hub-scene"); if (!scene) return;
    if (this.bar) this.bar.remove();
    const brush = (id, label) => this.el("button", {
      class: "hbtn" + (this.tool === id ? " on" : ""), type: "button", "data-tool": id,
      text: label, onclick: () => this.setTool(id),
    });

    const roomSel = this.el("select", { class: "hsel", onchange: e => { Hub.setRoom(e.target.value); this.sel = null; } });
    for (const id of Object.keys(window.HUB_ROOMS || {})) roomSel.append(this.el("option", { value: id, text: (HUB_ROOMS[id].name || id) + " (" + id + ")" }));
    roomSel.value = Hub.roomId;

    const propSel = this.el("select", { class: "hsel" });
    for (const p of (window.HUB_PROPS || [])) propSel.append(this.el("option", { value: p.id, text: p.label }));
    this.propSel = propSel;

    const doorSel = this.el("select", { class: "hsel", onchange: e => { this.doorTarget = e.target.value; } });
    for (const id of Object.keys(window.HUB_ROOMS || {})) doorSel.append(this.el("option", { value: id, text: "→ " + id }));
    this.doorTarget = doorSel.value; this.doorSel = doorSel;

    const r = this.room() || { grid: [""] };
    const wIn = this.el("input", { class: "hnum", type: "number", min: "3", max: "40", value: (r.grid[0] || "").length });
    const hIn = this.el("input", { class: "hnum", type: "number", min: "3", max: "30", value: r.grid.length });
    const applySize = () => this.resizeGrid(+wIn.value | 0, +hIn.value | 0);
    wIn.onchange = applySize; hIn.onchange = applySize;

    const bgIn = this.el("input", { class: "htext", type: "text", placeholder: "#0b1024 or sprite key", value: r.bg || "" });
    bgIn.onchange = () => { const room = this.room(); if (room) { const v = bgIn.value.trim(); if (v) room.bg = v; else delete room.bg; } };

    const solid = this.el("input", { type: "checkbox" }); solid.checked = this.solid;
    solid.onchange = () => { this.solid = solid.checked; if (this.sel) { if (this.sel.solid = solid.checked) { /*noop*/ } if (!solid.checked) delete this.sel.solid; } };
    this.solidBox = solid;

    this.status = this.el("span", { class: "hstatus", text: "" });

    this.bar = this.el("div", { class: "hub-editbar" }, [
      this.el("div", { class: "hgrp" }, [brush("floor", "Floor"), brush("wall", "Wall"), brush("door", "Door"), brush("erase", "Erase"), brush("prop", "Prop"), brush("select", "Select")]),
      this.el("label", { class: "hlbl" }, [solid, this.el("span", { text: " solid" })]),
      this.el("div", { class: "hgrp" }, [this.el("span", { class: "hlbl", text: "prop" }), propSel, this.el("span", { class: "hlbl", text: "door→" }), doorSel]),
      this.el("div", { class: "hgrp" }, [this.el("span", { class: "hlbl", text: "room" }), roomSel,
        this.el("button", { class: "hbtn", type: "button", text: "＋", title: "Add room", onclick: () => this.addRoom() }),
        this.el("button", { class: "hbtn", type: "button", text: "✎", title: "Rename room", onclick: () => this.renameRoom() })]),
      this.el("div", { class: "hgrp" }, [this.el("span", { class: "hlbl", text: "size" }), wIn, this.el("span", { class: "hlbl", text: "×" }), hIn]),
      this.el("div", { class: "hgrp" }, [this.el("span", { class: "hlbl", text: "bg" }), bgIn]),
      this.el("div", { class: "hgrp hgrp-end" }, [
        this.el("button", { class: "hbtn hbtn-go", type: "button", text: "Save", onclick: () => this.save() }),
        this.el("button", { class: "hbtn", type: "button", text: "Revert", onclick: () => this.revert() }),
        this.el("button", { class: "hbtn", type: "button", text: "Done", onclick: () => this.toggle(false) }),
        this.status,
      ]),
    ]);
    scene.append(this.bar);
  },
  setTool(id) { this.tool = id; if (this.bar) for (const b of this.bar.querySelectorAll(".hbtn[data-tool]")) b.classList.toggle("on", b.dataset.tool === id); },
  say(msg, bad) { if (this.status) { this.status.textContent = msg; this.status.className = "hstatus" + (bad ? " bad" : ""); } },

  // ---- canvas paint --------------------------------------------------------
  bindCanvas() {
    const cv = window.Hub && Hub.canvas; if (!cv) return;
    this._down = e => { this.painting = true; this.apply(e, true); };
    this._move = e => { const t = Hub.screenToTile(e.clientX, e.clientY); Hub._hoverTile = t; if (this.painting) this.apply(e, false); };
    this._up = () => { this.painting = false; };
    cv.addEventListener("pointerdown", this._down);
    cv.addEventListener("pointermove", this._move);
    window.addEventListener("pointerup", this._up);
    cv.addEventListener("pointerleave", () => { Hub._hoverTile = null; });
  },
  unbindCanvas() {
    const cv = window.Hub && Hub.canvas; if (!cv) return;
    cv.removeEventListener("pointerdown", this._down);
    cv.removeEventListener("pointermove", this._move);
    window.removeEventListener("pointerup", this._up);
  },
  apply(e, isDown) {
    const room = this.room(); if (!room) return;
    const { tx, ty } = Hub.screenToTile(e.clientX, e.clientY);
    const cols = (room.grid[0] || "").length, rows = room.grid.length;
    if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) return;
    if (this.tool === "floor") this.setTile(tx, ty, ".");
    else if (this.tool === "wall") this.setTile(tx, ty, "#");
    else if (this.tool === "erase") { this.setTile(tx, ty, " "); this.rmProp(tx, ty); this.rmDoor(tx, ty); }
    else if (!isDown) return;   // the tools below act on click only, not drag
    else if (this.tool === "door") this.putDoor(tx, ty);
    else if (this.tool === "prop") this.putProp(tx, ty);
    else if (this.tool === "select") this.pick(tx, ty);
  },

  setTile(tx, ty, ch) {
    const room = this.room(); const row = room.grid[ty];
    room.grid[ty] = row.substring(0, tx) + ch + row.substring(tx + 1);
  },
  rmProp(tx, ty) { const r = this.room(); r.props = (r.props || []).filter(p => !(p.tx === tx && p.ty === ty)); },
  rmDoor(tx, ty) { const r = this.room(); r.doors = (r.doors || []).filter(d => !(d.tx === tx && d.ty === ty)); },
  putProp(tx, ty) {
    const id = this.propSel && this.propSel.value; if (!id) return;
    const r = this.room(); this.setTile(tx, ty, "."); this.rmProp(tx, ty);
    const p = { id, tx, ty }; if (this.solid) p.solid = true;
    (r.props = r.props || []).push(p); this.sel = p;
    this.say("placed " + id);
  },
  putDoor(tx, ty) {
    const r = this.room(); this.setTile(tx, ty, "+"); this.rmDoor(tx, ty);
    const to = this.doorTarget;
    if (to && HUB_ROOMS[to]) { (r.doors = r.doors || []).push({ tx, ty, to, spawn: (HUB_ROOMS[to].spawn || [1, 1]).slice() }); this.say("door → " + to); }
    else this.say("set a door target", true);
  },
  pick(tx, ty) {
    const r = this.room(); const p = (r.props || []).find(q => q.tx === tx && q.ty === ty);
    if (!p) { this.sel = null; this.say("empty tile"); return; }
    this.sel = p;
    if (this.solidBox) this.solidBox.checked = !!p.solid;
    this.solid = !!p.solid;
    if (confirm(`Prop "${p.id}" here.\nOK = toggle solid (${p.solid ? "on→off" : "off→on"}), Cancel = delete it.`)) {
      if (p.solid) delete p.solid; else p.solid = true; this.say("solid " + (p.solid ? "on" : "off"));
    } else { this.rmProp(tx, ty); this.sel = null; this.say("deleted " + p.id); }
  },
  resizeGrid(w, h) {
    w = Math.max(3, Math.min(40, w)); h = Math.max(3, Math.min(30, h));
    const r = this.room(); const old = r.grid; const g = [];
    for (let y = 0; y < h; y++) { let row = ""; for (let x = 0; x < w; x++) row += (y < old.length && x < (old[y] || "").length) ? old[y][x] : "."; g.push(row); }
    r.grid = g;
    r.props = (r.props || []).filter(p => p.tx < w && p.ty < h);
    r.doors = (r.doors || []).filter(d => d.tx < w && d.ty < h);
  },
  addRoom() {
    const id = (prompt("New room id (letters/numbers, no spaces):") || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!id) return; if (HUB_ROOMS[id]) return this.say("id exists", true);
    HUB_ROOMS[id] = { name: id, grid: ["#########", "#.......#", "#.......#", "#.......#", "#.......#", "#########"], spawn: [4, 3], doors: [], props: [], signs: [] };
    Hub.setRoom(id); this.buildBar(); this.say("added " + id);
  },
  renameRoom() {
    const r = this.room(); if (!r) return;
    const name = (prompt("Room display name:", r.name || Hub.roomId) || "").trim();
    if (name) { r.name = name; this.buildBar(); }
  },

  async save() {
    if (!window.Content) return this.say("no content module", true);
    this.say("saving…");
    try {
      // deep-copy: Content.save → apply() rewrites the live global from `value`,
      // so passing the global itself would empty it mid-apply.
      await Content.save("HUB_ROOMS", JSON.parse(JSON.stringify(window.HUB_ROOMS)));
      await Content.save("HUBCFG", JSON.parse(JSON.stringify(window.HUBCFG)));
      this.say("✓ saved — live for everyone on reload");
    } catch (e) { this.say("✗ " + (e.message || e), true); }
  },
  async revert() {
    if (!window.Content) return;
    if (!confirm("Revert the hub map to the built-in default? Your saved override is removed.")) return;
    try { await Content.reset("HUB_ROOMS"); await Content.reset("HUBCFG"); if (!HUB_ROOMS[Hub.roomId]) Hub.setRoom(Object.keys(HUB_ROOMS)[0]); this.buildBar(); this.say("✓ reverted"); }
    catch (e) { this.say("✗ " + (e.message || e), true); }
  },
};

window.HubEdit = HubEdit;
window.addEventListener("DOMContentLoaded", () => HubEdit.init());
