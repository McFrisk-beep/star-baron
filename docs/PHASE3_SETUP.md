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

## Trust model

| RPC | Authority |
|---|---|
| `app_pull` | Banks routes / industries / expeditions / listings; also runs mission resolve. Server clock only. Caps offline window at 7 days. |
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

### Simplifications (ponytail)

- Route cargo/speed uses **catalog** ship stats (accessories ignored).
- Route events are seeded; hull damage from route events is skipped.
- Industry war/strike overlays ignored (production mult = 1); tax ignores Senate.
- Expedition gear/seam outcomes pay a **credit stub** (no item gen / local events).

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
```

## Re-paste note

Safe to re-run. Replaces `app_commit`, `app.result_slice`, and adds
`app_pull` / `app_prestige`.
