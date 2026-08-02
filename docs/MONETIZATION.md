# Monetization — options, fit, and a recommended path

A design/business note, not a spec. Nothing here is implemented. It exists so the
first real money decision is made deliberately instead of by whatever was easiest
to bolt on.

## 0. The uncomfortable part first

For a browser idle game, **revenue is traffic × conversion, and traffic is the
hard term by two orders of magnitude.** A brilliant monetization model at 200 DAU
earns roughly nothing; a mediocre one at 50k DAU pays rent. Every model below is
downstream of distribution.

Practical consequence: don't build a store, a hard currency, and a season pass
before there is an audience to sell to. The cheapest models to *build* (portal
revshare, one-time unlock) are also the right ones to build *first*, because they
don't need scale to be worth the effort.

## 1. What the game already has that is monetizable

This is the useful part — the hooks exist, they just aren't wired to a wallet.

| Existing system | Where | Natural SKU |
|---|---|---|
| Blackbox / blueprint restock, 24h | `data.js` CRAFTCFG, `bazaar.js:79` | timer skip / extra daily roll |
| Shipyard reroll, 5 min | `bazaar.js` | instant reroll |
| Survey cooldown, 30 min per system | `expeditions.js:33`, `EXPEDCFG.cooldownMs` | cooldown skip |
| Offline catch-up cap | `CONFIG` in `data.js` | longer away-window |
| Mission / travel / repair timers | `missions.js`, `fleet.js` | speed-up |
| Baron Board `title` column | `barons.js`, `docs/sql/baron_board.sql` | **custom titles / flair — the column already exists** |
| AI rival barons are pure data | `rivals.js` | patron tier: your baron becomes an NPC rival in everyone's galaxy |
| Cyberpunk asset pack + one big CSS file | `css/style.css`, `Cyberpunk_UI_Asset_Pack_v1.3/` | UI themes (cheap: a body class, same pattern as `lang-jp`) |
| Sprite manifest + admin image CMS | `sprite-manifest.js`, `admin-ui.js` | ship skins / hull paint with no engine work |
| Named ship refits | `bazaar.js` | vanity ship naming |
| Walkable station hub + full decor editor | `hub.js`, `hubedit.js`, `HUB_ROOMS` | **player-owned stations — see §2H; admin-only today** |
| Senate, ballots, shared cron world | `senate.js`, `senateworld.js` | this is already a **season engine** |
| Supabase accounts + RLS | `cloud.js`, `docs/CLOUD_SETUP.md` | entitlements table, extra save slots |

The Senate + shared news cron is the single most undervalued asset here. Seasonal
content is the highest-revenue live model in this genre, and the plumbing exists.

## 2. Models, ranked by fit

### A. Portal distribution + revshare — *do this first*
Ship to CrazyGames / Poki / Armor Games / itch. They pay a share of ad revenue per
playtime, handle the ads, and — the actual point — **bring traffic you cannot buy**.
Zero payment infrastructure, zero store cut, and it doubles as free playtest data.

- Effort: low (site is already static and `file://`-safe; portals mostly want a
  zip and an SDK shim).
- Ceiling: modest per-play, but it's the only option that fixes the traffic term.
- Risk: portal SDKs want ad breaks — keep them at natural pauses (sector travel,
  post-mission debrief), never mid-trade.

### B. One-time supporter unlock — *the best first paid SKU*
A single "Charter" / "Founder's Edition" purchase, ~$12–15. No churn management, no
subscription support burden, no expectation of monthly content.

Contents (deliberately zero economy power — see §3):
- All UI themes + ship skins + portrait set
- Custom Baron Board title and handle colour
- Extra cloud save slots
- Loadout presets, bulk-trade UI, longer chat/newswire history
- Supporter mark on the leaderboard

- Effort: low-medium (payment + entitlement, §4).
- Conversion on a web idle game: realistically 0.5–2% of registered accounts.

### C. Subscription "Trade Charter" — ~$4.99/mo, $39/yr
Same contents as B plus a monthly cosmetic drop and QoL. Better lifetime value per
payer, worse conversion, and it obligates you to a content cadence forever. Only
worth it once the Senate season loop is running on rails.

### D. Free-to-play hard currency ("Vault Chits")
Buy chits, spend on: shipyard rerolls, survey cooldown skips, extra blackbox roll,
mission speed-ups, offline-window extension. This is where the money actually is in
idle games — and where the design risk is highest, because every one of those is a
*power* purchase against a shared leaderboard.

If you go here: gate it behind an explicit ranked/unranked split (see §3), cap
daily purchasable skips, and never sell the thing that breaks the arbitrage skill
loop (per-trade cap, market depth, price edges).

### E. Rewarded video — the F2P earner
Optional, opt-in only: watch an ad to double one offline catch-up, reroll the
shipyard once, or clear one survey cooldown. Cap at ~3/day. Pairs naturally with D
as the free path to the same rewards, which is also the fairness argument.

### F. Steam premium SKU — the realistic "makes actual money" option
Wrap the static site (Tauri is lightest; Electron/NW.js work) and sell at $9.99–14.99
as a **complete premium game with no IAP**. Steam takes 30% but provides discovery
that no web portal matches, and this genre sells well there. Do it as a separate
SKU: Steam audiences punish F2P monetization inside a paid game, hard.

### G. Patron tier — cheap, high-affinity, low volume
~$49 one-time: your name and a taunt line become one of the AI rival barons in every
player's galaxy (`rivals.js` is data), or you name a system / commodity / NPC. Costs
almost nothing to implement, delights the people who care most, will never be a
revenue pillar. Cap the count so it stays meaningful.

### H. **A player-owned space station — the strongest cosmetic vehicle here**

Called out separately because it isn't a sixth option competing with the others;
it's the *container* that makes the cosmetic line in B and C worth buying at all.

**The hard part is already built, and it's admin-only.** `hub.js` is a walkable
station: canvas tilemap, ASCII room grids in `HUB_ROOMS`, doors between rooms,
props you walk up to that open the real feature panels via `UI.showPage()`.
`hubedit.js` is a full visual editor on top of it — floor/wall/door painting,
non-rectangular rooms, room add/rename/resize, per-room backgrounds, and a decor
system with drag, resize, free or snapped placement, solidity, and z-layering.
That is a station-decorating game. It ships today. The only reason players can't
use it is that it's gated to admins and writes one global map to the `content`
table.

**The gap is scoping, not rendering.**

- Per-player station data — a `stations` table (`user_id` PK, RLS: read any,
  write own) instead of the admin `content` override. A room grid plus a `deco`
  array is a few KB; storage is a non-issue.
- A restricted brush set for players — decor placement and backgrounds yes, wall
  painting probably yes, prop placement no (props are the nav registry; letting
  players delete their own Exchange is a support ticket).
- A decor catalog with entitlement or credit gates, instead of the free-for-all
  sprite palette admins get.

**Why this specifically, and not more ship skins.** Cosmetics only convert when
they are *seen*. Ship skins in this game are a few pixels drifting across the star
map — nobody, including the owner, really looks at them. A station is a room you
stand in every session, and the hub is already the default landing page. Add
read-only visiting (walk another baron's station from the Baron Board — the board
already has the identity and the ranking) and cosmetics go from "1% of players buy
a thing nobody sees" to the anchor of the whole line. That single feature is worth
more than the entire skin catalog.

**It's also a display case for progression, which is what idle players actually
pay for.** Everything the game already tracks has an obvious physical form: a
trophy wall for `achievements`, your Baron Board title on a plaque, mounted models
of hulls you've owned, faction banners that reflect standing, a case for legendary
accessories. None of it needs new systems — it's a read of state you already keep,
rendered as decor. This is the cheapest possible content pipeline: art drops into
`assets/hub/<id>.png` and the admin Images CMS already uploads it.

**Keep it cosmetic.** Station *upgrades* are the obvious next thought — extra
storage, module slots, docking fees from NPCs, passive income — and that's where it
turns into a power purchase against the shared Baron Board (§3), on top of directly
competing with industries/extractors, which already occupy the passive-income slot.
If station power ever ships it should be credits-only and server-authoritative.
Decoration is the part that's free, safe, and already written.

**Watch out for:** moderation once stations are visitable — a fixed decor catalog
is safe, free text is not (the `username.js` blocklist is the existing precedent);
and the fact that there are four rooms today, so a catalog needs enough art to make
customization feel like a choice rather than a menu.

## 3. What not to sell

- **Nothing that moves you up the Baron Board.** `barons.js` publishes a
  UTC-day-frozen net worth to a shared human leaderboard. Selling credits, price
  edges, trade-cap increases, or Baron Tiers turns that board into a spend ranking
  and kills the reason to climb it. If hard currency ever ships, add a `ranked`
  flag and exclude boosted accounts, or run a separate seasonal board.
- **Blackboxes for real money.** The game has literal randomized loot boxes
  (`data.js` `bb_*` recipes). Sold for cash they are a regulated product — banned
  outright in Belgium and the Netherlands, odds-disclosure required by the app
  stores and several jurisdictions, and an active legislative target elsewhere.
  Keep them purchasable with in-game credits only. That single rule avoids the
  entire problem.
- **The offline catch-up, past a point.** It's the core promise of the genre
  ("alt-tab for 90 seconds"). Selling too much of it sells the game back to itself.
- **Pay-to-skip the tutorial / early game.** New-player conversion is worth more
  than the sale.

## 4. Implementation notes specific to this repo

- **Entitlements must be server-side, no exceptions.** The client is readable JS on
  a static host and the save is `localStorage`. Add an `entitlements` table in
  Supabase with RLS: *read own row, no client writes at all*. Only a Stripe/
  LemonSqueezy webhook hitting an edge function (service role) may write it. Same
  posture as roles in `docs/ADMIN_SETUP.md`, which already does exactly this.
- **Anything sold as power routes through the authoritative path** —
  `Economy.authoritative()` and the Cloud RPCs, like credits and prestige already
  do. A purchased boost applied client-side is a boost anyone can grant themselves,
  which devalues the purchase for the people who paid.
- **Payment provider:** prefer a merchant of record (LemonSqueezy / Paddle) over raw
  Stripe. They handle EU VAT and US sales tax registration, which for a solo dev is
  the difference between shipping and not.
- **Cosmetics are nearly free here.** Themes = CSS custom properties plus a body
  class, mirroring the existing `lang-jp` swap in `i18n.js`. Skins = the sprite
  manifest and the admin image pipeline that already exist. Titles = a column that
  already exists on `baron_board`.
- **Accounts are already GDPR-relevant** (email + save data). Adding payment adds
  refund policy, receipts, and — if minors can buy — parental-consent handling.
  Budget a day for the legal boilerplate, not an afternoon.

## 5. Recommended path

1. **Now:** ship to itch + CrazyGames/Poki. Fix the traffic term. Measure D1/D7
   retention before selling anything — if D7 is under ~10%, monetization is not the
   problem to solve.
2. **Then:** one-time Charter unlock, cosmetics + QoL only, via LemonSqueezy →
   Supabase entitlement. Low risk, tests willingness to pay, no live-ops debt.
   The cosmetics worth putting in it are **station decor (§2H)**, not ship skins —
   scope `hubedit.js` to a per-player station first and the unlock has something
   to sell that players will actually look at.
3. **If retention holds:** rewarded video for the free tier, capped, opt-in.
4. **If there's a real audience:** Senate seasons with a free/premium track — the
   engine is already there.
5. **In parallel, independent of all of the above:** a Steam premium SKU. Different
   audience, different money, and the one path where a game like this has
   historically paid a salary.

Hard currency (D) is deliberately last. It's the biggest earner and the biggest
design liability, and it's the one decision that's genuinely hard to walk back.
