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

## Using the content editor

**🛠 Admin** → pick a collection (e.g. *Trader chat lines*, *Commodities (items)*)
→ edit the JSON → **Validate** → **Save**.

- **Flavor** collections (chat, omens, news, NPCs, ship lines, tutorial, …) apply
  **live** — new lines start showing right away.
- **Items & rules** (commodities, danger tiers, rarities, accessory kinds, contract
  templates) apply **after a reload** (the market/economy reads them at startup).
- **Reset to default** removes your override and restores the built-in content.
- Keep the JSON **shape** intact (same field names/types as the default you see) —
  malformed or wrong-typed overrides are ignored at boot and the default is used,
  so a bad edit can't brick the game.

## Notes & limits

- **Character/ship sprites** are image files, not JSON, so they aren't in this
  editor yet. Editing those means uploading images to **Supabase Storage** and
  pointing the game at them — a planned follow-up. For now, swapping the PNGs in
  `/assets` (same filenames) still works.
- Content is shared by **all** players (it's your canonical game content), so edits
  are global. There's no per-player content.
- Defaults always ship in the code, so the game still works fully offline / for
  guests, and as a fallback if Supabase is unreachable.
