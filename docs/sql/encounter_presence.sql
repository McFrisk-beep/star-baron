-- Encounter presence — other barons' FIGHTS, visible to everyone
-- (canvas-first battles, owner's direction: space should feel alive).
--
-- The trick is the same as flagship_presence: fights are deterministic, so a
-- spectator needs only the DESCRIPTION, never the fight itself. When a baron
-- dispatches a raid, their client posts one row per engagement window —
-- boarding, each predicted police wave, a manhunt — carrying the same fields
-- a report carries (the uid is the seed; roster names, the hauler, the wave,
-- the verdict). Every other client polls this table about once a minute and
-- replays the identical fight from the seed when its clock enters the
-- window: same ships, same shots, same winner, on every screen, with no
-- realtime channel and a few hundred bytes per fight.
--
-- Windows are posted IN ADVANCE (everything is pre-rolled), so a slow poll
-- still renders fights punctually. Rows self-expire: writers clean their own
-- finished rows, readers ignore anything past its window.
--
-- Optional: without this table the game runs unchanged — other barons'
-- fights simply don't render.
-- Run in the Supabase SQL Editor.

create table if not exists public.encounter_presence (
  user_id    uuid not null references auth.users(id) on delete cascade,
  enc_id     text not null check (char_length(enc_id) <= 48),
  display    text not null default 'Baron' check (char_length(display) between 1 and 24),
  kind       text not null check (kind in ('boarding', 'wave', 'manhunt')),
  sys_id     text not null check (char_length(sys_id) <= 32),
  t0         bigint not null,                 -- epoch ms, window start
  t1         bigint not null,                 -- epoch ms, window end
  -- The report-shaped fields Encounters.fromReport rebuilds the fight from.
  -- Cosmetic and clamped; clients must render text as plain text, never markup.
  params     jsonb not null default '{}'::jsonb check (pg_column_size(params) <= 4096),
  updated_at timestamptz not null default now(),
  primary key (user_id, enc_id),
  check (t1 > t0 and t1 - t0 <= 600000)       -- no window longer than 10 minutes
);

create index if not exists encounter_presence_window on public.encounter_presence (t1);

alter table public.encounter_presence enable row level security;

-- Fights are public by design — that is the whole point.
drop policy if exists "read encounters" on public.encounter_presence;
create policy "read encounters" on public.encounter_presence
  for select using (true);

drop policy if exists "insert own encounters" on public.encounter_presence;
create policy "insert own encounters" on public.encounter_presence
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own encounters" on public.encounter_presence;
create policy "update own encounters" on public.encounter_presence
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "delete own encounters" on public.encounter_presence;
create policy "delete own encounters" on public.encounter_presence
  for delete using (auth.uid() = user_id);
