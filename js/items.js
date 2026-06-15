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
};

window.Items = Items;
