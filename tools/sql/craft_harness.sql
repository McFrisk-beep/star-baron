-- Minimal stand-in for the Supabase pieces workshop_craft.sql leans on, so the
-- real file can be loaded and exercised against a scratch Postgres.
create schema if not exists app;
create schema if not exists market;
create schema if not exists auth;

create or replace function auth.uid() returns uuid
language sql stable as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;

create table if not exists public.players (
  user_id uuid primary key,
  state jsonb not null,
  updated_ms bigint not null default 0
);

create or replace function app._now_ms() returns bigint
language sql stable as $$ select (extract(epoch from now()) * 1000)::bigint $$;

-- Test hook: freeze "now" so readyAt assertions are deterministic.
create table if not exists app.clock (now_ms bigint);
create or replace function app._now_ms() returns bigint
language sql stable as $$
  select coalesce((select c.now_ms from app.clock c limit 1),
                  (extract(epoch from now()) * 1000)::bigint);
$$;

create or replace function app._lock_state(p_now_ms bigint) returns jsonb
language plpgsql as $$
declare st jsonb;
begin
  select p.state into st from public.players p where p.user_id = auth.uid() for update;
  return st;
end;
$$;

create or replace function app._write_state(p_state jsonb, p_now_ms bigint) returns void
language plpgsql as $$
begin
  insert into public.players (user_id, state, updated_ms)
  values (auth.uid(), p_state, p_now_ms)
  on conflict (user_id) do update set state = excluded.state, updated_ms = excluded.updated_ms;
end;
$$;
