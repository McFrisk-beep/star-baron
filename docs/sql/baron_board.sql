-- Baron Leaderboard — human players only.
-- Public read of daily wealth snapshots; writes only via SECURITY DEFINER RPC.
--
-- Prereq: docs/ADMIN_SETUP.md (profiles) + docs/sql/profile_username.sql.
-- Optional: docs/sql/phase1_players.sql + phase3 (app._net_worth) for richer NW.
-- Run in Supabase SQL Editor, then the Barons tab will list signed-in players.

create table if not exists public.baron_board (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  display    text not null,
  title      text not null default 'Baron',
  tier       int  not null default 0,
  net_worth  double precision not null default 0,
  day_key    int  not null default 0,          -- UTC day of last wealth write
  updated_at timestamptz not null default now()
);

create index if not exists baron_board_nw_idx
  on public.baron_board (net_worth desc);

alter table public.baron_board enable row level security;

drop policy if exists "read baron board" on public.baron_board;
create policy "read baron board" on public.baron_board
  for select using (true);
-- no insert/update/delete policies → clients cannot write; only the RPC does.

-- Baron Tier title from prestige tier (mirrors BARON_TIERS in js/data.js).
create or replace function public._baron_title(p_tier int)
returns text
language sql immutable as $$
  select case greatest(0, least(coalesce(p_tier, 0), 6))
    when 0 then 'Baron'
    when 1 then 'Magnate'
    when 2 then 'Tycoon'
    when 3 then 'Oligarch'
    when 4 then 'Plutocrat'
    when 5 then 'Potentate'
    else 'Cosmocrat'
  end;
$$;

-- Publish / refresh the caller's row. Display + title always refresh.
-- Net worth only advances once per UTC day (daily leaderboard cadence).
create or replace function public.app_baron_publish()
returns jsonb
language plpgsql
security definer
set search_path = public, market, app
as $$
declare
  uid uuid := auth.uid();
  st jsonb;
  nw double precision;
  tier int := 0;
  title text;
  disp text;
  uname text;
  jn bigint;
  today int := (extract(epoch from now()) / 86400)::int;
  prev_day int;
  prev_nw double precision;
  wrote_nw boolean := false;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'error', 'not signed in');
  end if;

  -- Prefer authoritative players.state; fall back to zeros if Phase 1 isn't in.
  begin
    select state into st from public.players where user_id = uid;
  exception when undefined_table then
    st := null;
  end;

  if st is not null then
    tier := coalesce((st->'prestige'->>'tier')::int, 0);
    begin
      -- Phase 3 full net worth when available.
      nw := app._net_worth(st, (extract(epoch from now()) * 1000)::bigint);
    exception when undefined_function then
      nw := coalesce((st->>'credits')::float8, 0);
    end;
  else
    nw := 0;
    tier := 0;
  end if;
  if nw is null or nw < 0 or nw <> nw then nw := 0; end if;
  title := public._baron_title(tier);

  select username, join_n into uname, jn
    from public.profiles where user_id = uid;
  if uname is not null and length(trim(uname)) > 0 then
    disp := trim(uname);
  elsif jn is not null and jn > 0 then
    disp := 'Baron #' || jn::text;
  else
    disp := 'Baron';
  end if;

  select day_key, net_worth into prev_day, prev_nw
    from public.baron_board where user_id = uid;

  if prev_day is null then
    -- First appearance: seed wealth immediately.
    insert into public.baron_board(user_id, display, title, tier, net_worth, day_key, updated_at)
    values (uid, disp, title, tier, nw, today, now())
    on conflict (user_id) do update set
      display = excluded.display,
      title = excluded.title,
      tier = excluded.tier,
      net_worth = excluded.net_worth,
      day_key = excluded.day_key,
      updated_at = now();
    wrote_nw := true;
  elsif prev_day < today then
    update public.baron_board set
      display = disp,
      title = title,
      tier = tier,
      net_worth = nw,
      day_key = today,
      updated_at = now()
    where user_id = uid;
    wrote_nw := true;
  else
    -- Same day: refresh name/title only — wealth stays frozen.
    update public.baron_board set
      display = disp,
      title = title,
      tier = tier,
      updated_at = now()
    where user_id = uid;
    nw := coalesce(prev_nw, nw);
  end if;

  return jsonb_build_object(
    'ok', true,
    'display', disp,
    'title', title,
    'tier', tier,
    'net_worth', nw,
    'day_key', today,
    'wealth_updated', wrote_nw
  );
end;
$$;

grant execute on function public.app_baron_publish() to authenticated;

-- Optional: public read helper (same as table select; handy if RLS ever tightens).
create or replace function public.app_baron_board()
returns table (
  user_id uuid,
  display text,
  title text,
  tier int,
  net_worth double precision,
  day_key int,
  updated_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select b.user_id, b.display, b.title, b.tier, b.net_worth, b.day_key, b.updated_at
  from public.baron_board b
  order by b.net_worth desc, b.display asc
  limit 2000;
$$;

grant execute on function public.app_baron_board() to anon, authenticated;
