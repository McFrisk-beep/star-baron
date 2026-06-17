# Star Baron — Handoff / Context Doc

A complete orientation for picking this project up in a fresh session (the
container is cloned fresh each time — this doc + the repo are your only memory).
Read it top-to-bottom once. It captures the architecture, the gameplay systems,
the persistence/cloud model, the conventions that aren't obvious from any one
file, the recent fixes not to regress, and what's deliberately left for later.

> **Also read `CLAUDE.md` at the repo root** — it's the coding discipline
> ("ponytail": write the least code that works; deletion over addition; boring
> over clever; never cut input validation or save-data error handling). Follow it.

---

## 1. What it is

A browser-based interstellar **trading game**: read a live market, run a combat
fleet, take contracts, run automated trade routes, build offworld mining/industry,
ride faction wars, climb a rival-baron leaderboard. Pure front-end (no framework,
no build step) served as a static site, with an **optional** Supabase backend for
accounts, cloud saves, an admin content CMS, and a shared persistent world.

- **Stack:** vanilla HTML/CSS/JS. No bundler, no npm, no transpile. **Keep it
  that way** — adding tooling/a framework breaks the premise (see CLAUDE.md).
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
- **`window.*` globals** (`Game`, `Market`, `UI`, `Industries`, …), and
- top-level `const` declarations visible to later scripts via the shared global
  lexical scope (this is why `Galaxy`, `Rep`, `Extractors` resolve across files).

**Script load order in `index.html` (order matters — globals read at load must
come first; runtime-only references can come later):**
```
supabase CDN → data.js → flavor.js → cloud-config.js → store.js → cloud.js →
content.js → market.js → galaxy.js → items.js → fleet.js → economy.js →
reputation.js → rivals.js → missions.js → routes.js → incidents.js → orders.js →
extractors.js → industries.js → bazaar.js → feed.js → broadcast.js → wars.js →
worldfeed.js → ui.js → auth-ui.js → admin-ui.js → planetview.js → starmap.js →
main.js
```
(`extractors.js` before `industries.js`; `planetview.js` before `starmap.js`;
`wars.js` after `broadcast.js` because `Wars.start` uses `Broadcast.announce`.)

### Decoupling
- **`Bus`** (in `store.js`) is a tiny pub/sub (`Bus.on/emit`). Events include:
  `chat`, `news`, `trade`, `dock`, `travelStart`, `missionDone`, `rep`,
  `prestige`, `achievement`, `localEvent`, `auth`, `order`, `war`,
  `industryLost`, `listingSold`, `shipBuy`.
- **`Util`** (in `store.js`): `randInt`, `randFloat`, `pick`, `clamp`, `gauss`,
  `credits` (compact 1.2K/3.4M), `creditsFull` (exact, grouped — HUD), `price`,
  `ago`, `duration`.

### Content is data, not code
Game content lives in `data.js` (config/economy) and `flavor.js` (text pools).
Both export everything to `window`; the engine reads them at runtime, so they can
be **overridden live** (see §6 Content CMS).

### Module map
| File | Responsibility |
|---|---|
| `data.js` | Static config: `CONFIG`, `COMMODITIES`, `SYSTEMS`, `SHIP_CATALOG`/`ALL_SHIPS`, `RARITIES`, `DANGER`, `FACTIONS`, `CATEGORY_FACTION`, `REP`, `PRESTIGE`, `GALAXY`, plus the system configs: `BAZAARCFG`, `ROUTECFG`, `INCIDENTCFG`, `WARCFG`, `INDUSTRYCFG`, `EXTRACTORCFG`, `COMPONENTCFG`, `PLANET_SUITABILITY`, `RIVALCFG`. **Tune the whole game here.** |
| `flavor.js` | All text pools: chat, omens, news events, NPCs, TV, local feeds, ship radio, rival barbs, tutorial steps, naming pools, contract templates, planet lore. |
| `store.js` | `Store` (local-first persistence + cloud sync), `Util`, `Bus`. |
| `cloud.js` | `Cloud` — the ONLY Supabase wrapper: auth, roles, per-user `saves` row. |
| `content.js` | `Content` — admin overrides overlaid on the in-memory collections at boot. |
| `market.js` | `Market` — price sim (random walk + mean reversion + news/local effects + category drift), offline `advance`, sparkline history, sentiment. |
| `galaxy.js` | `Galaxy` — deterministic procedural galaxy (sectors/systems/planets, each planet has a `type`/`cat`/`commodity`), local news log + mechanical local events. |
| `economy.js` | `Economy` — credits, buy/sell, timed docking/travel, net worth, achievements, prestige (resets routes/orders/industries/extractors/components too). |
| `fleet.js` | `Fleet` — owned ships, stats, flagship, equip, mercenaries (`pruneMercs` returns expired), power/cargo, dock travel time. |
| `items.js` | `Items` — procedural accessories (rarity/naming/value). |
| `missions.js` | `Missions` — contract missions: phases, success roll, payouts/losses, time-based resolve. |
| `reputation.js` | `Rep` — faction standing, price edges, discounts, gated jobs. |
| `rivals.js` | `Rivals` — AI baron leaderboard (drifting net worth) + taunts. |
| `routes.js` | `Routes` — automated trade routes (see §3). |
| `incidents.js` | `Incidents` + the `INCIDENTS` pool — choice-driven encounters (see §3). |
| `orders.js` | `Orders` — standing buy/sell orders + price alerts (see §3). |
| `wars.js` | `Wars` — periodic faction wars + market shocks (see §3). |
| `extractors.js` | `Extractors` + `Components` — mining machines & their upgrades (see §3). |
| `industries.js` | `Industries` — offworld manufacturing on star-map planets (see §3). |
| `bazaar.js` | `Bazaar` — shop board (ships/mercs/contracts/accessories/**extractors/components**), ship resale, churn. Retains a save-compat shim for retired item "listings" — **don't delete it** (it pays out / prevents stranded gear in old saves). |
| `feed.js` | `Feed` — live trader chat scheduler, token templating, omens, `prime()`. |
| `broadcast.js` | `Broadcast` — TV rotation + news→market pipeline + newswire + `backfill()` + `disableLocalNews()`. |
| `worldfeed.js` | `WorldFeed` — reads the **shared** Supabase world (chat + news). |
| `ui.js` | `UI` — all DOM rendering (tabbed pages, sidebar, modals incl. **While You Were Away**), toasts. Largest file. |
| `auth-ui.js` | `AuthUI` — account button + register/login modal + login save-sync. |
| `admin-ui.js` | `AdminUI` — admin gate, content/image CMS, and the **🧪 Dev view** (fast-news/fast-time toggles + a credits cheat — admin-only; moved out of Settings). |
| `planetview.js` | `PlanetView` — the planet popup: animated canvas planet, **About** lore tab, **Industries** tab (permit/extractor/component UI). |
| `starmap.js` | `StarMap` — galaxy SVG view + animated canvas system view; planet rows open `PlanetView`. |
| `main.js` | `Game` — boot, single in-memory `state`, the loop, schedulers, suspend/resume, offline catch-up, `awayRecap`, save. |

### State & the game loop
- `Game.state` is the single source of truth. `Game.defaultState()` / `Game.migrate()`
  define and **backfill** its shape (migrate adds any missing keys so old saves
  survive — keep new top-level keys defaulted in both).
- `Game.loop()` runs every `CONFIG.marketTickMs` (2000ms) while visible and ticks:
  `Market.tick`, `Wars.tick`, `Economy.checkArrival`, `Missions.resolveMatured`,
  `Fleet.pruneMercs`, `Rivals.tick`, `Routes.resolve`, `Orders.process`,
  `Industries.resolve`.
- **Offline catch-up** (in `init()`) and **`resume()`** run the *same* resolvers
  against real elapsed time, so the world keeps running while you're away. The
  time-driven resolvers (routes/orders/industries/missions) use **absolute
  timestamps**, so they bank everything up to their own per-resolve caps; only
  `Market.advance` is bounded by `CONFIG.maxOfflineMs` (7 days) / 600 ticks.

### Lifecycle: suspend when hidden
When the tab is hidden, `Game.suspend()` saves, flushes to cloud, and stops **all**
timers + the star-map animation + the world-feed poller (idle tab ≈ free CPU). On
return, `Game.resume()` fast-forwards the sim then restarts everything.

---

## 3. Gameplay systems (the layered features beyond the trading core)

The base loop is: buy low / sell high across systems, run a fleet on Bazaar
contracts, bank reputation with four factions, climb the rival leaderboard,
prestige. On top of that:

- **Trade routes (`routes.js`, `ROUTECFG`).** Assign idle ship(s) to ferry a
  commodity from a cheap system to a dear one; pooled cargo across multiple ships;
  it banks `margin × spread × cargo` per round trip while you're away. Transit is
  **speed-scaled and deliberately long** (~10–15 min near, more far —
  `legSecondsPerDist`). `maxCyclesPerResolve` caps offline windfalls.
- **Incidents (`incidents.js`, `INCIDENTCFG`).** Random choice-driven pop-ups
  during **active play only** (the timer is torn down while hidden, so they never
  fire on idle). Pool is `INCIDENTS` in `incidents.js`.
- **Standing orders & price alerts (`orders.js`).** Queue a buy/sell at a target
  price; `Orders.process()` fills it when the market crosses (works offline).
- **Faction wars (`wars.js`, `WARCFG`).** Periodically two rival factions clash:
  the aggressor's domain category **spikes**, the defender's **slumps**, a klaxon
  headline hits the newswire, and war-effort contracts pay a bonus. One war at a
  time; the victor is currently a coin flip (flavor + market, not player-swayed).
- **Offworld Industries / mining (`industries.js` + `extractors.js` +
  `planetview.js`).** The biggest recent system. Flow:
  1. **Permit** — on a star-map planet (open it from the Star Map → planet popup →
     Industries tab). Navos / **core sector is neutral** (free permit, low flat
     tax); elsewhere the commodity's controlling faction (`CATEGORY_FACTION`) owns
     the planet — standing gates the permit and sets its price/tax.
  2. **Install an extractor** (bought in **Bazaar → Extractors**). Three types
     (`EXTRACTORCFG.types`): **specialized** (one commodity, ×1.5), **semi** (a
     whole category, ×1.0), **jack** (anything, ×0.6). On install you pick *what*
     to produce within the extractor's scope.
  3. **Fit components** (Bazaar → Components; rarity-tiered, 2 slots/extractor):
     "Yield Booster" raises output, "Cycle Optimizer" shortens the cycle.
  4. **Produce.** Slow **~12h taxed batches** drop into your tradeable stock
     (`state.positions`). Yield/tax/cycle math is the single `Industries._yield()`
     helper (shared by the display `batch()` and the production `resolve()` — keep
     it single-source). Rule: `gross = round(baseYield × suitability × extractor
     tier × component rate × prodMult)`, `tax = ceil(gross × rate)`,
     `net = max(1, gross − tax)`.
  - **Suitability** = `PLANET_SUITABILITY[planetType][commodityCategory]`
    (lava→minerals, gas giants→gas, toxic→illicit, …).
  - **Faction licensing:** positive standing lowers permit price + tax; negative
    standing raises tax; **at/below −40 the faction seizes the structure**
    (`destroyRep`; "at risk" warning from `atRiskRep` −25). War boom ×2 if the
    commodity is a war's hot side; local strike / war slump → 0 that cycle.
  - All mining state is in `state.industries` / `state.extractors` /
    `state.components` (+ `bazaar.extractors`/`bazaar.components`), so it's covered
    by save/migrate/prestige and cloud sync like everything else.

**Welcome-back recap (`Game.awayRecap` + `UI.showWYWA`).** After an absence the
"While You Were Away" modal summarizes net worth then→now, an ongoing/ended war,
seized industries, mercenaries stood down, the biggest market swings (±4%), and
the income lines (contracts/routes/orders/industry output/sales). It snapshots
"when you left" before the offline catch-up and diffs after. (Note: only shown on
cold boot, not on tab-resume — that's a deliberate, easy-to-change choice.)

---

## 4. Persistence model (local-first)

All saves go through **`Store`** (`store.js`). Nothing else touches storage.
- `Store.save()` writes `localStorage` **immediately**, and (if signed in) pushes
  to the cloud on a ~20s debounce. `Store.flush()` pushes now (logout/suspend).
- `Store.load()` prefers the **cloud** copy when signed in, caches it locally,
  falls back to local otherwise.
- The whole `Game.state` blob is what's saved/synced — so any new feature's data
  is covered automatically *as long as it lives in `state`* and is defaulted in
  `defaultState`/`migrate`.
- **`Game._noSave` guard:** during logout/login we set `Game._noSave = true` so
  `beforeunload`/autosave can't re-persist stale state right before a reload.
  (This fixed logout-not-resetting — don't remove it.)

---

## 5. Cloud / Supabase (optional backend)

Configured in **`js/cloud-config.js`** (`window.CLOUD = { url, anonKey }`). The
anon key is **public by design**; security is RLS, never hiding it. Leave blank →
fully local/guest. **Currently configured** (live project `okqopvfxsexuoxlsnxtc`).

| Table / object | Purpose | RLS |
|---|---|---|
| `saves` | one JSONB save row per user | read/write own only |
| `profiles` | `role` per user (`player`/`admin`) | read own; **no client write** |
| `content` | admin content overrides | public read, **admin write** |
| `world_feed` | shared ambient chat (cron-written) | public read, function-only write |
| `world_news` | shared galactic news (cron-written) | public read, function-only write |
| Storage `sprites` | admin sprite overrides | public read, admin write |
| cron `world-tick` / `news-tick` | append shared chat / emit shared news | — |

Setup SQL (run in order added): **`docs/CLOUD_SETUP.md`** (auth + `saves`),
**`docs/ADMIN_SETUP.md`** (`profiles` + trigger, `content`, `sprites` bucket,
granting admin), **`docs/WORLD_CRON_SETUP.md`** (`pg_cron` + world_feed/news).

⚠️ **Verify which SQL is actually applied** (state is uncertain across sessions):
```sql
select to_regclass('public.saves'), to_regclass('public.profiles'),
       to_regclass('public.content'), to_regclass('public.world_feed'),
       to_regclass('public.world_news');
select * from cron.job;                          -- world-tick / news-tick present?
```
Console on load shows `[Cloud] online accounts enabled`, `[Store] loaded cloud
save`, `[WorldFeed] ... live`. A "Cloud sync isn't working — has the 'saves'
table been created?" toast means `saves` is missing.

---

## 6. Admin & content CMS

- **Roles:** `Cloud.isAdmin()` reads `profiles.role` (server-side). Players never
  see the **🧪 Dev** toggles or **🛠 Admin** button. Client checks are cosmetic —
  real enforcement is RLS.
- **Content editor (`admin-ui.js`):** edits the collections in `content.js`
  `COLLECTIONS`, auto-picking a widget by shape (table / line list / grouped
  lists), with a Raw JSON toggle. `content.js` loads overrides at boot and
  **mutates the in-memory globals in place** (flavor edits live; rule edits on
  reload). Malformed overrides are ignored (defaults win) → a bad edit can't
  brick the game. `Content.rederive()` rebuilds `ALL_SHIPS` after ship edits.
- **Images:** `🖼 Images` → upload to the `sprites` bucket; `ASSET_OVERRIDES`
  redirects `ASSET.*` to the uploaded URL.
- **Edits live in Supabase, not Git** (that's what makes them server-wide).

---

## 7. Shared persistent world (Supabase Cron)

- **Chat:** `world_tick()` (per minute) appends to `world_feed`; `WorldFeed` polls
  (~45s, paused while hidden). Also keeps the free project from auto-pausing.
- **News:** `news_tick()` (~20 min) emits to `world_news`; `WorldFeed` applies each
  event's market effect with the **same start+duration on every client** → markets
  react identically galaxy-wide; the local news generator is switched off
  (`Broadcast.disableLocalNews()`).
- **Without cloud/tables**, the client falls back to `Feed.prime()` +
  `Broadcast.backfill()` so it never looks empty (just not shared).

---

## 8. Recent fixes — DO NOT regress

- **Logout reset / login no longer clobbers cloud:** `AuthUI` + `Game._noSave`.
  The account's **cloud save always wins** on login if it exists; local is
  uploaded only when the account has no cloud save yet. `Cloud.signOut({scope:
  "local"})` so a reload can't silently re-auth.
- **Industries `_yield()` is the single source** for the yield/tax/cycle math
  (display `batch()` and production `resolve()` must not drift apart).
- **Planet popup z-index / Escape:** modal is `z-index:80` (above the star map);
  Escape closes the popup first (the star-map Escape handler skips while it's open).
- **Removed a dead `UI.refreshDispatch()`** call in the star-map unlock handler
  (it threw and broke the post-unlock save+refresh).
- **`PLANET_PAL.barren`** palette was malformed (`.slice(0,7)` map) — fixed.

---

## 9. Known caveats / deliberate ponytail shortcuts

- **Market isn't pixel-identical across clients** — shared news + the time anchor
  are shared, but per-tick noise differs. True determinism needs the seeded-market
  rewrite in **`docs/SERVER_AUTHORITATIVE_DESIGN.md`**. Tabled.
- **Client-authoritative** — a player can edit their own save via console. Fine
  for casual play; only matters with a competitive global leaderboard.
- **Industries balance is unplaytested** — `baseYield` 50, extractor tiers
  0.6–1.5, component strengths, 12h cadence, and faction tax/permit numbers are
  all in `data.js` (`INDUSTRYCFG`/`EXTRACTORCFG`/`COMPONENTCFG`). Expect a tuning
  pass after playtest.
- **WYWA market-swings** reflect the **capped** catch-up window (≤600 ticks), so
  after a very long absence they show where prices *settled*, not a multi-day swing.
- **WYWA shows on cold boot only**, not on tab-resume. Wars only *start* during
  active play; their victor is a coin flip. Mining batches that land *while you're
  actively watching* aren't toasted (you just see stock tick up).
- **Omens** are flavor-only once shared news is active. **Sprite uploads** need the
  `sprites` bucket. **No export-of-live-content-to-Git** yet. **Free Supabase
  pauses after 7 days idle** (mitigated by the per-minute cron).

---

## 10. Suggested next steps (pick from these)

1. **Industries balance pass** after playtest (all knobs in `data.js`).
2. Deterministic/seeded market (Phase 0 of the design doc) — the natural finish to
   the shared world; also unlocks anti-cheat.
3. Server-authoritative trading/missions (rest of the design doc).
4. Small polish: toast when a mining batch lands during active play; show the WYWA
   recap on long tab-resumes too; let players "pick a side" to sway a war.
5. Export-to-Git for live content; password reset / resend-confirmation in auth.

---

## 11. Working with the code

- **Git workflow (solo dev): commit and push straight to `main`.** No feature
  branches, no PRs (the owner directed this — "just push everything to main since
  there's no other developers"). The container is ephemeral and cloned fresh each
  session, so **commit + push anything worth keeping.** End commit messages with
  the Claude Code session footer your harness provides. **Never** put your model
  identifier in commits, PR bodies, code comments, or any pushed artifact — chat
  only.
- **GitHub** is reachable only via the `mcp__github__*` tools (scoped to
  `mcfrisk-beep/star-baron`); there's no `gh` CLI.
- **Sanity check before committing:** `for f in js/*.js; do node --check "$f"; done`.
  There's **no test suite** (and don't add a framework — static-site premise). For
  non-trivial logic, verify with a small **headless Node harness**: create a `vm`
  context, set `sandbox.window = sandbox`, stub the deps you don't exercise
  (`Galaxy`, `Rep`, `Market`, `Economy`, `matchMedia`, `localStorage`, …), then
  `vm.runInContext` the real files **into one shared context** (so cross-file
  `const`s resolve like the browser), and assert via the `window.*` exports. See
  `/tmp/verify_mining.js` / `/tmp/verify_wywa.js` patterns in this session's
  history. Gotcha: in Node, a bare top-level `const X` is *not* a cross-file
  global the way it is in the browser — load everything in ONE `vm` context (or
  read from `window.X`), don't `require()` files separately.
- **Layout/visual/animation changes can't be verified headlessly** — call those
  out for manual testing.
- **Follow `CLAUDE.md` (ponytail):** YAGNI, reuse existing code, prefer native
  HTML/CSS, shortest diff; mark deliberate shortcuts with `// ponytail:` comments.
- **Adding content:** edit `flavor.js`/`data.js` defaults and/or the admin CMS.
  New overridable collection → add to `content.js` `COLLECTIONS` + a `window.*`
  global.
- **Adding a script file:** insert its `<script>` in `index.html` in dependency
  order. **New `state` field:** default it in BOTH `defaultState()` and `migrate()`
  (and reset it in `Economy.prestige` if appropriate).

---

## 12. One-paragraph status

The trading core is feature-complete (market, fleet, missions, bazaar, factions,
rivals, prestige, star map, onboarding) and has since grown a full layer of
endgame systems: automated trade routes, choice-driven incidents, standing
orders/price alerts, faction wars, and a deep **offworld Industries/mining**
chain (permits → extractors → rarity-tiered components → 12h taxed batches, with
faction licensing and seizure). Accounts + per-user cloud saves, an admin
role + content/image CMS, and a shared persistent world (chat + news via Supabase
Cron) are built and working; save/login/logout are solid and the offline
catch-up + welcome-back recap cover every system. The biggest open work is an
**Industries balance pass** (after playtest) and, longer-term, the
**server-authoritative/deterministic market** (design doc written, tabled).
Verify the Supabase SQL in §5 is fully applied — that's the usual "cloud not
working" surprise.
