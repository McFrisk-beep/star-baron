# Phase 4 setup — sector stock authority

Phase 4 makes **commodity shelf stock** server-authoritative for signed-in
players. Fill price becomes:

```
market.price_system(c, sys, t) × scarcity(units / baseline) × (1 ± spread)
```

Guests keep the existing local `js/stock.js` loop. Station ownership / auctions /
Exchange Hall / Contract Office stay **client-authoritative** for now; SQL stubs
reserve the `app_station_*` names.

Requires Phase 0–3 (and workshop/repair overlays) already applied.

## Paste order (Supabase SQL editor)

1. `docs/sql/market_price.sql` — if not already applied  
2. `docs/sql/phase1_players.sql` — if not already applied  
3. Phase 2 / 3 / equip / workshop / repair — if not already applied  
4. **`docs/sql/phase4_sector_stock.sql`** ← this phase (safe to re-run)

Optional cron (Supabase → Database → Cron):

```sql
select public.app_stock_tick();
```

Run hourly. Without it, stock only moves when players trade; the zero-player
equilibrium from the client sim will not run on the server.

## Trust model

| RPC / object | Authority |
|---|---|
| `sector_stock` table | Shared shelf. Public `SELECT`. Writes only via SECURITY DEFINER RPCs. |
| `app_trade` (replaced) | Locks shelf row, clamps buy qty to units, applies scarcity, mutates units. Returns `stockUnits` + `sectorId` for client resync. |
| `app_sector_stock` | Full shelf snapshot for login / catch-up hydrate. |
| `app_stock_tick` | Coarse hourly consumption + NPC elastic backstop (optional cron). |
| `app_station_*` | Directory / hall / bays LIVE once their SQL is pasted (§14.1). Remaining stubs: bid, auction, module, policy, withdraw. |
| `app_commit` | Still must **not** trust client `state.stock` (stock is not in the save slice). |

### Stations alive (§14.1) — paste after phase 4

5. `docs/sql/station_directory.sql` — phase A (public station record)  
6. `docs/sql/station_hall.sql` — phase B (shared Exchange Hall)  
7. `docs/sql/station_bays.sql` — phase C (shared Production Hub bays)

Then, **after all other `station_*` files** (these redefine those functions and
must win — see each file's header for the exact predecessors), paste the two
server-authoritative custody fixes from the usage-sim review:

8. `docs/sql/publish_keep_won_stations.sql` — **C1**: stop `app_station_publish`
   from releasing a station owned server-side but missing from a client's publish
   list (e.g. an auction won while offline). Without it a just-won station snaps
   back to NPC after the bid credits are already spent.
9. `docs/sql/hall_item_custody.sql` — **C2**: make the Exchange Hall actually move
   goods (list removes + escrows the server's copy, buy delivers, cancel/settle/
   refund restore). Without it a seller keeps the listed item *and* collects the
   buyer's credits, repeatably.

After pasting `station_bays.sql`, call each RPC once as a signed-in user (the
functions *create* fine even when a local variable shadows a column — that only
surfaces at call time):

```sql
-- Expect ok:false with a real error string, not "column reference is ambiguous"
select public.app_station_lease_bay('navos', 0, '');
select public.app_station_vacate_bay('navos', 0);
select public.app_station_bay_produce('navos', 0, 10);
```

## Client behaviour

- Guests: unchanged (`Stock.tick`, local take/put).  
- Signed-in: `Cloud.sectorStock()` hydrates `Stock.units` after bootstrap/pull;
  `Stock.tick` is skipped while authoritative; trade rollback restores stock;
  trade responses apply `stockUnits` for the traded commodity.

## Verify

```sql
select to_regclass('public.sector_stock');
select count(*) from public.sector_stock;  -- expect 6 sectors × ~41 tradeables
select public.app_sector_stock()->'ok';
```

Parity of the scarcity curve (no DB needed):

```bash
node tools/check_scarcity_parity.js
```
