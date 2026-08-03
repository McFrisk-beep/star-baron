/* hub.js — walkable station hub as a top-down canvas tilemap.

   Rooms live in HUB_ROOMS (data.js) as ASCII tile art. Each room is its own
   screen; walking onto a door tile ('+') loads the connected room. Props are
   feature "stations": step within HUBCFG.interact tiles and a "▸ Open X" prompt
   appears — click it (or press E/Enter) to open that panel via UI.showPage(),
   the SAME nav path as the bottom tabs. Nothing auto-opens.

   No engine / no deps — one <canvas>, a tile grid, AABB wall collision, a fixed
   per-room camera (each room fits the screen), and a DOM prompt overlaid on the
   canvas so it stays a real, accessible button. Art is optional: an astronaut
   emoji + facing pip until you drop assets/hub/player.png (a 4-row walk sheet);
   prop art drops in at assets/hub/<id>.png.                                     */

const Hub = {
  _built: false, _active: false, _raf: null, _last: 0,
  scene: null, canvas: null, ctx: null, prompt: null,
  roomId: null, px: 1.5, py: 1.5, facing: "down", moving: false,
  keys: new Set(), target: null, _near: null, _armed: false,
  _frame: 0, _frameT: 0, _ts: 32, _ox: 0, _oy: 0, _w: 0, _h: 0,
  _imgs: {}, _playerImg: null, _bgImgs: {}, _decoImgs: {},
  editing: false, _hoverTile: null,   // set by the admin map editor (js/hubedit.js)
  _zoom: 1, _panx: 0, _pany: 0,       // edit-mode camera (1/0/0 = fit-to-screen; reset on exit)

  cfg() { return window.HUBCFG || { startRoom: "atrium", speed: 4.2, interact: 1.15, sheet: { cols: 4, rows: 4, order: ["down", "left", "right", "up"], fps: 8 } }; },
  rooms() { return window.HUB_ROOMS || {}; },
  room() { return this.rooms()[this.roomId] || null; },
  prop(id) { return (window.HUB_PROPS || []).find(p => p.id === id) || { id, label: id, icon: "▢", page: id }; },

  build() {
    if (this._built) return;
    this.scene = document.getElementById("hub-scene");
    this.canvas = document.getElementById("hub-canvas");
    this.prompt = document.getElementById("hub-prompt");
    if (!this.scene || !this.canvas) return;
    this.ctx = this.canvas.getContext("2d");

    const cfg = this.cfg();
    this.roomId = cfg.startRoom || Object.keys(this.rooms())[0];
    const sp = (this.room() && this.room().spawn) || [1, 1];
    this.px = sp[0] + 0.5; this.py = sp[1] + 0.5;

    // optional art (all lazy; falls back to emoji when a file is absent)
    const ps = new Image(); ps.onload = () => { this._playerImg = ps; }; ps.src = ASSET.hub("player");
    for (const p of (window.HUB_PROPS || [])) {
      const im = new Image(); im.onload = () => { this._imgs[p.id] = im; }; im.src = ASSET.hub(p.id);
    }

    window.addEventListener("keydown", e => this._key(e, true));
    window.addEventListener("keyup", e => this._key(e, false));
    this.canvas.addEventListener("pointerdown", e => this._point(e));
    if (this.prompt) this.prompt.addEventListener("click", () => this._open());

    this._built = true;
  },

  activate() {
    this.build();
    if (!this.ctx) return;
    this._active = true; this._last = performance.now();
    if (!this._raf) this._raf = requestAnimationFrame(t => this._loop(t));
  },
  deactivate() {
    this._active = false; this.keys.clear(); this.target = null; this.moving = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  },

  // ---- input ---------------------------------------------------------------
  _blocked() { return !!document.querySelector(".modal-backdrop:not(.hidden)"); },
  _typing() { const a = document.activeElement; return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); },
  _propAccess(page) {
    if (window.Stations && Stations.hubAccess) return Stations.hubAccess(page);
    return { ok: true };
  },
  _open() {
    const p = this._near; if (!p) return;
    const access = this._propAccess(p.page);
    if (!access.ok) {
      if (window.UI) UI.toast(access.reason || "Unavailable at this dock", "warn");
      return;
    }
    if (p.page === "starmap") { if (window.StarMap) StarMap.toggle(); }
    else if (window.UI) UI.showPage(p.page);
  },
  _key(e, down) {
    if (!this._active || this._typing() || this._blocked()) return;
    const k = (e.key || "").toLowerCase();
    const dir = { arrowup: "up", w: "up", arrowdown: "down", s: "down", arrowleft: "left", a: "left", arrowright: "right", d: "right" }[k];
    if (dir) { e.preventDefault(); if (down) this.keys.add(dir); else this.keys.delete(dir); this.target = null; }
    else if (down && (k === "e" || k === "enter") && this._near) { e.preventDefault(); this._open(); }
  },
  _point(e) {
    if (!this._active || this._blocked() || this.editing || !this._ts) return;
    const r = this.canvas.getBoundingClientRect();
    this.target = { x: (e.clientX - r.left - this._ox) / this._ts, y: (e.clientY - r.top - this._oy) / this._ts };
    this.keys.clear();
  },

  // ---- tiles / collision ---------------------------------------------------
  _tile(tx, ty) { const g = this.room() && this.room().grid; if (!g || ty < 0 || ty >= g.length) return "#"; const row = g[ty]; if (tx < 0 || tx >= row.length) return "#"; return row[tx]; },
  _solidPropAt(tx, ty) { return ((this.room() && this.room().props) || []).some(p => p.solid && p.tx === tx && p.ty === ty); },
  // A solid decoration blocks every tile its (fractional) bounding box overlaps.
  _solidDecoAt(tx, ty) {
    return ((this.room() && this.room().deco) || []).some(d => d.solid &&
      tx >= Math.floor(d.x) && tx < Math.ceil(d.x + (d.w || 1)) &&
      ty >= Math.floor(d.y) && ty < Math.ceil(d.y + (d.h || 1)));
  },
  _walk(tx, ty) { const c = this._tile(tx, ty); if (c !== "." && c !== "+") return false; return !this._solidPropAt(tx, ty) && !this._solidDecoAt(tx, ty); },
  // lazy image cache for decorations (arbitrary sprite paths); mirrors _bgImgs
  _decoImg(src) {
    let im = this._decoImgs[src];
    if (!im) { im = new Image(); im.src = src; this._decoImgs[src] = im; }
    return im;
  },
  // client px → tile coords (used by the editor); relies on the last render's layout
  screenToTile(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    return { tx: Math.floor((cx - r.left - this._ox) / this._ts), ty: Math.floor((cy - r.top - this._oy) / this._ts) };
  },
  // fractional tile coords (used by the editor for free / sub-tile decoration placement)
  screenToTileF(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (cx - r.left - this._ox) / this._ts, y: (cy - r.top - this._oy) / this._ts };
  },
  // ---- edit-mode camera ----------------------------------------------------
  resetCam() { this._zoom = 1; this._panx = 0; this._pany = 0; },
  // Zoom by `factor` keeping the world point under (cx,cy) fixed on screen (zoom-to-cursor).
  zoomAt(cx, cy, factor) {
    const cw = this.scene.clientWidth, ch = this.scene.clientHeight; if (!cw || !ch) return;
    const room = this.room(); if (!room) return;
    const cols = room.grid[0].length, rows = room.grid.length;
    const baseTs = Math.floor(Math.min(cw / (cols + 0.5), ch / (rows + 0.5)));
    const tf = this.screenToTileF(cx, cy);                 // world tile under the cursor (pre-zoom)
    this._zoom = Math.max(0.25, Math.min(8, this._zoom * factor));
    const ts = Math.max(1, Math.round(baseTs * this._zoom));
    const r = this.canvas.getBoundingClientRect();
    // solve pan so tf stays under the cursor: ox = (cx-left) - tf.x*ts  and  ox = (cw-ts*cols)/2 + panx
    this._panx = (cx - r.left) - tf.x * ts - (cw - ts * cols) / 2;
    this._pany = (cy - r.top) - tf.y * ts - (ch - ts * rows) / 2;
  },
  panBy(dx, dy) { this._panx += dx; this._pany += dy; },
  setRoom(id) {
    if (!this.rooms()[id]) return;
    this.roomId = id;
    const sp = this.room().spawn || [1, 1];
    this.px = sp[0] + 0.5; this.py = sp[1] + 0.5;
    this._near = null; if (this.prompt) this.prompt.classList.add("hidden");
  },
  _canMove(x, y) {
    const h = 0.30;
    return this._walk(Math.floor(x - h), Math.floor(y - h)) && this._walk(Math.floor(x + h), Math.floor(y - h))
        && this._walk(Math.floor(x - h), Math.floor(y + h)) && this._walk(Math.floor(x + h), Math.floor(y + h));
  },

  // ---- loop ----------------------------------------------------------------
  _loop(t) {
    if (!this._active) { this._raf = null; return; }
    const dt = Math.min(0.05, (t - this._last) / 1000); this._last = t;
    this._update(dt); this._render();
    this._raf = requestAnimationFrame(x => this._loop(x));
  },
  _update(dt) {
    if (this.editing) { this.moving = false; return; }   // editor drives the canvas; player is parked
    if (this._blocked()) { this.keys.clear(); this.target = null; this.moving = false; return; }
    let ix = 0, iy = 0;
    if (this.keys.size) {
      if (this.keys.has("left")) ix -= 1; if (this.keys.has("right")) ix += 1;
      if (this.keys.has("up")) iy -= 1; if (this.keys.has("down")) iy += 1;
    } else if (this.target) {
      ix = this.target.x - this.px; iy = this.target.y - this.py;
      if (Math.hypot(ix, iy) < 0.12) { this.target = null; ix = iy = 0; }
    }
    const len = Math.hypot(ix, iy);
    let moving = false;
    if (len > 0.001) {
      const step = (this.cfg().speed || 4.2) * dt;
      const ux = ix / len, uy = iy / len;
      const nx = this.px + ux * step, ny = this.py + uy * step;
      if (this._canMove(nx, this.py)) { this.px = nx; moving = true; }
      if (this._canMove(this.px, ny)) { this.py = ny; moving = true; }
      this.facing = Math.abs(ux) > Math.abs(uy) ? (ux < 0 ? "left" : "right") : (uy < 0 ? "up" : "down");
    }
    this.moving = moving;

    // door transitions: walk onto a '+' tile (armed = must leave a door first)
    const ctx = Math.floor(this.px), cty = Math.floor(this.py);
    if (this._tile(ctx, cty) === "+") {
      if (this._armed) {
        const d = (this.room().doors || []).find(dr => dr.tx === ctx && dr.ty === cty);
        if (d) return this._enter(d);
      }
    } else { this._armed = true; }

    // frame animation
    const sh = this.cfg().sheet;
    if (moving) { this._frameT += dt; if (this._frameT >= 1 / sh.fps) { this._frameT = 0; this._frame = (this._frame + 1) % sh.cols; } }
    else { this._frame = 0; this._frameT = 0; }

    this._proximity();
  },
  _enter(door) {
    this.roomId = door.to;
    const sp = door.spawn || (this.room() && this.room().spawn) || [1, 1];
    this.px = sp[0] + 0.5; this.py = sp[1] + 0.5;
    this._armed = false; this.keys.clear(); this.target = null; this._near = null;
    if (this.prompt) this.prompt.classList.add("hidden");
  },
  _proximity() {
    const props = (this.room() && this.room().props) || [];
    const rad = this.cfg().interact || 1.15;
    let best = null, bestD = Infinity;
    for (const pr of props) {
      const d = Math.hypot(pr.tx + 0.5 - this.px, pr.ty + 0.5 - this.py);
      if (d < rad && d < bestD) { bestD = d; best = pr; }
    }
    if (!best) {
      this._near = null;
      if (this.prompt) { this.prompt.classList.add("hidden"); this.prompt.classList.remove("hub-prompt-locked"); }
      return;
    }
    const meta = this.prop(best.id);
    const access = this._propAccess(meta.page);
    const locked = !access.ok;
    const changed = !this._near || this._near._room !== best.id || this._near.locked !== locked || this._near.reason !== access.reason;
    this._near = { id: best.id, page: meta.page, label: meta.label, _room: best.id, tx: best.tx, ty: best.ty, locked, reason: access.reason };
    if (changed && this.prompt) {
      const open = (window.I18n ? I18n.t("hub.open", "Open {x}") : "Open {x}").replace("{x}", meta.label);
      this.prompt.textContent = access.ok ? ("▸ " + open) : ("▹ " + meta.label + " — " + (access.reason || "unavailable"));
      this.prompt.setAttribute("aria-label", access.ok ? ("Open " + meta.label) : (meta.label + " unavailable"));
      this.prompt.classList.toggle("hub-prompt-locked", locked);
      this.prompt.classList.remove("hidden");
    }
  },

  // ---- render --------------------------------------------------------------
  _render() {
    const scene = this.scene, cv = this.canvas, ctx = this.ctx;
    const cw = scene.clientWidth, ch = scene.clientHeight; if (!cw || !ch) return;
    const dpr = window.devicePixelRatio || 1;
    if (this._w !== cw || this._h !== ch) {
      this._w = cw; this._h = ch;
      cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const room = this.room(); if (!room) return;
    const cols = room.grid[0].length, rows = room.grid.length;
    // fit-to-screen tile size, then apply the edit-mode camera (zoom around centre + pan)
    const baseTs = Math.floor(Math.min(cw / (cols + 0.5), ch / (rows + 0.5)));
    const ts = Math.max(1, Math.round(baseTs * this._zoom));
    const ox = Math.round((cw - ts * cols) / 2 + this._panx), oy = Math.round((ch - ts * rows) / 2 + this._pany);
    this._ts = ts; this._ox = ox; this._oy = oy;

    // per-room background (color like "#123" / "rgb(...)", or a sprite key/path), behind the tiles
    const bg = room.bg;
    if (bg) {
      const rw = ts * cols, rh = ts * rows;
      if (/^(#|rgb|hsl)/i.test(bg)) { ctx.fillStyle = bg; ctx.fillRect(ox, oy, rw, rh); }
      else {
        let im = this._bgImgs[bg];
        if (!im) { im = new Image(); im.src = /[./]/.test(bg) ? bg : ASSET.hub(bg); this._bgImgs[bg] = im; }
        if (im.complete && im.naturalWidth) ctx.drawImage(im, ox, oy, rw, rh);
      }
    }

    // tiles
    for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
      const c = room.grid[ty][tx]; const x = ox + tx * ts, y = oy + ty * ts;
      if (c === "#") {
        ctx.fillStyle = "#0e1730"; ctx.fillRect(x, y, ts, ts);
        ctx.fillStyle = "#22315a"; ctx.fillRect(x, y, ts, Math.max(2, ts * 0.14)); // top edge
      } else if (c === "." || c === "+") {
        ctx.fillStyle = ((tx + ty) & 1) ? "#243a63" : "#26406e"; ctx.fillRect(x, y, ts, ts);
        ctx.strokeStyle = "rgba(255,255,255,.035)"; ctx.strokeRect(x + 0.5, y + 0.5, ts - 1, ts - 1);
        if (c === "+") { ctx.fillStyle = "rgba(90,200,220,.30)"; ctx.fillRect(x + ts * 0.15, y + ts * 0.15, ts * 0.7, ts * 0.7); }
      }
    }

    // signs (door labels / room hints)
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `${Math.max(9, Math.floor(ts * 0.26))}px system-ui, sans-serif`;
    ctx.fillStyle = "rgba(190,210,255,.72)";
    for (const s of (room.signs || [])) ctx.fillText(s.text, ox + (s.tx + 0.5) * ts, oy + (s.ty + 0.5) * ts);

    // decorations — free-placed sprites (x,y,w,h in tile units); drawn on the floor,
    // beneath stations and the player. Solid ones get a faint outline in edit mode.
    for (const d of (room.deco || [])) {
      const im = this._decoImg(d.src);
      if (im.complete && im.naturalWidth) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(im, ox + d.x * ts, oy + d.y * ts, (d.w || 1) * ts, (d.h || 1) * ts);
      } else {
        ctx.fillStyle = "rgba(120,150,220,.25)";
        ctx.fillRect(ox + d.x * ts, oy + d.y * ts, (d.w || 1) * ts, (d.h || 1) * ts);
      }
    }

    // props (gray out when the current dock lacks that service / module)
    for (const pr of (room.props || [])) {
      const meta = this.prop(pr.id);
      const locked = !this._propAccess(meta.page).ok;
      const sx = ox + (pr.tx + 0.5) * ts, sy = oy + (pr.ty + 0.5) * ts;
      ctx.globalAlpha = locked ? 0.38 : 1;
      ctx.fillStyle = locked ? "rgba(28,34,52,.85)" : "rgba(40,58,110,.85)";
      this._roundRect(ctx, sx - ts * 0.42, sy - ts * 0.42, ts * 0.84, ts * 0.84, ts * 0.16); ctx.fill();
      ctx.strokeStyle = locked ? "rgba(90,100,130,.35)" : "rgba(130,160,230,.45)"; ctx.stroke();
      const img = this._imgs[pr.id];
      if (img) ctx.drawImage(img, sx - ts * 0.36, sy - ts * 0.36, ts * 0.72, ts * 0.72);
      else { ctx.font = `${Math.floor(ts * 0.5)}px system-ui, "Segoe UI Emoji", "Noto Color Emoji"`; ctx.fillStyle = locked ? "#889" : "#fff"; ctx.fillText(meta.icon, sx, sy + 1); }
      ctx.font = `${Math.max(9, Math.floor(ts * 0.22))}px system-ui, sans-serif`;
      ctx.fillStyle = locked ? "rgba(140,150,170,.7)" : "rgba(220,230,255,.85)";
      ctx.fillText(meta.label, sx, sy + ts * 0.62);
      ctx.globalAlpha = 1;
    }

    // player
    this._drawPlayer(ox + this.px * ts, oy + this.py * ts, ts);

    // room name (top-left)
    ctx.textAlign = "left"; ctx.font = `600 ${Math.max(11, Math.floor(ts * 0.32))}px system-ui, sans-serif`;
    ctx.fillStyle = "rgba(200,216,255,.6)"; ctx.fillText(room.name || "", 12, 18);

    // prompt overlay position
    if (this._near && this.prompt && !this.prompt.classList.contains("hidden")) {
      this.prompt.style.left = (ox + (this._near.tx + 0.5) * ts) + "px";
      this.prompt.style.top = (oy + this._near.ty * ts - ts * 0.15) + "px";
    }

    if (this.editing) this._editOverlay(ox, oy, ts, cols, rows, room);
  },
  // Edit-mode overlay: a grid, red rings on solid props, and the hovered tile.
  _editOverlay(ox, oy, ts, cols, rows, room) {
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(255,255,255,.08)"; ctx.lineWidth = 1;
    for (let x = 0; x <= cols; x++) { ctx.beginPath(); ctx.moveTo(ox + x * ts, oy); ctx.lineTo(ox + x * ts, oy + rows * ts); ctx.stroke(); }
    for (let y = 0; y <= rows; y++) { ctx.beginPath(); ctx.moveTo(ox, oy + y * ts); ctx.lineTo(ox + cols * ts, oy + y * ts); ctx.stroke(); }
    for (const p of (room.props || [])) if (p.solid) {
      ctx.strokeStyle = "rgba(255,90,90,.9)"; ctx.lineWidth = 2;
      ctx.strokeRect(ox + p.tx * ts + 2, oy + p.ty * ts + 2, ts - 4, ts - 4);
    }
    // decorations: red box if solid, cyan box + handle on the selected one
    const selDeco = window.HubEdit && HubEdit.selDeco;
    for (const d of (room.deco || [])) {
      const x = ox + d.x * ts, y = oy + d.y * ts, w = (d.w || 1) * ts, h = (d.h || 1) * ts;
      if (d.solid) { ctx.strokeStyle = "rgba(255,90,90,.9)"; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2); }
      if (d === selDeco) {
        ctx.strokeStyle = "rgba(150,220,255,.95)"; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = "rgba(150,220,255,.95)"; ctx.fillRect(x + w - 8, y + h - 8, 8, 8);   // resize handle
      }
    }
    const h = this._hoverTile;
    if (h && h.tx >= 0 && h.ty >= 0 && h.tx < cols && h.ty < rows) {
      ctx.fillStyle = "rgba(120,200,255,.22)"; ctx.fillRect(ox + h.tx * ts, oy + h.ty * ts, ts, ts);
      ctx.strokeStyle = "rgba(150,220,255,.9)"; ctx.lineWidth = 2; ctx.strokeRect(ox + h.tx * ts + 1, oy + h.ty * ts + 1, ts - 2, ts - 2);
    }
  },
  _drawPlayer(sx, sy, ts) {
    const ctx = this.ctx, sh = this.cfg().sheet;
    const img = this._playerImg;
    if (img && img.naturalWidth) {
      const fw = img.naturalWidth / sh.cols, fh = img.naturalHeight / sh.rows;
      const row = Math.max(0, sh.order.indexOf(this.facing));
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, this._frame * fw, row * fh, fw, fh, sx - ts * 0.5, sy - ts * 0.62, ts, ts);
      return;
    }
    // emoji fallback + facing pip + shadow
    ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.beginPath(); ctx.ellipse(sx, sy + ts * 0.34, ts * 0.26, ts * 0.10, 0, 0, 7); ctx.fill();
    const off = ts * 0.30 * (this.moving ? 1 : 0.85);
    const fp = { up: [0, -off], down: [0, off], left: [-off, 0], right: [off, 0] }[this.facing] || [0, off];
    ctx.fillStyle = "rgba(130,180,255,.95)"; ctx.beginPath(); ctx.arc(sx + fp[0], sy + fp[1], ts * 0.09, 0, 7); ctx.fill();
    const bob = this.moving ? Math.sin(performance.now() / 90) * ts * 0.05 : 0;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `${Math.floor(ts * 0.72)}px system-ui, "Segoe UI Emoji", "Noto Color Emoji"`;
    ctx.save(); ctx.translate(sx, sy - ts * 0.06 + bob);
    if (this.facing === "left") ctx.scale(-1, 1);
    ctx.fillText(this.cfg().playerEmoji || "🧑‍🚀", 0, 0); ctx.restore();
  },
  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  },
};

window.Hub = Hub;
