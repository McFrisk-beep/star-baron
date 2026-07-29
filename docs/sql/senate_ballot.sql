-- Shared Ballot Initiative — let signed-in barons (Baron Tier ≥ 3) table a bill
-- onto the galaxy-wide world_senate agenda. Run after docs/SENATE_SETUP.md §1.
-- Paste into the Supabase SQL Editor and Run.
--
-- The client (js/senateworld.js) calls app_senate_ballot(); until this is applied
-- tabling in shared play fails with a clear "clerks aren't accepting ballots" toast.

-- Attribution columns (cron-authored bills leave these null)
alter table public.world_senate
  add column if not exists proposed_by uuid references auth.users(id) on delete set null;
alter table public.world_senate
  add column if not exists proposed_label text;
create index if not exists world_senate_proposed_by_idx
  on public.world_senate (proposed_by) where proposed_by is not null;

create or replace function public.app_senate_ballot(
  p_edict_id text,
  p_target   text default null
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
  ballot_min constant int := 3;
  cost constant bigint := 250000;
  credits bigint;
  open_mine int;
  recent int;
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
  scope text; typ text; mag numeric; issue text;
  target text := ''; pct text := ''; effect jsonb := '{}'::jsonb;
  c text; cm jsonb; f text; ttl text; blb text;
  next_vote timestamptz; ends timestamptz;
  new_id bigint; sig text; taken boolean;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if p_edict_id is null or length(p_edict_id) > 64 then
    return jsonb_build_object('ok', false, 'error', 'invalid edict');
  end if;

  -- Prefer authoritative prestige tier when Phase 1 players row exists.
  begin
    select coalesce((state->'prestige'->>'tier')::int, 0),
           coalesce((state->>'credits')::bigint, 0)
      into tier, credits
      from public.players where user_id = uid;
  exception when undefined_table then
    tier := ballot_min; credits := null;   -- legacy saves: client already gated + charged
  end;
  if tier is null then tier := ballot_min; end if;   -- no players row yet → trust client gate
  if tier < ballot_min then
    return jsonb_build_object('ok', false, 'error', 'Baron Tier ' || ballot_min || ' required');
  end if;

  -- Rate limits: one open ballot per baron; one table per 24h; cap player noise on the docket.
  select count(*) into open_mine from public.world_senate
   where proposed_by = uid and votes_at > now();
  if open_mine > 0 then
    return jsonb_build_object('ok', false, 'error', 'you already have a bill on the docket');
  end if;
  select count(*) into recent from public.world_senate
   where proposed_by = uid and created_at > now() - interval '24 hours';
  if recent > 0 then
    return jsonb_build_object('ok', false, 'error', 'ballot cooldown — try again tomorrow');
  end if;
  select count(*) into open_player from public.world_senate
   where proposed_by is not null and votes_at > now();
  if open_player >= 3 then
    return jsonb_build_object('ok', false, 'error', 'the docket is full of ballot initiatives');
  end if;

  for i in 0 .. jsonb_array_length(tpls)-1 loop
    if tpls->i->>'id' = p_edict_id then tpl := tpls->i; found := true; exit; end if;
  end loop;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'that measure cannot be tabled');
  end if;

  typ := tpl->>'type'; scope := tpl->>'scope'; mag := coalesce((tpl->>'mag')::numeric, 0);
  issue := tpl->>'issue';

  if scope = 'cat' then
    c := lower(coalesce(nullif(btrim(p_target), ''), ''));
    if c <> all (cats) then
      return jsonb_build_object('ok', false, 'error', 'pick a valid commodity class');
    end if;
    target := initcap(c);
    if typ = 'priceCap' then effect := jsonb_build_object('type','priceCap','cat',c,'mult', round((1-(1-mag))::numeric,3)); pct := round((1-mag)*100)::text || '%';
    elsif typ = 'subsidy' then effect := jsonb_build_object('type','subsidy','cat',c,'mult', round(mag::numeric,3)); pct := round((mag-1)*100)::text || '%';
    elsif typ = 'tariff' then effect := jsonb_build_object('type','tariff','cat',c,'tax', round(mag::numeric,3)); pct := round(abs(mag)*100)::text || '%';
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
      effect := jsonb_build_object('type','ration','commId', cm->>'id', 'mult', round(mag::numeric,3));
      pct := round((mag-1)*100)::text || '%';
    else
      effect := jsonb_build_object('type', typ, 'commId', cm->>'id');
    end if;
  elsif scope = 'faction' then
    f := lower(coalesce(nullif(btrim(p_target), ''), ''));
    if f = 'all' then target := 'all sectors';
    elsif f = any (facs) then target := fac_names->>f;
    else return jsonb_build_object('ok', false, 'error', 'pick a valid faction'); end if;
    effect := jsonb_build_object('type', typ, 'faction', f, 'add', round(mag::numeric,3));
    pct := round(abs(mag)*100)::text || '%';
  elsif scope = 'safety' then
    effect := jsonb_build_object('type','routeSafety','add', round(mag::numeric,3));
    pct := round(abs(mag)*100)::text || '%';
  elsif scope = 'none' then
    if typ = 'warpGate' then
      effect := jsonb_build_object('type','warpGate','add', round(mag::numeric,4));
      pct := to_char(mag*100,'FM990.0') || '%';
    else
      effect := jsonb_build_object('type', typ, 'add', round(mag::numeric,3));
      pct := round(abs(mag)*100)::text || '%';
    end if;
  else
    return jsonb_build_object('ok', false, 'error', 'unsupported measure');
  end if;

  ttl := replace(replace(tpl->>'title','{TARGET}',target),'{PCT}',pct);
  blb := replace(replace(tpl->>'blurb','{TARGET}',target),'{PCT}',pct);

  -- Dedup against queued bills and still-in-force published outcomes.
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
  -- Slot after the floor bill (same cadence as the daily clerks).
  next_vote := greatest(next_vote, now()) + interval '1 day';
  ends := next_vote + interval '3 days';

  select split_part(coalesce(u.email, 'baron'), '@', 1) into label
    from auth.users u where u.id = uid;
  if label is null or length(label) = 0 then label := 'baron'; end if;
  if length(label) > 24 then label := left(label, 22) || '…'; end if;

  -- Charge when we have an authoritative credits balance.
  if credits is not null then
    if credits < cost then
      return jsonb_build_object('ok', false, 'error', 'Not enough credits to table this bill.');
    end if;
    update public.players
       set state = jsonb_set(state, '{credits}', to_jsonb(credits - cost), true),
           updated_at = now()
     where user_id = uid;
  end if;

  insert into public.world_senate(issue, type, lean, effect, title, blurb, votes_at, ends_at, proposed_by, proposed_label)
  values (issue, typ, 1, effect, ttl, blb, next_vote, ends, uid, label)
  returning id into new_id;

  return jsonb_build_object(
    'ok', true,
    'cost', cost,
    'charged', credits is not null,
    'credits', case when credits is not null then credits - cost else null end,
    'bill', jsonb_build_object(
      'id', new_id,
      'issue', issue, 'type', typ, 'lean', 1,
      'effect', effect, 'title', ttl, 'blurb', blb,
      'votes_at', next_vote, 'ends_at', ends,
      'proposed_by', uid, 'proposed_label', label
    )
  );
end;
$$;

revoke execute on function public.app_senate_ballot(text, text) from public;
revoke execute on function public.app_senate_ballot(text, text) from anon;
grant execute on function public.app_senate_ballot(text, text) to authenticated;
