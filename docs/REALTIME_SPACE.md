# Ships That Actually Fly — scoping the "Unending Galaxy" direction

**Status: SCOPING ONLY. Nothing here is built. No code has been written.**

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

## 16. Effort

Slices are ordered so each one is independently shippable and each one leaves
the game better than it found it. Sizes are relative to known landmarks in this
repo: **STATIONS.md was the largest change in the project's history — call that
XL.** Session estimates assume the established working style (one agent, vanilla
JS, no build step, SQL pasted by hand).

| # | Slice | What ships | New files | Touches | Size | ~Sessions |
|---|---|---|---|---|---|---|
| **A** | **Lanes + flight plans** | Charters fly a visible route on the map; ETA and risk derive from geography; re-routing | `lanes.js`, `flights.js`, `sql/app_flight.sql` | `charters.js`, `starmap.js`, `data.js`, `ui.js`, `main.js` | **L** | 3–4 |
| **B** | **NPC traffic** | Seeded convoys on every lane, driven by real scarcity; the map shows the economy | — (in `flights.js`) | `stock.js` (read-only), `starmap.js` | **S** | 1 |
| **C** | **Encounters & piracy** | Intercept, board, steal a manifest; stolen goods are contraband; stock effects | `encounters.js`, `sql/app_encounter.sql` | `charters.js`, `stock.js`, `fleet.js`, `ui.js` | **M–L** | 2–3 |
| **D** | **Security bands, police, bounties** | Derived security map; police response; bounty ledger; PvP consent rules | `security.js` | `stations.js`, `senate.js`, `reputation.js`, SQL from C | **M** | 2 |
| **E** | **Other players visible** | Tier 0 polling → Tier 1 realtime; other barons' convoys on your map | — | `flights.js`, `cloud.js`, `sql` | **S–M** | 1–2 |
| **F** | *(optional)* **Flyable system view** | Steer your own flagship in the system scene; manual intercepts | — | `starmap.js` | **M** | 2 |
| **G** | **Combat with a spine + visuals** (§15) | Layered shield/armor/hull rounds, joust passes, tracers, wrecks, blackboxes as tactical items | `combat.js` | `starmap.js`, `charters.js`, `items.js`, `data.js` | **M** | 2 |

**G depends on nothing.** It can ship before, after, or entirely without A–F —
it upgrades the dogfights already running in the system view today.

**Total for A–E: roughly 9–12 sessions.** That is comparable to STATIONS.md,
and it is *the same order of magnitude as the work already in this repo* — not a
rewrite.

Two things are load-bearing on the estimate:

1. **Slice A must land the `app_flight_*` RPCs.** Charters are client-local
   today (their own header admits it). Piracy on top of client-authoritative
   charters is exploitable on day one, so the server work isn't optional — but
   it also *closes an existing hole*, so it's not wasted budget either.
2. **No slice requires an engine, a bundler, or a framework.** Everything above
   is plain functions over the existing globals, one new canvas render path in a
   file that already has one, and SQL in the style of the seven `phase*` files
   we've already got. `CLAUDE.md`'s premise survives intact.

### What I'd cut if the budget is half this

**A + B alone (≈4–5 sessions)** delivers the headline: chartered ships physically
move through a real galaxy, past real NPC traffic that reflects the real
economy, and you can re-route them. No combat, no piracy, no multiplayer. It is
by far the best value in the document and it makes everything after it optional.

Add **C** for piracy, **D** to make piracy safe to ship, **E** for other players
— strictly in that order. C without D is a design hazard: piracy with no police
and no consent rules will produce exactly one round of complaints.

---

## 17. Risks and open questions

- **Idle premise vs. spectacle.** The flight-plan model protects it. Any drift
  toward Tier 2 realtime or Slice F-as-mandatory breaks it. Guard this.
- **Balance surface explodes.** We already have an unplaytested Industries
  balance pass outstanding (`HANDOFF.md` §9). This adds lanes, traffic volume,
  intercept odds, bounties and insurance on top. Budget a tuning pass, and keep
  every new number in `data.js` like everything else.
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

## 18. Recommendation

**Build G first** (≈2 sessions). Combat gets a real spine and real visuals, it
depends on nothing, and it makes the game visibly better *this week* — the
dogfights are already happening, they're just empty. It also de-risks everything
after it: if piracy ever ships, the fight at the end of it already exists.

**Then A and B** (≈4–5 sessions). Lanes, flight plans, seeded NPC traffic. This
is the answer to "it's just a timer," and it makes the star map load-bearing
instead of decorative.

**Then decide about piracy** — with flying and fighting already in your hands
rather than on paper. If the answer is yes, C and D ship together, never C alone.

Sources for the Unending Galaxy reference:
[Anarkis Gaming](https://www.anarkisgaming.com/unending-galaxy-info/) ·
[feature list](https://wiki.anarkisgaming.com/ug/feature_list) ·
[Steam](https://store.steampowered.com/app/439720/Unending_Galaxy/)
