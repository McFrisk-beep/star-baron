# Cloud accounts & saves — setup (Supabase, free)

Cosmocrat runs fully offline by default (saves to the browser). To enable
**online accounts + cloud saves that sync across devices**, connect a free
Supabase project. ~5 minutes, no server to run.

The whole frontend stays a static site (GitHub Pages). Players' browsers talk to
Supabase directly; their saves are protected by **Row-Level Security** so each
account can only ever read/write its own save.

---

## 1. Create a project

1. Sign up at <https://supabase.com> (free).
2. **New project** → pick a name, a strong database password (you won't need it
   for this), and a region near your players. Wait ~2 min for it to provision.

## 2. Create the saves table + security policies

Open **SQL Editor** in the Supabase dashboard, paste this, and **Run**:

```sql
-- one save blob per user
create table if not exists public.saves (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- lock the table down: a user may only touch their OWN row
alter table public.saves enable row level security;

create policy "read own save"   on public.saves
  for select using (auth.uid() = user_id);
create policy "insert own save" on public.saves
  for insert with check (auth.uid() = user_id);
create policy "update own save" on public.saves
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own save" on public.saves
  for delete using (auth.uid() = user_id);
```

## 3. Configure auth

In **Authentication → Providers**, make sure **Email** is enabled (it is by
default). For real players, keep **"Confirm email"** ON (under
*Authentication → Sign In / Providers → Email*) so signups verify their address.

In **Authentication → URL Configuration**, set the **Site URL** to where the game
is hosted (e.g. `https://YOURNAME.github.io/star-baron/`) and add it to
**Redirect URLs**, so confirmation emails link back to the game.

> The built-in email sender is rate-limited (a few/hour) — fine for testing. For
> volume, add a free SMTP provider later in *Authentication → Emails*.

## 4. Plug the keys into the game

In the Supabase dashboard go to **Project Settings → API** and copy:

- **Project URL** (e.g. `https://abcd1234.supabase.co`)
- **anon / public** key

Paste them into [`js/cloud-config.js`](../js/cloud-config.js):

```js
window.CLOUD = {
  url: "https://abcd1234.supabase.co",
  anonKey: "eyJhbGciOi...",   // the long anon/public key
};
```

Commit & deploy. The **Sign in** button appears in the top bar; until keys are
present it stays hidden and the game is local-only.

> The anon key is a **public, publishable** key — it's meant to live in client
> code. Your data is safe because of the RLS policies above, not because the key
> is hidden. **Never** put the `service_role` key in the frontend.

---

## How it behaves

- **Guest play:** anyone can play immediately; the save lives in their browser.
- **Register / Log in:** on first login the local progress is uploaded; if a
  newer cloud save exists, it wins. The game reloads from the chosen save.
- **Across devices:** log in anywhere and your latest save loads.
- **Saving:** writes to the browser instantly and pushes to the cloud on a ~20s
  debounce, plus immediately when you hide the tab or sign out.

## Good to know

- **Free-tier pause:** a free Supabase project pauses after **7 days with zero
  activity** (one click to restore in the dashboard, no data lost). Any player
  logging in resets the clock; a free uptime pinger can keep it warm.
- **Cheating:** saves are client-authoritative — a determined player can edit
  their own browser save. That's fine for a casual game. A tamper-proof global
  leaderboard would need server-side validation (Supabase Edge Functions) — a
  separate project.
