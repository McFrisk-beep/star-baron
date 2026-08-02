/* bgm.js — shared background-music playlist. Admin uploads tracks (Supabase
   content key BGM_PLAYLIST + sprites/bgm/*); every player hears the same loop.
   Starts after the first user gesture (browser autoplay policy). Volume/mute
   come from Game.state.settings.                                                 */

const BGM_PLAYLIST = [];   // [{ url, name }] — overlaid by Content at boot

const Bgm = {
  el: null,
  idx: 0,
  _armed: false,
  _wantPlay: true,

  tracks() {
    const list = window.BGM_PLAYLIST;
    if (!Array.isArray(list)) return [];
    return list.filter(t => t && typeof t.url === "string" && t.url);
  },

  volume() {
    const s = window.Game && Game.state && Game.state.settings;
    if (!s || s.muted) return 0;
    const v = s.volume == null ? 0.25 : +s.volume;
    return Util.clamp(Number.isFinite(v) ? v : 0.25, 0, 1);
  },

  ensure() {
    if (this.el) return this.el;
    const a = document.createElement("audio");
    a.preload = "auto";
    a.setAttribute("playsinline", "");
    a.addEventListener("ended", () => this.next());
    a.addEventListener("error", () => {
      // Skip a broken track rather than stalling the playlist.
      if (this.tracks().length > 1) this.next();
    });
    this.el = a;
    return a;
  },

  // Call after Content.load (and whenever the admin edits the playlist).
  sync() {
    const tracks = this.tracks();
    if (!tracks.length) { this.stop(); return; }
    this.idx = ((this.idx % tracks.length) + tracks.length) % tracks.length;
    this.applyVolume();
    if (this._armed && this._wantPlay && !document.hidden) this.play(false);
  },

  applyVolume() {
    const a = this.ensure();
    a.volume = this.volume();
    if (a.volume <= 0) { try { a.pause(); } catch (e) { /* ignore */ } }
    else if (this._armed && this._wantPlay && !document.hidden && a.paused && this.tracks().length)
      this.play(false);
  },

  play(restart = true) {
    const tracks = this.tracks();
    if (!tracks.length) return;
    const a = this.ensure();
    const t = tracks[this.idx % tracks.length];
    if (restart || !a.src || !a.src.includes(t.url.split("?")[0])) {
      a.src = t.url;
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
    if (!this.el) return;
    try { this.el.pause(); } catch (e) { /* ignore */ }
    this.el.removeAttribute("src");
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
    this.sync();
  },
};

window.BGM_PLAYLIST = BGM_PLAYLIST;
window.Bgm = Bgm;
