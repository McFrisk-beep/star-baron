# Phase 1 — server-authoritative trading (Supabase)

Makes **logged-in** buy/sell/dock/unlock cheat-resistant: the server validates
fills against the deterministic market and writes `players.state`. Guests stay
fully local (sandbox).

Prereq: a Supabase project with auth already working (`docs/CLOUD_SETUP.md`).

---

## 1. Install the deterministic market (if you haven’t yet)

Open **SQL Editor → New query**, paste
[`docs/sql/market_price.sql`](sql/market_price.sql), **Run**.

## 2. Install players + RPCs

New query → paste [`docs/sql/phase1_players.sql`](sql/phase1_players.sql) → **Run**.

This creates:

| Object | Role |
|---|---|
| `public.players` | Authoritative save (`state` jsonb). RLS: **read-own only** — no client writes. |
| `app_bootstrap()` | Ensure row (migrates from `saves` once); return state. |
| `app_trade(action, commodity, qty)` | Validated buy/sell at docked system. |
| `app_dock(system)` / `app_unlock(system)` | Travel + unlock-by-credits. Claimable system hubs auto-unlock on dock (re-run `docs/sql/station_dock_unlock.sql` if signed-in "Dock here" still says System locked). |
| `app_commit(state)` | Autosave merge: accepts client credits/positions (interim), protects travel/unlocks. |

## 3. Deploy the client

Ship the build that routes signed-in trades through `Cloud.rpc('app_*')`
(`js/cloud.js`, `js/economy.js`, `js/store.js`). No extra keys needed — same
`js/cloud-config.js` as before.

## 4. Smoke-check

1. Sign in → game should load (bootstrap migrates your old `saves` row if any).
2. Buy 1 Iron Ore on the Exchange → credits drop; refresh → balance sticks.
3. As a **guest**, trading still works offline with no RPCs.

### Required for the two wipes — Reset Save + Global Reset

New query → paste [`docs/sql/reset_save.sql`](sql/reset_save.sql) → **Run**,
then [`docs/sql/restore_backup.sql`](sql/restore_backup.sql) → **Run**.
`reset_save.sql` creates `app_reset_save()` (Settings → Reset Save) and
`app_world_reset_apply()` (Admin → Issue Global Reset).
`restore_backup.sql` creates no-arg `app_restore_backup()` so Settings →
Restore backup adopts the current server ledger (corrupt-migrate never wiped
it) and overlays Workshop / recipes from the browser backup — never client
credits / ships / positions.

`app_commit` deliberately protects credits / positions / ships / items /
prestige, so **no client-side wipe can reach `players.state`** — both resets
have to be RPCs. Without this file:

- **Reset Save** refuses and says so, leaving your progress intact (it used to
  clear localStorage and bounce straight back off the cloud row on reload).
- **Global Reset** leaves signed-in players untouched and re-tries on each load
  (it used to stamp `appliedResetEpoch` through `app_commit`, which took the
  5,000c credit *decrease* and echoed every other protected slice back — the
  player was marked reset, kept everything, and could never be reset again).

Guests and pre-Phase-1 `saves` players own their save, so both wipes work
locally for them with or without this file.

If the Phase 1 SQL isn’t applied yet, the client falls back to the legacy
`saves` upsert and toasts a pointer at this doc — logged-in play keeps
working, just not authoritative.

### Optional but recommended — cut the autosave's egress

New query → paste [`docs/sql/commit_allowlist.sql`](sql/commit_allowlist.sql) → **Run**.
(`commit_lite.sql` is superseded by this file and is now a no-op stub.)

`app_commit` returns the whole merged save, and on a developed player that is
~215KB — of which `Economy.applyCommitState` reads **none** of the world slices
(`market`, `galaxy`, `stations`, `story`, `senate`, `stock`, `newswire`): they
are regenerated client-side from the seed, or read from the shared world tables.
So every autosave was paying ~213KB of egress for something the client threw
away. Measured on this project it was the single most expensive statement in the
database (9,454 calls, 476s total, 50ms average).

`app_commit_lite` is a **wrapper** — it filters the upload down to an explicit
allowlist (anything a future feature forgets to classify is dropped, not
trusted), pins `craftedOnce` to the stored value so the one-of-a-kind burn
list can never be cleared, then calls `app_commit` and subtracts the world
slices from the echo. The merge/protection logic itself is untouched and
cannot drift. Measured against a real 219,422-char save: upload 74,787 chars
(−65.9%), response 5,365 chars (**−97.6%**).

Safe to skip: `Cloud.commit()` falls back to `app_commit` when the wrapper is
missing and latches after one miss, so a project without this file just keeps
paying for the full-size response.

---

## Trust model (honest)

| Action | Authority after Phase 1 |
|---|---|
| Exchange **fill price** / qty validation, dock, unlock | **Server** (`app_trade` / `app_dock` / `app_unlock`) |
| Credits & positions from missions, bazaar, industries, routes, … | Still **client** via `app_commit` (interim) |
| Travel / currentSystem / unlockedSystems on autosave | **Server** (anti-teleport) |

So a determined player can still mint credits by forging `app_commit` payloads
until Phase 2 seals those income sources. What they *can't* do is invent a
favorable exchange fill: `app_trade` prices against `market_price()` at the
server's docked system after locking the row.

**Re-run note:** if you already installed an older `phase1_players.sql`, re-paste
the file (or at least recreate `app_commit` / `app_dock`) so the interim credit
reconcile and unlocked-system docking land.
