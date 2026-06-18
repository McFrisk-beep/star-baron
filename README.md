# Cosmocrat

A browser-based, idle-friendly **interstellar trading game**. Read the live
*Galactic Exchange* better than the crowd, run a *cargo fleet* that works while
you're away, and soak in a constant stream of alien chatter, tabloid news, and
trashy alien TV. Built for the "alt-tab for 90 seconds, come back later" play
pattern.

> **Phase 1** — a 100% static site (HTML/CSS/vanilla JS). No backend, no build
> step, no framework. Runs straight from the repo via GitHub Pages *or* by
> opening `index.html` from disk.

## Play

- **Live:** https://mcfrisk-beep.github.io/star-baron/ (once Pages is enabled)
- **Local:** just open `index.html` in a browser. No server needed — game data
  loads as plain `<script>` globals so there are no `fetch()` / CORS issues on
  `file://`.

## What's in it (Phase 1, M1–M6)

- **The Galactic Exchange** — ~12 commodities with live prices (noise + mean
  reversion + slow sector drift), sparklines, % change, held quantity and
  unrealized P&L. One-click Buy / Sell / Max / All.
- **The Fleet** — a roster of **persistent ships with combat stats** (hull,
  armor, shields, firepower) plus cargo and speed, modified by equipped
  accessories and your flagship's passive bonus. A separate **main/flagship**
  sets sector-transfer time and buffs the whole fleet. Ships fly **contract
  missions** with phased progress (outbound → on-site work → return), and on
  failure you get a report: ships lost, or impounded (pay to retrieve).
- **The Bazaar** — buy transports & permanent **escort warships**, upgrade your
  flagship, **hire time-limited mercenaries**, work a live **contract board**
  (jobs + insider tips; listings expire or get taken by NPCs), and trade a
  **procedural accessory market** (thousands of varied names/stats, rarity tiers
  up to legendary). Plus an upgradable **inventory** — sell items now, or list
  them and wait for an NPC buyer (cancellable).
- **Timed docking** — moving between systems takes real time, set by your
  flagship's speed; the exchange opens when you arrive. **Offline catch-up**
  resolves missions, market drift, and listing sales into a "While You Were
  Away" summary.
- **The Alien Chat Feed** — templated banter that references the *current*
  market, recurring named NPCs, a feed that **reacts to your trades**, and the
  differentiator: **omens** — rare tip lines that precede a real news event
  (some are scams planted by a con-NPC). Reading the feed is an edge.
- **Broadcast & News** — Alien TV between bulletins; **news events that actually
  move the market**, with a klaxon, a scrolling ticker, and the GBN Newswire log.
- **Faction reputation** — four factions (Syndicate, Mining Combine, Free-Trade
  League, Agri-Collective) each control commodity categories and sponsor
  contracts. Completing their jobs (and trading their goods) raises your
  standing and annoys their rival. Standing spends as **exchange price edges**,
  **bazaar discounts**, **bigger contract payouts**, and **gates the top jobs**
  (assassinations / extreme-danger work) behind being Friendly with the sponsor —
  so you pick who to serve.
- **Rival barons & leaderboard** — twelve named AI barons whose net worth
  compounds in real time. Your live net worth is slotted into the same board, so
  climbing the exchange means **climbing the ladder** — and going idle means
  sliding back as the rivals keep getting richer. Overtakes (either direction)
  fire **faction-flavored taunts and gloats** in the trader chat (softened if
  you're Allied with that rival's faction) plus a toast, and the HUD shows your
  live **Rank**. A constant rivalry to chase between milestones and prestige.
- **Progression** — credits, ship tiers, system unlocks, achievements, a market
  sentiment gauge, a galactic clock, and **prestige** ("Retire Empire") for the
  long tail.
- **Star Map** — a navigable galaxy of **6 sectors × ~9–18 systems** (~80 total,
  procedurally generated from a fixed seed = the same universe every load). Every
  node is anchored to the galactic market and pulses green/red with its local
  prices. Click a system for a big animated scene — a star, orbiting planets, a
  space station, and tiny race-varied ships that drift unhurriedly (space is
  *big*), **call out to one another** and bark "Under attack!" mid-dogfight, and
  warp in and out through a **hyperspace gate** at the system's edge — plus
  planet industries, what each planet imports, and a **local news feed**. Most
  local news is flavor, but
  **local events** (riots halting an export, a fresh seam, a customs lockdown)
  actually move that system's prices — "valuable insight" for whoever's reading.
  Trading/fleet stay on the curated unlockable capitals (one per sector).
- **Accounts & admin tools** — optional online accounts (Supabase) with two roles:
  **players** get the game (dev toggles hidden), while **admins** get an in-game
  **CMS**: a **📝 Content** editor that renders each collection with the friendliest
  widget for its shape — **tables** (commodities, ships, danger, rarities, NPCs,
  news…), **line lists** (chat), **grouped lists** (ship/rival lines), or raw JSON —
  and an **🖼 Images** gallery to upload/replace any sprite (portraits, ships,
  planets, …) to Supabase Storage. All overlaid on the built-in defaults
  (public-read / admin-write); roles are set server-side so a player can't grant
  themselves access. See `docs/ADMIN_SETUP.md`.
- **Persistent shared world** (optional, Supabase Cron) — a once-a-minute job
  appends ambient **trader chat**, and a periodic job emits **galactic news** into
  shared tables every client reads. News applies the same market effect with the
  same start time on everyone, so the market reacts identically galaxy-wide, and
  the world keeps "running" (and the free project stays awake) with nobody online.
  Missions are timestamped, so you can launch one, leave, and return to it
  completed or mid-flight depending on elapsed time. See `docs/WORLD_CRON_SETUP.md`.
- **New-player onboarding** — a skippable, eight-step **tutorial carousel** walks
  a fresh baron through the Exchange, travel, fleet, Bazaar, reading the
  feed/news, and the rival ladder. A **❔ Help** button reopens it anytime.
- **Deep flavor** — hundreds of templated trader-chat lines, recurring NPC
  personalities, omens vs. scams, market-moving news events, alien TV, per-system
  local chatter and events, and — on the Star Map — ships that hold **multi-turn
  conversations** with each other. All content lives in `flavor.js`, easy to grow.
- **Quality floor** — a fixed **app-shell layout** (the page never scrolls;
  each region — pages, the sub-tabbed Bazaar, the trader chat — scrolls on its
  own), responsive down to phone width (where it relaxes into a natural stack),
  keyboard focus, missing-art fallbacks (tinted boxes), `prefers-reduced-motion`
  support, opt-in audio, and a settings panel (reset save, mute, reduced motion,
  dev speed/news toggles).
- **Light over long sessions** — every data pool is bounded (chat 100, newswire
  30, local feeds 15/system, price history 60/commodity, market effects pruned
  each tick), so memory doesn't grow. When the tab is backgrounded the game
  **suspends all timers and the star-map animation** (after a save) and
  **fast-forwards the simulation on return**, so an open tab costs ~nothing while
  you're away.

## Project layout

```
star-baron/
├── index.html            # loads scripts in order (no bundler)
├── css/style.css         # terminal/space theme, responsive, reduced-motion
├── js/
│   ├── data.js           # economy config — DATA, not logic
│   ├── flavor.js         # chat/news/TV/NPC content — grow this freely
│   ├── store.js          # the ONLY storage layer (local-first + cloud) + Util + Bus
│   ├── cloud-config.js   # your Supabase URL + anon key (blank = local-only)
│   ├── cloud.js          # Supabase wrapper: auth + roles + per-user save row (RLS)
│   ├── content.js        # admin-editable content overrides (loaded over defaults)
│   ├── auth-ui.js        # account button + register/login modal + save sync
│   ├── admin-ui.js       # admin gate (roles) + in-game content editor
│   ├── market.js         # price simulation, news modifiers, mean reversion
│   ├── galaxy.js         # procedural galaxy (sectors/systems) + local events
│   ├── items.js          # procedural ship accessories (rarity, naming, value)
│   ├── fleet.js          # persistent ships, combat stats, flagship, equipping
│   ├── economy.js        # credits, exchange, timed docking, achievements, prestige
│   ├── reputation.js     # faction standing: edges, discounts, contract gates
│   ├── rivals.js         # AI baron leaderboard: drift, ranks, taunts/gloats
│   ├── missions.js       # contract missions: phases, success, rewards, losses
│   ├── bazaar.js         # ships/mercs/contracts/accessories market + listings
│   ├── feed.js           # chat scheduler, templating, reactions, omens
│   ├── broadcast.js      # TV rotation + news→price pipeline + newswire
│   ├── ui.js             # tabbed-page DOM rendering (exchange/fleet/bazaar/…)
│   ├── starmap.js        # galaxy view + animated system view (canvas)
│   └── main.js           # bootstrap, game loop, schedulers, save
├── assets/               # placeholder PNGs (swap freely, keep filenames)
├── docs/GRAPHICS_SPEC.md # art drop-in guide: sizes, paths, races, how to add
└── tools/gen_placeholders.py   # regenerate placeholder art (pip install pillow)
```

See **`docs/GRAPHICS_SPEC.md`** to drop in your own PNGs (planets, race ships,
stations, nebulae, asteroids, stars) — same filename in, real art out, no code.

## Design notes

- **Persistence** is hidden behind `Store` — **local-first**: every save writes
  to `localStorage` instantly, and when a player is signed in it also syncs to
  the cloud. **Optional online accounts** use Supabase (auth + a per-user save
  row guarded by Row-Level Security); leave `js/cloud-config.js` blank to stay
  fully local/offline. The rest of the game never touches storage directly. See
  **`docs/CLOUD_SETUP.md`** for the 5-minute, free setup.
- **Content is data, not code.** Add commodities/systems/ships in `data.js` and
  chat/news/NPCs/TV in `flavor.js`; the engine adapts. Templating tokens
  (`{COMM}`, `{SYS}`, `{DIR}`, `{HANDLE}`, `{PRICE}`, `{PCT}`) make a small line
  pool feel huge.
- **Tuning** lives in `CONFIG` (top of `data.js`): tick cadence, news timing,
  volatility guardrails, offline cap, prestige curve.

### Dev toggles (Settings panel)

- **Fast news (~20s)** — watch the omen → news → price pipeline without waiting.
- **Fast time (×60)** — cargo runs and news scale to seconds for testing.

## Roadmap

- **Phase 2 (shared universe):** accounts/auth, a server-authoritative market
  over WebSocket, a shared feed/news, real rivals on the leaderboard, and
  server-side saves — all behind the same `Store` interface.

Built per the Cosmocrat design brief. Art is placeholder.
