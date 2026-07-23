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
| `app_dock(system)` / `app_unlock(system)` | Travel + unlock-by-credits. |
| `app_commit(state)` | Autosave merge: accepts client credits/positions (interim), protects travel/unlocks. |

## 3. Deploy the client

Ship the build that routes signed-in trades through `Cloud.rpc('app_*')`
(`js/cloud.js`, `js/economy.js`, `js/store.js`). No extra keys needed — same
`js/cloud-config.js` as before.

## 4. Smoke-check

1. Sign in → game should load (bootstrap migrates your old `saves` row if any).
2. Buy 1 Iron Ore on the Exchange → credits drop; refresh → balance sticks.
3. As a **guest**, trading still works offline with no RPCs.

If the SQL isn’t applied yet, the client falls back to the legacy `saves`
upsert and toasts a pointer at this doc — logged-in play keeps working, just
not authoritative.

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
