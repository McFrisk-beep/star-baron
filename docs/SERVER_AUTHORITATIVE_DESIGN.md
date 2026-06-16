# Server-authoritative core — technical design

> Status: **proposal for review.** No game code changes yet. This document is the
> plan to make money-affecting state cheat-resistant by moving the authority for
> it from the browser to Supabase.

## 1. Goal & non-goals

**Goal:** a logged-in player cannot fabricate progress by editing JS, the DOM,
localStorage, or their save row. Every credit they gain must be the result of an
action the **server** validated and applied.

**Non-goals (now):**
- Real-time multiplayer or a shared live market between players.
- Stopping *guests* from cheating — guests play a local, clearly-unranked sandbox.
- Perfect anti-bot/anti-automation (rate-limiting is a later concern).

**Key truth that shapes everything:** the game is only as cheat-proof as its
*weakest* credit source. Securing trades but leaving missions client-side still
lets someone mint credits via missions. So full protection only arrives when
**all** credit sources are authoritative (end of Phase 3). Each phase narrows the
hole; the doc is honest about what's still open mid-rollout.

## 2. Trust model

| State | Authority after rollout |
|---|---|
| credits, positions, avgCost | server |
| owned ships, mainShip, items, inventory | server |
| unlockedSystems, currentSystem, travel | server |
| missions + their payouts | server |
| reputation, prestige, stats | server |
| market prices | **deterministic function of time** (server validates, client mirrors for display) |
| rivals leaderboard, feed/chat, TV, local flavor | client (cosmetic — no money impact) |

The authoritative state is stored server-side and **can only be mutated by
server-side functions**. The client may *read* its own state but may **not**
write it directly (enforced by RLS — see §5). The client sends *intents*
("buy 10 iron_ore"); the server decides the outcome.

## 3. Architecture

```
 Browser (client)                         Supabase
 ────────────────                         ─────────────────────────────
 - renders state                          Postgres
 - computes prices LOCALLY for display      • players(user_id, state jsonb)   ← only functions write
   using the shared market formula          • RLS: read-own, no client writes
 - sends action intents  ───rpc()───▶      plpgsql RPC functions (SECURITY DEFINER)
 - replaces local state with the            • app_bootstrap()  → ensure/return state
   authoritative response                    • app_trade(action, commodity, qty)
                                             • app_dock(system) / app_unlock(system)
                         ◀──state json──     • app_pull()  → state + offline catch-up
                                             • (phase 2) app_mission_*, app_buy_*
                                           market_price(commodity, system, t) ← single SQL source of price
```

Why **plpgsql RPC** for the core (not Edge Functions): it runs *inside* the DB,
so a trade is atomic (`SELECT … FOR UPDATE`), there's **no separate runtime to
deploy**, no cold starts, and `supabase.rpc()` is a one-line client call. Edge
Functions (Deno/TS) are reserved for logic that's painful in SQL (e.g. richer
procedural mission generation) and only if we actually need them.

## 4. Deterministic market (the linchpin)

The current market is a random walk that **accumulates** state per tick — the
server can't reproduce it to validate a trade. We replace it with a function that
is **O(1), reproducible at any time t, and identical on client and server**.

### Formula (the contract both implementations MUST match)

```
price_global(c, t):                         # t in ms since epoch
  drift = 1 + DRIFT_AMP * sin(2π·t/DRIFT_PERIOD_MS + CAT_PHASE[c.cat])
  osc   = Σ_{i=1..3} A[i] * sin(2π·t/P[c,i] + θ[c,i])     # A normalized so |osc| ≲ 1
  price = c.base * drift * (1 + c.vol * VOL_GAIN * osc)
  price = price * event_mult(c, t)                        # see below
  return clamp(price, c.base*FLOOR, c.base*CEIL)

price_system(c, system, t) = price_global(c, t) * SYSTEM_MODS[system][c.cat]
                                                * local_event_mult(c, system, t)
```

- `A[i]`, `P[c,i]`, `θ[c,i]` are derived **deterministically** from
  `hash(MARKET_SEED, c.id, i)` (e.g. mulberry32 seeded by a string hash), so they
  are fixed constants per commodity — same everywhere. Periods chosen across a
  range (minutes→hours) so the curve looks organic, not sinusoidal.
- Constants reuse today's `CONFIG`: `DRIFT_AMP=0.06`, `DRIFT_PERIOD_MS=30min`,
  `FLOOR=0.3`, `CEIL=3.0`. `VOL_GAIN` tuned so motion ≈ current feel.
- **Time = server time.** Trades execute at `now()` on the DB; the client's clock
  is never trusted for pricing. The RPC returns the **actual fill price** so the
  UI shows what really happened (price may have ticked between display and fill —
  that's fine, like a real market).

### News / events, deterministically

Price-moving events become a **seeded schedule** rather than client RNG:
`event_mult(c, t)` is computed from the set of events whose window covers `t`,
where the event timeline is a pure function of `floor(t / EVENT_PERIOD)` + seed
(which category, multiplier, duration, decay). No writer process or table needed;
client and server compute the same active events.

> The *flavor* layer (omens, scam tips, the newswire copy, TV) stays client-side
> and cosmetic. Only the **price effect** is governed by the deterministic
> schedule, so the omen→news payoff still works: the omen hints the scheduled
> event, the schedule moves the price, the server honors it.

Local (per-system) events that move one system's prices likewise come from a
seeded per-system schedule.

### Parity guarantee
The formula is implemented twice (JS for display, SQL for authority). To prevent
drift we add a **parity test**: a Node script samples N×(commodity, t) pairs and
asserts the JS result matches the SQL function (queried) within ε. Runs in CI /
pre-deploy. A `get_prices()` RPC also lets the client self-check occasionally.

## 5. Database schema

```sql
create table public.players (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  state      jsonb       not null,
  updated_at timestamptz not null default now()
);
alter table public.players enable row level security;

-- read-only to its owner; NO insert/update/delete policies exist, so the
-- anon/auth client can never write this table directly…
create policy "read own player" on public.players
  for select using (auth.uid() = user_id);

-- …only SECURITY DEFINER functions (below) write it, after validating actions.
```

(The existing `saves` table from the local-first cloud feature can be retired for
logged-in users, or kept as a read cache. The doc assumes `players` supersedes it.)

## 6. Server API (Phase 1)

All are `SECURITY DEFINER` plpgsql functions owned by a privileged role, granted
`EXECUTE` to `authenticated`. Each starts by resolving `auth.uid()` and locking
the player row `FOR UPDATE` (atomicity / no double-spend on concurrent calls).

### `app_bootstrap() → state`
Ensures a row exists for the user (creates the canonical default state if not),
returns the authoritative state. Called once on login.

### `app_trade(p_action text, p_commodity text, p_qty int) → result`
Validates and applies a buy/sell **at the player's current docked system**
(system is taken from server state, never from the client, so they can't pick a
favorable market):
1. load state `FOR UPDATE`; reject if `travel` is non-null (in transit).
2. `qty = floor(p_qty)`, reject if `≤ 0`.
3. `price = market_price(p_commodity, state.currentSystem, now())`.
4. apply authoritative reputation **edge** (`buy = price*(1-edge)`, `sell = price*(1+edge)`).
5. **buy:** require `credits ≥ cost`; decrement credits; update `positions`, `avgCost`.
   **sell:** require `positions[c] ≥ qty`; increment credits; update position.
6. update `stats` (trades, biggestTrade), bump `updated_at`, write `state`.
7. return `{ ok, fillPrice, credits, positions, avgCost }` (or `{ ok:false, error }`).

### `app_dock(p_system text) → result` / `app_unlock(p_system text) → result`
Start travel (server stamps `departedAt`/`etaMs`; arrival validated by server time
on next read) and unlock-by-credits, both validated server-side.

### Later phases
- **Phase 2:** `app_mission_launch`, `app_mission_resolve` (server rolls outcomes
  with `gen_random_uuid()`/seeded RNG), `app_buy_ship/main/merc/accessory`,
  `app_take_contract`, `app_upgrade_inventory`. The bazaar board (mercs/contracts/
  accessories) becomes a **seeded function of time** so offers are server-known
  and purchases validated.
- **Phase 3:** `app_pull()` computes offline / "while you were away" gains
  server-side (matured missions, listing sales) using the deterministic market;
  `app_prestige()`.

## 7. Client changes

- **`market.js`** → deterministic price function (the §4 contract). The 2s tick
  just *recomputes* prices from the current time (cheap) instead of random-walking.
  History for sparklines = sample the function over the last N intervals.
- **`economy.js`** → for **logged-in** players, `buy/sell/dock/unlock` become
  `await supabase.rpc('app_*', …)`, then replace the authoritative slice of
  `Game.state` from the response and re-render. **Optimistic UI:** apply the
  expected result immediately, show a subtle pending state, and reconcile/rollback
  when the server responds (keeps trading snappy despite ~100–300ms latency).
- **Guest path unchanged:** if `!Cloud.signedIn()`, use today's local economy
  (clearly an unranked offline sandbox). One branch: `if (authoritative) rpc else local`.
- **Store/sync:** logged-in state comes from `app_bootstrap`/`app_pull`, not the
  JSONB upsert. Local save remains only as an offline cache for the guest sandbox.
- **Failure UX:** if a trade RPC fails (offline/conflict), revert the optimistic
  change and toast "couldn't reach the exchange — try again."

## 8. Guest vs. authenticated

| | Guest | Logged in |
|---|---|---|
| State authority | local (cheatable) | server |
| Works offline | yes | reads cached; actions need connection |
| Counts for ranked/leaderboard | no | yes |
| Trade latency | instant | ~100–300ms (optimistic = feels instant) |

This preserves "play instantly," while making *accounts* trustworthy.

## 9. Concurrency, time, atomicity

- Every mutating RPC locks the player row `FOR UPDATE`, so two rapid trades can't
  double-spend.
- **Server time only** for pricing, travel ETAs, mission maturation, event
  schedule — the client clock is never trusted.
- Optional `updated_at` optimistic-concurrency token returned to the client to
  detect/abort stale writes.

## 10. Cost on the free tier

- RPC calls = normal API requests → **unlimited** on Supabase free; DB compute per
  trade is trivial (a few sins + a row update).
- Storage: one small JSONB row per user → negligible vs the 500 MB cap.
- No Edge Functions needed for Phase 1 (so the 500K/mo budget is untouched).
- Still subject to the **7-day inactivity pause** (unchanged; any login wakes it).

Net: effectively free at small/medium scale.

## 11. Rollout plan

1. **Phase 0 — deterministic market.** Land the new `market.js` formula behind the
   existing UX (client-only), plus the SQL `market_price()` + parity test. No
   behavior change for players; this de-risks the hardest part first.
2. **Phase 1 — authoritative trading.** `players` table, RLS, `app_bootstrap`,
   `app_trade`, `app_dock`, `app_unlock`; client routes trades through RPC when
   logged in. *Trades are now uncheatable.* (Missions/bazaar still client → noted.)
3. **Phase 2 — authoritative missions & bazaar.** Server-rolled outcomes and
   purchases; seeded offer board.
4. **Phase 3 — offline catch-up & prestige server-side.** Now **all** credit
   sources are authoritative → the account economy is cheat-resistant.

Each phase is shippable and independently testable.

## 12. Risks & open questions

- **Formula parity (JS↔SQL):** mitigated by the parity test + `get_prices` self-check.
- **Latency feel:** mitigated by optimistic UI; needs playtesting.
- **Migration of existing saves:** import current `saves.data` into `players.state`
  once per user on first authenticated bootstrap.
- **Determinism vs. surprise:** a seeded market is less "wild" than pure RNG. Tunable
  via more oscillators / `VOL_GAIN`; decide if the feel is acceptable in Phase 0.
- **Reputation/edges, prestige multipliers** must be read from authoritative state
  inside the RPCs (not trusted from client) — already accounted for.
- **Anti-automation** (scripted RPC spamming to grind) is out of scope; add
  per-user rate limits later if needed.

## 13. Deploy steps (Phase 0–1)

1. Run the §5 schema SQL in the Supabase SQL Editor.
2. Run the provided `market_price()` + `app_*` function SQL; `grant execute … to authenticated`.
3. Set `MARKET_SEED` (a constant) identically in the SQL and in `js/data.js`.
4. Deploy the client with the new `market.js` + RPC-routed `economy.js`.
5. Run the parity test against the live DB before flipping logged-in players to RPC.

No Supabase CLI / Edge Function deploy is required for Phases 0–1 (pure SQL).
Edge Functions (and `supabase functions deploy`) only enter the picture if Phase 2
needs them.

---

### What I need from you to start building Phase 0
Just a go-ahead. Phase 0 (deterministic market + parity test) changes no visible
behavior and needs no Supabase work from you yet — it's the safe first step. The
Supabase SQL (schema + functions) comes with Phase 1, with copy-paste blocks like
the existing `docs/CLOUD_SETUP.md`.
