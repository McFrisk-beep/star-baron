# Workshop crafting (server-authoritative)

Crafted gear used to exist **only in the browser**. `Workshop._deliver` wrote the
finished item into `state.items` and no RPC ever told the server — but
`app_commit` owns the item pool:

```sql
merged := jsonb_set(merged, '{items}', coalesce(server->'items', '{}'::jsonb));
```

and `Economy.applyCommitState` copies that answer back over the live state. The
only function that ever *added* to the server pool was `app_buy_accessory`, so a
crafted item was deleted by the next cloud sync — about five seconds after it
appeared. This file closes that hole by putting the craft queue on the ledger.

**Guests are unaffected** and keep the local path. So do projects that haven't
applied this file: the client latches `Cloud.craftMissing` on the first missing
RPC and falls back (crafted gear won't survive a commit there — same as before).

## Install

Supabase → **SQL Editor** → paste & **Run**
[`docs/sql/workshop_craft.sql`](sql/workshop_craft.sql). Safe to re-run.

Prereqs (all already required by Phase 3):

1. `docs/sql/market_price.sql` — `market.seed_hash` / `market.u01`
2. `docs/sql/phase1_players.sql` — `players`, `app._lock_state` / `_write_state`
3. `docs/sql/phase2_missions_bazaar.sql` — `app.item_value`, `app.make_ship`
4. `docs/sql/phase3_pull_prestige.sql` — the `app_commit` this file extends

> Apply this **after** phase 3 (and after `equip_persist.sql`): it replaces
> `app_commit` and `app.result_slice`, so re-running an earlier file afterwards
> would drop the workshop slice back out of both.

> **Re-apply `phase2_missions_bazaar.sql` and `equip_persist.sql` too** if your
> database predates the craft-only transport/survey hulls. `app.ship_def` (phase
> 2) is where hull stats live and `app._ship_slots` (equip_persist) is where
> fitment size lives — a hull missing from the first means a finished ship job
> has nothing to build, and one missing from the second silently truncates that
> ship's accessories to two slots on the next commit.

## Changing recipes later

The recipe/blackbox/hull tables live in **two** places — `js/data.js` for the
client, and these SQL fixtures for the server — so both are generated from one
source and pinned by a check.

**If you edited recipes in the game** (Admin → 🔧 Crafting), that changes only
the client half. Open that tab's **Server SQL** pane → **Copy SQL** → paste into
the Supabase **SQL Editor** → Run. No terminal involved. Until you run it, guests
see the new recipe and signed-in players get "Unknown recipe."

**If you edited `js/data.js`**, regenerate the checked-in SQL and paste the file
you changed:

```
node tools/sql/gen_craft_fixtures.js            # everything, to stdout
node tools/sql/gen_craft_fixtures.js recipe     # → docs/sql/workshop_craft.sql
node tools/sql/gen_craft_fixtures.js blackbox   # → docs/sql/workshop_craft.sql
node tools/sql/gen_craft_fixtures.js ship       # → docs/sql/phase2_missions_bazaar.sql
node tools/sql/gen_craft_fixtures.js slots      # → docs/sql/equip_persist.sql
node tools/check_craft_parity.js                # confirms the SQL matches data.js
```

> `gen_craft_fixtures.js` is a **Node script, not SQL** — it *prints* the
> fixtures. Pasting the script itself into the Supabase SQL editor fails with
> `syntax error at or near "#!"`. Paste its output, or paste the regenerated
> `docs/sql/*.sql` file. Both routes run the same generator as the Server SQL
> pane, so the two copies can't drift.

## What it creates

| Object | Role |
|---|---|
| `app_craft_start(recipe, flavor)` | Validates the blueprint, slots, inventory/fleet room, then charges ingredients + credits and queues the job. |
| `app_craft_claim()` | Delivers every job past `readyAt` (12 per call), minting gear / blackboxes / extractors / ships into the server pool. |
| `app_craft_slot()` | Buys a Workshop slot upgrade. |
| `app_craft_adopt(workshop, items)` | Migration — see below. |
| `app.craft_recipe` etc. | Recipe / blackbox / scope fixtures mirroring `js/data.js`. |
| `app_commit` | Now forces `workshop` from the server row. |

`state.workshop` (queue + slot upgrades) becomes **server-owned**: the queue is
the receipt that says an item was paid for, so a client that could append to it
could mint gear for free.

## Migrating existing players

Every player already has Workshop state the server has never seen — crafted
items, in-flight jobs, slot upgrades. `app_craft_adopt` takes that local copy
once, from `Workshop.adoptLocal()` on the first signed-in boot **before**
anything commits. Without it, all of that would vanish the moment the queue
became server-owned.

It allows **3 calls / 12 items per account, ever** rather than exactly one,
because gear recovered from a `starbaron.corrupt` wipe backup (Settings →
Restore backup) arrives *after* that first boot. Adopted items are re-rolled
server-side from their kind and rarity, so a hand-edited backup yields an
ordinary item of that kind — never its numbers.

## Known gaps

- **Senate craft edicts are not honored for signed-in players.** Fabrication
  Rights cost/time modifiers live in the client-side Senate bill model, so the
  server charges the base recipe cost and duration. Blackbox `craftTime` boosts
  (Fabricator's Boon) *are* honored — those are a 7-row fixture.
- **A job whose recipe or hull the server can't resolve is parked, not dropped.**
  Its ingredients were already charged, so it stays in the queue (holding a slot)
  until the recipe id or `app.ship_def` row comes back. Same rule client-side.
- **`knownRecipes` / `craftedOnce` stay client-owned.** Blueprints drop from the
  bazaar, expeditions, missions, story and Senate edicts, none of which have
  RPCs. This is the status quo; a forged blueprint still can't mint anything for
  free, because the ingredients and credits are server-owned.

## Tests

```
node tools/check_craft_parity.js    # SQL fixtures vs js/data.js  (runs in CI)
node tools/check_craft_client.js    # client routing + no local mint (runs in CI)
node tools/check_admin_crafting.js  # admin recipe editor round-trip + SQL (CI)
node tools/check_equip_persist.js   # hull fitment table vs SHIP_CATALOG (CI)
```

The SQL logic itself needs a real Postgres, which CI doesn't have:

```
node tools/sql/build_craft_check.js > /tmp/craft_check.sql
psql "$SCRATCH_DATABASE_URL" -v ON_ERROR_STOP=1 -f /tmp/craft_check.sql
```

Use a **throwaway** database — it creates its own `players` table and a stub
`auth.uid()`. It asserts the whole lifecycle, including the original bug
("crafted item survives app_commit") and that a forged queue job is discarded.
