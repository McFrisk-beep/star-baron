/* items.js — procedurally generated ship accessories. Each has a kind, a
   rarity, one primary stat (legendaries get a bonus second stat), a unique
   generated name, and a credit value. There are effectively thousands of
   distinct items from a small data set.                                       */

const Items = {
  rarity(id) { return RARITIES.find(r => r.id === id); },

  rollRarity(bias = 0) {
    // bias shifts the weight toward rarer drops (0..1).
    const weights = RARITIES.map(r => r.weight * (1 + bias * RARITIES.indexOf(r)));
    const total = weights.reduce((a, b) => a + b, 0);
    let x = Math.random() * total;
    for (let i = 0; i < RARITIES.length; i++) { x -= weights[i]; if (x <= 0) return RARITIES[i]; }
    return RARITIES[0];
  },

  // Build a stat for a kind at a given rarity multiplier.
  _stat(kindId, mult) {
    const k = ACCESSORY_KINDS[kindId];
    const jitter = Util.randFloat(0.8, 1.3);
    let amount = k.base * mult * jitter;
    amount = k.pct ? +(amount).toFixed(3) : Math.round(amount);
    return { stat: k.stat, amount, pct: k.pct, kind: kindId };
  },

  _name(kindId, rarity) {
    const k = ACCESSORY_KINDS[kindId];
    const mk = ["I", "II", "III", "IV", "V"][Util.randInt(0, 4)];
    let n = `${Util.pick(ITEM_BRANDS)} Mk.${mk} ${k.label}`;
    if (rarity.id === "epic" || rarity.id === "legendary") n += ` "${Util.pick(ITEM_SUFFIXES)}"`;
    return n;
  },

  // Generate one item. opts: { kind, rarity (id), bias }.
  gen(opts = {}) {
    const kindId = opts.kind || Util.pick(Object.keys(ACCESSORY_KINDS));
    const rarity = opts.rarity ? this.rarity(opts.rarity) : this.rollRarity(opts.bias || 0);
    const primary = this._stat(kindId, rarity.mult);
    let bonus = null;
    if (rarity.id === "legendary") {
      let bk = Util.pick(Object.keys(ACCESSORY_KINDS));
      if (bk === kindId) bk = Util.pick(Object.keys(ACCESSORY_KINDS));
      bonus = this._stat(bk, rarity.mult * 0.6);
    }
    const item = {
      uid: "i" + (++window.Game.state.seq),
      kind: kindId, rarity: rarity.id,
      name: this._name(kindId, rarity),
      primary, bonus,
    };
    item.value = this.value(item);
    return item;
  },

  // Credit value: scales with stat magnitude × rarity price multiplier.
  value(item) {
    const k = ACCESSORY_KINDS[item.kind];
    const r = this.rarity(item.rarity);
    const base = k.pct ? item.primary.amount * 8000 : item.primary.amount * 90;
    let v = base * r.price;
    if (item.bonus) v *= 1.4;
    return Math.round(v / 10) * 10;
  },

  // Short stat label for UI, e.g. "+8% speed" or "+18 armor".
  statLabel(st) {
    if (!st) return "";
    const sign = "+";
    return st.pct ? `${sign}${(st.amount * 100).toFixed(1)}% ${st.stat}`
                  : `${sign}${st.amount} ${st.stat}`;
  },

  label(item) {
    let s = this.statLabel(item.primary);
    if (item.bonus) s += " · " + this.statLabel(item.bonus);
    return s;
  },

  // Server Phase-2 stubs look like "Shield uncommon" (initcap(kind) + rarity).
  isStubName(it) {
    if (!it || !it.name) return true;
    const kind = String(it.kind || "");
    const stub = kind.charAt(0).toUpperCase() + kind.slice(1) + " " + it.rarity;
    return it.name === stub;
  },
  // Rebuild a cosmetic name. Seeded bazaar uids reuse the board formula; others
  // hash the uid so the same item keeps a stable name across reloads.
  nameFromUid(it) {
    if (!it) return "Gear";
    const m = /^i(\d+)a(\d+)$/.exec(it.uid || "");
    if (m && window.Bazaar && Bazaar.genSeededAccessory) {
      try { return Bazaar.genSeededAccessory(+m[1], +m[2]).item.name; } catch (e) {}
    }
    const k = ACCESSORY_KINDS[it.kind] || { label: it.kind || "Gear" };
    const rar = this.rarity(it.rarity) || RARITIES[0];
    const brands = window.ITEM_BRANDS || ["Vex"], suf = window.ITEM_SUFFIXES || ["Howl"];
    let h = 2166136261; const s = String(it.uid || it.kind);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h >>>= 0;
    const mk = ["I", "II", "III", "IV", "V"][h % 5];
    let n = `${brands[(h >>> 5) % brands.length]} Mk.${mk} ${k.label}`;
    if (rar.id === "epic" || rar.id === "legendary") n += ` "${suf[(h >>> 11) % suf.length]}"`;
    return n;
  },
};

window.Items = Items;
