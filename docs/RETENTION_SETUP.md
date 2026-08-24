# Data retention — keeping the database manageable

The world ticks already trim the tables they write (`world_feed` 3h, `world_news`
6h, `world_senate` 14d). Everything else appended without a ceiling. This adds
**one daily sweep** that prunes the rest.

Measured on the live project on 2026-08-24, 69 days in — a 35 MB database:

| Table | Size | Why it grows | Before |
|---|---|---|---|
| `cron.job_run_details` | **16 MB / 104,638 rows** | pg_cron logs every run of all four jobs (~1,537/day) and never prunes. Supabase does not purge it for you. | no retention |
| `sector_stock` | 2,744 kB | 246 rows holding **14 kB** of live data — the rest is update bloat | n/a (not a retention problem — see §3) |
| `players` + `saves` | 1,472 kB | ~43 kB + ~34 kB of JSONB **per account** | the real ceiling |
| `world_senate_result` / `_influence` | small | one row per cycle, per player | retention written but **commented out** |
| `station_*` | ~0 | one row per haul / payout / tax / listing / auction, forever | no retention |

`cron.job_run_details` is the headline: **46% of the entire database is the
scheduler's own log**, growing ~85 MB/year whether or not anybody plays.

## What this does *not* delete

The station ledgers double as **custody records**. A settled row is history; an
unsettled one is the only server-side proof that a player is owed something.

- `station_payouts` / `station_bay_tax` with `claimed_at is null` — **credits owed**.
- `station_listings` with status `open` or `cancelled` — the seller's **item** is
  held server-side; `app_station_settle()` hands it back on their next visit
  (`docs/sql/hall_item_custody.sql`).
- `station_hauls` with status `open` or `active` — **in flight**.

Only settled/terminal rows are pruned. `tools/check_retention.js` locks this
down; it fails if a predicate is ever widened to touch a custody state.

## 1. Run the SQL

Supabase dashboard → **SQL Editor** → paste `docs/sql/retention.sql` and **Run**.
Idempotent, and safe on a project that never ran the station SQL (missing tables
are skipped). It creates `public.retention_tick()` and schedules it daily at
03:17 UTC.

**Dry-run first** — it reports what *would* go, per table, and deletes nothing:

```sql
select public.retention_tick(true);
```

Then for real:

```sql
select public.retention_tick();
```

## 2. The windows

All of them are interval literals in the rule list inside `retention_tick()`.
Edit and re-run the file to change one, exactly like `world_tick`'s `lines` array.

| What | Kept for |
|---|---|
| `cron.job_run_details` | 14 days |
| `world_senate_result` | 21 days |
| `world_senate_influence` | 14 days |
| settled `station_*` ledger rows | 30 days |
| `flagship_presence` (stale) | 2 days |
| **abandoned accounts** (`players` + `saves`) | **180 days** |

### The account reap

This is the only rule that deletes real save data, and the only one that
addresses the actual ceiling (~1,400 accounts against the 500 MB free tier).
An account is reaped only if it is **cold and settled** — it fails closed, so
any doubt keeps the account:

- 180 days since the newest of `players.updated_at`, `saves.updated_at`,
  `profiles.created_at` — both save rows are gated on the **same** combined
  timestamp, so a stale legacy `saves` row can never survive its `players` row
  and resurrect as the live game;
- not an admin;
- owns no station, is owed no credits, has no goods in custody, nothing in flight,
  is not the high bidder on an open auction.

`profiles` and the `auth.users` row are **kept**, so a returning player still
owns their username — they come back to a fresh save, not a taken handle.

## 3. One-off: de-bloat `sector_stock`

Not retention — bloat, and worth fixing while you're here. `stock-tick` rewrites
all 246 rows hourly: 122,553 updates so far, of which only **748 (0.6%) were
HOT**. At the default fillfactor of 100 a full page has nowhere to put the new
row version, so each update lands on a fresh page and drags an index write with
it. Result: 14 kB of live data in 2,744 kB.

Run **by hand, once** (`VACUUM FULL` takes a brief exclusive lock — milliseconds
on a table this small, which is why it isn't in the cron):

```sql
alter table public.sector_stock set (fillfactor = 70);
vacuum full public.sector_stock;
vacuum full cron.job_run_details;   -- after the first retention_tick()
```

Expect the database to drop from ~35 MB to ~16 MB.

## 4. Verify

```sql
select jobname, schedule, active from cron.job;
select jobname, status, start_time from cron.job_run_details
 where jobname = 'retention-tick' order by start_time desc limit 5;

select c.relname, pg_size_pretty(pg_total_relation_size(c.oid))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('public','cron') and c.relkind = 'r'
 order by pg_total_relation_size(c.oid) desc limit 10;
```

And the guardrails: `node tools/check_retention.js`.

## Still unbounded (deliberately not touched)

- **`raw-export/` is 247 MB** of the 381 MB working tree and is referenced by no
  shipped code; `.git` is 300 MB, so every clone and CI run pays it. Untracking it
  from HEAD would not shrink `.git` — the blobs live in history — so this needs a
  history rewrite or a move to Releases, which breaks existing clones. Flagged, not done.
- **Egress**, not storage, is the other free-tier limit (5 GB/mo): `world_feed`
  polls every 45s per client and saves push every 15s. `tools/check_cloud_egress.js`
  already guards the payload size; the *cadence* is what to watch as players arrive.
