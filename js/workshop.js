/* workshop.js — timed crafting queue + blueprint-gated recipes.
   See docs/CRAFTING_AND_MATERIALS.md §3. Outputs land in inventory / extractors /
   fleet when a job's readyAt elapses (offline catch-up capped).                */

const Workshop = {
  s() { return window.Game.state; },

  recipe(id) { return RECIPES.find(r => r.id === id); },
  blueprint(id) { return BLUEPRINTS.find(b => b.id === id); },
  blueprintForRecipe(recipeId) { return BLUEPRINTS.find(b => b.recipeId === recipeId); },

  meta() {
    const s = this.s();
    s.workshop ||= { upgrades: 0, queue: [] };
    s.workshop.queue ||= [];
    s.knownRecipes ||= [];
    s.craftedOnce ||= [];
    return s.workshop;
  },

  slots() {
    const up = this.meta().upgrades || 0;
    return Math.min(WORKSHOPCFG.maxSlots, WORKSHOPCFG.baseSlots + up);
  },
  freeSlots() { return Math.max(0, this.slots() - this.meta().queue.length); },
  upgradeCost() {
    const lvl = this.meta().upgrades || 0;
    return Math.round(WORKSHOPCFG.slotUpgradeBase * Math.pow(1.65, lvl));
  },
  buySlot() {
    const s = this.s();
    this.meta();
    if (this.slots() >= WORKSHOPCFG.maxSlots) return { ok: false, msg: "Workshop is fully expanded." };
    const cost = this.upgradeCost();
    if (cost > s.credits) return { ok: false, msg: "Not enough credits." };
    s.credits -= cost;
    s.workshop.upgrades = (s.workshop.upgrades || 0) + 1;
    if (window.Economy) Economy.refreshNetWorth();
    return { ok: true, slots: this.slots(), cost };
  },

  // Auto-source blueprints unlock for every save (Baron floor).
  ensureAutoUnlocks() {
    this.meta();
    const s = this.s();
    for (const bp of BLUEPRINTS) {
      if (bp.source === "auto" && !s.knownRecipes.includes(bp.recipeId)) {
        s.knownRecipes.push(bp.recipeId);
      }
    }
  },

  burned(recipeId) { return (this.s().craftedOnce || []).includes(recipeId); },

  // Allied standing check for Fabrication Rights (REP Allied = +50).
  _alliedWith(factionId) {
    if (!factionId || factionId === "all") return true;
    if (!window.Rep) return false;
    return Rep.tierIndex(Rep.tierOf(factionId).id) >= Rep.tierIndex("allied");
  },

  // Temporary unlocks from active Fabrication Rights edicts.
  senateRecipes(now = Date.now()) {
    const out = new Set();
    if (!window.Senate) return out;
    for (const g of Senate.blueprintGrants()) {
      if (g.recipeId && this._alliedWith(g.faction) && !this.burned(g.recipeId)) out.add(g.recipeId);
    }
    return out;
  },

  known(recipeId) {
    if (this.burned(recipeId)) return false;
    if ((this.s().knownRecipes || []).includes(recipeId)) return true;
    return this.senateRecipes().has(recipeId);
  },

  unlockRecipe(recipeId) {
    this.meta();
    const s = this.s();
    if (this.burned(recipeId)) return { ok: false, msg: "That one-of-a-kind craft is already spent." };
    if (!s.knownRecipes.includes(recipeId)) s.knownRecipes.push(recipeId);
    return { ok: true };
  },

  // Senate cost/time helpers (neg mag = discount).
  craftCostFactor() {
    const add = window.Senate ? Senate.craftCostAdd() : 0;
    return Math.max(0.2, 1 + add);
  },
  ingQty(ing) {
    const q = Math.max(1, Math.ceil((ing.qty || 1) * this.craftCostFactor()));
    return q;
  },
  creditCost(recipe) {
    const base = recipe.credits || 0;
    if (!base) return 0;
    return Math.max(0, Math.round(base * this.craftCostFactor()));
  },

  // Grant a blueprint (by blueprint id or recipe id). Inventory item optional.
  grantBlueprint(blueprintId, opts = {}) {
    const bp = this.blueprint(blueprintId) || this.blueprintForRecipe(blueprintId);
    if (!bp) return { ok: false, msg: "Unknown blueprint." };
    if (this.burned(bp.recipeId)) return { ok: false, msg: "Already forged — that blueprint is spent." };
    this.unlockRecipe(bp.recipeId);
    if (opts.asItem && window.Items) {
      const room = !(window.Bazaar) || Bazaar.inventoryUsed() < Bazaar.capacity();
      if (room) {
        const it = {
          uid: "i" + (++this.s().seq),
          kind: "blueprint", rarity: "rare", name: bp.name,
          consumable: false, blueprintId: bp.id, recipeId: bp.recipeId,
          primary: null, bonus: null, value: 8000,
        };
        this.s().items[it.uid] = it;
        return { ok: true, blueprint: bp, item: it };
      }
    }
    return { ok: true, blueprint: bp };
  },

  // Recipes visible in the Workshop (known and not burned).
  visible(outputType = null) {
    this.ensureAutoUnlocks();
    return RECIPES.filter(r => this.known(r.id) && !this.burned(r.id) && (!outputType || r.outputType === outputType));
  },

  craftMs(recipe, now = Date.now()) {
    let ms = recipe.craftMs || 60 * 1000;
    if (window.Boosts) ms *= Math.max(0.2, 1 + Boosts.mag("craftTime", now));
    if (window.Senate) ms *= Math.max(0.2, 1 + Senate.craftTimeAdd());
    return Math.max(CONFIG.marketTickMs, ms / (window.Game.timeScale || 1));
  },

  haveQty(commId) { return this.s().positions[commId] || 0; },

  // Flavor options the player can afford right now (senate cost factor applied).
  affordableFlavors(recipe) {
    if (!recipe.flavor || !recipe.flavor.length) return [];
    return recipe.flavor.filter(f => this.haveQty(f.id) >= this.ingQty(f));
  },

  canCraft(recipeId, flavorId = null) {
    const recipe = this.recipe(recipeId);
    if (!recipe) return { ok: false, msg: "Unknown recipe." };
    if (!this.known(recipeId)) return { ok: false, msg: "Blueprint required." };
    if (this.burned(recipeId)) return { ok: false, msg: "Already crafted — unique blueprint spent." };
    if (this.freeSlots() <= 0) return { ok: false, msg: "No free Workshop slots." };
    const s = this.s();
    const credits = this.creditCost(recipe);
    if (credits > s.credits) return { ok: false, msg: "Not enough credits." };
    for (const ing of recipe.ingredients || []) {
      const need = this.ingQty(ing);
      if (this.haveQty(ing.id) < need) {
        const n = (COMMODITIES.find(c => c.id === ing.id) || {}).name || ing.id;
        return { ok: false, msg: `Need ${need} ${n}.` };
      }
    }
    let flavor = null;
    if (recipe.flavor && recipe.flavor.length) {
      flavor = flavorId
        ? recipe.flavor.find(f => f.id === flavorId)
        : this.affordableFlavors(recipe)[0];
      if (!flavor) return { ok: false, msg: "Need a category-flavor ingredient." };
      const fNeed = this.ingQty(flavor);
      if (this.haveQty(flavor.id) < fNeed) {
        const n = (COMMODITIES.find(c => c.id === flavor.id) || {}).name || flavor.id;
        return { ok: false, msg: `Need ${fNeed} ${n}.` };
      }
    }
    if (recipe.outputType === "gear" || recipe.outputType === "blackbox") {
      if (window.Bazaar && Bazaar.inventoryUsed() >= Bazaar.capacity()) {
        return { ok: false, msg: "Inventory full — free a slot first." };
      }
    }
    if (recipe.outputType === "ship") {
      const cap = window.Economy ? Economy.fleetCap() : 99;
      if ((s.ships || []).length >= cap) return { ok: false, msg: `Fleet at capacity (${cap}).` };
      const shipType = recipe.output && recipe.output.shipType;
      const def = shipType && Fleet.shipDef(shipType);
      if (def && def.unique && (s.ships || []).some(sh => sh.type === shipType)) {
        return { ok: false, msg: "You already command that unique hull." };
      }
    }
    return { ok: true, recipe, flavor };
  },

  craft(recipeId, flavorId = null, now = Date.now()) {
    const chk = this.canCraft(recipeId, flavorId);
    if (!chk.ok) return chk;
    const { recipe, flavor } = chk;
    const s = this.s();
    for (const ing of recipe.ingredients || []) {
      const need = this.ingQty(ing);
      s.positions[ing.id] = (s.positions[ing.id] || 0) - need;
      if (s.positions[ing.id] <= 0) { s.positions[ing.id] = 0; s.avgCost[ing.id] = 0; }
    }
    if (flavor) {
      const fNeed = this.ingQty(flavor);
      s.positions[flavor.id] = (s.positions[flavor.id] || 0) - fNeed;
      if (s.positions[flavor.id] <= 0) { s.positions[flavor.id] = 0; s.avgCost[flavor.id] = 0; }
    }
    const credits = this.creditCost(recipe);
    if (credits) s.credits -= credits;
    const ms = this.craftMs(recipe, now);
    const job = {
      id: "ck" + (++s.seq),
      recipeId: recipe.id,
      startedAt: now,
      readyAt: now + ms,
      flavorId: flavor ? flavor.id : null,
    };
    this.meta().queue.push(job);
    if (window.Economy) Economy.refreshNetWorth();
    return { ok: true, job, recipe };
  },

  _deliver(job) {
    const recipe = this.recipe(job.recipeId); if (!recipe) return null;
    const s = this.s();
    const out = recipe.output || {};
    let label = recipe.name;
    if (recipe.outputType === "gear" && window.Items) {
      const it = Items.gen({ kind: out.kind, rarity: out.rarity });
      s.items[it.uid] = it;
      label = it.name;
    } else if (recipe.outputType === "blackbox" && window.Items) {
      const it = Items.genBlackbox(out.effectId);
      s.items[it.uid] = it;
      label = it.name;
    } else if (recipe.outputType === "extractor" && window.Extractors) {
      let scope = out.scope || "all";
      if (out.extractorType === "specialized") {
        const flav = (recipe.flavor || []).find(f => f.id === job.flavorId);
        const cat = flav ? flav.scopeCat : "mineral";
        const pool = COMMODITIES.filter(c => c.cat === cat && !c.craftOnly);
        scope = (Util.pick(pool) || COMMODITIES[0]).id;
      } else if (out.extractorType === "semi") {
        scope = out.scope || Util.pick(["mineral", "gas", "agri", "tech", "luxury", "illicit"]);
      }
      const ex = {
        uid: "ex" + (++s.seq),
        type: out.extractorType,
        scope,
        name: Extractors.name(out.extractorType, scope),
        components: [],
      };
      Extractors.acquire(ex);
      label = ex.name;
    } else if (recipe.outputType === "ship" && window.Fleet) {
      const sh = Fleet.makeShip(out.shipType);
      s.ships.push(sh);
      label = sh.name;
    }
    const bp = this.blueprintForRecipe(recipe.id);
    if (bp && bp.destroyOnUse) {
      s.craftedOnce = s.craftedOnce || [];
      if (!s.craftedOnce.includes(recipe.id)) s.craftedOnce.push(recipe.id);
      s.knownRecipes = (s.knownRecipes || []).filter(id => id !== recipe.id);
    }
    return { recipeId: recipe.id, name: label, outputType: recipe.outputType };
  },

  resolve(now = Date.now()) {
    this.meta();
    const q = this.meta().queue;
    const done = [];
    let n = 0;
    const keep = [];
    for (const job of q) {
      if (n < WORKSHOPCFG.maxResolvePerCatchup && now >= job.readyAt) {
        const d = this._deliver(job);
        if (d) done.push(d);
        n++;
      } else keep.push(job);
    }
    this.meta().queue = keep;
    if (done.length && window.Economy) Economy.refreshNetWorth();
    return done;
  },

  // Blueprints eligible for bazaar / expedition / mission drops.
  dropPool(source) {
    return BLUEPRINTS.filter(bp => bp.source === source && !this.known(bp.recipeId) && !this.burned(bp.recipeId));
  },
};

window.Workshop = Workshop;
