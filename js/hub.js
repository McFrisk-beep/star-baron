/* hub.js — Phase B: a walkable 4-direction character for the station hub.

   The hub scene + kiosks are built by UI.renderHub() (see ui.js). This module
   adds the player and the proximity prompt on top, and runs the movement loop
   only while the Hub page is active. Design points:
   • Movement: arrows / WASD (held), or tap-to-walk toward a point (mobile too).
   • No auto-open: coming within HUBCFG.radius of a kiosk raises a "▸ Open X"
     prompt; clicking it (or pressing E/Enter) calls UI.showPage(kiosk.page) —
     the SAME nav path as the tabs. Kiosks stay directly clickable too.
   • Position persists: the scene DOM survives tab switches (just hidden), and we
     never re-spawn, so returning to the Hub leaves you where you left off.
   • Art is optional: assets/hub/player.png (a 4-row walk sheet) is used if
     present; otherwise the astronaut emoji + a facing pip.                       */

const Hub = {
  _built: false, _active: false, _raf: null, _last: 0,
  fx: 0.5, fy: 0.88, facing: "down", moving: false, _near: null,
  keys: new Set(), target: null, _frame: 0, _frameT: 0,
  scene: null, player: null, avatar: null, sprite: null, prompt: null,

  cfg() { return window.HUBCFG || { speed: 0.36, radius: 0.12, spawn: { x: 50, y: 88 }, sheet: { cols: 4, rows: 4, order: ["down", "left", "right", "up"], fps: 8 } }; },

  build() {
    if (this._built) return;
    this.scene = document.getElementById("hub-scene");
    if (!this.scene) return;
    const cfg = this.cfg();

    const player = document.createElement("div"); player.className = "hub-player";
    const sprite = document.createElement("div"); sprite.className = "hub-sprite";
    const facingPip = document.createElement("span"); facingPip.className = "hub-facing";
    const avatar = document.createElement("span"); avatar.className = "hub-avatar"; avatar.textContent = cfg.playerEmoji || "🧑‍🚀";
    player.append(sprite, facingPip, avatar);
    this.scene.append(player);
    this.player = player; this.avatar = avatar; this.sprite = sprite;

    // optional 4-direction walk sheet (assets/hub/player.png)
    const sheet = new Image();
    sheet.onload = () => { player.classList.add("has-sprite"); sprite.style.backgroundImage = `url("${ASSET.hub("player")}")`; };
    sheet.onerror = () => {};
    sheet.src = ASSET.hub("player");

    const prompt = document.createElement("button"); prompt.type = "button"; prompt.className = "hub-prompt hidden";
    prompt.addEventListener("click", () => this._open());
    this.scene.append(prompt); this.prompt = prompt;

    const sp = cfg.spawn || { x: 50, y: 88 };
    this.fx = sp.x / 100; this.fy = sp.y / 100;

    window.addEventListener("keydown", e => this._key(e, true));
    window.addEventListener("keyup", e => this._key(e, false));
    this.scene.addEventListener("pointerdown", e => this._point(e));

    this._built = true;
    this._place();
  },

  activate() {
    this.build();
    if (!this.scene) return;
    this._active = true;
    this._last = performance.now();
    if (!this._raf) this._raf = requestAnimationFrame(t => this._loop(t));
  },
  deactivate() {
    this._active = false;
    this.keys.clear(); this.target = null; this.moving = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  },

  // ---- input ---------------------------------------------------------------
  _blocked() { return !!document.querySelector(".modal-backdrop:not(.hidden)"); },
  _typing() { const a = document.activeElement; return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); },
  _open() {
    const p = this._near; if (!p) return;
    if (p.page === "starmap") { if (window.StarMap) StarMap.toggle(); }
    else if (window.UI) UI.showPage(p.page);
  },
  _key(e, down) {
    if (!this._active || this._typing() || this._blocked()) return;
    const k = (e.key || "").toLowerCase();
    const dir = { arrowup: "up", w: "up", arrowdown: "down", s: "down", arrowleft: "left", a: "left", arrowright: "right", d: "right" }[k];
    if (dir) {
      e.preventDefault();
      if (down) this.keys.add(dir); else this.keys.delete(dir);
      this.target = null;
    } else if (down && (k === "e" || k === "enter") && this._near) {
      e.preventDefault(); this._open();
    }
  },
  _point(e) {
    if (!this._active || this._blocked()) return;
    if (e.target.closest(".hub-hotspot") || e.target.closest(".hub-prompt")) return;   // let those handle their own click
    const r = this.scene.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.target = { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height };
    this.keys.clear();
  },

  // ---- loop ----------------------------------------------------------------
  _loop(t) {
    if (!this._active) { this._raf = null; return; }
    const dt = Math.min(0.05, (t - this._last) / 1000); this._last = t;
    this._update(dt);
    this._raf = requestAnimationFrame(x => this._loop(x));
  },
  _update(dt) {
    const r = this.scene.getBoundingClientRect(); const W = r.width, H = r.height;
    if (!W || !H) return;
    if (this._blocked()) { this.keys.clear(); this.target = null; this.moving = false; this._place(); return; }
    const cfg = this.cfg();

    // desired direction (px vector)
    let vx = 0, vy = 0;
    if (this.keys.size) {
      if (this.keys.has("left")) vx -= 1; if (this.keys.has("right")) vx += 1;
      if (this.keys.has("up")) vy -= 1; if (this.keys.has("down")) vy += 1;
      vx *= W; vy *= H;   // treat key axes in px so diagonals feel even
    } else if (this.target) {
      vx = (this.target.fx - this.fx) * W; vy = (this.target.fy - this.fy) * H;
    }

    const len = Math.hypot(vx, vy);
    let moving = false;
    if (len > 1.5) {
      moving = true;
      const step = (cfg.speed || 0.36) * W * dt;   // px this frame
      const ux = vx / len, uy = vy / len;
      let npx = this.fx * W + ux * step, npy = this.fy * H + uy * step;
      if (this.target && !this.keys.size && len <= step) { npx = this.target.fx * W; npy = this.target.fy * H; this.target = null; moving = false; }
      const padX = W * 0.04;
      npx = Math.max(padX, Math.min(W - padX, npx));
      npy = Math.max(H * 0.10, Math.min(H * 0.94, npy));
      this.fx = npx / W; this.fy = npy / H;
      this.facing = Math.abs(ux) > Math.abs(uy) ? (ux < 0 ? "left" : "right") : (uy < 0 ? "up" : "down");
    }
    this.moving = moving;
    this._place();
    this._anim(dt, moving);
    this._proximity(W, H);
  },

  _place() {
    if (!this.player) return;
    this.player.style.left = (this.fx * 100) + "%";
    this.player.style.top = (this.fy * 100) + "%";
    this.player.dataset.facing = this.facing;
    this.player.classList.toggle("walk", this.moving);
  },
  _anim(dt, moving) {
    if (!this.player.classList.contains("has-sprite")) return;
    const sh = this.cfg().sheet || { cols: 4, rows: 4, order: ["down", "left", "right", "up"], fps: 8 };
    const row = Math.max(0, sh.order.indexOf(this.facing));
    if (moving) { this._frameT += dt; if (this._frameT >= 1 / sh.fps) { this._frameT = 0; this._frame = (this._frame + 1) % sh.cols; } }
    else { this._frame = 0; this._frameT = 0; }
    this.sprite.style.backgroundSize = (sh.cols * 100) + "% " + (sh.rows * 100) + "%";
    const bx = sh.cols > 1 ? (this._frame / (sh.cols - 1)) * 100 : 0;
    const by = sh.rows > 1 ? (row / (sh.rows - 1)) * 100 : 0;
    this.sprite.style.backgroundPosition = bx + "% " + by + "%";
  },
  _proximity(W, H) {
    const props = window.HUB_PROPS || [];
    const radius = (this.cfg().radius || 0.12) * W;
    const px = this.fx * W, py = this.fy * H;
    let best = null, bestD = Infinity;
    for (const p of props) {
      const d = Math.hypot(p.x / 100 * W - px, p.y / 100 * H - py);
      if (d < radius && d < bestD) { bestD = d; best = p; }
    }
    if (best !== this._near) {
      this._near = best;
      if (best) {
        this.prompt.textContent = "▸ " + ((window.I18n ? I18n.t("hub.open", "Open {x}") : "Open {x}").replace("{x}", best.label));
        this.prompt.setAttribute("aria-label", "Open " + best.label);
        this.prompt.classList.remove("hidden");
      } else {
        this.prompt.classList.add("hidden");
      }
    }
    if (best) {
      const iconHalfPct = Math.min(0.065 * W, 58) / H * 100;   // half a kiosk's height, in % of scene height
      this.prompt.style.left = best.x + "%";
      this.prompt.style.top = (best.y - iconHalfPct - 3) + "%";
    }
  },
};

window.Hub = Hub;
