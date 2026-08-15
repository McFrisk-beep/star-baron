# Ships That Actually Fly — scoping the "Unending Galaxy" direction

**Status: SCOPING ONLY. Nothing here is built. No code has been written.**

> **Looking for the roadmap? Jump to [§20 The phase plan](#20-the-phase-plan).**
> §1–§19 are the design reasoning behind it; §21–§23 are effort, risks and where
> to start.

The question this answers: *could Cosmocrat stop being a game of timers and
become a game of ships moving through space — with pirates, police, and other
players visible in the same sky — and what would that cost?*

Short answer: **yes, and much more cheaply than it looks**, because the repo
already contains ~70% of the parts. But only if we refuse to build an entity
simulation. The whole proposal hangs on one idea (§3). If that idea is rejected,
the cost goes up by roughly an order of magnitude and the idle-friendly premise
of the game dies with it.

---

## 1. The reference — what Unending Galaxy is

A 2D sandbox space game by **Anarkis Gaming** (largely one developer). Top-down
sectors linked by jumpgates, a fully-simulated universe where thousands of NPC
ships actually exist as entities: 12 factions trading, warring and expanding in
real time, ~115 ship types, ~50 station types, hundreds of sectors. Military
production is tied to each faction's economy — a faction that loses its ore
sectors stops fielding fleets. You can play it as a **single pilot** (missions,
trading, smuggling, bounty hunting, piracy) or as a **faction** (fleets,
colonies, diplomacy, treaties, backstabbing). Pirates raid trade lanes; police
and a bounty system push back.

### What's worth stealing

1. **The economy is the AI.** UG's NPCs aren't scripted set-pieces — they're
   traders reading prices, and pirates reading traders. The behaviour looks
   deep because the *world state* is deep. We already have that world state
   (finite per-sector stock, scarcity pricing, station production). We just
   never let anything move through it.
2. **Everything the player does, an NPC also does.** Same rules both sides.
   That's what makes piracy feel legitimate rather than bolted on.
3. **Two zoom levels.** A galaxy map you command from, and a system view you
   watch. We already have exactly these two views in `starmap.js`.

### What is NOT worth stealing

- **Thousands of live entities.** UG is a desktop game with a real tick loop and
  a save file. We're a static site with an idle-play premise and a free-tier
  Postgres. Copying the entity model is the single decision that would sink this.
- **Mandatory** twitch piloting. Cosmocrat's stated design target is "alt-tab for
  90 seconds, come back later" (README). A flight model you *have to* sit at is a
  different game. You can still fly — §12 covers how, without making it required.
- **Faction-scale RTS.** UG lets you command an empire's fleets. We have the
  Senate, stations and wars for that fantasy already, and they're asynchronous.

---

## 2. What we already have (the reason this is affordable)

| Piece | Where | State |
|---|---|---|
| 84 systems / 6 sectors, deterministic from one seed | `galaxy.js`, `GALAXY.seed` | ✅ done |
| Per-system 2D coordinates | `sys.pos` (jittered golden-angle disk) | ✅ done |
| **A live canvas system view with moving ships** | `starmap.js` `startScene` / `_stepShip` | ✅ done, but **cosmetic** |
| Ship FSM: `warpIn → travel → dock / land / warpOut`, plus `combat` | `starmap.js:1137` | ✅ done, cosmetic |
| Camera pan/zoom, particles, explosions, speech bubbles, multi-turn radio | `starmap.js` | ✅ done |
| Hyperspace gate at the system edge, warp in/out with flash | `starmap.js` `_drawGate` | ✅ done |
| Persistent ships with `hull` / `armor` / `shields` / `firepower` / `cargo` | `fleet.js`, `Fleet.stats()` | ✅ done |
| Damage model (`Fleet.addDamage`, `DMGCFG` profiles by job type + danger band) | `fleet.js`, `data.js` | ✅ done |
| Risk maths: cargo draws raids, guns/armour/shields cut the odds | `charters.js` `destroyChance` | ✅ done |
| Finite per-sector stock, scarcity → price, hourly NPC production/consumption | `stock.js`, `STOCKCFG` | ✅ done |
| 78 claimable stations: modules, power budget, tariffs, **scrutiny**, sentiment/revolt | `stations.js` (3.6k lines) | ✅ done |
| Customs seizure of contraband at the gate; Customs House / Free Port modules | `stations.js`, `economy.js` | ✅ done |
| Factions, standing, gated jobs, faction wars with market shocks | `reputation.js`, `wars.js` | ✅ done |
| Shared world across players: station directory, Exchange Hall, bays, Senate, baron board | `docs/sql/station_*.sql`, `senateworld.js`, `barons.js` | ✅ done |
| Server-authoritative economy Phases 0–3 (trade / dock / missions / bazaar / pull / prestige) | `docs/SERVER_AUTHORITATIVE_DESIGN.md` | ✅ done |
| **Deterministic-function-of-time pattern**, proven twice (market price, bazaar board) | `market.js`, `phase2_missions_bazaar.sql` | ✅ done |

### What's actually missing

1. **Nothing the player owns has a position.** A ship has `status: "idle" |
   "charter" | "impounded"`. A charter has `startedAt + durationMs`. Travel is
   `departedAt + etaMs`. There are no coordinates anywhere outside the
   decorative canvas scene.
2. **No lane graph.** Systems have `pos`, but no edges. Every system has a
   generic gate that leads nowhere in particular.
3. **No transport for live data.** Every cross-player feature polls
   (`WorldFeed` ~45s, `SenateWorld` ~45s). Supabase Realtime is **not used
   anywhere in the codebase.**
4. **Charters are still client-authoritative.** `charters.js` says so in its own
   header comment: *"Phase 3 has no charter RPCs yet — resolution is client-local
   for everyone."* Any combat or piracy layered on top of that is trivially
   cheatable from the console on day one. This is a pre-existing hole that the
   work below would have to close anyway.

---

## 3. The load-bearing idea: **flight plans, not entities**

> Do not store where a ship *is*. Store where it's *going*, and compute where it
> is.

A flight is a plan: an ordered list of waypoints, a departure timestamp, and a
speed. Position is a pure function:

```
pos(plan, t) → { systemId, x, y, heading, leg, phase }
```

O(1), no accumulated state, no tick required. This is **the same trick the
project already uses twice** — `market_price(commodity, system, t)` and the
seeded bazaar board. It is the house style, not a new pattern.

What falls out of it for free:

- **Works while the tab is closed.** The ship keeps "flying" because flying is
  arithmetic on the clock, not a loop that has to run.
- **Works offline / on catch-up.** `Game.resume()` and `app_pull()` need no new
  concept: they already fast-forward time.
- **Identical on every client.** Two players watching the same lane see the same
  ship in the same place, with no synchronisation traffic at all — the same
  guarantee the shared market already provides.
- **Cheap to store and cheap to serve.** A flight row is ~200 bytes. A sector
  with 40 ships in the air is one small query, not a stream.
- **Cheap to make authoritative.** The server validates *the plan* once at
  dispatch and *the outcome* once at resolution. It never simulates motion.
- **Renders beautifully with code we already wrote.** `_stepShip`'s `travel`
  state is already "steer toward a target point." Feeding it a computed position
  instead of a random errand is a small change to an existing function.

The cost: **you cannot have continuous collision or free-flight dogfighting.**
Encounters must happen at discrete, pre-computable moments (§8). In exchange,
the entire feature stays idle-friendly and stays inside the free tier.

Everything in §4–§11 assumes this model.

---

## 4. Lanes — giving the galaxy a shape

Today `sys.pos` places systems on a disk but nothing connects them. Add a
**deterministic lane graph** built from the same seed (no new persisted state,
same as `Galaxy.build()`):

- Connect each system to its 2–4 nearest neighbours; guarantee the sector is
  connected; add one or two long **trunk lanes** between sector capitals so the
  six capitals form a ring/hub through Navos (Core Worlds is already the
  neutral centre at `pos 0.50, 0.50`).
- Each lane gets a **length** (from `pos` distance — already used for
  survey/charter time scaling) and a **security band** (§9), derived from the
  sector, the endpoint stations' modules, and Senate edicts. All three already
  exist.
- 84 nodes / ~150 edges. This is a small enough graph that route-finding is a
  textbook Dijkstra over an adjacency list, computed once at boot and cached. No
  pathfinding library, no A*, no engine. ~80 lines in a new `js/lanes.js`.

Lanes are what turn "risk band" from a dropdown into geography: a charter
through the Sable Sprawl is dangerous *because of where it goes*, and you can
see it on the map.

---

## 5. Charters become flights (the direct answer to "instead of just a timer")

Today: pick ships → pick a risk band from a dropdown → pick a duration →
`startedAt + durationMs` → a die roll at the end.

After: pick ships → **pick a destination on the map** → the route is a lane path
→ duration is *derived* from path length ÷ fleet speed → risk is *derived* from
the security bands of the lanes you actually cross.

- Your convoy appears on the galaxy map as a moving marker, and inside the
  system view as real ships flying to the gate, warping, and arriving.
- Clicking it shows the manifest, ETA, current lane, and the threat level ahead.
- **You can re-route mid-flight** (for a fuel/time cost) when a war or a raid
  alert lights up a lane in front of you. That single interaction is the whole
  difference between watching a progress bar and playing a logistics game.
- The existing risk maths survives almost untouched: `cargoRiskFactor`,
  `defenseFactor`, `durationRiskMult` and the Senate escort-mandate multiplier
  all still apply — they just get fed per-lane instead of per-band.
- `CHARTER_BANDS` doesn't disappear; it becomes the *description of a lane*
  rather than a choice in a form. `DANGER` pay multipliers still drive payout.

This slice alone answers "make it not a timer," and it's shippable with zero
combat, zero piracy, zero multiplayer.

---

## 6. NPC traffic — free, because it's seeded

Do **not** store NPC ships. Generate them the way the bazaar board is generated:
a pure function of `(lane, floor(t / period), seed)`.

```
npcFlights(laneId, t) → [ { plan, faction, manifest, escort, value } … ]
```

Every client computes the same NPC convoys on the same lanes at the same times,
with no rows, no cron, no writes. They render, they're clickable, they can be
*interacted with* — and the only thing the server ever has to store is the
outcome when a player actually touches one.

Make the generator read the world state we already have, and the traffic becomes
meaningful rather than decorative:

- **Route choice** = from a sector with surplus stock to a sector where
  `Stock.scarcity()` is high. `stock.js` already computes exactly this number.
- **Volume** = the hourly NPC production/consumption already in `STOCKCFG`.
  Lanes into a starving sector get visibly busier.
- **Cargo** = the commodity that sector is short of.
- **Escort strength** = the lane's security band + whether a war is on.

Result: the map *shows you the economy*. A player who learns to read traffic is
reading `Stock` without knowing it. That's the "valuable insight" hook the
project already leans on with omens and local events.

---

## 7. Enemies and AI behaviour

The UG lesson is that you don't need clever AI — you need a small state machine
plus a world worth reacting to. Reuse the `_stepShip` FSM; add a *goal* layer.

| Enemy | Where it comes from | Behaviour | Reuses |
|---|---|---|---|
| **Lane pirate** | Seeded, spawns on low-security lanes weighted by cargo value flowing through | Loiter near a lane midpoint → interdict the richest passing manifest → flee to a hideout on damage | `_stepShip` combat state, `CHARTERCFG` risk maths |
| **Pirate clan** | Persistent, holds one of the 78 stations | Sustains local pirate spawns until the station is taken; raises its sector's insurance costs | `stations.js` ownership, sentiment |
| **Raider fleet** | Spawned by an active faction war | Blockades a trunk lane in the loser's territory for the war's duration | `wars.js` (already has start/end + market shock) |
| **Customs cutter / police** | Security band ≥ yellow | Scans passing ships; seizes contraband; pursues anyone with a bounty | Existing customs seizure + station `scrutiny` |
| **Bounty hunter** | Spawns against a player carrying a bounty | Hunts the *player's* flights specifically | Bounty ledger (new, small) |
| **Derelict / hazard** | Existing survey hazard, promoted to the map | Static, damages on contact | `expeditions.js` hazard outcome |
| **Rival baron escort** | AI barons in `rivals.js` | Flavour-only convoys that contest the same lanes | `rivals.js` |

Three behaviour verbs cover all of them — `patrol(lane)`, `intercept(target)`,
`flee(home)` — each a few lines on top of the existing steering. **No pathfinding
work**: the graph is 84 nodes and the plan already contains the route.

The bit that makes it feel alive is not the AI, it's the **feedback**: a pirate
clan that goes unchecked visibly starves its sector (stock drops → prices spike →
sentiment falls → revolt risk rises), and all of that machinery is already built.

---

## 8. Piracy — the most interesting mechanic here, and the cheapest

Piracy in this model is an **event at a waypoint**, not a dogfight.

When two plans intersect in space-time (computable in advance — both are
functions of `t`), or when a player commits their own flight to an intercept, an
**encounter** resolves at that moment:

```
outcome = roll(attacker firepower/hull/armor/shields
             vs defender's same, per existing defenseScore)
        → { boarded | driven off | attacker destroyed | defender destroyed }
```

That's `charters.js`'s existing `destroyChance` / `defenseFactor` maths pointed
at two fleets instead of one fleet and an abstract band. Almost no new balance
work.

**Why piracy is worth building here specifically:** because the economy is
finite, stealing a shipment is not just a credit transfer — it *removes stock
from the destination sector*. Scarcity rises, prices rise, and the pirate can
sell the stolen cargo into the spike they just created. That's a genuine
strategic loop, and it exists only because `STOCKCFG` was already built.

Consequences, all reusing existing systems:

- Stolen goods are **flagged contraband** → the existing Customs seizure at the
  gate becomes the fence-or-risk decision.
- Piracy in a policed system creates a **bounty** and tanks standing with the
  lane's controlling faction (`CATEGORY_FACTION` already maps this).
- The **Free Port** station module (already built) becomes the fence — a real
  reason to own one, and a reason for other players to shut yours down.
- Repeated piracy on a sector drops its **sentiment** — the revolt system that
  currently only responds to owner neglect now has a second driver.

---

## 9. AI police and keeping PvP from ruining the game

Do **not** ship a global PvP flag. Ship **security bands per system**, enforced
server-side.

| Band | Where | Hostile action against a player |
|---|---|---|
| 🟢 **Green** | Core Worlds, all six capitals | Blocked outright. The RPC refuses. Police respond instantly, flavour only. |
| 🟡 **Yellow** | Most sector interiors | Allowed, but: immediate bounty, standing loss, station lockout in that sector, police interception on the way out |
| 🔴 **Red** | Sable Sprawl fringe, war zones, pirate-clan systems | Free fire. This is where the money is. |

Bands are **derived**, not authored: sector + station modules (a Customs House
raises it, a Free Port lowers it) + Senate edicts + whether a war is running.
Every one of those inputs already exists. Which means players *change* the
security map by playing — claiming a station and fitting a Customs House
genuinely makes a lane safer, for everyone.

**The rules that keep this from being miserable** — these matter more than the
mechanics:

1. **Only cargo in transit is ever at risk.** Never docked assets, never station
   holdings, never anything in the save blob. The blast radius of losing is one
   manifest.
2. **Hulls are only destroyed if both players are online.** Offline players lose
   the manifest and the ship comes home damaged. Losing a ship you never saw die,
   while asleep, is the single most reliable way to kill a game like this.
3. **Opt-in escalation.** A "Letter of Marque" (a Senate bill — the system is
   already there and already shared) makes you both a valid target and eligible
   for the good prizes. Players who never take one are only ever exposed to NPC
   piracy, which is deterministic and insurable.
4. **Insurance exists** and is priced off the lane's security band. It turns a
   catastrophe into an operating cost and gives the safe-play route a real
   strategy.
5. **Enforcement is server-side or it is nothing.** Every hostile action goes
   through an RPC that checks the band, the consent flag, and both parties'
   state. A client-side check is decoration.

---

## 10. Seeing other players in real time

Three tiers. **The cheap one is most of the value.**

### Tier 0 — no realtime at all (recommended first)
Because position is `pos(plan, t)`, you don't need to stream positions. Publish
flight *plans* to a table; each client polls the plans relevant to its current
sector every ~15–20s and evaluates them locally every frame.

Players see each other's ships **moving smoothly, in the correct place, at 60fps**,
with ~20s freshness on *intent*. Traffic is a few hundred bytes per poll. This
reuses the exact polling shape `WorldFeed` and `SenateWorld` already use, and it
is the single highest value-per-byte item in this document.

### Tier 1 — Supabase Realtime on the flights table
Subscribe to `postgres_changes` on flights filtered by sector. A new departure,
a re-route, or an interception appears instantly instead of within 20s. Still
zero per-frame traffic. Small, additive change to Tier 0. **This is the ceiling
I'd recommend.**

### Tier 2 — actual free-flight piloting with other players in the room
Realtime Presence/Broadcast channel per system, players steering ships directly.
This needs a tick authority, interpolation, lag compensation, and an answer to
"what happens when someone closes the tab mid-fight." It is a different genre, a
different budget, and it breaks the idle premise. **Not recommended.** If it's
ever wanted, it should be a separate mode, not the main game.

---

## 11. What the player actually does

The honest risk in this whole direction is building a game that requires you to
*sit there*. Keep every verb below meaningful whether you watch it or not:

**Async (works while you're away — the default):**
- Plan a route; choose safe-and-slow vs short-and-red
- Assign escorts to a convoy; buy insurance
- Set standing intercept orders on a lane ("raid anything over 50k through
  Sable-4") — piracy as a policy, not an action
- Claim/fit a station to change a lane's security band
- Post bounties; take bounty contracts

**Sync (rewarded for watching, never required):**
- Re-route a convoy around a raid alert in real time
- Personally join an intercept for a meaningful bonus
- Watch and read traffic to spot a scarcity spike before it prices in

That split is the design constraint. If a verb only works when you're watching,
it needs an async equivalent, or it doesn't ship.

---

## 12. What "control" actually means — two layers

The flight-plan model governs **persistence and multiplayer sync. It says nothing
about what the player's hands do.** That distinction got lost in §3, so, plainly:

| Layer | Where | Input | Persisted as |
|---|---|---|---|
| **Strategic** | Galaxy map | Orders: route, escort, intercept, re-route | The plan (`pos(plan, t)`) |
| **Tactical** | System view | **Direct control** — steer, fire, disengage | Only the *outcome* |

A tactical engagement is short (15–30s) and local. The client can run it at 60fps
with real steering and real input, because the server never needs the frames —
it needs the result, validated once, the same way it validates a trade today.

**The rule that keeps this honest:** every tactical engagement must have an
**auto-resolve** that produces a comparable outcome. Watching earns a modest edge
(call it 10–20% better odds, plus the option to spend consumables — §15), never a
requirement. The moment flying is *mandatory* to compete, the idle premise is
dead and so is the game's stated audience.

So: **yes, you can fly.** You can't fly everywhere, forever, persistently — and
you never have to.

---

## 13. Player-initiated piracy

Three ways in, escalating commitment. All three use the same encounter resolver.

**1. Standing interdiction order (async policy).** "Raid anything over 50k moving
through Sable-4." Assign hulls, set a threshold, walk away. Resolves like a
charter does today. Piracy as a *business*, playable by someone who never opens
the map.

**2. Committed intercept (the interesting one).** You can see a convoy's plan.
Since both your position and theirs are functions of `t`, **the intercept is an
analytic solution** — solve for where your reachable set touches their path.

The UI for this is the mechanic: show a **reachable cone** along their route —
the stretch you can actually reach before they exit. A faster hull's cone is
visibly longer, so speed stops being a number in a tooltip and becomes *how many
targets exist for you*. Escorted convoys, tighter lanes and short legs shrink it.
That is a real decision made of numbers we already have.

**3. Fly it yourself.** Join the engagement you set up (§12 tactical layer).

### The verbs at the encounter — and the anti-grief lever

| Action | Payoff | Cost |
|---|---|---|
| **Hail / demand tribute** | They pay to pass, no shots fired | Small standing hit; escorted convoys refuse |
| **Disable & board** | A slice of the manifest — **the profitable path** | Bounty, standing, contraband flag on the goods |
| **Destroy** | Wreck salvage only — scraps | Maximum bounty, maximum standing loss |

Making destruction **economically the worst option** is the cheapest anti-grief
design in this document. It costs nothing to implement and it removes most of the
incentive to kill for the sake of killing.

Piracy also has to be a *build*, not a whim: a bounty follows you, the lane's
controlling faction turns on you, policed stations lock you out, and you need a
**Free Port** to fence flagged goods — all of which already exist.

---

## 14. The flagship — can it fly, can it get ganked

**It can fly. It can be attacked. It can never be destroyed.** That last one is a
hard rule, not a tuning knob.

The flagship is the player's character: it sets travel speed, buffs the whole
fleet, and carries the hold. Losing it to something you didn't watch happen is
not a setback, it's a reason to stop playing.

**Failure state is `crippled`, not destroyed:** engines down, cargo looted or
jettisoned, limps home, repair bill. Both halves of that already exist —
`impounded` status and the `dmg` model with `DMGCFG.statPenalty` (which already
makes a battered hull fly and fight worse, and caps at `maxDmg: 0.95` precisely
so that "only a destroy roll removes a ship").

**Exposure is opt-in by geography.** The flagship is only a valid target in a red
band, and only when *you* took it there. It is never exposed by an auto-charter.

### The anti-gank rules (these matter more than the combat maths)

1. **Dock immunity + arrival grace** — untouchable while docked and for ~60s
   after warp-in. No spawn camping.
2. **No hostile action in green/yellow without a mutual Letter of Marque.**
   Consent is geographic *and* explicit.
3. **Bully scaling** — rewards fall off hard as the attacker outclasses the
   defender. Farming weaker players pays approximately nothing.
4. **Repeat-target cooldown** — the same attacker can't hit the same victim again
   for N hours. Pound for pound the single most effective anti-grief rule that
   exists; it converts "being hunted" into "being unlucky once."
5. **Offline players never lose a hull** (§9), and insurance covers the manifest.

Net: **you can lose a run. You cannot lose your account.** Every one of these is
a cheap server-side check inside the encounter RPC.

---

## 15. Making fights actually visual

### What's wrong today

`_stepShip`'s combat state: two ships orbit a fixed midpoint at a constant radius,
emit random sparks, a 3–6s timer runs down, a **coin flip** picks a loser, one
explodes. It's a light show with no information in it. Nothing reads off a stat,
nothing escalates, and the outcome was decided before it started.

Fix it in two halves. Neither needs an engine.

### Half 1 — give combat a spine (`js/combat.js`, small)

Discrete **rounds of ~1.2–1.5s**, resolved from real stats, *rendered
continuously*. Each round: fire → **shields** absorb → **armor** mitigates →
**hull** takes the remainder.

The free win here: **`shields` / `armor` / `hull` already exist on every ship in
`Fleet.stats()` and nothing currently treats them as layers.** We don't invent a
combat model — we *expose the one already sitting in the data*. Damage output
comes from `firepower`, already reduced by battle damage. `DMGCFG` already has
per-profile damage ranges and danger multipliers.

### Half 2 — render the spine

Every beat is driven by real state, which is what makes it readable instead of
decorative:

| Beat | Visual | Reuses |
|---|---|---|
| Firing | **Tracers with travel time**, class-varied: rapid tracers, heavy slugs, sweeping beams, arcing missiles. Rate and colour from `firepower`. | particle system |
| Shield hit | Hex-ripple bubble flashing at the impact point, dimmer as shields drop | ~30 new lines |
| **Shield break** | White flash, shockwave ring, "SHIELDS DOWN" callout | speech bubbles |
| Armor hit | Orange sparks + debris chips | existing `spark()` |
| Hull damage | Venting smoke trail, scorch overlay, ship **visibly slows** | `DMGCFG.statPenalty` |
| Critical | Fire trail, erratic steering, engine flicker | — |
| Death | Existing explosion + a **persistent salvageable wreck** | existing `explode()` |
| Surrender | Engines cut, ship drifts, cargo pods eject | small |

**Maneuvering — the biggest single upgrade.** Replace circle-strafing with
**joust passes**: approach, fire through the pass, overshoot, break turn,
re-engage. Three steering behaviours (pursue / lead-pursuit / evade), ~40 lines,
and it instantly reads as a dogfight instead of a carousel.

**Feel.** Camera eases toward the engagement and zooms slightly; 2–3 frame
hit-stop on a shield break or a kill; screen shake scaled to damage; chromatic
flash on criticals. All gated behind `prefers-reduced-motion`, which the project
already respects.

**Readability.** Shield/armor/hull bars for each side pinned to the canvas edge,
floating damage numbers, and — cheapest of all — tie the **existing** `combat`
speech pool to real events instead of random timing. "Shields are gone!" landing
exactly when they are is worth more than any particle effect.

### Interactivity without a flight model

Stretch a fight to 15–30s and let the player spend **blackboxes** during it.
`Boosts` already exists, already tracks `activeBoosts` with expiry, and already
exposes `Boosts.mag(stat)`. Add three combat stats — `combatDamage`,
`combatShield`, `evade` — and the existing consumable economy becomes a tactical
one. **Zero new systems**, and watching a fight becomes a decision rather than a
spectator seat.

### Why this should probably ship first

It needs **none** of the flight work. The decorative dogfights already firing in
every system view get the full treatment immediately, and charter resolution can
play out as a real animated fight instead of a die roll — which means the
existing game gets visibly better before a single lane exists.

---

## 16. Space gets bigger — the points-of-interest layer

Today a system view contains: a star, orbiting planets, one station, one gate,
and ambient traffic. It's a screensaver. Making space *bigger* only helps if
bigger space contains **reasons to go somewhere**, so the real deliverable isn't
scale — it's a **POI layer**.

Seeded per system from the existing galaxy seed (no storage, same as everything
else), each system gets 4–12 points of interest scattered across a much larger
logical extent:

| POI | What it's for |
|---|---|
| **Asteroid belt / field** | Cover in a chase; extractor sites; ambush terrain |
| **Derelict hulk** | Survey target; salvage; occasionally occupied |
| **Debris field** | Cover; scrap; the leftovers of an old fight |
| **Gas cloud / nebula pocket** | Sensor shadow — hides ships from scans |
| **Mining rig / refinery** | The visual home for `industries.js`, which currently has none |
| **Jump buoy** | Lane anchor; the Lane Buoy station module gets a body |
| **Pirate camp** | Makeshift station; clickable → "clear the hideout" job |
| **Research relay / listening post** | Mission objective; intel |

The camera already pans and zooms (`_initPanZoom`, pinch support), and
`sys.asteroidBelt` already exists as a flag on mineral-sector systems. So the
work is: widen the world extent, place POIs deterministically, render them with
the existing image/fallback pattern, make them clickable, and add a minimap so a
bigger space stays navigable.

**Why this comes early:** every later feature needs a *destination inside a
system*. A survey flies to a derelict. An assassination happens at a relay. A
smuggler hides in a gas cloud. A pirate camp is a place you attack. Without POIs,
all of that has nowhere to happen and stays abstract.

---

## 17. Instanced sites — seeded site, stored state

The tension in "I want instanced content, but everyone should see it if they're
there" dissolves once you split the two halves:

```
site  = f(systemId, poiId, epoch, seed)     ← generated, never stored, identical for everyone
state = { clearedBy, clearedAt, claimedBy } ← stored, tiny, the only row that exists
```

The broken station at Korrin-7 is the *same* broken station for every player who
flies out to look at it, because they all compute it from the same inputs. Nobody
stored it. What gets stored is one small row saying it was picked clean at 14:02
by someone, after which it renders as a stripped hulk until the epoch rolls.

This is exactly the pattern already proven by the seeded bazaar board
(`app.gen_*` / `app_bazaar_board` in `phase2_missions_bazaar.sql`), so it needs
no new architecture and it is trivially server-validatable: the server recomputes
the site from the same seed and checks the claim is legal.

**Epochs** control freshness — a POI's site regenerates on a cadence (say 6–24h),
which is what makes the galaxy re-explorable without unbounded storage. The
existing `state.surveyed` per-system cooldown already does a cruder version of
this and can be folded in.

**Two kinds of instance, and they behave differently:**

| | **Sites** (POI-anchored) | **Encounters** (mission-anchored) |
|---|---|---|
| Example | Derelict, pirate camp, seam | Your escort's ambush, an assassination target |
| Generated from | System + POI + epoch | The mission's own seed, at a point on a route |
| Who sees it | Everyone who goes there | Everyone in range during its window |
| Stored as | A claim row | A short-lived published contact |
| Can others interfere? | Yes — first come, first served | Phase-gated policy (§20, Phase 7) |

A mission encounter is published like a flight: a location, a time window, a
faction. Another player flying past sees a **contact** on their map — a real
fight happening to someone else, in a place they can reach. That's the "everyone
can see it if they happen to be there" you asked for, and it costs one row.

---

## 18. Missions become journeys

Today a mission is a progress bar with phases (`buildPhases`: outbound → work →
work → return) and a success roll at the end (`successChance`). The phases are
already labelled per mission type — the structure is right, it just has no body.

**Keep the skeleton. Give each phase a place and a beat.** A mission becomes a
flight (§3) with **scheduled encounter beats** along it. Every beat auto-resolves
if you're away, and can be played if you're watching (§12).

### Survey → fly to the derelict, scan it
The dispatch flies to a **POI**, not a system id. On arrival: the scan animation
(expanding sensor ring over the hulk, returns resolving one by one), then the
existing **SurveyStory** mini-story opens as it does today. The beloved
choice-driven thread survives untouched — it finally has a body to happen to.
`EXPEDCFG.weights` already biases which event pool fires; the POI type just
becomes another input (derelict → derelict/ruin pools, belt → seam pools).

### Smuggling → checkpoints
Patrol pickets sit at seeded points along the route. Each is an **inspection
roll** — and the entire customs system already exists (`CUSTOMS`, seizure odds,
`Boosts.mag("customsSeize")`, the Smuggler's Veil blackbox, station scrutiny).
On being pinged: **run** (speed vs their scan), **bribe** (credits + standing),
**dump cargo** (lose the goods, keep the ship), or **fight** (crime, §19). Gas
clouds and belts from §16 are what make "run" a real option — cover is a place.

### Escort → an NPC ship you have to keep alive
You fly alongside a generated NPC hull with its own stats. Ambush beats spawn
attackers en route; the objective is *its* survival, not yours, which makes it
the only mission type where positioning matters more than firepower. Payout
scales with the cargo that arrives — the exact `payoutFrac` pro-rating
`charters.js` already implements.

### Assassination → a target with escorts, at a place
The target is a generated ship + escort screen sitting at a POI, or moving on a
known plan you have to intercept (§13's reachable cone). The fight is Phase 1
combat. Getting *out* afterwards is the second half of the mission — you just
committed a killing, so §19 applies.

### Pirate camp → clear the hideout
A POI-anchored **site**, clickable straight off the map. Multi-wave defenders,
a station to destroy or capture, real loot, and clearing it suppresses that
sector's pirate spawns for an epoch. First player there gets it. This is the
single most legible "there is a thing in space, go kill it" content type in the
whole design, and it falls out of §16 + §17 almost for free.

---

## 19. Crime, bounty, and getting locked out

One rating, two faces:

- **`crime` (0–100)** — what the law thinks of you. Rises with piracy, smuggling
  convictions, and kills in policed space. Decays slowly with time.
- **`bounty` (credits)** — derived from crime; what *other players and NPC
  hunters* can collect off you.

| Band | Crime | What changes |
|---|---|---|
| 🟢 Clean | 0–20 | Nothing |
| 🟡 Watched | 21–45 | Customs scrutiny up, small tariff surcharge |
| 🟠 Wanted | 46–75 | Best contracts hidden, patrols shadow you, some stations refuse docking |
| 🔴 Outlaw | 76–100 | Locked out of policed stations, hunters spawn, capitals closed |

### Docking while locked out — the approach run

This is the good part, and §16 is what makes it possible. Docking at a station
that's refused you becomes a **run**: patrol pickets hold positions between the
gate and the station, each with a detection radius scaled by their scan and your
**signature** (hull size + cargo load — big fat haulers are easy to spot).

- **Async:** one roll — speed vs patrol density vs signature vs crime band,
  modified by blackboxes. `Smuggler's Veil` and `Ghost Manifest` already exist and
  already do exactly this job for customs; they extend to this with no new items.
- **Sync:** you fly it. Belts, debris fields and gas clouds are cover. Vision
  cones, timing, route choice. It is the most "game" thing in this document and it
  costs almost nothing extra because every ingredient is already being built.
- **Caught:** fine, cargo seized (existing customs path), ship impounded
  (existing status), crime goes up. You lose the run, not the account.

### Getting clean again — non-negotiable

A crime stat with no way down is a trap that teaches players to never take risks.
Four exits, all reusing existing systems:

1. **Fines / bribes** — credits, scaled by band. The boring reliable one.
2. **Free Port amnesty** — launder standing at an outlaw station. Gives Free Ports
   a second reason to exist.
3. **Senate pardon** — a bill on the shared agenda. The Senate is already built,
   already shared, already votes. A pardon bill is content, not code.
4. **Serving time** — a cooldown where your ships sit impounded. Free, slow, and
   the flavour writes itself.

---

## 20. The phase plan

Eight phases. Each is independently shippable, each leaves the game better than
it found it, and each has a clean stop point. Sizes are relative to
`STATIONS.md` (the largest change in the project so far). Session counts assume
the established working style — one agent, vanilla JS, no build step, SQL pasted
by hand.

---

### **Phase 1 — Combat gets a spine and a face**
*≈2 sessions · depends on nothing · `js/combat.js`, `starmap.js`, `items.js`, `data.js`*

Layered `shields → armor → hull` rounds (the stats already exist and are unused
as layers), joust passes instead of circle-strafing, tracers with travel time,
shield-break shockwaves, venting hulls that visibly slow, salvageable wrecks,
per-side HUD bars, blackboxes as tactical items via the existing `Boosts.mag`.

**You get:** the dogfights already running in every system view become real
fights. Charter and mission resolution can play out as an animated engagement
instead of a die roll. Nothing else in this document is required.

---

### **Phase 2 — Space gets big**
*≈2–3 sessions · depends on nothing · `js/poi.js`, `starmap.js`, `data.js`*

Widen the system world extent; seed 4–12 POIs per system (belts, derelicts,
debris, gas clouds, rigs, buoys, camps); make them clickable and labelled; add a
minimap. Camera pan/zoom already exists.

**You get:** systems become places instead of screensavers. Industries and
asteroid belts get a visual home. No new gameplay yet — this is the substrate
everything after it stands on.

---

### **Phase 3 — Instanced sites: surveys and hideouts**
*≈2–3 sessions · needs Phase 2 · `js/sites.js`, `expeditions.js`, `survey-story.js`, `sql/app_site.sql`*

Seeded-site / stored-state model (§17) with epochs. Surveys fly to a **POI**,
play a scan animation, then open the existing SurveyStory. Pirate camps become
clickable "clear the hideout" jobs with waves and loot. First player to a site
claims it; everyone sees the same site and its aftermath.

**You get:** the first genuinely *instanced content everyone shares*, the survey
loop gets a body, and the map has things on it worth flying to. Combat from
Phase 1 gets its first real use.

---

### **Phase 4 — Lanes and flight plans**
*≈3–4 sessions · needs nothing, but pairs with 2–3 · `js/lanes.js`, `js/flights.js`, `sql/app_flight.sql`, `charters.js`, `starmap.js`*

The `pos(plan, t)` model. Lane graph over the 84 systems. Charters fly a visible
route with derived ETA and derived risk; mid-flight re-routing. **Lands
`app_flight_*`, which closes the existing client-authoritative charter hole.**

**You get:** the answer to "it's just a timer." Ships physically move. This is
the structural centrepiece — everything after it assumes flights exist.

---

### **Phase 5 — Missions become journeys**
*≈2–3 sessions · needs Phases 1, 2, 4 · `missions.js`, `js/encounters.js`, `sql/app_encounter.sql`*

Missions become flights with scheduled encounter beats (§18): smuggling
checkpoints with inspection rolls, escort ambushes with an NPC you keep alive,
assassination targets with escort screens. Every beat auto-resolves when you're
away and can be played when you're watching. Encounters publish as contacts, so
other players see them happening.

**You get:** every mission type stops being a progress bar. This is where the
game you described actually arrives.

---

### **Phase 6 — A galaxy with other people in it**
*≈2–3 sessions · needs Phase 4 · `flights.js`, `cloud.js`, `stock.js` (read-only), SQL*

Seeded NPC convoys routed by real `Stock` scarcity — traffic that *shows you the
economy*. Publish player flight plans; poll them per sector (Tier 0), then
upgrade to Supabase Realtime on plan changes (Tier 1).

**You get:** the map is populated and other barons are visibly in it. Still zero
hostile interaction, so it's safe to ship without any PvP policy.

---

### **Phase 7 — Piracy, crime and the law**
*≈3–4 sessions · needs Phases 1, 4, 6 · `js/piracy.js`, `js/security.js`, `js/crime.js`, SQL*

Piracy dispatch ("send hulls to raid system X"), committed intercepts with the
reachable cone, boarding and manifest theft with real stock effects. Crime rating
and bounty (§19), derived security bands, patrol response, station lockouts and
the approach run. **All anti-grief rules (§9, §14) ship in this phase, not
after** — C without D is the one ordering mistake that would hurt.

**You get:** the full loop. Piracy is a career, the law is a real opponent, and
other players are in the same sky under rules that keep it fair.

---

### **Phase 8 — Fly it yourself** *(optional)*
*≈2 sessions · needs Phases 1, 2 · `starmap.js`*

Direct control of your flagship in the tactical layer: steer, pick targets,
manage range, use cover, run the approach, join your own intercepts. Always
optional, always with auto-resolve parity (§12).

**You get:** hands-on flying, for the players who want it, without ever
requiring it.

**→ Full mechanics, and the honest answer on what "realtime" can and can't mean
here, in [§24](#24-appendix--how-phase-8-actually-works).**

---

### Totals and stop points

| Through | Sessions | What you have |
|---|---|---|
| Phase 1 | ~2 | Fights that look and read like fights |
| Phase 3 | ~7–8 | Real places with real content in them |
| Phase 4 | ~10–12 | Ships that actually fly |
| Phase 5 | ~13–15 | Every mission type is a journey |
| Phase 7 | ~18–22 | The whole design |

**Phases 1, 3, 4 and 5 are all clean stopping points.** Each leaves a coherent,
better game rather than a half-built system — which matters, because this is
roughly 3–4× the size of `STATIONS.md` and it should be possible to get off at
any floor.

---

## 21. Effort notes

Three things are load-bearing on the estimates in §20:

1. **Phase 4 must land the `app_flight_*` RPCs.** Charters are client-local today
   (their own header comment admits it). Piracy on top of client-authoritative
   charters is exploitable on day one, so the server work isn't optional — but it
   also *closes a hole that's already open*, so it isn't wasted budget either.
2. **Phase 7 must ship its own police.** Piracy without crime, bands and
   anti-grief rules is the one ordering mistake in this plan that would actually
   hurt. They are one phase for a reason.
3. **Nothing here needs an engine, a bundler, or a framework.** Every phase is
   plain functions over the existing globals, canvas render work in a file that
   already has a render loop, and SQL in the style of the seven `phase*` files
   already in `docs/sql/`. `CLAUDE.md`'s premise survives intact.

**What got cheaper by adding scope.** POIs (Phase 2) look like an extra, but they
make Phases 3, 5 and 7 *smaller*: instanced sites need somewhere to be, smuggler
cover needs to be a place, and the approach run needs terrain. Building them
early converts three vague features into three concrete ones.

**What genuinely got more expensive.** The original scope was ~9–12 sessions;
this is ~18–22. The additions are POIs, instanced sites, per-mission-type
encounters and the crime system. That's real growth, not estimate drift — it is
roughly 3–4× `STATIONS.md`, and it should be treated as a multi-month direction
rather than a feature.

---

## 22. Risks and open questions

- **Idle premise vs. spectacle.** The flight-plan model protects it. Any drift
  toward Tier 2 realtime, or toward Phase 8 becoming *mandatory*, breaks it.
  Guard this — every sync verb needs an async equivalent, every time.
- **Balance surface explodes.** We already have an unplaytested Industries
  balance pass outstanding (`HANDOFF.md` §9). This adds lanes, traffic volume,
  intercept odds, bounties, crime decay and insurance on top. Budget a tuning
  pass per phase, and keep every new number in `data.js` like everything else.
- **Crime must have exits.** A one-way crime stat teaches players never to take
  risks, which kills the exact loop Phase 7 exists to create. The four exits in
  §19 ship *with* crime, not later.
- **POI density is a trap in both directions.** Too sparse and bigger space is
  just emptier space; too dense and it's noise. Expect to tune count-per-system
  after the first playtest — keep it a single `POICFG` knob.
- **`starmap.js` is 1,410 lines and would grow.** The scene renderer is the one
  place a split might genuinely be warranted (scene vs. galaxy vs. flights).
  Worth watching, not worth pre-empting.
- **Save size.** Flights in the save blob are fine (bounded by `maxActive`), but
  it's another argument for `station_inv`-style server tables that `HAULING.md`
  §7 already flagged as the upgrade path.
- **PvP is a community problem, not a code problem.** The rules in §9 are the
  cheap insurance. Ship them *with* piracy, never after.
- **Open:** should NPC traffic be interceptable by *guests*, or is the whole
  layer signed-in-only? Signed-in-only is simpler and consistent with the
  existing ranked/unranked split, but it makes the map emptier for new players.
  Leaning: guests see traffic and fly charters, but can't interdict.

---

## 23. Recommendation

**Start with Phase 1, then Phase 2.** Roughly 4–5 sessions for both. Combat gets
a spine and a face, and space gets big enough to hold things. Neither depends on
anything, both are visible immediately, and together they're the foundation
every other phase stands on — Phase 3 needs places, Phase 5 needs fights, Phase 7
needs terrain.

**Phase 3 next**, because it's the first phase that produces *content* (instanced
sites everyone shares) and it proves the seeded-site model end to end on
something small before Phase 5 depends on it.

**Then Phase 4**, the structural centrepiece, and reassess. By that point ships
fly, fights are real, space has places in it, and you'll be deciding about
missions-as-journeys and piracy from inside the game rather than from a document.

**Do not start with Phase 7.** It's the most exciting one on paper and the one
most likely to go wrong first: it needs flights, combat, terrain and other
players to already exist, and it carries all the social risk in the design.

---

## 24. Appendix — how Phase 8 actually works

§10 says free-flight multiplayer isn't recommended. §20 then offers a phase
called "fly it yourself." Those aren't in conflict, but only because
**"realtime" is four different questions**, and they have four different answers.

| Question | Answer | Why |
|---|---|---|
| Can **I** fly my ship in realtime, 60fps, direct control? | **Yes, fully** | It's a local canvas game. No network involved at all. |
| Can I fight **NPCs, patrols and sites** that way? | **Yes, fully** | They're seeded/simulated. Nothing to synchronise. |
| Can I **see other players' ships** moving while I fly? | **Yes, genuinely** | `pos(plan, t)` — their positions are actually correct, not interpolated guesses. |
| Can I **trade individual shots with another human** in realtime? | **No** | This is the Tier 2 problem: tick authority, lag compensation, who-shot-first, disconnect abuse. Different genre, different budget. |

So Phase 8 is **realtime play, not realtime PvP.** You fly; everything you fly
*against* is simulated; other players are visibly present but not twitch-fightable.

### The key move: flying is the approach, the encounter is the resolution

When you're flying and you find another baron's convoy, you don't exchange
individual hits with them. You close, you commit, and the **engagement resolves
through the same encounter RPC that an async interception uses** (§13). Both
sides get an outcome they can trust, and neither needed to be online at the same
millisecond.

This isn't a compromise bolted on — it's the shape the whole design already has.
A flight is a plan, and encounters happen at points along it. Phase 8 simply lets
you **hand-fly the approach** instead of letting the auto-router do it.

### Why Phase 1 is what makes this cheap

Phase 1's combat is **round-based** — 1.2–1.5s rounds resolved from
`shields`/`armor`/`hull`/`firepower`. That single decision is what makes Phase 8
affordable, and it's worth being explicit about why:

Because rounds are resolved from stats, **flying doesn't supply aim — it supplies
modifiers.** Positioning, range band, cover, target focus and ability timing feed
into the same roll the auto-resolver performs. So the flown fight and the
auto-resolved fight compute *through the same function*, which is exactly the
§12 parity requirement.

Had combat been projectile-accuracy based, parity would be impossible: there'd be
no honest way to auto-resolve "how well would this player have aimed," and Phase 8
would fork into a second combat system. It doesn't.

### What the player actually does

No aiming. Auto-fire at a selected target; the player controls *everything else*:

- **Target selection** — focus the escort or the hauler first?
- **Range management** — sit in your weapons' optimal band, kite a brawler, close on a sniper
- **Cover** — break sensor locks behind asteroid belts, debris and gas clouds (Phase 2)
- **Ability timing** — spend blackboxes at the right moment (`Boosts`, already built)
- **Disengage** — run for the gate before it turns bad

That's a real tactical layer with zero twitch requirement, which matters because
this game is responsive down to phone width and has a history of mobile fixes.
**Recommended input: click-to-move plus ability buttons**, with keyboard thrust as
an alternative — both feed the same steering the scene renderer already has
(`moveTo` in `_stepShip`). Mouse-aim twitch controls would be a much bigger
commitment and would break the parity above.

### The two problems everyone hits, and the answers

**"What if I close the tab mid-fight?"** The encounter falls back to auto-resolve
from its current state. No rage-quit escape hatch, no punishment for a dropped
connection, no special-casing. It's the same function either way.

**"The client runs the fight — can't it cheat?"** Yes, if unbounded. So bound it:
the server recomputes what auto-resolve *could plausibly have produced* and
rejects anything outside that envelope. Since flying is worth at most the stated
edge (10–20%), a modified client can claim at most 10–20% — not worth building.
And **PvP outcomes never come from a flown client at all**: those always go
through the encounter RPC, where both sides' stats are server-side.

### What this means for scope

The ≈2 session estimate holds **only** for the model above — click-to-move,
auto-fire, round-based resolution, reusing Phase 1 and Phase 2 wholesale. If the
goal is genuine twitch flight — manual aim, projectile leading, per-shot
collision — that is a different feature: it forks combat into two systems, breaks
auto-resolve parity, and pulls Tier 2 realtime back onto the table for anything
involving other players. Worth wanting, but it should be scoped as its own
project rather than as a phase of this one.

---

Sources for the Unending Galaxy reference:
[Anarkis Gaming](https://www.anarkisgaming.com/unending-galaxy-info/) ·
[feature list](https://wiki.anarkisgaming.com/ug/feature_list) ·
[Steam](https://store.steampowered.com/app/439720/Unending_Galaxy/)
