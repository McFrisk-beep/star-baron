-- Account usernames — signed-in barons can set a public handle on Account.
-- Default display is "Baron #<join_n>" (signup order). Custom names: A–Z only,
-- 3–16 letters, unique (case-insensitive), blocked-word filter (incl. letter-only
-- workarounds). profiles stays read-own for clients; writes go through the RPC.
--
-- Run in Supabase SQL Editor after docs/ADMIN_SETUP.md (profiles table).
-- Re-run docs/sql/senate_ballot.sql after this so ballot labels prefer username.

alter table public.profiles
  add column if not exists username text,
  add column if not exists join_n bigint;

-- Signup order for the default "Baron #N" label.
with ordered as (
  select user_id, row_number() over (order by created_at nulls last, user_id) as n
  from public.profiles
)
update public.profiles p
   set join_n = o.n
  from ordered o
 where p.user_id = o.user_id
   and (p.join_n is null or p.join_n <> o.n);

create unique index if not exists profiles_username_lower_uidx
  on public.profiles (lower(username))
  where username is not null;

create sequence if not exists public.profiles_join_n_seq;
select setval(
  'public.profiles_join_n_seq',
  greatest(coalesce((select max(join_n) from public.profiles), 0), 1)
);

-- New signups: assign next join_n (keep role insert).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n bigint;
begin
  n := nextval('public.profiles_join_n_seq');
  insert into public.profiles (user_id, join_n)
  values (new.id, n)
  on conflict (user_id) do update
    set join_n = coalesce(public.profiles.join_n, excluded.join_n);
  return new;
end;
$$;

-- Letter-only normalize: lower + collapse repeated letters (fuuuck → fuck).
create or replace function public._username_norm(p text)
returns text
language sql
immutable
as $$
  select regexp_replace(lower(coalesce(p, '')), '(.)\1+', '\1', 'g');
$$;

-- True when the name (or collapsed form) contains a blocked stem.
-- Keep in sync with Username.BLOCKED in js/username.js.
create or replace function public._username_blocked(p text)
returns boolean
language plpgsql
immutable
as $$
declare
  raw text := lower(coalesce(p, ''));
  nrm text := public._username_norm(p);
  w text;
  blocked text[] := array[
    'fuck','fuk','fck','fuc','fvck','phuck','ffuck',
    'shit','sht','shyt',
    'cunt','cnt',
    'asshole','arsehole','asshat',
    'bitch','btch','biatch',
    'bastard',
    'damn','dammit',
    'dick','dck',
    'cock','cok',
    'pussy','puss',
    'penis','vagina','vag',
    'whore','slut','slutty',
    'nigger','nigga',
    'faggot','fag','fgt',
    'retard','rtrd','tard',
    'rape','raper','rapist',
    'nazi','hitler','holocaust',
    'kike','spic','chink','gook','tranny','troon',
    'porn','porno','hentai','nsfw',
    'kkk','isis'
  ];
begin
  foreach w in array blocked loop
    if position(w in raw) > 0 or position(w in nrm) > 0 then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

create or replace function public.app_set_username(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  raw text := coalesce(p_username, '');
  trimmed text := btrim(raw);
  join_num bigint;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  -- Empty / whitespace → clear custom name (fall back to Baron #N).
  if trimmed = '' then
    update public.profiles set username = null where user_id = uid
      returning join_n into join_num;
    if join_num is null then
      insert into public.profiles (user_id, join_n)
      values (uid, nextval('public.profiles_join_n_seq'))
      on conflict (user_id) do update set username = null
      returning join_n into join_num;
    end if;
    return jsonb_build_object(
      'ok', true, 'username', null, 'join_n', join_num,
      'display', 'Baron #' || coalesce(join_num, 0)
    );
  end if;

  if trimmed !~ '^[A-Za-z]+$' then
    return jsonb_build_object('ok', false, 'error', 'letters only (A–Z) — no numbers, spaces, or other scripts');
  end if;
  if char_length(trimmed) < 3 or char_length(trimmed) > 16 then
    return jsonb_build_object('ok', false, 'error', 'username must be 3–16 letters');
  end if;
  if public._username_blocked(trimmed) then
    return jsonb_build_object('ok', false, 'error', 'that username is not allowed');
  end if;

  if exists (
    select 1 from public.profiles
     where lower(username) = lower(trimmed) and user_id <> uid
  ) then
    return jsonb_build_object('ok', false, 'error', 'that username is taken');
  end if;

  update public.profiles
     set username = trimmed
   where user_id = uid
   returning join_n into join_num;

  if not found then
    insert into public.profiles (user_id, username, join_n)
    values (uid, trimmed, nextval('public.profiles_join_n_seq'))
    returning join_n into join_num;
  end if;

  return jsonb_build_object(
    'ok', true, 'username', trimmed, 'join_n', join_num, 'display', trimmed
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'that username is taken');
end;
$$;

revoke execute on function public.app_set_username(text) from public;
revoke execute on function public.app_set_username(text) from anon;
grant execute on function public.app_set_username(text) to authenticated;
