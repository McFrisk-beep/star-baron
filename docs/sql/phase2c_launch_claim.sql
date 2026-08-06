-- Phase 2c — Launch claims the board job (View Contract does not reserve).
-- Requires: phase2_missions_bazaar.sql (+ phase2b_cancel.sql optional)
-- Paste into SQL Editor and Run. Safe to re-run (create or replace).
--
-- app_mission_launch now:
--   1) uses a legacy pendingContracts entry if present, OR
--   2) recomputes the board offer, claims it, and launches in one step
-- app_take_contract jobs no longer park into pending (tips unchanged).

create or replace function public.app_take_contract(p_offer_id text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  offer jsonb;
  credits double precision;
  tier int;
begin
  st := app._lock_state(now_ms);
  tier := coalesce((st->'prestige'->>'tier')::int, 0);
  if app.claim_used(st, p_offer_id) then
    return jsonb_build_object('ok', false, 'error', 'Contract no longer available.');
  end if;
  offer := app.lookup_offer(p_offer_id, now_ms, tier);
  if offer is null then
    return jsonb_build_object('ok', false, 'error', 'Contract no longer available.');
  end if;

  if offer->>'kind' = 'tip' then
    credits := coalesce((st->>'credits')::float8, 0);
    if coalesce((offer->>'cost')::float8, 0) > credits then
      return jsonb_build_object('ok', false, 'error', 'Not enough credits.');
    end if;
    st := jsonb_set(st, '{credits}', to_jsonb(credits - (offer->>'cost')::float8));
    st := app.mark_claimed(st, p_offer_id);
    perform app._write_state(st, now_ms);
    return app.result_slice(st) || jsonb_build_object('tip', true, 'cat', offer->>'cat');
  end if;

  -- Jobs: View Contract is preview-only. Claim happens at app_mission_launch.
  return jsonb_build_object('ok', false, 'error', 'Open the contract and Launch to take it.');
end;
$$;

create or replace function public.app_mission_launch(p_contract_id text, p_ship_uids jsonb)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  ships jsonb;
  uids jsonb := '[]'::jsonb;
  pick jsonb;
  power double precision := 0;
  cargo double precision := 0;
  speed double precision := 0;
  n int := 0;
  chance double precision;
  min_fp double precision;
  cargo_req double precision;
  danger text;
  duration_ms double precision;
  leg double precision;
  work double precision;
  total_ms double precision;
  seq int;
  mission jsonb;
  phases jsonb;
  pending jsonb;
  contract jsonb;
  rng_seed bigint;
  tier int;
  from_pending boolean := false;
begin
  if p_contract_id is null or jsonb_typeof(p_ship_uids) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'Invalid mission.');
  end if;

  st := app._lock_state(now_ms);
  tier := coalesce((st->'prestige'->>'tier')::int, 0);
  pending := coalesce(st->'pendingContracts', '[]'::jsonb);
  select value into contract from jsonb_array_elements(pending) x(value)
    where x.value->>'id' = p_contract_id limit 1;
  if contract is not null then
    from_pending := true;
  else
    -- Claim from the live board at launch (View Contract does not reserve).
    if app.claim_used(st, p_contract_id) then
      return jsonb_build_object('ok', false, 'error', 'Contract no longer available.');
    end if;
    contract := app.lookup_offer(p_contract_id, now_ms, tier);
    if contract is null then
      return jsonb_build_object('ok', false, 'error', 'Contract no longer available.');
    end if;
    if contract->>'kind' is distinct from 'job' then
      return jsonb_build_object('ok', false, 'error', 'Not a flyable contract.');
    end if;
    st := app.mark_claimed(st, p_contract_id);
  end if;

  if contract->>'kind' is distinct from 'job' then
    return jsonb_build_object('ok', false, 'error', 'Not a flyable contract.');
  end if;

  ships := coalesce(st->'ships', '[]'::jsonb);
  pick := app._pick_idle_ships(ships, p_ship_uids);
  if not coalesce((pick->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', coalesce(pick->>'error', 'Select at least one idle ship.'));
  end if;
  uids := pick->'uids';
  power := coalesce((pick->>'power')::float8, 0);
  cargo := coalesce((pick->>'cargo')::float8, 0);
  speed := coalesce((pick->>'speed')::float8, 1);
  n := coalesce((pick->>'n')::int, 0);

  danger := coalesce(contract->>'danger', 'moderate');
  min_fp := coalesce((contract->>'minFirepower')::float8, 0);
  cargo_req := coalesce((contract->>'cargoRequired')::float8, 0);
  duration_ms := coalesce((contract->>'durationMs')::float8, 600000);
  duration_ms := greatest(180000, least(720000, duration_ms));
  chance := app.danger_base_success(danger);
  if min_fp > 0 then
    chance := chance + greatest(-0.6, least(0.35, ((power / min_fp) - 1.0) * 0.25));
  elsif power > 0 then
    chance := chance + 0.02;
  end if;
  if cargo_req > 0 and cargo < cargo_req then
    chance := chance - 0.45 * (1.0 - cargo / cargo_req);
  end if;
  chance := greatest(0.03, least(0.99, chance));

  leg := (duration_ms * 0.3) / greatest(speed, 0.25);
  work := duration_ms * 0.4;
  total_ms := leg + work * 0.45 + work * 0.55 + leg;
  phases := jsonb_build_array(
    jsonb_build_object('label', 'Outbound transit', 'dir', 'out', 'ms', leg),
    jsonb_build_object('label', 'On site', 'dir', 'work', 'ms', work * 0.45),
    jsonb_build_object('label', 'Working', 'dir', 'work', 'ms', work * 0.55),
    jsonb_build_object('label', 'Return transit', 'dir', 'in', 'ms', leg)
  );

  seq := coalesce((st->>'seq')::int, 1) + 1;
  rng_seed := market.seed_hash('cosmocrat-market-v1', 'mission', 'm' || seq, now_ms::text);
  mission := jsonb_build_object(
    'uid', 'm' || seq,
    'contractId', p_contract_id,
    'type', contract->>'type',
    'title', contract->>'title',
    'sysName', contract->>'sysName',
    'shipUids', uids,
    'phases', phases,
    'totalMs', total_ms,
    'startedAt', now_ms,
    'rngSeed', rng_seed,
    'successChance', chance,
    'reward', contract->'reward',
    'impound', coalesce((contract->>'impound')::boolean, false),
    'danger', danger,
    'stakeTier', coalesce((contract->>'stakeTier')::int, 0),
    'faction', contract->>'faction',
    'resolved', false
  );

  ships := (
    select coalesce(jsonb_agg(
      case when exists (
        select 1 from jsonb_array_elements_text(uids) u where u = sh.value->>'uid'
      )
        then jsonb_set(sh.value, '{status}', '"mission"')
        else sh.value end
    ), '[]'::jsonb)
    from jsonb_array_elements(ships) sh(value)
  );

  if from_pending then
    pending := (
      select coalesce(jsonb_agg(value), '[]'::jsonb)
      from jsonb_array_elements(pending) x(value)
      where x.value->>'id' is distinct from p_contract_id
    );
    st := jsonb_set(st, '{pendingContracts}', pending);
  end if;

  st := jsonb_set(st, '{ships}', ships);
  st := jsonb_set(st, '{missions}', coalesce(st->'missions', '[]'::jsonb) || jsonb_build_array(mission));
  st := jsonb_set(st, '{seq}', to_jsonb(seq));
  perform app._write_state(st, now_ms);

  return app.result_slice(st) || jsonb_build_object('mission', mission);
end;
$$;

grant execute on function public.app_take_contract(text) to authenticated;
grant execute on function public.app_mission_launch(text, jsonb) to authenticated;
