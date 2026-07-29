-- Shared Ballot Initiative — signed-in barons (Baron Tier ≥ 3) table bills onto
-- the galaxy-wide world_senate agenda. Re-run anytime to update the function.
-- Paste into the Supabase SQL Editor and Run (after docs/SENATE_SETUP.md §1).
--
-- Fixes: credits cast used ::bigint on float JSON (e.g. 50032320.9097972) → error.
-- Adds: severity factor, edict length (1–10 days), weekly tier quota, bump-up RPC.

alter table public.world_senate
  add column if not exists proposed_by uuid references auth.users(id) on delete set null;
alter table public.world_senate
  add column if not exists proposed_label text;
-- lean must be numeric so fractional ballot hardness (0.15–1.0) survives
alter table public.world_senate alter column lean type numeric using lean::numeric;
create index if not exists world_senate_proposed_by_idx
  on public.world_senate (proposed_by) where proposed_by is not null;

-- Drop prior overloads so the new signature is the only write path.
drop function if exists public.app_senate_ballot(text, text);
drop function if exists public.app_senate_ballot(text, text, numeric, int);
drop function if exists public.app_senate_ballot_bump(text);

create or replace function public.app_senate_ballot(
  p_edict_id text,
  p_target   text default null,
  p_factor   numeric default 1,
  p_days     int default 3
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  label text;
  tier int := 0;
  is_admin boolean := false;
  ballot_min constant int := 3;
  base_cost constant numeric := 250000;
  factor numeric := greatest(0.5, least(coalesce(p_factor, 1), 2.0));
  days int := greatest(1, least(coalesce(p_days, 3), 10));
  cost bigint;
  credits numeric;
  week_used int;
  week_quota int;
  open_player int;
  tpls jsonb := '[
    {"id":"price_control","issue":"trade","type":"priceCap","scope":"cat","mag":0.8,"title":"{TARGET} Price Control Act","blurb":"Caps {TARGET} prices across the exchange — about {PCT} below their drift."},
    {"id":"tariff","issue":"tax","type":"tariff","scope":"cat","mag":0.1,"title":"{TARGET} Tariff","blurb":"Levies a {PCT} duty on every {TARGET} trade, both ways."},
    {"id":"warp_gate","issue":"subsidy","type":"warpGate","scope":"none","mag":0.015,"title":"Warp-Lane Standardization","blurb":"Standardised warp gates speed every ship about {PCT} faster between systems."},
    {"id":"subsidy","issue":"subsidy","type":"subsidy","scope":"cat","mag":1.18,"title":"{TARGET} Subsidy","blurb":"Props {TARGET} prices up about {PCT} above their drift."},
    {"id":"tax_holiday","issue":"subsidy","type":"taxHoliday","scope":"faction","mag":-0.07,"title":"{TARGET} Tax Holiday","blurb":"Cuts offworld industry tax {PCT} on {TARGET} holdings."},
    {"id":"trade_relief","issue":"trade","type":"tariff","scope":"cat","mag":-0.08,"title":"{TARGET} Free-Trade Act","blurb":"Waives duties on {TARGET} — about {PCT} better on every trade, both ways."},
    {"id":"windfall_tax","issue":"tax","type":"windfall","scope":"none","mag":0.06,"title":"Windfall Levy","blurb":"An antitrust surtax skims about {PCT} off the top barons'' trade and route profits."},
    {"id":"convoy_act","issue":"borders","type":"routeSafety","scope":"safety","mag":0.4,"title":"Convoy Escort Mandate","blurb":"Naval escorts ride the trade lanes — automated routes run about {PCT} safer from raids."},
    {"id":"rationing","issue":"trade","type":"ration","scope":"comm","mag":1.3,"title":"{TARGET} Emergency Rationing","blurb":"Mandatory stockpiling of {TARGET} spikes demand — prices sit about {PCT} above their drift until repeal."},
    {"id":"salvage_act","issue":"subsidy","type":"salvage","scope":"none","mag":0.3,"title":"Salvage Rights Act","blurb":"Opened salvage claims enrich survey debriefs — expedition payouts run about {PCT} higher."},
    {"id":"prohibition","issue":"prohibition","type":"ban","scope":"comm","mag":0,"title":"{TARGET} Prohibition","blurb":"Outlaws all buying and selling of {TARGET} in senate space."}
  ]'::jsonb;
  cats text[] := array['mineral','gas','agri','tech','luxury','illicit'];
  comms jsonb := '[{"id":"iron_ore","name":"Iron Ore"},{"id":"silicon","name":"Silicon"},{"id":"rare_earths","name":"Rare Earths"},{"id":"hydrogen","name":"Hydrogen"},{"id":"helium3","name":"Helium-3"},{"id":"water_ice","name":"Water Ice"},{"id":"foodstuffs","name":"Foodstuffs"},{"id":"synthsilk","name":"Synthsilk"},{"id":"nanochips","name":"Nanochips"},{"id":"antimatter","name":"Antimatter"},{"id":"spice","name":"Spice"},{"id":"contraband","name":"Contraband"}]'::jsonb;
  facs text[] := array['syndicate','mining_combine','free_trade','agri_collective'];
  fac_names jsonb := '{"syndicate":"The Syndicate","mining_combine":"Mining Combine","free_trade":"Free-Trade League","agri_collective":"Agri-Collective"}'::jsonb;
  tpl jsonb; i int; found boolean := false;
  scope text; typ text; mag numeric; issue text; binary boolean;
  target text := ''; pct text := ''; effect jsonb := '{}'::jsonb;
  c text; cm jsonb; f text; ttl text; blb text;
  next_vote timestamptz; ends timestamptz;
  new_id bigint; sig text; taken boolean;
  lean_v numeric; sev_mult numeric;
  host_sev numeric; host_dur numeric; host_hard numeric;
  join_num bigint;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if p_edict_id is null or length(p_edict_id) > 64 then
    return jsonb_build_object('ok', false, 'error', 'invalid edict');
  end if;

  begin
    select coalesce((role = 'admin'), false) into is_admin
      from public.profiles where user_id = uid;
  exception when undefined_table then
    is_admin := false;
  end;
  if is_admin is null then is_admin := false; end if;

  -- floor() so float credits like 50032320.9097972 don't blow up ::bigint
  begin
    select coalesce((state->'prestige'->>'tier')::int, 0),
           floor(coalesce((state->>'credits')::numeric, 0))
      into tier, credits
      from public.players where user_id = uid;
  exception when undefined_table then
    tier := ballot_min; credits := null;
  when others then
    -- malformed credits JSON — treat as unreadable; client will charge
    tier := ballot_min; credits := null;
  end;
  if tier is null then tier := ballot_min; end if;
  if tier < ballot_min and not is_admin then
    return jsonb_build_object('ok', false, 'error', 'Baron Tier ' || ballot_min || ' required');
  end if;

  -- Weekly quota: tier pairs 3–4 → 1, 5–6 → 2, … ; Cosmocrat (last tier) gets +1.
  -- Admins unlimited. (ponytail: galaxy docket still hard-capped below — whales can't flood it.)
  week_quota := greatest(0, (tier - ballot_min) / 2 + 1);
  if tier >= 6 then week_quota := week_quota + 1; end if;   -- last Baron Tier (Cosmocrat)
  select count(*) into week_used from public.world_senate
   where proposed_by = uid and created_at > now() - interval '7 days';
  if not is_admin and week_used >= week_quota then
    return jsonb_build_object('ok', false, 'error', 'weekly ballot limit reached (' || week_used || '/' || week_quota || ')');
  end if;

  -- ponytail: shared open-ballot cap (not per-baron); raise if the chamber feels empty under weekly quotas
  select count(*) into open_player from public.world_senate
   where proposed_by is not null and votes_at > now();
  if open_player >= 8 then
    return jsonb_build_object('ok', false, 'error', 'the docket is full of ballot initiatives');
  end if;

  for i in 0 .. jsonb_array_length(tpls)-1 loop
    if tpls->i->>'id' = p_edict_id then tpl := tpls->i; found := true; exit; end if;
  end loop;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'that measure cannot be tabled');
  end if;

  typ := tpl->>'type'; scope := tpl->>'scope';
  mag := coalesce((tpl->>'mag')::numeric, 0);   -- template base; factor applied per-type below
  issue := tpl->>'issue';
  binary := typ in ('ban', 'shipBan');
  if binary then factor := 1; end if;

  -- Cost: base × severity × (days/3). Binary bans only scale with duration.
  sev_mult := case when binary then 1.0 else (0.5 + factor) end;
  cost := greatest(1, round(base_cost * sev_mult * (days::numeric / 3.0)))::bigint;

  -- Stronger / longer ballots: hostility = 0.55·sev + 0.45·dur + 0.30·sev·dur;
  -- lean = 1 − hostility (mirrors Senate.ballotLean). Client _vote then treats
  -- lean < 1 on proposedBy bills as a nay-bias, so sentiment scales down.
  if binary then host_sev := 0.45; else host_sev := greatest(0, least(1, (factor - 0.5) / 1.5)); end if;
  host_dur := greatest(0, least(1, (days - 1)::numeric / 9.0));
  host_hard := least(1.0, 0.55 * host_sev + 0.45 * host_dur + 0.30 * host_sev * host_dur);
  lean_v := greatest(0.12, least(1.0, 1.0 - host_hard));

  if scope = 'cat' then
    c := lower(coalesce(nullif(btrim(p_target), ''), ''));
    if c <> all (cats) then
      return jsonb_build_object('ok', false, 'error', 'pick a valid commodity class');
    end if;
    target := initcap(c);
    if typ = 'priceCap' then
      effect := jsonb_build_object('type','priceCap','cat',c,'mult', round((1 - (1 - mag) * factor)::numeric, 3));
      pct := round(((1 - mag) * factor) * 100)::text || '%';
    elsif typ = 'subsidy' then
      effect := jsonb_build_object('type','subsidy','cat',c,'mult', round((1 + (mag - 1) * factor)::numeric, 3));
      pct := round(((mag - 1) * factor) * 100)::text || '%';
    elsif typ = 'tariff' then
      effect := jsonb_build_object('type','tariff','cat',c,'tax', round((mag * factor)::numeric, 3));
      pct := round(abs(mag * factor) * 100)::text || '%';
    elsif typ = 'ban' then effect := jsonb_build_object('type','ban','cat',c);
    else return jsonb_build_object('ok', false, 'error', 'unsupported measure'); end if;
  elsif scope = 'comm' then
    cm := null;
    for i in 0 .. jsonb_array_length(comms)-1 loop
      if comms->i->>'id' = p_target then cm := comms->i; exit; end if;
    end loop;
    if cm is null then
      return jsonb_build_object('ok', false, 'error', 'pick a valid commodity');
    end if;
    target := cm->>'name';
    if typ = 'ration' then
      effect := jsonb_build_object('type','ration','commId', cm->>'id', 'mult', round((1 + (mag - 1) * factor)::numeric, 3));
      pct := round(((mag - 1) * factor) * 100)::text || '%';
    else
      effect := jsonb_build_object('type', typ, 'commId', cm->>'id');
    end if;
  elsif scope = 'faction' then
    f := lower(coalesce(nullif(btrim(p_target), ''), ''));
    if f = 'all' then target := 'all sectors';
    elsif f = any (facs) then target := fac_names->>f;
    else return jsonb_build_object('ok', false, 'error', 'pick a valid faction'); end if;
    effect := jsonb_build_object('type', typ, 'faction', f, 'add', round((mag * factor)::numeric, 3));
    pct := round(abs(mag * factor) * 100)::text || '%';
  elsif scope = 'safety' then
    effect := jsonb_build_object('type','routeSafety','add', round((mag * factor)::numeric, 3));
    pct := round(abs(mag * factor) * 100)::text || '%';
  elsif scope = 'none' then
    if typ = 'warpGate' then
      effect := jsonb_build_object('type','warpGate','add', round((mag * factor)::numeric, 4));
      pct := to_char(mag * factor * 100, 'FM990.0') || '%';
    else
      effect := jsonb_build_object('type', typ, 'add', round((mag * factor)::numeric, 3));
      pct := round(abs(mag * factor) * 100)::text || '%';
    end if;
  else
    return jsonb_build_object('ok', false, 'error', 'unsupported measure');
  end if;

  ttl := replace(replace(tpl->>'title','{TARGET}',target),'{PCT}',pct);
  blb := replace(replace(tpl->>'blurb','{TARGET}',target),'{PCT}',pct);

  sig := coalesce(effect->>'type','') || ':' || coalesce(effect->>'cat', effect->>'commId', effect->>'faction', effect->>'cls', '');
  select exists (
    select 1 from public.world_senate ws
     where ws.votes_at > now()
       and coalesce(ws.effect->>'type','') || ':' || coalesce(ws.effect->>'cat', ws.effect->>'commId', ws.effect->>'faction', ws.effect->>'cls', '') = sig
  ) into taken;
  if not taken then
    select exists (
      select 1 from public.world_senate_result wr
       where wr.status = 'passed' and wr.effect is not null
         and (wr.ends_at is null or wr.ends_at > now())
         and coalesce(wr.effect->>'type','') || ':' || coalesce(wr.effect->>'cat', wr.effect->>'commId', wr.effect->>'faction', wr.effect->>'cls', '') = sig
    ) into taken;
  end if;
  if taken then
    return jsonb_build_object('ok', false, 'error', 'that measure is already on the books or docketed');
  end if;

  select coalesce(max(votes_at), now()) into next_vote
    from public.world_senate where votes_at > now();
  next_vote := greatest(next_vote, now()) + interval '1 day';
  ends := next_vote + (days || ' days')::interval;

  -- Prefer custom username; else Baron #<join_n>; else email local-part.
  begin
    select nullif(btrim(p.username), ''), p.join_n
      into label, join_num
      from public.profiles p where p.user_id = uid;
  exception when undefined_column then
    label := null; join_num := null;
  when others then
    label := null; join_num := null;
  end;
  if label is null or length(label) = 0 then
    if join_num is not null then
      label := 'Baron #' || join_num;
    else
      select split_part(coalesce(u.email, 'baron'), '@', 1) into label
        from auth.users u where u.id = uid;
      if label is null or length(label) = 0 then label := 'baron'; end if;
    end if;
  end if;
  if length(label) > 24 then label := left(label, 22) || '…'; end if;

  if credits is not null then
    if credits < cost then
      return jsonb_build_object('ok', false, 'error', 'Not enough credits to table this bill.');
    end if;
    update public.players
       set state = jsonb_set(state, '{credits}', to_jsonb((credits - cost)::bigint), true),
           updated_at = now()
     where user_id = uid;
  end if;

  insert into public.world_senate(issue, type, lean, effect, title, blurb, votes_at, ends_at, proposed_by, proposed_label)
  values (issue, typ, lean_v, effect, ttl, blb, next_vote, ends, uid, label)
  returning id into new_id;

  return jsonb_build_object(
    'ok', true,
    'cost', cost,
    'charged', credits is not null,
    'credits', case when credits is not null then (credits - cost)::bigint else null end,
    'week_used', week_used + 1,
    'week_quota', case when is_admin then null else week_quota end,
    'bill', jsonb_build_object(
      'id', new_id,
      'issue', issue, 'type', typ, 'lean', lean_v,
      'effect', effect, 'title', ttl, 'blurb', blb,
      'votes_at', next_vote, 'ends_at', ends,
      'proposed_by', uid, 'proposed_label', label,
      'edict_days', days, 'factor', factor
    )
  );
end;
$$;

-- Pay to swap this ballot one slot earlier on the shared docket.
create or replace function public.app_senate_ballot_bump(p_bill_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  is_admin boolean := false;
  bump_cost constant bigint := 100000;
  credits numeric;
  bill_num bigint;
  my_id bigint;
  my_at timestamptz;
  prev_id bigint;
  prev_at timestamptz;
  prev_ends timestamptz;
  my_ends timestamptz;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  begin
    select coalesce((role = 'admin'), false) into is_admin from public.profiles where user_id = uid;
  exception when undefined_table then is_admin := false; end;
  if is_admin is null then is_admin := false; end if;

  begin
    bill_num := nullif(regexp_replace(coalesce(p_bill_id, ''), '\D', '', 'g'), '')::bigint;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'invalid bill');
  end;
  if bill_num is null then
    return jsonb_build_object('ok', false, 'error', 'invalid bill');
  end if;

  -- Identify the two rows, then lock them in id order (avoids deadlock + lost swaps).
  select id, votes_at, ends_at into my_id, my_at, my_ends
    from public.world_senate
   where id = bill_num and votes_at > now()
     and (proposed_by = uid or is_admin);
  if my_id is null then
    return jsonb_build_object('ok', false, 'error', 'bill not on the docket (or not yours)');
  end if;

  select id into prev_id
    from public.world_senate
   where votes_at > now() and votes_at < my_at
   order by votes_at desc, id desc
   limit 1;
  if prev_id is null then
    return jsonb_build_object('ok', false, 'error', 'already first on the docket');
  end if;

  -- Lock both bills ascending by id, then re-read times under the locks.
  perform 1 from public.world_senate where id in (my_id, prev_id) order by id for update;

  select votes_at, ends_at into my_at, my_ends from public.world_senate where id = my_id;
  select votes_at, ends_at into prev_at, prev_ends from public.world_senate where id = prev_id;
  if my_at is null or prev_at is null or not (my_at > now() and prev_at > now()) then
    return jsonb_build_object('ok', false, 'error', 'bill left the docket — try again');
  end if;
  -- Still neighbors? Another bump may have reshuffled between identify and lock.
  if exists (
    select 1 from public.world_senate
     where votes_at > now() and votes_at > prev_at and votes_at < my_at
  ) then
    return jsonb_build_object('ok', false, 'error', 'docket changed — try again');
  end if;

  begin
    select floor(coalesce((state->>'credits')::numeric, 0)) into credits
      from public.players where user_id = uid;
  exception when others then credits := null; end;

  if credits is not null then
    if credits < bump_cost then
      return jsonb_build_object('ok', false, 'error', 'Not enough credits to move this bill up.');
    end if;
    update public.players
       set state = jsonb_set(state, '{credits}', to_jsonb((credits - bump_cost)::bigint), true),
           updated_at = now()
     where user_id = uid;
  end if;

  -- Swap vote times (keep each bill's planned edict length relative to its vote).
  update public.world_senate set votes_at = prev_at,
    ends_at = case when my_ends is not null and my_at is not null
      then prev_at + (my_ends - my_at) else ends_at end
   where id = my_id;
  update public.world_senate set votes_at = my_at,
    ends_at = case when prev_ends is not null and prev_at is not null
      then my_at + (prev_ends - prev_at) else ends_at end
   where id = prev_id;

  return jsonb_build_object(
    'ok', true, 'cost', bump_cost, 'charged', credits is not null,
    'credits', case when credits is not null then (credits - bump_cost)::bigint else null end,
    'bill_id', my_id, 'swapped_with', prev_id
  );
end;
$$;

revoke execute on function public.app_senate_ballot(text, text, numeric, int) from public;
revoke execute on function public.app_senate_ballot(text, text, numeric, int) from anon;
grant execute on function public.app_senate_ballot(text, text, numeric, int) to authenticated;

revoke execute on function public.app_senate_ballot_bump(text) from public;
revoke execute on function public.app_senate_ballot_bump(text) from anon;
grant execute on function public.app_senate_ballot_bump(text) to authenticated;
