/* police.js — the law's response (docs/SPACE_INTERACTIVITY.md §5.2, built
   form). Three things, none of them AI:

   • PRECINCTS — derived geography, never authored: any system whose published
     security band reaches POLICECFG.stationBand hosts a police station, drawn
     in the scene. Fit a Customs House and lift a system into the band, and a
     precinct opens; a Free Port drops the band and the precinct closes. The
     players keep changing the map by playing (§5.3).

   • PATROLS — seeded flight plans, exactly the §5.2 idea given hulls and
     lights: each sector with a precinct flies a standing patrol, always in a
     PAIR, hopping between that sector's systems on a seeded loop. A pure view
     of the clock riding the same Voyages pipeline as all traffic — nothing
     stored, identical on every client, red/blue strobes drawn by the scene.

   • THE CHASE — §5.1's "you succeed, then the bill arrives". A successful
     robbery can draw a response on the way home, with odds scaled by the law
     present where it happened (stamped on the op at dispatch — the risk you
     accepted). It resolves like a mission: the wallet is decided first by a
     pure seeded function of the op, then a report is filed in Dispatches that
     BattleView can replay — the movie never disagrees with the outcome.

     Police are formidable but killable. Break the pair and the loot is yours
     for now — but killing patrol officers is the worst crime on the books
     (CRIMECFG.gain.police per pair), the next wave comes heavier, and only
     breaking every wave (POLICECFG.maxWaves) shakes the trail. A broken pair
     sometimes yields the one piece of kit money can't buy (POLICE_ITEM).

     The stakes are real: being run down costs the stolen cargo (recovered to
     the shelf it was bound for) AND the raiding hull itself — destroyed with
     all hands. Piracy risks the ship you fly it with; banked stock and
     credits are still never touched.

   • THE MANHUNT — past CRIMECFG.criminal the law stops waiting for a fresh
     crime: a patrol runs a dispatched hull down on the way OUT, for the
     record it already carries. No outrun branch (they chase until they catch
     it): you break the pair or you lose the ship. Only hulls a baron SENT are
     hunted — never the flagship they fly themselves.                        */

const Police = {
  cfg() { return window.POLICECFG || {}; },

  _ready() {
    return !!(window.Galaxy && Galaxy.sectors && Galaxy.sectors.length
      && window.Security && window.Voyages && window.Lanes);
  },

  // ---- precincts: derived, never authored ---------------------------------
  // The seat of a sector's law is its CAPITAL — one precinct per sector, not
  // one per high-scoring system (which piled every station into the Core and
  // left four sectors unpoliced). Still derived: a capital must also be
  // somewhere the law runs at all, which is what keeps Senate stations out of
  // the Sable Sprawl (§5.4 — the Syndicate is the law there). Lift the
  // Sprawl's capital above the floor by playing and a precinct opens there.
  hasPrecinct(sysId) {
    const sys = window.Galaxy ? Galaxy.get(sysId) : null;
    if (!sys || !sys.capital || !window.Security) return false;
    return Security.score(sysId) >= (this.cfg().precinctMinScore || 0);
  },
  // Per-sector precinct lists, cached per minute — Security reads station
  // tables, and patrols() runs per frame.
  _pc: null,
  _precincts(now) {
    const bucket = Math.floor(now / 60000);
    if (this._pc && this._pc.bucket === bucket) return this._pc.map;
    const map = {};
    for (const sec of Galaxy.sectors) {
      const list = sec.systems.filter(id => this.hasPrecinct(id));
      if (list.length) map[sec.id] = list;
    }
    this._pc = { bucket, map };
    return map;
  },

  // ---- patrols: seeded pairs on the sector lanes --------------------------
  // Same shape as Traffic flights so Voyages/StarMap draw them for free.
  // manifest stays empty: the intercept card has nothing to offer on them.
  patrols(now = Date.now()) {
    if (!this._ready()) return [];
    try {
      const c = this.cfg(), out = [];
      const pre = this._precincts(now);
      for (const sec of Galaxy.sectors) {
        const homes = pre[sec.id];
        if (!homes) continue;
        for (let i = 0; i < (c.pairsPerSector || 1); i++) {
          const sSlot = Market._seed(["police", "pair", sec.id, String(i)]);
          const loopMs = (c.patrolLoopMinMs || 1200000)
            + Market._u01(sSlot, 0) * ((c.patrolLoopMaxMs || 2100000) - (c.patrolLoopMinMs || 1200000));
          const k = Math.floor(now / loopMs);
          const s = Market._seed(["police", "hop", sec.id, String(i), String(k)]);
          // Out of a precinct, sweep to another system in the sector.
          const from = homes[k % homes.length];
          const ids = sec.systems;
          let to = ids[Math.floor(Market._u01(s, 0) * ids.length) % ids.length];
          if (to === from) to = ids[(ids.indexOf(from) + 1) % ids.length];
          if (to === from) continue;
          const plan = Voyages.plan(from, to, k * loopMs, loopMs * (c.patrolFlyFrac || 0.85));
          if (!plan) continue;
          const at = Voyages.pos(plan, now);
          if (!at || at.p >= 1) continue;         // holding at the far end of the sweep
          out.push({
            id: `npc:pol:${sec.id}:${i}`, kind: "police", police: true, pair: true,
            npc: true, name: `${sec.name} Patrol`, label: "Senate Patrol",
            sprite: "race:voidkin", manifest: [], plan, at,
          });
        }
      }
      return out;
    } catch (e) {
      console.warn("Police.patrols failed", e);
      return [];
    }
  },

  // ---- the chase ----------------------------------------------------------
  responseChance(law) {
    const cl = this.cfg().responseClamp || [0, 1];
    return Util.clamp((this.cfg().responseBase || 0) * law, cl[0], cl[1]);
  },
  pairScoreAt(law, wave) {
    const c = this.cfg();
    return (c.pairScore || 600) * (1 + law * (c.lawScore || 0)) * Math.pow(c.waveMult || 1, wave);
  },

  // The pursuit's ROLLS, pure of (op id, atk) — no state touched. Same seed
  // and draw order the SQL's app._police_chase mirrors: index 0 gates the
  // response, then 4 indexes per wave. Split from pursue() so the timeline
  // (Piracy.settleAt, the chart markers, the stage toasts) can pre-read how
  // the chase runs without applying a single effect.
  // Returns null (no response formed) or
  // { waves: [{destroyed, caught, dmg, item}], destroyed, caught, escaped }.
  chaseOutcome(op, atk) {
    const c = this.cfg();
    const law = Util.clamp(op.law != null ? +op.law : 0.5, 0, 1);
    const s = Market._seed(["police", op.id]);
    if (Market._u01(s, 0) >= this.responseChance(law)) return null;
    const roll = (range, n) => { const r = range || [0, 0]; return r[0] + Market._u01(s, n) * (r[1] - r[0]); };
    const dCl = c.destroyClamp || [0, 1], cCl = c.catchClamp || [0, 1];
    const out = { waves: [], destroyed: 0, caught: false, escaped: false };
    for (let w = 0; w < (c.maxWaves || 3); w++) {
      const def = this.pairScoreAt(law, w);
      const base = 1 + w * 4;
      if (Market._u01(s, base) < Util.clamp(atk / (atk + def), dCl[0], dCl[1])) {
        out.destroyed++;
        out.waves.push({ destroyed: true, dmg: roll(c.chaseDmg, base + 1),
          item: Market._u01(s, base + 2) < (c.itemChance || 0) });
        continue;
      }
      if (Market._u01(s, base + 3) < Util.clamp(def / (def + atk) * (c.catchMult || 1), cCl[0], cCl[1])) {
        out.caught = true;
        out.waves.push({ caught: true, dmg: roll(c.chaseDmg, base + 1) });
        break;
      }
      out.waves.push({});                   // outran the lights
      out.escaped = true;
      break;
    }
    if (!out.caught && !out.escaped) out.escaped = true;   // broke every wave — the trail goes cold
    return out;
  },
  // How long the response plays on the clock: the rush to the scene, then one
  // fight window per wave actually formed. Zero when no response forms.
  chaseLenMs(chase) {
    const c = this.cfg();
    return chase ? (c.arriveMs || 0) + chase.waves.length * (c.waveGapMs || 0) : 0;
  },

  // ---- the manhunt (CRIMECFG.criminal and above) ---------------------------
  // Past the criminal line a patrol no longer needs a fresh crime to act on:
  // finding one of your dispatched hulls in its lane is enough. Pure of
  // (op id, atk) exactly like the chase — the CRIME gate is read live on both
  // sides (client Crime.value(), server state) rather than stamped on the op,
  // so lying low genuinely calls them off mid-flight.
  // "Chases until it catches on": there is no outrun branch. You break the
  // pair or they take the hull.
  manhuntChance(crime) {
    const c = this.cfg();
    const line = (window.CRIMECFG || {}).criminal || 300;
    const over = Math.max(0, crime - line);
    const cl = c.manhuntClamp || [0, 1];
    return Util.clamp((c.manhuntBase || 0) * (1 + over / 100 * (c.manhuntPer100 || 0)), cl[0], cl[1]);
  },
  manhuntOutcome(op, atk, crime) {
    const c = this.cfg();
    const line = (window.CRIMECFG || {}).criminal || 300;
    if (!(crime >= line)) return null;
    const s = Market._seed(["manhunt", op.id]);
    if (Market._u01(s, 0) >= this.manhuntChance(crime)) return null;
    const law = Util.clamp(op.law != null ? +op.law : 0.5, 0, 1);
    const def = this.pairScoreAt(law, 0);
    const dCl = c.destroyClamp || [0, 1];
    const broke = Market._u01(s, 1) < Util.clamp(atk / (atk + def), dCl[0], dCl[1]);
    const dm = c.chaseDmg || [0, 0];
    const at = c.manhuntAt || [0.3, 0.7];
    return {
      broke, caught: !broke,
      dmg: broke ? dm[0] + Market._u01(s, 2) * (dm[1] - dm[0]) : 0,
      frac: at[0] + Market._u01(s, 3) * (at[1] - at[0]),
    };
  },
  // Apply a manhunt that has come due. Called once per op, under the caller's
  // own once-gate, so offline equals online.
  runManhunt(op, sh, mh, now = Date.now()) {
    const out = { caught: !!mh.caught, crime: 0, item: null, lost: null,
      report: null, ship: sh.name, sysId: op.sysId };
    if (mh.broke) {
      out.crime = ((window.CRIMECFG || {}).gain || {}).police || 0;
      Fleet.addDamage(sh, mh.dmg);
      out.report = this._fileReport(op, sh, 0, true, mh.dmg, now, null, "Manhunt");
      if (out.crime && window.Crime) Crime.add(out.crime);
    } else {
      out.lost = { uid: sh.uid, name: sh.name };
      out.report = this._fileReport(op, sh, 0, false, 0, now, out.lost, "Manhunt");
      const st = window.Game.state;
      st.ships = st.ships.filter(x => x.uid !== sh.uid);
    }
    if (window.Bus) Bus.emit("manhunt", out);
    return out;
  },

  // Resolve the pursuit for one robbed run. Called by Piracy.resolve exactly
  // once, under the op.resolved gate, so applying effects here keeps offline
  // equal to online. All rolls come from chaseOutcome(); this applies them.
  // Returns null (no response formed) or a summary for the recap/toast.
  pursue(op, sh, now = Date.now()) {
    if (!op || !op.loot || !sh || !window.Charters) return null;
    const atk = Charters.defenseScore(Charters.fleetStats([sh]));
    const rolls = this.chaseOutcome(op, atk);
    if (!rolls) return null;
    const out = { waves: rolls.waves.length, destroyed: rolls.destroyed,
      caught: rolls.caught, escaped: rolls.escaped, seized: 0, crime: 0,
      item: null, report: null, lost: null, ship: sh.name, sysId: op.sysId };
    for (let w = 0; w < rolls.waves.length; w++) {
      const wave = rolls.waves[w];
      if (wave.destroyed) {
        // The pair is broken. The loot stays yours; the charge sheet grows,
        // and the next response comes heavier.
        out.crime += ((window.CRIMECFG || {}).gain || {}).police || 0;
        Fleet.addDamage(sh, wave.dmg);
        out.report = this._fileReport(op, sh, w, true, wave.dmg, now);
        if (!out.item && wave.item) out.item = this._salvage();
      } else if (wave.caught) {
        // Run down. The stolen cargo is recovered — it goes back to the shelf
        // the delivery was bound for — and the hull is LOST WITH ALL HANDS:
        // shooting it out with the Senate and losing costs the ship itself.
        const sid = window.Stock ? Stock.sectorOf(op.toSys) : null;
        for (const [id, q] of Object.entries(op.loot)) { out.seized += q; if (sid) Stock.put(sid, id, q); }
        op.loot = null;
        out.lost = { uid: sh.uid, name: sh.name };
        out.report = this._fileReport(op, sh, w, false, wave.dmg, now, out.lost);
        const st = window.Game.state;
        st.ships = st.ships.filter(x => x.uid !== sh.uid);
      }
    }
    if (out.crime && window.Crime) Crime.add(out.crime);
    if (window.Bus) Bus.emit("policeChase", out);
    return out;
  },

  // A mission-shaped report: the chase plays in BattleView off the smuggle
  // template (a run for the gate, pursuers cutting angles) and lands in
  // Comms → Dispatches like any engagement. Combat's police flavour fields
  // the ENEMY_CATALOG.police hulls, tier rising with the wave.
  _fileReport(op, sh, wave, success, dmg, now, lost, kindLabel) {
    const s = window.Game.state;
    if (!s.reports) s.reports = [];
    const sys = window.Galaxy ? Galaxy.get(op.sysId) : null;
    const report = {
      uid: op.id + (kindLabel ? "mh" : "w") + wave,
      title: (kindLabel || ["Patrol response", "Reinforced response", "Vanguard response"][Math.min(wave, 2)])
        + (sys ? ` — ${sys.name}` : ""),
      type: "smuggle", success, ts: now, faction: "police", police: true,
      danger: ["moderate", "high", "extreme"][Math.min(wave, 2)],
      enemyCount: 2 * (wave + 1),         // pairs, reinforced per wave
      wave,                               // combat.js fields a UNIFORM pair per wave
      credits: 0, items: [], lost: lost ? [lost] : [], impounded: [],
      wipe: !!lost,                       // the run-down hull goes with all hands
      damaged: !lost && dmg > 0 ? [{ uid: sh.uid, name: sh.name, pct: Math.max(1, Math.round(dmg * 100)) }] : [],
      roster: [{ uid: sh.uid, name: sh.name, type: sh.type }],
    };
    s.reports.unshift(report);
    if (s.reports.length > 20) s.reports.length = 20;
    return report.uid;
  },

  // The police-only accessory, stripped from a broken pair. Fixed shape from
  // POLICE_ITEM — deliberately stronger than anything Items.gen can roll.
  _salvage() {
    const def = window.POLICE_ITEM;
    if (!def) return null;
    if (window.Bazaar && Bazaar.inventoryUsed() >= Bazaar.capacity())
      return { name: def.name, full: true };    // no room — the wreck burns with it
    const s = window.Game.state;
    const it = JSON.parse(JSON.stringify(def));
    it.uid = "i" + (++s.seq);
    it.police = true;
    it.value = window.Items ? Items.value(it) : 0;
    s.items[it.uid] = it;
    return { name: it.name, uid: it.uid };
  },
};

window.Police = Police;
