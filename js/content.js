/* content.js — admin-editable game content. The flavor/data collections live as
   globals (window.X) that the game reads at runtime; the same arrays/objects are
   what the rest of the code references, so applying an override = mutating them
   IN PLACE (no reassignment needed). Defaults ship in code; an admin's edits are
   stored in Supabase (`content` table, public-read / admin-write) and overlaid at
   boot, so every player sees the admin's content. Guests/offline use defaults.   */

const Content = {
  // Collections an admin may edit, grouped for the editor. Only collections that
  // are read at runtime (not baked into derived consts) are safe to expose.
  COLLECTIONS: [
    { key: "CHAT_LINES",      label: "Trader chat lines",     group: "flavor" },
    { key: "DIRWORDS",        label: "Direction words",       group: "flavor" },
    { key: "REACTIONS",       label: "Reactions to you",      group: "flavor" },
    { key: "OMENS",           label: "Omens & scams",         group: "flavor" },
    { key: "NEWS_EVENTS",     label: "Market news events",    group: "flavor" },
    { key: "NPCS",            label: "Recurring NPCs",        group: "flavor" },
    { key: "TV_SHOWS",        label: "Alien TV shows",        group: "flavor" },
    { key: "LOCAL_NEWS",      label: "Local system chatter",  group: "flavor" },
    { key: "LOCAL_EVENTS",    label: "Local events",          group: "flavor" },
    { key: "SHIP_RADIO",      label: "Ship voice lines",      group: "flavor" },
    { key: "SHIP_DIALOGUES",  label: "Ship dialogues",        group: "flavor" },
    { key: "RIVAL_BARBS",     label: "Rival barbs",           group: "flavor" },
    { key: "TUTORIAL_STEPS",  label: "Tutorial steps",        group: "flavor" },
    { key: "NAME_PARTS",      label: "Trader handle parts",   group: "flavor" },
    { key: "GALAXY_NAMES",    label: "Galaxy name parts",     group: "flavor" },
    { key: "INDUSTRIES",      label: "Planet industries",     group: "flavor" },
    { key: "MISSION_PHASES",  label: "Mission phases",        group: "flavor" },
    { key: "SENATE_ISSUES",   label: "Senate issues",         group: "data" },
    { key: "SENATE_EDICTS",   label: "Senate edicts",         group: "data" },
    { key: "SENATE_FIRST",    label: "Senator first names",   group: "flavor" },
    { key: "SENATE_SUR",      label: "Senator surname parts", group: "flavor" },
    { key: "SENATE_TITLES",   label: "Senator titles",        group: "flavor" },
    { key: "SENATE_HALL",     label: "Senate hall chatter",   group: "flavor" },
    { key: "SENATE_SPEAKER",  label: "Senate speaker lines",  group: "flavor" },
    { key: "SENATE_BUBBLES",  label: "Senate solo remarks",   group: "flavor" },
    { key: "SENATE_TALK",     label: "Senate conversations",  group: "data" },
    { key: "COMMODITIES",     label: "Commodities (items)",   group: "data" },
    { key: "SHIP_CATALOG",    label: "Ships (transport/escort/flagship)", group: "data" },
    { key: "CONTRACT_TEMPLATES", label: "Contract templates", group: "data" },
    { key: "DANGER",          label: "Danger tiers",          group: "data" },
    { key: "DMGCFG",          label: "Battle damage",         group: "data" },
    { key: "CUSTOMS",         label: "Customs scans",         group: "data" },
    { key: "EXPEDCFG",        label: "Anomaly surveys",       group: "data" },
    { key: "MARKETCFG",       label: "Market depth & travel", group: "data" },
    { key: "RARITIES",        label: "Item rarities",         group: "data" },
    { key: "ACCESSORY_KINDS", label: "Accessory kinds",       group: "data" },
  ],
  // Non-collection keys that are also persisted in the content table (managed by
  // the image manager, not the JSON editor).
  EXTRA_KEYS: ["ASSET_OVERRIDES"],
  _defaults: {},
  _snapped: false,
  loaded: false,

  has(key) { return this.COLLECTIONS.some(c => c.key === key) || this.EXTRA_KEYS.includes(key); },
  meta(key) { return this.COLLECTIONS.find(c => c.key === key); },
  current(key) { return window[key]; },
  default(key) { return this._defaults[key]; },

  // Deep-copy the pristine defaults once, before any override is applied.
  snapshotDefaults() {
    if (this._snapped) return; this._snapped = true;
    const keys = this.COLLECTIONS.map(c => c.key).concat(this.EXTRA_KEYS);
    for (const k of keys) {
      const v = window[k];
      if (v !== undefined) { try { this._defaults[k] = JSON.parse(JSON.stringify(v)); } catch (e) {} }
    }
  },

  // Some globals are derived from editable ones (ALL_SHIPS from SHIP_CATALOG);
  // rebuild them in place after overrides are applied.
  rederive() {
    if (window.SHIP_CATALOG && Array.isArray(window.ALL_SHIPS)) {
      const sc = window.SHIP_CATALOG;
      const all = [...(sc.transport || []), ...(sc.escort || []), ...(sc.main || [])];
      window.ALL_SHIPS.length = 0; window.ALL_SHIPS.push(...all);
    }
  },

  // Overlay a value onto a live collection by mutating it in place (so every
  // existing reference sees the change). Type must match (array↔array, obj↔obj).
  apply(key, value) {
    const target = window[key];
    if (target === undefined || value == null) return false;
    if (Array.isArray(target) && Array.isArray(value)) {
      target.length = 0; target.push(...value); return true;
    }
    if (target && typeof target === "object" && !Array.isArray(target)
        && typeof value === "object" && !Array.isArray(value)) {
      // Object overrides replace key-by-key, but start from shipped defaults so a
      // stale CMS row (saved before a schema growth) can't delete new required
      // fields — e.g. MARKETCFG.seed / oscPeriod* added in Phase 0.
      const defaults = this._defaults[key];
      for (const k of Object.keys(target)) delete target[k];
      if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
        try { Object.assign(target, JSON.parse(JSON.stringify(defaults))); } catch (e) {}
      }
      Object.assign(target, value); return true;
    }
    console.warn("[Content] type mismatch, skipping override:", key);
    return false;
  },

  // Boot: snapshot defaults, then overlay any admin overrides from Supabase.
  // Runs for everyone (public read) so all players get the admin's content.
  async load() {
    this.snapshotDefaults();
    if (!window.Cloud || !Cloud.enabled || !Cloud.client) return;
    try {
      const { data, error } = await Cloud.client.from("content").select("key,data");
      if (error) throw error;
      for (const row of (data || [])) if (this.has(row.key)) this.apply(row.key, row.data);
      this.rederive();
      this.loaded = true;
    } catch (e) { console.warn("[Content] load failed (using built-in defaults):", e); }
  },

  // Admin: persist an edit to Supabase and apply it live. RLS enforces admin-only.
  async save(key, value) {
    if (!this.has(key)) throw new Error("Unknown collection.");
    if (!window.Cloud || !Cloud.isAdmin()) throw new Error("Admins only.");
    const { error } = await Cloud.client.from("content")
      .upsert({ key, data: value, updated_at: new Date().toISOString() });
    if (error) throw error;
    this.apply(key, value);
    this.rederive();
  },

  // Admin: drop the override and restore the built-in default.
  async reset(key) {
    if (!window.Cloud || !Cloud.isAdmin()) throw new Error("Admins only.");
    const { error } = await Cloud.client.from("content").delete().eq("key", key);
    if (error) throw error;
    if (this._defaults[key] !== undefined) this.apply(key, this._defaults[key]);
  },
};

window.Content = Content;
