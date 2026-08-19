/* bgm.js — background-music playlist. Git is the source of truth: every file in
   assets/bgm/ is a track (baked into BGM_TRACKS by tools/gen_media_manifest.py)
   and the loop runs through all of them. Each player then picks their own order
   and start track in Settings → Music. Playback starts after the first user
   gesture (browser autoplay policy). Volume/mute come from Game.state.settings. */

const Bgm = {
  el: null,
  idx: 0,
  _armed: false,
  _failStreak: 0,
  _srcUrl: null,          // manifest url currently loaded into el (see play())

  // The shipped playlist, in manifest (file-name) order.
  all() {
    const list = window.BGM_TRACKS;
    if (!Array.isArray(list)) return [];
    return list.filter(t => t && typeof t.url === "string" && t.url);
  },

  settings() { return (window.Game && Game.state && Game.state.settings) || {}; },

  // Saved order is player data — treat it as untrusted: keep only strings, and
  // let the lookups below silently drop urls that no longer ship.
  savedOrder() {
    const o = this.settings().bgmOrder;
    return Array.isArray(o) ? o.filter(u => typeof u === "string" && u) : [];
  },

  // Playlist = the player's saved order, then anything they've never seen (a
  // song added by a later deploy) appended in manifest order.
  tracks() {
    const all = this.all();
    const order = this.savedOrder();
    if (!order.length) return all;
    const byUrl = new Map(all.map(t => [t.url, t]));
    const out = [];
    for (const url of order) {
      const t = byUrl.get(url);
      if (t) { out.push(t); byUrl.delete(url); }   // delete = dupes in the save collapse
    }
    for (const t of all) if (byUrl.has(t.url)) out.push(t);
    return out;
  },

  // The track playing right now (or the one queued up), for UI highlighting.
  current() { const t = this.tracks()[this.idx]; return t ? t.url : ""; },

  // Point idx back at `url` so a reorder doesn't restart what's playing.
  reindex(url) {
    const i = this.tracks().findIndex(t => t.url === url);
    if (i >= 0) this.idx = i;
  },

  // Player reorder: swap two rows and persist the new order. Returns false when
  // the move runs off either end so the caller can skip a re-render.
  move(index, dir) {
    const tracks = this.tracks();
    const j = index + dir;
    if (index < 0 || index >= tracks.length || j < 0 || j >= tracks.length) return false;
    const playing = this.current();
    const next = tracks.slice();
    const tmp = next[index]; next[index] = next[j]; next[j] = tmp;
    this.settings().bgmOrder = next.map(t => t.url);
    this.reindex(playing);
    return true;
  },

  // Player's start track — where the loop begins on load. Jumping to it now is
  // the feedback that says "this one".
  startUrl() {
    const u = this.settings().bgmStart;
    return typeof u === "string" ? u : "";
  },
  setStart(url) {
    this.settings().bgmStart = String(url || "");
    const i = this.tracks().findIndex(t => t.url === url);
    if (i < 0) return;
    this.idx = i;
    this.play(true);
  },

  volume() {
    const s = this.settings();
    if (s.muted) return 0;
    const v = s.volume == null ? 0.25 : +s.volume;
    return Util.clamp(Number.isFinite(v) ? v : 0.25, 0, 1);
  },

  ensure() {
    if (this.el) return this.el;
    const a = document.createElement("audio");
    a.preload = "auto";
    a.setAttribute("playsinline", "");
    a.addEventListener("ended", () => { this._failStreak = 0; this.next(); });
    a.addEventListener("playing", () => { this._failStreak = 0; });
    a.addEventListener("error", () => {
      // Bound consecutive failures so a dead bucket can't hammer the network.
      this._failStreak++;
      const n = Math.max(1, this.tracks().length);
      if (this._failStreak >= n) { this.stop(); return; }
      this.next();
    });
    this.el = a;
    return a;
  },

  // Call whenever the effective playlist changes (boot, or a settings edit).
  sync() {
    const tracks = this.tracks();
    if (!tracks.length) { this.stop(); return; }
    this.idx = ((this.idx % tracks.length) + tracks.length) % tracks.length;
    this.applyVolume();
    if (this._armed && !document.hidden) this.play(false);
  },

  applyVolume() {
    const a = this.ensure();
    a.volume = this.volume();
    if (a.volume <= 0) { try { a.pause(); } catch (e) { /* ignore */ } }
    else if (this._armed && !document.hidden && a.paused && this.tracks().length)
      this.play(false);
  },

  play(restart = true) {
    const tracks = this.tracks();
    if (!tracks.length) return;
    const a = this.ensure();
    const t = tracks[this.idx % tracks.length];
    // a.src reads back resolved AND percent-encoded ("1.%20Abandoned%20Outpost.mp3"),
    // so comparing it to the manifest url misses on any name with a space and
    // every resume restarts the song. Remember what we loaded instead.
    if (restart || !a.src || this._srcUrl !== t.url) {
      a.src = t.url;
      this._srcUrl = t.url;
      try { a.load(); } catch (e) { /* ignore */ }
    }
    a.volume = this.volume();
    if (a.volume <= 0) return;
    const p = a.play();
    if (p && typeof p.catch === "function") p.catch(() => { /* wait for gesture */ });
  },

  next() {
    const tracks = this.tracks();
    if (!tracks.length) return;
    this.idx = (this.idx + 1) % tracks.length;
    this.play(true);
  },

  stop() {
    this._failStreak = 0;
    if (!this.el) return;
    try { this.el.pause(); } catch (e) { /* ignore */ }
    this.el.removeAttribute("src");
    this._srcUrl = null;
    try { this.el.load(); } catch (e) { /* ignore */ }
  },

  pause() { if (this.el) try { this.el.pause(); } catch (e) { /* ignore */ } },

  // Arm autoplay after the first click/key — browsers block sound until then.
  arm() {
    if (this._armed) return;
    this._armed = true;
    this.play(false);
  },

  init() {
    const unlock = () => {
      this.arm();
      document.removeEventListener("pointerdown", unlock, true);
      document.removeEventListener("keydown", unlock, true);
    };
    document.addEventListener("pointerdown", unlock, true);
    document.addEventListener("keydown", unlock, true);
    // Begin at the player's chosen start track (0 when unset or no longer shipped).
    this.idx = Math.max(0, this.tracks().findIndex(t => t.url === this.startUrl()));
    this.sync();
  },
};

window.Bgm = Bgm;
