-- piracy_rpcs.sql — server-side player piracy and the police response
-- (docs/SPACE_INTERACTIVITY.md §4 and §5.1/§5.2).
--
-- THE PROBLEM
-- Piracy shipped client-local, exactly as mining did before mining_rpcs.sql.
-- Loot is minted into `positions`, tolls and escort fees into `credits`, and
-- app_commit forces both from the server row — so a signed-in baron's take
-- evaporated on the next autosave. Piracy.canStart knew it and refused to
-- dispatch at all unless Economy.softIncomeLocal(), which meant build step 4
-- (player piracy) and the police response built on top of it were guest-only
-- content. A signed-in player clicked a hauler and got a gate message.
--
-- THE FIX — the shape _catchup_mining already uses, not a new one.
--   app._catchup_piracy — resolves intercepts on the SERVER clock inside
--                         app_pull: the fight, the loot, tolls and escort pay,
--                         hull damage, crime, standing, the §4.2 shelf drain,
--                         the police chase, and the hull landing home.
--   app._merge_piracy   — new dispatches merge from the client (dispatch is
--                         free, so there is nothing to validate a payment
--                         against and no dispatch RPC); the server owns every
--                         timer and every outcome once the op exists.
--   app._merge_hot      — the stolen-goods flag may only ever go DOWN from the
--                         client (selling or a customs seizure sheds it). It
--                         only ever goes UP here, when a raider lands.
-- and app_commit / app_pull / result_slice grow the piracy slices.
--
-- TRUST MODEL — identical in stance to mining_rpcs.sql.
-- The op row carries four numbers the server cannot derive: `chance` (the
-- odds), `value` (the manifest's worth at its destination), `atk` (the hull's
-- attack score) and `law` (the security score where the robbery happened).
-- All four are computed by the client at dispatch — it owns the seeded traffic
-- pipeline, the live station tables that move a security band, and its own
-- accessory/refit fitment, none of which the server models — and all four are
-- CLAMPED here against the server's ship catalog and the PIRACYCFG bands.
-- Bounded at roughly "best possible legitimate fleet", not infinity.
--
-- WHY THE ODDS RIDE ON THE OP
-- Same reason raiders.js rolls against op.threat: it lets this file reproduce
-- a fight EXACTLY — same seed, same draw order — instead of porting the
-- traffic generator and the security bands to SQL and watching them drift.
-- tools/check_piracy_parity.js pins the two implementations together. It also
-- means you accepted a quoted risk when you dispatched: an edict passed an
-- hour later does not retroactively re-roll a fight already in flight.
--
-- ANTI-GRIEF (§6.6) HOLDS ON THE LEDGER TOO
-- The worst outcome is losing the cargo you just stole plus a repair bill. A
-- chase never destroys a hull, never impounds one, and never touches banked
-- positions or credits. Being caught returns the stolen units to the shelf
-- they were bound for — the delivery arrives late rather than never.
--
-- Apply LAST — after mining_rpcs.sql and every other file that declares
-- app_commit. This file's app_commit / result_slice / app_pull extend those
-- layers, and whichever copy is pasted last wins. Requires market_price.sql
-- (seeded RNG), phase2_missions_bazaar.sql (app.ship_def) and
-- phase4_sector_stock.sql (the shelf). Safe to re-run. Then re-run
-- docs/sql/commit_allowlist.sql if you keep it applied last — its allowlist
-- now carries 'piracy', 'piracyHits' and 'hot'.
--
-- Client: js/piracy.js stamps chance/value/atk/law at dispatch, js/cloud.js
-- sends the three keys (Cloud.WIRE_KEYS), and tools/check_cloud_egress.js pins
-- the wire to the allowlist.

-- ===========================================================================
-- The bounds: what a hull could legitimately bring to a fight
-- ===========================================================================

-- Charters.defenseScore is firepower*3 + hull*1 + armor*2 + shields*2, but
-- app.ship_def predates the armor/shields columns. Rather than re-paste a
-- 1300-line catalog, bound the score from the two columns it does carry and
-- allow generously for the rest plus a full accessory fit. A player who
-- overstates `atk` gains nothing beyond this ceiling; understating it only
-- makes the police harder, which is not an exploit worth chasing.
create or replace function app._piracy_atk_cap(p_ship jsonb)
returns double precision
language plpgsql stable as $$
declare
  d record;
begin
  if p_ship is null then return 0; end if;
  select * into d from app.ship_def(p_ship->>'type');
  if d.id is null then return 0; end if;
  return (coalesce(d.firepower, 0) * 3.0 + coalesce(d.hull, 0)) * 2.5;
end;
$$;

-- ===========================================================================
-- The fight: a pure function of the op, mirroring Piracy.rollOutcome
-- ===========================================================================
create or replace function app._piracy_outcome(p_op jsonb, p_atk_cap double precision)
returns jsonb
language plpgsql immutable as $$
declare
  s bigint;
  verb text := coalesce(p_op->>'verb', 'rob');
  chance double precision := least(greatest(coalesce((p_op->>'chance')::float8, 0), 0.05), 0.9);
  val double precision := greatest(coalesce((p_op->>'value')::float8, 0), 0);
  cargo double precision := greatest(coalesce((p_op->>'cargo')::float8, 0), 0);
  kind text := coalesce(p_op->>'kind', 'trader');
  lo double precision;
  hi double precision;
  manifest jsonb := coalesce(p_op->'manifest', '[]'::jsonb);
  loot jsonb := '{}'::jsonb;
  won boolean;
  credits double precision := 0;
  dmg double precision := 0;
  qty int;
  total int := 0;
  i int;
  cid text;
  k double precision;
begin
  s := market.seed_hash('cosmocrat-market-v1', 'piracy', p_op->>'id');

  -- Escort is lawful work: no fight to roll, a fee against the manifest.
  if verb = 'escort' then
    return jsonb_build_object('verb', verb, 'won', true, 'loot', null,
      'credits', round((0.10 + market.u01(s, 1) * 0.06) * val),
      'dmg', 0::float8);
  end if;

  won := market.u01(s, 0) < chance;
  if not won then
    return jsonb_build_object('verb', verb, 'won', false, 'loot', null,
      'credits', 0::float8, 'dmg', 0.04 + market.u01(s, 1) * 0.08);
  end if;

  if verb = 'toll' then
    return jsonb_build_object('verb', verb, 'won', true, 'loot', null,
      'credits', round((0.16 + market.u01(s, 1) * 0.14) * val),
      'dmg', 0::float8);
  end if;

  -- Rob: PIRACYCFG.lootQty per manifest commodity, capped by the hold flown.
  if kind = 'freighter' then lo := 10; hi := 22; else lo := 4; hi := 10; end if;
  i := 0;
  for cid in select t.v from jsonb_array_elements_text(manifest) t(v) loop
    qty := greatest(1, round(lo + market.u01(s, 2 + i) * (hi - lo))::int);
    loot := jsonb_set(loot, array[cid],
      to_jsonb(coalesce((loot->>cid)::int, 0) + qty), true);
    total := total + qty;
    i := i + 1;
  end loop;
  if cargo > 0 and total > cargo then
    k := cargo / total;
    loot := (select coalesce(jsonb_object_agg(e.key,
        to_jsonb(greatest(1, floor((e.value#>>'{}')::int * k)::int))), '{}'::jsonb)
      from jsonb_each(loot) e);
  end if;
  return jsonb_build_object('verb', verb, 'won', true, 'loot', loot,
    'credits', 0::float8, 'dmg', 0::float8);
end;
$$;

-- ===========================================================================
-- The chase: a pure function of the op, mirroring Police.pursue
-- ===========================================================================
-- Returns null when no response forms. The caller applies the ledger effects;
-- everything decided here is decided from (op, atk) alone.
create or replace function app._police_chase(p_op jsonb, p_atk double precision)
returns jsonb
language plpgsql immutable as $$
declare
  s bigint;
  law double precision := least(greatest(coalesce((p_op->>'law')::float8, 0), 0), 1);
  waves int := 0;
  destroyed int := 0;
  caught boolean := false;
  escaped boolean := false;
  got_item boolean := false;
  dmg double precision := 0;
  crime double precision := 0;
  w int;
  base int;
  def double precision;
  p_destroy double precision;
  p_catch double precision;
begin
  s := market.seed_hash('cosmocrat-market-v1', 'police', p_op->>'id');
  -- POLICECFG.responseBase 0.9, clamped to responseClamp [0, 0.95].
  if market.u01(s, 0) >= least(greatest(0.9 * law, 0), 0.95) then return null; end if;

  for w in 0..2 loop                      -- POLICECFG.maxWaves = 3
    base := 1 + w * 4;
    waves := waves + 1;
    -- pairScore 700 x (1 + law x lawScore 1.4) x waveMult 1.6^w
    def := 700.0 * (1 + law * 1.4) * power(1.6, w);
    p_destroy := least(greatest(p_atk / nullif(p_atk + def, 0), 0.02), 0.75);
    if market.u01(s, base) < p_destroy then
      destroyed := destroyed + 1;
      crime := crime + 25;                -- CRIMECFG.gain.police
      dmg := dmg + (0.06 + market.u01(s, base + 1) * 0.10);
      if not got_item and market.u01(s, base + 2) < 0.2 then got_item := true; end if;
      continue;
    end if;
    p_catch := least(greatest(def / nullif(def + p_atk, 0) * 1.1, 0.1), 0.92);
    if market.u01(s, base + 3) < p_catch then
      caught := true;
      dmg := dmg + (0.06 + market.u01(s, base + 1) * 0.10);
      exit;
    end if;
    escaped := true;
    exit;
  end loop;
  if not caught and not escaped then escaped := true; end if;   -- broke every wave

  return jsonb_build_object(
    'waves', waves, 'destroyed', destroyed, 'caught', caught, 'escaped', escaped,
    'item', got_item, 'dmg', dmg, 'crime', crime);
end;
$$;

-- ===========================================================================
-- Ledger helpers: hull custody and damage, mirroring the client's bookkeeping
-- ===========================================================================
create or replace function app._piracy_set_status(p_ships jsonb, p_uid text, p_status text)
returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(
    case when s.value->>'uid' = p_uid then jsonb_set(s.value, '{status}', to_jsonb(p_status))
    else s.value end), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) s(value);
$$;

-- DMGCFG.maxDmg 0.95 — a chase damages, it never destroys (§6.6.5).
create or replace function app._piracy_damage(p_ships jsonb, p_uid text, p_frac double precision)
returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(
    case when s.value->>'uid' = p_uid then jsonb_set(s.value, '{dmg}',
      to_jsonb(least(greatest(coalesce((s.value->>'dmg')::float8, 0) + p_frac, 0), 0.95)))
    else s.value end), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) s(value);
$$;

-- ===========================================================================
-- The catch-up: resolve intercepts on the SERVER clock (mirrors Piracy.resolve)
-- ===========================================================================
-- This is what makes piracy work for a signed-in baron who dispatches and
-- closes the tab. p_now_ms is float8 for the same reason mining's is: JS
-- timestamps on these rows carry a fractional travelMs.
create or replace function app._catchup_piracy(p_state jsonb, p_now_ms double precision)
returns jsonb
language plpgsql as $$
declare
  st jsonb := p_state;
  ops jsonb := '[]'::jsonb;
  runs jsonb := '[]'::jsonb;          -- the away-slice the client recaps
  hits jsonb;
  positions jsonb;
  avg_cost jsonb;
  hot jsonb;
  ships jsonb;
  items jsonb;
  rep jsonb;
  credits double precision;
  crime double precision;
  seq int;
  op jsonb;
  sh jsonb;
  outcome jsonb;
  chase jsonb;
  loot jsonb;
  entry jsonb;
  op_n int := 0;
  atk double precision;
  atk_cap double precision;
  gain double precision;
  dmg double precision;
  sector text;
  e record;
  held double precision;
  prev_avg double precision;
  qty int;
  item_uid text;
  got_item boolean;
begin
  positions := coalesce(st->'positions', '{}'::jsonb);
  avg_cost := coalesce(st->'avgCost', '{}'::jsonb);
  hot := coalesce(st->'hot', '{}'::jsonb);
  ships := coalesce(st->'ships', '[]'::jsonb);
  items := coalesce(st->'items', '{}'::jsonb);
  rep := coalesce(st->'reputation', '{}'::jsonb);
  hits := coalesce(st->'piracyHits', '[]'::jsonb);
  credits := coalesce((st->>'credits')::float8, 0);
  crime := coalesce((st->>'crime')::float8, 50);
  seq := coalesce((st->>'seq')::int, 1);

  for op in select value from jsonb_array_elements(coalesce(st->'piracy', '[]'::jsonb)) loop
    op_n := op_n + 1;
    -- PIRACYCFG.maxOps — forged extras are dropped, not merely idled.
    if op_n > 2 then continue; end if;

    select value into sh from jsonb_array_elements(ships) x(value)
      where x.value->>'uid' = op->>'shipUid' limit 1;
    -- Hull gone (sold, lost, never existed): close the op out.
    if sh is null then continue; end if;

    -- The fight, once, when the intercept matures.
    if not coalesce((op->>'resolved')::boolean, false)
       and p_now_ms >= coalesce((op->>'resolveAt')::float8, 0) then
      atk_cap := app._piracy_atk_cap(sh);
      atk := least(greatest(coalesce((op->>'atk')::float8, 0), 0), atk_cap);
      outcome := app._piracy_outcome(op, atk_cap);
      op := jsonb_set(op, '{resolved}', 'true'::jsonb);

      dmg := coalesce((outcome->>'dmg')::float8, 0);
      credits := credits + coalesce((outcome->>'credits')::float8, 0);
      loot := case when outcome->'loot' = 'null'::jsonb then null else outcome->'loot' end;

      -- CRIMECFG.gain: piracy 12 / piracyFail 6 / toll 4. Escort is lawful.
      gain := case
        when op->>'verb' = 'rob' then case when (outcome->>'won')::boolean then 12 else 6 end
        when op->>'verb' = 'toll' then 4 else 0 end;

      -- PIRACYCFG.rep — standing swings only on a verb that landed.
      if (outcome->>'won')::boolean then
        if op->>'verb' = 'rob' then
          rep := app._piracy_rep(rep, 'free_trade', -3);
          rep := app._piracy_rep(rep, 'syndicate', 2);
        elsif op->>'verb' = 'toll' then
          rep := app._piracy_rep(rep, 'free_trade', -1);
          rep := app._piracy_rep(rep, 'syndicate', 1);
        elsif op->>'verb' = 'escort' then
          rep := app._piracy_rep(rep, 'free_trade', 3);
        end if;
      end if;

      got_item := false;
      chase := null;
      if loot is not null then
        -- §4.2: the delivery never arrives — the destination sector's shelf
        -- loses what the hold now carries. This is the whole point of robbing:
        -- scarcity climbs where the cargo was going.
        op := jsonb_set(op, '{loot}', loot);
        hits := hits || jsonb_build_array(jsonb_build_object(
          'f', op->>'flightId', 'k', coalesce((op->>'loop')::bigint, 0), 'at', p_now_ms::bigint));
        sector := market.sector_of_system(op->>'toSys');
        if sector is not null then
          for e in select key as k, (value#>>'{}')::int as q from jsonb_each(loot) loop
            perform market.ensure_stock_row(sector, e.k);
            update public.sector_stock set units = greatest(0, units - e.q)
              where sector_id = sector and comm_id = e.k;
          end loop;
        end if;

        -- §5.1 response: the law can answer a successful robbery on the way
        -- home (js/police.js). Same seed, same draw order.
        chase := app._police_chase(op, atk);
        if chase is not null then
          dmg := dmg + coalesce((chase->>'dmg')::float8, 0);
          crime := crime + coalesce((chase->>'crime')::float8, 0);
          if coalesce((chase->>'caught')::boolean, false) then
            -- Caught: the stolen units go back on the shelf they were bound
            -- for. Never the hull, never banked stock, never credits.
            if sector is not null then
              for e in select key as k, (value#>>'{}')::int as q from jsonb_each(loot) loop
                update public.sector_stock set units = units + e.q
                  where sector_id = sector and comm_id = e.k;
              end loop;
            end if;
            op := jsonb_set(op, '{loot}', 'null'::jsonb);
            loot := null;
          end if;
          -- The police-only accessory (POLICE_ITEM), minted server-side
          -- because items are server-owned. Inventory full: the wreck burns
          -- with it.
          if coalesce((chase->>'item')::boolean, false) then
            if (select count(*) from jsonb_object_keys(items))
               < coalesce((st->'inventory'->>'capacity')::int, 6) then
              seq := seq + 1;
              item_uid := 'i' || seq;
              items := jsonb_set(items, array[item_uid], jsonb_build_object(
                'uid', item_uid, 'kind', 'reactor', 'rarity', 'legendary',
                'name', 'Senate Enforcement Core', 'police', true,
                'primary', jsonb_build_object('stat', 'firepower', 'amount', 0.45,
                  'pct', true, 'kind', 'reactor'),
                'bonus', jsonb_build_object('stat', 'shields', 'amount', 60,
                  'pct', false, 'kind', 'shield'),
                -- Items.value: 0.45 x 8000 x 30 (legendary) x 1.4 (bonus)
                'value', 151200), true);
              got_item := true;
            end if;
          end if;
        end if;
      end if;

      crime := crime + gain;
      if dmg > 0 then ships := app._piracy_damage(ships, op->>'shipUid', dmg); end if;

      entry := jsonb_build_object(
        'verb', op->>'verb', 'won', (outcome->>'won')::boolean,
        'name', op->>'name', 'kind', op->>'kind', 'sysId', op->>'sysId',
        'fromSys', op->>'fromSys',
        'credits', coalesce((outcome->>'credits')::float8, 0),
        'loot', coalesce(loot, 'null'::jsonb),
        'dmg', dmg, 'crime', gain + coalesce((chase->>'crime')::float8, 0),
        'ship', sh->>'name');
      if chase is not null then
        entry := jsonb_set(entry, '{chase}', chase || jsonb_build_object(
          'item', case when got_item then jsonb_build_object('name', 'Senate Enforcement Core')
                  else 'null'::jsonb end,
          'ship', sh->>'name', 'sysId', op->>'sysId',
          -- The seized count reads the PRE-seizure loot: op.loot is already
          -- nulled out by the time we get here.
          'seized', case when coalesce((chase->>'caught')::boolean, false)
                         and jsonb_typeof(outcome->'loot') = 'object'
                    then (select coalesce(sum((le.value#>>'{}')::int), 0)
                          from jsonb_each(outcome->'loot') le) else 0 end));
      end if;
      runs := runs || jsonb_build_array(entry);
    end if;

    -- Home with the take: bank the loot, flag it hot, free the hull.
    if p_now_ms >= coalesce((op->>'returnAt')::float8, 0)
       and coalesce((op->>'resolved')::boolean, false) then
      if op->'loot' is not null and op->'loot' <> 'null'::jsonb then
        for e in select key as k, (value#>>'{}')::int as q from jsonb_each(op->'loot') loop
          qty := greatest(0, e.q);
          if qty > 0 then
            held := coalesce((positions->>e.k)::float8, 0);
            prev_avg := coalesce((avg_cost->>e.k)::float8, 0);
            positions := jsonb_set(positions, array[e.k], to_jsonb(held + qty), true);
            -- Stolen goods cost nothing: the average drops toward zero.
            avg_cost := jsonb_set(avg_cost, array[e.k],
              to_jsonb(case when held + qty > 0 then (held * prev_avg) / (held + qty) else 0 end), true);
            hot := jsonb_set(hot, array[e.k],
              to_jsonb(coalesce((hot->>e.k)::int, 0) + qty), true);
          end if;
        end loop;
      end if;
      ships := app._piracy_set_status(ships, op->>'shipUid', 'idle');
      continue;                                   -- op is done; drop it
    end if;

    -- Still flying: keep the hull locked to the job.
    ships := app._piracy_set_status(ships, op->>'shipUid', 'raiding');
    ops := ops || jsonb_build_array(op);
  end loop;

  -- PIRACYCFG.hitTtlMs — robbed-run marks outlive any traffic loop, then die.
  hits := (select coalesce(jsonb_agg(h.value), '[]'::jsonb)
    from jsonb_array_elements(hits) h(value)
    where p_now_ms - coalesce((h.value->>'at')::float8, 0) <= 2 * 60 * 60 * 1000);

  st := jsonb_set(st, '{piracy}', ops);
  st := jsonb_set(st, '{piracyHits}', hits);
  st := jsonb_set(st, '{positions}', positions);
  st := jsonb_set(st, '{avgCost}', avg_cost);
  st := jsonb_set(st, '{hot}', hot);
  st := jsonb_set(st, '{ships}', ships);
  st := jsonb_set(st, '{items}', items);
  st := jsonb_set(st, '{reputation}', rep);
  st := jsonb_set(st, '{credits}', to_jsonb(credits));
  st := jsonb_set(st, '{crime}', to_jsonb(least(greatest(crime, 0), 1000)));
  st := jsonb_set(st, '{seq}', to_jsonb(seq));
  return jsonb_build_object('state', st, 'piracy', runs);
end;
$$;

-- Rep.change, clamped to REP.min/max (-100..100).
create or replace function app._piracy_rep(p_rep jsonb, p_faction text, p_delta double precision)
returns jsonb
language sql immutable as $$
  select jsonb_set(coalesce(p_rep, '{}'::jsonb), array[p_faction],
    to_jsonb(least(greatest(coalesce((p_rep->>p_faction)::float8, 0) + p_delta, -100), 100)), true);
$$;

-- ===========================================================================
-- Merges: what the client is allowed to say about its own piracy
-- ===========================================================================
-- New dispatches merge in (dispatch is free — there is no payment to validate
-- and no dispatch RPC), and the server owns the op from then on. Counters are
-- forced so a forged op can never arrive pre-resolved or pre-looted.
create or replace function app._merge_piracy(p_server jsonb, p_client jsonb)
returns jsonb
language plpgsql immutable as $$
declare
  out jsonb := '[]'::jsonb;
  s jsonb;
  c jsonb;
  n int := 0;
begin
  for s in select value from jsonb_array_elements(coalesce(p_server, '[]'::jsonb)) loop
    -- A server op the client dropped was landed locally; keep the server's.
    n := n + 1;
    if n <= 2 then out := out || jsonb_build_array(s); end if;   -- PIRACYCFG.maxOps
  end loop;
  for c in select value from jsonb_array_elements(coalesce(p_client, '[]'::jsonb)) loop
    if not exists (
      select 1 from jsonb_array_elements(coalesce(p_server, '[]'::jsonb)) s2(value)
      where s2.value->>'id' = c->>'id'
    ) then
      n := n + 1;
      if n <= 2 then
        out := out || jsonb_build_array(
          c || jsonb_build_object('resolved', false, 'loot', null, 'outcome', null));
      end if;
    end if;
  end loop;
  return out;
end;
$$;

-- The stolen-goods flag. It only ever goes UP in _catchup_piracy (a raider
-- landing) and only ever DOWN from the client (selling the goods, or customs
-- taking them). Taking the lower of the two lets a client shed a flag it has
-- legitimately spent, and never mint one — or clear one it still owes.
create or replace function app._merge_hot(p_server jsonb, p_client jsonb)
returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
    select e.key as k,
      to_jsonb(greatest(0, least(
        coalesce((e.value#>>'{}')::int, 0),
        coalesce((coalesce(p_client, '{}'::jsonb)->>e.key)::int, 0)))) as v
    from jsonb_each(coalesce(p_server, '{}'::jsonb)) e
  ) merged where (v#>>'{}')::int > 0;
$$;

-- Robbed-run marks are cosmetic (traffic.js draws the emptied hull) and the
-- server stamps them in the catch-up. Accept the client's list only to carry a
-- guest's history in on first commit; bounded so it cannot grow forever.
create or replace function app._merge_piracy_hits(p_server jsonb, p_client jsonb)
returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(x.value), '[]'::jsonb) from (
    select value from jsonb_array_elements(
      case when jsonb_array_length(coalesce(p_server, '[]'::jsonb)) > 0
      then coalesce(p_server, '[]'::jsonb) else coalesce(p_client, '[]'::jsonb) end)
    limit 60
  ) x;
$$;

-- ===========================================================================
-- result_slice + app_commit + app_pull — piracy joins the server-owned slices.
-- The three bodies below are copied VERBATIM from the tail of each chain in
-- docs/sql/mining_rpcs.sql (currently the last file to declare them), plus the
-- piracy lines. Whichever copy an admin pastes LAST wins, which is why this
-- file must be applied after mining_rpcs.sql and why its copies must be the
-- newest — a stale body would silently un-protect whatever the newer one added.
-- tools/check_piracy_parity.js asserts every line of all three sources is
-- still present here.
-- ===========================================================================
create or replace function app.result_slice(p_state jsonb)
returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'ok', true,
    'credits', (p_state->>'credits')::float8,
    'positions', coalesce(p_state->'positions', '{}'::jsonb),
    'avgCost', coalesce(p_state->'avgCost', '{}'::jsonb),
    'ships', coalesce(p_state->'ships', '[]'::jsonb),
    'mainShip', p_state->'mainShip',
    'missions', coalesce(p_state->'missions', '[]'::jsonb),
    'reports', coalesce(p_state->'reports', '[]'::jsonb),
    'items', coalesce(p_state->'items', '{}'::jsonb),
    'inventory', p_state->'inventory',
    'pendingContracts', coalesce(p_state->'pendingContracts', '[]'::jsonb),
    'bazaarBought', coalesce(p_state->'bazaarBought', '[]'::jsonb),
    'seq', coalesce((p_state->>'seq')::int, 1),
    'stats', p_state->'stats',
    'reputation', p_state->'reputation',
    'currentSystem', p_state->>'currentSystem',
    'travel', p_state->'travel',
    'unlockedSystems', p_state->'unlockedSystems',
    'prestige', coalesce(p_state->'prestige', '{"tier":0,"multiplier":1}'::jsonb),
    'routes', coalesce(p_state->'routes', '[]'::jsonb),
    'industries', coalesce(p_state->'industries', '[]'::jsonb),
    'expeditions', coalesce(p_state->'expeditions', '[]'::jsonb),
    'surveyed', coalesce(p_state->'surveyed', '{}'::jsonb),
    'listings', coalesce(p_state->'listings', '[]'::jsonb),
    'extractors', coalesce(p_state->'extractors', '{}'::jsonb),
    'components', coalesce(p_state->'components', '{}'::jsonb),
    'workshop', coalesce(p_state->'workshop', '{"upgrades":0,"queue":[]}'::jsonb),
    'knownRecipes', coalesce(p_state->'knownRecipes', '[]'::jsonb),
    'craftedOnce', coalesce(p_state->'craftedOnce', '[]'::jsonb),
    'workshopAdopt', p_state->'workshopAdopt',
    'charters', coalesce(p_state->'charters', '[]'::jsonb),
    'mining', coalesce(p_state->'mining', '[]'::jsonb),
    'beltPools', coalesce(p_state->'beltPools', '{}'::jsonb),
    -- Piracy (this file). The KEY's presence is what latches
    -- Cloud.piracyOwned on the client, exactly as 'mining' does.
    'piracy', coalesce(p_state->'piracy', '[]'::jsonb),
    'piracyHits', coalesce(p_state->'piracyHits', '[]'::jsonb),
    'hot', coalesce(p_state->'hot', '{}'::jsonb),
    'crime', app._crime_value(p_state),
    'crimeSeenAt', (p_state->>'crimeSeenAt')::bigint,
    'lastSeenAt', (p_state->>'lastSeenAt')::bigint
  );
$$;

create or replace function public.app_commit(p_state jsonb)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  server jsonb;
  merged jsonb;
begin
  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'invalid state');
  end if;

  server := app._lock_state(now_ms);
  merged := p_state;

  -- Topology (Phase 1)
  merged := jsonb_set(merged, '{currentSystem}', server->'currentSystem');
  merged := jsonb_set(merged, '{travel}',
    case when app._in_transit(server) then server->'travel' else 'null'::jsonb end);
  merged := jsonb_set(merged, '{unlockedSystems}', coalesce(server->'unlockedSystems', '[]'::jsonb));

  -- Phase 2 owned slices. Ships: server owns the roster, client owns fitment
  -- (docs/sql/equip_persist.sql).
  merged := jsonb_set(merged, '{ships}', app._merge_ships(
    coalesce(server->'ships', '[]'::jsonb),
    coalesce(p_state->'ships', '[]'::jsonb),
    coalesce(server->'items', '{}'::jsonb)));
  merged := jsonb_set(merged, '{mainShip}', coalesce(server->'mainShip', '{"type":"pinnace"}'::jsonb));
  merged := jsonb_set(merged, '{missions}', coalesce(server->'missions', '[]'::jsonb));
  merged := jsonb_set(merged, '{items}', coalesce(server->'items', '{}'::jsonb));
  merged := jsonb_set(merged, '{inventory}', coalesce(server->'inventory', '{"capacity":6,"upgrades":0}'::jsonb));
  merged := jsonb_set(merged, '{pendingContracts}', coalesce(server->'pendingContracts', '[]'::jsonb));
  merged := jsonb_set(merged, '{bazaarBought}', coalesce(server->'bazaarBought', '[]'::jsonb));
  merged := jsonb_set(merged, '{reputation}', coalesce(server->'reputation', '{}'::jsonb));
  merged := jsonb_set(merged, '{bazaar}', coalesce(server->'bazaar',
    '{"mercs":[],"contracts":[],"accessories":[]}'::jsonb));

  -- Workshop: crafting is server-authoritative (docs/sql/workshop_craft.sql).
  merged := jsonb_set(merged, '{workshop}', coalesce(server->'workshop',
    '{"upgrades":0,"queue":[]}'::jsonb));
  if server ? 'workshopAdopt' then
    merged := jsonb_set(merged, '{workshopAdopt}', server->'workshopAdopt', true);
  else
    merged := merged - 'workshopAdopt';
  end if;

  -- Charters: dispatched/cancelled/resolved via app_charter_* (charter_rpcs.sql).
  merged := jsonb_set(merged, '{charters}', coalesce(server->'charters', '[]'::jsonb));

  -- Phase 3: economy + prestige + catch-up timers (server is source of truth)
  if coalesce((p_state->>'credits')::float8, 0) < coalesce((server->>'credits')::float8, 0) then
    merged := jsonb_set(merged, '{credits}', p_state->'credits');
  else
    merged := jsonb_set(merged, '{credits}', server->'credits');
  end if;
  merged := jsonb_set(merged, '{positions}', coalesce(server->'positions', '{}'::jsonb));
  merged := jsonb_set(merged, '{avgCost}', coalesce(server->'avgCost', '{}'::jsonb));
  merged := jsonb_set(merged, '{prestige}', coalesce(server->'prestige', '{"tier":0,"multiplier":1}'::jsonb));
  merged := jsonb_set(merged, '{listings}', coalesce(server->'listings', '[]'::jsonb));
  merged := jsonb_set(merged, '{surveyed}', coalesce(server->'surveyed', '{}'::jsonb));
  merged := jsonb_set(merged, '{routes}', coalesce(server->'routes', '[]'::jsonb));
  merged := jsonb_set(merged, '{industries}', app._merge_industries(
    coalesce(server->'industries', '[]'::jsonb),
    coalesce(p_state->'industries', '[]'::jsonb)));
  merged := jsonb_set(merged, '{expeditions}', app._merge_expeditions(
    coalesce(server->'expeditions', '[]'::jsonb),
    coalesce(p_state->'expeditions', '[]'::jsonb)));
  -- Mining ops keep the client-setup merge (dispatch is free, so there is no
  -- payment to validate and no dispatch RPC); every timer, counter and the
  -- worked-out pool are server-owned after pull. See app._merge_mining.
  merged := jsonb_set(merged, '{mining}', app._merge_mining(
    coalesce(server->'mining', '[]'::jsonb),
    coalesce(p_state->'mining', '[]'::jsonb)));
  merged := jsonb_set(merged, '{beltPools}', app._merge_belt_pools(
    coalesce(server->'beltPools', '{}'::jsonb),
    coalesce(p_state->'beltPools', '{}'::jsonb)));
  -- Piracy ops keep the client-setup merge (dispatch is free, so there is no
  -- payment to validate and no dispatch RPC); every outcome, the loot and the
  -- hot-cargo flags are server-owned after pull. See app._merge_piracy.
  merged := jsonb_set(merged, '{piracy}', app._merge_piracy(
    coalesce(server->'piracy', '[]'::jsonb),
    coalesce(p_state->'piracy', '[]'::jsonb)));
  merged := jsonb_set(merged, '{piracyHits}', app._merge_piracy_hits(
    coalesce(server->'piracyHits', '[]'::jsonb),
    coalesce(p_state->'piracyHits', '[]'::jsonb)));
  merged := jsonb_set(merged, '{hot}', app._merge_hot(
    coalesce(server->'hot', '{}'::jsonb),
    coalesce(p_state->'hot', '{}'::jsonb)));
  merged := jsonb_set(merged, '{extractors}', app._merge_extractors(
    coalesce(server->'extractors', '{}'::jsonb),
    coalesce(p_state->'extractors', '{}'::jsonb)));
  merged := jsonb_set(merged, '{components}', coalesce(server->'components', '{}'::jsonb));

  -- Crime coefficient: server-owned (this file). A save edit can't clear a
  -- record, and the 1/day cooling is applied on the server clock.
  merged := jsonb_set(merged, '{crime}',
    coalesce(server->'crime', to_jsonb(app._crime_start())));
  merged := jsonb_set(merged, '{crimeSeenAt}',
    coalesce(server->'crimeSeenAt', to_jsonb(now_ms)));
  merged := app._crime_decay(merged, now_ms);

  if coalesce((server->'stats'->>'trades')::int, 0) > coalesce((merged->'stats'->>'trades')::int, 0) then
    merged := jsonb_set(merged, '{stats,trades}', server->'stats'->'trades');
  end if;
  if coalesce((server->'stats'->>'biggestTrade')::float8, 0)
     > coalesce((merged->'stats'->>'biggestTrade')::float8, 0) then
    merged := jsonb_set(merged, '{stats,biggestTrade}', server->'stats'->'biggestTrade');
  end if;
  if coalesce((server->'stats'->>'contractsDone')::int, 0)
     > coalesce((merged->'stats'->>'contractsDone')::int, 0) then
    merged := jsonb_set(merged, '{stats,contractsDone}', server->'stats'->'contractsDone');
  end if;
  if coalesce((server->'stats'->>'peakNetWorth')::float8, 0)
     > coalesce((merged->'stats'->>'peakNetWorth')::float8, 0) then
    merged := jsonb_set(merged, '{stats,peakNetWorth}', server->'stats'->'peakNetWorth');
  end if;

  -- Expired mercenaries leave the roster (merc_expiry.sql).
  merged := app._prune_mercs(merged, now_ms);
  -- Survey custody: expeditions and ship statuses agree (survey_custody.sql).
  merged := app._survey_custody(merged);
  -- This file: bay capacity matches the client's hauling model, and dead
  -- purchase marks stop riding in every commit.
  merged := app._normalize_inventory(merged);
  merged := app._prune_bazaar_bought(merged, now_ms);

  perform app._write_state(merged, now_ms);
  return jsonb_build_object('ok', true, 'state', merged);
end;
$$;

create or replace function public.app_pull()
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  last_seen bigint;
  elapsed bigint;
  max_offline constant bigint := 7::bigint * 24 * 60 * 60 * 1000;
  frag jsonb;
  sold jsonb := '[]'::jsonb;
  routed jsonb := '{"total":0,"runs":[],"events":[]}'::jsonb;
  industry jsonb := '[]'::jsonb;
  mined jsonb := '[]'::jsonb;
  piracy jsonb := '[]'::jsonb;
  raids jsonb := '[]'::jsonb;
  surveys jsonb := '[]'::jsonb;
  mission_r jsonb;
  resolved jsonb := '[]'::jsonb;
  nw double precision;
  stats jsonb;
begin
  st := app._lock_state(now_ms);

  -- Cap catch-up window (mirrors CONFIG.maxOfflineMs). Timers older than the
  -- cap are advanced so we don't bank infinite cycles from a forged nextAt.
  last_seen := coalesce((st->>'lastSeenAt')::bigint, now_ms);
  elapsed := greatest(0, now_ms - last_seen);
  if elapsed > max_offline then
    -- Shift route/industry nextAt forward so only max_offline of work banks.
    st := jsonb_set(st, '{routes}', (
      select coalesce(jsonb_agg(
        case when r.value->>'nextAt' is not null
          then jsonb_set(r.value, '{nextAt}',
            to_jsonb(greatest((r.value->>'nextAt')::bigint, now_ms - max_offline)))
          else r.value end
      ), '[]'::jsonb)
      from jsonb_array_elements(coalesce(st->'routes', '[]'::jsonb)) r(value)
    ));
    st := jsonb_set(st, '{industries}', (
      select coalesce(jsonb_agg(
        case when i.value->>'nextAt' is not null
          then jsonb_set(i.value, '{nextAt}',
            to_jsonb(greatest((i.value->>'nextAt')::bigint, now_ms - max_offline)))
          else i.value end
      ), '[]'::jsonb)
      from jsonb_array_elements(coalesce(st->'industries', '[]'::jsonb)) i(value)
    ));
  end if;

  -- Matured missions (reuse Phase 2 RPC logic via internal call pattern:
  -- write interim state, call resolve, re-lock). Simpler: inline by invoking
  -- the public function's body through a state swap — call app_mission_resolve
  -- after writing current st so it sees our locked row.
  perform app._write_state(st, now_ms);
  mission_r := public.app_mission_resolve();
  if mission_r is not null and coalesce((mission_r->>'ok')::boolean, false) then
    -- Re-lock after mission resolve wrote
    st := app._lock_state(now_ms);
    resolved := coalesce(mission_r->'resolved', '[]'::jsonb);
  else
    st := app._lock_state(now_ms);
  end if;

  frag := app._catchup_listings(st, now_ms);
  st := frag->'state';
  sold := coalesce(frag->'sold', '[]'::jsonb);

  frag := app._catchup_routes(st, now_ms);
  st := frag->'state';
  routed := coalesce(frag->'routed', routed);

  frag := app._catchup_industries(st, now_ms);
  st := frag->'state';
  industry := coalesce(frag->'industry', '[]'::jsonb);

  -- Belt mining: untaxed batches, corsair raids and returning hulls, all on the
  -- server clock so a signed-in baron can dispatch and close the tab.
  frag := app._catchup_mining(st, now_ms::float8);
  st := frag->'state';
  mined := coalesce(frag->'mining', '[]'::jsonb);
  raids := coalesce(frag->'raids', '[]'::jsonb);

  -- Piracy: the fight, the loot, the police chase and the hull landing home,
  -- all on the server clock so a signed-in baron can dispatch and close the
  -- tab. Runs AFTER mining so a hull cannot be double-booked in one pull.
  frag := app._catchup_piracy(st, now_ms::float8);
  st := frag->'state';
  piracy := coalesce(frag->'piracy', '[]'::jsonb);

  frag := app._catchup_expeditions(st, now_ms);
  st := frag->'state';
  surveys := coalesce(frag->'surveys', '[]'::jsonb);

  -- Peak net worth
  nw := app._net_worth(st, now_ms);
  stats := coalesce(st->'stats', '{}'::jsonb);
  if nw > coalesce((stats->>'peakNetWorth')::float8, 0) then
    stats := jsonb_set(stats, '{peakNetWorth}', to_jsonb(nw));
    st := jsonb_set(st, '{stats}', stats);
  end if;

  perform app._write_state(st, now_ms);

  return app.result_slice(st) || jsonb_build_object(
    'away', jsonb_build_object(
      'elapsedMs', least(elapsed, max_offline),
      'sold', sold,
      'routed', routed,
      'industry', industry,
      'surveys', surveys,
      'mining', mined,
      'miningRaids', raids,
      'piracy', piracy,
      'resolved', resolved
    )
  );
end;
$$;
