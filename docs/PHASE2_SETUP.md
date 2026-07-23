# Phase 2 setup — missions & bazaar RPCs

Phase 2 makes **mission launch/resolve** and **bazaar purchases** (ships, main,
mercs, accessories, contracts, hangar upgrade) server-authoritative when the
player is logged in.

Requires Phase 0 + Phase 1 already applied.

## Paste order (Supabase SQL editor)

1. `docs/sql/market_price.sql` — if not already applied
2. `docs/sql/phase1_players.sql` — if not already applied
3. **`docs/sql/phase2_missions_bazaar.sql`** ← this phase (safe to re-run)

## What it adds

| RPC | Purpose |
|---|---|
| `app_mission_launch` | Validate contract + idle ships; stamp server `startedAt` / chance / phases |
| `app_mission_resolve` | Resolve matured missions with server RNG; pay credits / attrition |
| `app_buy_ship` / `app_buy_main` | Deduct credits; append ship / set mainShip |
| `app_buy_merc` / `app_buy_accessory` | Hire / buy from board offer |
| `app_take_contract` | Deduct fee; append to `contracts` |
| `app_upgrade_inventory` | Hangar capacity upgrade |
| `app_sell_ship` / `app_sell_item` | Sell fleet ship / hangar item (closes dump hole) |
| `app_commit` (replaced) | Protects ships/missions/items/inventory; still accepts soft-economy credits |

## Client behaviour

- Guests: unchanged local simulation.
- Logged-in + Phase 2 SQL present: mission/bazaar mutations go through RPCs.
- Soft income (routes, industries, expeditions, listings) still client-side until
  Phase 3; `app_commit` still accepts those credit deltas.
- If Phase 2 RPCs are missing, client falls back to local mutation + commit.

## Honest limits

- Bazaar **board generation** is still client-side (synced via commit). Purchase
  RPCs validate the offer exists in the stored board — a forged offer id fails.
- Mission outcome RNG is server-side; loot tables are a simplified subset of the
  client generator (credits + attrition are the high-value parts).
- Soft income remains forgeable until Phase 3 `app_pull`.
