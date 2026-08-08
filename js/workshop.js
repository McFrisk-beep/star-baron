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
  // True once crafting is on the server ledger (docs/sql/workshop_craft.sql).
  // Everything below keeps a local twin for guests and for projects that
  // haven't applied that file yet.
  authoritative() { return !!(window.Cloud && Cloud.craftReady && Cloud.craftReady()); },

  _buySlotLocal() {
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
  buySlot() {
    if (!this.authoritative()) return this._buySlotLocal();
    return Economy._withRpc(
      () => this._buySlotLocal(),
      () => Cloud.craftSlot(),
      "Couldn't reach the Workshop — try again."
    );
  },

  baronTier() { return window.Economy ? Economy.tier() : ((this.s().prestige || {}).tier || 0); },

  // Auto-source blueprints unlock once Baron Tier floor is met (§5 / recipe table).
  // Optional `state` so Game.migrate can unlock before Game.state is assigned.
  ensureAutoUnlocks(state) {
    const s = state || this.s();
    s.workshop ||= { upgrades: 0, queue: [] };
    s.workshop.queue ||= [];
    s.knownRecipes ||= [];
    const tier = state ? ((s.prestige || {}).tier || 0) : this.baronTier();
    for (const bp of BLUEPRINTS) {
      if (bp.source !== "auto") continue;
      if (tier < (bp.minBaronTier || 0)) continue;
      if (!s.knownRecipes.includes(bp.recipeId)) s.knownRecipes.push(bp.recipeId);
    }
  },

  burned(recipeId) { return (this.s().craftedOnce || []).includes(recipeId); },

  // Unique (destroyOnUse) already sitting in the craft queue — treat as reserved.
  queued(recipeId) {
    return (this.meta().queue || []).some(j => j.recipeId === recipeId);
  },

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
    const bp = this.blueprintForRecipe(recipeId);
    if (bp && bp.source === "auto" && this.baronTier() >= (bp.minBaronTier || 0)) return true;
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
    // Workshop Annex (docs/STATIONS.md §10) — best owned station; craft isn't
    // location-locked yet. Upgrade: require docking at the annex system.
    if (window.Stations) {
      let factor = 1;
      for (const st of Stations.ownedBy()) factor = Math.min(factor, Stations.workshopTimeFactor(st.systemId));
      ms *= factor;
    }
    return Math.max(CONFIG.marketTickMs, ms / (window.Game.timeScale || 1));
  },

  // Stochastic material discount (option 3): each unit has `chance` of not
  // being consumed. Averages correctly at every quantity; no fractional stock.
  _annexMatChance() {
    if (!window.Stations) return 0;
    let best = 0;
    for (const st of Stations.ownedBy()) best = Math.max(best, Stations.workshopMatChance(st.systemId));
    return best;
  },
  _consumeIng(commId, need) {
    const s = this.s();
    let pay = need;
    const chance = this._annexMatChance();
    if (chance > 0) {
      let saved = 0;
      for (let i = 0; i < need; i++) if (Math.random() < chance) saved++;
      pay = need - saved;
    }
    // Prefer docked bay, then hold (HAULING.md §5 — Workshop draws local stock).
    let left = pay;
    if (window.Assets && !s.travel) {
      const fromBay = Math.min(left, Assets.bayQty(s.currentSystem, commId));
      if (fromBay > 0) { Assets.withdraw(s.currentSystem, "block", commId, fromBay); left -= fromBay; }
    }
    if (window.Assets && left > 0) {
      const fromHold = Math.min(left, Assets.holdQty(commId));
      if (fromHold > 0) { Assets.withdraw("hold", "block", commId, fromHold); left -= fromHold; }
    }
    if (left > 0) {
      // Fallback for pre-hauling / remote stock still on positions.
      s.positions[commId] = Math.max(0, (s.positions[commId] || 0) - left);
      if (s.positions[commId] <= 0) { s.positions[commId] = 0; s.avgCost[commId] = 0; }
      if (window.Assets) Assets.reconcileFromPositions(s.currentSystem);
    }
    return pay;
  },

  // Crafting can pull from hold + docked bay (not stranded remote stock).
  haveQty(commId) {
    if (!window.Assets) return this.s().positions[commId] || 0;
    const s = this.s();
    let n = Assets.holdQty(commId);
    if (!s.travel) n += Assets.bayQty(s.currentSystem, commId);
    return n;
  },

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
    const bp = this.blueprintForRecipe(recipeId);
    if (bp && bp.destroyOnUse && this.queued(recipeId)) {
      return { ok: false, msg: "That unique hull is already on the slips." };
    }
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

  _craftLocal(recipeId, flavorId = null, now = Date.now()) {
    const chk = this.canCraft(recipeId, flavorId);
    if (!chk.ok) return chk;
    const { recipe, flavor } = chk;
    const s = this.s();
    for (const ing of recipe.ingredients || []) this._consumeIng(ing.id, this.ingQty(ing));
    if (flavor) this._consumeIng(flavor.id, this.ingQty(flavor));
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

  // The optimistic job (and its ingredient spend) is replaced by the server's
  // queue in the result slice, so the job id / readyAt the player ends up with
  // are the server's, not ours.
  craft(recipeId, flavorId = null, now = Date.now()) {
    if (!this.authoritative()) return this._craftLocal(recipeId, flavorId, now);
    return Economy._withRpc(
      () => this._craftLocal(recipeId, flavorId, now),
      () => Cloud.craftStart(recipeId, flavorId),
      "Couldn't reach the Workshop — try again."
    );
  },

  // Docked system id for toast labels. null while traveling — parkGear itself
  // routes finished gear to the hold when given null / while s.travel is set.
  _baySystem(s) {
    s = s || this.s();
    if (s.travel) return null;
    return (typeof s.currentSystem === "string" && s.currentSystem) || null;
  },

  _deliver(job) {
    const recipe = this.recipe(job.recipeId); if (!recipe) return null;
    const s = this.s();
    const out = recipe.output || {};
    const baySystem = this._baySystem(s);
    let label = recipe.name;
    if (recipe.outputType === "gear" && window.Items) {
      const it = Items.gen({ kind: out.kind, rarity: out.rarity });
      s.items[it.uid] = it;
      if (window.Assets) Assets.parkGear(it.uid, baySystem);
      label = it.name;
    } else if (recipe.outputType === "blackbox" && window.Items) {
      const it = Items.genBlackbox(out.effectId);
      s.items[it.uid] = it;
      if (window.Assets) Assets.parkGear(it.uid, baySystem);
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
      // Hull missing from SHIP_CATALOG (admin edit) — keep the job, don't throw.
      if (!Fleet.shipDef(out.shipType)) return null;
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
    return { recipeId: recipe.id, name: label, outputType: recipe.outputType, baySystem };
  },

  _resolveLocal(now = Date.now()) {
    this.meta();
    const q = this.meta().queue;
    const done = [];
    let n = 0;
    const keep = [];
    for (const job of q) {
      if (n < WORKSHOPCFG.maxResolvePerCatchup && now >= job.readyAt) {
        const d = this._deliver(job);
        // No output (recipe id renamed/removed by an admin edit) — keep the job
        // queued rather than silently eating the ingredients it already cost.
        if (d) { done.push(d); n++; } else keep.push(job);
      } else keep.push(job);
    }
    this.meta().queue = keep;
    if (done.length && window.Economy) Economy.refreshNetWorth();
    // One announce per resolve — not every Workshop paint while a job is due.
    if (done.length && !(window.Game && Game._booting)) Bus.emit("crafted", done);
    return done;
  },

  // resolve() has a dozen synchronous callers (boot catch-up, the tick, the
  // Workshop render), so it stays synchronous. On the server ledger it must NOT
  // mint locally — that item would only be deleted by the next app_commit, which
  // is the bug this whole path exists to fix — so it kicks off a claim instead
  // and the delivered goods arrive via the "crafted" event.
  resolve(now = Date.now()) {
    if (!this.authoritative()) return this._resolveLocal(now);
    void this.claimDue(now);
    return [];
  },

  _claiming: false,
  _claimBackoffUntil: 0,
  dueCount(now = Date.now()) {
    return (this.meta().queue || []).filter(j => j && now >= j.readyAt).length;
  },
  async claimDue(now = Date.now()) {
    if (this._claiming || !this.authoritative() || !this.dueCount(now)) return [];
    // Transient RPC failures used to re-fire every market tick while a job sat
    // ready — back off so a finished craft can't hammer the ledger.
    if (now < this._claimBackoffUntil) return [];
    this._claiming = true;
    try {
      const r = await Cloud.craftClaim();
      if (!r || !r.ok) {
        this._claimBackoffUntil = now + 15000;
        return [];
      }
      // _applyServerSlice → parkOrphanGear parks new gear into the docked bay
      // without duplicating uids already sitting in another bag.
      Economy._applyServerSlice(r);
      Economy.refreshNetWorth();
      const baySystem = this._baySystem();
      const done = (r.delivered || []).map(d => Object.assign({}, d, { baySystem }));
      if (done.length) {
        this._claimBackoffUntil = 0;
        window.Game.requestSave();
        Bus.emit("crafted", done);
      } else if (this.dueCount(now)) {
        // Still due after an empty claim (parked unknown recipe, clock skew) —
        // don't re-fire every market tick.
        this._claimBackoffUntil = now + 15000;
      } else {
        this._claimBackoffUntil = 0;
      }
      return done;
    } catch (e) {
      console.warn("[Workshop] claim failed:", e);
      this._claimBackoffUntil = now + 15000;
      return [];
    } finally { this._claiming = false; }
  },

  // Handoff of pre-ledger Workshop state (queue, slot upgrades, and the crafted
  // items that only ever existed in this browser) to the server pool. Called on
  // the first authoritative boot, and again after a wipe-backup restore puts
  // more items back — the server allows a few calls for exactly that reason and
  // answers "adopt limit reached" once the budget is spent.
  async adoptLocal(force = false) {
    if (!this.authoritative()) return null;
    const s = this.s();
    if (!force && s.workshopAdopt) return null;
    try {
      const r = await Cloud.craftAdopt(s.workshop || { upgrades: 0, queue: [] }, s.items || {});
      if (!r) return null;                       // SQL not applied — stay local
      if (r.ok) {
        Economy._applyServerSlice(r);
        Economy.refreshNetWorth();
        s.workshopAdopt = r.workshopAdopt || { calls: 1, items: 0, at: Date.now() };
        window.Game.requestSave();
        if (r.adoptedItems || r.adoptedJobs) {
          console.log(`[Workshop] adopted ${r.adoptedItems} item(s), ${r.adoptedJobs} job(s) into the server ledger`);
        }
        return r;
      }
      // Budget spent (or another device got there first) — stop asking.
      if (r.state && r.state.workshopAdopt) s.workshopAdopt = r.state.workshopAdopt;
      return r;
    } catch (e) {
      console.warn("[Workshop] adopt failed:", e);
      return null;
    }
  },

  // Blueprints eligible for bazaar / expedition / mission RNG drops.
  // destroyOnUse uniques (Last Aegis) are story-chain only — never random.
  dropPool(source) {
    return BLUEPRINTS.filter(bp =>
      bp.source === source
      && !bp.destroyOnUse
      && !this.known(bp.recipeId)
      && !this.burned(bp.recipeId));
  },
};

window.Workshop = Workshop;
