-- charter_rpcs.sql — server-authoritative Charter Contracts (High H1).
--
-- Charter resolution used to be client-local for everyone: the payout was a
-- LOCAL credit increase (rejected by app_commit's "credits may only go down"),
-- hulls destroyed by the roll came back on the next slice (ships are server-
-- owned), and buyouts evaporated the same way — only abort FEES stuck. The
-- entire charter economy was a no-op on the signed-in ledger.
--
-- Same seam repair/equip/retrieve already got: dedicated RPCs.
--   app_charter_dispatch  — validates hulls + clamps the client's quote, locks
--                           the ships server-side, appends the charter row
--   app_charter_cancel    — abort fee / matured buyout on the server ledger
--   app_charter_resolve   — seeded rolls, payout after tax, hull loss/impound/
--                           damage, reputation, Dispatches reports
-- and app_commit is re-defined to force `charters` from the server row, so a
-- forged row can no longer ride in through the autosave.
--
-- Anti-cheat shape: the client still computes its quote (it owns accessory /
-- refit / flagship buffs the server doesn't model), but the server clamps the
-- reward to a generous cap built from its OWN ship catalog (base cargo × 2.5
-- headroom) and the tier payout ceiling — so a tampered quote is bounded at
-- roughly "best possible legitimate fleet", not infinity. Destroy/impound
-- chances are clamped to [0, 0.85]; zeroing them dodges risk but mints nothing.
-- ponytail: recompute chances fully server-side if risk-dodging ever matters.
--
-- Note: client-soft blackbox boosts (contractReward) don't reach the server
-- roll — they never actually paid out online anyway (the gain evaporated).
--
-- Apply AFTER workshop_craft.sql (this file's app_commit / result_slice extend
-- that layer) and after impound_retrieve.sql (uses app._impound_fine).
-- Safe to re-run. Requires phase2_missions_bazaar.sql + phase3_pull_prestige.sql.

-- CHARTER_BANDS — match js/data.js
create or replace function app.charter_band(p_band text)
returns table(id text, destroy double precision, impound double precision, faction text)
language sql immutable as $$
  select * from (values
    ('safe',     0.0::float8,  0.0::float8,  null::text),
    ('low',      0.01,         0.0,          'free_trade'),
    ('moderate', 0.03,         0.0,          'mining_combine'),
    ('high',     0.07,         0.0,          'agri_collective'),
    ('extreme',  0.14,         0.06,         'syndicate')
  ) as b(id, destroy, impound, faction)
  where b.id = p_band;
$$;

-- Reward ceiling for a charter on these hulls. Mirrors Charters.quote
-- (CHARTERCFG rateBase 600, rateCargo 30, taperExp 0.75, payoutCapMult 3 vs
-- tier depth) with base catalog cargo × 2.5 headroom standing in for the
-- refit/accessory/flagship buffs the client legitimately stacks.
create or replace function app._charter_cap(
  p_state jsonb, p_ship_uids jsonb, p_band text, p_duration_ms double precision
) returns double precision
language plpgsql stable as $$
declare
  cargo double precision := 0;
  uid   text;
  sh    jsonb;
  hours double precision := greatest(coalesce(p_duration_ms, 0), 60000) / 3600000.0;
  tier  int := coalesce((p_state->'prestige'->>'tier')::int, 0);
begin
  for uid in select jsonb_array_elements_text(coalesce(p_ship_uids, '[]'::jsonb)) loop
    select value into sh
      from jsonb_array_elements(coalesce(p_state->'ships', '[]'::jsonb)) x(value)
      where x.value->>'uid' = uid limit 1;
    if sh is not null then
      cargo := cargo + coalesce(app._ship_cargo(sh->>'type'), 0);
    end if;
  end loop;
  return least(
    (600.0 + cargo * 30.0 * 2.5) * app.danger_pay(p_band) * power(hours, 0.75),
    app._tier_cap(tier) * 3.0
  );
end;
$$;

-- ===========================================================================
-- app_charter_dispatch(p_charter) — lock hulls + append a validated row
-- ===========================================================================
create or replace function public.app_charter_dispatch(p_charter jsonb)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms      bigint := app._now_ms();
  st          jsonb;
  ships       jsonb;
  charters    jsonb;
  b           record;
  band        text;
  dur_ms      double precision;
  dur_min     int;
  uid_arr     text[];
  uid         text;
  sh          jsonb;
  n           int;
  active      int;
  reward      double precision;
  destroy_p   double precision;
  impound_p   double precision;
  cargo_by    jsonb := '{}'::jsonb;
  cargo_total double precision := 0;
  base_cargo  double precision;
  cargo_snap  double precision;
  cid         text;
  seq         int;
  row_j       jsonb;
begin
  if p_charter is null or jsonb_typeof(p_charter) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'Invalid charter.');
  end if;

  st := app._lock_state(now_ms);
  band := p_charter->>'band';
  select * into b from app.charter_band(band);
  if b is null then
    return jsonb_build_object('ok', false, 'error', 'Unknown risk band.');
  end if;

  dur_ms := coalesce((p_charter->>'durationMs')::float8, 0);
  dur_min := round((dur_ms / 60000.0)::numeric)::int;
  if dur_min not in (30, 60, 120, 240, 480, 720, 1440, 2880, 4320)
     or abs(dur_ms - dur_min * 60000.0) > 1 then
    return jsonb_build_object('ok', false, 'error', 'Pick a listed duration.');
  end if;

  select coalesce(array_agg(distinct u.value), array[]::text[]) into uid_arr
    from jsonb_array_elements_text(coalesce(p_charter->'shipUids', '[]'::jsonb)) u(value)
    where u.value is not null and u.value <> '';
  n := coalesce(array_length(uid_arr, 1), 0);
  if n = 0 then
    return jsonb_build_object('ok', false, 'error', 'Pick at least one ship.');
  end if;
  if n > 6 then
    return jsonb_build_object('ok', false, 'error', 'At most 6 ships per charter.');
  end if;

  charters := coalesce(st->'charters', '[]'::jsonb);
  select count(*) into active
    from jsonb_array_elements(charters) c(value)
    where not coalesce((c.value->>'resolved')::boolean, false);
  if active >= 3 then
    return jsonb_build_object('ok', false, 'error', 'At most 3 charters at once.');
  end if;

  ships := coalesce(st->'ships', '[]'::jsonb);
  foreach uid in array uid_arr loop
    select value into sh from jsonb_array_elements(ships) x(value)
      where x.value->>'uid' = uid limit 1;
    if sh is null then
      return jsonb_build_object('ok', false, 'error', 'Ship not found.');
    end if;
    if coalesce((sh->>'mercenary')::boolean, false) then
      return jsonb_build_object('ok', false, 'error', 'Mercenaries can''t take charters.');
    end if;
    if coalesce(sh->>'status', 'idle') <> 'idle' then
      return jsonb_build_object('ok', false, 'error',
        coalesce(sh->>'name', 'A ship') || ' must be idle.');
    end if;
    -- Cargo snapshot drives the pro-rated payout; clamp the client's effective
    -- cargo to base × 2.5 so a forged snapshot can't inflate the fraction.
    base_cargo := coalesce(app._ship_cargo(sh->>'type'), 0);
    cargo_snap := greatest(0, least(
      coalesce((p_charter->'cargoByShip'->>uid)::float8, base_cargo),
      base_cargo * 2.5));
    cargo_by := jsonb_set(cargo_by, array[uid], to_jsonb(cargo_snap));
    cargo_total := cargo_total + cargo_snap;
  end loop;

  reward := round((least(
    greatest(0, coalesce((p_charter->>'reward')::float8, 0)),
    app._charter_cap(st, to_jsonb(uid_arr), band, dur_ms)))::numeric);
  destroy_p := greatest(0, least(coalesce((p_charter->>'destroyChance')::float8, b.destroy), 0.85));
  impound_p := case when b.impound > 0
    then greatest(0, least(coalesce((p_charter->>'impoundChance')::float8, b.impound), 0.85))
    else 0 end;

  -- Keep the client's optimistic id when it's sane and unused (the optimistic
  -- row is replaced by this slice either way); otherwise mint one off seq.
  cid := p_charter->>'id';
  if cid is null or cid !~ '^ch[0-9]{1,12}$'
     or exists (select 1 from jsonb_array_elements(charters) c(value) where c.value->>'id' = cid) then
    seq := coalesce((st->>'seq')::int, 1) + 1;
    st := jsonb_set(st, '{seq}', to_jsonb(seq));
    cid := 'ch' || seq;
  end if;

  row_j := jsonb_build_object(
    'id', cid,
    'shipUid', uid_arr[1],
    'shipUids', to_jsonb(uid_arr),
    'band', band,
    'durationMs', dur_ms,
    'startedAt', now_ms,
    'reward', reward,
    'cargoByShip', cargo_by,
    'cargoTotal', cargo_total,
    'faction', b.faction,
    'destroyChance', destroy_p,
    'impoundChance', impound_p,
    'impound', b.impound > 0,
    'resolved', false);

  ships := (
    select coalesce(jsonb_agg(
      case when x.value->>'uid' = any(uid_arr)
        then jsonb_set(x.value, '{status}', '"charter"'::jsonb)
        else x.value end), '[]'::jsonb)
    from jsonb_array_elements(ships) x(value)
  );
  st := jsonb_set(st, '{ships}', ships);
  st := jsonb_set(st, '{charters}', charters || jsonb_build_array(row_j));
  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('charter', row_j);
end;
$$;

-- ===========================================================================
-- app_charter_cancel(p_charter_id) — abort fee (early) / buyout (late)
-- Mirrors Charters.cancelValue: bailoutAt 0.5, abortFeeRate 0.70, salvage
-- floor/ceil 0.35/0.60 ramped in 10-minute steps, ceiling squeezed by risk.
-- ===========================================================================
create or replace function public.app_charter_cancel(p_charter_id text)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms    bigint := app._now_ms();
  st        jsonb;
  charters  jsonb;
  ships     jsonb;
  c         jsonb;
  credits   double precision;
  dur       double precision;
  t         double precision;
  n_steps   int;
  done      int;
  ramp      double precision;
  ceil_v    double precision;
  value     double precision;
  fac       text;
  hit       double precision := 0;
  uid       text;
begin
  st := app._lock_state(now_ms);
  charters := coalesce(st->'charters', '[]'::jsonb);
  select x.value into c from jsonb_array_elements(charters) x(value)
    where x.value->>'id' = p_charter_id
      and not coalesce((x.value->>'resolved')::boolean, false)
    limit 1;
  if c is null then
    return jsonb_build_object('ok', false, 'error', 'Charter not found.');
  end if;

  dur := greatest(1, coalesce((c->>'durationMs')::float8, 1));
  t := greatest(0, least(now_ms - coalesce((c->>'startedAt')::bigint, now_ms), dur));
  if t / dur < 0.5 then
    value := -round((coalesce((c->>'reward')::float8, 0) * 0.70)::numeric);
  else
    n_steps := greatest(1, round(((dur * 0.5) / 600000.0)::numeric)::int);
    done := least(n_steps - 1, floor((t - dur * 0.5) / 600000.0)::int);
    ramp := case when n_steps > 1 then done::float8 / (n_steps - 1) else 1 end;
    ceil_v := greatest(0.35, 0.60 * (1 - coalesce((c->>'destroyChance')::float8, 0) * 2));
    value := round((coalesce((c->>'reward')::float8, 0)
      * (0.35 + (ceil_v - 0.35) * ramp))::numeric);
  end if;

  credits := coalesce((st->>'credits')::float8, 0);
  if value < 0 and credits < -value then
    return jsonb_build_object('ok', false, 'error', 'Not enough credits to abort.');
  end if;
  st := jsonb_set(st, '{credits}', to_jsonb(credits + value));

  fac := c->>'faction';
  if fac is not null and fac <> '' then
    hit := app.cancel_rep_hit(c->>'band');
    st := jsonb_set(st, '{reputation}',
      app._rep_change(coalesce(st->'reputation', '{}'::jsonb), fac, -hit));
  end if;

  charters := (
    select coalesce(jsonb_agg(x.value), '[]'::jsonb)
    from jsonb_array_elements(charters) x(value)
    where x.value->>'id' <> p_charter_id
  );
  st := jsonb_set(st, '{charters}', charters);

  -- Unlock hulls not held by another open charter.
  ships := coalesce(st->'ships', '[]'::jsonb);
  for uid in select jsonb_array_elements_text(coalesce(c->'shipUids',
      case when c->>'shipUid' is not null
           then jsonb_build_array(c->'shipUid') else '[]'::jsonb end)) loop
    if not exists (
      select 1 from jsonb_array_elements(charters) oc(value)
      where not coalesce((oc.value->>'resolved')::boolean, false)
        and (oc.value->'shipUids' ? uid or oc.value->>'shipUid' = uid)
    ) then
      ships := (
        select coalesce(jsonb_agg(
          case when x.value->>'uid' = uid and x.value->>'status' = 'charter'
            then jsonb_set(x.value, '{status}', '"idle"'::jsonb)
            else x.value end), '[]'::jsonb)
        from jsonb_array_elements(ships) x(value)
      );
    end if;
  end loop;
  st := jsonb_set(st, '{ships}', ships);

  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('value', value, 'repHit', hit);
end;
$$;

-- ===========================================================================
-- app_charter_resolve() — settle every matured charter (server clock + RNG)
-- ===========================================================================
create or replace function public.app_charter_resolve()
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms      bigint := app._now_ms();
  st          jsonb;
  charters    jsonb;
  kept        jsonb := '[]'::jsonb;
  resolved_out jsonb := '[]'::jsonb;
  reports     jsonb;
  ships       jsonb;
  c           jsonb;
  b           record;
  report      jsonb;
  credits     double precision;
  tier        int;
  tax_rate    double precision;
  band        text;
  label       text;
  reward      double precision;
  seed        bigint;
  smuggle     boolean;
  dmg_chance  double precision;
  dmg_lo      double precision;
  dmg_hi      double precision;
  danger_mult double precision;
  destroy_p   double precision;
  impound_p   double precision;
  has_imp     boolean;
  uid         text;
  sh          jsonb;
  i           int;
  alive_cargo double precision;
  total_cargo double precision;
  frac        double precision;
  lost_j      jsonb;
  imp_j       jsonb;
  dmgd_j      jsonb;
  surv_names  text[];
  fine        double precision;
  old_dmg     double precision;
  new_dmg     double precision;
  gross       double precision;
  payout      double precision;
  fac         text;
  gain        double precision;
  rep         jsonb;
  rival       text;
  stats       jsonb;
  any_done    boolean := false;
  bits        text;
begin
  st := app._lock_state(now_ms);
  charters := coalesce(st->'charters', '[]'::jsonb);
  reports := coalesce(st->'reports', '[]'::jsonb);
  ships := coalesce(st->'ships', '[]'::jsonb);
  credits := coalesce((st->>'credits')::float8, 0);
  tier := coalesce((st->'prestige'->>'tier')::int, 0);
  tax_rate := app._tier_tax(tier);
  rep := coalesce(st->'reputation', '{}'::jsonb);
  stats := coalesce(st->'stats', '{}'::jsonb);

  for c in select value from jsonb_array_elements(charters) loop
    if coalesce((c->>'resolved')::boolean, false) then
      continue;   -- drop resolved leftovers
    end if;
    if not coalesce((c->>'deferred')::boolean, false)
       and now_ms < coalesce((c->>'startedAt')::bigint, 0)
                    + coalesce((c->>'durationMs')::float8, 0) then
      kept := kept || jsonb_build_array(c);
      continue;
    end if;

    any_done := true;
    band := coalesce(c->>'band', 'safe');
    select * into b from app.charter_band(band);
    label := initcap(band);
    -- Re-clamp at resolve time too: rows committed by pre-RPC clients were
    -- never validated at dispatch.
    reward := least(greatest(0, coalesce((c->>'reward')::float8, 0)),
                    app._tier_cap(tier) * 3.0);

    report := jsonb_build_object(
      'uid', c->>'id', 'title', 'Charter — ' || label, 'type', 'charter',
      'success', true, 'ts', now_ms, 'danger', band, 'faction', c->'faction',
      'credits', 0, 'items', '[]'::jsonb, 'stock', null,
      'lost', '[]'::jsonb, 'impounded', '[]'::jsonb, 'damaged', '[]'::jsonb);

    if coalesce((c->>'deferred')::boolean, false) then
      -- Legacy "payout pending" row: hulls came home long ago — settle it.
      payout := round((reward * (1.0 - tax_rate))::numeric);
      credits := credits + payout;
      report := jsonb_set(report, '{credits}', to_jsonb(payout));
      report := jsonb_set(report, '{taxed}', to_jsonb(reward - payout));
      report := jsonb_set(report, '{summary}',
        to_jsonb('Deferred charter payout settled (+' || payout::bigint || 'c).'));
      reports := jsonb_build_array(report) || reports;
      resolved_out := resolved_out || jsonb_build_array(report);
      continue;
    end if;

    seed := market.seed_hash('cosmocrat-market-v1', 'charter',
      coalesce(c->>'id', '?'), coalesce(c->>'startedAt', '0'));
    smuggle := band in ('high', 'extreme');
    dmg_chance := case when smuggle then 0.40 else 0.20 end;   -- DMGCFG smuggle/transport
    dmg_lo := case when smuggle then 0.05 else 0.02 end;
    dmg_hi := case when smuggle then 0.20 else 0.08 end;
    danger_mult := case band when 'safe' then 0.5 when 'low' then 0.75
      when 'moderate' then 1.0 when 'high' then 1.3 when 'extreme' then 1.6 else 1.0 end;
    destroy_p := greatest(0, least(coalesce((c->>'destroyChance')::float8,
      coalesce(b.destroy, 0)), 0.85));
    has_imp := coalesce((c->>'impound')::boolean, coalesce(b.impound, 0) > 0);
    impound_p := case when has_imp
      then greatest(0, least(coalesce((c->>'impoundChance')::float8,
        coalesce(b.impound, 0)), 0.85))
      else 0 end;

    i := 0; alive_cargo := 0;
    lost_j := '[]'::jsonb; imp_j := '[]'::jsonb; dmgd_j := '[]'::jsonb;
    surv_names := array[]::text[];
    for uid in select jsonb_array_elements_text(coalesce(c->'shipUids',
        case when c->>'shipUid' is not null
             then jsonb_build_array(c->'shipUid') else '[]'::jsonb end)) loop
      i := i + 1;
      select value into sh from jsonb_array_elements(ships) x(value)
        where x.value->>'uid' = uid limit 1;
      if sh is null then
        continue;   -- hull already gone (sold via exploit / legacy) — no cargo credit
      end if;

      if market.u01(seed, i * 4 + 1) < destroy_p then
        lost_j := lost_j || jsonb_build_array(jsonb_build_object(
          'uid', uid, 'name', coalesce(sh->>'name', uid)));
        ships := (
          select coalesce(jsonb_agg(x.value), '[]'::jsonb)
          from jsonb_array_elements(ships) x(value)
          where x.value->>'uid' <> uid
        );
        continue;
      end if;

      if has_imp and market.u01(seed, i * 4 + 2) < impound_p then
        fine := app._impound_fine(st, sh);
        ships := (
          select coalesce(jsonb_agg(
            case when x.value->>'uid' = uid
              then jsonb_set(jsonb_set(x.value, '{status}', '"impounded"'::jsonb),
                             '{retrieveCost}', to_jsonb(fine))
              else x.value end), '[]'::jsonb)
          from jsonb_array_elements(ships) x(value)
        );
        imp_j := imp_j || jsonb_build_array(jsonb_build_object(
          'uid', uid, 'name', coalesce(sh->>'name', uid), 'cost', fine));
        continue;
      end if;

      -- Survivor: cargo credit, possible wear, back to idle.
      surv_names := array_append(surv_names, coalesce(sh->>'name', uid));
      alive_cargo := alive_cargo + greatest(0, coalesce((c->'cargoByShip'->>uid)::float8, 0));
      old_dmg := coalesce((sh->>'dmg')::float8, 0);
      new_dmg := old_dmg;
      if market.u01(seed, i * 4 + 3) < dmg_chance then
        new_dmg := least(0.95, old_dmg
          + (dmg_lo + (dmg_hi - dmg_lo) * market.u01(seed, i * 4 + 4)) * danger_mult);
        dmgd_j := dmgd_j || jsonb_build_array(jsonb_build_object(
          'uid', uid, 'name', coalesce(sh->>'name', uid),
          'pct', round(((new_dmg - old_dmg) * 100)::numeric)));
      end if;
      ships := (
        select coalesce(jsonb_agg(
          case when x.value->>'uid' = uid
            then jsonb_set(jsonb_set(x.value, '{status}', '"idle"'::jsonb),
                           '{dmg}', to_jsonb(new_dmg))
            else x.value end), '[]'::jsonb)
        from jsonb_array_elements(ships) x(value)
      );
    end loop;

    report := jsonb_set(report, '{lost}', lost_j);
    report := jsonb_set(report, '{impounded}', imp_j);
    report := jsonb_set(report, '{damaged}', dmgd_j);

    if coalesce(array_length(surv_names, 1), 0) = 0 then
      report := jsonb_set(report, '{success}', 'false'::jsonb);
      bits := '';
      if jsonb_array_length(lost_j) > 0 then
        bits := 'lost ' || (select string_agg(x.value->>'name', ', ')
          from jsonb_array_elements(lost_j) x(value));
      end if;
      if jsonb_array_length(imp_j) > 0 then
        bits := bits || case when bits <> '' then '; ' else '' end || 'impounded '
          || (select string_agg(x.value->>'name', ', ')
              from jsonb_array_elements(imp_j) x(value));
      end if;
      report := jsonb_set(report, '{summary}', to_jsonb(
        'Charter wiped — ' || coalesce(nullif(bits, ''), 'no hulls returned') || '.'));
    else
      total_cargo := greatest(0, coalesce((c->>'cargoTotal')::float8, 0));
      frac := case when total_cargo > 0
        then greatest(0, least(alive_cargo / total_cargo, 1)) else 1 end;
      gross := round((reward * frac * app.rep_reward_mult(st, c->>'faction'))::numeric);
      gross := least(gross, app._tier_cap(tier) * 3.0);
      payout := case when gross > 0 then round((gross * (1.0 - tax_rate))::numeric) else 0 end;
      credits := credits + payout;
      report := jsonb_set(report, '{credits}', to_jsonb(payout));
      report := jsonb_set(report, '{taxed}', to_jsonb(gross - payout));
      report := jsonb_set(report, '{cargoFrac}', to_jsonb(frac));
      report := jsonb_set(report, '{shipName}',
        to_jsonb(array_to_string(surv_names, ', ')));
      stats := jsonb_set(stats, '{contractsDone}',
        to_jsonb(coalesce((stats->>'contractsDone')::int, 0) + 1));

      fac := c->>'faction';
      if fac is not null and fac <> '' then
        gain := case band when 'safe' then 3 when 'low' then 5 when 'moderate' then 7
          when 'high' then 10 when 'extreme' then 13 else 5 end;
        rep := app._rep_change(rep, fac, gain);
        rival := app._faction_rival(fac);
        if rival is not null then
          rep := app._rep_change(rep, rival, -round((gain * 0.5)::numeric));
        end if;
        if smuggle then
          rep := app._rep_change(rep, 'free_trade', -2);
        end if;
      end if;

      bits := array_to_string(surv_names, ', ') || ' returned from '
        || case when label ~* '^[aeiou]' then 'an ' else 'a ' end
        || lower(label) || ' charter (+' || payout::bigint || 'c).';
      if jsonb_array_length(lost_j) > 0 then
        bits := bits || ' Lost ' || (select string_agg(x.value->>'name', ', ')
          from jsonb_array_elements(lost_j) x(value)) || '.';
      end if;
      if jsonb_array_length(imp_j) > 0 then
        bits := bits || ' Impounded ' || (select string_agg(x.value->>'name', ', ')
          from jsonb_array_elements(imp_j) x(value)) || '.';
      end if;
      if frac < 0.999999 then
        bits := bits || ' Payout cut to ' || round((frac * 100)::numeric) || '% — cargo hulls missing.';
      end if;
      report := jsonb_set(report, '{summary}', to_jsonb(bits));
    end if;

    reports := jsonb_build_array(report) || reports;
    resolved_out := resolved_out || jsonb_build_array(report);
  end loop;

  if not any_done then
    return app.result_slice(st) || jsonb_build_object('resolved', '[]'::jsonb);
  end if;

  if jsonb_array_length(reports) > 20 then
    reports := (
      select jsonb_agg(value) from (
        select value, ordinality from jsonb_array_elements(reports) with ordinality
        order by ordinality limit 20
      ) t
    );
  end if;

  st := jsonb_set(st, '{credits}', to_jsonb(credits));
  st := jsonb_set(st, '{ships}', ships);
  st := jsonb_set(st, '{charters}', kept);
  st := jsonb_set(st, '{reports}', reports);
  st := jsonb_set(st, '{reputation}', rep);
  st := jsonb_set(st, '{stats}', stats);
  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('resolved', resolved_out);
end;
$$;

-- ===========================================================================
-- result_slice + app_commit — charters join the server-owned slices.
-- Same as workshop_craft.sql (the last file to replace both, so this extends
-- that layer) plus the charters line. A client on this SQL must also run the
-- matching js (Charters routes through the RPCs); an older cached client's
-- local-only dispatch is dropped by the next commit and its hulls simply
-- return to idle — nothing is lost but the forged lock.
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

  -- Charters: dispatched/cancelled/resolved via app_charter_* (this file), so
  -- the rows are server-owned — a forged row can't ride in on the autosave.
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
  merged := jsonb_set(merged, '{extractors}', app._merge_extractors(
    coalesce(server->'extractors', '{}'::jsonb),
    coalesce(p_state->'extractors', '{}'::jsonb)));
  merged := jsonb_set(merged, '{components}', coalesce(server->'components', '{}'::jsonb));

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

  perform app._write_state(merged, now_ms);
  return jsonb_build_object('ok', true, 'state', merged);
end;
$$;

grant execute on function public.app_charter_dispatch(jsonb) to authenticated;
grant execute on function public.app_charter_cancel(text) to authenticated;
grant execute on function public.app_charter_resolve() to authenticated;
