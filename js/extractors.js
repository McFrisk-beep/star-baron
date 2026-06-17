/* extractors.js — the machines that work an industry. Bought in the Bazaar,
   installed into a permitted planet slot. Three types set what they can produce
   and the yield tier:
     • specialized — one specific commodity, best yield
     • semi        — any commodity in one category (gas / tech / …), mid yield
     • jack        — anything, lowest yield
   Names are randomized; the description spells out exactly what each does.
   Components (next increment) slot into an extractor to raise rate / cut time.  */

const EXTRACTOR_MFR = ["Korr", "Volkov", "Cygnus", "Drell", "Maru", "Oort", "Tassen", "Bell4", "Hjar", "Nuvo"];
const EXTRACTOR_SUFFIX = {
  specialized: ["Rig", "Borer", "Driver", "Extractor"],
  semi: ["Harvester", "Processor", "Refinery", "Works"],
  jack: ["Array", "Plant", "Unit", "Fabricator"],
};
const EXTRACTOR_JACK_CORE = ["Universal", "Omni", "All-Purpose", "Versatile"];

const Extractors = {
  s() { return window.Game.state; },
  pool() { return this.s().extractors || (this.s().extractors = {}); },
  get(uid) { return this.pool()[uid]; },
  installedSet() { return new Set((this.s().industries || []).map(i => i.extractorUid).filter(Boolean)); },
  unequipped() { const used = this.installedSet(); return Object.values(this.pool()).filter(e => !used.has(e.uid)); },

  yieldMult(ex) { return ex ? EXTRACTORCFG.types[ex.type].yieldMult : 0; },
  canProduce(ex, commId) {
    if (!ex) return false;
    if (ex.type === "jack") return true;
    if (ex.type === "specialized") return ex.scope === commId;
    const c = COMMODITIES.find(x => x.id === commId);
    return !!c && c.cat === ex.scope;          // semi
  },
  targets(ex) {
    if (!ex) return [];
    if (ex.type === "specialized") return [ex.scope];
    if (ex.type === "semi") return COMMODITIES.filter(c => c.cat === ex.scope).map(c => c.id);
    return COMMODITIES.map(c => c.id);          // jack
  },
  describe(ex) {
    const t = EXTRACTORCFG.types[ex.type];
    if (ex.type === "specialized") { const c = COMMODITIES.find(x => x.id === ex.scope); return `Specialized — extracts only ${c ? c.name : ex.scope}, at the highest yield (×${t.yieldMult}).`; }
    if (ex.type === "semi") return `Semi-specialized — extracts any ${ex.scope} commodity, at a solid yield (×${t.yieldMult}).`;
    return `Jack-of-all-trades — extracts any commodity, at a modest yield (×${t.yieldMult}).`;
  },
  price(ex) { return EXTRACTORCFG.types[ex.type].price; },

  name(type, scope) {
    const mfr = Util.pick(EXTRACTOR_MFR), suf = Util.pick(EXTRACTOR_SUFFIX[type] || EXTRACTOR_SUFFIX.jack);
    let core;
    if (type === "specialized") core = (COMMODITIES.find(c => c.id === scope) || {}).name || scope;
    else if (type === "semi") core = scope.charAt(0).toUpperCase() + scope.slice(1);
    else core = Util.pick(EXTRACTOR_JACK_CORE);
    return `${mfr} ${core} ${suf}`;
  },
  gen() {
    const r = Math.random();
    const type = r < 0.45 ? "specialized" : r < 0.8 ? "semi" : "jack";
    const scope = type === "specialized" ? Util.pick(COMMODITIES).id
      : type === "semi" ? Util.pick([...new Set(COMMODITIES.map(c => c.cat))])
        : "all";
    return { uid: "ex" + (++this.s().seq), type, scope, name: this.name(type, scope) };
  },
  // Add a bought extractor (offer.ex) to the owned pool.
  acquire(ex) { this.pool()[ex.uid] = ex; return ex; },

  // ---- components fitted to an extractor ----------------------------------
  componentSlots() { return EXTRACTORCFG.componentSlots; },
  componentsOf(ex) { return ((ex && ex.components) || []).map(u => Components.get(u)).filter(Boolean); },
  bonuses(ex) {
    let rate = 1, speed = 0;
    for (const c of this.componentsOf(ex)) { if (c.kind === "rate") rate += c.amount; else speed += c.amount; }
    return { rate, cycle: Math.max(COMPONENTCFG.cycleFloor, 1 - speed) };
  },
  attachComponent(exUid, compUid) {
    const ex = this.get(exUid); if (!ex) return { ok: false, msg: "Extractor not found." };
    if (!Components.get(compUid)) return { ok: false, msg: "Component not found." };
    if (Components.installedSet().has(compUid)) return { ok: false, msg: "Already fitted elsewhere." };
    ex.components = ex.components || [];
    if (ex.components.length >= this.componentSlots()) return { ok: false, msg: "No free component slots." };
    ex.components.push(compUid);
    return { ok: true };
  },
  detachComponent(exUid, compUid) {
    const ex = this.get(exUid); if (!ex) return { ok: false };
    ex.components = (ex.components || []).filter(u => u !== compUid);
    return { ok: true };
  },
};

const Components = {
  s() { return window.Game.state; },
  pool() { return this.s().components || (this.s().components = {}); },
  get(uid) { return this.pool()[uid]; },
  rarity(id) { return RARITIES.find(r => r.id === id) || RARITIES[0]; },
  installedSet() {
    const set = new Set();
    for (const ex of Object.values(Extractors.pool())) for (const u of ex.components || []) set.add(u);
    return set;
  },
  unequipped() { const used = this.installedSet(); return Object.values(this.pool()).filter(c => !used.has(c.uid)); },
  _rollRarity() {
    const tot = RARITIES.reduce((n, r) => n + r.weight, 0); let x = Math.random() * tot;
    for (const r of RARITIES) if ((x -= r.weight) <= 0) return r;
    return RARITIES[0];
  },
  gen() {
    const kind = Math.random() < 0.5 ? "rate" : "speed";
    const rar = this._rollRarity();
    const base = kind === "rate" ? COMPONENTCFG.rateBase : COMPONENTCFG.speedBase;
    return { uid: "cp" + (++this.s().seq), kind, rarity: rar.id, amount: +(base * rar.mult).toFixed(3),
      name: `${Util.pick(EXTRACTOR_MFR)} ${COMPONENTCFG.kinds[kind].label}` };
  },
  describe(c) { return c.kind === "rate" ? `+${(c.amount * 100).toFixed(0)}% yield` : `−${(c.amount * 100).toFixed(0)}% cycle time`; },
  price(c) { return Math.round(COMPONENTCFG.priceBase * this.rarity(c.rarity).price); },
  acquire(c) { this.pool()[c.uid] = c; return c; },
};

window.Extractors = Extractors;
window.Components = Components;
