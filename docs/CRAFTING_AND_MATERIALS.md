# Content Phase 2 — Materials, Blackboxes & Crafting

> Naming note: this is "Phase 2" in the *content roadmap* sense (more resources,
> more systems), not `docs/PHASE2_SETUP.md` (that's server-authoritative infra
> for missions/bazaar — unrelated, don't confuse the two).

Status: **Implemented** on branch `claude/game-crafting-brainstorm-2q6nx9`
(commodities + rarity stocking, blackboxes + Hub boost bar, Workshop queue/
blueprints/recipes, Senate Fabrication Rights + craft discounts, Last Aegis
story chain). Remaining work is playtest tuning of §5 knobs.

> **Server note:** after expanding `COMMODITIES`, re-run
> [`docs/sql/market_commodities_expand.sql`](sql/market_commodities_expand.sql)
> (or the updated `market_price.sql`) in Supabase. Without it, signed-in
> trade/routes return **Unknown commodity** for new resources like Exotic Pelts.

Station-level resource exclusivity is **shelved** — exclusivity is handled via
a `rarity` tag on each commodity (see below), not a station/module system.

Numbers below were starting points — tune against live prices during playtest.

---

## 1. Commodities — 12 → 45 (33 new, in addition to the existing 12)

Keep the existing flat shape in `js/data.js` `COMMODITIES` (`{id, name, cat,
base, vol}`) and add two optional fields:

- `rarity`: `"common" | "uncommon" | "rare" | "exotic"` — drives which systems
  stock it at all (see §1.2). This *is* the "station-limited" idea, just
  system-level instead of a separate station entity (there is no station
  entity distinct from a system — confirmed in `galaxy.js`/`data.js`, a
  "station" is cosmetic dressing on a system).
- `craftOnly` (optional, `true`): trades for little/nothing at the Exchange,
  or doesn't spawn in normal system stock at all — acquired via expeditions,
  missions, or blueprint rewards. Exists purely as a crafting ingredient.

### 1.1 Full list

Existing entries unchanged in **bold**; new entries follow.

**Minerals — 8 total (3 existing + 5 new)** — ship hulls, gear frames, extractor housings
| id | name | base | vol | rarity |
|---|---|---|---|---|
| **iron_ore** | Iron Ore | 40 | 0.04 | common |
| **silicon** | Silicon | 65 | 0.05 | common |
| **rare_earths** | Rare Earths | 220 | 0.09 | uncommon |
| titanium_ore | Titanium Ore | 150 | 0.07 | uncommon |
| cobalt_ore | Cobalt Ore | 90 | 0.06 | common |
| graphene_lattice | Graphene Lattice | 260 | 0.09 | uncommon |
| pulsar_shard | Pulsar Shard | 680 | 0.17 | rare |
| voidstone | Voidstone | 1400 | 0.20 | exotic, `craftOnly` |

**Gas — 8 total (3 existing + 5 new)** — fuel, engines, cooling
| id | name | base | vol | rarity |
|---|---|---|---|---|
| **hydrogen** | Hydrogen | 30 | 0.05 | common |
| **helium3** | Helium-3 | 180 | 0.08 | common |
| **water_ice** | Water Ice | 25 | 0.06 | common |
| plasma_gas | Plasma Gas | 210 | 0.10 | uncommon |
| methane_slurry | Methane Slurry | 85 | 0.06 | common |
| xenon_gas | Xenon Gas | 260 | 0.11 | uncommon |
| cryo_vapor | Cryo Vapor | 340 | 0.12 | rare |
| quantum_foam | Quantum Foam | 1100 | 0.19 | exotic, `craftOnly` |

**Agri — 10 total (2 existing + 8 new)** — crew upkeep now, seeds the future staff mechanic later
| id | name | base | vol | rarity |
|---|---|---|---|---|
| **foodstuffs** | Foodstuffs | 55 | 0.05 | common |
| **synthsilk** | Synthsilk | 140 | 0.07 | common |
| grain | Grain | 35 | 0.04 | common |
| protein_stock | Protein Stock | 70 | 0.05 | common |
| hydro_greens | Hydro Greens | 50 | 0.05 | common |
| algae_paste | Algae Paste | 45 | 0.05 | common |
| biofiber | Biofiber | 160 | 0.08 | uncommon |
| nectar_extract | Nectar Extract | 190 | 0.08 | uncommon |
| medicinal_herbs | Medicinal Herbs | 200 | 0.09 | uncommon |
| spore_culture | Spore Culture | 380 | 0.14 | rare |

Rationale: `grain`/`protein_stock`/`hydro_greens` are cheap staples (later:
what hired staff consume as upkeep); `biofiber`/`medicinal_herbs`/
`nectar_extract` are crafting inputs (gear padding, blackbox effects, future
staff morale/medbay); `algae_paste` is a cheap life-support filler (fuel/food
hybrid flavor); `spore_culture` is the one exotic biotech ingredient for
top-tier blackboxes/gear. When the staff mechanic lands, the staples are
already positioned as "what staff need" without renaming anything.

**Tech — 7 total (2 existing + 5 new)** — the advanced-parts tier
| id | name | base | vol | rarity |
|---|---|---|---|---|
| **nanochips** | Nanochips | 320 | 0.10 | common |
| **antimatter** | Antimatter | 900 | 0.14 | rare |
| fusion_cell | Fusion Cell | 260 | 0.08 | common |
| sensor_array | Sensor Array | 410 | 0.11 | uncommon |
| neural_processor | Neural Processor | 560 | 0.13 | rare |
| quantum_core | Quantum Core | 750 | 0.13 | rare |
| ai_matrix | AI Matrix | 2200 | 0.22 | exotic, `craftOnly` |

**Luxury — 6 total (1 existing + 5 new)** — mostly sell-fodder, a couple double as cosmetic crafting inputs
| id | name | base | vol | rarity |
|---|---|---|---|---|
| **spice** | Spice | 260 | 0.12 | common |
| gemstones | Gemstones | 300 | 0.10 | common |
| vintage_wine | Vintage Wine | 180 | 0.08 | common |
| perfume_essence | Perfume Essence | 220 | 0.09 | common |
| fine_art | Fine Art | 420 | 0.13 | uncommon |
| exotic_pelts | Exotic Pelts | 520 | 0.15 | rare |

**Contraband — 6 total (1 existing + 5 new)** — illicit crafting, seizure risk stays the deterrent
| id | name | base | vol | rarity |
|---|---|---|---|---|
| **contraband** | Contraband | 480 | 0.18 | common |
| narcotics | Narcotics | 340 | 0.16 | common |
| forged_credentials | Forged Credentials | 410 | 0.15 | uncommon |
| weapons_cache | Weapons Cache | 600 | 0.17 | uncommon |
| bio_toxin | Bio Toxin | 720 | 0.19 | rare |
| cipher_shard | Cipher Shard | 950 | 0.21 | rare, `craftOnly` |

### 1.2 Rarity → sourcing rule

Reuse `SYSTEMS[].mods` and the sector/race/specialty structure already in
`data.js` (`belt`=mineral, `tide`=gas, `green`=agri, `forge`=tech,
`sprawl`=luxury) instead of adding a new gating system:

- `common`: stocked in every system, same as today.
- `uncommon`: stocked only in systems whose sector specialty matches the
  commodity's category, plus Navos (home/neutral).
- `rare`: stocked in 1–2 systems only (the sector specialty capital + maybe
  one more), at a noticeably worse (higher buy-cost) mod.
- `exotic` / `craftOnly`: **not** in normal system stock at all. Sourced only
  from expeditions, mission rewards, or as blueprint-tied drops. This is the
  layer that gives expeditions/missions a reason to exist beyond credits —
  and it's the version of "station-limited" worth building now; a literal
  per-station inventory system can layer on top later without conflicting.

---

## 2. Blackbox item (Inventory) + Hub boost bar

### 2.1 Data shape

Lives in `state.inventory` alongside existing accessory items, flagged
`consumable: true`. Using one removes it from inventory and pushes an entry
onto a new `state.activeBoosts: [{ effectId, expiresAt }]`.

```
BLACKBOX_EFFECTS = [
  { id: "overclock_core",  name: "Overclock Core",  desc: "+25% extractor yield",              stat: "industryYield",  mag: 0.25,  durationMs: 2*3600*1000 },
  { id: "smugglers_veil",  name: "Smuggler's Veil", desc: "-50% customs seizure odds",          stat: "customsSeize",   mag: -0.50, durationMs: 3*3600*1000 },
  { id: "autopilot_surge", name: "Autopilot Surge", desc: "-20% mission transit time",          stat: "missionTransit", mag: -0.20, durationMs: 4*3600*1000 },
  { id: "silver_tongue",   name: "Silver Tongue",   desc: "+15% contract reward",                stat: "contractReward", mag: 0.15,  durationMs: 3*3600*1000 },
  { id: "void_shield",     name: "Void Shield",     desc: "-30% mission hull damage",            stat: "missionDamage",  mag: -0.30, durationMs: 2*3600*1000 },
  { id: "tax_ghost",       name: "Tax Ghost",       desc: "-50% industry tax",                   stat: "industryTax",    mag: -0.50, durationMs: 4*3600*1000 },
];
```

(Dropped the price-forecast-reveal idea per your note — every effect above is
a plain modifier on an existing stat, nothing that reveals hidden information.)

Each effect ties directly into a system that already exists: `industries.js`
yield, `customs` seizure roll, `missions.js` transit/damage/reward, and
faction industry tax — so integrating "read active boosts" is a lookup in
code that already computes those numbers, not a new pipeline.

### 2.2 Hub display

A small buff-bar row on the Hub: icon + `mm:ss`/`Xh Ym` countdown + tooltip
with the effect's `desc`. Reads off the same clock driving market ticks —
compute remaining time as `expiresAt - now` at render time; no separate
expiry timer needed. When `now > expiresAt`, the systems that check
`activeBoosts` (industries, customs, missions) just stop seeing the modifier;
purely a filter at read time.

### 2.3 Acquisition

Don't make blackboxes single-source — mix:
- Expedition/survey loot (existing loot loop in `survey-story.js`).
- Rare Bazaar stock (rotating offer, like accessories).
- **Crafted** (§3.4) — the renewable path, once Workshop unlocks it.

---

## 3. Crafting system

### 3.1 Where it happens

New Hub panel: **Workshop** (sibling to Exchange / Bazaar / Industries).
Shows available recipes as cards, grouped by output type (Gear / Extractor /
Ship / Blackbox tabs). A card shows ingredient icons + qty (green if you have
enough, red if short), a Craft button, and — once queued — a progress bar,
same visual language as Industries' cycle bar.

### 3.2 Timed queue

Crafting is **not instant**. Workshop has `N` slots (start small, e.g. 2;
upgradeable with credits, same pattern as `inventory.upgradeStep` /
`inventoryUpgradeBase`). Each slot processes one recipe at a time; queued
crafts resolve on return like Industries batches do (offline catch-up, capped
the same way `maxCyclesPerResolve` caps industries). Craft time scales with
output tier:

- Gear: minutes to a couple hours
- Extractor: several hours
- Blackbox: minutes to an hour (it's meant to be renewable/disposable)
- Ship: many hours to multiple days — a real commitment, not a quick flip

### 3.3 Blueprint gating

Recipes aren't visible/craftable until you hold their **Blueprint** item.

```
Blueprint shape:
{ id, name, outputType: "gear"|"extractor"|"ship"|"blackbox", recipeId,
  source: "expedition" | "mission" | "bazaar" | "senate",
  uses: number | Infinity,       // most blueprints: Infinity (reusable unlock)
  destroyOnUse: boolean }        // true only for one-of-a-kind outputs
```

- Most blueprints are **permanent unlocks** once acquired — held in inventory
  (or flip a `state.knownRecipes` flag on pickup, simpler for the common
  case) and reusable forever.
- **One-of-a-kind items** (see the Sovereign-class ship below) use
  `uses: 1, destroyOnUse: true` — the blueprint is consumed the moment the
  single craft completes, and the recipe can never be crafted again on that
  save. This is the mechanic you described for the unique battleship.

Blueprint sources, deliberately mixed so no single loop gates all of
crafting:
- **Expedition-only**: rare/exotic-tier blueprints (gear, extractors,
  blackboxes) drop from survey loot the same way derelict gear does today.
  This is the "some crafting is rare, survey-only" tier.
- **Mission-only**: specific high-danger or story-flagged contracts
  (`missions.js` / `survey-story.js`) grant a blueprint as the reward instead
  of (or alongside) credits — including the path to the one-of-a-kind ship
  blueprint, likely gated behind a mission chain rather than a single job.
- **Bazaar purchase**: rotating rare stock, credits-gated, for
  players who'd rather buy their way past RNG.
- **Senate bills**: a new bill archetype (e.g. "Fabrication Rights") that,
  while active/passed, grants allied-faction players a temporary or
  permanent blueprint unlock — reuses the existing bill effect-aggregation
  pattern in `senate.js` (`_effects()`), just add a new effect type
  (e.g. `effect.type === "blueprintGrant"`) alongside `priceCap`/`subsidy`/etc.

### 3.4 Recipes (static table)

One flat `RECIPES` array, same style as `COMMODITIES`/`EXTRACTORCFG`. Numbers
below are a starting point for balancing, not final.

**Gear** (feeds `ACCESSORY_KINDS` — engine/reactor/cannon/plating/shield/hold/scanner/probe/survey_shield)

| recipe | tier | ingredients | craft time | blueprint source |
|---|---|---|---|---|
| Common Plating | common | 6 iron_ore + 2 silicon | 20 min | auto-unlocked (Baron Tier 1) |
| Uncommon Cannon | uncommon | 8 titanium_ore + 4 nanochips | 1 h | Bazaar |
| Rare Shield | rare | 6 titanium_ore + 5 sensor_array + 2 quantum_core | 2 h | Expedition |
| Epic Reactor | epic | 4 quantum_core + 3 plasma_gas + 2 gemstones | 4 h | Expedition or Bazaar |
| Legendary Scanner | legendary | 2 ai_matrix + 3 quantum_core + 1 voidstone | 8 h | Mission (story chain) |

**Extractors** (feeds `EXTRACTORCFG.types`)

| recipe | tier | ingredients | craft time | blueprint source |
|---|---|---|---|---|
| Jack Extractor | jack | 10 iron_ore + 5 silicon + 2 nanochips | 3 h | auto-unlocked (Baron Tier 1) |
| Semi-Spec Extractor | semi | 8 titanium_ore + 6 nanochips + 3 sensor_array | 6 h | Bazaar |
| Specialized Extractor | specialized | 12 titanium_ore + 10 nanochips + 4 quantum_core + 1 category-flavor item (e.g. plasma_gas for gas, spore_culture for agri) | 10 h | Expedition |

**Ships** — recipe output slots into the existing `SHIP_CATALOG` shape

| recipe | class | ingredients | craft time | blueprint source |
|---|---|---|---|---|
| Craftable Corvette | escort | 40 titanium_ore + 20 nanochips + 15 plasma_gas + 10,000cr | 24 h | Bazaar |
| Craftable Cruiser | escort | 70 titanium_ore + 35 nanochips + 20 quantum_core + 40,000cr | 48 h | Expedition or Mission |
| **The Last Aegis** (one-of-a-kind) | escort, unique | 30 voidstone + 20 ai_matrix + 40 quantum_core + 25 antimatter + 250,000cr | 5 days | Mission chain only, `uses: 1, destroyOnUse: true` |

The Last Aegis is the "really strong, only craftable once" item you
described: absurd ingredient cost gated behind a story-flagged mission chain,
stats well above the current top-end `battleship`/`dreadnought` entries, and
the blueprint burns on completion so it's a genuine one-run choice, not a
repeatable grind.

**Blackboxes** (feeds §2.1 `BLACKBOX_EFFECTS`)

| recipe | effect | ingredients | craft time | blueprint source |
|---|---|---|---|---|
| Overclock Core (box) | overclock_core | 4 quantum_core + 2 plasma_gas + 3 gemstones | 30 min | auto-unlocked |
| Smuggler's Veil (box) | smugglers_veil | 5 weapons_cache + 3 cipher_shard + 2 narcotics | 45 min | Bazaar |
| Autopilot Surge (box) | autopilot_surge | 6 sensor_array + 4 plasma_gas | 30 min | auto-unlocked |
| Silver Tongue (box) | silver_tongue | 4 fine_art + 3 vintage_wine + 2 gemstones | 40 min | Bazaar |
| Void Shield (box) | void_shield | 5 titanium_ore + 4 biofiber + 2 quantum_core | 40 min | Expedition |
| Tax Ghost (box) | tax_ghost | 6 cipher_shard + 4 bio_toxin | 1 h | Mission |

### 3.5 Cross-system hooks (per your ask — missions / senate / blackbox synergy)

- **Missions**: some contracts (esp. high-danger / story-flagged) pay out a
  Blueprint instead of, or in addition to, credits. This is also the
  intended path to the one-of-a-kind ship blueprint.
- **Senate bills**: new bill archetype grants/unlocks blueprints for allied
  factions while active (§3.3); could also add a bill type that discounts
  Workshop craft time or ingredient cost for a category, mirroring how
  `priceCap`/`subsidy` already work on Exchange prices.
- **Blackboxes**: consider one more effect purely for Workshop synergy —
  e.g. a "Fabricator's Boon" blackbox (-30% craft time or +1 Workshop slot,
  a few hours) — since Workshop timers are new, a boost that shortens them
  gives blackboxes a reason to exist beyond combat/trade stats. (Not added to
  the table above yet — flagging it as a natural 7th effect once Workshop
  ships, so the two systems visibly reinforce each other.)

---

## 4. Suggested build order

1. Commodity table expansion + rarity-based system stocking (§1) — no new UI,
   just data + the stocking rule. Also add `craftOnly` items to expedition
   loot tables so exotic materials have a source before anything consumes them.
2. Blackbox item + Hub boost bar (§2) — self-contained, consumable item type,
   one new panel widget.
3. Workshop panel + timed queue + blueprint gating (§3) — the biggest piece;
   land gear recipes first (smallest scope, reuses `ACCESSORY_KINDS`), then
   extractors, then blackbox recipes, then ships last (biggest data surface,
   depends on everything above already working).
4. Cross-system hooks (§3.5) — senate bill archetype + mission blueprint
   rewards, once Workshop itself is stable.

## 5. Open balancing knobs (revisit during playtest)

- Exact ingredient quantities/craft times above are placeholders — tune
  against existing price points (`COMMODITIES.base`) once in-game.
- Workshop slot count + upgrade cost curve (mirror `inventoryUpgradeStep`/
  `inventoryUpgradeBase`).
- Auto-unlocked Baron Tier floor: **yes** — `BLUEPRINTS[].minBaronTier`
  (0 = Baron for plating/jack; 1 = Magnate for auto blackbox recipes).
- Blueprint drop rates: expedition 6%/14%, mission 12% on high/extreme;
  **Last Aegis** excluded from RNG pools (Dispatches arc `last_aegis` only).


---

## 6. Second wave — more hulls, more gear, more boxes

Everything below is live in `js/data.js` (and mirrored into the SQL fixtures).
Ships marked *one-of-a-kind* burn their blueprint on delivery, like the Last
Aegis.

**Craft-only hulls** — never sold in the Bazaar, never offered as mercenaries.

| hull | class | notes | recipe | blueprint |
|---|---|---|---|---|
| Yard Courier | transport | 30 cargo, fast | `ship_courier` | Bazaar |
| Yard Freighter | transport | 150 cargo | `ship_freighter` | Bazaar |
| Void Caravan | transport | 470 cargo | `ship_void_caravan` | Mission |
| **The Argent Ark** | transport | 760 cargo, 5 slots, *one-of-a-kind* | `ship_argent_ark` | Mission |
| Yard Frigate | escort | fills the corvette→cruiser gap | `ship_frigate` | Survey |
| Yard Probe | survey | scan 4 / endure 2 | `ship_probe` | Auto (Tier 2) |
| Pathfinder Cutter | survey | scan 6 / endure 4 | `ship_pathfinder` | Survey |
| **The Oracle Lens** | survey | scan 11 / endure 7, *one-of-a-kind* | `ship_oracle_lens` | Mission |

**Gear** — the kinds §3.4 never covered (cargo pods, engines, survey rigs) plus
a wider rarity spread: `gear_hold_common`, `gear_engine_uncommon`,
`gear_probe_uncommon`, `gear_plating_rare`, `gear_survey_shield_rare`,
`gear_cannon_epic`, `gear_engine_epic`, `gear_shield_legend`.

**Blackboxes** — eight more effects, all on stats the game already reads, except
`surveyScan` which is added straight to a survey choice's odds in
`Expeditions.choiceChance`:

| effect | does | duration |
|---|---|---|
| Foundry Blitz | −55% craft time | 1 h |
| Bulk Yield Injector | +45% extractor yield | 1 h |
| Iron Ledger | −75% industry tax | 2 h |
| Ghost Manifest | −80% customs seizure odds | 90 min |
| Hard Bargain | +35% contract reward | 90 min |
| Aegis Field | −60% mission hull damage | 90 min |
| Long Haul Protocol | −35% mission transit | 2 h |
| Deep Lens | +10pp survey success odds | 3 h |

Exotic `craftOnly` materials (voidstone, quantum foam, AI matrix, cipher shard)
are the sink for the top tier — the uniques and the legendary gear cost them by
the dozen, which is what keeps surveys worth flying.

---

## 7. Editing all of this in-game (Admin → 🔧 Crafting)

Recipes, their blueprints, and blackbox effects are admin-editable data, saved to
the shared `content` table like every other collection (`docs/ADMIN_SETUP.md`):

- **Recipes** — add / edit / delete, with pickers for ingredients, output and the
  paired blueprint (how players get it, Baron-Tier floor, one-of-a-kind).
  Deleting a recipe deletes its blueprint too.
- **Blackboxes** — add / edit / delete effects. The stat list is exactly what
  `Boosts.mag` is read for, so a saved effect always does something. An effect a
  recipe still crafts can't be deleted.
- **Server SQL** — crafting is server-authoritative, so the database keeps its
  own copy of these tables. This pane regenerates them from your edits; paste it
  into the Supabase SQL editor. Skipping it means guests see the change and
  signed-in players get "Unknown recipe."

New *hulls* are added in Content → Ships (`SHIP_CATALOG`); mark them
`craftOnly: true` so they stay out of the shipyard and the mercenary roster, then
point a ship recipe at the id and re-run the Server SQL (it carries the hull
stats and fitment tables too).
