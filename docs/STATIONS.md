# Space Stations & the Supply Economy

**Status:** client guest path live (Phases 1–6 + bays/leases + Workshop Annex + Exchange Hall §9 + Contract Office §11 + Customs/Free Port §12 with non-capital docking). **Signed-in docking at system hubs:** paste `docs/sql/station_dock_unlock.sql` (or re-run the `app_dock` block in `phase1_players.sql`) so claimable hubs auto-unlock on dock. **Phase 4 server stock:** paste `docs/sql/phase4_sector_stock.sql` (see `docs/PHASE4_SETUP.md`) — replaces `app_trade` with stock lock + scarcity; station `app_station_*` RPCs stubbed. **Stations alive to other players (§14.1):** paste `docs/sql/station_directory.sql` — phase A publishes each station's public record, so a claimed station shows its holder and upgrades instead of "NPC", and its modules affect visitors who dock there. Then `docs/sql/station_hall.sql` — phase B makes the Exchange Hall one shared shelf: barons list and buy across saves, the owner's tariff is split off at the sale, and both sides queue for whoever is offline. Then `docs/sql/station_bays.sql` — phase C makes Production Hub bays a shared floor: lease/vacate write the `bays` column, the lessee produces on their own account, and lease tax queues as commodity cargo for the owner.
**Depends on:** shared server-authoritative state (Phase 4) for multiplayer authority
**Touches:** `market.js`, `galaxy.js`, `economy.js`, `stock.js`, `stations.js`, `workshop.js`, `ui.js`, `starmap.js`, plus SQL stubs

This is the largest structural change in the game so far. It does three things at once:

1. Converts the 78 non-capital systems from survey backdrop into **claimable, upgradeable player property**, won by auction.
2. Replaces the infinite, price-only commodity market with a **finite per-sector stock model** — the exchange has literal stock, it is consumed, and it must be replenished.
3. Makes station owners the **supply side** of that economy, under a sentiment system that removes them if they let their region starve.

Commodity trading stays at the six sector capitals. Stations do not open exchanges; they feed them.

---

## 1. The galaxy at a glance

Measured from the current generator (`GALAXY.seed = 195939070`):

| Sector | Capital | Specialty | Systems | Claimable stations |
|---|---|---|---|---|
| Core Worlds | Navos Junction | — | 12 | 11 |
| Korrin Belt | Korrin Belt | mineral | 15 | 14 |
| Tide Reaches | Velm Tide | gas | 13 | 12 |
| Green Expanse | Thessa Greens | agri | 16 | 15 |
| Forge Reach | Orin Forge | tech | 13 | 12 |
| Sable Sprawl | Sable | luxury | 15 | 14 |
| **Total** | | | **84** | **78** |

Every generated system already carries a `stationName` (`Galaxy.build`), using the suffixes Outpost / Relay / Dock / Waystation / Berth / **Anchorage**. Those become the tier ladder — no new naming needed. Capitals keep separate flavour aliases (Station / Spire / Platform / Anchorage) and stay unclaimable; Anchorage on a non-capital is the claimable top tier that unlocks the §7.1 power ceiling of 25.

---

## 2. Finite sector stock

### 2.1 What changes

Today `Market.prices[id]` is a deterministic oscillator function of time, mirrored exactly by `docs/sql/market_price.sql` under a shared seed. Quantity does not exist; buying only pushes a decaying `tradeImpact` pressure.

The new model adds **stock as the primary state**. Price becomes a *function of* stock rather than a curve read from a clock.

```js
// per sector, per commodity
stock[sectorId][commId] = units          // integer, persisted, server-owned
baseline[commId]                          // the "healthy" reference level

ratio        = stock / baseline
scarcityMult = clamp((1 / max(ratio, 0.02)) ** STOCKCFG.elasticity,
                     STOCKCFG.minMult, STOCKCFG.maxMult)

price = anchor(commId) × sectorMod(cat, sector) × scarcityMult
```

`anchor` keeps the existing deterministic oscillator, but demoted: it now supplies gentle background texture while **scarcity supplies the real signal**.

### 2.2 Price response

At `elasticity 0.35`, `minMult 0.70`, `maxMult 3.00`:

| stock vs baseline | price |
|---|---|
| 200% (glut) | ×0.78 |
| 125% | ×0.92 |
| 100% (healthy) | ×1.00 |
| 75% | ×1.11 |
| 50% | ×1.27 |
| 25% | ×1.62 |
| 10% | ×2.24 |
| 5% | ×2.85 |
| 0% (empty) | ×3.00, **no units available to buy** |

Elasticity is the single most important knob in this document. At 0.25 a 75%-depleted sector only pays ×1.41 and shortages barely register; at 0.6 it pays ×2.30 and the economy whipsaws. Sim before committing.

### 2.3 Baselines

Scale by rarity, since rare goods should feel scarce by construction:

| Rarity | Baseline units per sector |
|---|---|
| common | 6,000 |
| uncommon | 2,500 |
| rare | 800 |
| exotic / craftOnly | n/a — never exchange-stocked |

Multiply by the sector's specialty affinity: a sector produces its specialty category at ×1.6 baseline and off-specialty at ×0.7. Korrin Belt should be swimming in ore and short on grain.

### 2.4 Trading against stock

- **Buy** decrements sector stock. You cannot buy more than exists.
- **Sell** increments it.
- `Buy Max` clamps to available stock as well as the tier trade cap.
- The old `Market.addImpact` / `impactAt` slippage hack becomes **redundant and should be deleted**. Finite stock does the same job honestly: buying 400 units genuinely moves the price because there are genuinely 400 fewer units. The 25-minute artificial decay was always a stand-in for this.

This also resolves the concern raised against the earlier station-exchange proposal: because commodity trade stays at six capitals, the arbitrage-pair count doesn't explode. What changes is *why* prices differ — regional shortage, not a mod table.

---

## 3. Consumption

Every sector eats, hourly. This is the demand that makes production meaningful.

```js
consumed(sector, comm) = CONSUMPTION.base[comm]
                       × sectorPopFactor(sector)
                       × (1 + seasonalNoise)
```

| Category | Consumed where | Rationale |
|---|---|---|
| **agri** | every sector | populations eat |
| **gas** | every sector | life support, fuel |
| **mineral** | every sector, lower rate | construction, repair |
| **tech** | Forge Reach ×2, others ×1 | industry |
| **luxury** | Sable Sprawl ×2.5, Core ×1.5, others ×0.5 | wealth concentration |
| **illicit** | Sable Sprawl ×2, Core ×1.2, others ×0.6 | vice follows luxury |

Consumption drains stock directly. If it would take stock below zero, it clamps at zero and the shortfall is recorded — **shortfall is what drives sentiment**, not the stock number itself.

### The death-spiral guard

If galaxy-wide consumption ever exceeds production, everything trends to zero, prices pin at ×3.00, sentiment collapses everywhere, and mass revolts fire. That is a real failure mode and it needs a hard stabiliser:

```js
npcOutputMult(ratio) = clamp(1 + (1 - min(ratio, 1)) × 2.5, 1, 3.5)
```

| sector stock | NPC output |
|---|---|
| 100% | ×1.00 |
| 50% | ×2.25 |
| 25% | ×2.88 |
| 0% | ×3.50 |

NPC production scales up as a region empties. Tune it so **NPC supply alone roughly balances consumption at equilibrium** — the galaxy survives with zero players online — and player production is the surplus that generates profit and pushes prices down. This is the same discipline applied to charter NPC traffic: the floor keeps the lights on, players earn the margin.

---

## 4. Production

### 4.1 NPC-held stations

Each NPC station has a **production basket** derived from its system's generated `mods`: the two or three categories where its mod is below 1.0 (cheap here = produced here). The basket rerolls **every hour** within that profile, so a mineral-rich system might make Iron Ore and Cobalt one hour, Silicon and Titanium the next.

Output goes **directly into sector stock** — NPCs handle their own logistics.

If a commodity's sector stock hits zero, the next hourly tick imports a **trickle** from sectors holding a surplus (a fixed small fraction, not enough to fix the shortage). Galaxy-wide stock is therefore roughly conserved and moves from surplus to deficit, but slowly enough that a genuine shortage stays a genuine opportunity.

### 4.2 Player-held stations

Production Hub output goes into the **station hold**, not into sector stock. To raise regional supply — and to get paid — the owner must physically haul it to the sector capital and sell it on the exchange.

That friction is the entire point. It gives charters and cargo hulls a permanent job, it makes the star map a logistics problem, and it means a player station only helps its region when its owner is actually playing.

---

## 5. Ownership

### 5.1 Caps by Baron Tier

| Tier | Stations |
|---|---|
| Baron, Magnate, Tycoon | 1 |
| Oligarch, Plutocrat, Potentate | 2 |
| Cosmocrat | 3 |

Checked at bid time **and again at auction close** — a player who acquires a station elsewhere mid-auction forfeits and the next-highest bidder wins.

### 5.2 The auction

All 78 stations begin NPC-held. Any player may **open an auction** on an NPC-held station by posting an opening bid.

```js
openingBid = roundTo50k(150_000 + tier × 100_000 + Σ(installedModuleValue) × 0.5)
```

Modules persist through ownership changes (§7), so a well-developed station opens expensive. That is deliberate: inherited infrastructure should cost.

**Rules:**

- Duration **72 hours** from opening.
- Each new bid must exceed the standing bid by **at least 50,000c**. Players may bid the minimum increment or any larger amount.
- The bid is **deducted immediately** and held in escrow.
- Being outbid **refunds in full, immediately**.
- Highest bid at expiry takes ownership.
- **Anti-snipe:** any bid inside the final 30 minutes extends the close by 30 minutes. Without this, a 72-hour auction is decided by who happens to be awake in the wrong timezone — unacceptable for a global playerbase.
- Winning credits are paid to the faction controlling the system. This is a **major credit sink** and one of the few the economy has; keep it.
- Escrowed bids still count toward net worth, or players will tank their own leaderboard position by bidding.

One auction per station at a time. A player may hold multiple simultaneous bids but the sum of escrow cannot exceed their credits.

### 5.3 The Stations tab

A new top-level nav tab, **Stations**, appears once a player owns one. One sub-tab per owned station (max 3), each containing: overview, power/module management, production hub controls, tariffs and roles, treasury and ledger, and the sentiment/standing readout.

---

## 6. Sentiment and revolt

Two meters. Keeping them separate matters: collective punishment for one player's neglect would be arbitrary and infuriating.

### 6.1 Sector Sentiment (0–100, starts 70)

Region-wide, driven by whether demand was met. Per hourly tick, for each consumed commodity:

| Condition | Sentiment |
|---|---|
| shortfall (demand unmet) | −3.0 |
| stock below 10% baseline | −1.5 |
| stock below 25% baseline | −0.5 |
| stock at or above 60% baseline | +0.75 |

Clamped 0–100. Displayed on the star map as a sector-wide tint and in the Stations tab.

Sentiment has teeth beyond revolts: below 40 it raises local NPC contract danger and cuts station traffic; below 20 it triggers Senate riot edicts through the existing legislation machinery.

### 6.2 Station Standing (0–100 per station, starts 60)

Measures *this owner's* contribution.

| Condition | Standing |
|---|---|
| delivered ≥ expected units to the sector exchange this cycle | +4 |
| delivered partially | +1 |
| delivered nothing | −5 |
| production hub idle or unstaffed | −3 |
| upkeep unpaid | −6 |
| tariff above the fair-rate threshold | −2 |

`expected` scales with station tier and Production Hub level, so a Berth is not held to an Anchorage's standard.

### 6.3 Revolt

```js
revoltChance = clamp((1 - sentiment/100) × (1 - standing/100) × REVOLT.rate, 0, 0.35)
```

Rolled hourly, only when Sector Sentiment < 40 **and** Station Standing < 35. Both conditions required — a diligent owner in a starving sector is safe, and a lazy owner in a healthy sector is safe. You lose the station only when your own region is suffering and you are visibly part of why.

**Warning stages**, each a Comms dispatch, so this is never a surprise:

1. *Unrest* — standing below 45. Advisory.
2. *Protests* — below 35 with sentiment below 40. Revolt rolls begin.
3. *General strike* — below 20. Production halved, revolt chance doubled.
4. *Revolt* — ownership lost.

**On revolt:**

- Ownership reverts to NPC.
- The station resumes its **default NPC production basket** for the system.
- **All installed modules persist**, including Reactor level and Production Hub upgrades. The next owner inherits a developed station — and pays for it in the opening bid.
- Station treasury is forfeited to the controlling faction.
- Docked player assets (leased production bays, warehoused goods) are returned to their owners, not seized. Punishing bystanders for a landlord's failure would be a bad rule.
- A 24-hour cooldown, then the station becomes auctionable again.

---

## 7. Power budget

Tier grants Power. Modules cost Power. You cannot install what you cannot power.

| Tier | Berth | Relay | Waystation | Dock | Outpost | Anchorage |
|---|---|---|---|---|---|---|
| Base power | 3 | 5 | 7 | 9 | 12 | 15 |
| Base upkeep /cycle | 800 | 1,600 | 3,000 | 5,200 | 8,500 | 13,000 |

### 7.1 Reactor

The one module that buys more budget — at a steeply rising running cost.

| Reactor level | Power added | Added upkeep /cycle |
|---|---|---|
| I | +2 | 1,200 |
| II | +4 | 3,000 |
| III | +6 | 6,000 |
| IV | +8 | 11,000 |
| V | +10 | 18,000 |

Maximum power is therefore 25 (Anchorage + Reactor V) against a total module cost of roughly 48 to install everything. **Even a fully maxed station runs about half the catalogue.** Specialisation is permanent, not a phase you grow out of.

Reactor costs no Power itself but occupies a dedicated slot, so it is never a free upgrade — it is a bet that the modules it enables will out-earn 18,000c a cycle.

### 7.2 Module catalogue

| Module | Power | Requires | Conflicts | Effect |
|---|---|---|---|---|
| **Production Hub I–V** | 4 / 6 / 8 / 10 / 12 | — | — | Passive commodity production; leasable bays (§8) |
| **Refinery** | 5 | Prod Hub ≥ II | — | Converts raw output to a higher-tier commodity in the same category |
| **Exchange Hall** | 4 | — | — | Player marketplace for crafted goods (§9) |
| **Workshop Annex I–III** | 3 / 5 / 7 | — | — | Craft time and material reduction (§10) |
| **Dry Dock** | 3 | — | — | Repairs for visitors; owner takes a cut |
| **Charter Office** | 3 | — | — | Charters dispatchable from here |
| **Contract Office** | 4 | — | — | Owner-funded haul contracts (§11) |
| **Survey Relay** | 4 | — | — | Cuts expedition cooldown/transit in a radius |
| **Warehouse I–II** | 2 / 3 | — | — | Rentable storage slots |
| **Customs House** | 3 | lawful faction ≥ Neutral | Free Port, Black Market | Owner-set scrutiny (§12) |
| **Free Port** | 3 | — | Customs House | Suppresses scrutiny here (§12) |
| **Black Market** | 5 | Syndicate ≥ Friendly | Customs House | Stolen/illicit crafted goods tradeable in the Exchange Hall |
| **Lane Buoy** | 2 | — | — | Cuts travel time to this system for everyone |
| **Reactor I–V** | — | — | — | +2…+10 power, rising upkeep |

*Broadcast Array is removed — station visibility in the newswire and directory is baseline for every station.*

### 7.3 The three exclusivity mechanisms

**Antagonist pairs.** Customs House and Free Port cannot coexist — you cannot be both the port that confiscates contraband and the port that shelters it. Black Market inherits the same conflict with Customs House.

**Faction locks.** Customs House requires standing with a lawful faction; Black Market requires Syndicate ≥ Friendly. Operating either *moves* standing, so the choice compounds: a month of running a Customs House makes Black Market unreachable without deliberately rebuilding Syndicate reputation.

**Sticky swapping.** Uninstalling refunds 50% of component cost and none of the credits, and the station goes **offline for a 6-hour refit** — no production, no services, no tariff. Enough friction to make choices feel chosen; not so much that a mistake is permanent.

Refit is *offline*, not *unowned*. Through the whole downtime the owner keeps the station, the Stations tab, the star-map panel and every owner control (reassign, staff bays, withdraw, relinquish), and nobody can auction it out from under them. Only `npc` and `cooldown` are ownerless states.

### 7.4 Sample builds at Waystation (7 power)

| Build | Modules | Identity |
|---|---|---|
| Foundry | Production Hub I (4) + Refinery (5)† | Pure supplier — needs Reactor I |
| Bazaar | Exchange Hall (4) + Warehouse I (2) | Crafted-goods trading post |
| Shipyard | Dry Dock (3) + Charter Office (3) | Fleet services depot |
| Haven | Free Port (3) + Black Market (5)† | Smuggler sanctuary — needs Reactor I |
| Guild hall | Workshop Annex I (3) + Warehouse I (2) + Lane Buoy (2) | Crafter's base |

† over budget at base tier — the Reactor decision, exactly where it should sit.

---

## 8. Production Hub

Functions like the existing Industries system and should reuse its plumbing (`INDUSTRYCFG`, extractors, components, `Extractors.bonuses`).

**Owner controls:**

- **Assigned commodity** — chosen from what the system supports. A system can produce any commodity in a category where its generated `mods` value is below 1.0. *Changing* it costs a retooling downtime (half a refit); the first assignment on an idle hub has nothing to retool from, so it starts clean.
- **Level** — I–V, each raising both yield and bay count.
- **Lease tax** — 0–40%, owner-set, applied to non-owner output.

| Level | Power | Yield /cycle | Bays | Upkeep /cycle |
|---|---|---|---|---|
| I | 4 | 60 | 2 | 900 |
| II | 6 | 140 | 3 | 1,800 |
| III | 8 | 260 | 4 | 3,200 |
| IV | 10 | 420 | 6 | 5,000 |
| V | 12 | 640 | 8 | 7,500 |

Yield is further modified by extractor quality and installed components, exactly as planet industries are today.

**Leasing.** The owner occupies as many bays as they wish; the rest are leasable to any visiting player. A lessee installs their own extractor into the bay and produces on their own account, with the owner taking `leaseTax%` of output at source. Lessee output lands in *their* hold and they haul it themselves. **Across players:** live once `docs/sql/station_bays.sql` is applied (§14.1 phase C) — occupancy is the shared `bays` column, tax queues as commodity cargo for the owner.

This is the cleanest player-to-player loop in the design: it gives extractors a second home, it gives players without a station a way to participate in production, and it gives owners revenue that scales with how attractive their terms are. Set the tax at 40% and the bays sit empty; set it at 10% and you're running a busy factory on someone else's capital.

Lease tax above a fair-rate threshold feeds the Station Standing penalty (§6.2), so gouging carries a real risk.

---

## 9. Exchange Hall — the player marketplace

**Client status:** live in guest mode (`Stations.listHallItem` / `buyHallListing` / `_npcBuyHall`), and **live across players** on a published station once `docs/sql/station_hall.sql` is applied (§14.1 phase B) — same three calls, routed to the shared shelf. Owners manage via the Stations tab; visitors use the Star Map system panel while docked at the sector capital (non-capital docking lands with Customs/Free Port). NPC buyers (`hallNpcBuyChance`) clear stalls so guest solo play has liquidity, and stand down on a shared shelf where real barons are the liquidity. Customs House without Black Market blocks blackbox listings.

Stations do **not** trade commodities. The Exchange Hall trades everything else: gear, accessories, crafted ships, extractors, components, blackboxes, blueprints.

- Any docked player may **list** a crafted item at a price of their choosing.
- Any docked player may buy.
- The station owner takes a **sale tariff** (owner-set, 0–15%).
- Listings expire after a set window; unsold goods return to the seller's inventory.
- Commodities are explicitly excluded — those belong to the capital exchanges and the stock system.

This is the "player hub" role: the only place in the game where players trade directly with each other, and the reason a station becomes a destination rather than a waypoint. A well-run Exchange Hall with low tariffs and heavy traffic is the social-hub fantasy made concrete.

---

## 10. Workshop Annex

Reduces craft time and material requirements for crafting performed at this station.

| Level | Power | Craft time | Material discount | Upkeep /cycle |
|---|---|---|---|---|
| I | 3 | −15% | −10% | 1,000 |
| II | 5 | −30% | −20% | 2,200 |
| III | 7 | −45% | −30% | 4,000 |

Material quantities round **up**: `qty = Math.ceil(base × (1 - discount))`. No fractional components ever enter inventory.

### The rounding interacts badly with small recipes

| base qty | −10% | −20% | −30% |
|---|---|---|---|
| 2 | 2 | 2 | 2 |
| 4 | 4 | 4 | 3 |
| 5 | 5 | 4 | 4 |
| 6 | 6 | 5 | 5 |
| 8 | 8 | 7 | 6 |
| 12 | 11 | 10 | 9 |
| 20 | 18 | 16 | 14 |

A 2-unit ingredient never benefits at any tier, and Level I does nothing for anything under 10 units. Looking at the current `RECIPES` table, most ingredients sit in the 2–8 range, so **Level I will feel broken to players** even though it is behaving as specified.

Three options, pick one deliberately:

1. Accept it, and market Workshop Annex as a bulk-crafting perk (fine, but Level I is then near-worthless).
2. Apply the discount to the **whole recipe cost** and let the player choose which line item absorbs the saving.
3. Discount stochastically — a 20% discount means each unit has a 20% chance of not being consumed, resolved at craft time. Averages correctly, works at every quantity, and gives a small pleasant surprise on completion.

Option 3 is the one that feels best in play and holds the "no decimals" rule.

---

## 11. Contract Office

**Client status:** live in guest mode (`Stations.postHaul` / `claimHaulForLaunch` / `settleHaul` / `_npcFillHauls`). Owners post from the Stations tab (hold → escrowed bounty). Jobs inject onto the Bazaar Contracts board (`Bazaar._injectStationContracts`), fly through existing `Missions`, and settle goods into sector stock at the capital. Owners cannot fly their own hauls. NPC haulers fill slowly after a delay. Reliability = filled / (filled + expired), shown on the map tip and board copy.

The owner deposits credits into a **bounty pool** and posts haul orders: *deliver 200 Helium-3 to Korray Waystation, 210c/unit*. Payouts are escrowed at post time, so a broke owner cannot stiff a hauler and posting decoy contracts locks up real credits.

Postings appear on the normal Bazaar contract board for every player, flagged with the station name and the owner's handle, and fly through the existing `Missions` system — phases, success rolls, damage, all of it. No new mission machinery.

Because a player station's production must be hauled to a capital to reach the market, the Contract Office is how an owner buys their way out of doing it personally: pay other humans to move your goods. NPC haulers fill orders slowly at fair rates so the board is never fully dead at low concurrency, but human players clear it far faster.

**Reliability rating** — fulfilled-versus-expired ratio, shown publicly in the station directory. Drives NPC traffic and tells other players whether your postings are worth flying.

**Posting fee** to the controlling faction, so self-dealing through an alt account is quietly loss-making.

---

## 12. Customs House and Free Port

**Client status:** live in guest mode. Non-capital stations are dockable (`Economy._dockLocal` + map travel via galaxy `pos`). `Economy.customsScan` reads `Stations.scrutinyFor`; Customs House seizures go to `impoundHold` with ransom claims; Free Port lowers scrutiny and damps border edicts. Scrutiny is public on the star map before undock. Allied/Partner/owner skip Customs scans. Black Market requires Exchange Hall. Enforcement subsidy + standing/rep forks tick hourly. Covered by `tools/check_customs.js`.

Both plug into the existing `CUSTOMS` block — `base: 0.10`, `cap: 0.85`, `repShield: 0.30`, `scrutinyClamp`, `seize: [0.30, 0.70]`. No new subsystem; the owner simply controls an input.

**Customs House** raises seizure odds above baseline for players docking here.

- Seized contraband enters the station's **impound hold**. The owner may sell it at a capital or **ransom it back** to the smuggler for a bribe — itself a Syndicate-standing fork.
- Lawful factions pay an **enforcement subsidy** per cycle, and standing climbs.
- The station carries a public **Clean** flag, lifting legitimate NPC traffic and reducing raid events.
- Cost: smugglers route around you, Syndicate standing craters, and Black Market is locked out.

**Owner controls:** a **scrutiny dial** (0–100%) rather than a binary switch, and an **exemption list** bound to the Allied role — which finally gives alliances real teeth. My friends walk through; everyone else gets scanned.

**Free Port** suppresses scrutiny below the global baseline, partially offsetting Senate border edicts via `smuggleFailAdd`. Illicit trade concentrates on you, Syndicate standing climbs, lawful standing falls, and you become a standing target for Senate prohibition edicts.

**Non-negotiable: scrutiny level is public**, shown in the station directory before anyone undocks toward you. Hidden confiscation is a trap and players will rightly hate it; displayed confiscation is a decision they made with open eyes. Same principle as showing charter destruction odds before dispatch.

---

## 13. Roles

| Role | Can |
|---|---|
| **Owner** | Everything: modules, tariffs, roles, treasury withdrawal, production assignment |
| **Partner** | Adjust services, tariffs and production; view the ledger. **Cannot** withdraw, sell, or transfer |
| **Allied** | Reduced or zero tariffs; exempt from Customs House scrutiny |
| **Guest** | Default. Docks, trades, leases bays, pays full tariff |
| **Barred** | Denied docking |

Partner cannot withdraw, or co-ownership is a trust exercise with no recourse. Capitals remain permanently neutral and free, so no combination of blacklists can lock a player out of the game — the worst case is inconvenience.

---

## 14. Backend

**Live (Phase 4 paste):** `docs/sql/phase4_sector_stock.sql` — `sector_stock` + RLS, `market.scarcity_mult` / baselines, replaced `app_trade` (stock lock + scarcity), `app_sector_stock`, optional `app_stock_tick` cron. Station tables partially created; `app_station_*` return not-implemented stubs.

```sql
stations          system_id PK           -- one per system, enforced by schema
                  owner_id NULL, tier, power_used, reactor_level,
                  modules jsonb, treasury, upkeep_paid_through,
                  standing, scrutiny, lease_tax_bps, sale_tariff_bps,
                  status ('npc'|'owned'|'refit'|'cooldown')

station_access    station_id, player_id, role
station_ledger    append-only revenue / expense rows
station_bays      station_id, bay_index, lessee_id, extractor_id, produced_units

auctions          station_id, opens_at, closes_at, status
auction_bids      auction_id, player_id, amount, placed_at, refunded_at

sector_stock      sector_id, comm_id, units, updated_at   -- LIVE
market_listings   station_id, seller_id, item jsonb, price, expires_at
```

### 14.1 Making a station alive to other players

A station's whole record — owner, modules, tariffs, scrutiny, shelf, bays — lived only in its owner's save, so everyone else saw a vacant NPC berth. Landing that in phases, because the transactional half needs the record to exist first:

| Phase | What lands | State |
|---|---|---|
| **A** | Public station record + every effect that's a pure read of it | **live** — `docs/sql/station_directory.sql` |
| **B** | Exchange Hall: list + buy across players, tariff to the owner's treasury, payout queue | **live** — `docs/sql/station_hall.sql` |
| **C** | Production bays: lease, produce, lease tax at source | **live** — `docs/sql/station_bays.sql` |
| **D** | Contract Office postings on the shared board; treasury / upkeep / standing server-side; then auctions | after C |

**Phase A (live):** `docs/sql/station_directory.sql` — adds `owner_display`, `updated_at`, `hall` and `bays` to `stations`, plus `app_station_directory` (anon + authenticated read) and `app_station_publish` (authenticated write). Owners publish their held stations; every client reads them through `Stations.view(systemId)`, which returns the owner's record in place of the local vacant one. Consequences that follow immediately, because the client already computes them from `modules`: their **Customs House** scans you and their **Free Port** doesn't, their **Workshop Annex** speeds your crafting, their **Dry Dock** / **Survey Relay** / **Lane Buoy** apply at your dock, their scrutiny is public before you undock, and their hub stops minting NPC supply into the shared shelf (§4.2). Their shelf and bay occupancy are visible read-only. Claims are first-come, released on relinquish/revolt, and a row unrefreshed for 30 days ages out so an abandoned save can't lock a station out of the auction pool. Treasury and hold stay unpublished until the server owns the transactions that move them.

**Phase B (live):** `docs/sql/station_hall.sql` — the shelf itself moves to the server, so a stall one baron puts up is the stall another baron buys. `station_listings` holds the listing *and the item* while it sits in escrow; `station_payouts` is the queue that pays whoever was offline when the sale happened. `app_station_hall` reads a shelf (anon, like the directory — a signed-out visitor browses but can't trade), `app_station_list_item` / `app_station_buy_item` / `app_station_cancel_listing` move goods, and `app_station_settle` hands back what's owed in one round trip: sale proceeds and tariffs as credits, plus the payloads behind stalls that expired or were cleared.

The server owns the listing row, the 48h expiry clock, the tariff split at the moment of sale, and the payout queue. It does **not** own player credits: the buyer's client debits itself once the RPC returns. A tampered client could take an item without paying; it can't fabricate one, spend someone else's escrow, or pay itself. The debit moves inside the transaction in phase D, when treasury and upkeep become server-side.

Client side, `Stations.hallShared(systemId)` is the seam: a published station's shelf comes from `hallRemote`, an unpublished one (offline, signed out, or a project without this SQL) keeps using the local `st.hall` exactly as before. Stalls still sitting in a save are pushed up on first sync — never copied, so an item is never in both places. NPC hall buyers stop on a shared shelf: they were liquidity for a shelf nobody else could reach, and real barons are that now. Items arriving with nowhere to go (inventory full) wait in `Stations.unclaimed`, which survives a save and lands them on the next tick — they're already paid for.

Payloads are a trust boundary in both directions: another player's client authored them, so every object is rebuilt field by field against the catalogs on arrival, uids are re-minted so they can't collide with ours, and values are recomputed rather than read. A ship crosses as a bare hull — accessories and yard refits live in `state.items` / `state.shipVariants` and aren't part of the sale — and an extractor crosses without its fitted components for the same reason.

**Phase C (live):** `docs/sql/station_bays.sql` — the bay floor moves to the shared `bays` column. `app_station_lease_bay` / `app_station_vacate_bay` claim and free slots; `app_station_bay_produce` splits lease tax at the published rate into `station_bay_tax` (commodity units for the owner's hold); `app_station_settle` was extended to hand that cargo back with the hall payouts. `app_station_publish` merges rather than overwrites, so an owner's autosave can't wipe a remote lessee. The extractor stays in the lessee's save (`Stations.remoteLeases`); the server only records who holds the slot. Lessee keep is still client-side — same trust model as hall credits. Impound ransom stays local (claims aren't published yet).

Client side, `Stations.bayShared(systemId)` is the seam: a published station's floor goes through the RPCs, an unpublished one keeps today's local lease path. NPC bay tenants stay on the local/guest path only.

**Phase D:** Contract Office postings on the shared board; treasury / upkeep / standing server-side; then auctions. Credits become authoritative here, which also closes the hall buy-without-paying and bay tax under-report holes. Remaining stubs: `app_station_bid`, `app_station_auction_open`, `app_station_module_install`, `app_station_set_policy`, `app_station_withdraw`.

**RPCs:** `app_trade` (stock+scarcity LIVE), `app_sector_stock`, `app_stock_tick`, `app_station_directory` + `app_station_publish` (LIVE), `app_station_hall` + `app_station_list_item` + `app_station_buy_item` + `app_station_cancel_listing` + `app_station_settle` (LIVE), `app_station_lease_bay` + `app_station_vacate_bay` + `app_station_bay_produce` (LIVE); stubs: `app_station_bid`, `app_station_auction_open`, `app_station_module_install`, `app_station_set_policy`, `app_station_withdraw`.

**Cron (hourly):** `app_stock_tick` for consumption + NPC elastic backstop (optional). Full sentiment/revolt/auction close still client-side until station RPCs land.

**RLS:** public read on `stations`, `sector_stock`. `station_listings` and `station_payouts` have RLS on with **no** policies — an escrowed payload is never directly selectable. Writes gated by SECURITY DEFINER RPCs.

**Critical:** stock decrements and scarcity pricing live **inside** `app_trade`. Do not fork a parallel client path for signed-in players.

---

## 15. Build order

1. **Sector stock, single-player first.** Add `sector_stock`, wire consumption and NPC production, derive price from stock, delete `Market.addImpact`. Rewrite `docs/sql/market_price.sql` — the seed-determinism contract is broken by design and both client and server must change together. Sim a 30-day galaxy with zero players and confirm it reaches equilibrium.
2. **Stations as NPC entities.** All 78 exist, produce, and appear on the map. No ownership yet.
3. **Auction system** — opening, bidding, escrow, anti-snipe, close, refunds.
4. **Stations tab** — ownership, power budget, Reactor, module install/uninstall with refit downtime.
5. **Production Hub** including leasable bays.
6. **Sentiment, standing, revolt**, with all four warning stages.
7. **Exchange Hall, Contract Office, Customs/Free Port, Workshop Annex.**
8. `tools/check_stations.js` and `tools/check_stock_economy.js`.

Step 1 is the risky one and it is worth building the simulation harness before the feature. Everything after it is additive.

---

## 16. Open questions

- **Is a 72-hour auction too slow for an early galaxy?** With 78 stations and few players, the first month is mostly waiting. Consider a shorter window (12–24h) until some threshold of stations are claimed, then lengthen it as competition rises.
- **What stops one player's alt accounts from bidding each other up?** Nothing here does. The faction sink means it only burns credits, but a whale could still park stations under alts to dodge the tier cap. Worth an account-level check.
- **Refit downtime versus revolt risk.** A 6-hour refit means zero deliveries, which costs Station Standing at the exact moment you are investing in the station. Consider suspending standing decay during a declared refit.
- **Should Sector Sentiment be visible to non-owners?** Yes for the map tint, but a precise number turns "help your region" into an optimisation problem for everyone rather than a responsibility for owners. Suggest a coarse five-band label publicly, exact figures only in the Stations tab.
