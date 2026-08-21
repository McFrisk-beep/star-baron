/* voyage.js — visible voyages (docs/LIVING_GALAXY.md §3–§4, step 3).

   A voyage is any fleet movement: flagship transfer, mission, charter, courier
   run, survey. Everything here is a VIEW of state that already exists — flying
   is arithmetic on the clock (`pos(plan, t)` is pure, O(legs), no tick), and
   the mid-flight event schedule is a pure function of the voyage uid, so every
   reload recomputes the identical journey. Nothing new is persisted.

   Three consumers:
     • StarMap galaxy view — moving markers on the lane polylines.
     • StarMap system view — flagships / convoys crossing between real gates,
       with the owner's name over flagships (own + other players').
     • Hub — the in-transit mini galaxy view (flagship centred, moving), and
       the Active Missions cards' "▶ watch" skirmish buttons.

   Events are non-decisive skirmishes in v1: they never touch the wallet — the
   resolver math is untouched (§7) and server-settled voyages keep their server
   verdict. The §4.4 "dice roll moves to dispatch" upgrade stays future work.

   Cross-player flagships ride a tiny optional table (docs/sql/voyage_presence.sql):
   one row per player — from/to/departedAt/etaMs — and every client replays the
   same pure function over it. No table → feature silently off.               */

const Voyages = {
  s() { return window.Game && Game.state; },
  _plans: {},        // id+route key → plan (derived cache, never persisted)
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

  // Where a plan is at time t. Pure — same t in, same point out, in any order
  // (the §9 anti-accumulation property). Galaxy pos space (0..1 fractions).
  // → { x, y, heading, a, b, leg, p, legP } or null (degenerate plan).
  pos(plan, t = Date.now()) {
    if (!plan || !plan.legs || plan.legs.length < 2) return null;
    const p = Util.clamp((t - plan.departedAt) / Math.max(1, plan.etaMs), 0, 1);
    const cum = this._cum(plan.legs);
    const total = cum[cum.length - 1] || 1e-9;
    const d = p * total;
    let i = 0;
    while (i + 2 < cum.length && cum[i + 1] <= d) i++;
    const a = Galaxy.get(plan.legs[i]).pos, b = Galaxy.get(plan.legs[i + 1]).pos;
    const seg = Math.max(1e-9, cum[i + 1] - cum[i]);
    const legP = Util.clamp((d - cum[i]) / seg, 0, 1);
    return { x: a.x + (b.x - a.x) * legP, y: a.y + (b.y - a.y) * legP,
      heading: Math.atan2(b.y - a.y, b.x - a.x),
      a: plan.legs[i], b: plan.legs[i + 1], leg: i, p, legP };
  },

  _sysByName(name) { return name ? Galaxy.list.find(x => x.name === name) : null; },
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

    // flagship — travelling or docked
    if (s.travel) {
      const plan = this.plan(s.travel.from, s.travel.to, s.travel.departedAt, s.travel.etaMs);
      if (plan) out.push({ id: "flag", kind: "flagship", label: "Flagship", name: this.playerName(),
        you: true, sprite: this._flagSprite(), plan, at: this.pos(plan, now) });
    } else if (here) {
      out.push({ id: "flag", kind: "flagship", label: "Flagship", name: this.playerName(),
        you: true, sprite: this._flagSprite(), sysId: here });
    }

    // missions — out leg, on-site work, return leg (Missions.phaseAt drives it)
    for (const m of s.missions || []) {
      if (m.resolved || !m.phases) continue;
      const dest = this._sysByName(m.sysName); if (!dest) continue;
      const from = (m.fromSys && Galaxy.get(m.fromSys)) ? m.fromSys : here;
      if (!from || from === dest.id) continue;
      const ph = Missions.phaseAt(m, now);
      const base = { id: "m:" + m.uid, kind: "mission", label: m.title, you: true,
        sprite: this._fleetSprite(m.shipUids), mission: m };
      const outMs = m.phases[0].ms, inMs = m.phases[m.phases.length - 1].ms;
      if (ph.dir === "out") {
        const plan = this.plan(from, dest.id, m.startedAt, outMs);
        if (plan) out.push({ ...base, plan, at: this.pos(plan, now) });
      } else if (ph.dir === "in") {
        const plan = this.plan(dest.id, from, m.startedAt + m.totalMs - inMs, inMs);
        if (plan) out.push({ ...base, plan, at: this.pos(plan, now) });
      } else out.push({ ...base, sysId: dest.id });
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
      else if (p >= 0.45 && p < 0.55) out.push({ ...base, sysId: e.sysId });
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

  // Presence rows → the same marker shape as active(). you:false.
  others(now = Date.now()) {
    const out = [];
    for (const r of this._presence) {
      if (!Galaxy.get(r.to)) continue;
      const flying = r.departedAt && r.etaMs && now < r.departedAt + r.etaMs && Galaxy.get(r.from);
      if (flying) {
        const plan = this.plan(r.from, r.to, r.departedAt, r.etaMs);
        if (plan) out.push({ id: r.id, kind: "flagship", label: "Flagship", name: r.name,
          you: false, sprite: r.sprite, plan, at: this.pos(plan, now) });
      } else {
        out.push({ id: r.id, kind: "flagship", label: "Flagship", name: r.name,
          you: false, sprite: r.sprite, sysId: r.to });
      }
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

  // What's visibly IN a system for the system view: parked entries, plus a
  // transit whose current leg touches it (first half of a leg = departing the
  // near end, second half = arriving at the far end, so a ship is never in two
  // system scenes at once). gate = which lane gate it uses (§2.4).
  inSystem(sysId, now = Date.now()) {
    const out = [];
    for (const v of this.active(now).concat(this.others(now))) {
      if (v.sysId === sysId) { out.push({ ...v, mode: "docked" }); continue; }
      const at = v.at; if (!at) continue;
      if (at.a === sysId && at.legP < 0.5)
        out.push({ ...v, mode: "departing", gate: at.b, frac: at.legP * 2 });
      else if (at.b === sysId && at.legP >= 0.5)
        out.push({ ...v, mode: "arriving", gate: at.a, frac: (at.legP - 0.5) * 2 });
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
      .find(x => x.mission === src || x.charter === src || x.id.slice(2) === (src.uid || src.id));
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
    // keep other barons' flagships fresh while someone is actually watching
    if ((window.UI && UI.page === "hub") || (window.StarMap && StarMap.open))
      void this.refreshPresence();
    const evs = this.allEvents();
    if (!this._primed) {
      this._primed = true;
      for (const e of evs) if (e.t <= now) this._seen.add(e.id);
      return;
    }
    let announced = 0;
    for (const e of evs) {
      if (e.t > now || this._seen.has(e.id)) continue;
      this._seen.add(e.id);
      // resume() after time away matures a batch at once — two toasts, not a wall
      if (announced++ < 2) this._announce(e, now);
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

  // ▶ watch: play the encounter as a non-decisive skirmish. Seeded by the event
  // id — the same fight plays every time. Never touches the report or wallet.
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
    BattleView.open({
      uid: "sk:" + e.id, skirmish: true,
      title: (e.m ? e.m.title : "Charter fleet") + " — skirmish",
      type, danger: e.m ? e.m.danger : e.c.band,
      faction: src.faction || null, sysName: this._eventSys(e, Date.now()),
      success: true, lost: [], damaged: [], impounded: [], items: [], roster,
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

  // ---- Hub mini galaxy view (flagship centred, moving through space) -------
  _hubRaf: null, _hubStars: null,
  hubSync() {
    const s = this.s();
    const wrap = document.getElementById("hub-transit-view");
    const on = !!(s && s.travel && window.UI && UI.page === "hub" && wrap);
    if (wrap) wrap.classList.toggle("hidden", !on);
    if (on && !this._hubRaf) this._hubRaf = requestAnimationFrame(t => this._hubDraw(t));
    if (!on && this._hubRaf) { cancelAnimationFrame(this._hubRaf); this._hubRaf = null; }
  },
  _hubDraw() {
    this._hubRaf = null;
    const s = this.s();
    const cv = document.getElementById("hub-transit-canvas");
    if (!cv || !s || !s.travel || !window.UI || UI.page !== "hub") { this.hubSync(); return; }
    const now = Date.now();
    const flag = this.active(now).find(v => v.kind === "flagship");
    const at = flag && flag.at;
    const ctx = cv.getContext("2d"); if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = cv.parentElement.getBoundingClientRect();
    const w = Math.max(280, Math.floor(r.width)), h = 230;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#06080f"; ctx.fillRect(0, 0, w, h);
    if (!at) { this.hubSync(); return; }

    // parallax starfield seeded once; drifts against travel so motion reads
    if (!this._hubStars) {
      const rng = Combat._mk(Combat.seedFrom("hubstars"));
      this._hubStars = Array.from({ length: 90 }, () => ({ x: rng(), y: rng(), b: 0.25 + rng() * 0.6, d: 0.3 + rng() * 0.7 }));
    }
    const K = Math.min(w, h) / 0.16;          // px per galaxy unit — a close view
    const cx = w / 2, cy = h / 2;
    const px = gx => cx + (gx - at.x) * K, py = gy => cy + (gy - at.y) * K;
    ctx.fillStyle = "#fff";
    for (const st of this._hubStars) {
      const x = ((st.x - at.x * st.d * 0.5) % 1 + 1) % 1 * w;
      const y = ((st.y - at.y * st.d * 0.5) % 1 + 1) % 1 * h;
      ctx.globalAlpha = st.b * 0.7; ctx.fillRect(x, y, 1.2, 1.2);
    }
    ctx.globalAlpha = 1;

    // lanes + systems near the flagship
    for (const lane of Lanes.list) {
      const a = Galaxy.get(lane.a).pos, b = Galaxy.get(lane.b).pos;
      const x1 = px(a.x), y1 = py(a.y), x2 = px(b.x), y2 = py(b.y);
      if (Math.max(x1, x2) < -80 || Math.min(x1, x2) > w + 80 || Math.max(y1, y2) < -80 || Math.min(y1, y2) > h + 80) continue;
      const onRoute = flag.plan.legs.some((id, i) => i + 1 < flag.plan.legs.length
        && ((id === lane.a && flag.plan.legs[i + 1] === lane.b) || (id === lane.b && flag.plan.legs[i + 1] === lane.a)));
      ctx.strokeStyle = onRoute ? "rgba(63,227,255,.65)" : lane.trunk ? "rgba(130,200,255,.35)" : "rgba(150,170,220,.18)";
      ctx.lineWidth = onRoute ? 2 : lane.trunk ? 1.6 : 1;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    const destId = s.travel.to;
    for (const sys of Galaxy.list) {
      const x = px(sys.pos.x), y = py(sys.pos.y);
      if (x < -30 || x > w + 30 || y < -30 || y > h + 30) continue;
      const dest = sys.id === destId;
      ctx.fillStyle = dest ? "#3fe3ff" : sys.capital ? "#ffd9a0" : "#9aa9c8";
      ctx.beginPath(); ctx.arc(x, y, dest ? 4.5 : sys.capital ? 3.5 : 2.2, 0, 7); ctx.fill();
      if (dest) {
        const pulse = 7 + Math.sin(now / 300) * 2.5;
        ctx.strokeStyle = "rgba(63,227,255,.7)"; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(x, y, pulse, 0, 7); ctx.stroke();
      }
      if (sys.capital || dest || sys.id === s.travel.from) {
        ctx.fillStyle = "rgba(207,227,255,.8)"; ctx.font = "10px system-ui, sans-serif";
        ctx.textAlign = "center"; ctx.fillText(sys.name, x, y + 14);
      }
    }

    // fellow travellers in frame (missions, couriers, other barons)
    for (const v of this.markers(now)) {
      if (v.id === "flag") continue;
      const x = px(v.at.x), y = py(v.at.y);
      if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
      ctx.save(); ctx.translate(x, y); ctx.rotate(v.at.heading);
      ctx.fillStyle = v.kind === "flagship" ? "#ffd9a0" : "rgba(123,140,255,.9)";
      ctx.beginPath(); ctx.moveTo(5, 0); ctx.lineTo(-4, 3); ctx.lineTo(-4, -3); ctx.closePath(); ctx.fill();
      ctx.restore();
      if (v.kind === "flagship" && v.name) {
        ctx.fillStyle = "rgba(255,217,160,.85)"; ctx.font = "9px system-ui, sans-serif";
        ctx.textAlign = "center"; ctx.fillText(v.name, x, y - 8);
      }
    }

    // the flagship, centred, thrusting
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(at.heading);
    const fl = 6 + Math.sin(now / 60) * 2.5;
    const g = ctx.createLinearGradient(-8, 0, -8 - fl * 2, 0);
    g.addColorStop(0, "rgba(120,200,255,.9)"); g.addColorStop(1, "rgba(120,200,255,0)");
    ctx.fillStyle = g; ctx.fillRect(-8 - fl * 2, -2, fl * 2, 4);
    ctx.fillStyle = "#3fe3ff";
    ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-8, 6); ctx.lineTo(-4, 0); ctx.lineTo(-8, -6); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#cfe3ff"; ctx.font = "600 10px system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.fillText(this.playerName(), cx, cy - 14);

    this._hubRaf = requestAnimationFrame(t => this._hubDraw(t));
  },
};

window.Voyages = Voyages;
