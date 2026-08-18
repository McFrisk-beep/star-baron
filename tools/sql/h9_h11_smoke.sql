-- crime_smoke.sql — assertions for the H9/H10/H11 SQL:
--   merc_expiry.sql (expired mercs leave the roster),
--   crime_coefficient.sql (server-owned record, 1/day decay, priced + capped
--   senate influence, the barred line), and senate_ballot.sql's crime gate.
-- Built + run by tools/sql/build_crime_check.js — throwaway databases only.

do $t$
declare
  uid uuid := auth.uid();
  now_ms bigint;
  day constant bigint := 86400000;
  base jsonb;
  r jsonb;
  st jsonb;
  n int;
  s numeric;
  bill_open text;
  bill_shut text;
  new_id bigint;
begin
  -- Start from a clean slate so the file is re-runnable against the same
  -- scratch database (the lobby-decay assertion counts prior pushes).
  delete from public.world_senate_influence;
  delete from public.world_senate;
  delete from public.world_senate_result;
  delete from public.station_auctions;
  delete from public.stations;
  delete from public.players;

  delete from app.clock;
  insert into app.clock(now_ms) values (1800000000000);
  now_ms := app._now_ms();

  -- =====================================================================
  -- H9 — expired mercenaries leave the roster
  -- =====================================================================
  base := jsonb_build_object(
    'credits', 1000000, 'currentSystem', 'here', 'travel', null,
    'unlockedSystems', jsonb_build_array('here'),
    'prestige', jsonb_build_object('tier', 3, 'multiplier', 1),
    'stats', jsonb_build_object('trades', 0),
    'items', '{}'::jsonb, 'expeditions', '[]'::jsonb,
    'ships', jsonb_build_array(
      jsonb_build_object('uid','s1','type','mule','status','idle'),
      jsonb_build_object('uid','m_exp','type','mule','status','idle','mercenary',true,'expiresAt', now_ms - 1000),
      jsonb_build_object('uid','m_live','type','mule','status','idle','mercenary',true,'expiresAt', now_ms + 600000),
      jsonb_build_object('uid','m_busy','type','mule','status','mission','mercenary',true,'expiresAt', now_ms - 1000)
    ));
  insert into public.players(user_id, state, updated_ms) values (uid, base, 0)
    on conflict (user_id) do update set state = excluded.state;

  r := public.app_commit(base);
  if (r->>'ok')::boolean is not true then raise exception 'commit failed: %', r; end if;
  st := r->'state';
  if exists (select 1 from jsonb_array_elements(st->'ships') x where x.value->>'uid' = 'm_exp') then
    raise exception 'expired idle merc survived: %', st->'ships';
  end if;
  if not exists (select 1 from jsonb_array_elements(st->'ships') x where x.value->>'uid' = 'm_live') then
    raise exception 'live merc was pruned: %', st->'ships';
  end if;
  if not exists (select 1 from jsonb_array_elements(st->'ships') x where x.value->>'uid' = 'm_busy') then
    raise exception 'merc still on a mission was pruned early: %', st->'ships';
  end if;
  raise notice 'ok H9: expired idle merc released; live and mission mercs kept';

  -- =====================================================================
  -- crime coefficient: server-owned, cools 1/day, idempotent
  -- =====================================================================
  -- A save edit can't clear the record.
  update public.players set state = jsonb_set(jsonb_set(state, '{crime}', to_jsonb(130)),
    '{crimeSeenAt}', to_jsonb(now_ms)) where user_id = uid;
  r := public.app_commit(base || jsonb_build_object('crime', 0));
  if (r->'state'->>'crime')::numeric <> 130 then
    raise exception 'client cleared its own record: %', r->'state'->>'crime';
  end if;
  raise notice 'ok: crime is server-owned (a forged 0 is ignored)';

  -- Three days later it has cooled by exactly 3, and re-running changes nothing.
  update public.players set state = jsonb_set(state, '{crimeSeenAt}', to_jsonb(now_ms - 3 * day))
   where user_id = uid;
  r := public.app_commit(base);
  if (r->'state'->>'crime')::numeric <> 127 then
    raise exception 'expected 127 after 3 days, got %', r->'state'->>'crime';
  end if;
  r := public.app_commit(base);
  if (r->'state'->>'crime')::numeric <> 127 then
    raise exception 'decay is not idempotent: %', r->'state'->>'crime';
  end if;
  raise notice 'ok: crime cools 1/day and the sweep is idempotent';

  -- =====================================================================
  -- H10 — senate influence is priced, capped and recorded
  -- =====================================================================
  -- Capture the real ids: the identity sequence keeps climbing across runs, so
  -- hardcoding 'wb1' would silently point at a deleted bill on a re-run.
  insert into public.world_senate(issue, type, lean, effect, title, blurb, votes_at)
    values ('trade', 'priceCap', 1, '{}'::jsonb, 'Test Bill', 'blurb', now() + interval '1 hour')
    returning id into new_id;
  bill_open := 'wb' || new_id;
  insert into public.world_senate(issue, type, lean, effect, title, blurb, votes_at)
    values ('trade', 'priceCap', 1, '{}'::jsonb, 'Closed Bill', 'blurb', now() - interval '1 hour')
    returning id into new_id;
  bill_shut := 'wb' || new_id;

  update public.players set state = jsonb_set(jsonb_set(base, '{crime}', to_jsonb(50)),
    '{crimeSeenAt}', to_jsonb(now_ms)) where user_id = uid;

  -- A closed vote takes nothing.
  r := public.app_senate_influence(bill_shut, 'lobby_fac', 'free_trade', 1, 99);
  if r->>'error' <> 'voting closed' then raise exception 'closed bill accepted: %', r; end if;

  -- Lobby: charged, and the strength is the server's, not the request's.
  r := public.app_senate_influence(bill_open, 'lobby_fac', 'free_trade', 1, 999);
  if (r->>'ok')::boolean is not true then raise exception 'lobby refused: %', r; end if;
  if (r->>'cost')::bigint <> 40000 then raise exception 'lobby cost %', r->>'cost'; end if;
  if abs((r->>'strength')::numeric - 1.232) > 0.001 then
    raise exception 'lobby strength % (forged 999 must be ignored)', r->>'strength';
  end if;
  if (r->>'crime')::numeric <> 50 then raise exception 'lobbying is legal — no crime: %', r; end if;

  -- Repeat lobbies of one bloc decay.
  r := public.app_senate_influence(bill_open, 'lobby_fac', 'free_trade', 1, 999);
  if abs((r->>'strength')::numeric - 0.6776) > 0.001 then
    raise exception 'repeat lobby did not decay: %', r->>'strength';
  end if;

  -- Bribery and coercion go on the record.
  r := public.app_senate_influence(bill_open, 'bribe', 'sen_navos', 1, 99);
  if (r->>'cost')::bigint <> 20000 or (r->>'crime')::numeric <> 56 then
    raise exception 'bribe: %', r;
  end if;
  r := public.app_senate_influence(bill_open, 'coerce', 'sen_kepler', 1, 99);
  if (r->>'cost')::bigint <> 8000 or (r->>'crime')::numeric <> 76 then
    raise exception 'coerce: %', r;
  end if;
  if (r->>'refused')::boolean is not false then
    raise exception 'a clean record must not be refused: %', r;
  end if;

  -- One senator, one working-over.
  r := public.app_senate_influence(bill_open, 'coerce', 'sen_kepler', 1, 99);
  if r->>'error' is null then raise exception 'senator worked twice: %', r; end if;

  -- Tier 3 → 1 + 3 = 4 senators per bill.
  r := public.app_senate_influence(bill_open, 'bribe', 'sen_a', 1, 99);
  if (r->>'ok')::boolean is not true then raise exception 'third target refused: %', r; end if;
  r := public.app_senate_influence(bill_open, 'bribe', 'sen_b', 1, 99);
  if (r->>'ok')::boolean is not true then raise exception 'fourth target refused: %', r; end if;
  r := public.app_senate_influence(bill_open, 'bribe', 'sen_c', 1, 99);
  if r->>'error' not like 'only 4 senator%' then
    raise exception 'fifth target was NOT capped: %', r;
  end if;
  raise notice 'ok H10: tier caps the senators worked per bill (4 at tier 3)';

  -- Credits actually left the account: 40000×2 + 20000 + 8000 + 20000×2 = 148000
  select (state->>'credits')::numeric into s from public.players where user_id = uid;
  if s <> 1000000 - 148000 then raise exception 'expected 852000 credits, got %', s; end if;
  select count(*) into n from public.world_senate_influence where bill_id = bill_open and user_id = uid;
  if n <> 6 then raise exception 'expected 6 booked pushes, got %', n; end if;
  raise notice 'ok H10: influence is charged server-side (148000c for 6 pushes)';

  -- Tier gates.
  update public.players set state = jsonb_set(state, '{prestige,tier}', to_jsonb(0)) where user_id = uid;
  r := public.app_senate_influence(bill_open, 'lobby_fac', 'syndicate', 1, 1);
  if r->>'error' not like 'Baron Tier 1%' then raise exception 'tier gate open: %', r; end if;
  update public.players set state = jsonb_set(state, '{prestige,tier}', to_jsonb(3)) where user_id = uid;

  -- Bad shapes.
  r := public.app_senate_influence(bill_open, 'lobby_fac', 'not_a_faction', 1, 1);
  if r->>'error' <> 'invalid target' then raise exception 'faction not validated: %', r; end if;
  r := public.app_senate_influence(bill_open, 'bribe', 'DROP TABLE', 1, 1);
  if r->>'error' <> 'invalid target' then raise exception 'senator id not validated: %', r; end if;

  -- =====================================================================
  -- The barred line (crime ≥ 200): the chamber closes
  -- =====================================================================
  update public.players set state = jsonb_set(state, '{crime}', to_jsonb(250)) where user_id = uid;
  r := public.app_senate_influence(bill_open, 'lobby_fac', 'syndicate', 1, 1);
  if r->>'error' <> 'senate_locked' then raise exception 'barred baron still influenced: %', r; end if;
  select (state->>'credits')::numeric into s from public.players where user_id = uid;
  if s <> 852000 then raise exception 'a refused push still charged: %', s; end if;

  r := public.app_senate_ballot('price_cap', 'mineral', 1, 3);
  if r->>'error' <> 'senate_locked' then raise exception 'barred baron tabled a ballot: %', r; end if;
  raise notice 'ok H10: at 200+ influence and ballots are both refused';

  -- Back under the line and the chamber reopens.
  update public.players set state = jsonb_set(state, '{crime}', to_jsonb(199)) where user_id = uid;
  r := public.app_senate_influence(bill_open, 'lobby_fac', 'syndicate', 1, 1);
  if (r->>'ok')::boolean is not true then raise exception 'still barred under the line: %', r; end if;
  raise notice 'ok: below the line the chamber reopens';

  -- =====================================================================
  -- H11 — opening a station auction can't double-escrow
  -- =====================================================================
  update public.players set state = jsonb_set(jsonb_set(state, '{credits}', to_jsonb(5000000)),
    '{crime}', to_jsonb(50)) where user_id = uid;
  insert into public.stations(system_id, status, tier) values ('navos', 'npc', 'Berth')
    on conflict (system_id) do update set status = 'npc', owner_id = null;
  delete from public.station_auctions where system_id = 'navos';

  n := public._station_opening_bid('Berth', '{}'::jsonb, 0);
  r := public.app_station_auction_open('navos', n);
  if (r->>'ok')::boolean is not true then raise exception 'first open refused: %', r; end if;
  select (state->>'credits')::numeric into s from public.players where user_id = uid;
  if s <> 5000000 - n then raise exception 'escrow not taken: %', s; end if;

  -- Second open finds the live auction and takes nothing.
  r := public.app_station_auction_open('navos', n);
  if r->>'error' <> 'Auction already open.' then raise exception 'second open accepted: %', r; end if;
  select (state->>'credits')::numeric into s from public.players where user_id = uid;
  if s <> 5000000 - n then raise exception 'a refused open still escrowed: %', s; end if;
  if (select high_bidder from public.station_auctions where system_id = 'navos') is distinct from uid then
    raise exception 'high bidder was overwritten';
  end if;
  raise notice 'ok H11: a second open escrows nothing and cannot overwrite the high bidder';
end;
$t$;
