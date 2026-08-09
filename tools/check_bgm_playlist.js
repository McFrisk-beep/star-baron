#!/usr/bin/env node
/* check_bgm_playlist.js — git (BGM_TRACKS) is the playlist; a player's saved
   order only permutes it, and must survive songs being added or removed from
   the repo between saves. Run: node tools/check_bgm_playlist.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

// Bgm.play() builds an <audio>; stub just enough for setStart to run headless.
const audioStub = {
  addEventListener() {}, setAttribute() {}, removeAttribute() {},
  play() { return null; }, load() {}, pause() {}, paused: true, volume: 1,
};
const ctx = vm.createContext({
  console, Math,
  document: { createElement: () => Object.create(audioStub), hidden: false, addEventListener() {} },
  Util: { clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)) },
});
ctx.window = ctx;
vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/bgm.js"), "utf8"), ctx, { filename: "bgm.js" });

const { Bgm } = ctx;
// Array.from re-homes vm-realm arrays so deepStrictEqual's prototype check passes.
const urls = list => Array.from(list, t => t.url);
const plain = list => Array.from(list || []);
const setup = (tracks, settings) => {
  ctx.BGM_TRACKS = tracks.map(u => ({ url: u, name: u }));
  ctx.Game = { state: { settings: settings || {} } };
  Bgm.idx = 0;
};

// 1. No saved order → ship in manifest (file-name) order.
setup(["a.mp3", "b.mp3", "c.mp3"], {});
assert.deepStrictEqual(urls(Bgm.tracks()), ["a.mp3", "b.mp3", "c.mp3"], "default order is the manifest");

// 2. A saved order permutes it.
setup(["a.mp3", "b.mp3", "c.mp3"], { bgmOrder: ["c.mp3", "a.mp3", "b.mp3"] });
assert.deepStrictEqual(urls(Bgm.tracks()), ["c.mp3", "a.mp3", "b.mp3"], "saved order wins");

// 3. A song added to the repo since the save is appended, not lost.
setup(["a.mp3", "b.mp3", "new.mp3"], { bgmOrder: ["b.mp3", "a.mp3"] });
assert.deepStrictEqual(urls(Bgm.tracks()), ["b.mp3", "a.mp3", "new.mp3"], "new files append");

// 4. A song deleted from the repo drops out; junk and dupes in the save can't
//    resurrect it or double a track (save data is a trust boundary).
setup(["a.mp3"], { bgmOrder: ["gone.mp3", "a.mp3", "a.mp3", null, 7, { url: "a.mp3" }] });
assert.deepStrictEqual(urls(Bgm.tracks()), ["a.mp3"], "stale/dupe/non-string entries are dropped");

// 5. Reordering persists and does not restart what is playing.
setup(["a.mp3", "b.mp3", "c.mp3"], {});
Bgm.idx = 2;                                    // "c.mp3" is playing
assert.strictEqual(Bgm.move(0, 1), true, "move in range");
assert.deepStrictEqual(plain(ctx.Game.state.settings.bgmOrder), ["b.mp3", "a.mp3", "c.mp3"], "order saved");
assert.strictEqual(Bgm.current(), "c.mp3", "still pointing at the playing track");
assert.strictEqual(Bgm.move(0, -1), false, "can't move the first row up");
assert.strictEqual(Bgm.move(2, 1), false, "can't move the last row down");

// 6. The start track is saved and jumped to.
setup(["a.mp3", "b.mp3"], {});
Bgm.setStart("b.mp3");
assert.strictEqual(ctx.Game.state.settings.bgmStart, "b.mp3", "start saved");
assert.strictEqual(Bgm.current(), "b.mp3", "playback jumps to the new start");

// 7. init() begins on the saved start track, and tolerates one that no longer ships.
setup(["a.mp3", "b.mp3", "c.mp3"], { bgmStart: "c.mp3" });
Bgm.init();
assert.strictEqual(Bgm.current(), "c.mp3", "loop begins on the chosen song");
setup(["a.mp3", "b.mp3"], { bgmStart: "deleted.mp3" });
Bgm.init();
assert.strictEqual(Bgm.current(), "a.mp3", "missing start track falls back to the first");

console.log("check_bgm_playlist: order, start track + save-data tolerance ✔");
