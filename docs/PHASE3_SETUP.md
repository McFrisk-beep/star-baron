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
| `app_commit` | **Protects** positions / avgCost / prestige / routes / listings / surveyed timers. **Credits:** accepts client value only when *lower* (permit spends, repairs) — never an increase. Merges new industries/expeditions from client; server `nextAt` / ETA win for known ids. |

Soft income can no longer be forged by editing the save and upserting. Routes
now go through RPCs (the client can't mark a ship `'trading'` via commit, so a
route otherwise never pays). Industry/expedition setup still originates on the
client and merges via commit; production is applied only by `app_pull`.

### Industry hardening (Gap 2)

`app_pull` bounds industry production so client-set inputs can't inflate it:
- each component's effect is **recomputed** from its `kind` + `rarity`
  (`app._component_amount`), never the client's `amount` — a forged
  `amount:9999` is clamped to its legit ceiling (≤0.40);
- at most **2 components** per extractor count (the real slot cap);
- extractor yield is the bounded catalog multiplier (0.6–1.5);
- only the tier's **permit cap** worth of industries produce per pull.

**Known residual (needs server-side planet data):** the industry's `commodity`
and `planetType` are still client snapshots — the server can't validate a
procedurally-generated planet without porting galaxy generation to SQL. So a
determined cheater can still run a *bounded, legit-magnitude* industry on a
fabricated planet/commodity for free. Production magnitude is capped; the
open lever is only *which* commodity and *skipping setup cost*. Fully closing
it means a seeded server extractor board + `app_buy_extractor`/`_component` +
`app_build_industry` RPCs (a later pass).

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
