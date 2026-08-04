# Cargo, Station Bays & the Courier — design spec

Goods stop being a location-less number and become **things that sit somewhere**.
Your flagship is a capital ship with a finite hold; every station you visit keeps
a bay of your stuff; the Galactic Exchange only trades what's physically in the
bay you're standing in; and anything you can't carry yourself moves by **Courier**
— for a fee, over real time, with real risk.

Status: **built (v1).** Client ledger + Exchange bind + transfer UI + Assets tab +
Courier. Station bays ride in the save blob (§7 fallback); `public.station_inv`
is still the upgrade path if blob size bites.

---

## 1. The shape of it

Three places goods can be:

| Place | What it is | Capacity |
|---|---|---|
| **Flagship hold** | What travels with you. The old "Inventory" becomes this. | Slots from the flagship hull's new `cargo` stat (4–32) |
| **Station bay** | Per-station locker. Persists while you're away. | `STATIONCFG`-driven, base **50 slots**, upgradeable (the existing Bazaar "Inventory Bay" purchase) |
| **In transit** | A Courier manifest between two bays | — |

Two rules do most of the work:

1. **The Exchange only sees the bay.** Buying deposits into the bay of the
   station you're docked at; selling draws from that same bay. The flagship hold
   is never tradeable — it exists to *move* goods between bays.
2. **A slot is a slot.** One gear item = 1 slot. Commodities are bundled into
   **blocks** — 5,000 iron ore is one block, one slot.

That split is what turns arbitrage from a button into a trip: goods bought in
Sector A have to be *carried* to Sector B before they can be sold there.

---

## 2. Blocks

Commodity stock is stored in blocks, sized by rarity, anchored to the existing
`STOCKCFG.baseline` ladder so a block is a meaningful bite of a sector's shelf:

```js
// data.js
const BLOCKCFG = {
  byRarity: { common: 5000, uncommon: 2000, rare: 500, exotic: 100 },
};
```

- **Slots used = `ceil(qty / blockSize)`** per commodity. 5,001 iron ore is two
  slots; 300 iron ore is one.
- Partial blocks are the interesting part: carrying six commodities at 300 units
  each costs six slots, the same as 30,000 units of one. Consolidating before a
  run is a real decision, and it's free texture — no extra code.
- Gear (`state.items` accessories, extractors, components, blackboxes) is always
  1 slot per item, unchanged from today.
- `craftOnly` / exotic stock blocks the same way; it just can't be sold on the
  Exchange (existing rule).

**Tuning note, up front:** with 5,000-unit blocks a starter flagship (4 slots)
can carry ~800K credits of iron ore, which is *more* than a Baron-tier player can
buy in one trade (15K cap). That's deliberate — the friction we're adding is the
**trip and the split**, not a volume squeeze. If hauling ends up too easy, the
two knobs are `BLOCKCFG.byRarity` (smaller blocks) and the hull slot counts, in
that order. Don't reach for a m³ system; it's a second unit to balance for the
same feel.

---

## 3. Flagship cargo (the new stat)

`SHIP_CATALOG.main[]` rows currently have `travelSpeed`, `effects`, `hull`,
`price` — **no `cargo`**. Add one. Suggested slot counts, scaling with rarity and
leaning toward the industrial hulls:

| Hull | Rarity | Slots |
|---|---|---|
| Baron's Pinnace | common | 4 |
| Lane Runner | common | 5 |
| Quiet Keel | common | 6 |
| Ore Throne | common | 8 |
| Chart Crown | uncommon | 8 |
| Escort Pulpit | uncommon | 9 |
| Void Yacht | uncommon | 10 |
| Harvest Seat | uncommon | 12 |
| Lens of Sable | rare | 14 |
| Command Flagship | rare | 16 |
| Foundry Ark | rare | 20 |
| Ghost Cathedral | epic | 22 |
| Magnate Spire | epic | 24 |
| Baron Dreadnought | legendary | 30 |
| Cosmocrat Seat | legendary | 32 |

The existing flagship effect `{ type: "cargo", pct }` (Void Yacht +6%, Foundry
Ark +8%, Ghost Cathedral +8%) already flows through `Fleet.stats()` — it should
now also apply to the flagship's **own** hold, so those hulls read as haulers.
Effective slots = `floor(Fleet.stats(mainShip).cargo × (1 + cargoEffect))`.

**Downsizing is the one dangerous edge.** Swapping to a smaller flagship while
loaded must **spill into the local bay, never delete**. If the local bay is also
full, the hold goes *overfull*: you keep everything, but no new deposits are
accepted until you're back under cap. Same rule for a bay that ends up over
capacity after a migration. Losing goods is not an acceptable failure mode here
(see `CLAUDE.md` — save-data loss is where laziness stops).

---

## 4. State shape

```js
state.hold       = { blocks: { [commId]: qty }, gear: [itemUid, …] }
state.stationInv = { [systemId]: { blocks: { [commId]: qty }, gear: [itemUid, …] } }
state.shipments  = [ {
  id, from, to, items, fee, slots,
  departedAt, etaMs, riskPct, illicit: bool,
  resolved: false, outcome: null
} ]
```

### `positions` stays — as a derived total

`state.positions` is protected server-side by `app_trade` / `app_commit`, and is
read by net worth, Workshop, standing orders, Industries and the customs scan.
**Do not restructure it.** Instead:

> **Invariant:** `positions[c] == hold.blocks[c] + Σ stationInv[*].blocks[c] + Σ shipments[*].blocks[c]`

`Assets.reconcile()` recomputes `positions` from the ledger after every mutation.
On boot, if the two disagree (an old save, a server slice, a mid-flight RPC),
**trust `positions` as the total** and push the difference into the bay at
`currentSystem`. Goods can never vanish; worst case they turn up where you're
standing.

This keeps the whole Phase 3/4 server contract untouched. The *location* split is
client-side and therefore forgeable — exactly as forgeable as charters,
industries and stations already are. Location-aware SQL is a later phase, and the
invariant above is the thing that makes that migration mechanical when it comes.

### Migration

`Game.migrate()`: flat `positions` → `stationInv[currentSystem]`, blocked by the
rules in §2, `hold` empty. `state.inventory.capacity` (the old 6-slot Bazaar bay)
carries over as the **station bay** upgrade level, so nobody loses a purchase.
Over-capacity after migration is allowed (§3, overfull).

`Economy.prestige()` resets `hold`, `stationInv` and `shipments`, and deletes the
player's cloud bay rows (§7).

---

## 5. Where everything lands

Today every system mints straight into `positions`. With addresses, each one
gains a destination:

| Source | Lands in |
|---|---|
| Exchange buy | Bay at `currentSystem` |
| Exchange sell | Draws from bay at `currentSystem` **only** |
| Extractors / Industries (`industries.js`) | Bay at that planet's system |
| Station bay production & lease keep (`stations.js`) | Already parks in `pendingCargo` → becomes a bay deposit |
| Survey / expedition debriefs (`survey-story.js`) | Bay at the surveyed system — go get it |
| Mission & charter rewards (`missions.js`, `charters.js`) | Bay at the system the hulls return to |
| Workshop (`workshop.js`) | Consumes from hold + bay at your current dock; output to that bay |
| Standing orders (`orders.js`) | Bind to the system where the order was placed |
| Customs seizure (`economy.js`) | Scans the **hold** only — bay stock is safe |

That last row is the good one: contraband becomes a load-out decision. Park
illicit stock in a Free Port bay, carry it only on the run you mean to make.

Everything goes through one entry point — `Assets.deposit(systemId, kind, id, qty)`
/ `Assets.withdraw(...)` — so there's exactly one place that maintains the
invariant, and no caller needs to know the block math.

---

## 6. The transfer view (Fleet → Inventory)

Two panels side by side on desktop, **drag and drop** between them:

```
┌─ FLAGSHIP HOLD ────── 11/16 ─┐   ┌─ VESPER STATION BAY ─── 31/50 ─┐
│ [filter…] [cat ▾] [sort ▾]   │   │ [filter…] [cat ▾] [sort ▾]     │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐  │ ⇄ │ ┌────┐ ┌────┐ ┌────┐ ┌────┐    │
│ │ ⛏ │ │ ⛏ │ │ ⚙ │ │ 💎 │  │   │ │ 🌾 │ │ ⚙ │ │ 📦 │ │ 💊 │    │
│ │5.0K│ │1.2K│ │Mk3 │ │ 500│  │   │ │3.0K│ │Mk1 │ │ 800│ │ 2.0K│    │
│ └────┘ └────┘ └────┘ └────┘  │   │ └────┘ └────┘ └────┘ └────┘    │
└──────────────────────────────┘   └────────────────────────────────┘
```

- **Tiles**, not rows — same compact box treatment as today's inventory grid.
  Commodity tiles show the commodity icon, quantity, and a fill pip for a partial
  block; gear tiles keep their rarity border.
- **Drag** a tile to the other panel to transfer. Dragging a commodity tile opens
  a quantity prompt (with **All** / **One block** shortcuts); gear moves whole.
- **Capacity header per panel**, turning amber near full and red when overfull.
  A drop that won't fit is rejected before it starts (drop zone shows why).
- **Filter/sort bar per panel:** free-text name filter, category chips
  (mineral · gas · tech · agri · luxury · illicit · gear), sort by name / quantity
  / unit value / total value / slots used.
- **No station bay when undocked or in transit** — the right panel shows the
  hold only, with a "dock to access a bay" note.
- **Touch/mobile:** drag-and-drop is a desktop affordance. On narrow widths the
  panels stack and every tile gets a `⇄` move button; tap-select-then-tap-target
  also works. Keyboard: tiles are focusable, `Enter` opens the same move dialog.
  Nothing is drag-only.

The Bazaar's **Inventory Bay** upgrade stays exactly where it is and now buys
station bay slots.

---

## 7. Persistence: per-station rows, created lazily

Bays do **not** ride in the save blob. 78 stations × a bag each would bloat every
single `Store.save()` write, and the whole blob goes over the wire each time.
They get their own table, written per touched station:

```sql
create table public.station_inv (
  user_id    uuid not null references auth.users(id) on delete cascade,
  system_id  text not null,
  slots      int  not null default 0,
  value      bigint not null default 0,   -- for the Assets quick-glance
  data       jsonb not null,              -- { blocks:{…}, gear:[…] }
  updated_at timestamptz not null default now(),
  primary key (user_id, system_id)
);
alter table public.station_inv enable row level security;
create policy "own rows" on public.station_inv
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

**Egress and row-count rules:**

- **Never write an empty row.** A row exists only while that station holds
  something.
- **Emptying a bay does not delete immediately** — you're probably mid-shopping.
  Mark it pending-empty and flush the deletes as one batched
  `.delete().eq(user_id).in("system_id", […])` when you **undock** (the `dock`
  bus event fires on arrival elsewhere) or on `Store.flush()`.
- **Assets quick-glance reads the summary only:** `select system_id, slots, value,
  updated_at` — no `data` column. The jsonb is fetched for one system when the
  player expands it, and for the docked station on arrival.
- **Local-first, same as everything else.** `state.stationInv` is the working
  copy and the guest/offline store; cloud rows are the sync target. The bay
  slice is stripped from the save blob **only after** its row write succeeds — if
  the write fails it stays in the blob and retries. Never strip optimistically.

Guests (no cloud config) keep bays in `localStorage` inside the save blob, which
is fine at that size.

> If it turns out the blob would have been small enough after all, the fallback
> is to drop the table and keep `state.stationInv` in the save — one deletion,
> no migration. Worth re-checking after the first month of real saves.

---

## 8. Assets tab

New nav tile (`📦 Assets`, `data-page="assets"`, i18n `nav.assets` in EN + JA),
sitting between **Fleet** and **Star Map**.

**Level 1 — quick glance.** One row per system where you hold anything:

```
📦 ASSETS                                    12 systems · 74 slots · 8.4M cr
────────────────────────────────────────────────────────────────────────────
▸ Vesper Station        core    18 slots   2.1M cr   ● you are here
▸ Kel Drift             belt    12 slots   1.4M cr
▸ Ordo Prime            forge    9 slots   890K cr   ⏳ inbound manifest 14m
▸ Hollow Reach          tide     4 slots   210K cr   ⚠ illicit
```

Value is at that system's local spot price, so "rich but stranded" is visible.
Sorted by value by default; sortable by slots, name, sector, distance.

**Level 2 — breakdown.** Clicking a row expands it (fetching that system's jsonb
on demand) into the same compact tiles as §6, plus per-item local value, best
known price elsewhere, and an **Add to manifest** button.

---

## 9. Courier service

A shopping cart for freight. You build a **manifest**, pick a destination, pay,
and it flies without you.

### Rules

- **Add to manifest** from any system where you have assets (Assets tab, or the
  bay panel while docked).
- **Destination** must be a system where you **already have assets** — plus the
  station you're currently docked at. Couriers consolidate a footprint; they
  never establish one. Reaching a new station for the first time is the
  flagship's job, and that's the point of having a flagship.
- One manifest = one origin → one destination. Multiple origins means multiple
  manifests (and multiple fees).
- `COURIERCFG.maxActive` (start at **3**) shipments in flight at once.
- **No cancellation once dispatched.** The goods are on someone else's ship.

### Fee

```
fee = base
    + perSlot  × slots
    + perDist  × distance          (galaxy-map distance, same source as Fleet.dockTravelMs)
    + valueRate × declaredValue     (insurance-flavoured; the reason a block of
                                     Voidstone costs more to move than a block of ice)
fee ×= laneMult                     (Senate; see below)
```

### Time

Distance-scaled like docking, but on a **courier speed constant that is slower
than any flagship** (`COURIERCFG.speed`, ~0.8 against `travelSpeed`). Flying it
yourself must always be faster — the courier buys convenience, not time.

Uses absolute timestamps (`departedAt` + `etaMs`) so it resolves offline and
through catch-up exactly like missions and charters.

### Risk — piracy

```
riskPct = COURIERCFG.base
        × slotRiskFactor(slots)              // reuse Charters.cargoRiskFactor shape
        × durationRiskMult(hours)            // reuse Charters.durationRiskMult
        − Senate.routeSafetyAdd()            // Convoy Mandate ↓ / Lane Cuts ↑
        − flagship routeSafe effect × COURIERCFG.routeSafeWeight
```

More slots = fatter target, exactly as the user-facing text should say. On a hit,
lose **one block** (or one gear item), not the manifest — a partial loss reads as
a raid, a total loss reads as a bug. Clamp to `COURIERCFG.riskCap` so a shipment
is never doomed.

The Senate hook is the interesting one: `Senate.routeSafetyAdd()` already exists
and already swings on Convoy Mandate / Lane Cut edicts, so reading the docket
tells you when freight is cheap and safe — the same "reading the room is the
edge" loop the game already runs on.

### Risk — customs, on landing

If the manifest contains `cat: "illicit"` goods, roll a customs check **on
arrival** using the existing pipeline, not a parallel one:

- `CUSTOMS.base` + `Senate.smuggleFailAdd()` (border edicts)
- × destination system tolerance (`sys.mods.illicit`), or the station's
  `Stations.scrutinyFor()` dial / Free Port multiplier
- − Syndicate standing shield (`CUSTOMS.repShield`)
- skipped entirely if `Stations.customsExempt(dest)` (owner / allied Customs House)

On a hit, `CUSTOMS.seize` fraction of one illicit block is taken. If the
destination has a Customs House, it goes to `Stations.impoundCargo()` and can be
ransomed back — the mechanic already exists and this feeds it.

`Economy.customsScan()` should be refactored so the roll is a shared helper taking
(goods, systemId) — one implementation, two callers (flagship arrival, courier
arrival). Do not fork the odds math.

### Reporting

**Dispatches** (`Story._push`, arc `courier`, a Courier Guild dispatcher contact)
gets a message on:

- **Dispatch** — manifest summary, destination, ETA, quoted risk.
- **Incident** — piracy hit or customs seizure, with what was lost and where.
- **Arrival** — what landed, in which bay.

**Hub** — the `#hub-dock` panel gains a line per in-flight manifest
(`→ Ordo Prime · 4 slots · 14m`), and the Assets tab shows the same `⏳ inbound`
badge on the destination row. Both read the same `Shipments.active()` list.

---

## 10. Balance consequences to watch

- **Net worth becomes location-aware** — each pile values at its own system's
  spot. That moves the baron leaderboard on day one; it is a balance change, not
  a display change.
- **The tier depth cap and the bay are now two different limits.** Depth caps
  what the *market* will fill at one price; the bay caps what you can *hold*.
  They don't conflict — but a Baron-tier player with a 50-slot bay will basically
  never feel the bay, which is correct.
- **Trade routes / charters get a purpose.** Freight charters (fleet hulls moving
  real goods instead of banking abstract credits) are the natural follow-up and
  should reuse §9's risk math wholesale.
- **Industries get slower to realise.** Output now lands at the planet, not in
  your pocket, so mining income needs either a courier run or a visit. That's the
  intended cost; watch that it doesn't make extractors feel bad, and if it does,
  the lever is courier fee, not removing the address.

---

## 11. Build order

1. **Ledger.** `Assets` module: `hold` / `stationInv`, block math, deposit /
   withdraw / reconcile, `migrate()`, prestige reset. Headless Node harness
   asserting the invariant survives buy → haul → sell → prestige.
2. **Bind the Exchange.** Buy → bay, sell → bay only, capacity gates. Retarget
   the mint sites in §5. Customs scans the hold only.
3. **Flagship `cargo` stat** + the transfer view (§6), desktop DnD + touch
   fallback + filters.
4. **Assets tab** (§8) — quick glance, then breakdown.
5. **Persistence** (§7) — table, lazy create, deferred delete, summary reads.
6. **Courier** (§9) — manifest cart, fee/time/risk, offline resolve, Dispatches
   and Hub reporting.
7. Later: freight charters on fleet hulls; server-side location keying.

Steps 1–2 are the risky ones and they're the ones with a runnable check. Steps
3–4 are layout work and can only be verified in a browser — call that out at
review time.

---

## 12. Open questions

- **Bay capacity per station type.** Flat 50 everywhere, or does a Storage Bay
  module / station tier raise it at stations you own? The latter is a good hook
  into the `STATIONS.md` power budget, but it's phase 2 at the earliest.
- **Should the courier be able to reach a system with no assets** if you have an
  in-flight manifest already heading there? Currently no — the rule is
  deliberately dumb. Revisit if it bites.
- **Bay rent.** Nothing charges for storage today. A small per-slot fee at
  stations you don't own would give the Assets tab teeth (and a reason to
  consolidate), but it also punishes idle players, which cuts against the
  alt-tab premise. Leaning no.
- **Does gear belong in bays at all,** or should accessories stay globally
  available? Spec says bays (consistent, and it makes the Bazaar's location
  matter); the risk is annoyance when you want to equip something that's three
  sectors away.
- **Insurance.** A paid option that refunds the credit value of a lost block
  would make high-value manifests less swingy. Cheap to add later; not in v1.
