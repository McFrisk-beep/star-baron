# Living Galaxy — lanes, visible voyages, watchable battles

**Status: Steps 1–4 of §8 are built.** Step 1: lane graph (`js/lanes.js`),
galaxy-view lane render, per-bearing gates, lane-routed travel ETAs. Step 2:
combat view (`js/combat.js`, `js/battleview.js`), `ENEMY_CATALOG`, report
rosters + replays. Step 3: voyages (`js/voyage.js`) — `pos(plan, t)` over the
lane graph, moving markers on the galaxy chart, flagship/convoy vignettes in
the system view (a slice of §6.2 shipped early), the Hub's **Live View**
(the REAL system scene — `StarMap.startScene` rendering onto the Hub canvas
with a chase cam gliding after the followed ship: flagship, mission,
charter, courier or survey — plus a hyperspace-tunnel stage mid-lane, a
chart inset, and follow chips for **every** voyage — your flagship,
missions, charters, couriers, surveys, and other barons' flagships in
transit (yours sort first). Each row that owns a voyage also carries a
**▶ Follow live** button: mission cards, survey and courier lines on the
Hub, and charter cards on Fleet (which jumps to the Hub). Chips are built
with `textContent`, never innerHTML — another baron's display name is
untrusted text. Each hyperspace hop also adds a ~5s gate
dwell to client-computed flagship ETAs so routes read as journeys),
dispatch-seeded
event schedules with comms entries and watchable skirmishes, and
cross-player flagship presence (`docs/sql/voyage_presence.sql`, optional).
Every lane leg is choreographed (`Voyages.legPhase`): cruise out, brake into
the gate, hyperdrive spool + jump flash, hyperspace, drop-out, approach —
total leg time unchanged, only where the ship is drawn moves. In the scene
the cruise legs and the gate hold share one **hold point** (26px inside the
gate) so a ship never teleports between stages. Stations are **fixed in
space** — parked at a seeded per-system berth angle, out at orbit 0.36 so
departures aren't lost in the star's glare — and transits run station ↔ gate
because the station is the system's port. The ship the Live View follows
wears a tracking reticle and draws larger, so it stays findable among
ambient traffic. Docked ships are berthed inside the station and not drawn.
Committing to a transfer (Star Systems list or star map) goes through a
**launch-clearance** confirm — a seeded bridge line, the route and rough
time — and on "go" hands the player to the Hub to watch the run. Arrival countdowns are gone
from the travel/mission UI — the ship itself is the timer (mechanics are
untouched: arrival still lands at `departedAt + etaMs`); only on-site work
shows a clock. **§4.4 is in for every path**: client-local voyages
draw outcomes from a stream seeded by the voyage uid at dispatch
(`Missions._mkOutcomeRng` / `Charters._mkOutcomeRng` — resolve applies, it
doesn't roll), and server-settled voyages are now mirrored bit for bit — no
SQL change was needed, because `app_mission_launch` already stamps `rngSeed`
and `app_charter_resolve`'s seed is `(id, startedAt)`, both fixed at
dispatch; `market.u01` is mulberry32, the same generator as `Combat._mk`, so
`Missions.rolledSuccess` / `Charters.predictClean` reproduce the SQL
resolvers' draws and every mid-flight skirmish knows its verdict (the wallet
still lands only at settle). **§4.3 is in**: toll/customs events are choice
encounters — the incident-modal shell (`UI.showVoyCheck`) with a 15s
countdown whose timeout fires the event-seeded auto-roll, so an unanswered
(or offline, or caught-up) check costs exactly the same distribution;
outcomes roll against `Charters.fleetStats` and apply through
`Incidents.apply`, guest/local-only (the same gate and the same
`app_incident_resolve` upgrade path as incidents), exactly once via the
persisted `state.voyChecks` ledger. **§4.5 is in**: entries missed since the
persisted `state.voySeenT` watermark post to comms in order on catch-up
(bounded to the last 8 + a summary toast; pre-watermark saves still prime
silently). **Step 4 is built**: the scene lives in §6.1 world space — a
fixed 1000×1000 world with the star at the centre, the camera carrying the
canvas fit — so gates, berths and work-sites are identical on every client
and canvas size; and the §6.2 vignettes are complete: survey hulls park at a
seeded work-site (derelict hulk / abandoned outpost / anomaly, hashed from
system + survey uid) under the scan pulse, and multi-hull convoys fly in
trailing-echelon formation, each wingman wearing its own hull's sprite.

Companion to `REALTIME_SPACE.md` — this refines its Phases 1, 2 and 4 into one
concrete plan after design review. Where the two differ, this document wins.

The premise stays fixed: the game is idle-first. Everything below is a **view of
state that already exists** (or is decided at dispatch), never a simulation that
must be watched. Presence adds; absence never subtracts.

---

## 1. Principles (the load-bearing ones)

1. **Render the record.** Battles dramatize an outcome that is already decided.
   The visual layer never decides anything.
2. **The dice roll moves from arrival to departure.** Outcomes are seeded and
   computed at dispatch, not at maturity. Statistically identical, invisible to
   the player — and it makes every mid-flight event playable at its moment.
3. **Events only when there's an instance.** A safe run generates *nothing* —
   no animation, no comms entry. Encounters exist only where the seeded
   schedule put one.
4. **Deterministic from seed.** Lanes, gates, event times, choreography: all
   pure functions of `(GALAXY.seed | uid, t)`. Same trick as `Galaxy.build()`,
   `market_price` and the bazaar board. No new persisted structure.
5. **No new infra.** No realtime channels, no SQL required for v1. One future
   SQL tweak is flagged in §4.4.

---

## 2. The lane map

### 2.1 Sector ring (trunk lanes)

The six sectors connect in a loop — every sector has exactly two trunk
connectors to its neighbours (Core Worlds ↔ Korrin Belt, Core Worlds ↔ Helm
Tide, and on around). Each connector is anchored on the sectors' **edge
systems** — the closest cross-border pair — not capital-to-capital, so a
highway enters a sector at its rim and traffic reaches the capital over local
lanes. Drawn as bright "highways" on the galaxy view.

### 2.2 Intra-sector lanes

Within a sector: connect each system to its 1–3 nearest neighbours, then add a
spanning pass so the sector is guaranteed connected, with the capital as hub
bias. Derived from `GALAXY.seed` exactly like `Galaxy.build()` — every client
computes the identical graph; nothing is saved.

### 2.3 `js/lanes.js` (new, ~100 lines)

- `build()` — once at boot, after `Galaxy.build()`. Adjacency list + lane
  lengths (from `pos` distance, already the charter/survey scaling metric).
- `route(a, b)` — Dijkstra over the adjacency list, cached. 84 nodes / ~150
  edges: textbook, no library.
- `gates(sysId)` → `[{ to, angle }]` — one gate per lane; `angle` is the true
  bearing from this system's `pos` to the neighbour's `pos`.
- Later (Phase 7 of REALTIME_SPACE.md): per-lane security band from sector +
  endpoint stations + edicts. Not needed for v1 rendering.

### 2.4 Gates in the system view

Gate **count = lane count**. Gate **position = bearing to the connected
system**, projected onto the system-view edge — so the gate to Navos points at
Navos, every system's layout is unique, and it costs nothing. Replaces the
hardcoded single gate at `starmap.js` (`gatePos`, one corner for every system
today). Ambient warp-in/out traffic picks a random gate; purposeful ships (§6)
use the gate their route actually passes through.

### 2.5 Travel becomes geometry

`Economy` travel keeps its `{ departedAt, etaMs }` shape — but `etaMs` now
derives from route length through the lane graph instead of raw disk distance.
Timers keep working; they just gained a shape you can see.

---

## 3. Voyages

A **voyage** is any fleet movement: a mission, a charter, a flagship transfer.

```
plan = { legs: [systemId...], departedAt, speed }        // ~200 bytes
pos(plan, t) → { systemId | laneId, x, y, heading, leg, phase }
```

Pure function, O(1), no tick — flying is arithmetic on the clock, so it works
with the tab closed and fast-forwards for free (`REALTIME_SPACE.md` §3).

**Galaxy view:** every active voyage renders as a moving marker on its lane
polyline. Player fleets highlighted; the flagship gets its own glyph.

---

## 4. The event schedule ("roll for initiative")

### 4.1 Seeded at dispatch

At launch, hash the voyage uid → an ordered list of events:

```
events = [{ t, kind, systemId|laneId, seed }, ...]   // usually EMPTY
```

Probability per leg derives from mission type, danger band, cargo (illicit ⇒
customs exposure) and — later — lane security band. **Most voyages roll zero
events.** That's the design, not a limitation.

### 4.2 Event kinds by source

| Source | Possible events |
|---|---|
| Escort mission | 0–2 raid attempts en route (multiple instances are normal) |
| Smuggle | customs checkpoint in policed space; pirate shakedown in red space — **only if the route crosses one** |
| Transport | ambush, only on dangerous legs |
| Combat / assassinate | the engagement itself, at the destination |
| Survey | site event at the anomaly (see §6) |
| Charter | per-lane checks: customs (illicit cargo × policed lane), pirate toll (red lane), nav hazard (nebula) |
| Flagship travel | none in v1 (exposure rules are REALTIME_SPACE.md §14, later) |

### 4.3 Checks — DnD encounters with existing dice

A check rolls the event seed against `Charters.fleetStats(ships)` (already
built: cargo/firepower/hull/armor/shields aggregation). Outcomes reuse the
`incidents.js` effect vocabulary: credits delta, damage, impound, rep.

**If the player is online when a check fires**, surface it through the
`incidents.js` modal as a choice (pay the toll / run the gate / fight) with the
auto-roll as the timeout default. Offline players get the auto-roll — same
distribution, nothing lost. This merges incidents with geography: the pirate
toll now happens *somewhere*, visibly.

### 4.4 When the dice rolls (the one real change)

Today `missions.resolveMatured()` rolls at maturity; shared hauls settle on the
server at resolve. New rule:

- **Client-local voyages** (guests, charters' local loop): the full outcome —
  events, per-event results, final report — is computed from the dispatch seed.
  `resolveMatured()` stops rolling and starts *applying*.
- **Server-settled voyages**: the server verdict still wins and still lands at
  settle. Mid-flight events before settle play as non-decisive skirmishes; the
  decisive engagement is choreographed once the report exists.
- **Upgrade path — shipped, and no SQL was needed:** the dispatch RPCs
  already fix the outcome seed at launch (`app_mission_launch` stamps
  `rngSeed`; `app_charter_resolve` seeds from `(id, startedAt)`, both set at
  dispatch), so the client mirrors the resolvers instead —
  `Missions.rolledSuccess` / `Charters.predictClean` reproduce
  `market.u01`'s draws bit for bit (mulberry32 == `Combat._mk`; parity
  asserted in `tools/check_voyage.js`). Shared voyages get playable
  mid-flight outcomes with zero schema change.

### 4.5 Comms integration

When an event's time passes, `feed.js`/comms gets an entry:
`⚔ Convoy engaged off Sable-4 — ▶ watch`. Clicking plays the encounter (§5).
Entries also append to the mission's report card, so the log shows the journey,
not just the verdict. Catch-up after a closed tab posts the missed entries in
order — same fast-forward the game already does everywhere.

---

## 5. The combat view

### 5.1 Two new files

- **`js/combat.js`** — the choreographer. Pure: `(report, participants, seed) →
  script`. No DOM, no canvas. The script is a flat event list
  `{ t, kind: beam|missile|flak|death|launch|shieldhit, from, to }` over ~4
  acts (approach → first exchange → attrition → resolution).
- **`js/battleview.js`** — canvas playback in the existing `mission-modal`
  shell. Dumb renderer: reads the script, draws frames.

Not in `starmap.js` — it's 1,400+ lines and REALTIME_SPACE.md §22 already
flags it as the split candidate.

### 5.2 Choreography works backwards from the report

Fates first, timeline second: ships in `report.lost` get a death beat; ships in
`report.damaged` get hits summing to their `pct`; untouched ships are never
shown hit. Enemy losses are free variables — success reads as a rout, failure
as your line breaking. **The movie must never disagree with the wallet.**

### 5.3 Variety = templates × composition × outcome × seed

Five templates keyed by the mission type already in every report:

| Type | Shape |
|---|---|
| combat | two lines close and slug it out |
| escort | convoy huddles, raiders converge from outside |
| smuggle | a chase for the gate, pursuers cutting angles |
| assassinate | one ringed high-value target, you punch inward |
| transport | ambush — caught strung out |

Layered with fleet composition (3 corvettes vs battleship + frigates look
nothing alike), danger band (count, range, aggression), outcome shape
(flawless / pyrrhic / narrow loss / wipe), and seed jitter (formation, first
shot, which flank folds). **Duration scales with stakes:** a safe courier
scrape is a 6–8s flyby; an extreme combat mission with a battleship on the
line gets the full ~25s. Skippable from frame one; skip preference remembered.

### 5.4 Role choreography from existing stats

No new data: `speed ≥ 1.8` + low hull ⇒ dogfighting screen; destroyers/frigates
hold the line and volley; `firepower ≥ 120` + `speed ≤ 1.2` ⇒ capital drift and
broadsides; `id: "carrier"` ⇒ launches fighters mid-fight; `cls: "transport"`
huddles and runs when the line breaks. Draw size scales with `hull`, so shared
silhouettes still read as tiers (a hull-900 battleship draws ~3× a gunboat).

### 5.5 Enemy roster

`ENEMY_CATALOG` in `data.js`, mirroring `SHIP_CATALOG`'s shape
(id/name/firepower/hull/armor/shields/speed/sprite/role). 10–14 hulls, three
flavours: pirates (light, swarming), syndicate enforcers (mid, disciplined),
corporate security (heavy, shielded). Picked by `report.faction` + danger.
**Sprites: `mechanim` and `syndics`** — the two raceship silhouettes no player
hull uses — plus "stolen" player hull types for pirate flavour. Zero new art.

### 5.6 Effects are procedural — no sprite sheets

`assets/raceships/` + `assets/ships/` are already top-down, right-facing,
rotation-ready (checked). `assets/shipart/` is 3/4 catalog art — never rotate
it; it stays in the shipyard UI. Weapons/explosions are canvas primitives:
gradient-stroke beams, tracer flak, missile rects with particle trails
(`explode()`'s particle array already exists), expanding-ring deaths, arc
shield hits. Recolorable per faction, resolution-free, zero download.

### 5.7 Replays

Report cards get **▶ Replay engagement**. Requires the report to carry a
participant roster `{ uid, name, type }` for both sides (~200 bytes, capped —
save-size is already a flagged concern), because lost ships leave `s.ships`.
Seeded by mission uid: the same fight plays every time. **Never auto-play on
resolve** — `resolveMatured()` batches after time away; five queued cutscenes
is hostile. Offer inline play only when a single mission resolves while the
tab is visible.

---

## 6. The living system view

### 6.1 World space + camera

The scene gets fixed world coordinates with a camera (pan, modest zoom) instead
of canvas-pixel space. This is the one real refactor in the plan — everything
else rides on it. Bigger felt space, and shared positions stop depending on
per-client canvas size.

### 6.2 Purposeful ships (projections of real state)

Read-only derivations — no new persisted state:

- **Survey active here** → your actual survey hull parked at a seeded site
  (derelict hulk, abandoned outpost, anomaly — site type hashed from system +
  survey uid) with a scan-pulse effect.
- **Escort/transport mission in transit here** → the convoy crossing between
  its route's actual gates, escorts in formation.
- **Charter passing through** → freighter transit, gate to gate.
- **Flagship arriving/departing** → through the correct gate for its route.

Ambient errand-runners remain as filler; purposeful ships move among them.
Vignettes are v1; interacting with them (hailing, joining) is later.

---

## 7. What does not change

- Resolver math: `DMGCFG`, `successChance`, reward rolls — untouched numbers,
  only *when* they're sampled moves (§4.4).
- Server RPC surface (v1) and the security model: client-local stays
  client-local, server-settled stays server-settled.
- No framework, no build step, no sprite sheets, no new dependency.
- `file://` + GitHub Pages both keep working.

---

## 8. Build order (each step ships alone)

| Step | What | New files | Est. |
|---|---|---|---|
| 1 | Lane graph + galaxy render + per-bearing gates | `lanes.js` | ~1 session |
| 2 | Combat view: choreographer + playback + enemy catalog + replays | `combat.js`, `battleview.js` | ~3 sessions |
| 3 | Voyages: dispatch-seeded schedules, comms entries, charter checks, watchable events | `voyage.js` | ~2–3 sessions |
| 4 | System view: world-space camera + mission vignettes | (starmap split) | ~2 sessions |

1 → 2 → 3 → 4 is the dependency order: lanes give geometry, combat view gives
the payoff scene that events link to, voyages generate the events, vignettes
make systems feel inhabited. Stop points after every step.

---

## 9. Checks (`tools/`, no framework — house style)

- `check_lanes.js` — graph connected; every system's gate count = degree;
  identical graph across two independent builds; ring property on capitals.
- `check_combat_script.js` — script terminal state matches the report exactly
  (same dead, damage sums within rounding) across many seeded reports.
- `check_voyage.js` — event schedules deterministic; `pos(plan, t)` identical
  under shuffled/odd-stepped timestamp evaluation (the anti-accumulation test).

---

## 10. Open questions

- Do guests see other players' voyage markers, or only their own + NPC filler?
  (Leaning: own + filler; consistent with the ranked/unranked split.)
- Lane security bands: derive in step 1 (cheap, cosmetic tint) or wait for the
  crime phase where they gain teeth?
- Cap on stored replay rosters (save size): last N reports keep rosters, older
  ones degrade to text?
