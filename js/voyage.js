/* voyage.js — visible voyages (docs/LIVING_GALAXY.md §3–§4, step 3).

   A voyage is any fleet movement: flagship transfer, mission, charter, courier
   run, survey. Everything here is a VIEW of state that already exists — flying
   is arithmetic on the clock (`pos(plan, t)` is pure, O(legs), no tick), and
   the mid-flight event schedule is a pure function of the voyage uid, so every
   reload recomputes the identical journey. Nothing new is persisted.

   Every lane leg is choreographed (legPhase): accelerate out of the system,
   slow into the gate, hold while the hyperdrive spools, streak down the lane,
   drop out at the far gate, then cruise in — so ships visibly do the maneuver
   instead of teleporting at constant speed. Total leg time is unchanged;
   only where the ship is drawn inside the leg moves.

   Consumers:
     • StarMap galaxy view — moving markers on the lane polylines.
     • StarMap system view — flagships / convoys crossing between real gates,
       with the owner's name over flagships (own + other players'). Docked
       ships are berthed inside the station and not drawn.
     • Hub — the Live View chase cam (screen centred on the followed ship,
       with a mini chart inset), and the mission cards' "▶ watch" buttons.

   §4.4: for client-local voyages (guests, charters' local loop) the dice roll
   moved to dispatch — Missions/Charters draw outcomes from a stream seeded by
   the voyage uid, so a mid-flight skirmish can already know the verdict.
   Server-settled voyages keep the server verdict; their events stay
   non-decisive. Nothing here ever touches the wallet.

   Cross-player flagships ride a tiny optional table (docs/sql/voyage_presence.sql):
   one row per player — from/to/departedAt/etaMs — and every client replays the
   same pure function over it. No table → feature silently off.               */

const Voyages = {
  s() { return window.Game && Game.state; },
  _plans: {},        // route key → legs (derived cache, never persisted)
  _seen: new Set(),  // announced event ids (session memory; past events prime silently)
  _primed: false,

  // ---- pure geometry -------------------------------------------------------
  // plan: { legs: [systemId...], departedAt, etaMs } (~200 bytes, derived)
  plan(fromId, toId, departedAt, etaMs) {
    if (!window.Lanes || !window.Galaxy) return null;
    const key = fromId + ">" + toId;
    let legs = this._plans[key];
    if (!legs) {
      const r = Lanes.route(fromId, toId);
      if (!r || r.path.length < 2) return null;
      legs = this._plans[key] = r.path;
    }
    return { legs, departedAt, etaMs };
  },

  // Cumulative leg lengths for a legs array (cached on the array itself).
  _cum(legs) {
    if (legs._cum) return legs._cum;
    const cum = [0];
    for (let i = 0; i + 1 < legs.length; i++) {
      const a = Galaxy.get(legs[i]).pos, b = Galaxy.get(legs[i + 1]).pos;
      cum.push(cum[i] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    return (legs._cum = cum);
  },

  // Per-leg choreography, by time fraction through the leg. gateD is where the
  // gate sits along the lane (distance fraction from each end).
  LEG: { cruiseOut: 0.30, gateOut: 0.40, hyperEnd: 0.60, gateIn: 0.70, gateD: 0.08 },
  _ss(x) { x = Util.clamp(x, 0, 1); return x * x * (3 - 2 * x); },   // smoothstep
  legPhase(legP) {
    const L = this.LEG;
    if (legP < L.cruiseOut) return { mode: "cruise", side: "out", f: legP / L.cruiseOut };
    if (legP < L.gateOut) return { mode: "gate", side: "out", f: (legP - L.cruiseOut) / (L.gateOut - L.cruiseOut) };
    if (legP < L.hyperEnd) return { mode: "hyper", side: "out", f: (legP - L.gateOut) / (L.hyperEnd - L.gateOut) };
    if (legP < L.gateIn) return { mode: "gate", side: "in", f: (legP - L.hyperEnd) / (L.gateIn - L.hyperEnd) };
    return { mode: "cruise", side: "in", f: (legP - L.gateIn) / (1 - L.gateIn) };
  },
  // Time fraction → eased DISTANCE fraction along the leg: slow near the ends
  // (accelerate away, decelerate into the gate, stop-and-go at each side),
  // fast through the middle (hyperspace). Monotonic, 0→0 and 1→1, pure.
  _legD(legP) {
    const L = this.LEG, gd = L.gateD;
    const ph = this.legPhase(legP);
    if (ph.mode === "cruise") return ph.side === "out" ? gd * this._ss(ph.f) : 1 - gd + gd * this._ss(ph.f);
    if (ph.mode === "gate") return ph.side === "out" ? gd : 1 - gd;
    return gd + (1 - 2 * gd) * ph.f;
  },

  // Where a plan is at time t. Pure — same t in, same point out, in any order
  // (the §9 anti-accumulation property). Galaxy pos space (0..1 fractions).
  // legP is the raw TIME fraction through the leg; x/y apply the choreography.
  // → { x, y, heading, a, b, leg, p, legP } or null (degenerate plan).
  pos(plan, t = Date.now()) {
    if (!plan || !plan.legs || plan.legs.length < 2) return null;
    // A malformed voyage (corrupt save, a mission built with no duration) would
    // otherwise produce NaN coordinates and draw nothing, invisibly. Degrade to
    // "not flying" so callers skip it instead of painting at NaN.
    if (!Number.isFinite(plan.departedAt) || !Number.isFinite(plan.etaMs)) return null;
    const p = Util.clamp((t - plan.departedAt) / Math.max(1, plan.etaMs), 0, 1);
    const cum = this._cum(plan.legs);
    const total = cum[cum.length - 1] || 1e-9;
    const d = p * total;
    let i = 0;
    while (i + 2 < cum.length && cum[i + 1] <= d) i++;
    const a = Galaxy.get(plan.legs[i]).pos, b = Galaxy.get(plan.legs[i + 1]).pos;
    const seg = Math.max(1e-9, cum[i + 1] - cum[i]);
    const legP = Util.clamp((d - cum[i]) / seg, 0, 1);
    const ld = this._legD(legP);
    return { x: a.x + (b.x - a.x) * ld, y: a.y + (b.y - a.y) * ld,
      heading: Math.atan2(b.y - a.y, b.x - a.x),
      a: plan.legs[i], b: plan.legs[i + 1], leg: i, p, legP };
  },

  // Board contracts generated SERVER-side carry a PLACEHOLDER destination
  // ("Sector 12"): the SQL has no galaxy table — the galaxy is client-seeded
  // from GALAXY.seed — so app_board_contract can't name a real system. An
  // unresolvable name maps to a real system deterministically from the name
  // itself, so every client agrees and the same label always means the same
  // place. Without this every signed-in player's missions had no destination
  // and vanished from the Live View entirely.
  _sysByName(name) {
    if (!name) return null;
    const hit = Galaxy.list.find(x => x.name === name);
    if (hit) return hit;
    if (!window.Combat || !Galaxy.list.length) return null;
    const rng = Combat._mk(Combat.seedFrom("sysname:" + name));
    return Galaxy.list[Math.floor(rng() * Galaxy.list.length)] || null;
  },
  playerName() {
    return (window.Cloud && Cloud.signedIn && Cloud.signedIn()
      && Cloud.displayName && Cloud.displayName()) || "You";
  },
  _flagSprite() {
    const md = window.Fleet && Fleet.mainDef ? Fleet.mainDef() : null;
    return md ? "ship:" + md.sprite : "ship:shuttle";
  },
  // First live hull's top-down sprite for a convoy (same ref scheme as combat.js).
  _fleetSprite(uids) {
    for (const u of uids || []) {
      const sh = Fleet.ship(u); if (!sh) continue;
      const def = Fleet.shipDef(sh.type);
      if (def) return (def.cls === "escort" ? "race:" : "ship:") + def.sprite;
    }
    return "ship:mule";
  },

  // ---- own voyages: projections of existing state --------------------------
  // Each: { id, kind, label, name?, you:true, sprite, plan?|sysId, at? }
  //   at = pos() result when moving; sysId set when parked in a system.
  active(now = Date.now()) {
    const s = this.s();
    if (!s || !window.Lanes || !Object.keys(Lanes.adj).length) return [];
    const out = [];
    const here = s.currentSystem;

    // flagship — only while travelling; docked = berthed inside the station
    if (s.travel) {
      const plan = this.plan(s.travel.from, s.travel.to, s.travel.departedAt, s.travel.etaMs);
      if (plan) out.push({ id: "flag", kind: "flagship", label: "Flagship", name: this.playerName(),
        you: true, sprite: this._flagSprite(), plan, at: this.pos(plan, now) });
    }

    // missions — out leg, on-site work, return leg (Missions.phaseAt drives it)
    for (const m of s.missions || []) {
      if (m.resolved || !m.phases) continue;
      const dest = this._sysByName(m.sysName); if (!dest) continue;
      const from = (m.fromSys && Galaxy.get(m.fromSys)) ? m.fromSys : here;
      if (!from) continue;
      const ph = Missions.phaseAt(m, now);
      const base = { id: "m:" + m.uid, kind: "mission", label: m.title, you: true,
        sprite: this._fleetSprite(m.shipUids), mission: m };
      // A job in the system we launched from has no transit legs — the fleet
      // works local space the whole time. Still a voyage you can follow.
      if (from === dest.id) { out.push({ ...base, sysId: dest.id, phaseLabel: ph.label }); continue; }
      const outMs = m.phases[0].ms, inMs = m.phases[m.phases.length - 1].ms;
      if (ph.dir === "out") {
        const plan = this.plan(from, dest.id, m.startedAt, outMs);
        if (plan) out.push({ ...base, plan, at: this.pos(plan, now) });
      } else if (ph.dir === "in") {
        const plan = this.plan(dest.id, from, m.startedAt + m.totalMs - inMs, inMs);
        if (plan) out.push({ ...base, plan, at: this.pos(plan, now) });
      } else out.push({ ...base, sysId: dest.id, phaseLabel: ph.label });
    }

    // charters — abstract timed jobs get a deterministic out-and-back patrol
    // (seeded from the charter id, like everything else): visible, never load-bearing.
    for (const c of (window.Charters ? Charters.active() : [])) {
      const from = (c.fromSys && Galaxy.get(c.fromSys)) ? c.fromSys : here;
      if (!from) continue;
      const rng = Combat._mk(Combat.seedFrom("chv:" + c.id));
      const cand = Galaxy.list[Math.floor(rng() * Galaxy.list.length)];
      if (!cand || cand.id === from) continue;
      const p = Util.clamp((now - c.startedAt) / Math.max(1, c.durationMs), 0, 1);
      const base = { id: "c:" + c.id, kind: "charter", you: true,
        label: "Charter — " + ((DANGER.find(d => d.id === c.band) || {}).label || c.band),
        sprite: this._fleetSprite(Charters.shipUids(c)), charter: c };
      const half = c.durationMs / 2;
      const plan = p < 0.5
        ? this.plan(from, cand.id, c.startedAt, half)
        : this.plan(cand.id, from, c.startedAt + half, half);
      if (plan) out.push({ ...base, plan, at: this.pos(plan, now) });
    }

    // couriers — shipments already carry the exact { from, to, departedAt, etaMs }
    for (const sh of (window.Shipments ? Shipments.active() : [])) {
      const plan = this.plan(sh.from, sh.to, sh.departedAt, sh.etaMs);
      if (plan) out.push({ id: "sh:" + sh.id, kind: "courier", label: "Courier", you: true,
        sprite: "ship:mule", plan, at: this.pos(plan, now) });
    }

    // surveys — out 45%, charting on site 10%, back 45%
    for (const e of (window.Expeditions ? Expeditions.list() : [])) {
      if (e.resolved || e.debrief) continue;
      const from = (e.fromSys && Galaxy.get(e.fromSys)) ? e.fromSys : here;
      if (!from || from === e.sysId || !Galaxy.get(e.sysId)) continue;
      const sh = Fleet.ship(e.shipUid);
      const base = { id: "x:" + e.id, kind: "survey", you: true,
        label: sh ? sh.name : "Survey ship",
        sprite: sh ? this._fleetSprite([sh.uid]) : "ship:sparrow" };
      const p = Util.clamp((now - e.startedAt) / Math.max(1, e.etaMs), 0, 1);
      const legMs = e.etaMs * 0.45;
      const plan = p < 0.45 ? this.plan(from, e.sysId, e.startedAt, legMs)
        : p >= 0.55 ? this.plan(e.sysId, from, e.startedAt + e.etaMs * 0.55, legMs)
        : null;
      if (plan) out.push({ ...base, plan, at: this.pos(plan, now) });
      else if (p >= 0.45 && p < 0.55) out.push({ ...base, sysId: e.sysId, phaseLabel: "Charting the system" });
    }
    return out;
  },

  // ---- other players' flagships (docs/sql/voyage_presence.sql) -------------
  _presence: [], _presAt: 0, _presMissing: false, _pubAt: 0,
  _presenceOn() { return !!(window.Cloud && Cloud.enabled && Cloud.client) && !this._presMissing; },

  async refreshPresence(force = false) {
    if (!this._presenceOn()) return;
    const now = Date.now();
    if (!force && now - this._presAt < 60000) return;
    this._presAt = now;
    try {
      const { data, error } = await Cloud.client.from("flagship_presence")
        .select("user_id,display,sprite,from_sys,to_sys,departed_at,eta_ms,updated_at")
        .gt("updated_at", new Date(now - 12 * 3600000).toISOString())
        .limit(200);
      if (error) throw error;
      const me = (window.Cloud && Cloud.signedIn() && Cloud.user()) ? String(Cloud.user().id) : null;
      this._presence = (data || []).filter(r => String(r.user_id) !== me).map(r => ({
        id: "p:" + r.user_id,
        name: String(r.display || "Baron").slice(0, 24),
        sprite: /^[a-z0-9_:-]{1,40}$/i.test(String(r.sprite || "")) ? String(r.sprite) : "ship:shuttle",
        from: String(r.from_sys || ""), to: String(r.to_sys || ""),
        departedAt: +r.departed_at || 0, etaMs: +r.eta_ms || 0,
      }));
    } catch (e) {
      const msg = String((e && (e.message || e)) || e);
      if (/flagship_presence|does not exist|relation|PGRST/i.test(msg)) {
        this._presMissing = true;   // table not set up — feature quietly off
      }
    }
  },

  // Presence rows → the same marker shape as active(). you:false. Docked
  // barons are berthed inside their station — only transits are visible.
  others(now = Date.now()) {
    const out = [];
    for (const r of this._presence) {
      if (!Galaxy.get(r.to)) continue;
      const flying = r.departedAt && r.etaMs && now < r.departedAt + r.etaMs && Galaxy.get(r.from);
      if (!flying) continue;
      const plan = this.plan(r.from, r.to, r.departedAt, r.etaMs);
      if (plan) out.push({ id: r.id, kind: "flagship", label: "Flagship", name: r.name,
        you: false, sprite: r.sprite, plan, at: this.pos(plan, now) });
    }
    return out;
  },

  // Push our own row: current travel, or "docked here". Throttled; fire-and-forget.
  publishPresence(force = false) {
    if (!this._presenceOn() || !(window.Cloud && Cloud.signedIn && Cloud.signedIn())) return;
    const s = this.s(); if (!s) return;
    const now = Date.now();
    if (!force && now - this._pubAt < 5000) return;
    this._pubAt = now;
    const t = s.travel;
    const row = {
      user_id: Cloud.user().id,
      display: this.playerName().slice(0, 24),
      sprite: this._flagSprite(),
      from_sys: t ? t.from : s.currentSystem,
      to_sys: t ? t.to : s.currentSystem,
      departed_at: t ? t.departedAt : 0,
      eta_ms: t ? t.etaMs : 0,
      updated_at: new Date(now).toISOString(),
    };
    void Cloud.client.from("flagship_presence").upsert(row).then(({ error }) => {
      if (error && /flagship_presence|does not exist|relation/i.test(String(error.message || error)))
        this._presMissing = true;
    }).catch(() => {});
  },

  // Everything moving, for the galaxy chart. Parked entries are skipped there.
  markers(now = Date.now()) {
    return this.active(now).concat(this.others(now)).filter(v => v.at);
  },

  // What's visibly IN a system for the system view. Docked flagships are
  // berthed inside the station (not drawn). A transit shows in the near
  // system while cruising/holding at its gate, in NO system mid-hyperspace,
  // then in the far system — never two scenes at once. gate = which lane
  // gate it uses (§2.4); frac = eased station↔gate fraction.
  inSystem(sysId, now = Date.now()) {
    const out = [];
    for (const v of this.active(now).concat(this.others(now))) {
      if (v.sysId === sysId) {
        if (v.kind !== "flagship") out.push({ ...v, mode: "working" });
        continue;
      }
      const at = v.at; if (!at) continue;
      const ph = this.legPhase(at.legP);
      if (ph.mode === "hyper") continue;
      const inA = ph.side === "out";
      if ((inA ? at.a : at.b) !== sysId) continue;
      out.push({ ...v,
        mode: ph.mode === "gate" ? (inA ? "gateOut" : "gateIn") : (inA ? "departing" : "arriving"),
        gate: inA ? at.b : at.a,
        frac: ph.mode === "gate" ? (inA ? 1 : 0) : this._ss(ph.f),
        f: ph.f });
    }
    return out;
  },

  // ---- the event schedule (§4): seeded at dispatch, usually EMPTY ----------
  _chance(danger) {
    return { safe: 0.06, low: 0.16, moderate: 0.3, high: 0.5, extreme: 0.68 }[danger] ?? 0.2;
  },

  // Deterministic events for one mission: [{ id, kind, t, watch, m }]
  _missionEvents(m) {
    if (!m.phases || !m.totalMs) return [];
    const rng = Combat._mk(Combat.seedFrom("voy:" + m.uid));
    const c = this._chance(m.danger);
    const outMs = m.phases[0].ms, inMs = m.phases[m.phases.length - 1].ms;
    const winOut = [m.startedAt + outMs * 0.15, m.startedAt + outMs * 0.9];
    const winIn = [m.startedAt + m.totalMs - inMs * 0.9, m.startedAt + m.totalMs - inMs * 0.15];
    const evs = [];
    const at = w => w[0] + rng() * (w[1] - w[0]);
    const push = (kind, t, watch = true) =>
      evs.push({ id: m.uid + ":e" + evs.length, kind, t: Math.round(t), watch, m });
    if (m.type === "escort") {                       // 0–2 raid attempts en route
      if (rng() < c) push("raid", at(winOut));
      if (rng() < c * 0.6) push("raid", at(winIn));
    } else if (m.type === "smuggle") {               // checkpoint / shakedown
      if (rng() < c * 0.8) push("customs", at(rng() < 0.5 ? winOut : winIn), false);
      if (rng() < c * 0.5) push("toll", at(winOut));
    } else if (m.type === "transport") {             // ambush, dangerous legs only
      if ((m.danger === "high" || m.danger === "extreme") && rng() < c)
        push("ambush", at(rng() < 0.5 ? winOut : winIn));
    } else if (m.type === "combat" || m.type === "assassinate") {
      push("engage", m.startedAt + outMs);           // the engagement itself, on arrival
    }
    return evs;
  },

  // Charter checks (§4.2): 0–2 per run by band — toll on red bands, customs on
  // impound bands. Announce-only + watchable; wallet untouched (see header).
  _charterEvents(cx) {
    const rng = Combat._mk(Combat.seedFrom("voy:" + cx.id));
    const c = this._chance(cx.band);
    const evs = [];
    const at = f => Math.round(cx.startedAt + cx.durationMs * f);
    const push = (kind, t, watch = true) =>
      evs.push({ id: cx.id + ":e" + evs.length, kind, t, watch, c: cx });
    if ((cx.band === "high" || cx.band === "extreme") && rng() < c)
      push("toll", at(0.15 + rng() * 0.6));
    if (cx.impound && rng() < c * 0.7)
      push("customs", at(0.2 + rng() * 0.6), false);
    return evs;
  },

  allEvents() {
    const s = this.s(); if (!s) return [];
    let evs = [];
    for (const m of s.missions || []) if (!m.resolved) evs = evs.concat(this._missionEvents(m));
    for (const c of (window.Charters ? Charters.active() : [])) evs = evs.concat(this._charterEvents(c));
    return evs;
  },
  firedEventsFor(missionUid, now = Date.now()) {
    const m = (this.s().missions || []).find(x => x.uid === missionUid);
    return m ? this._missionEvents(m).filter(e => e.t <= now) : [];
  },

  // Nearest mapped system to where the voyage is at the event's moment.
  _eventSys(e, now) {
    const src = e.m || e.c;
    const v = this.active(e.t <= now ? e.t : now)
      .find(x => x.mission === src || x.charter === src);
    if (v && v.at) { const sys = Galaxy.get(v.at.legP < 0.5 ? v.at.a : v.at.b); if (sys) return sys.name; }
    if (v && v.sysId) { const sys = Galaxy.get(v.sysId); if (sys) return sys.name; }
    return (e.m && e.m.sysName) || "deep space";
  },

  EVENT_TEXT: {
    raid:    { ico: "⚔", line: sys => `raiders hit a convoy off ${sys} — escorts drove them off` },
    ambush:  { ico: "⚔", line: sys => `an ambush sprung near ${sys} — the line held` },
    toll:    { ico: "☠", line: sys => `a pirate wing demanded toll off ${sys} — the convoy ran the gate` },
    customs: { ico: "🛃", line: sys => `customs checkpoint off ${sys} — waved through after inspection` },
    engage:  { ico: "⚔", line: sys => `strike group engaging at ${sys}` },
  },

  // Called from Game.loop. First call primes: events already in the past are
  // marked seen without announcing (no retro toast wall after time away).
  // ponytail: §4.5 wants missed entries posted in order on catch-up; add that
  // to the WYWA recap when journeys land in report cards.
  tick(now = Date.now()) {
    if (!this.s() || !window.Lanes || !Object.keys(Lanes.adj).length) return;
    const evs = this.allEvents();
    if (!this._primed) {
      this._primed = true;
      for (const e of evs) if (e.t <= now) this._seen.add(e.id);
      return;
    }
    for (const e of evs) {
      if (e.t > now || this._seen.has(e.id)) continue;
      this._seen.add(e.id);
      this._announce(e, now);
    }
    if (this._seen.size > 200) {
      const live = new Set(evs.map(e => e.id));
      this._seen = new Set([...this._seen].filter(id => live.has(id)));
    }
  },

  _announce(e, now) {
    const meta = this.EVENT_TEXT[e.kind]; if (!meta) return;
    const sys = this._eventSys(e, now);
    if (window.Feed) Feed.emit(`${meta.ico} ${meta.line(sys)}`, { kind: "reaction" });
    if (window.UI) {
      const what = e.m ? e.m.title : "Charter fleet";
      UI.toast(`${meta.ico} ${what} — ${meta.line(sys)}${e.watch ? " · ▶ watch on Hub" : ""}`,
        "warn", 6000);
      if (UI.page === "hub" && UI.updateMissions) UI.updateMissions();
    }
  },

  // ▶ watch: play the encounter, seeded by the event id — the same fight plays
  // every time. Client-local voyages (§4.4) already know their verdict, so a
  // skirmish on a doomed run reads as your line getting mauled; server-settled
  // voyages stay non-decisive (the server verdict lands at settle).
  watch(eventId) {
    const e = this.allEvents().find(x => x.id === eventId);
    if (!e || !window.BattleView || !window.Combat) return;
    const src = e.m || e.c;
    const uids = e.m ? e.m.shipUids : Charters.shipUids(e.c);
    const roster = (uids || []).map(u => {
      const sh = Fleet.ship(u);
      return sh ? { uid: sh.uid, name: sh.name, type: sh.type } : null;
    }).filter(Boolean).slice(0, 12);
    if (!roster.length) return;
    const type = e.m ? (e.kind === "toll" || e.kind === "customs" ? "smuggle" : e.m.type)
      : (e.c.band === "high" || e.c.band === "extreme" ? "smuggle" : "transport");
    const localVerdict = e.m && window.Missions && !Missions.authoritative()
      ? Missions.rolledSuccess(e.m) : true;
    BattleView.open({
      uid: "sk:" + e.id, skirmish: true,
      title: (e.m ? e.m.title : "Charter fleet") + " — skirmish",
      type, danger: e.m ? e.m.danger : e.c.band,
      faction: src.faction || null, sysName: this._eventSys(e, Date.now()),
      success: localVerdict, lost: [], damaged: [], impounded: [], items: [], roster,
    });
  },

  // ---- wiring --------------------------------------------------------------
  wire() {
    if (!window.Bus) return;
    Bus.on("travelStart", () => { this.publishPresence(true); });
    Bus.on("dock", d => { if (d && d.arrived) this.publishPresence(true); });
    Bus.on("auth", () => { this._presAt = 0; this.publishPresence(true); void this.refreshPresence(true); });
    this.publishPresence();
    void this.refreshPresence(true);
  },

  // ===== Hub Live View — chase cam on the followed ship =====================
  // While the ship is inside a system this runs the REAL system scene
  // (StarMap.startScene onto the hub canvas — nebula, planets, gates, ambient
  // traffic) with the camera gliding after the followed voyage. Mid-lane it
  // switches to the hyperspace tunnel. A mini chart inset shows where on the
  // map that actually is.
  followId: null,
  _liveRaf: null, _liveFx: { mode: "", flashT: 0, trail: [] },
  _liveStars: null, _imgs: {},
  _hubScene: null,   // StarMap.startScene handle rendering onto the hub canvas
  _stopHubScene() { if (this._hubScene) { this._hubScene.stop(); this._hubScene = null; } },

  img(ref) {
    const [kind, id] = String(ref || "ship:shuttle").split(":");
    const url = kind === "race" ? ASSET.raceship(id) : ASSET.ship(id);
    let im = this._imgs[url];
    if (!im) { im = new Image(); im.onload = () => { im.ok = true; }; im.src = url; this._imgs[url] = im; }
    return im;
  },

  // Voyages worth putting on the big screen: anything moving, plus fleets
  // working on site. A docked flagship is berthed — nothing to watch.
  followable(now = Date.now()) {
    const order = { flagship: 0, mission: 1, charter: 2, courier: 3, survey: 4 };
    // Other barons' flagships are followable too — you can watch a rival run a
    // lane. Yours always sort first so the default follow is your own.
    return this.active(now).concat(this.others(now))
      .filter(v => v.at || v.sysId)
      .filter(v => !(v.kind === "flagship" && !v.at))
      .sort((a, b) => (b.you ? 1 : 0) - (a.you ? 1 : 0)
        || (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  },

  hubSync() {
    const panel = document.getElementById("hub-live");
    if (!panel) return;
    // The star-map overlay covers the hub — don't render two scenes at once.
    const onHub = !!(window.UI && UI.page === "hub") && !(window.StarMap && StarMap.open);
    const list = onHub ? this.followable() : [];
    panel.classList.toggle("hidden", !list.length);
    if (!list.length) {
      // the id may be a rAF handle or a reduced-motion timeout — clear both
      if (this._liveRaf) { cancelAnimationFrame(this._liveRaf); clearTimeout(this._liveRaf); this._liveRaf = null; }
      this._stopHubScene();
      return;
    }
    if (!list.some(v => v.id === this.followId)) this.followId = list[0].id;
    // follow chips — rebuilt only when the set changes
    const chips = document.getElementById("hub-live-follow");
    if (chips) {
      const sig = list.map(v => v.id).join(",") + "|" + this.followId;
      if (chips.dataset.sig !== sig) {
        chips.dataset.sig = sig;
        chips.textContent = "";
        for (const v of list) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "btn btn-mini" + (v.id === this.followId ? " active" : "");
          b.dataset.follow = v.id;
          // textContent, never innerHTML — other barons' display names (and
          // admin-authored contract titles) are untrusted text.
          b.textContent = v.kind === "flagship"
            ? (v.you ? "★ Flagship" : "◈ " + v.name) : v.label;
          chips.appendChild(b);
        }
        if (!chips._wired) {
          chips._wired = true;
          chips.onclick = e => {
            const b = e.target.closest("[data-follow]");
            if (b) { this.followId = b.dataset.follow; chips.dataset.sig = ""; this.hubSync(); }
          };
        }
      }
    }
    if (!this._liveRaf) this._liveRaf = requestAnimationFrame(() => this._liveDraw());
  },

  _liveSub(text) {
    const el = document.getElementById("hub-live-sub");
    if (el && el.textContent !== text) el.textContent = text;
  },
  // generated names can already end in "Gate" (Daxor Gate) — don't double it
  _gateName(sys) { return sys.name.replace(/\s+gate$/i, ""); },

  // The coordinator: each frame decide which stage the followed ship is on.
  // Inside a system → the REAL system scene (StarMap.startScene on our
  // canvas, chase cam). Mid-lane → the hyperspace tunnel, drawn here.
  _liveDraw() {
    this._liveRaf = null;
    const cv = document.getElementById("hub-live-canvas");
    if (!cv || !window.UI || UI.page !== "hub" || (window.StarMap && StarMap.open)) {
      this._stopHubScene(); this.hubSync(); return;
    }
    const now = Date.now();
    const list = this.followable(now);
    const v = list.find(x => x.id === this.followId) || list[0];
    if (!v) { this._stopHubScene(); this.hubSync(); return; }

    let sub = "", ph = null, sysA = null, sysB = null, sysId = v.sysId;
    if (v.at) {
      ph = this.legPhase(v.at.legP);
      sysA = Galaxy.get(v.at.a); sysB = Galaxy.get(v.at.b);
      sysId = ph.mode === "hyper" ? null : (ph.side === "out" ? v.at.a : v.at.b);
    }
    // white flash on every stage handoff (jump, drop-out, system hop)
    const fx = this._liveFx;
    const stage = (sysId || "hyper") + "|" + v.id;
    if (fx.mode && fx.mode !== stage) { fx.flashT = now; fx.trail = []; }
    fx.mode = stage;

    if (sysId) {
      if (!this._hubScene || this._hubScene.sysId !== sysId || this._hubScene.followVoy !== v.id) {
        this._stopHubScene();
        const h = (window.StarMap && StarMap.startScene)
          ? StarMap.startScene(Galaxy.get(sysId), {
              canvas: cv, followVoy: v.id, zoom: 1.7,
              overlay: (octx, w, oh) => this._liveOverlay(octx, w, oh),
            })
          : null;
        if (h) { h.followVoy = v.id; this._hubScene = h; }
      }
      if (!v.at) sub = `${v.label} · ${v.phaseLabel || "on site"}`;
      else if (ph.mode === "gate") sub = ph.side === "out"
        ? `holding at the ${this._gateName(sysB)} gate — hyperdrive spooling`
        : `dropped out at the ${this._gateName(sysA)} gate — ${sysB.name} space`;
      else sub = ph.side === "out"
        ? `leaving ${sysA.name} — burning for the ${this._gateName(sysB)} gate`
        : `in ${sysB.name} space — on approach`;
    } else {
      this._stopHubScene();
      this._drawTunnel(cv, v, ph, now);
      sub = `hyperspace — ${sysA.name} → ${sysB.name}`;
    }

    this._liveSub(v.you === false && v.name ? v.name + " · " + sub : sub);
    // reduced motion: step twice a second instead of every frame
    const s = this.s();
    this._liveRaf = (s && s.settings && s.settings.reduced)
      ? setTimeout(() => { this._liveRaf = null; this._liveDraw(); }, 500)
      : requestAnimationFrame(() => this._liveDraw());
  },

  // The hyperspace tunnel — streaking stars, a blue-shift vignette, the ship
  // riding the middle with a stretched drive plume and a fading trail.
  _drawTunnel(cv, v, ph, now) {
    const ctx = cv.getContext("2d"); if (!ctx) return;
    const r = cv.parentElement.getBoundingClientRect();
    const w = Math.max(320, Math.floor(r.width)), h = Math.max(260, Math.floor(r.height));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#05070e"; ctx.fillRect(0, 0, w, h);
    if (!this._liveStars) {
      const rng = Combat._mk(Combat.seedFrom("livestars"));
      this._liveStars = Array.from({ length: 130 }, () => ({ x: rng(), y: rng(), b: 0.2 + rng() * 0.7, d: 0.25 + rng() * 0.75 }));
    }
    const streak = 0.5 + ph.f * 0.5;
    for (const st of this._liveStars) {
      const x = ((st.x - (now / 40000) * 2.2 * st.d) % 1 + 1) % 1 * w;
      const y = st.y * h;
      ctx.globalAlpha = st.b * 0.8;
      const len = 2 + streak * 90 * st.d;
      const g = ctx.createLinearGradient(x, y, x + len, y);
      g.addColorStop(0, "rgba(160,200,255,.9)"); g.addColorStop(1, "rgba(160,200,255,0)");
      ctx.strokeStyle = g; ctx.lineWidth = 1 + st.d;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const sx = w * 0.42, sy = h * 0.52;
    const vg = ctx.createRadialGradient(sx, sy, h * 0.18, sx, sy, h * 0.75);
    vg.addColorStop(0, "rgba(60,120,255,0)"); vg.addColorStop(1, "rgba(40,70,200,.35)");
    ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);

    const fx = this._liveFx;
    fx.trail.push({ x: sx, y: sy + Math.sin(now * 0.0012) * 2, t: now });
    while (fx.trail.length && now - fx.trail[0].t > 900) fx.trail.shift();
    ctx.lineCap = "round";
    for (let i = 1; i < fx.trail.length; i++) {
      const a = fx.trail[i - 1], b = fx.trail[i];
      const age = 1 - (now - b.t) / 900;
      ctx.strokeStyle = `rgba(120,200,255,${(age * 0.45).toFixed(3)})`;
      ctx.lineWidth = 1 + age * 3;
      ctx.beginPath(); ctx.moveTo(a.x - (now - a.t) * 0.05, a.y); ctx.lineTo(b.x - (now - b.t) * 0.05, b.y); ctx.stroke();
    }
    const bob = Math.sin(now * 0.0012) * 2;
    const fl = (8 + Math.sin(now * 0.018) * 3) * 2.2;
    const pg = ctx.createLinearGradient(sx - 18, sy, sx - 18 - fl * 3, sy);
    pg.addColorStop(0, "rgba(190,225,255,.95)"); pg.addColorStop(1, "rgba(120,200,255,0)");
    ctx.fillStyle = pg;
    ctx.beginPath(); ctx.moveTo(sx - 16, sy - 4 + bob); ctx.lineTo(sx - 16 - fl * 3, sy + bob); ctx.lineTo(sx - 16, sy + 4 + bob); ctx.closePath(); ctx.fill();
    const im = this.img(v.sprite);
    if (im.ok) ctx.drawImage(im, sx - 26, sy - 15 + bob, 52, 30);
    else {
      ctx.fillStyle = "#3fe3ff";
      ctx.beginPath(); ctx.moveTo(sx + 24, sy + bob); ctx.lineTo(sx - 18, sy - 12 + bob); ctx.lineTo(sx - 9, sy + bob); ctx.lineTo(sx - 18, sy + 12 + bob); ctx.closePath(); ctx.fill();
    }
    ctx.font = "600 11px system-ui, sans-serif"; ctx.textAlign = "center";
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(4,8,18,.8)";
    const nm = v.kind === "flagship" ? (v.name || "You") : v.label;
    ctx.strokeText(nm, sx, sy - 24 + bob);
    ctx.fillStyle = v.kind === "flagship" ? "#3fe3ff" : "#aab9dc";
    ctx.fillText(nm, sx, sy - 24 + bob);

    this._liveOverlay(ctx, w, h);
  },

  // Chrome shared by both stages: the chart inset + stage-handoff flash.
  // Uses Date.now() itself — the scene's overlay callback hands performance.now.
  _liveOverlay(ctx, w, h) {
    const now = Date.now();
    const list = this.followable(now);
    const v = list.find(x => x.id === this.followId) || list[0];
    if (v) this._drawMini(ctx, v, w, h, now);
    const fx = this._liveFx;
    if (fx.flashT && now - fx.flashT < 380) {
      ctx.fillStyle = `rgba(220,240,255,${((1 - (now - fx.flashT) / 380) * 0.75).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }
  },
  // The small screen: the actual chart — route, systems, and the ship's dot.
  _drawMini(ctx, v, w, h, now) {
    const mw = Math.min(220, w * 0.32), mh = mw * 0.62;
    const mx = w - mw - 10, my = 10;
    ctx.save();
    ctx.fillStyle = "rgba(5,8,16,.82)"; ctx.strokeStyle = "rgba(63,227,255,.35)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.rect(mx, my, mw, mh); ctx.fill(); ctx.stroke();
    ctx.clip();
    const px = gx => mx + gx * mw, py = gy => my + gy * mh;
    for (const lane of Lanes.list) {
      const a = Galaxy.get(lane.a).pos, b = Galaxy.get(lane.b).pos;
      ctx.strokeStyle = lane.trunk ? "rgba(130,200,255,.25)" : "rgba(150,170,220,.12)";
      ctx.lineWidth = lane.trunk ? 1 : 0.6;
      ctx.beginPath(); ctx.moveTo(px(a.x), py(a.y)); ctx.lineTo(px(b.x), py(b.y)); ctx.stroke();
    }
    if (v.plan) {
      ctx.strokeStyle = "rgba(63,227,255,.8)"; ctx.lineWidth = 1.6;
      ctx.beginPath();
      v.plan.legs.forEach((id, i) => {
        const p = Galaxy.get(id).pos;
        i ? ctx.lineTo(px(p.x), py(p.y)) : ctx.moveTo(px(p.x), py(p.y));
      });
      ctx.stroke();
    }
    for (const sys of Galaxy.list) {
      if (!sys.capital) continue;
      ctx.fillStyle = "#ffd9a0"; ctx.beginPath(); ctx.arc(px(sys.pos.x), py(sys.pos.y), 1.6, 0, 7); ctx.fill();
    }
    const at = v.at || (v.sysId && { x: Galaxy.get(v.sysId).pos.x, y: Galaxy.get(v.sysId).pos.y });
    if (at) {
      const pulse = 3 + Math.sin(now / 220) * 1.2;
      ctx.strokeStyle = "rgba(63,227,255,.9)"; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(px(at.x), py(at.y), pulse, 0, 7); ctx.stroke();
      ctx.fillStyle = "#3fe3ff"; ctx.beginPath(); ctx.arc(px(at.x), py(at.y), 1.8, 0, 7); ctx.fill();
    }
    ctx.restore();
  },
};

window.Voyages = Voyages;
