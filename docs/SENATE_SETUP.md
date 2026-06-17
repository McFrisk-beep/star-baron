# Galaxy-wide senate (Supabase Cron)

This makes the **senate legislation shared across all players**: a Supabase cron
job authors one bill a day into a `world_senate` table — running even when no
one is online — and every client reads the **same agenda** and resolves each
bill at its shared `votes_at`. Because the senators are deterministic (generated
from the galaxy seed) and the market trend + bill id are shared, every player
who doesn't interfere lands on the **same outcome**, so the galaxy passes the
same laws at the same time.

The senate is now also a multiplayer **tug-of-war**: every player's
lobby/bribe/scandal goes into a shared `world_senate_influence` pool, and the
combined pool decides the one outcome everyone gets (§1b below). Run **both** SQL
blocks.

The client already reads `world_senate` (see `js/senateworld.js`): it loads the
recent bills on arrival, polls every ~45s (paused while hidden), and falls back
to the fully local senate when this table doesn't exist or you're offline. No
keys or config to change — it uses your existing Supabase connection.

---

## 1. Run the SQL

Supabase dashboard → **SQL Editor** → paste & **Run**:

```sql
-- enable the scheduler
create extension if not exists pg_cron;

-- the shared bill agenda everyone reads (only the tick function writes it)
create table if not exists public.world_senate (
  id         bigint generated always as identity primary key,
  issue      text not null,            -- trade | tax | borders | prohibition | arms | subsidy
  type       text not null,            -- priceCap | subsidy | tariff | industryTax | taxHoliday | border | warpGate | ban | shipBan
  lean       int  not null default 1,
  effect     jsonb,                    -- { type, cat|commId|faction|cls, mult|add|tax }
  title      text not null,
  blurb      text not null,
  votes_at   timestamptz not null,     -- when every client resolves it (shared)
  ends_at    timestamptz,              -- when its edict expires if passed
  created_at timestamptz not null default now()
);
create index if not exists world_senate_id_idx on public.world_senate (id desc);
alter table public.world_senate enable row level security;
create policy "read world senate" on public.world_senate for select using (true);
-- (no insert/update/delete policy → clients can't write; only the function does)

-- author one bill per tick: weighted template pick → severity → concrete effect
create or replace function public.senate_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tpls jsonb := '[
    {"issue":"trade","type":"priceCap","scope":"cat","mag":0.8,"weight":10,"title":"{TARGET} Price Control Act","blurb":"Caps {TARGET} prices across the exchange — about {PCT} below their drift."},
    {"issue":"tax","type":"tariff","scope":"cat","mag":0.1,"weight":12,"title":"{TARGET} Tariff","blurb":"Levies a {PCT} duty on every {TARGET} trade, both ways."},
    {"issue":"tax","type":"industryTax","scope":"faction","mag":0.12,"weight":10,"title":"Industrial Levy: {TARGET}","blurb":"Raises offworld industry tax {PCT} on {TARGET} holdings."},
    {"issue":"borders","type":"border","scope":"none","mag":0.18,"weight":8,"title":"Border Security Act","blurb":"Tightens the lanes — smuggling runs are about {PCT} likelier to fail."},
    {"issue":"subsidy","type":"warpGate","scope":"none","mag":0.015,"weight":11,"title":"Warp-Lane Standardization","blurb":"Standardised warp gates speed every ship about {PCT} faster between systems."},
    {"issue":"subsidy","type":"subsidy","scope":"cat","mag":1.18,"weight":11,"title":"{TARGET} Subsidy","blurb":"Props {TARGET} prices up about {PCT} above their drift."},
    {"issue":"subsidy","type":"taxHoliday","scope":"faction","mag":-0.07,"weight":10,"title":"{TARGET} Tax Holiday","blurb":"Cuts offworld industry tax {PCT} on {TARGET} holdings."},
    {"issue":"trade","type":"tariff","scope":"cat","mag":-0.08,"weight":9,"title":"{TARGET} Free-Trade Act","blurb":"Waives duties on {TARGET} — about {PCT} better on every trade, both ways."},
    {"issue":"prohibition","type":"ban","scope":"comm","mag":0,"weight":3,"title":"{TARGET} Prohibition","blurb":"Outlaws all buying and selling of {TARGET} in senate space."},
    {"issue":"prohibition","type":"ban","scope":"cat","mag":0,"weight":2,"title":"{TARGET} Embargo","blurb":"Suspends all trade in {TARGET}-class goods until repeal."},
    {"issue":"arms","type":"shipBan","scope":"shipcls","mag":0,"weight":1,"title":"{TARGET} Restriction Act","blurb":"Bars {TARGET}-class ships from contract work in senate space."}
  ]'::jsonb;
  cats text[] := array['mineral','gas','agri','tech','luxury','illicit'];
  comms jsonb := '[{"id":"iron_ore","name":"Iron Ore"},{"id":"silicon","name":"Silicon"},{"id":"rare_earths","name":"Rare Earths"},{"id":"hydrogen","name":"Hydrogen"},{"id":"helium3","name":"Helium-3"},{"id":"water_ice","name":"Water Ice"},{"id":"foodstuffs","name":"Foodstuffs"},{"id":"synthsilk","name":"Synthsilk"},{"id":"nanochips","name":"Nanochips"},{"id":"antimatter","name":"Antimatter"},{"id":"spice","name":"Spice"},{"id":"contraband","name":"Contraband"}]'::jsonb;
  facs text[] := array['syndicate','mining_combine','free_trade','agri_collective'];
  fac_names jsonb := '{"syndicate":"The Syndicate","mining_combine":"Mining Combine","free_trade":"Free-Trade League","agri_collective":"Agri-Collective"}'::jsonb;
  total numeric := 0; r numeric; tpl jsonb; i int;
  sev numeric := 1; sevlabel text := '';
  scope text; typ text; mag numeric;
  target text := ''; pct text := ''; effect jsonb := '{}'::jsonb;
  c text; cm jsonb; f text; cls text;
  ttl text; blb text; ov jsonb;
begin
  -- prefer admin-edited SENATE_EDICTS (Admin → Content), else the built-in set
  begin
    select data into ov from public.content where key = 'SENATE_EDICTS';
    if ov is not null and jsonb_array_length(ov) > 0 then tpls := ov; end if;
  exception when others then null; end;

  for i in 0 .. jsonb_array_length(tpls)-1 loop total := total + coalesce((tpls->i->>'weight')::numeric, 1); end loop;
  r := random() * total;
  for i in 0 .. jsonb_array_length(tpls)-1 loop
    r := r - coalesce((tpls->i->>'weight')::numeric, 1);
    if r <= 0 then tpl := tpls->i; exit; end if;
  end loop;
  if tpl is null then tpl := tpls->0; end if;

  typ := tpl->>'type'; scope := tpl->>'scope'; mag := coalesce((tpl->>'mag')::numeric, 0);

  -- severity (bans are binary): mild 64% / moderate 28% / sweeping 8%
  if typ not in ('ban','shipBan') then
    r := random();
    if r < 0.64 then sev := 0.5; elsif r < 0.92 then sev := 1.0; else sev := 1.7; sevlabel := 'Sweeping '; end if;
  end if;

  if scope = 'cat' then
    c := cats[1 + floor(random()*array_length(cats,1))::int]; target := initcap(c);
    if typ = 'priceCap' then effect := jsonb_build_object('type','priceCap','cat',c,'mult', round((1-(1-mag)*sev)::numeric,3)); pct := round((1-mag)*sev*100)::text || '%';
    elsif typ = 'subsidy' then effect := jsonb_build_object('type','subsidy','cat',c,'mult', round((1+(mag-1)*sev)::numeric,3)); pct := round((mag-1)*sev*100)::text || '%';
    elsif typ = 'tariff' then effect := jsonb_build_object('type','tariff','cat',c,'tax', round((mag*sev)::numeric,3)); pct := round(abs(mag*sev)*100)::text || '%';
    elsif typ = 'ban' then effect := jsonb_build_object('type','ban','cat',c); end if;
  elsif scope = 'comm' then
    cm := comms -> floor(random()*jsonb_array_length(comms))::int; target := cm->>'name';
    effect := jsonb_build_object('type', typ, 'commId', cm->>'id');
  elsif scope = 'faction' then
    if random() < 0.4 then f := 'all'; target := 'all sectors'; else f := facs[1 + floor(random()*array_length(facs,1))::int]; target := fac_names->>f; end if;
    effect := jsonb_build_object('type', typ, 'faction', f, 'add', round((mag*sev)::numeric,3)); pct := round(abs(mag*sev)*100)::text || '%';
  elsif scope = 'shipcls' then
    if random() < 0.5 then cls := 'escort'; else cls := 'transport'; end if; target := initcap(cls);
    effect := jsonb_build_object('type','shipBan','cls',cls);
  elsif scope = 'none' then
    if typ = 'border' then effect := jsonb_build_object('type','border','add', round((mag*sev)::numeric,3)); pct := round(mag*sev*100)::text || '%';
    elsif typ = 'warpGate' then effect := jsonb_build_object('type','warpGate','add', round((mag*sev)::numeric,4)); pct := to_char(mag*sev*100,'FM990.0') || '%'; end if;
  end if;

  ttl := sevlabel || replace(replace(tpl->>'title','{TARGET}',target),'{PCT}',pct);
  blb := replace(replace(tpl->>'blurb','{TARGET}',target),'{PCT}',pct);

  insert into public.world_senate(issue, type, lean, effect, title, blurb, votes_at, ends_at)
  values (tpl->>'issue', typ, 1, effect, ttl, blb, now() + interval '1 day', now() + interval '4 days');

  delete from public.world_senate where created_at < now() - interval '14 days';
end;
$$;

-- one new bill per day (votes ~24h later, giving players time to react)
select cron.schedule('senate-tick', '0 0 * * *', $$ select public.senate_tick(); $$);
```

> Re-running? Remove the old job first to avoid duplicates:
> `select cron.unschedule('senate-tick');` then re-run the `cron.schedule(...)` line.
> Want a bill right now to test? `select public.senate_tick();`

## 1b. Pooled influence (run this too)

Lets every player's lobby/bribe/scandal combine into the shared outcome. Players
**insert their own** influence for the open bill; everyone **reads the aggregate**;
the deterministic resolution then lands the same result for all. Run in the
**SQL Editor**:

```sql
create table if not exists public.world_senate_influence (
  id         bigint generated always as identity primary key,
  bill_id    text not null,            -- the world_senate bill (client id: 'wb' || world_senate.id)
  user_id    uuid not null default auth.uid(),
  kind       text not null,            -- lobby_all | lobby_fac | bribe | scandal
  target     text,                     -- faction id (lobby_fac) | senator id (bribe/scandal) | null
  dir        int  not null default 0,  -- +1 back / -1 block (0 for scandal)
  strength   numeric not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists wsi_bill_idx on public.world_senate_influence (bill_id);
alter table public.world_senate_influence enable row level security;
create policy "read influence"      on public.world_senate_influence for select using (true);
create policy "insert own influence" on public.world_senate_influence for insert with check (auth.uid() = user_id);
-- (no update/delete → influence is immutable once cast)

-- optional housekeeping: drop influence for bills older than the retention window
-- (safe to skip; or add to senate_tick: delete from world_senate_influence where created_at < now() - interval '14 days';)
```

> Influence requires the player to be **signed in** (so each contribution has an
> owner). Guests still see the shared agenda and outcomes, they just can't sway
> them. Submissions close at a bill's `votes_at`; clients resolve with the final
> pool, so everyone agrees.

## 2. That's it

The client activates automatically once rows exist: on load you'll see
`[SenateWorld] shared senate live (N recent bills).` and the local bill
generator switches off. Two browsers will show the same upcoming legislation.

### Verify it's working
- **SQL Editor:** `select count(*), max(created_at) from public.world_senate;`
- **Scheduled jobs:** `select * from cron.job;` (and `cron.job_run_details` for runs).
- **In game (console):** the `[SenateWorld] shared senate live` line; the Senate
  tab's "Upcoming Legislation" matches across browsers.

### Tuning
- Frequency / lead time: edit the schedule (`'0 0 * * *'` = daily) and the
  `votes_at`/`ends_at` intervals.
- Bill mix: edit the `tpls` weights/templates (or override **SENATE_EDICTS** in
  Admin → Content — the function prefers it when present).
- Retention: edit `interval '14 days'`.

### Remove it
```sql
select cron.unschedule('senate-tick');
drop function if exists public.senate_tick();
drop table if exists public.world_senate;
drop table if exists public.world_senate_influence;
```
