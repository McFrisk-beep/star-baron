# Space Interactivity — mining, piracy, and the law

**Status: build order steps 1–4 are built, plus step 5's security bands
(§5.3) and police response (§5.2, in its built form below).**

- **Step 1 (POI layer, §2):** `js/pois.js` seeds the places, `js/starmap.js`
  renders them, makes them clickable and adds the minimap;
  `tools/check_pois.js` is the determinism check.
- **Step 2 (mining + the miner class, §3):** miner hulls in `SHIP_CATALOG`
  (+ `app.ship_def` / `app._ship_slots` rows — re-paste
  `phase2_missions_bazaar.sql` and `equip_persist.sql`), seeded seams on belt
  POIs, `js/mining.js` runs the dispatch → park → untaxed batches → recall
  loop, NPC barges work the rich belts, and the belt's POI card carries the
  controls. `tools/check_mining.js` is the check. **Now server-settled too:**
  `docs/sql/mining_rpcs.sql` moves the whole loop — batches, raids, returning
  hulls — into `app_pull`, so a signed-in baron can dispatch and close the tab;
  the op row carries the three numbers the server cannot derive (`per`,
  `threat`, `repel`), computed by the client and clamped server-side, and
  `tools/check_mining_parity.js` pins the two implementations together. §11 Q3
  is **settled: ore stays private** — it lands in `state.positions` + the system
  bay, NOT the sector shelf, so the `npcOutputMult` trap in §3.7 stays
  untriggered. Claims (§3.6) and the extra classes (§3.8) are still open.
- **Step 3 (NPC piracy, §4):** `js/raiders.js` is the whole consequence layer.
  Corsairs jump parked claims and rob NPC haulers; `tools/check_raiders.js` is
  the check. Threat is derived from a number that already existed — the seam's
  own richness, which already carries the sector (`MININGCFG.sectorRich`), so
  "the rich seams sit in the worst neighbourhoods" needed no second table. A
  pirate den in the system multiplies it, Senate lane patrols swing it, and in
  the Sprawl Syndicate standing buys quiet (§5.4). Escort hulls now have the
  standing job §3.5 asked for: guard the claim from the belt's own card, scored
  with `Charters.defenseScore` so there was no second balance pass. Every roll
  is a pure function of `(op, cycle index)`, so a night offline banks exactly
  the raids a watched tab would have seen. **The anti-grief rules of §6.6 are
  enforced against NPCs first, because this is where the player learns what
  raiding costs:** a raid takes the batch that was in the hold and nothing else
  — never banked ore, never the system bay, never a hull. A robbed miner takes
  damage (a repair bill) and can be chased off its rock; it always flies home.
- **Step 4 (player piracy on NPC traffic, §4):** `js/piracy.js`. An NPC hauler
  in the system view is now a clickable contact carrying §4.3's verbs — rob,
  toll, and (on relief traders only) escort. Dispatch an armed hull, close the
  tab: the odds, loot ranges and target worth are stamped on the op at
  dispatch, and the outcome is a pure function of the op id, exactly the
  mining pattern. §4.2 is live: a robbed delivery is taken **off the
  destination sector's shelf** (`Stock.take`) — the opposite of step 3's
  shelf-neutral NPC raids, deliberately, because here the drain IS the loot —
  and the pirate can sell into the spike they made. §4.4 is live: stolen units
  are flagged **hot** (`state.hot`), and the existing `CUSTOMS` docking scan
  seizes from the hot slice only — legitimate units of the same commodity
  pass. §5.1's *prevention* is the law half that shipped with it: in a policed
  system the verb is simply not offered (`Piracy.verbs` reads
  `Security.bandOf`); *response* is still design. A failed run costs a repair
  bill and `CRIMECFG.gain.piracyFail` — §6.7's "high variance, never free"
  rule, enforced from day one. Client-local like mining before its SQL:
  signed-in dispatch is gated until a piracy SQL surface lands
  (`Piracy.local`, keys on `Cloud.localOnly`). `tools/check_piracy.js` is the
  check. A robbed run limps on with an empty hold — the same distress pulse as
  a corsair hit, one law for the whole world.
- **§5.2 police response (the other half of step 5):** `js/police.js`. Three
  pieces, still no AI anywhere. **Precincts** sit at the **sector capitals** —
  the seats of the law, one per sector — drawn in the scene with a rotating
  red/blue beacon. Still derived rather than authored: a capital also has to
  be somewhere the law actually runs (`POLICECFG.precinctMinScore`, the
  Contested boundary), which is what keeps Senate stations out of the Sable
  Sprawl on §5.4's own grounds — the Syndicate is the law there — and means
  lifting Sable Reach above the floor by playing would open one. That is 5 of
  6 sectors today. (An earlier build keyed precincts to the top security band
  instead; it put 12 of 13 stations inside the Core and left four sectors with
  no police at all, which is the failure mode the capital rule exists to
  avoid.) **Patrols** are §5.2's seeded flight plans given hulls and lights: each
  sector with a precinct flies a standing patrol, always in a **pair**,
  launching from the capital and sweeping out across that sector's systems on
  a seeded loop, riding the same Voyages pipeline as all traffic, strobing
  red/blue in the scene. `pairsPerSector` is the density knob: at 1 that is 5
  pairs — 10 hulls — galaxy-wide, ~4 of them in flight at any moment and the
  rest docked between sweeps. They are drawn on the **galaxy chart** too, the
  way NPC haulers are: a lead hull with its wingman in echelon under strobing
  red/blue, named, with the same two lamps badging every capital that seats a
  precinct — and both ride a **Law** chart layer with its own legend key, so
  switching it off takes the stations and their patrols together. **The
  chase** is §5.1's response made concrete: a successful robbery can draw
  pursuit on the way home, odds scaled by the law stamped on the op at
  dispatch, resolving *exactly like a mission* — the outcome is a pure seeded
  function of the op (offline banks the same chase a watched tab sees), then
  a mission-shaped report lands in Comms → Dispatches that `BattleView`
  replays off the smuggle template (a run for the gate, pursuers cutting
  angles), fielding `ENEMY_CATALOG.police` hulls in pairs. Police are
  formidable but killable: caught costs exactly the stolen cargo (recovered
  to the shelf it was bound for) plus a repair bill — never the hull, never
  banked stock, never credits; each destroyed pair adds
  `CRIMECFG.gain.police` (the worst charge on the books) and draws a heavier
  wave, up to `maxWaves`, and a broken pair sometimes yields `POLICE_ITEM` —
  the one accessory `Items.gen` cannot roll. This deliberately trades §5.2's
  parked-picket sketch for a resolved encounter, at the owner's direction —
  but keeps the sketch's actual point: no pathfinding, no behaviour trees, no
  tick loop, and the movie never decides anything. `tools/check_police.js` is
  the check. Crime with teeth beyond the chase (§5.5 bounties) is still
  design.
- **§5.3 security bands (part of step 5):** `js/security.js` computes how much
  law is present in a system — sector floor + sector capital + station modules
  + Senate edicts + a running war — and the galaxy chart paints it: each region
  is a blob hugging its own systems, tinted by its band, with system nodes
  wearing their faction's colour (`Galaxy.factionOf`, tallied off the planets
  each system actually works; Syndic space answers to the Syndicate per §5.4).
  `tools/check_security.js` is the check. **Raiders reads the same number**, so
  there is one answer to "how lawful is here" rather than two that drift — and
  fitting a Customs House now measurably protects your own mining claims *and*
  repaints the map for everyone. The other half of step 5 — police *response*
  as a seeded flight plan (§5.2), and crime with teeth — is still design only.

**Site churn (§1.3's epoch input) is also built.** A system's *slots* are
permanent geography, but their *occupants* are not: belts, debris fields and
derelicts are worked out by NPC crews over a seeded 1–3h lifetime (`POICFG`,
staggered per site) and a fresh site takes the slot — new name, new
composition, a short drift within the slot. Gas clouds, jump buoys, listening
posts, rigs and **pirate dens stay put** — a den leaves only when someone
clears it (§7.1). For belts this is what makes the NPC barges mean something:
they drain the same finite pool you do, so a rock nobody touches is empty by
the time the crews move on, and getting there early is the whole game. A
parked miner whose rock is cleared flies home rather than silently working a
seam it was never sent to. Nothing new is stored: occupancy is
`f(slot, generation)` and the generation is `f(clock)`; the only row is still
what *you* took, and it dies with its generation. Mining's cadence dropped to
30-minute batches (`MININGCFG.cycleMs`) so several land inside a site's life.

Everything from §5.1 on, apart from the §5.3 bands noted above, is still
design only. The document is the consolidated
output of two brainstorming rounds, written down so the decided parts can be
separated from the open ones before anybody opens an editor.

Companion to `REALTIME_SPACE.md` and `LIVING_GALAXY.md`:

- `LIVING_GALAXY.md` owns the **geometry and the camera** — lanes, gates,
  `pos(plan, t)`, the combat view, world space. It is largely built.
- `REALTIME_SPACE.md` owns the **long-range scoping** — its §16–19 already sketch
  a POI layer, instanced sites, missions-as-journeys and a crime ladder.
- **This document refines the piracy / police / mining half after design review.**
  Where it differs from `REALTIME_SPACE.md`, this one wins; where it touches
  lanes or the combat view, `LIVING_GALAXY.md` wins.

The premise stays fixed. The game is **idle-first**: everything below must
resolve correctly for a player who dispatches and closes the tab. Presence adds,
absence never subtracts.

---

## 0. What already exists (the reason this is affordable)

Almost none of this is new machinery. It is new *verbs* on machinery that shipped.

| Existing | What it gives this design |
|---|---|
| `SYSTEMVIEW.worldSpan` (2000) vs `coreSpan` (1000) | The deep-space ring is already reserved, in `js/data.js`, for "mission instances, surveys and pirate encounters" |
| `js/voyage.js` — `plan()`, `pos(plan, t)`, `legPhase()` | Position is a pure function of `t`, so two flight plans intersect **analytically**. No simulation, no tick loop |
| `js/traffic.js` | Named NPC freighters with a real ≤3-commodity manifest. Its own header calls them "the future targets for piracy" |
| `js/charters.js` — `defenseScore`, `destroyChance`, `payoutFrac` | A fleet-vs-risk resolver that only needs pointing at a second fleet |
| `js/combat.js` + `js/battleview.js` | Any resolved report can be choreographed and replayed. The fight already has a face |
| `js/stock.js` + `STOCKCFG` | Finite per-sector shelves with consumption, `npcOutputMult` relief and sentiment. **This is what makes theft matter** |
| `js/crime.js` + `CRIMECFG` | A 0–1000 lawfulness score, server-owned, cooling 1/day. Its own ponytail note reserves it for "smuggling/piracy sources" |
| `CUSTOMS` | Seizure odds, rep shielding, per-system scrutiny — a working fence-or-risk gate |
| `js/extractors.js` | specialized / semi / jack yield tiers, naming, components. A complete mining-rig framework that happens to be pointed at planets |
| `flagship_presence` (`js/voyage.js`) | Cross-player rows already published and read. `Voyages.others()` already draws other barons |
| `js/wars.js` | Faction wars with a ponytail note explicitly asking for player contributions to decide the victor |
| `Voyages.isCheck` / `applyCheck` / `UI.showVoyCheck` | A live choice-encounter modal with a 15s timeout that falls back to the seeded auto-roll |

---

## 1. Principles (the load-bearing ones)

1. **Everything is a place.** The missing primitive is not "content" — it is *a
   clickable thing at a location in the deep-space ring*. Asteroids, dens, wrecks,
   bosses and intercepts are all that one primitive with different lifetimes.
2. **Render the record.** Fights dramatize a decided outcome. The visual layer
   never decides anything. (Inherited from `LIVING_GALAXY.md` §1.)
3. **Seeded site, tiny state row.** `site = f(systemId, poiId, epoch, seed)` is
   generated and never stored; `state = { claimedBy, clearedAt, depleted }` is the
   only row that exists. Re-explorable without unbounded storage.
4. **Derived, never authored.** Security bands, den pressure and response
   strength are computed from state that already exists (sector, station modules,
   Senate edicts, war, crime). Players change the world by playing, not by being
   told what changed.
5. **Consent through action, not a toggle.** You become a target by doing
   targetable things, and every one of those things pays better for the risk.
6. **Only cargo in transit is ever at risk.** Never docked assets, never station
   holdings, never the save blob. Maximum blast radius is one manifest.
7. **PvP is server-authoritative or it does not ship.** This is the one place the
   "no new infra" rule breaks, and it should be acknowledged as the single most
   expensive item here rather than smuggled in.

---

## 2. The POI layer — the foundation everything else needs

Seeded per system from `GALAXY.seed`, 4–12 points of interest scattered through
the ring between `coreSpan` and `worldSpan`. No storage; identical for every
client, exactly like `Galaxy.build()` and the bazaar board.

| POI | Purpose |
|---|---|
| **Asteroid / belt cluster** | Mining sites (§3), cover in a chase, ambush terrain |
| **Derelict hulk** | Survey target, salvage, occasionally occupied |
| **Debris field** | Cover, scrap, the leftovers of a fight that actually happened |
| **Gas cloud** | Sensor shadow — makes "run" a real option instead of a stat check |
| **Mining rig / refinery** | The visual home `js/industries.js` has never had |
| **Jump buoy** | Lane anchor; gives the Lane Buoy station module a body |
| **Pirate den** | Makeshift station; the persistent threat of §7 |
| **Listening post** | Intel, mission objective, omen source |

`sys.asteroidBelt` already exists (`js/galaxy.js:43,61`) and `ASSET.asteroids()`
already renders (`js/starmap.js:1079`). The work is: place POIs deterministically,
render with the existing image/fallback pattern, make them clickable, add a
minimap so a wider world stays navigable.

**Why this is first:** every later feature needs a destination *inside* a system.
Without POIs, mining, dens, bosses and intercepts all have nowhere to happen.

---

## 3. Mining and the miner class

### 3.1 Why mining comes before piracy

This reverses the ordering in the first brainstorm round, deliberately. Piracy
without mining is robbing the same NPC freighters forever. Mining creates two
things piracy needs to be interesting: a **stationary, fat, poorly-armed target
that the owner chose to place in dangerous space**, and an **ore leg** — a second
cargo run that has to happen before value is realised.

### 3.2 Mining is the untaxed twin of `industries.js`

| | Planet industry (built) | Asteroid mining (new) |
|---|---|---|
| Access | Faction permit, standing-gated | None — open space |
| Cost | Permit price + per-batch tax | No tax |
| Risk | Seizure at ≤ −40 standing | Robbery, claim jumping |
| Feels like | Safe and taxed | Free and exposed |

That is a real strategic axis rather than a second grind, and it needs no new
faction plumbing — the absence of faction plumbing *is* the feature.

### 3.3 Asteroids as sites

Each rock is seeded: composition (which mineral/gas commodities, at what
richness), size, and a **finite yield pool** that depletes as it is worked and
regenerates on an epoch. Depletion is the only stored field.

**The rich seams sit in the worst neighbourhoods.** That single placement rule
does all the risk/reward work and requires no balancing pass of its own.

### 3.4 The miner class

`cls: "miner"`, symmetric with the existing `transport` / `escort` / `survey` /
`main` in `js/data.js`. Slow, lightly armed, decent hull, modest ore hold, and one
new stat — yield rate. A progression like Prospector → Rock Hopper → Core Driller
→ Belt Leviathan, with Bazaar refits applying exactly as they do to every other
hull (a "Deep Core" variant trading speed for yield).

**Rigs reuse `js/extractors.js` wholesale.** Specialized / semi / jack tiers,
component slots, naming and bonus maths already exist and are already balanced.
A miner has rig slots; a specialized rig gets the best rate on one commodity.
Zero new framework.

### 3.5 The vulnerability is the design

A parked miner is a stationary target sitting in space for hours, and it is
**opt-in by placement** — you chose the rich rock in yellow space. That one fact
generates most of the social game:

- The `escort` class finally has a *standing* job (guard the claim) rather than
  only a contract-board job. **Built in step 3:** idle escort hulls are picked
  on the belt's card, ride the op out and home, and repel raids on a saturating
  curve — a bare miner almost never repels, a heavy wing usually does, and
  nothing is ever immune.
- Player-to-player mercenary escort becomes a real service with a real price.
- **The ore leg**: mined ore accumulates at the rock or in the miner's hold and
  must be hauled to a station to become tradeable. A second raidable leg, and the
  thing that makes `transport` matter again.

### 3.6 Claims

A rock can be claimed for an epoch (one small row). Claim jumping is a crime in
policed space and free in red space — a legible, place-anchored conflict that
costs one boolean and generates arguments for free.

### 3.7 Economy hooks — and the one real trap

Mined output should feed the **sector shelf** (`js/stock.js`), not only personal
`state.positions`. That is what makes mining a genuine price lever and gives the
death-spiral guard a player-side counterweight.

> **The trap:** `npcOutputMult` scales NPC supply up as a shelf empties and
> throttles it on glut. If player-mined tonnage lands on the shelf **without
> being counted in the ratio that drives it**, NPC relief convoys keep surging
> against a stale number and you have built an infinite-supply exploit directly
> into the stabiliser. Player supply must be inside the ratio, not beside it.

Raw ore → refined commodity through the existing Workshop / Production Hub gives
crafted materials a source that isn't the bazaar.

### 3.8 Classes worth considering while the door is open

Adding one class means touching class-handling code once. Candidates:

- **Salvager** — turns wrecks into materials. Closes the loop on all the combat
  the rest of this document adds.
- **Tender** — field repair without flying home.
- **Interdictor** — detects and slows flight plans. Gives piracy a *skill* input
  beyond raw firepower, and gives the defender something to counter.

---

## 4. Piracy against NPC traffic

The PvE half. It ships before anything player-facing and teaches the whole threat
model in a sandbox where nobody can be griefed.

**All of this is built.** Step 3 (`js/raiders.js`) is piracy *by* NPCs:
corsairs raid parked mining claims and strip NPC haulers running out of a den
system — the threat model, taught from the receiving end, where nobody can be
griefed at all. Step 4 (`js/piracy.js`) is the player-side half below —
§4.1's click-a-contact loop, §4.3's three verbs, §4.2's shelf drain and
§4.4's hot-cargo fencing (see the status block up top for what each landed
as). Two decisions from step 3 worth recording, because both were tempting to
get wrong:

- **A raided NPC hauler still arrives, with an empty hold.** Hull kept, cargo
  gone — the same rule that protects a player's miner (§6.6.5), applied to the
  NPCs so the world plays by one law.
- **It is deliberately shelf-neutral.** Robbing a freighter here does *not*
  subtract from `js/stock.js`. Suppressing NPC supply is the den's own job in
  §7.1, and doing it in two places for one den is exactly the `npcOutputMult`
  desync §3.7 warns about. The visible raids are the telegraph; the drain
  arrives with the den.

### 4.1 The loop

`Traffic.flights(now)` already draws named haulers carrying the same ≤3-commodity
basket `Stations.npcProduceHour` is about to deliver. Click one → intercept →
`Combat` resolves → the manifest is yours.

### 4.2 Why it matters — the part that only works here

The stolen cargo **never reaches the destination shelf**. Scarcity rises, prices
rise, and the pirate sells the stolen goods into the spike they personally
created. That is a genuine strategic loop and it exists solely because
`STOCKCFG`'s finite stock shipped first.

### 4.3 Three verbs at the same contact

| Verb | Loot | Crime | Notes |
|---|---|---|---|
| **Rob** | Full manifest | Full | The base case |
| **Toll** | A cut | Reduced | `js/incidents.js`'s `pirate_toll` with the roles reversed |
| **Escort** | Payment + rep | None | Shepherd a relief convoy in during a surge. Gives idle warships work |

Escort matters more than it looks: it means the anti-piracy side of the game is
*played*, not just suffered.

### 4.4 Fencing

Stolen goods are flagged contraband, so the existing `CUSTOMS` seizure gate
becomes the fence-or-risk decision with no new system. The Free Port station
module becomes a real fence — a reason to own one, and a reason for someone else
to want yours shut down.

---

## 5. The law

Police are not entities that stop you. They are a **consequence engine** with
three mechanisms that are usually wrongly conflated.

### 5.1 Three mechanisms

| | Where | What it is |
|---|---|---|
| **Prevention** | Green — capitals, Core Worlds | The verb is not offered; the RPC refuses. Not a fight you can lose. Cheap and perfectly reliable |
| **Response** | Yellow — most sector interiors | You *succeed*, then the bill arrives. Pickets appear on the gates you must leave through. The crime lands; **the escape is the game** |
| **Persistence** | Everywhere | `js/crime.js` — already built, already server-owned, cooling 1/day. A spree has a tail measured in weeks |

### 5.2 Police are geography, not AI

A "response" is a **seeded flight plan** parked between the player and their exit
for N minutes — the same `Voyages.plan()` machinery that already draws traffic. No
pathfinding, no behaviour trees, no entities, no tick loop. Strength and duration
are numbers derived from crime band + security band + what was just hit.

This is the single cheapest idea in the document and it should not be traded away
for "real" police AI later.

### 5.3 Bands are derived

Sector base + station modules (a Customs House raises the band, a Free Port lowers
it) + Senate edicts + whether `js/wars.js` has a war running. Every input exists.

The consequence is the good part: **players change the security map by playing.**
Fitting a Customs House genuinely makes a lane safer for everyone, competitors
included — a public good that is also individually profitable.

**Built (`js/security.js`).** `Security.score(sysId)` is that sum, 0–1, clamped;
`band()` buckets it into the five the galaxy chart draws. One number was
authored — `SECURITYCFG.sectorBase`, exactly parallel to `MININGCFG.sectorRich`
— and everything on top of it is read from the world. Two decisions worth
recording:

- **Pirate dens are deliberately not an input.** Security is the law's
  *published* presence; a den is a local secret you find by flying out to it
  (§7.1 keeps it hidden until found), and folding it in here would paint every
  den on the galaxy chart. Den pressure stays in `RAIDCFG`, discovered.
- **`Raiders` consumes this, it does not duplicate it.** `claimChance` was
  growing its own Senate term; that is now `Security.raidMult()`. One truth for
  "how lawful is here", so a Customs House protects a mining claim and repaints
  the region for the same reason, and neither can drift from the other.

The Sable Sprawl starts *below* the lawless line on purpose (§5.4): its capital
scrapes into Frontier on the capital bonus, the rest is genuinely outside the
law. Every band boundary is reachable by play in both directions — a Free Port
or a Black Market drops a system, a Customs House or a Lane Buoy lifts it.

**Faction allegiance** rides alongside it on the same chart, and is derived the
same way: `Galaxy.factionOf(sys)` tallies the categories its planets actually
work and maps the winner through `CATEGORY_FACTION`. The one stated rule is
§5.4's — Syndic space answers to the Syndicate whatever it digs up — which is
what makes the Sprawl read as Syndicate territory and scatters Syndicate
footholds through everyone else's back yard.

Civil unrest (`Stock.sentiment`) kept its place on the chart as a *separate*
channel — a dashed region edge — rather than a second hue, so an angry but
well-policed sector can never be misread as a lawless one.

### 5.4 Sable Sprawl is not lawless — it has a different law

"Free-for-all" is a bad design space because it has no dials. **Protection racket**
has excellent ones.

- The Syndicate *is* the law in the Sprawl. You are not policed there, you are
  **taxed** — a cut of what you extract or haul through.
- Pay tribute → Syndicate muscle answers when you are hit, and local pirates leave
  your convoys alone.
- Refuse → you are fair game *and* the muscle hunts you. Worse than being policed.
- **Syndicate standing is your safety**, and it already shields you at customs
  (`CUSTOMS.repShield`, up to −30% seizure odds at +100).

Red space therefore converts griefing pressure into a **reputation-and-economy
loop** rather than a combat loop — and it arrives pre-loaded with tension, because
the standing that keeps you alive in the Sprawl is exactly what the Free-Trade
League and the Senate punish you for holding.

### 5.5 Bounty is the player-facing half of the law

`crime` is what the law thinks of you; **bounty** is what other players can collect.
A raider's bounty becomes a contract on the existing board that other players can
take — PvP that is opt-in at *both* ends, and which turns griefers into content.

---

## 6. Raiding player fleets

### 6.1 Publish the contact, not the ship

A dispatched charter publishes a light row: route, departure, ETA, **cargo value
band** (not the exact manifest), **escort strength band**, and the security bands
it crosses. Others see it as a contact if it crosses space they can reach.

Publishing *bands* rather than values gives fog of war for free — a raider can
misjudge, which is what keeps interception a decision rather than arithmetic.

### 6.2 Interception is a commitment, not a click

The raider dispatches their own hulls to an intercept point on the target's plan.
Both plans are functions of `t`, so the intersection is computed once at dispatch —
no simulation. Ships and hours are staked, and the raider can simply be **wrong**:
the target cancels, a hidden escort was inside the band, or a Senate edict turned
the sector green in the meantime.

### 6.3 Resolution is asynchronous and deterministic

At intercept time, `Charters.defenseScore` / `destroyChance` runs attacker fleet
against defender fleet instead of fleet against an abstract band — almost no new
balance work. Both sides get a report; both can replay it in `BattleView`, which
already exists. **Neither party needs to be online.**

### 6.4 The defender's agency is preparation, not reflexes

Because resolution is async, counterplay is escort composition, route band choice,
decoy manifests, insurance, Syndicate tribute, and timing a run for a quiet hour.
That is the correct shape for this game — it is idle-compatible, which matters
more here than twitch counterplay ever could.

**Optional live layer:** a defender who happens to be online at intercept gets one
real decision — jettison and run / fight / pay off. `Voyages.isCheck` /
`applyCheck` / `UI.showVoyCheck` already implement exactly this shape, including
the timeout that falls back to the seeded roll.

### 6.5 What each side walks away with

| Raider | Victim |
|---|---|
| The manifest, flagged contraband (→ `CUSTOMS` fence-or-risk) | Pro-rated payout — `Charters.payoutFrac` already does this by survivors |
| The scarcity spike they engineered on the destination shelf | An insurance claim priced off the lane's band |
| Crime, faction rep loss, a bounty | A bounty contract on the raider they can post |
| | A grudge — `js/rivals.js` taunt lines already exist |

### 6.6 The anti-grief rules — these carry more weight than the mechanics

In rough order of importance:

1. **Only cargo in transit is ever at risk.** Never docked, never station
   holdings, never the save blob.
2. **Consent through action.** You become raidable by flying fat cargo through
   yellow/red, taking the high-pay `DANGER` band, or holding a Letter of Marque. A
   baron running green-band charters through the Core is never a target. Because
   `DANGER[].pay` already scales with band, "safe" is a real strategy with a real
   cost — not a safety switch.
3. **Punching down is unprofitable.** Payout scales with the *gap* between
   attacker and victim: far below your tier pays near-nothing and costs full
   crime; a peer pays full. More robust than level brackets, and needs none.
4. **Diminishing returns per victim.** A second raid on the same baron inside 24h
   pays a fraction; a third pays nothing and still costs crime. Kills farming
   without banning it.
5. **Offline players lose the manifest, never the hull.** Non-negotiable. Losing a
   ship you never saw die, while asleep, is the most reliable way to kill a game
   like this.
6. **Insurance exists**, priced off the lane's band. Turns catastrophe into an
   operating cost and makes safe play a strategy rather than a concession.
7. **Post-hit grace** — a visible window ("under Senate escort for 6h") after
   being raided.

### 6.7 The expected-value trap

**Raiding must not beat hauling on expected value**, or nobody hauls and the raid
economy starves itself of targets. Raiding should be **high variance, not high
EV** — the real payoff is the price spike the raider engineers, not the loot.

---

## 7. Persistent threats — the den, and the boss

### 7.1 The pirate den

A POI-anchored site with a lifetime measured in days. It is the strongest of the
persistent-threat ideas because it is the only one that plugs into `js/stock.js`,
the system that makes everything else consequential.

- **Hidden until found** — a survey hit, an interrogated pirate, or a feed omen
  (with the con-NPC's scam version as a natural false positive).
- **How it drains:** *do not invent a new drain.* The den **suppresses the
  sector's NPC freighters** — fewer `Traffic` runs arrive, `npcOutputMult` relief
  surges, prices climb. The drain is then **visible in space** instead of being a
  hidden subtraction, and it cannot desync from the shelf because it *is* the
  shelf's own supply mechanism.
- **It escalates if ignored:** camp → outpost → fortress across epochs. More
  suppression, a harder fight, better loot.
- **Clearing it** is a multi-wave assault through `Combat` / `BattleView`, and
  should be **contribution-based** (one row tallying damage) so several barons can
  chip at it asynchronously. Cleared, it respawns elsewhere in the sector next
  epoch: recurring content, no storage growth.
- **Payout:** the den's cached cargo dumps onto the sector shelf — a real price
  crash to trade — plus faction rep, a blackbox/blueprint outside the 24h restock
  gate, and safer lanes for the epoch.

> **Bounded, always.** Any suppression must be capped and must never touch
> player-held station holdings — only NPC supply. See the `npcOutputMult` note in
> §3.7; the same stabiliser is at stake.

### 7.2 The boss is the den's final form

Rather than a second mechanic with a second drain, an ignored den escalates into
a system boss. One drain, three tiers of content, and "we let it fester" becomes a
story instead of a separate system.

Flavours, all of which hook something that already exists:

- **Reawakened dreadnought** in the deep-space ring, taxing every voyage through
  the system.
- **Swarm bloom** that spreads to adjacent systems on the star map if unbeaten — a
  failure state that is interesting rather than merely punishing.
- **A war's flagship** — killing it decides `js/wars.js`'s victor, which is the
  exact hook that file's ponytail note asks for.
- **A Senate blockade fleet** — the Senate is already shared and server-side, so a
  bill can spawn world content.

### 7.3 The rule that keeps it idle-first

**Contribution-based, offline-resolving, never attendance-gated.** Telegraph via
the existing klaxon and ticker → a 12–24h window → contribute by dispatching ships
→ a broadcast resolution with a contributor board. A boss that requires being
present at a specific hour breaks the premise of the game.

---

## 8. Ambient interactables (cheap texture, real teeth)

Small, mostly independent, each shippable in isolation:

- **Hail a passing trader** — buy cargo off them between stations, better than the
  shelf, with a scam risk the con-NPC already supports.
- **Wreck salvage** — every fight leaves a hulk for an epoch. Free loot for the
  next player through, and it makes combat leave marks on the world.
- **Repair tender** parked in-system: repair without flying to a capital, at a
  premium.
- **Listening post** — pay or hack for an early omen, feeding the omen/scam
  system that is already the game's differentiator.
- **Buoy tampering** — divert NPC traffic toward your own station's system. Small
  crime, repairable by others.
- **Belt time trial** — pure flagship bragging rights, no economy attached.

---

## 9. Build order

Each step ships alone and is playable without the next one.

| Step | What | Why here |
|---|---|---|
| 1 | **POI layer** in the deep-space ring — ✅ shipped (`js/pois.js`) | Everything needs a destination inside a system |
| 2 | **Mining + the `miner` class** (NPC miners first) — ✅ shipped client-side (`js/mining.js`; signed-in dispatch waits on the mining SQL surface) | Creates the stationary target and the ore leg; belts should look worked before players arrive |
| 3 | **NPC piracy against miners and traffic** — ✅ shipped (`js/raiders.js`) | Teaches the threat model where nobody can grief anybody |
| 4 | **Player piracy on NPC traffic** — ✅ shipped client-side (`js/piracy.js`; signed-in dispatch waits on a piracy SQL surface) | The loot → scarcity → spike loop, still entirely PvE |
| 5 | **Security bands, response, crime with teeth** — bands ✅ shipped (`js/security.js`, §5.3); response ✅ shipped (`js/police.js`, §5.2 built form); §5.5 bounties still design | The rules now have something to govern |
| 6 | **The den, then the boss** | Persistent threat on top of proven site tech |
| 7 | **Player-vs-player raiding** | Last: the only part that *requires* server RPCs and the only part that can make people quit |

The ordering has one deliberate property: by the time PvP raiding lands, every
player already knows what a bounty costs, what red space means, and why a miner
needs an escort — **because NPCs taught them.**

---

## 10. What does not change

- No framework, no build step, no bundler, no new dependency.
- `file://` and GitHub Pages both keep working.
- Resolver maths (`DMGCFG`, `successChance`, `destroyChance`, reward rolls) is
  reused, not replaced.
- Client-local stays client-local; server-settled stays server-settled — with the
  single exception in §1.7.
- Every feature resolves correctly for a player who dispatches and closes the tab.

---

## 11. Open questions

1. **Server surface for PvP.** Steps 1–6 need little or no SQL. Step 7 needs a
   real RPC surface (publish contact, commit intercept, settle raid, both ledgers).
   Is that scoped as its own phase, or is PvP raiding cut in favour of NPC piracy
   plus bounty contracts — which delivers most of the fantasy at a fraction of the
   cost and none of the grief risk?
2. **Do guests see contacts at all?** Consistent with the ranked/unranked split,
   probably own + NPC filler only. Same open question `LIVING_GALAXY.md` §10 raises
   for voyage markers.
3. ~~**Does mined tonnage land on the shelf or in `state.positions` first?**~~ —
   settled: **private.** Ore lands in `state.positions` + the system bay, and
   `docs/sql/mining_rpcs.sql` does the same server-side. Mining is an income
   stream and an ore-hauling leg, not a price lever. §3.7's argument for the
   shelf still stands on its merits and the `npcOutputMult` trap it names is the
   reason this is the conservative answer — revisit it as a deliberate change,
   with player tonnage inside the ratio rather than beside it.
4. ~~**Epoch length** for asteroid depletion and site regeneration~~ — settled:
   each churning site gets its own seeded 1–3h lifetime (`POICFG`), staggered so
   a system never reshuffles all at once, and depletion rides the same clock.
   **Den escalation** is still open, and `state.surveyed`'s per-system cooldown is
   still a cruder version of the same idea that should probably be folded in.
5. **Is insurance a station module, a Senate product, or a flat service?** It is
   load-bearing for anti-grief (§6.6.6) but has no obvious owner yet.
6. **Claim jumping in yellow space** — crime, or free? §3.6 says crime in policed
   space, but yellow is where most claims will actually be.
7. **How many new ship classes at once?** §3.8 lists three more that are cheap
   *if* done while class handling is already open, and expensive later.
8. **Does a raid on your claim earn a grudge?** Step 3 resolves raids as
   weather: a seeded band name, no persistence, nothing to hunt. `js/rivals.js`
   taunts and §5.5's bounty board are the obvious hook for turning a repeat
   attacker into a *target*, but that is the bounty half of §5 and wants the
   crime ladder underneath it first.
9. **Should a guarded claim pay less?** Escorting is currently free counterplay
   — an idle warship costs nothing to park. If escort hulls ever earn upkeep,
   guarding becomes a priced decision instead of an obvious one.
