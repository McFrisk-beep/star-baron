# Phase 2 setup — missions & bazaar RPCs

Phase 2 makes **mission launch/resolve** and **bazaar purchases** (ships, main,
mercs, accessories, contracts, hangar upgrade) server-authoritative when the
player is logged in.

Requires Phase 0 + Phase 1 already applied.

## Paste order (Supabase SQL editor)

1. `docs/sql/market_price.sql` — if not already applied
2. **`docs/sql/phase1_players.sql`** — re-run this even if already applied:
   `app_trade` now also awards server-side trade reputation. Safe to re-run
   (`create or replace`).
3. **`docs/sql/phase2_missions_bazaar.sql`** ← this phase (safe to re-run; replaces
   older Phase 2 functions)

## Trust model (important)

Bazaar offers and job contracts are a **seeded function of time**
(`epoch = floor(now_ms / 60000)`, seed `cosmocrat-market-v1|bazaar|…`). Purchase /
take / launch RPCs **recompute** the offer from its id — they never trust
client-supplied prices, rewards, ship types, or item values.

| RPC | Authority |
|---|---|
| `app_bazaar_board` | Returns current seeded board (optional; client can mirror) |
| `app_buy_ship` / `app_buy_main` / `app_upgrade_inventory` | Catalog / formula prices |
| `app_buy_merc` / `app_buy_accessory` / `app_take_contract` | Recompute offer by id |
| `app_mission_launch(contract_id, ships)` | Contract must be in server `pendingContracts` |
| `app_mission_resolve` | Launch-time `rngSeed`; server reward + full `onContract` reputation |
| `app_sell_ship` / `app_sell_item` | Catalog / recomputed `app.item_value` |
| `app_commit` | Protects ships/missions/items/inventory/rep/claims; **ignores** client bazaar |

**Reputation is fully server-authoritative.** Trades award standing in `app_trade`
(mirrors `Rep.onTrade`); contracts award it in `app_mission_resolve` (danger-scaled
gain, rival penalty, dirty-work Free-Trade hit — mirrors `Rep.onContract`).
`app_commit` protects the `reputation` slice, so a client can't forge standing to
inflate discounts or reward multipliers. `tools/check_bazaar_parity.js` asserts the
client's seeded board matches these generators.

## Client behaviour

- Guests: unchanged local simulation (procedural board).
- Logged-in: display board from the same seed; mutations go through RPCs.
- Soft income (routes, industries, expeditions, listings) still client-side until
  Phase 3; `app_commit` still accepts those credit deltas.
- Extractors / components / dossiers on the board remain local soft content.

## Re-paste note

If you installed an earlier Phase 2 SQL that accepted client boards / contract
JSON, re-run this file. It drops `app_mission_launch(jsonb, jsonb)` in favor of
`app_mission_launch(text, jsonb)`.
