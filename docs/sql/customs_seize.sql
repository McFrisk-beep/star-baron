-- customs_seize.sql — make customs / piracy seizures stick online (High H4).
--
-- Customs scans (js/economy.js customsScan) and charter piracy losses used to be
-- purely LOCAL decrements of `positions`. But positions are server-owned:
-- app_commit force-restores them on the next autosave, so the "seized" goods
-- quietly came back ~10s later — the whole customs risk mechanic was a no-op for
-- signed-in players. Worse, with a station Customs House the impound lot had
-- already taken a copy of the cargo, so 100 seized units turned into 140.
--
-- This RPC applies the seizure to the server ledger. The RNG roll stays on the
-- client (it owns the flavor + the hold/bay split); the server just clamps and
-- decrements. Decrease-only, so a tampered client can only hurt itself — and a
-- client that skips the call merely keeps today's (broken) no-op behaviour.
--
-- Apply any time after phase3_pull_prestige.sql (needs app._lock_state /
-- app._write_state / app.result_slice). Safe to re-run.

create or replace function public.app_customs_seize(p_comm text, p_qty int)
returns jsonb
language plpgsql security definer set search_path = public, market, app as $$
declare
  now_ms    bigint := app._now_ms();
  st        jsonb;
  positions jsonb;
  avg_cost  jsonb;
  held      double precision;
  take      double precision;
begin
  if p_comm is null or p_comm = '' or coalesce(p_qty, 0) <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Nothing to seize.');
  end if;

  st := app._lock_state(now_ms);
  positions := coalesce(st->'positions', '{}'::jsonb);
  avg_cost  := coalesce(st->'avgCost', '{}'::jsonb);
  held := coalesce((positions->>p_comm)::float8, 0);
  if held <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Nothing to seize.');
  end if;

  take := least(held, p_qty::float8);
  positions := jsonb_set(positions, array[p_comm], to_jsonb(held - take));
  if held - take <= 0 then
    avg_cost := jsonb_set(avg_cost, array[p_comm], to_jsonb(0::float8));
  end if;
  st := jsonb_set(st, '{positions}', positions);
  st := jsonb_set(st, '{avgCost}', avg_cost);
  perform app._write_state(st, now_ms);
  return app.result_slice(st) || jsonb_build_object('seized', take, 'comm', p_comm);
end;
$$;

grant execute on function public.app_customs_seize(text, int) to authenticated;
