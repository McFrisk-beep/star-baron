# Phase 3 setup — offline pull & prestige

Phase 3 makes **offline catch-up** (routes, industries, expeditions, legacy
listings, matured missions) and **Baron Tier prestige** server-authoritative
when the player is logged in.

Requires Phase 0 + Phase 1 + Phase 2 already applied.

## Paste order (Supabase SQL editor)

1. `docs/sql/market_price.sql` — if not already applied
2. `docs/sql/phase1_players.sql` — if not already applied
3. `docs/sql/phase2_missions_bazaar.sql` — if not already applied
4. **`docs/sql/phase3_pull_prestige.sql`** ← this phase (safe to re-run;
   `create or replace`)
5. **`docs/sql/equip_persist.sql`** ← required, and must come **after** step 4
   (it replaces `app_commit` so ship accessories persist — see
   [Equip persistence](#equip-persistence-fitment-survives-a-reload))
6. **`docs/sql/workshop_craft.sql`** ← required, and must come **after** step 5.
   Puts the Workshop craft queue on the ledger; without it a crafted item is
   deleted by the next `app_commit` (it rewrites `items` from the server pool).
   Replaces `app_commit` + `app.result_slice` again, carrying step 5's fitment
   merge forward — see [`docs/WORKSHOP_CRAFT_SETUP.md`](WORKSHOP_CRAFT_SETUP.md).
7. **`docs/sql/repair_equip.sql`** ← required, and must come **after** steps 5–6.
   Adds `app_repair_ship` / `app_equip_item` / `app_unequip_item`; without it
   repairs are silently undone by the next autosave — see
   [Repair & equip are RPCs](#repair--equip-are-rpcs).
8. **`docs/sql/impound_retrieve.sql`** ← required (usage-sim review **C3**). Adds
   `app_retrieve_ship`, the same trap as repair: without it a signed-in retrieve
   is undone by the next `app_commit` — the hull re-shows impounded every slice
   while the fine spend sticks (a money black hole). Mirrors `app_repair_ship`;
   the client keeps a local fallback until it's applied.

## Trust model

| RPC | Authority |
|---|---|
| `app_pull` | Banks routes / industries / listings; parks matured expeditions at **debrief** (no auto-loot); also runs mission resolve. Server clock only. Caps offline window at 7 days. |
| `app_survey_debrief` | Closes a parked survey from Dispatches (`leave` / `push_ok` / `push_fail`). Bounded credit stubs + ship release. |
| `app_prestige` | Recomputes net worth (spot prices + catalog fleet + item values); bumps tier if ≥ next threshold |
| `app_route_start` / `app_route_stop` | Assign/free route ships **server-side** (sets `'trading'` status). Routes are fully server-owned; `app_commit` forces the `routes` slice from the server. |
| `app_buy_extractor` / `app_buy_component` | Recompute the seeded offer by id, charge credits, add the **server-authored** extractor/component. `app_commit` forces the component pool and keeps only server-owned extractors. |
| `app_commit` | **Protects** positions / avgCost / prestige / routes / extractors / components / listings / surveyed timers. **Credits:** accepts client value only when *lower* (permit spends, repairs) — never an increase. Merges new industries/expeditions from client; server `nextAt` / ETA win for known ids. |

Soft income can no longer be forged by editing the save and upserting. Routes
now go through RPCs (the client can't mark a ship `'trading'` via commit, so a
route otherwise never pays). Industry/expedition setup still originates on the
client and merges via commit; production is applied only by `app_pull`.

### Industry hardening (Gap 2)

Extractors and components are now **server-authored**, so industry production
can't be inflated by editing the save:
- **Seeded board + buy RPCs** — `app.gen_extractor` / `app.gen_component` define
  each offer's type/scope/rarity/price from `(seed, epoch, slot)`;
  `app_buy_extractor` / `app_buy_component` recompute the offer, charge server
  credits, and add the server-authored item. `check_bazaar_parity.js` asserts the
  client board matches.
- `app_commit` **forces** the component pool from the server and keeps only
  server-owned extractors (`_merge_extractors`), taking the client's
  component-attachment array but nothing else — a forged extractor/component is
  dropped.
- `app_pull` still **recomputes** each component's effect from `kind`+`rarity`
  (≤0.40), honors the **2-slot** cap, uses the bounded catalog yield (0.6–1.5),
  validates the industry's **commodity is inside the extractor's scope**
  (specialized→exact / semi→category / jack→any), pays only **one industry per
  extractor**, and caps producing industries at the **tier permit cap**.

Net: a logged-in player can't forge a high-yield extractor, an inflated
component, a free/mismatched commodity, or clone one extractor across permits.

**Remaining soft (minor, bounded):** the industry *permit* (planet slot) is
still bought client-side, and planet suitability (`suit`) is a client snapshot
clamped server-side — so a cheater can skip the ~6k permit and assert a planet
type, but production magnitude stays capped and the commodity is bounded to a
**purchased** extractor's scope. The server can't fully validate a
procedurally-generated planet without porting galaxy generation to SQL.

### Equip persistence (fitment survives a reload)

`docs/sql/equip_persist.sql` fixes a long-standing bug: **gear equipped to a ship
came unequipped after a refresh.**

Equipping is a client-side action (`Fleet.equip` just pushes an item uid onto
`ship.accessories` — there's no RPC), but `app_commit` forced the whole `ships`
array from the server row, so the fitment array was discarded on every autosave
and the players row kept `accessories: []` forever. `Economy._restoreEquip`
patched it back **in memory**, which is why the equip looked fine until the next
reload — when `app_bootstrap` returned the server row and the gear popped back
into inventory.

`app_commit` now merges ships the way it already merges extractors: the server
keeps the roster and every field it owns (uid / type / cls / name / status / dmg /
mercenary / expiresAt / retrieveCost) and **only** the fitment array comes from
the client, validated by `app._merge_ships` so it can't forge stats:

| Rule | Blocks |
|---|---|
| uid must exist in the **server's** item pool | fitting gear you don't own |
| de-duplicated within a ship | stacking one item for 2× stats |
| claimed fleet-wide, first ship wins | cloning one item onto N ships |
| truncated to `app._ship_slots(type)` | exceeding the hull's slot count |

An **empty** client array is honoured, so an unequip still persists. A ship the
client didn't send keeps its stored fitment, and a client-only ship is dropped —
the roster stays server-owned. There's deliberately **no idle gate**: `app_pull`'s
mission/route math ignores accessories entirely (`app._ship_cargo`), so refitting
a busy ship buys no advantage, and gating it would wipe gear mid-mission.

`app._ship_slots` duplicates the slot counts from `SHIP_CATALOG` (js/data.js);
`tools/check_equip_persist.js` asserts the two stay in lockstep, so adding or
retuning a hull fails the check rather than silently truncating fitment.

### Repair & equip are RPCs

`docs/sql/repair_equip.sql` closes the last two economy actions that had no RPC
and therefore could not survive an autosave:

- **Repair.** `Fleet.repair` used to just set `ship.dmg = 0` and subtract the
  bill locally. `app_commit` takes the client's credits when they're *lower*
  (that's how spends work) but rebuilds `ships` from the server row — and
  `app._merge_ships` keeps the server's `dmg`. Net effect: **the player paid and
  the damage came back** on the next save. `app_repair_ship` now charges and
  clears the hull server-side, pricing off the server catalog and the server's
  own damage value.
- **Equip.** The fitment merge only re-accepts uids present in the **server's**
  item pool. Gear that only ever existed client-side — most often something
  crafted while `workshop_craft.sql` wasn't applied — was dropped on the next
  commit, so the equip "worked" until the save and then popped off.
  `app_equip_item` writes the fitment authoritatively and returns a real error
  ("that item isn't on your server ledger yet") instead of reverting in silence.

Both re-check every rule server-side: idle ship, owned item, no blackboxes, no
item fitted to two hulls, and the hull's `app._ship_slots` cap.

If the file isn't applied, `Cloud._optional` latches the missing RPC on the
first click and the client falls back to the old local behaviour — buttons keep
working, they just aren't durable. `tools/check_repair_equip.js` covers both
paths, and `tools/check_equip_persist.js` now fails if **any** `app_commit`
declared at or after `equip_persist.sql` stops calling `app._merge_ships` (that
regression is how this bug returned twice).

### Simplifications (ponytail)

- Route cargo/speed uses **catalog** ship stats (accessories ignored).
- Route events are seeded; hull damage from route events is skipped.
- Industry war/strike overlays ignored (production mult = 1); tax ignores Senate.
- Survey trips **park at debrief** on pull; the player finishes them in Dispatches.
  `app_survey_debrief` pays a **credit stub** (no item gen / local events).

## Client behaviour

- Guests: unchanged local simulation.
- Logged-in + Phase 3 SQL live (`Cloud.pullReady`): boot / resume / due-timers
  call `app_pull`; local `Routes`/`Industries`/`Expeditions` resolve and listing
  payouts are no-ops.
- Logged-in without Phase 3 SQL: falls back to Phase 2 local soft income
  (same as before).
- Prestige button → `app_prestige` with optimistic local ascend + rollback.

## Verify

```bash
for f in js/*.js; do node --check "$f"; done
node tools/check_phase3_pull_prestige.js
node tools/check_equip_persist.js
node tools/check_equip_sync.js
node tools/check_repair_equip.js
```

In the app: equip an accessory to a ship, hard-refresh, and confirm it's still
fitted (the ship's slot count stays `1/4`, not `0/4`). Then repair a damaged
hull, wait past one autosave, and confirm the hull % stays at 100.

## Re-paste note

Safe to re-run. Replaces `app_commit`, `app.result_slice`, and adds
`app_pull` / `app_prestige`. `equip_persist.sql` replaces `app_commit` again, so
always paste it **after** `phase3_pull_prestige.sql`, and `repair_equip.sql`
last of all (it needs `app._ship_slots` and `app.result_slice`).
