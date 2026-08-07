# Admin accounts & content editing — setup

Adds two account types — **player** (default) and **admin** — and an in-game
**content editor** so an admin can add/modify/delete flavor and item data without
touching code. Builds on the Supabase setup in `CLOUD_SETUP.md`.

- **Players** see the normal game; the *dev* toggles (fast news / fast time) are hidden.
- **Admins** get the dev toggles **and** a **🛠 Admin** button → a content editor.
- Content lives in a Supabase table: **anyone can read** it (so every player gets
  your latest content), but **only admins can write** it (enforced by the DB).
- If a player edits the page/console, they still can't gain admin or change shared
  content — the role and the write-permission are enforced server-side.

---

## 1. Run the SQL

Supabase dashboard → **SQL Editor** → paste & **Run**:

```sql
-- ── roles ──────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null default 'player',     -- 'player' | 'admin'
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- a user may read their OWN role; nobody can change roles from the client
create policy "read own profile" on public.profiles
  for select using (auth.uid() = user_id);

-- auto-create a profile row for every new signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id) values (new.id) on conflict do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- backfill profiles for any accounts that already existed
insert into public.profiles (user_id)
  select id from auth.users on conflict do nothing;

-- ── editable content ───────────────────────────────────────────────────
create table if not exists public.content (
  key        text primary key,            -- e.g. 'CHAT_LINES'
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.content enable row level security;

-- everyone (even logged-out) may READ content…
create policy "read content" on public.content
  for select using (true);

-- …only admins may write it
create policy "admin writes content" on public.content
  for all
  using      (exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'admin'));
```

## 2. Make yourself an admin

Register/log in once in the game (so your account exists), then in **SQL Editor**:

```sql
update public.profiles
set role = 'admin'
where user_id = (select id from auth.users where email = 'YOU@example.com');
```

Reload the game while logged in. You should now see the **🛠 Admin** button in the
top bar, and the dev toggles inside **⚙ Settings**.

---

## 3b. Storage bucket for sprite / music uploads (Images + Music tabs)

To replace character/ship/planet sprites **or** upload background music from the
admin panel, create a public **`sprites`** bucket and let admins write to it
(music files land under `sprites/bgm/`). In **SQL Editor**:

```sql
-- public bucket (or create it in Dashboard → Storage → New bucket, name "sprites", Public)
insert into storage.buckets (id, name, public)
  values ('sprites', 'sprites', true) on conflict (id) do nothing;

-- anyone can read; only admins can upload/replace/delete
create policy "public read sprites" on storage.objects
  for select using (bucket_id = 'sprites');
create policy "admin write sprites" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'sprites' and exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'admin'));
create policy "admin update sprites" on storage.objects
  for update to authenticated using (
    bucket_id = 'sprites' and exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'admin'));
create policy "admin delete sprites" on storage.objects
  for delete to authenticated using (
    bucket_id = 'sprites' and exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'admin'));
```

## 3c. Global reset switch (for the "Issue Global Reset" button)

Lets an admin wipe **every** player's progress at once — accounts *and* guests.
The button bumps a shared counter; each client reads it on load and, if it's
newer than what they've already applied, does a one-time reset (credits → 5,000,
all owned assets wiped, **senate legislation kept**) and shows an "admin reset"
popup. Without this table the button just reports it's missing and nothing else
changes. In **SQL Editor**:

```sql
create table if not exists public.world_reset (
  id         int primary key default 1,
  epoch      int not null default 0,   -- bump this (the button does) to issue a reset
  note       text,
  updated_at timestamptz not null default now(),
  constraint world_reset_singleton check (id = 1)
);
insert into public.world_reset (id, epoch) values (1, 0) on conflict (id) do nothing;
alter table public.world_reset enable row level security;
create policy "read world_reset" on public.world_reset for select using (true);   -- everyone (incl. guests) reads it
create policy "admin writes world_reset" on public.world_reset
  for all to authenticated
  using      ((select role from public.profiles where user_id = auth.uid()) = 'admin')
  with check ((select role from public.profiles where user_id = auth.uid()) = 'admin');
```

Signed-in players also need [`docs/sql/reset_save.sql`](sql/reset_save.sql)
applied — the wipe runs server-side through `app_world_reset_apply()`, because
`app_commit` protects credits/positions/ships/items/prestige and would echo a
client-built fresh state straight back. Without it their authoritative save is
left untouched and the reset re-tries on every load (console warns why); guests
still reset normally.

> Then **Admin → Dev → Issue Global Reset**. Each player resets on their *next*
> load (it fires once per bump, never loops). To undo a mistaken reset there's no
> clean rollback — players who've already loaded have applied it — so it's behind
> a confirm. Note the issuing admin's own save also resets on their next reload.

---

## Using the admin panel

**🛠 Admin** opens these tabs:

### 📝 Content
Pick a collection. Most are shown as a **friendly editor**, no JSON needed:

- **Tables** for structured lists — *Commodities (items)*, *Ships*, *Danger tiers*,
  *Rarities*, *Omens*, *Tutorial steps*. Edit cells inline; **+ row** / **✕** to
  add/remove entries.
- **Line lists** for simple text pools — *Trader chat lines*, *Local chatter* —
  one entry per line.
- **Grouped lists** for keyed pools — *Ship voice lines*, *Reactions*, *Rival barbs*.
- **Raw JSON** checkbox — switch any collection to direct JSON for full control
  (needed for the few nested ones like *News events*, *NPCs*, *Ship dialogues*).

Then **Validate** → **Save**.
- **Flavor** edits apply **live**. **Items & rules** (commodities, ships, …) apply
  **after a reload** (the market/economy reads them at startup).
- **Reset to default** removes your override.
- Malformed or wrong-typed overrides are ignored at boot (the built-in default is
  used), so a bad edit **can't brick the game**.

### 🔧 Crafting
A shape-aware editor for the Workshop, so recipes don't have to be hand-written
JSON. Three tabs:

- **Recipes** — add / edit / delete. Ingredients, output (gear kind + rarity,
  blackbox effect, extractor type, or hull) and the paired **blueprint** (how
  players get it — auto-unlock at a Baron Tier, Bazaar stock, survey drop, or
  mission reward — plus the one-of-a-kind flag) are all pickers, so ids stay
  valid. Deleting a recipe deletes its blueprint too.
- **Blackboxes** — add / edit / delete consumable effects. The "Affects" list is
  exactly the stats the game reads, so an effect always does something. An effect
  a recipe still crafts is refused until you repoint or delete that recipe.
- **Server SQL** — crafting is **server-authoritative**: the database keeps its
  own copy of the recipe, blackbox and hull tables. This pane regenerates them
  from your live edits — copy it into the Supabase **SQL Editor** and run it.
  Until you do, guests see your new recipes and signed-in players get
  "Unknown recipe."

New *hulls* go in **Content → Ships**; set `craftOnly` to `true` so they stay out
of the shipyard and the mercenary roster, then point a ship recipe at the id and
re-run the Server SQL (it carries hull stats and accessory slots too). Details in
`docs/CRAFTING_AND_MATERIALS.md` §7 and `docs/WORKSHOP_CRAFT_SETUP.md`.

### 🖼 Images
A gallery of every sprite slot — portraits, ship hulls, race ships, planets, stars,
stations, commodities, nebulae, broadcast screens. **Upload** (or **Replace**) a
PNG/JPG; it's stored in your `sprites` bucket and the game points at it. **Reset**
reverts a slot to the built-in art. Changes show on **reload**.

### 🎵 Music
Shared background playlist for **every player**. **+ Add song** uploads an
MP3/OGG/WAV/WEBM into `sprites/bgm/` and appends it to content key `BGM_PLAYLIST`.
Tracks play in order and loop when the list ends. Rename / reorder / remove from
the same tab. Players control mute (top-bar icon next to Settings) and volume
(Settings, default 25%).

**Single slots vs pools.** Most categories take one image. The ones marked
*(pools)* take **as many as you like** per entry, and each individual thing in
the game picks one from the pool and keeps it — so a category of gear or ships
doesn't look like the same picture repeated down the page:

| Pool | One pool per… | Where it shows |
|---|---|---|
| Gear kinds | accessory kind (reactor, shield, …) | Bazaar gear market + Inventory |
| **Ships** | **hull** (Lane Clipper, Battleship, …) | **Bazaar shipyard, Fleet card, mission icons** |
| **Blackboxes** | **effect** (Overclock Core, Tax Ghost, …) | **Bazaar gear tab + Inventory** |
| **Blueprints** | **blueprint** | **Bazaar gear tab** |
| Extractors / Components | type / kind | Bazaar extractors tab |
| Mercenaries | escort hull | Bazaar mercenaries tab |
| Broadcast screens | channel | Comms → Broadcast (GIFs animate) |

The pick is deterministic, not random per render: a ship on the shipyard shelf
picks from its hull's pool by offer id, and once bought it picks by the ship's
uid — so **the picture a player bought is the picture they keep**. An empty pool
falls back to what that thing looked like before (the shared class sprite for
ships, the generic `blackbox` / `blueprint` gear art for the other two), so you
can fill pools in gradually without anything looking half-finished.

## Notes & limits

- Content & sprites are shared by **all** players (your canonical game content), so
  edits are global. There's no per-player content.
- Defaults always ship in the code, so the game still works fully offline / for
  guests, and as a fallback if Supabase is unreachable.
- Edits live in **Supabase, not Git** — that's what makes them instantly
  server-wide for everyone without a redeploy. (Want a backup in Git? Use Raw JSON
  to copy a collection out, or ask for an Export button.)
