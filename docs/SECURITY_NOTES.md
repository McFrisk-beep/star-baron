# Security notes

Running record of the game's security posture, what's been fixed, and the
lower-priority hardening still on the backlog. The authoritative-economy design
lives in `docs/SERVER_AUTHORITATIVE_DESIGN.md`; this file is the security-review
companion.

## Trust model (short version)

- **Logged-in players** are server-authoritative. `players.state` is written
  **only** by `SECURITY DEFINER` RPCs (`app_trade`, `app_dock`, `app_unlock`,
  `app_commit`, `app_pull`, `app_prestige`, the bazaar/mission/route buys). The
  `players` table has **no client write policy** — a modified localStorage save
  can't reach the DB, and `app_commit` accepts a client credit value only when
  it's *lower* (spends), never higher.
- **Roles** live in `profiles`, which is **read-own, no client write**. You
  cannot promote yourself to admin from the client; a spoofed `Cloud.isAdmin()`
  only reveals the UI, and every admin action is re-checked by RLS server-side.
- **Shared content** (`content` table: item rarities, ships, flavor, …) is
  public-read / admin-write. Editing it in the admin console is global for all
  players and enforced admin-only by RLS.
- **Guests** are local/offline and explicitly unranked — not defended.

## Fixed

- **Legacy `saves` injection (HIGH).** `saves` is now read-own only (no client
  insert/update/delete), and `app_bootstrap` resets a migrated legacy account's
  economy to defaults (keeps only cosmetic `settings`) instead of trusting it.
  See `docs/sql/security_hardening.sql`.
- **Unbounded senate influence (MEDIUM).** `world_senate_influence` writes go
  through `app_senate_influence` (validates/clamps `kind`/`dir`/`strength`,
  rate-limits per bill, rejects closed votes); the direct insert policy is
  dropped. See `docs/sql/security_hardening.sql`.

## Backlog — lower-priority hardening (not yet done)

These are defense-in-depth / noise-reduction items surfaced by the security
review and Supabase advisors. None is a known exploit; capture here so they
aren't lost.

1. **Pin `search_path` on the `app._*` helper functions.** ~63 advisor warnings
   (`function_search_path_mutable`). The public entrypoints already set
   `search_path`; the internal helpers (`app._now_ms`, `app._lock_state`,
   `app._write_state`, `app._default_state`, …) do not. Add
   `SET search_path = public, market, app` to each. Defense in depth against
   search-path hijacking.
2. **Enable leaked-password protection** in Supabase Auth (checks passwords
   against HaveIBeenPwned). One dashboard toggle. Advisor:
   `auth_leaked_password_protection`.
3. **Tighten the public `sprites` bucket SELECT policy** so clients can't *list*
   every file (object reads via public URL don't need listing). Advisor:
   `public_bucket_allows_listing`. Low impact — it's public art.
4. **`app_*` RPCs are executable by the `anon` role.** Harmless today (each one
   raises `not authenticated` when `auth.uid()` is null), but revoking
   `EXECUTE … from anon` on the mutating RPCs would shrink the surface and clear
   ~27 advisor warnings. (`app_senate_influence` already has anon revoked.)
5. **Retire the legacy `saves` table** entirely once every active account has
   bootstrapped a `players` row. It's read-own only now, but it no longer serves
   a purpose for authoritative accounts.

## Out of scope (by design)

- **Anti-sybil / anti-automation.** Senate influence is now bounded *per
  account*, but nothing stops someone farming many confirmed accounts or
  scripting RPC calls. Per-user rate limits and bot defense are a deliberate
  later concern (see `SERVER_AUTHORITATIVE_DESIGN.md` §1, §12).
- **Guest cheating.** Guests play a local, unranked sandbox; their state is
  intentionally not defended.
