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
| `app_commit(state)` | Autosave merge: keeps economy fields server-side, accepts the rest. |

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
| Exchange buy/sell, dock, unlock | **Server** |
| Missions, bazaar, industries, prestige, … | Still client (Phase 2–3) |

So a determined player can still mint credits via missions until later phases.
Trades themselves are no longer forgeable by editing localStorage / the save row.
