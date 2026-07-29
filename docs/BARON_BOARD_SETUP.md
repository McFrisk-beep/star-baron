# Baron Leaderboard (human players)

Shared **Barons** tab ranking: signed-in players only. Rival AI barons stay as
flavor chatter; they are **not** on this board.

Wealth on the board updates **once per UTC day** when a player is online (name
and Baron Tier title can refresh anytime).

## Install

Supabase → **SQL Editor** → paste & **Run**
[`docs/sql/baron_board.sql`](sql/baron_board.sql).

Prereqs:

- `profiles` + usernames (`docs/ADMIN_SETUP.md`, `docs/sql/profile_username.sql`)
- Ideally Phase 1 `players` (+ Phase 3 `app._net_worth`) so published net worth
  includes cargo/fleet, not just credits

## What it creates

| Object | Role |
|---|---|
| `public.baron_board` | Snapshot rows (`display`, `title`, `tier`, `net_worth`). **Public read**, no client writes. |
| `app_baron_publish()` | Upserts the caller's row; **net worth only on a new UTC day**. |
| `app_baron_board()` | Returns up to 2000 rows richest-first (also usable via table select). |

## Client

`js/barons.js` fetches the board, publishes after login/save, and pages ±10
around you on the Barons tab. Guests can **read** the board but do not appear
until they sign in.
