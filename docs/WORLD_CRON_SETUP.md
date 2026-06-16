# Persistent shared world (Supabase Cron)

This makes the trader chat a **living, always-on, shared** feed: a Supabase cron
job appends ambient chatter every minute — running even when **no one is online**
— and every player reads the same lines. So players never arrive to an empty
channel, and the world genuinely "kept going" while they were away.

**Bonus:** because the job touches the database every minute, it also keeps your
free Supabase project from **pausing after 7 days** of inactivity.

> Scope (v1): shared ambient **chat**. The market + news stay client-side for now
> (they're wired to the omen→news→price gameplay). Ask for the shared-news/market
> upgrade when you want it.

---

## 1. Run the SQL

Supabase dashboard → **SQL Editor** → paste & **Run**:

```sql
-- enable the scheduler
create extension if not exists pg_cron;

-- shared feed everyone reads (only the tick function writes it)
create table if not exists public.world_feed (
  id         bigint generated always as identity primary key,
  kind       text not null,                 -- 'chat'
  payload    jsonb not null,                -- { handle, text, portrait }
  created_at timestamptz not null default now()
);
create index if not exists world_feed_id_idx on public.world_feed (id desc);

alter table public.world_feed enable row level security;
create policy "read world feed" on public.world_feed for select using (true);
-- (no insert/update/delete policy → clients can't write; only the function does)

-- the world tick: append 1–2 ambient lines, then trim old history
create or replace function public.world_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  handles text[] := array[
    'xeno_trader','void_baron77','quark_Maxx','nova_hodls','astro_Prime',
    'drift_official','ion_zzz','lumen_wagmi','vexSupreme','orb_degen',
    'pulsar_quant','gloop_HODL','warp_clown','MadameUmbra','AdmiralCrabbe'];
  lines text[] := array[
    'spice holding steady, who''s buying?',
    'another quiet shift on the exchange',
    'somebody just moved size in nanochips 👀',
    'the belt''s been generous this cycle',
    'customs backed up at the hub again',
    'long contraband, short patience',
    'helium-3 looking spicy today',
    'who keeps dumping ore into Korrin??',
    'antimatter bid is thin, mind the gap',
    'heard a baron retired richer than a moon',
    'rumor of raiders out past the tide lanes',
    'foodstuffs creeping up, stock the holds',
    'never sell into a quiet market, friend',
    'my hauler''s held together with tape and vibes',
    'green candles everywhere, stay frosty',
    'the void provides. eventually. maybe.'];
  n int := 1 + floor(random()*2)::int;   -- 1–2 lines/minute
  i int;
begin
  for i in 1..n loop
    insert into public.world_feed(kind, payload) values (
      'chat',
      jsonb_build_object(
        'handle',   handles[1 + floor(random()*array_length(handles,1))::int],
        'text',     lines[1 + floor(random()*array_length(lines,1))::int],
        'portrait', floor(random()*12)::int
      )
    );
  end loop;
  delete from public.world_feed where created_at < now() - interval '3 hours';
end;
$$;

-- schedule it once a minute
select cron.schedule('world-tick', '* * * * *', $$ select public.world_tick(); $$);
```

> Re-running? First remove the old job to avoid duplicates:
> `select cron.unschedule('world-tick');` then re-run the `cron.schedule(...)` line.
> You can also manage this under **Dashboard → Integrations → Cron**.

## 2. That's it

The client already reads `world_feed` (see `js/worldfeed.js`): it loads the recent
shared lines on arrival and polls for new ones every ~45s (paused while the tab is
hidden). No keys or config to change — it activates automatically because it uses
your existing Supabase connection.

### Verify it's working
- **SQL Editor:** `select count(*), max(created_at) from public.world_feed;` — the
  count should climb every minute.
- **Scheduled jobs:** `select * from cron.job;` (and `cron.job_run_details` for runs).
- **In game (console):** on load you'll see `[WorldFeed] shared world feed live (N recent lines).`
  Open the game in two browsers — the ambient lines appear in both.

### Tuning
- Edit the `lines` / `handles` arrays in `world_tick()` to change the chatter
  (keep them plain text — no `{tokens}`).
- Change frequency by editing the schedule (`'* * * * *'` = every minute) or the
  `n := 1 + floor(random()*2)` line count.
- Change retention by editing the `interval '3 hours'`.

### Remove it
```sql
select cron.unschedule('world-tick');
drop function if exists public.world_tick();
drop table if exists public.world_feed;
```
