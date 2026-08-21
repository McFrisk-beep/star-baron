-- Flagship presence — the cross-player slice of docs/LIVING_GALAXY.md step 3.
-- One row per signed-in player: where their flagship is flying (or docked).
-- Every client replays the same pure function (Voyages.pos) over the row, so
-- everyone sees the same ship at the same point on the same lane — no ticks,
-- no realtime channel, one ~100-byte row per player.
--
-- Optional: without this table the game runs unchanged — other barons'
-- flagships simply don't appear on the chart or in system views.
-- Run in the Supabase SQL Editor.

create table if not exists public.flagship_presence (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  display     text not null default 'Baron' check (char_length(display) between 1 and 24),
  sprite      text not null default 'ship:shuttle' check (char_length(sprite) <= 40),
  from_sys    text not null check (char_length(from_sys) <= 32),
  to_sys      text not null check (char_length(to_sys) <= 32),
  departed_at bigint not null default 0,    -- epoch ms; 0 = docked at to_sys
  eta_ms      bigint not null default 0 check (eta_ms between 0 and 86400000),
  updated_at  timestamptz not null default now()
);

alter table public.flagship_presence enable row level security;

-- Presence is public by design (it's what makes other barons' ships visible).
drop policy if exists "read flagship presence" on public.flagship_presence;
create policy "read flagship presence" on public.flagship_presence
  for select using (true);

-- Players write only their own row. display/sprite are cosmetic and clamped by
-- the checks above; clients must render display as plain text, never markup.
drop policy if exists "insert own flagship presence" on public.flagship_presence;
create policy "insert own flagship presence" on public.flagship_presence
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own flagship presence" on public.flagship_presence;
create policy "update own flagship presence" on public.flagship_presence
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
