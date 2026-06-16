# Star Baron — Handoff / Context Doc

A complete orientation for picking this project up in a fresh session. Read this
top-to-bottom once; it captures the architecture, the persistence/cloud model,
the conventions that aren't obvious from any single file, the recent bug fixes
not to regress, and what's deliberately left for later.

---

## 1. What it is

A browser-based interstellar **trading game**: read a live market, run a combat
fleet, take contracts, climb a rival-baron leaderboard, become a galactic trade
baron. Pure front-end (no framework, no build step) served as a static site,
with an **optional** Supabase backend for accounts, cloud saves, an admin content
CMS, and a shared persistent world.

- **Stack:** vanilla HTML/CSS/JS. No bundler, no npm, no transpile.
- **Run locally:** open `index.html` (works on `file://`), or serve the folder
  (`python3 -m http.server`) — a real URL is needed for Supabase email-confirm
  redirects and is how it's deployed.
- **Deploy:** GitHub Pages from `main` (`https://mcfrisk-beep.github.io/star-baron/`).
- **Repo:** `mcfrisk-beep/star-baron`, default branch `main`.

---

## 2. Architecture & conventions (read this — it's the non-obvious part)

### No build, global scripts, shared scope
Every file is a classic `<script>` loaded in dependency order from `index.html`.
There are **no modules/imports**. Files communicate via:
- **`window.*` globals** (`Game`, `Market`, `UI`, `Cloud`, `Content`, etc.), and
- top-level `const` declarations that are visible to later scripts via the shared
  global lexical scope.

**Script load order in `index.html` (order matters):**
```
supabase CDN → data.js → flavor.js → cloud-config.js → store.js → cloud.js →
content.js → market.js → galaxy.js → items.js → fleet.js → economy.js →
reputation.js → rivals.js → missions.js → bazaar.js → feed.js → broadcast.js →
worldfeed.js → ui.js → auth-ui.js → admin-ui.js → starmap.js → main.js
```

### Decoupling
- **`Bus`** (in `store.js`) is a tiny pub/sub (`Bus.on/emit`). Cross-module events:
  `chat`, `news`, `trade`, `runDone`, `dock`, `missionDone`, `missionLaunched`,
  `rep`, `prestige`, `achievement`, `localEvent`, `auth`, `rivalPass`, etc.
- **`Util`** (in `store.js`) holds shared helpers (`randInt`, `pick`, `clamp`,
  `gauss`, `credits`, `ago`, `duration`, …).

### Content is data, not code
Game content lives in `data.js` (config/economy) and `flavor.js` (text pools).
Both export everything to `window`. The engine reads these at runtime, so they
can be **overridden live** (see §5 Content CMS).

### Module map
| File | Responsibility |
|---|---|
| `data.js` | Static config: `CONFIG`, `COMMODITIES`, `SYSTEMS`, `SHIP_CATALOG`/`ALL_SHIPS`, `RARITIES`, `DANGER`, `FACTIONS`, `REP`, `RIVALS`, `PRESTIGE`, `GALAXY`, `SECTORS`, `RACES`, `SYSTEMVIEW`, `ASSET`/`ASSET_OVERRIDES`. |
| `flavor.js` | All text pools: chat, omens, news events, NPCs, TV, local feeds, ship radio/dialogues, rival barbs, tutorial steps, naming pools, contract templates. |
| `store.js` | `Store` (local-first persistence + cloud sync), `Util`, `Bus`. |
| `cloud.js` | `Cloud` — the ONLY Supabase wrapper: auth, roles, per-user `saves` row. |
| `content.js` | `Content` — admin overrides overlaid on the in-memory collections at boot. |
| `market.js` | `Market` — price simulation (random walk + mean reversion + news/local effects + category drift), offline `advance`, sparkline history, sentiment. |
| `galaxy.js` | `Galaxy` — deterministic procedural galaxy (sectors/systems/planets), local news log + mechanical local events. |
| `economy.js` | `Economy` — credits, buy/sell, timed docking/travel, net worth, achievements, prestige. |
| `fleet.js` | `Fleet` — owned ships, stats, flagship, equip, mercenaries, power/cargo. |
| `items.js` | `Items` — procedural accessories (rarity/naming/value). |
| `missions.js` | `Missions` — contract missions: phases, success roll, payouts/losses, time-based resolve. |
| `bazaar.js` | `Bazaar` — shop board (ships/mercs/contracts/accessories), listings, churn. |
| `reputation.js` | `Rep` — faction standing, price edges, discounts, gated jobs. |
| `rivals.js` | `Rivals` — AI baron leaderboard (drifting net worth) + taunts. |
| `feed.js` | `Feed` — live trader chat scheduler, token templating, omens, reactions, **`prime()`** (fill on load). |
| `broadcast.js` | `Broadcast` — TV rotation + news→market pipeline + newswire + **`backfill()`** + **`disableLocalNews()`** (shared-news handoff). |
| `worldfeed.js` | `WorldFeed` — reads the **shared** Supabase world (chat + news), applies shared news effects. |
| `ui.js` | `UI` — all DOM rendering (tabbed pages, sidebar, modals), toasts, tabs. |
| `auth-ui.js` | `AuthUI` — account button + register/login modal + login save-sync. |
| `admin-ui.js` | `AdminUI` — admin gate (roles), content editor (tables/lines/groups/JSON), image manager. |
| `starmap.js` | `StarMap` — galaxy SVG view + animated canvas system view (ships, hyperspace gate, voice-lines). |
| `main.js` | `Game` — boot, single in-memory `state`, the loop, schedulers, suspend/resume, save. |

### State & the game loop
- `Game.state` is the single source of truth (credits, positions, ships, missions,
  reputation, newswire, etc.). `Game.defaultState()` / `Game.migrate()` define and
  upgrade its shape.
- Loop: `setInterval(Game.loop, CONFIG.marketTickMs=2000)` ticks market, resolves
  missions, etc. Schedulers are created in `Game.startSchedulers()` /
  torn down in `Game.stopSchedulers()` (so suspend/resume can't double up timers).

### Lifecycle: suspend when hidden (important)
When the tab is hidden, `Game.suspend()` saves, stops **all** timers + the star-map
animation + the world-feed poller. On return, `Game.resume()` **fast-forwards** the
sim (`Market.advance`, mission resolve, rivals, bazaar) then restarts everything.
This keeps an idle tab ~free and makes returning feel "the world kept running."

---

## 3. Persistence model (local-first)

All saves go through **`Store`** (`store.js`). Nothing else touches storage.
- `Store.save()` writes `localStorage` **immediately**, and (if signed in) pushes
  to the cloud on a ~20s debounce. `Store.flush()` pushes now (logout/suspend).
- `Store.load()` prefers the **cloud** copy when signed in, caches it locally,
  falls back to local otherwise.
- **`Game._noSave` guard:** during logout/login we set `Game._noSave = true` so the
  `beforeunload`/autosave can't re-persist stale state right before a reload.
  (This fixed logout-not-resetting — don't remove it.)

---

## 4. Cloud / Supabase (optional backend)

Configured in **`js/cloud-config.js`** (`window.CLOUD = { url, anonKey }`). The
anon key is **public by design**; security is enforced by RLS, never by hiding it.
Leave blank → game runs fully local/guest. **It is currently configured** (live
project `okqopvfxsexuoxlsnxtc.supabase.co`).

### What lives server-side (Supabase)
| Table / object | Purpose | RLS |
|---|---|---|
| `saves` | one JSONB save row per user | read/write own only |
| `profiles` | `role` per user (`player`/`admin`) | read own; **no client write** (you set admin in dashboard) |
| `content` | admin content overrides (per collection key) | public read, **admin write** |
| `world_feed` | shared ambient chat (cron-written) | public read, function-only write |
| `world_news` | shared galactic news events (cron-written) | public read, function-only write |
| Storage bucket `sprites` | admin-uploaded sprite overrides | public read, admin write |
| `cron.job` `world-tick` | every minute → `world_tick()` appends chat | — |
| `cron.job` `news-tick` | every ~20 min → `news_tick()` emits news | — |

### Setup docs (the SQL to run, in order of when added)
- **`docs/CLOUD_SETUP.md`** — auth + the `saves` table (cloud saves).
- **`docs/ADMIN_SETUP.md`** — `profiles` (+ new-user trigger) + `content` table +
  the `sprites` Storage bucket. How to grant yourself admin.
- **`docs/WORLD_CRON_SETUP.md`** — `pg_cron`, `world_feed` + `world_tick` +
  schedule (shared chat), and §1b `world_news` + `news_tick` + schedule (shared news).

### ⚠️ Verify which SQL has actually been run (state is uncertain across sessions)
Run in Supabase SQL Editor:
```sql
select to_regclass('public.saves'), to_regclass('public.profiles'),
       to_regclass('public.content'), to_regclass('public.world_feed'),
       to_regclass('public.world_news');
select * from cron.job;                          -- world-tick / news-tick present?
select count(*),max(created_at) from world_feed; -- climbing every minute?
```
In the browser console on load you'll see `[Cloud] online accounts enabled`,
`[Store] loaded cloud save` / `cloud save synced`, and
`[WorldFeed] shared chat/news live (...)`. A warning toast "Cloud sync isn't
working — has the 'saves' table been created?" means the `saves` table is missing.

---

## 5. Admin & content CMS

- **Roles:** `Cloud.isAdmin()` reads `profiles.role` (server-side). Players never
  see the **dev toggles** (fast news / fast time); admins get them + a **🛠 Admin**
  button. The client checks are cosmetic — real enforcement is RLS (a non-admin's
  content/sprite write is rejected by the database).
- **Content editor (`admin-ui.js`):** edits the collections registered in
  `content.js` `COLLECTIONS`. It auto-picks a widget by shape: **table** (object
  lists: commodities, ships, danger, rarities, NPCs, news, contracts, tutorial),
  **line list** (chat, local chatter), **grouped lists** (ship radio, reactions,
  rival barbs, name pools), with a **Raw JSON** toggle on everything.
- **How overrides apply:** `content.js` loads rows from the `content` table at boot
  and **mutates the in-memory globals in place** (same array/object reference the
  game already holds), so flavor edits apply live; item/rule edits apply on reload.
  Malformed/type-mismatched overrides are ignored (defaults win) → a bad edit can't
  brick the game. `Content.rederive()` rebuilds `ALL_SHIPS` after ship edits.
- **Image manager:** `🖼 Images` tab → category sub-tabs → upload to the `sprites`
  bucket; `ASSET_OVERRIDES` (consulted by every `ASSET.*` helper) points the game
  at the uploaded URL. Reset reverts to built-in art.
- **Edits live in Supabase, not Git** — that's what makes them instantly
  server-wide. (No export-to-Git button yet; see §8.)

---

## 6. Shared persistent world (Supabase Cron)

- **Chat:** `world_tick()` (every minute) appends ambient lines to `world_feed`;
  `WorldFeed` loads recent on arrival and polls (~45s, paused while hidden). Keeps
  the channel alive/shared and **keeps the free project from pausing**.
- **News:** `news_tick()` (~20 min) emits an event to `world_news` (from your
  admin-edited `NEWS_EVENTS` if present, else a built-in set). `WorldFeed` applies
  each event's market effect with the **same start time + duration on every client**
  → the market reacts identically galaxy-wide; the local news generator is switched
  off (`Broadcast.disableLocalNews()`), so shared events are the single source.
- **Without cloud / without these tables**, the client falls back to:
  `Feed.prime()` (fills chat on load) and `Broadcast.backfill()` (fabricates recent
  newswire history) — so it still never looks empty, just not shared.

---

## 7. Recent fixes — DO NOT regress

- **Logout reset:** logout clears local + reloads; `Game._noSave` stops
  `beforeunload`/autosave from re-writing the old state. (`auth-ui.doSignOut`,
  `main.save`.)
- **Login no longer clobbers the cloud save:** `AuthUI.syncOnLogin` — the account's
  **cloud save always wins** if it exists; local is uploaded only when the account
  has no cloud save yet. (Previously a "newer timestamp wins" heuristic uploaded the
  fresh post-logout game over real progress, wiping credits/missions.)
- **`Cloud.signOut({scope:"local"})`** so a reload can't silently re-authenticate.
- **Exchange click handler** is assigned (`onclick =`), not `addEventListener`, so
  rebuilding on prestige can't stack duplicate handlers.

---

## 8. Known caveats / not-yet-done

- **Market isn't pixel-identical across clients.** News shocks + the time-based
  anchor are shared, but the small per-tick random noise differs per client. True
  determinism needs the market rewrite in **`docs/SERVER_AUTHORITATIVE_DESIGN.md`**
  (replace the random walk with a seeded time function). **Tabled.**
- **Anti-cheat:** the game is client-authoritative — a player can edit their own
  credits/save via console. Fine for casual play; only matters with a competitive
  global leaderboard. Full fix = the server-authoritative design (tabled).
- **Omens** are flavor-only once shared news is active (they no longer reliably
  precede a news event).
- **Sprite uploads** need the `sprites` Storage bucket (ADMIN_SETUP §3b) created.
- **No export-of-live-content-to-Git** button yet (content lives only in Supabase).
- **Free Supabase pauses after 7 days idle** — mitigated by the per-minute cron.

## 9. Suggested next steps (pick from these)
1. Deterministic/seeded market for pixel-identical, fully-reconstructable prices
   (Phase 0 of the design doc) — the natural finish to the shared world.
2. Server-authoritative trading/missions (anti-cheat) — the rest of the design doc.
3. Export-to-Git button for live content (backup/source-control).
4. Password reset + "resend confirmation" in the auth modal.
5. Re-couple omens to shared news (cron emits an omen a few minutes before a news).

---

## 10. Working with the code

- **Sanity check before committing:** `for f in js/*.js; do node --check "$f"; done`.
  There's no test suite; logic is commonly verified with small headless Node
  harnesses that stub `window`/`localStorage` and `eval` the files (see this
  session's history for the pattern). Layout/visual changes can't be verified
  headlessly — call those out for manual testing.
- **Git:** work on `main`; commits end with a session URL footer. Pushing to `main`
  is gated and asks for confirmation each time (or move to feature-branch + draft PR
  if preferred).
- **Adding content:** prefer editing `flavor.js`/`data.js` (defaults) AND/OR the
  admin CMS (live overrides). New overridable collection → add it to
  `content.js` `COLLECTIONS` and ensure it's a `window.*` global.
- **Adding a script file:** insert the `<script>` in `index.html` in dependency
  order (globals it reads must load first; it may reference others at runtime only).

---

## 11. One-paragraph status

The base game is feature-complete and balanced (market, fleet, missions, bazaar,
factions, rivals, prestige, star map, onboarding). Cloud accounts + per-user saves,
an admin role + content/image CMS, and a shared persistent world (chat + news via
Supabase Cron) are all built and working; save/logout/login bugs are fixed. The
main open frontier is making the **market itself** server-authoritative/deterministic
(design doc written, tabled). Confirm the Supabase SQL in §4 has all been applied in
the live project — that's the most likely source of "cloud not working" surprises.
