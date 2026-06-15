# Star Baron

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
- **The Fleet** — buy cheap in one system, dispatch a ship, sell dear in
  another. Real-time ETAs, **offline catch-up** ("While You Were Away" payout),
  bigger/faster ships, and gated systems to unlock.
- **The Alien Chat Feed** — templated banter that references the *current*
  market, recurring named NPCs, a feed that **reacts to your trades**, and the
  differentiator: **omens** — rare tip lines that precede a real news event
  (some are scams planted by a con-NPC). Reading the feed is an edge.
- **Broadcast & News** — Alien TV between bulletins; **news events that actually
  move the market**, with a klaxon, a scrolling ticker, and the GBN Newswire log.
- **Progression** — credits, ship tiers, system unlocks, achievements, a market
  sentiment gauge, a galactic clock, and **prestige** ("Retire Empire") for the
  long tail.
- **Star Map** — a navigable galaxy of **6 sectors × ~9–18 systems** (~80 total,
  procedurally generated from a fixed seed = the same universe every load). Every
  node is anchored to the galactic market and pulses green/red with its local
  prices. Click a system for a big animated scene — a star, orbiting planets, a
  space station, and tiny race-varied ships — plus planet industries, what each
  planet imports, and a **local news feed**. Most local news is flavor, but
  **local events** (riots halting an export, a fresh seam, a customs lockdown)
  actually move that system's prices — "valuable insight" for whoever's reading.
  Trading/fleet stay on the curated unlockable capitals (one per sector).
- **Quality floor** — responsive to phone width, keyboard focus, missing-art
  fallbacks (tinted boxes), `prefers-reduced-motion` support, opt-in audio, and
  a settings panel (reset save, mute, reduced motion, dev speed/news toggles).

## Project layout

```
star-baron/
├── index.html            # loads scripts in order (no bundler)
├── css/style.css         # terminal/space theme, responsive, reduced-motion
├── js/
│   ├── data.js           # economy config — DATA, not logic
│   ├── flavor.js         # chat/news/TV/NPC content — grow this freely
│   ├── store.js          # the ONLY storage layer (localStorage) + Util + Bus
│   ├── market.js         # price simulation, news modifiers, mean reversion
│   ├── fleet.js          # ships, runs, ETA, offline catch-up
│   ├── economy.js        # credits, trades, purchases, achievements, prestige
│   ├── feed.js           # chat scheduler, templating, reactions, omens
│   ├── broadcast.js      # TV rotation + news→price pipeline + newswire
│   ├── galaxy.js         # procedural galaxy (sectors/systems) + local events
│   ├── ui.js             # main-screen DOM rendering
│   ├── starmap.js        # galaxy view + animated system view (canvas)
│   └── main.js           # bootstrap, game loop, schedulers, save
├── assets/               # placeholder PNGs (swap freely, keep filenames)
├── docs/GRAPHICS_SPEC.md # art drop-in guide: sizes, paths, races, how to add
└── tools/gen_placeholders.py   # regenerate placeholder art (pip install pillow)
```

See **`docs/GRAPHICS_SPEC.md`** to drop in your own PNGs (planets, race ships,
stations, nebulae, asteroids, stars) — same filename in, real art out, no code.

## Design notes

- **Persistence** is hidden behind `Store` (localStorage in Phase 1). Phase 2
  swaps it for a backend without touching game logic — the market/fleet
  resolution functions are kept pure and portable for that move.
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

Built per the Star Baron design brief. Working title; art is placeholder.
