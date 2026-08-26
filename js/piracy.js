/* piracy.js — player piracy against NPC traffic
   (docs/SPACE_INTERACTIVITY.md §4, build order step 4). The PvE half of the
   pirate fantasy: the haulers traffic.js already draws become contacts with
   three verbs on them (§4.3) — rob the manifest, shake the captain down for a
   toll, or escort a relief convoy in for lawful pay. NPCs taught the threat
   model in step 3; this hands the player the other end of the gun, still in a
   sandbox where nobody real can be griefed.

   Why robbing matters (§4.2): the stolen cargo never reaches the destination
   shelf. Stock.take drains the very sector the hauler was feeding, scarcity
   climbs, and the pirate sells into the spike they personally engineered —
   the loop only exists because STOCKCFG's finite stock shipped first. It is
   deliberately the OPPOSITE of raiders.js's shelf-neutral NPC raids: a den's
   drain is the den's job (§7.1); a player's drain is the player's loot.

   Fencing (§4.4): stolen units are flagged hot (state.hot), and the existing
   CUSTOMS docking scan becomes the fence-or-risk gate — only the hot slice of
   a stack is seizable, legitimate units of the same commodity are not.

   The law (§5.1): PREVENTION — in a policed system the verb is simply not
   offered; you cannot start the fight the Senate would win. Everywhere else
   the bill is real: armed robbery books you straight onto the watchlist
   (Crime.bookRobbery — the police can chase you the moment you rob), the
   response plays out on a staged clock (settleAt), and a hull the patrols
   run down is DESTROYED with all hands. §6.7's guard rail still holds —
   high variance, never high expected value.

   Idle-first and deterministic: the odds, the loot ranges and the target's
   worth are stamped on the op at dispatch (the risk you accepted, exactly as
   mining stamps threat/repel), and the outcome is a pure function of the op
   id — dispatch, close the tab, and the same fight resolves that a watched
   tab would have seen. Guests settle here; signed-in dispatch waits on a
   piracy SQL surface, the same way mining shipped (canStart gates it).      */

const Piracy = {
  s() { return window.Game.state; },
  cfg() { return window.PIRACYCFG || {}; },
  list() { return this.s().piracy || (this.s().piracy = []); },
  // Runs already emptied by a player this session-or-so, for the scene: the
  // robbed hauler limps on with a bare hold (traffic.js asks tookManifest).
  hits() { return this.s().piracyHits || (this.s().piracyHits = []); },
  // Server-settled once docs/sql/piracy_rpcs.sql is applied: app_pull resolves
  // the fight, the loot, the chase and the landing on the server clock, and
  // serverOwned() latches when its slice comes back. Until it does, a local
  // mint would evaporate under app_commit — the trap mining.js documents — so
  // dispatch stays gated for a signed-in baron and guests keep the local loop.
  serverOwned() { return !!(window.Cloud && Cloud.piracyOwned); },
  local() { return !window.Economy || Economy.softIncomeLocal(); },
  // Can this baron dispatch at all? Guests always; signed-in only once the
  // server owns the settle.
  canSettle() { return this.local() || this.serverOwned(); },

  opFor(shipUid) { return this.list().find(o => o.shipUid === shipUid) || null; },
  opOnFlight(flightId, loop) {
    return this.list().find(o => o.flightId === flightId && o.loop === loop) || null;
  },

  // ---- reading a contact ---------------------------------------------------
  fromSysOf(v) { return v.plan.legs[0]; },
  toSysOf(v) { return v.plan.legs[v.plan.legs.length - 1]; },
  landsAt(v) { return v.plan.departedAt + v.plan.etaMs; },

  // Which verbs this contact offers, with the §5.1 rule applied: in policed
  // space prevention is absolute — the verb is not offered, there is no fight
  // to lose. Escort is lawful and only exists on relief runs (§4.3).
  verbs(v, sysId) {
    if (!v || !v.npc || v.raided) return [];
    const policed = window.Security && Security.bandOf(sysId).id === "policed";
    const out = [];
    if (!policed && v.manifest.length) out.push("rob", "toll");
    if (v.relief) out.push("escort");
    return out;
  },

  // ---- the quote (stamped at dispatch, §6.2's commitment) ------------------
  travelMs(sysId, shipUid) {
    const c = this.cfg();
    const here = Galaxy.get(this.s().currentSystem), there = Galaxy.get(sysId);
    const dist = (here && there) ? Math.hypot(here.pos.x - there.pos.x, here.pos.y - there.pos.y) : 0.2;
    const sh = Fleet.ship(shipUid);
    const speed = (sh ? Fleet.stats(sh).speed || 1 : 1) * (window.Senate ? Senate.travelSpeedMult() : 1);
    return Math.max(c.minLegMs || 15000,
      dist * (c.legSecondsPerDist || 220) * 1000 / Math.max(0.1, speed) / (window.Game.timeScale || 1));
  },
  // The target's effective escort: hired guns by hull kind, multiplied by the
  // law present where you'd hit it — the same Security number the chart paints
  // and raiders.js rolls against, so nothing here can drift from the map.
  targetDef(v, sysId) {
    const c = this.cfg();
    const base = (c.targetSoft || {})[v.kind] || 200;
    const law = window.Security ? Security.score(sysId) : 0.5;
    return base * (1 + law * (c.lawFactor || 0));
  },
  chance(shipUid, v, sysId, verb) {
    if (verb === "escort") return 1;      // lawful work, no fight to roll
    const c = this.cfg();
    const sh = Fleet.ship(shipUid);
    const atk = sh && window.Charters ? Charters.defenseScore(Charters.fleetStats([sh])) : 0;
    let p = atk / (atk + this.targetDef(v, sysId));
    if (verb === "toll") p *= c.tollEase || 1;
    const cl = c.chanceClamp || [0, 1];
    return Util.clamp(p, cl[0], cl[1]);
  },
  // What the manifest is worth at its destination — the base the toll cut and
  // the escort fee are quoted from. A nominal load per commodity (the loot
  // range's midpoint), priced at the delivery exchange.
  manifestValue(v) {
    const r = (this.cfg().lootQty || {})[v.kind] || [5, 10];
    const nominal = (r[0] + r[1]) / 2;
    const to = this.toSysOf(v);
    let sum = 0;
    for (const id of v.manifest) sum += nominal * Market.systemPrice(id, to);
    return Math.round(sum);
  },
  crimeGain(verb, won) {
    const g = (window.CRIMECFG || {}).gain || {};
    if (verb === "rob") return won ? (g.piracy || 0) : (g.piracyFail || 0);
    if (verb === "toll") return g.toll || 0;
    return 0;
  },

  // ---- dispatch ------------------------------------------------------------
  canStart(v, verb, shipUid, sysId, now = Date.now()) {
    if (!this.canSettle())
      return { ok: false, msg: "Piracy needs docs/sql/piracy_rpcs.sql applied to this project before a signed-in baron can dispatch — otherwise the take would evaporate on the next save." };
    if (!v || !v.npc) return { ok: false, msg: "No contact there." };
    if (!this.verbs(v, sysId).includes(verb)) {
      if (v.raided) return { ok: false, msg: "Their hold is already empty — someone beat you to it." };
      if (verb === "escort") return { ok: false, msg: "Only relief convoys hire escorts." };
      return { ok: false, msg: "Not here — the Senate writ runs in this system, and the verb is not offered." };
    }
    if (this.list().length >= (this.cfg().maxOps || 2))
      return { ok: false, msg: `Intercepts at capacity (${this.cfg().maxOps || 2}).` };
    if (this.opOnFlight(v.id, v.loop)) return { ok: false, msg: "You already have a hull on that contact." };
    const sh = Fleet.ship(shipUid);
    if (!sh || sh.status !== "idle") return { ok: false, msg: "Pick an idle ship." };
    if (sh.mercenary) return { ok: false, msg: "Mercenaries won't fly against the lanes." };
    if (!(Fleet.stats(sh).firepower >= 1)) return { ok: false, msg: "That hull has no guns worth showing." };
    const travel = this.travelMs(sysId, shipUid);
    if (now + travel >= this.landsAt(v))
      return { ok: false, msg: "They make dock before you could reach them — hit an earlier leg of the run." };
    return { ok: true, travel };
  },

  start(v, verb, shipUid, sysId, now = Date.now()) {
    const can = this.canStart(v, verb, shipUid, sysId, now);
    if (!can.ok) return can;
    const s = this.s();
    // Everything the resolver needs rides ON the op — quoted at dispatch,
    // locked in. An edict passed an hour later doesn't re-roll a fight you
    // already committed hulls to (the same rule mining.js records).
    const op = {
      id: "pr" + (++s.seq), verb, shipUid, sysId,
      flightId: v.id, loop: v.loop, kind: v.kind, name: v.name,
      manifest: v.manifest.slice(), toSys: this.toSysOf(v),
      chance: this.chance(shipUid, v, sysId, verb),
      // The hull's attack score, stamped at dispatch: the server cannot derive
      // it (it doesn't model accessories or yard refits) and the police chase
      // rolls against it. Clamped server-side against the ship catalog.
      atk: window.Charters ? Charters.defenseScore(Charters.fleetStats([Fleet.ship(shipUid)])) : 0,
      // The law present where you struck, locked in with the odds: the police
      // response (police.js) rolls against this, not against whatever the map
      // says by the time the hull is flying home.
      law: window.Security ? Security.score(sysId) : 0.5,
      value: this.manifestValue(v),
      cargo: Fleet.stats(Fleet.ship(shipUid)).cargo || 0,
      fromSys: s.currentSystem, travelMs: can.travel,
      startedAt: now, resolveAt: now + can.travel, returnAt: now + can.travel * 2,
      resolved: false,
    };
    Fleet.ship(shipUid).status = "raiding";
    this.list().push(op);
    if (window.Bus) Bus.emit("piracyStart", op);
    return { ok: true, op };
  },

  // ---- the roll: pure of the op --------------------------------------------
  // Same (op) in, same fight out, however long the tab was shut.
  rollOutcome(op) {
    const c = this.cfg();
    const s = Market._seed(["piracy", op.id]);
    // Clamp on READ, exactly as raiders.js does with threat/repel: the server
    // resolver (docs/sql/piracy_rpcs.sql) clamps the same way, so a tampered
    // save can never make the optimistic client view disagree with the settle.
    const cl = c.chanceClamp || [0, 1];
    const chance = Util.clamp(+op.chance || 0, cl[0], cl[1]);
    const value = Math.max(0, +op.value || 0);
    const cargo = Math.max(0, +op.cargo || 0);
    const roll = (range, n) => { const r = range || [0, 0]; return r[0] + Market._u01(s, n) * (r[1] - r[0]); };
    const out = { verb: op.verb, won: true, loot: null, credits: 0, dmg: 0 };
    if (op.verb === "escort") {
      out.credits = Math.round(roll(c.escortPayFrac, 1) * value);
      return out;
    }
    out.won = Market._u01(s, 0) < chance;
    if (!out.won) { out.dmg = roll(c.atkDmg, 1); return out; }
    if (op.verb === "toll") { out.credits = Math.round(roll(c.tollFrac, 1) * value); return out; }
    // Rob: a seeded load per manifest commodity, capped by the hold you flew.
    const range = (c.lootQty || {})[op.kind] || [5, 10];
    let want = op.manifest.map((id, i) => ({ id, qty: Math.max(1, Math.round(roll(range, 2 + i))) }));
    let total = want.reduce((n, w) => n + w.qty, 0);
    if (cargo > 0 && total > cargo) {
      const k = cargo / total;
      want = want.map(w => ({ id: w.id, qty: Math.max(1, Math.floor(w.qty * k)) }));
    }
    out.loot = {};
    for (const w of want) out.loot[w.id] = (out.loot[w.id] || 0) + w.qty;
    return out;
  },

  // ---- the stage clock (derived, never stored) -----------------------------
  // The fight takes PIRACYCFG.battleMs, the law takes POLICECFG.arriveMs to
  // reach the scene and waveGapMs per wave — all derived from resolveAt and
  // the pure rolls, so nothing new rides the op, app._merge_piracy needs no
  // new keys, and the SQL derives the identical clock.
  battleMs() { return this.cfg().battleMs || 0; },
  robEndAt(op) { return op.resolveAt + this.battleMs(); },
  // Pre-read the fight and the chase — pure of the op, cached per op id so the
  // per-frame chart markers don't re-roll. atk uses the live hull when it
  // still flies (what pursue() will use); a refit mid-flight can nudge the
  // predicted wave count until the settle corrects it.
  _pre: {},
  preview(op) {
    const hit = this._pre[op.id];
    if (hit) return hit;
    const out = this.rollOutcome(op);
    let chase = null;
    if (op.verb === "rob" && out.won && out.loot && window.Police && window.Charters) {
      const sh = Fleet.ship(op.shipUid);
      const atk = sh ? Charters.defenseScore(Charters.fleetStats([sh])) : (+op.atk || 0);
      chase = Police.chaseOutcome(op, atk);
    }
    return (this._pre[op.id] = { out, chase });
  },
  settleAt(op) {
    const p = this.preview(op);
    return this.robEndAt(op) + (p.chase && window.Police ? Police.chaseLenMs(p.chase) : 0);
  },
  // When the law arrives and the duel opens — the hulls stop running and
  // fight at the scene (POLICECFG.arriveMs after the boarding ends).
  duelAt(op) { return this.robEndAt(op) + ((window.POLICECFG || {}).arriveMs || 0); },
  // The run home departs when everything at the scene is over: no chase means
  // settleAt === robEndAt, so this is one rule for both cases.
  landAt(op) {
    return this.settleAt(op) + (op.travelMs || Math.max(1, op.returnAt - op.resolveAt));
  },

  // ---- the intercept engagement (Dispatches ▶ Replay) ----------------------
  // The boarding action is a real report: free_trade flavour fields the
  // hauler's hired security, and policeInbound tells combat.js the law showed
  // up — the hauler jumps clear at the end of the movie.
  robReport(op, sh, out, policeInbound, now) {
    const sys = window.Galaxy ? Galaxy.get(op.sysId) : null;
    return {
      uid: op.id + "rob",
      title: `Intercept — ${op.name}` + (sys ? ` (${sys.name})` : ""),
      type: "combat", success: !!out.won, ts: now, faction: "free_trade",
      danger: op.kind === "freighter" ? "moderate" : "low",
      enemyCount: op.kind === "freighter" ? 3 : 2,
      policeInbound: !!policeInbound,
      credits: out.credits || 0, items: [], lost: [], impounded: [],
      damaged: out.dmg > 0 ? [{ uid: sh.uid, name: sh.name, pct: Math.max(1, Math.round(out.dmg * 100)) }] : [],
      roster: [{ uid: sh.uid, name: sh.name, type: sh.type }],
    };
  },
  // The same movie, before the settle: the rolls are pure, so the live-watch
  // offer at engage time and the post-settle replay show the identical fight.
  previewReport(op) {
    const sh = Fleet.ship(op.shipUid);
    if (!sh || op.verb !== "rob") return null;
    const p = this.preview(op);
    return this.robReport(op, sh, p.out, !!p.chase, Date.now());
  },
  _fileRobReport(op, sh, out, policeInbound, now) {
    const s = this.s();
    if (!s.reports) s.reports = [];
    const r = this.robReport(op, sh, out, policeInbound, now);
    s.reports.unshift(r);
    if (s.reports.length > 20) s.reports.length = 20;
    return r.uid;
  },

  // ---- live stage announcements --------------------------------------------
  // Purely presentational: as an op's derived stages pass on a watched tab,
  // tell the UI — the fight starting, the law inbound. The ledger still moves
  // only at settleAt. Transient marks, never saved; stages that are already
  // history (a reload mid-op, the settle passed) stay silent — the resolved
  // toast covers them.
  _seenStage: {},
  _announce(op, now) {
    if (op.resolved || (window.Game && Game._booting)) return;
    if (now >= this.settleAt(op)) return;
    const seen = this._seenStage[op.id] || 0;
    if (seen < 1 && now >= op.resolveAt && op.verb !== "escort") {
      this._seenStage[op.id] = 1;
      if (window.Bus) Bus.emit("piracyEngaged", { op });
    }
    if ((this._seenStage[op.id] || 0) < 2 && now >= this.robEndAt(op) && this.preview(op).chase) {
      this._seenStage[op.id] = 2;
      if (window.Bus) Bus.emit("policeInbound", { op, waves: this.preview(op).chase.waves.length });
    }
    if ((this._seenStage[op.id] || 0) < 3 && now >= this.duelAt(op) && this.preview(op).chase) {
      this._seenStage[op.id] = 3;
      if (window.Bus) Bus.emit("policeEngaged", { op, chase: this.preview(op).chase });
    }
  },

  // ---- the hot ledger (§4.4) -----------------------------------------------
  // Stolen units stay hot until fenced (sold — positions drop and the clamp
  // follows) or seized at a customs gate. One small map, clamped on read so
  // every path that sheds the goods sheds the flag with them.
  hot() { return this.s().hot || (this.s().hot = {}); },
  hotQty(commId) {
    const held = (this.s().positions || {})[commId] || 0;
    return Math.max(0, Math.min(this.hot()[commId] | 0, held));
  },
  addHot(commId, qty) { if (qty > 0) this.hot()[commId] = (this.hot()[commId] | 0) + qty; },
  takeHot(commId, qty) {
    const h = this.hot();
    h[commId] = Math.max(0, (h[commId] | 0) - Math.max(0, qty));
    if (!h[commId]) delete h[commId];
  },

  // Did a player rob this run? The scene and traffic.js read this to draw the
  // hauler limping on with an empty hold — render the record (§1.2). Called
  // per frame from the render layer: read-only, never creates the row.
  tookManifest(flightId, loop) {
    const s = window.Game && Game.state;
    return !!s && (s.piracyHits || []).some(h => h.f === flightId && h.k === loop);
  },
  _markHit(op, now) {
    this.hits().push({ f: op.flightId, k: op.loop, at: now });
  },
  _pruneHits(now) {
    const ttl = this.cfg().hitTtlMs || 7200000;
    const s = this.s();
    if ((s.piracyHits || []).some(h => now - h.at > ttl))
      s.piracyHits = s.piracyHits.filter(h => now - h.at <= ttl);
  },

  // ---- resolve: fight at the intercept, bank on landing --------------------
  // Returns made[] entries ({ piracy: r }) for the same recap channel mining
  // feeds, so an offline run's verdict is in "while you were away".
  resolve(now = Date.now()) {
    const s = this.s();
    this._pruneHits(now);
    if (!this.list().length) return [];
    const made = [];
    const local = this.local();
    for (const op of this.list()) {
      const sh = Fleet.ship(op.shipUid);
      if (!sh) { op._dead = true; delete this._pre[op.id]; continue; }  // hull gone — close out
      if (sh.status === "idle") sh.status = "raiding";   // self-heal after a merge reset
      this._announce(op, now);
      // Settle at settleAt, not resolveAt: the boarding action and the police
      // response take real time on the clock. Watched or AFK, the ledger
      // moves once, when the last stage would have played out.
      if (!op.resolved && now >= this.settleAt(op) && local) {
        const out = this.rollOutcome(op);
        op.resolved = true;
        op.outcome = { verb: op.verb, won: out.won, credits: out.credits };
        if (out.dmg > 0) Fleet.addDamage(sh, out.dmg);
        if (out.credits > 0) s.credits += out.credits;
        if (out.loot) {
          op.loot = out.loot;
          this._markHit(op, now);
          // §4.2 — the delivery never arrives: the destination sector's shelf
          // loses what your hold now carries (bounded by what it had).
          const sid = window.Stock ? Stock.sectorOf(op.toSys) : null;
          if (sid) for (const [id, q] of Object.entries(out.loot)) Stock.take(sid, id, q);
        }
        // Armed robbery books you straight onto the watchlist (won or not —
        // you tried); a toll is menace and stays a plain gain.
        const crime = this.crimeGain(op.verb, out.won);
        if (window.Crime) {
          if (op.verb === "rob") Crime.bookRobbery(crime);
          else if (crime) Crime.add(crime);
        }
        if (out.won && window.Rep) {
          for (const [f, d] of (this.cfg().rep || {})[op.verb] || []) Rep.change(f, d);
        }
        const r = { verb: op.verb, won: out.won, name: op.name, kind: op.kind,
          sysId: op.sysId, credits: out.credits, loot: op.loot || null,
          dmg: out.dmg, crime, ship: sh.name };
        // The boarding action itself is a replayable Dispatches report.
        if (op.verb === "rob")
          r.report = this._fileRobReport(op, sh, out, !!(op.loot && this.preview(op).chase), now);
        // §5.1 response: a successful robbery can draw the law on the way
        // home (police.js). Runs under the same resolved-once gate, so the
        // chase is banked offline exactly as it would play out live. A caught
        // run clears op.loot AND costs the hull — nothing banks, nothing
        // lands, the ship is gone.
        if (op.loot && window.Police) {
          const chase = Police.pursue(op, sh, now);
          if (chase) r.chase = chase;
        }
        made.push({ piracy: r });
        if (window.Bus) Bus.emit("piracyResolved", r);
        if (r.chase && r.chase.lost) {          // run down — no hull to land
          op._dead = true;
          delete this._pre[op.id]; delete this._seenStage[op.id];
          continue;
        }
      }
      if (now >= this.landAt(op) && (op.resolved || !local)) {
        // Home with the take. The manifest lands like mined ore: positions at
        // zero cost, parked at the home system's bay — hauling it somewhere
        // sellable is the same ore leg, now with a customs problem (§4.4).
        if (op.loot && local) {
          for (const [id, qty] of Object.entries(op.loot)) {
            const held = s.positions[id] || 0, prev = s.avgCost[id] || 0;
            s.positions[id] = held + qty;
            s.avgCost[id] = (held + qty) > 0 ? (held * prev) / (held + qty) : 0;
            if (window.Assets) Assets.parkBlocks(op.fromSys, id, qty);
            this.addHot(id, qty);
          }
        }
        sh.status = "idle";
        op._dead = true;
        delete this._pre[op.id]; delete this._seenStage[op.id];
      }
    }
    if (this.list().some(o => o._dead)) s.piracy = this.list().filter(o => !o._dead);
    if (made.length && window.Economy) { Economy.refreshNetWorth(); Economy.checkAchievements(); }
    return made;
  },
};

window.Piracy = Piracy;
