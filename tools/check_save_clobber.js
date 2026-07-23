/* check_save_clobber.js — regression: a post-logout guest local save must not
   beat a richer cloud row for the signed-in user, and a failed cloud load must
   not leave Store willing to upsert. Covers Phase 1 bootstrap + legacy saves.
   No browser — loads store.js into vm. */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const root = path.join(__dirname, "..");
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };

const mem = { local: null };
const fakeUser = { id: "user-aaa", email: "a@example.com" };
const cloud = {
  signedIn: () => true,
  user: () => fakeUser,
  playersReady: false,
  _remote: null,
  _boot: null,          // null → missing Phase 1 SQL → legacy saves path
  _bootErr: null,
  _loadErr: null,
  _saved: null,
  async bootstrap() {
    if (this._bootErr) throw this._bootErr;
    if (this._boot == null) { this.playersReady = false; return null; }
    this.playersReady = true;
    return this._boot;
  },
  async loadRemote() { if (this._loadErr) throw this._loadErr; return this._remote; },
  async saveRemote(state) { this._saved = state; },
  async clearRemote() {},
};

const ctx = {
  console,
  window: {},
  setTimeout, clearTimeout,
  localStorage: {
    getItem: () => mem.local,
    setItem: (_k, v) => { mem.local = v; },
    removeItem: () => { mem.local = null; },
  },
};
ctx.window = ctx;
ctx.window.Cloud = cloud;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, "js/store.js"), "utf8"), ctx);
const Store = ctx.Store;

(async () => {
  // 1) Phase 1 bootstrap wins over a fresher guest local.
  cloud._boot = { credits: 800000, lastSeenAt: 1000, cloudUserId: "user-aaa" };
  cloud._bootErr = null;
  mem.local = JSON.stringify({ credits: 1500, lastSeenAt: 999999 }); // fresher guest
  let loaded = await Store.load();
  assert(loaded.credits === 800000, "guest local does not clobber authoritative bootstrap");
  assert(Store._cloudReady === true, "cloud ready after successful bootstrap");
  assert(cloud.playersReady === true, "playersReady set after bootstrap");

  // 2) Legacy saves path: same-user newer local still wins (unsynced progress).
  cloud._boot = null;
  cloud.playersReady = false;
  cloud._remote = { credits: 100, lastSeenAt: 1000, cloudUserId: "user-aaa" };
  mem.local = JSON.stringify({ credits: 50000, lastSeenAt: 2000, cloudUserId: "user-aaa" });
  loaded = await Store.load();
  assert(loaded.credits === 50000, "same-user newer local still preferred (legacy saves)");

  // 3) Legacy: guest local must not beat a richer remote save.
  cloud._boot = null;
  cloud._remote = { credits: 800000, lastSeenAt: 1000, cloudUserId: "user-aaa" };
  mem.local = JSON.stringify({ credits: 1500, lastSeenAt: 999999 });
  loaded = await Store.load();
  assert(loaded.credits === 800000, "guest local does not clobber cloud on login (legacy)");

  // 4) Cloud load failure: do not allow cloud upserts.
  cloud._bootErr = new Error("network down");
  cloud._boot = { credits: 1 }; // would win if bootstrap weren't throwing
  cloud._remote = null;
  mem.local = null;
  Store._cloudWarned = true; // quiet toast
  loaded = await Store.load();
  assert(loaded == null, "failed cloud load with empty local returns null");
  assert(Store._cloudReady === false, "cloud writes gated after load failure");
  cloud._saved = null;
  await Store.save({ credits: 1500, lastSeenAt: Date.now() });
  assert(cloud._saved == null, "default-state save does not upsert after failed load");
  await Store.flush({ credits: 1500 });
  assert(cloud._saved == null, "flush also gated after failed load");

  // 5) Saves get stamped with the signed-in user id.
  cloud._bootErr = null;
  cloud._boot = null;
  cloud._loadErr = null;
  cloud._remote = null;
  Store._cloudReady = true;
  const st = { credits: 42, lastSeenAt: 1 };
  await Store.save(st);
  assert(st.cloudUserId === "user-aaa", "save stamps cloudUserId");

  console.log("All save-clobber checks passed.");
})().catch(e => { console.error(e); process.exit(1); });
