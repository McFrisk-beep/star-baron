/* items.js — procedurally generated ship accessories + consumable blackboxes.
   Accessories: kind/rarity/primary(+bonus)/name/value.
   Blackboxes: consumable:true + effectId → Boosts.use pushes state.activeBoosts.
   See docs/CRAFTING_AND_MATERIALS.md §2.                                       */

const Items = {
  rarity(id) { return RARITIES.find(r => r.id === id); },
  isBlackbox(it) { return !!(it && (it.consumable || it.kind === "blackbox") && it.effectId); },

  // Credit value for a blackbox effect (duration × |mag|).
  blackboxValue(effect) {
    const e = typeof effect === "string" ? BLACKBOX_EFFECTS.find(x => x.id === effect) : effect;
    if (!e) return 2000;
    return Math.round(6000 * Math.abs(e.mag) * (e.durationMs / (2 * 3600 * 1000)) / 10) * 10;
  },

  // Mint a consumable blackbox into inventory shape.
  genBlackbox(effectId) {
    const e = (effectId && BLACKBOX_EFFECTS.find(x => x.id === effectId)) || Util.pick(BLACKBOX_EFFECTS);
    return {
      uid: "i" + (++window.Game.state.seq),
      kind: "blackbox",
      rarity: "rare",
      name: `${e.name} Blackbox`,
      consumable: true,
      effectId: e.id,
      primary: null,
      bonus: null,
      value: this.blackboxValue(e),
    };
  },

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
    if (this.isBlackbox(item)) return item.value || this.blackboxValue(item.effectId);
    const k = ACCESSORY_KINDS[item.kind];
    if (!k || !item.primary) return item.value || 0;
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
    if (this.isBlackbox(item)) {
      const e = BLACKBOX_EFFECTS.find(x => x.id === item.effectId);
      return e ? e.desc : "Timed boost (consumable)";
    }
    let s = this.statLabel(item.primary);
    if (item.bonus) s += " · " + this.statLabel(item.bonus);
    return s;
  },

  // Server Phase-2 stubs look like "Shield uncommon" (initcap(kind) + rarity).
  isStubName(it) {
    if (!it || !it.name) return true;
    if (this.isBlackbox(it)) {
      const e = BLACKBOX_EFFECTS.find(x => x.id === it.effectId);
      return !e || it.name !== `${e.name} Blackbox`;
    }
    const kind = String(it.kind || "");
    const stub = kind.charAt(0).toUpperCase() + kind.slice(1) + " " + it.rarity;
    return it.name === stub;
  },
  // Rebuild a cosmetic name. Seeded bazaar uids reuse the board formula; others
  // hash the uid so the same item keeps a stable name across reloads.
  nameFromUid(it) {
    if (!it) return "Gear";
    if (this.isBlackbox(it)) {
      const e = BLACKBOX_EFFECTS.find(x => x.id === it.effectId);
      return e ? `${e.name} Blackbox` : "Blackbox";
    }
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

/* Active blackbox buffs. Read-time filter on expiresAt — no expiry timer.
   Systems call Boosts.mag("industryYield") etc. when computing numbers.       */
const Boosts = {
  s() { return window.Game.state; },
  effect(id) { return (typeof BLACKBOX_EFFECTS !== "undefined" ? BLACKBOX_EFFECTS : []).find(e => e.id === id); },

  // Drop expired entries when read (keeps save tidy without a scheduler).
  prune(now = Date.now()) {
    const s = this.s();
    if (!s) return [];
    s.activeBoosts = (s.activeBoosts || []).filter(b => b && b.expiresAt > now && this.effect(b.effectId));
    return s.activeBoosts;
  },
  active(now = Date.now()) { return this.prune(now); },

  // Sum of mag for a stat across non-expired boosts (0 if none).
  mag(stat, now = Date.now()) {
    let m = 0;
    for (const b of this.active(now)) {
      const e = this.effect(b.effectId);
      if (e && e.stat === stat) m += e.mag;
    }
    return m;
  },

  // Consume a blackbox from inventory. Same effectId refreshes duration (no stack).
  use(itemUid, now = Date.now()) {
    const s = this.s();
    const it = s.items[itemUid];
    if (!it || !Items.isBlackbox(it)) return { ok: false, msg: "Not a blackbox." };
    const e = this.effect(it.effectId);
    if (!e) return { ok: false, msg: "Unknown blackbox effect." };
    if (window.Bazaar && Bazaar.equippedSet().has(itemUid)) return { ok: false, msg: "Unequip it first." };
    // Must be in the hold or docked bay — can't use a box three sectors away.
    if (window.Assets) {
      const loc = Assets.gearLocation(itemUid);
      if (!loc) return { ok: false, msg: "Blackbox isn't here." };
      if (loc !== "hold" && (s.travel || loc !== s.currentSystem))
        return { ok: false, msg: "Dock where the blackbox is stored to use it." };
      Assets.withdraw(loc === "hold" ? "hold" : loc, "gear", itemUid);
    }
    delete s.items[itemUid];
    this.prune(now);
    s.activeBoosts = s.activeBoosts.filter(b => b.effectId !== e.id);
    s.activeBoosts.push({ effectId: e.id, expiresAt: now + e.durationMs });
    return { ok: true, effect: e, expiresAt: now + e.durationMs };
  },
};

window.Items = Items;
window.Boosts = Boosts;
