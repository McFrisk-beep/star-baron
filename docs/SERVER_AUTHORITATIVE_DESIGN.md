# Server-authoritative core — technical design

> Status: **Phase 0–3 landed** (deterministic market; authoritative
> trade/dock/unlock; missions & bazaar; offline pull & prestige). This document
> is the plan that was executed to make money-affecting state cheat-resistant by
> moving the authority for it from the browser to Supabase.

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

### Phase 0 deliverables (done)

- `js/market.js` — O(1) deterministic `formulaGlobal` / `formulaSystem`; tick
  recomputes from the clock; sparkline hist samples the function.
- `js/data.js` — `MARKETCFG.seed` + oscillator / event-schedule knobs.
- `docs/sql/market_price.sql` — Postgres mirror (paste when ready; not required
  for clients yet).
- `tools/check_market_parity.js` (+ `tools/market_sql_ref.js`) — JS↔SQL-ref
  parity over a (commodity × t × system) grid.

Client news/local overlays (Broadcast / Wars / Galaxy), Senate banding, and
trade-impact pressure still multiply on top for today's UX; Phase 1 routes
logged-in trades through RPC and stops trusting those for fill price.

### Phase 1 deliverables (done)

- `docs/sql/phase1_players.sql` — `players` table (read-own RLS), `app_bootstrap`,
  `app_trade`, `app_dock`, `app_unlock`, `app_commit`.
- `docs/PHASE1_SETUP.md` — paste-and-run instructions (needs `market_price.sql` first).
- `js/cloud.js` — `rpc` / `bootstrap` / `trade` / `dock` / `unlock` / `commit`;
  `authoritative()` when Phase 1 SQL is live; legacy `saves` fallback otherwise.
- `js/store.js` + `js/auth-ui.js` — signed-in load via `app_bootstrap`.
- `js/economy.js` + `js/ui.js` — logged-in buy/sell/dock/unlock → optimistic local
  apply → soft-sync commit → RPC → reconcile / rollback + toast.
- `js/orders.js` — `process()` awaits authoritative buys/sells.
- `tools/check_phase1_economy.js` — client wiring harness (incl. mission-income
  sync before trade, order fills).

**Interim reconcile (important):** `app_commit` **accepts** client
`credits`/`positions`/`avgCost` so mission/bazaar/industry/route income still
persists. It **protects** `currentSystem`/`travel`/`unlockedSystems` (no
teleport via autosave). Before each `app_trade`/`dock`/`unlock`, the client
commits the *pre-action* economy snapshot so soft income is on the server row
when the validated RPC runs. Full credit authority moves in Phase 2–3.

**You still need to run the SQL** in the Supabase dashboard (`docs/PHASE1_SETUP.md`).
Until then, signed-in clients keep using the legacy `saves` path. Re-paste if
you installed an older Phase 1 SQL before the interim reconcile.

### Phase 2 deliverables (done)

- `docs/sql/phase2_missions_bazaar.sql` — seeded bazaar board (`app.gen_*` /
  `app_bazaar_board`), `app_mission_launch(contract_id)` (pendingContracts only),
  `app_mission_resolve` (launch-time `rngSeed`), buy/sell RPCs that **recompute**
  offers, tightened `app_commit` (protects fleet/items/rep/claims; ignores client
  bazaar).
- `docs/PHASE2_SETUP.md` — paste order + trust model.
- `js/cloud.js` — Phase 2 RPC wrappers (launch by id).
- `js/economy.js` — auth snap/slice includes pendingContracts / bazaarBought / rep.
- `js/missions.js` / `js/bazaar.js` / `js/ui.js` / `js/main.js` — seeded board
  display when logged in; optimistic → soft-sync → RPC → reconcile.
- `tools/check_phase2_missions_bazaar.js` — wiring + “launch is by id” harness.

**Still soft (explicit non-goals):** extractor/component/dossier **board**
purchases; Senate; Wars flavor overlays on industry; accessory-buffed route
stats; expedition item loot (credit stubs instead). Guest sandbox unchanged.

**You still need to run** `docs/sql/phase3_pull_prestige.sql` after Phase 2
(`docs/PHASE3_SETUP.md`).

### Phase 3 deliverables (done)

- `docs/sql/phase3_pull_prestige.sql` — `app_pull` (routes / industries /
  expeditions / listings + mission resolve), `app_prestige`, tightened
  `app_commit` (credits decrease-only; protect positions/prestige/timers).
- `docs/PHASE3_SETUP.md` — paste order + trust model.
- `js/cloud.js` — `pull` / `prestige`; `pullReady` gate.
- `js/economy.js` — `applyPull`, prestige RPC, Phase 3 slice apply.
- `js/main.js` — boot/resume/live catch-up via `app_pull` when logged in.
- `js/routes.js` / `industries.js` / `expeditions.js` / `bazaar.js` — skip local
  soft income when `Cloud.pullReady`.
- `tools/check_phase3_pull_prestige.js` — wiring harness.

### What I need from you
Paste `docs/sql/phase3_pull_prestige.sql` in the Supabase SQL editor (after
Phases 0–2). Until then, signed-in clients keep Phase 2 local soft income.
