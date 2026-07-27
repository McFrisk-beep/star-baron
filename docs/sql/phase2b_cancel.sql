-- Phase 2b — cancel pending contracts + abandon in-flight missions
-- Requires: docs/sql/phase2_missions_bazaar.sql (+ phase1)
-- Paste into SQL Editor and Run. Safe to re-run (create or replace).
--
-- Mirrors js/bazaar.js cancelFee / cancelPending and js/missions.js abandon:
--   pending cancel → credits fee (scales with Baron Tier), drop from pendingContracts
--   mission abandon → ships idle, optional faction standing hit (no credits)

create or replace function app.cancel_fee(p_reward double precision, p_tier int)
returns double precision
language sql immutable as $$
  -- BAZAARCFG.cancelFeeRate 0.10, cancelFeeTierMult 0.35, cancelFeeMin 250
  select greatest(250.0,
    round(greatest(0, coalesce(p_reward, 0))
      * 0.10
      * (1.0 + greatest(0, coalesce(p_tier, 0)) * 0.35)));
$$;

create or replace function app.cancel_rep_hit(p_danger text)
returns double precision
language sql immutable as $$
  select case p_danger
    when 'safe' then 2 when 'low' then 3 when 'moderate' then 4
    when 'high' then 6 when 'extreme' then 8 else 3 end;
$$;

-- Drop a taken-but-not-launched bazaar job for a title-scaled fee.
drop function if exists public.app_cancel_pending_contract(text);
create or replace function public.app_cancel_pending_contract(p_contract_id text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  pending jsonb;
  contract jsonb;
  fee double precision;
  credits double precision;
  tier int;
  reward double precision;
begin
  if p_contract_id is null or p_contract_id = '' then
    return jsonb_build_object('ok', false, 'error', 'Contract not in hand.');
  end if;

  st := app._lock_state(now_ms);
  pending := coalesce(st->'pendingContracts', '[]'::jsonb);
  select value into contract from jsonb_array_elements(pending) x(value)
    where x.value->>'id' = p_contract_id limit 1;
  if contract is null then
    return jsonb_build_object('ok', false, 'error', 'Contract not in hand.');
  end if;

  tier := coalesce((st->'prestige'->>'tier')::int, 0);
  reward := coalesce((contract->'reward'->>'credits')::float8, 0);
  fee := app.cancel_fee(reward, tier);
  credits := coalesce((st->>'credits')::float8, 0);
  if fee > credits then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits to cancel.');
  end if;

  pending := (
    select coalesce(jsonb_agg(value), '[]'::jsonb)
    from jsonb_array_elements(pending) x(value)
    where x.value->>'id' is distinct from p_contract_id
  );
  st := jsonb_set(st, '{credits}', to_jsonb(credits - fee));
  st := jsonb_set(st, '{pendingContracts}', pending);
  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('fee', fee);
end;
$$;

-- Abort an in-flight mission: free ships; faction standing hit if sponsored.
drop function if exists public.app_mission_abandon(text);
create or replace function public.app_mission_abandon(p_mission_uid text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms bigint := app._now_ms();
  st jsonb;
  missions jsonb;
  mission jsonb;
  ships jsonb;
  uids jsonb;
  fac text;
  hit double precision := 0;
  rep jsonb;
begin
  if p_mission_uid is null or p_mission_uid = '' then
    return jsonb_build_object('ok', false, 'error', 'Mission not found.');
  end if;

  st := app._lock_state(now_ms);
  missions := coalesce(st->'missions', '[]'::jsonb);
  select value into mission from jsonb_array_elements(missions) x(value)
    where x.value->>'uid' = p_mission_uid
      and coalesce((x.value->>'resolved')::boolean, false) = false
    limit 1;
  if mission is null then
    return jsonb_build_object('ok', false, 'error', 'Mission not found.');
  end if;

  uids := coalesce(mission->'shipUids', '[]'::jsonb);
  ships := coalesce(st->'ships', '[]'::jsonb);
  ships := (
    select coalesce(jsonb_agg(
      case when exists (
        select 1 from jsonb_array_elements_text(uids) u where u = sh.value->>'uid'
      ) and sh.value->>'status' = 'mission'
        then jsonb_set(sh.value, '{status}', '"idle"')
        else sh.value end
    ), '[]'::jsonb)
    from jsonb_array_elements(ships) sh(value)
  );

  fac := nullif(mission->>'faction', '');
  rep := coalesce(st->'reputation', '{}'::jsonb);
  if fac is not null then
    hit := app.cancel_rep_hit(coalesce(mission->>'danger', 'moderate'));
    rep := app._rep_change(rep, fac, -hit);
  end if;

  missions := (
    select coalesce(jsonb_agg(value), '[]'::jsonb)
    from jsonb_array_elements(missions) x(value)
    where x.value->>'uid' is distinct from p_mission_uid
  );

  st := jsonb_set(st, '{ships}', ships);
  st := jsonb_set(st, '{missions}', missions);
  st := jsonb_set(st, '{reputation}', rep);
  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('repHit', hit);
end;
$$;

grant execute on function public.app_cancel_pending_contract(text) to authenticated;
grant execute on function public.app_mission_abandon(text) to authenticated;
