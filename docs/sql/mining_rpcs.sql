-- mining_rpcs.sql — server-side belt mining (docs/SPACE_INTERACTIVITY.md §3).
--
-- THE PROBLEM
-- Mining shipped client-local. Ore is minted into `positions`, which app_commit
-- forces from the server row, so a signed-in baron's batches evaporated on the
-- next autosave — and Mining.canStart knew it, refusing to dispatch at all
-- unless Economy.softIncomeLocal(). Two whole build steps (§3 mining, §4 NPC
-- piracy against it) were guest-only content.
--
-- THE FIX — the shape _catchup_industries already uses, not a new one.
--   app._catchup_mining   — banks matured batches on the SERVER clock inside
--                           app_pull: untaxed ore into positions, corsair raids
--                           rolled, hull damage applied, driven-off and
--                           recalled hulls landed, the guard wing released.
--   app._merge_mining     — new dispatches merge from the client (dispatch is
--                           free, so there is nothing to validate a payment
--                           against and no dispatch RPC); the server owns every
--                           timer and counter once the op exists.
--   app._merge_belt_pools — what you took off a rock may only ever go UP within
--                           a generation, so a worked-out seam cannot be reset
--                           and mined twice.
-- and app_commit / app_pull / result_slice grow the two mining slices.
--
-- TRUST MODEL
-- The op row carries three numbers the server cannot derive: `per` (the batch
-- size), `threat` and `repel` (the corsair odds). All three are computed by the
-- client at dispatch — it owns the seeded belt, its own accessory/refit/
-- flagship fitment and its escort wing, none of which the server models — and
-- all three are CLAMPED here against the server's own ship catalog and the
-- RAIDCFG bands. This is the same stance charter_rpcs.sql takes on a charter
-- quote: bounded at roughly "best possible legitimate fleet", not infinity.
-- Sending threat 0 dodges raids but mints nothing extra; the batch ceiling and
-- the finite rock are what actually bound the exploit.
--
-- WHY THE ODDS RIDE ON THE OP
-- js/raiders.js rolls against op.threat / op.repel rather than recomputing from
-- the seeded POI and the live station tables. That is what lets this file
-- reproduce a raid EXACTLY — same seed, same draw order, same bands — instead
-- of porting POI generation and security bands to SQL and watching the two
-- drift. tools/check_mining_parity.js pins the two implementations together.
-- It also means you accepted a quoted risk when you dispatched: an edict passed
-- an hour later does not retroactively re-roll batches already in the hold.
--
-- ANTI-GRIEF (§6.6) HOLDS ON THE LEDGER TOO
-- A raid takes the interrupted batch and nothing else. It never touches banked
-- positions, never destroys a hull and never impounds one — the worst outcome
-- here, as on the client, is damage plus a flight home.
--
-- ORE STAYS PRIVATE (§11 Q3, settled): batches land in positions/avgCost only.
-- No sector-shelf write, so the npcOutputMult trap in §3.7 stays untriggered.
-- The client parks the matching bay blocks off the `mining` away-slice.
--
-- Apply LAST — after every other file that declares app_commit (the tail of
-- tools/check_equip_persist.js's APPLY_ORDER, currently save_hygiene.sql).
-- This file's app_commit / result_slice / app_pull extend those layers, and
-- whichever copy is pasted last wins. Requires
-- market_price.sql for the seeded RNG and the commodity catalog. Safe to
-- re-run. Then re-run docs/sql/commit_allowlist.sql if you keep it applied
-- last — its allowlist now carries 'mining' and 'beltPools'.
--
-- Client: js/mining.js stamps per/threat/repel at dispatch, js/cloud.js sends
-- the two keys (Cloud.WIRE_KEYS), and tools/check_cloud_egress.js pins the wire
-- to the allowlist.

-- ===========================================================================
-- Server-side mining: the catalog bound, the seeded raid roll, the catch-up
-- ===========================================================================

-- The `mine` stat per miner hull. app.ship_def predates the miner class and has
-- no such column; adding one would mean re-pasting a 1300-line file everyone
-- has already applied, so the yield lives here instead. Keep in lockstep with
-- SHIP_CATALOG.miner in js/data.js (tools/check_mining_parity.js pins them).
create or replace function app.miner_yield(p_type text)
returns double precision
language sql immutable as $$
  select coalesce((select y from (values
    ('prospector', 2::float8),
    ('rock_hopper', 4),
    ('core_driller', 6),
    ('belt_leviathan', 9)
  ) as m(id, y) where m.id = p_type), 0);
$$;

-- Per-batch ore ceiling for one op. Mirrors Mining.batchQty
-- (MININGCFG.baseYield 2 x seam richness x hull mine stat x rig) with headroom
-- standing in for the accessory / yard-refit / flagship buffs the client
-- legitimately stacks and the server does not model — the same shape
-- app._charter_cap uses for a charter quote. A forged `rich` is clamped to the
-- band POIs._occupy can actually roll, so the ceiling is "best possible
-- legitimate rock and rig", not infinity.
create or replace function app._mining_batch_cap(p_op jsonb, p_ship jsonb)
returns int
language sql immutable as $$
  select greatest(1, ceil(
    2.0                                                        -- MININGCFG.baseYield
    * least(greatest(coalesce((p_op->>'rich')::float8, 1), 0.3), 2.5)
    * (1 + app.miner_yield(p_ship->>'type') / 10.0)
    * 1.8                                                      -- fitment headroom
    * 2.2                                                      -- best specialized rig
  )::int);
$$;

-- One corsair roll against a parked claim, mirroring Raiders.rollClaim exactly:
-- same seed (Market._seed(["raid", op.id, cycle]) — MARKETCFG.seed first), same
-- draw order, same bands from RAIDCFG. tools/check_mining_parity.js asserts the
-- two agree draw for draw.
--
-- `threat` and `repel` ride on the op, computed by the client at dispatch and
-- CLAMPED here. That is deliberate and it is the house trust model: the client
-- owns the inputs the server cannot see (the seeded belt, its own escort
-- fitment), and a tampered value is bounded to the legitimate range. Sending
-- threat 0 dodges raids but mints nothing extra — the ore ceiling above is what
-- actually bounds the exploit. Same stance charter_rpcs.sql takes on
-- destroy/impound odds.
create or replace function app._mining_raid(p_op jsonb, p_cycle int, p_qty int, p_guards int)
returns jsonb
language plpgsql immutable as $$
declare
  s bigint;
  threat double precision := least(greatest(coalesce((p_op->>'threat')::float8, 0), 0.01), 0.6);
  repel  double precision := least(greatest(coalesce((p_op->>'repel')::float8, 0), 0), 0.9);
  stolen int;
begin
  if p_qty <= 0 then return null; end if;
  s := market.seed_hash('cosmocrat-market-v1', 'raid', p_op->>'id', p_cycle::text);
  if market.u01(s, 0) >= threat then return null; end if;          -- nobody came
  if market.u01(s, 1) < repel then                                  -- the wing held
    return jsonb_build_object(
      'repelled', true, 'stolen', 0, 'driveOff', false,
      'minerDmg', 0::float8,
      'guardDmg', case when p_guards > 0 then (0.02 + market.u01(s, 4) * 0.05) * 0.5 else 0 end);
  end if;
  stolen := least(p_qty, greatest(1, round(p_qty * (0.6 + market.u01(s, 2) * 0.4))::int));
  return jsonb_build_object(
    'repelled', false,
    'stolen', stolen,
    'minerDmg', 0.05 + market.u01(s, 3) * 0.10,
    'guardDmg', case when p_guards > 0 then 0.02 + market.u01(s, 4) * 0.05 else 0 end,
    'driveOff', market.u01(s, 5) < 0.35 * (case when p_guards > 0 then 0.4 else 1 end));
end;
$$;

-- Bank matured batches on the SERVER clock, mirroring Mining.resolve. This is
-- what makes mining work for a signed-in baron who dispatches and closes the
-- tab: ore lands in positions here, not optimistically on the client where
-- app_commit would reject it.
--
-- The user's call on SPACE_INTERACTIVITY §11 Q3 is honoured: mined ore is
-- PRIVATE. It lands in positions/avgCost and nowhere else — no sector shelf
-- write, so the npcOutputMult trap in §3.7 stays untriggered. The client parks
-- the matching bay blocks off the `mining` away-slice returned below.
-- p_now_ms is float8, not bigint: JS timestamps on these rows are fractional
-- (arriveAt = now + a fractional travelMs), and '123.4'::bigint throws.
create or replace function app._catchup_mining(p_state jsonb, p_now_ms double precision)
returns jsonb
language plpgsql as $$
declare
  st jsonb := p_state;
  ops jsonb := '[]'::jsonb;
  made jsonb := '[]'::jsonb;
  raids jsonb := '[]'::jsonb;
  pools jsonb;
  positions jsonb;
  avg_cost jsonb;
  ships jsonb;
  op jsonb;
  sh jsonb;
  comm record;
  pool_row jsonb;
  guards jsonb;
  guard_n int;
  per int;
  cycles int;
  cycle_ms constant double precision := 30.0 * 60 * 1000;   -- MININGCFG.cycleMs
  used int;
  pool_cap constant int := 364;   -- MININGCFG.poolBase 260 x the 1.4 size jitter ceiling
  take int;
  qty int;
  banked int;
  k int;
  raid jsonb;
  chased boolean;
  op_n int := 0;
  held double precision;
  prev_avg double precision;
  dmg double precision;
  gu text;
begin
  pools := coalesce(st->'beltPools', '{}'::jsonb);
  positions := coalesce(st->'positions', '{}'::jsonb);
  avg_cost := coalesce(st->'avgCost', '{}'::jsonb);
  ships := coalesce(st->'ships', '[]'::jsonb);

  for op in select value from jsonb_array_elements(coalesce(st->'mining', '[]'::jsonb)) loop
    op_n := op_n + 1;
    -- MININGCFG.maxOps — forged extras are dropped, not merely idled.
    if op_n > 4 then continue; end if;

    select value into sh from jsonb_array_elements(ships) x(value)
      where x.value->>'uid' = op->>'shipUid' limit 1;
    -- Hull gone (sold, lost, never existed): close the op out and free the wing.
    if sh is null then
      ships := app._mining_free(ships, op);
      continue;
    end if;

    guards := coalesce(op->'guardUids', '[]'::jsonb);
    guard_n := jsonb_array_length(guards);

    -- Home: land the hull and the wing, drop the op.
    if op->>'returnAt' is not null and op->'returnAt' <> 'null'::jsonb
       and p_now_ms >= (op->>'returnAt')::float8 then
      ships := app._mining_free(ships, op);
      continue;
    end if;

    -- Re-lock the hulls the op is holding (a server slice can reset a status).
    ships := app._mining_lock(ships, op);

    -- Still flying out, heading home, or the batch clock hasn't matured.
    if (op->>'returnAt' is not null and op->'returnAt' <> 'null'::jsonb)
       or p_now_ms < coalesce((op->>'arriveAt')::float8, 0)
       or p_now_ms < coalesce((op->>'nextAt')::float8, 0) then
      ops := ops || jsonb_build_array(op);
      continue;
    end if;

    -- The seam must be something a belt can actually carry: a tradeable
    -- mineral or gas. POIs._occupy picks from exactly that pool, so a forged
    -- commId naming something dearer banks nothing.
    select * into comm from market.commodity(op->>'commId');
    if comm.id is null or comm.craft_only or comm.cat not in ('mineral', 'gas') then
      op := jsonb_set(op, '{nextAt}', to_jsonb(p_now_ms + cycle_ms));
      ops := ops || jsonb_build_array(op);
      continue;
    end if;

    -- What you have already taken off THIS rock this generation. A row from an
    -- older generation belonged to the rock this one replaced.
    pool_row := pools->(op->>'poiId');
    if pool_row is null or coalesce((pool_row->>'gen')::int, -1) <> coalesce((op->>'gen')::int, 0) then
      pool_row := jsonb_build_object('gen', coalesce((op->>'gen')::int, 0), 'used', 0);
    end if;
    used := greatest(0, coalesce((pool_row->>'used')::int, 0));

    -- The client's quoted rate, clamped to what its hull and the best rig could
    -- legitimately produce. Taking the CAP instead would mine every claim at
    -- the ceiling; taking the claim unchecked would mine at infinity.
    per := greatest(1, least(coalesce((op->>'per')::int, 1), app._mining_batch_cap(op, sh)));
    cycles := least(
      (floor((p_now_ms - (op->>'nextAt')::float8) / cycle_ms) + 1)::int,
      24   -- MININGCFG.maxCyclesPerResolve
    );
    qty := 0; banked := 0; chased := false;
    k := coalesce((op->>'cycles')::int, 0);

    while cycles > 0 and used < pool_cap loop
      cycles := cycles - 1;
      take := least(per, pool_cap - used);
      used := used + take;
      k := k + 1;
      raid := app._mining_raid(op, k, take, guard_n);
      if raid is null then
        qty := qty + take;
      else
        qty := qty + take - coalesce((raid->>'stolen')::int, 0);
        dmg := coalesce((raid->>'minerDmg')::float8, 0);
        if dmg > 0 then ships := app._mining_damage(ships, op->>'shipUid', dmg); end if;
        dmg := coalesce((raid->>'guardDmg')::float8, 0);
        if dmg > 0 then
          for gu in select value #>> '{}' from jsonb_array_elements(guards) loop
            ships := app._mining_damage(ships, gu, dmg);
          end loop;
        end if;
        raids := raids || jsonb_build_array(raid || jsonb_build_object(
          'poiId', op->>'poiId', 'sysId', op->>'sysId', 'commId', op->>'commId',
          'poiName', op->>'poiName', 'ship', sh->>'name'));
        if coalesce((raid->>'driveOff')::boolean, false) then chased := true; exit; end if;
      end if;
    end loop;

    banked := greatest(0, qty);
    -- `t` is the prune clock, not decoration: see the sweep below.
    pools := jsonb_set(pools, array[op->>'poiId'],
      jsonb_build_object('gen', coalesce((op->>'gen')::int, 0), 'used', used, 't', p_now_ms));
    op := jsonb_set(op, '{cycles}', to_jsonb(k));
    op := jsonb_set(op, '{nextAt}', to_jsonb(p_now_ms + cycle_ms));
    -- Chased off the claim: the hull flies home. That is the worst a raid is
    -- ever allowed to do to it (SPACE_INTERACTIVITY §6.6.5) — never destroyed,
    -- never impounded, on the server ledger exactly as on the client.
    if chased then
      op := jsonb_set(op, '{returnAt}',
        to_jsonb(p_now_ms + coalesce((op->>'travelMs')::float8, 60000)));
    end if;

    if banked > 0 then
      op := jsonb_set(op, '{mined}', to_jsonb(coalesce((op->>'mined')::int, 0) + banked));
      held := coalesce((positions->>(op->>'commId'))::float8, 0);
      prev_avg := coalesce((avg_cost->>(op->>'commId'))::float8, 0);
      positions := jsonb_set(positions, array[op->>'commId'], to_jsonb(held + banked));
      -- Mined ore carries zero cost basis, same as the client resolver.
      avg_cost := jsonb_set(avg_cost, array[op->>'commId'],
        to_jsonb(case when (held + banked) > 0 then (held * prev_avg) / (held + banked) else 0 end));
      made := made || jsonb_build_array(jsonb_build_object(
        'commodity', op->>'commId', 'qty', banked, 'tax', 0, 'mining', true,
        'sysId', op->>'sysId', 'poiName', op->>'poiName'));
    end if;
    ops := ops || jsonb_build_array(op);
  end loop;

  -- Prune by AGE, never by "no op is working it". Dropping a row the moment its
  -- op ends would hand out a free reset: recall off a worked-out seam, dispatch
  -- again, mine the same rock twice. POICFG caps a site's life at 3h, so a row
  -- untouched for longer than that belongs to a rock that has certainly rolled
  -- over — and resetting THAT is correct, because it is a different rock.
  -- Rows with no stamp yet (written by a client before this SQL) are kept.
  pools := coalesce((
    select jsonb_object_agg(k2, v2) from jsonb_each(pools) e(k2, v2)
    where coalesce((v2->>'t')::float8, p_now_ms) > p_now_ms - 3.0 * 60 * 60 * 1000
  ), '{}'::jsonb);

  st := jsonb_set(st, '{mining}', ops);
  st := jsonb_set(st, '{beltPools}', pools);
  st := jsonb_set(st, '{ships}', ships);
  st := jsonb_set(st, '{positions}', positions);
  st := jsonb_set(st, '{avgCost}', avg_cost);
  return jsonb_build_object('state', st, 'mining', made, 'raids', raids);
end;
$$;

-- Release the miner and its guard wing back to idle.
create or replace function app._mining_free(p_ships jsonb, p_op jsonb)
returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(
    case when s.value->>'uid' = p_op->>'shipUid'
           or (p_op->'guardUids') ? (s.value->>'uid')
         then jsonb_set(s.value, '{status}', '"idle"'::jsonb)
         else s.value end
  ), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) s(value);
$$;

-- Lock them to the op. An impounded hull is left alone: the lot holds the
-- vessel and a mining op must not quietly spring it.
create or replace function app._mining_lock(p_ships jsonb, p_op jsonb)
returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(
    case when s.value->>'status' = 'impounded' then s.value
         when s.value->>'uid' = p_op->>'shipUid'
           then jsonb_set(s.value, '{status}', '"mining"'::jsonb)
         when (p_op->'guardUids') ? (s.value->>'uid')
           then jsonb_set(s.value, '{status}', '"guarding"'::jsonb)
         else s.value end
  ), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) s(value);
$$;

-- Battle damage from a raid, clamped to DMGCFG.maxDmg exactly as Fleet.addDamage.
create or replace function app._mining_damage(p_ships jsonb, p_uid text, p_frac double precision)
returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(
    case when s.value->>'uid' = p_uid
         then jsonb_set(s.value, '{dmg}',
           to_jsonb(least(0.95, greatest(0, coalesce((s.value->>'dmg')::float8, 0) + p_frac))))
         else s.value end
  ), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) s(value);
$$;

-- Ops merge like industries: the client creates them (there is no dispatch RPC
-- — dispatch costs nothing, so there is nothing to validate a payment against),
-- and the server owns every timer and counter once the op exists. A client
-- cannot rewind nextAt, inflate `mined`, or resurrect an op the server landed.
create or replace function app._merge_mining(p_server jsonb, p_client jsonb)
returns jsonb
language plpgsql immutable as $$
declare
  out jsonb := '[]'::jsonb;
  s jsonb;
  c jsonb;
  n int := 0;
begin
  for s in select value from jsonb_array_elements(coalesce(p_server, '[]'::jsonb)) loop
    -- A server op the client no longer lists was landed or recalled locally.
    -- Accept the recall (returnAt only ever moves a hull HOME, never enriches),
    -- but keep every other server field.
    select value into c from jsonb_array_elements(coalesce(p_client, '[]'::jsonb)) x(value)
      where x.value->>'id' = s->>'id' limit 1;
    if c is null then continue; end if;
    if c->>'returnAt' is not null and c->'returnAt' <> 'null'::jsonb
       and (s->>'returnAt' is null or s->'returnAt' = 'null'::jsonb) then
      s := jsonb_set(s, '{returnAt}', c->'returnAt');
    end if;
    n := n + 1;
    if n <= 4 then out := out || jsonb_build_array(s); end if;
  end loop;
  -- New dispatches. Counters are forced to zero here so a forged op can never
  -- arrive pre-loaded with banked ore or a skipped batch clock.
  for c in select value from jsonb_array_elements(coalesce(p_client, '[]'::jsonb)) loop
    if not exists (
      select 1 from jsonb_array_elements(coalesce(p_server, '[]'::jsonb)) s2(value)
      where s2.value->>'id' = c->>'id'
    ) then
      n := n + 1;
      if n <= 4 then
        out := out || jsonb_build_array(
          c || jsonb_build_object('mined', 0, 'cycles', 0, 'raids', 0, 'lost', 0));
      end if;
    end if;
  end loop;
  return out;
end;
$$;

-- What you took off each rock. The server value wins outright: `used` may only
-- ever go UP within a generation, so a client cannot reset a worked-out rock to
-- mine it twice. A generation change resets it — that is a different rock.
create or replace function app._merge_belt_pools(p_server jsonb, p_client jsonb)
returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
    select e.key as k,
      case
        when sv is null then e.value
        when coalesce((sv->>'gen')::int, -1) <> coalesce((e.value->>'gen')::int, -1) then sv
        else jsonb_build_object('gen', (sv->>'gen')::int,
          'used', greatest(coalesce((sv->>'used')::int, 0), coalesce((e.value->>'used')::int, 0)),
          't', coalesce(sv->'t', e.value->'t'))
      end as v
    from jsonb_each(coalesce(p_client, '{}'::jsonb)) e
    left join lateral (select coalesce(p_server, '{}'::jsonb)->e.key as sv) j on true
    union
    select e2.key, e2.value from jsonb_each(coalesce(p_server, '{}'::jsonb)) e2
    where not (coalesce(p_client, '{}'::jsonb) ? e2.key)
  ) merged;
$$;


-- ===========================================================================
-- result_slice + app_commit + app_pull — mining joins the server-owned slices.
-- The three bodies below are copied VERBATIM from the current tail of each
-- chain, plus the mining lines:
--   app_commit    <- save_hygiene.sql   (last file in check_equip_persist.js's
--                                        APPLY_ORDER that declares it)
--   result_slice  <- crime_coefficient.sql
--   app_pull      <- phase3_pull_prestige.sql (the only file that declares it)
-- Whichever copy an admin pastes LAST wins, which is why this file must be
-- applied last and why its copies must be the newest — a stale body would
-- silently un-protect whatever the newer one had added.
-- tools/check_mining_parity.js asserts every line of all three sources is
-- still present here; tools/check_equip_persist.js re-checks the ships merge.
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
      'resolved', resolved
    )
  );
end;
$$;
