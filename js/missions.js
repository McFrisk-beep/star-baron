/* missions.js — active contract missions. A mission runs through phases:
   an outbound leg (bar fills left→right), one or two on-site "work" phases with
   flavor text, then a return leg (bar drains right→left). On completion it rolls
   success vs the computed chance and pays out, or inflicts losses / impound.

   Phase 2: logged-in players launch/resolve via app_mission_* RPCs (server RNG). */

const Missions = {
  s() { return window.Game.state; },
  authoritative() { return !!(window.Economy && Economy.authoritative()); },

  // Success probability for a contract flown by the given ships.
  successChance(contract, uids) {
    const danger = DANGER.find(d => d.id === contract.danger) || DANGER[0];
    let chance = danger.baseSuccess;
    if (contract.minFirepower > 0) {
      const ratio = Fleet.power(uids) / contract.minFirepower;
      chance += Util.clamp((ratio - 1) * 0.25, -0.6, 0.35);
    } else if (Fleet.power(uids) > 0) chance += 0.02;
    if (contract.cargoRequired > 0) {
      const cap = Fleet.cargoCap(uids);
      if (cap < contract.cargoRequired) chance -= 0.45 * (1 - cap / contract.cargoRequired);
    }
    if (contract.faction) chance += Rep.successBonus(contract.faction); // friendly sponsor helps
    if (window.Senate && contract.type === "smuggle") chance -= Senate.smuggleFailAdd(); // tighter borders
    return Util.clamp(chance, 0.03, 0.99);
  },

  buildPhases(contract, uids) {
    const speed = Fleet.avgSpeed(uids) || 1;
    const total = contract.durationMs;
    const transit = window.Boosts ? (1 + Boosts.mag("missionTransit")) : 1;
    const leg = ((total * 0.3) / speed) * Math.max(0.2, transit);
    const work = total * 0.4;
    const labels = MISSION_PHASES[contract.type] || ["Working"];
    const fill = t => t.replace(/\{SYS\}/g, contract.sysName || "the site");
    return [
      { label: "Outbound transit", dir: "out", ms: leg },
      { label: fill(labels[1 % labels.length]), dir: "work", ms: work * 0.45 },
      { label: fill(labels[2 % labels.length]), dir: "work", ms: work * 0.55 },
      { label: "Return transit", dir: "in", ms: leg },
    ];
  },

  async _launchLocal(contract, uids) {
    const s = this.s();
    uids = uids.filter(u => { const sh = Fleet.ship(u); return sh && sh.status === "idle"; });
    if (!uids.length) return { ok: false, msg: "Select at least one idle ship." };
    if (window.Senate && uids.some(u => Senate.shipClassBanned(Fleet.ship(u).cls))) {
      const sh = Fleet.ship(uids.find(u => Senate.shipClassBanned(Fleet.ship(u).cls)));
      const info = Senate.shipBanInfo(sh && sh.cls);
      return { ok: false, msg: info ? `${info.cls}-class ships banned due to ${info.title}.` : "That ship class is restricted by a senate edict." };
    }
    // Claim at launch (board job or legacy pending) — View Contract does not
    // reserve. Stays below the guards above so a rejected launch never consumes
    // the contract.
    const claim = window.Bazaar ? await Bazaar.claimForLaunch(contract) : { ok: true, contract };
    if (!claim.ok) return claim;
    contract = claim.contract;
    const phases = this.buildPhases(contract, uids);
    const totalMs = phases.reduce((a, p) => a + p.ms, 0);
    const mission = {
      uid: "m" + (++s.seq),
      type: contract.type, title: contract.title, sysName: contract.sysName,
      shipUids: uids.slice(), phases, totalMs, startedAt: Date.now(),
      successChance: this.successChance(contract, uids),
      reward: contract.reward, impound: !!contract.impound, danger: contract.danger,
      stakeTier: contract.stakeTier || 0,
      faction: contract.faction, resolved: false,
      contractId: contract.id || null,
      // Station Contract Office haul (docs/STATIONS.md §11)
      stationId: contract.stationId || null,
      source: contract.source || null,
    };
    for (const u of uids) Fleet.ship(u).status = "mission";
    s.missions.push(mission);
    if (contract && contract.id && s.pendingContracts) {
      s.pendingContracts = s.pendingContracts.filter(c => c.id !== contract.id);
    }
    Economy.refreshNetWorth();
    Bus.emit("missionLaunched", mission);
    return { ok: true, mission };
  },

  launch(contract, uids) {
    if (!this.authoritative()) return this._launchLocal(contract, uids);
    const shipUids = (uids || []).slice();
    const contractId = contract && contract.id;
    if (!contractId) return Promise.resolve({ ok: false, msg: "Contract not in hand." });

    // Shared station hauls: escrow lives in station_hauls. Launch stamps the
    // server flight timer; bazaar app_mission_launch can't see those ids.
    const sharedStation = contract.source === "station" && contract.stationId
      && window.Stations && Stations.contractsShared
      && Stations.contractsShared(contract.stationId)
      && Stations._contractsWritable && Stations._contractsWritable();
    if (sharedStation) {
      return Economy._withRpc(
        () => this._launchLocal(contract, shipUids),
        () => Cloud.stationLaunchHaul(contractId, shipUids),
        "Couldn't launch station haul — try again."
      );
    }

    return Economy._withRpc(
      () => this._launchLocal(contract, shipUids),

      // phase2c: launch claims the board job. Pre-phase2c SQL only accepts
      // pendingContracts — take once, then retry launch.
      async () => {
        let r = await Cloud.missionLaunch(contractId, shipUids);
        const err = (r && (r.error || r.msg)) || "";
        if (r && !r.ok && /not in hand/i.test(err)) {
          const take = await Cloud.takeContract(contractId);
          if (take && take.ok) r = await Cloud.missionLaunch(contractId, shipUids);
        }
        return r;
      },
      "Couldn't launch mission — try again."
    );
  },

  // Abort an in-flight mission: ships return idle. Faction jobs cost standing
  // (no credits). Independent / unfactioned jobs are a free walk-away.
  _abandonLocal(uid) {
    const s = this.s();
    const m = (s.missions || []).find(x => x.uid === uid);
    if (!m || m.resolved) return { ok: false, msg: "Mission not found." };
    for (const u of m.shipUids || []) {
      const sh = Fleet.ship(u);
      if (sh && sh.status === "mission") sh.status = "idle";
    }
    const repHit = m.faction ? Rep.onContractCancel(m.faction, m.danger) : 0;
    s.missions = s.missions.filter(x => x.uid !== uid);
    if (m.source === "station" && m.contractId && window.Stations)
      void Stations.settleHaul(m.contractId, "abandon");
    Economy.refreshNetWorth();
    Bus.emit("missionAbandoned", m);
    return { ok: true, mission: m, repHit: repHit || 0 };
  },
  abandon(uid) {
    if (!this.authoritative()) return this._abandonLocal(uid);
    return Economy._withRpc(
      () => this._abandonLocal(uid),
      () => Cloud.missionAbandon(uid),
      "Couldn't abort mission — try again."
    );
  },

  phaseAt(m, now = Date.now()) {
    let elapsed = Util.clamp(now - m.startedAt, 0, m.totalMs);
    const overall = elapsed / m.totalMs;
    let acc = 0;
    for (let i = 0; i < m.phases.length; i++) {
      const p = m.phases[i];
      if (elapsed <= acc + p.ms || i === m.phases.length - 1) {
        return { index: i, label: p.label, dir: p.dir,
          phaseProgress: Util.clamp((elapsed - acc) / p.ms, 0, 1),
          overall, remaining: Math.max(0, m.totalMs - elapsed) };
      }
      acc += p.ms;
    }
    return { index: 0, label: m.phases[0].label, dir: "out", phaseProgress: 0, overall, remaining: 0 };
  },

  // Resolve finished missions. Returns reports (also pushed to state.reports).
  // Authoritative path awaits app_mission_resolve (server RNG); guests stay sync.
  // Station hauls are skipped by app_mission_resolve (escrow settle is separate).
  // Auth first so its result_slice can't resurrect a station mission we just cleared.
  // Shared station hauls settle BEFORE narrative so money and story share one roll.
  resolveMatured(now) {
    if (!this.authoritative()) return this._resolveLocal(now);
    const due = this.s().missions.some(m =>
      !m.resolved && m.source !== "station" && now - m.startedAt >= m.totalMs);
    if (!due) return this._resolveStationsAuth(now);
    return this._resolveAuth(now).then(async out =>
      (await this._resolveStationsAuth(now)).concat(out));
  },

  async _resolveStationsAuth(now) {
    const s = this.s();
    const waits = [];
    for (const m of s.missions) {
      if (m.resolved || now - m.startedAt < m.totalMs) continue;
      if (m.source !== "station" || !m.contractId || !window.Stations) continue;
      if (!(Stations.contractsShared && Stations.contractsShared(m.stationId))) continue;
      waits.push(Stations.settleHaul(m.contractId, "success").then(res => {
        m._serverSettle = res || { ok: false, msg: "Settle refused." };
      }).catch(e => {
        console.warn("[Missions] shared haul settle failed:", m.contractId, e);
        m._serverSettle = { ok: false, msg: "Couldn't reach the contract board." };
      }));
    }
    if (waits.length) await Promise.all(waits);
    return this._resolveLocal(now, { stationOnly: true });
  },

  // Replay roster: {uid, name, type} per participant, capped (~200 bytes).
  _roster(m) {
    return (m.shipUids || []).map(u => {
      const sh = Fleet.ship(u);
      return sh ? { uid: sh.uid, name: sh.name, type: sh.type } : null;
    }).filter(Boolean).slice(0, 12);
  },

  async _resolveAuth(now) {
    // Snapshot rosters BEFORE the RPC — the server slice replaces ships and
    // missions, and lost hulls are gone by the time the reports come back.
    const rosters = {};
    for (const m of this.s().missions) if (!m.resolved) rosters[m.uid] = this._roster(m);
    const r = await Economy._rpcOnly(() => Cloud.missionResolve(), "Couldn't resolve missions — try again.");
    if (r && r.missing) return this._resolveLocal(now, { skipStation: true });
    if (!r || !r.ok) return [];
    const out = Array.isArray(r.resolved) ? r.resolved : [];
    for (const rep of out) if (!rep.roster && rosters[rep.uid]) rep.roster = rosters[rep.uid];
    // ponytail: the next server slice may drop rosters again (server doesn't
    // store them yet — §4.4 upgrade path); the Replay button just disappears.
    for (const sr of this.s().reports || []) if (!sr.roster && rosters[sr.uid]) sr.roster = rosters[sr.uid];
    Economy.refreshNetWorth();
    Economy.checkAchievements();
    for (const rep of out) {
      if (window.MissionStory) MissionStory.begin(rep);
      Bus.emit("missionDone", rep);
    }
    return out;
  },

  // Shared station hauls: settle before narrative so money and story share one
  // server roll. Transient RPC failures leave the mission open — resolveMatured
  // is the retry (don't also queue pendingHaulSettles; the two drivers race).
  _resolveLocal(now, opts = {}) {
    const s = this.s();
    const out = [];
    for (const m of s.missions) {
      if (m.resolved || now - m.startedAt < m.totalMs) continue;
      if (opts.stationOnly && m.source !== "station") continue;
      if (opts.skipStation && m.source === "station") continue;

      const stationHaul = m.source === "station";
      const sharedHaul = stationHaul && m.stationId && window.Stations
        && Stations.contractsShared && Stations.contractsShared(m.stationId);
      const pre = sharedHaul ? m._serverSettle : null;
      if (sharedHaul) delete m._serverSettle;

      if (sharedHaul) {
        const err = (pre && (pre.msg || pre.error)) || "";
        // Still in flight — try again next tick. ("Not launched" is terminal in
        // _applySharedSettle; don't list it here or the guard lies.)
        if (pre && !pre.ok && /still in flight/i.test(err)) continue;
        // Transient RPC / board error — leave mission open; next resolveMatured
        // re-settles. No contractId (corrupt/legacy save) is terminal failure.
        if (m.contractId && (!pre || (!pre.ok && !pre.terminal))) continue;
      }

      m.resolved = true;
      // Shared: one server roll. Guest/local: client roll (and local settle below).
      let success = sharedHaul
        ? !!(pre && pre.ok && pre.outcome === "success")
        : Math.random() < m.successChance;
      const sharedPaid = sharedHaul && success;
      if (sharedPaid && pre.credits != null) s.credits = +pre.credits;

      const report = { uid: m.uid, title: m.title, type: m.type, success, ts: now,
        sysName: m.sysName || null, danger: m.danger || null, faction: m.faction || null,
        credits: 0, items: [], stock: null, lost: [], impounded: [], damaged: [],
        // LIVING_GALAXY.md §5.7: replays need the roster — lost ships leave
        // s.ships. Capped small; reports are already capped at 20.
        roster: this._roster(m) };

      // ---- battle damage & attrition: every ship rolls wear against the
      // mission type's profile (a courier grazes an asteroid; a battle line
      // comes home shot up). Destruction scales with how long the odds were.
      const prof = DMGCFG.types[m.type] || DMGCFG.types.transport;
      const dangerMult = DMGCFG.dangerMult[m.danger] || 1;
      const riskMult = 1 + (m.stakeTier || 0) * BAZAARCFG.tierRiskMult;
      const odds = 0.5 + (1 - m.successChance);        // 0.5 (sure thing) → ~1.5 (long shot)
      for (const u of m.shipUids) {
        const sh = Fleet.ship(u); if (!sh) continue;
        const destroyP = Util.clamp((success ? prof.destroy : prof.destroyFail * riskMult) * odds, 0, 0.9);
        if (Math.random() < destroyP) { report.lost.push({ uid: sh.uid, name: sh.name }); continue; }
        const hitP = success ? prof.chance : Math.min(1, prof.chance * 1.5);
        if (Math.random() < hitP) {
          const before = sh.dmg || 0;
          const dmgMult = window.Boosts ? Math.max(0, 1 + Boosts.mag("missionDamage")) : 1;
          Fleet.addDamage(sh, Util.randFloat(prof.dmg[0], prof.dmg[1]) * dangerMult * (success ? 1 : prof.failMult) * dmgMult);
          report.damaged.push({ uid: sh.uid, name: sh.name, pct: Math.round((sh.dmg - before) * 100) });
        }
      }
      const lostIds = new Set(report.lost.map(x => x.uid));
      const survivors = m.shipUids.map(u => Fleet.ship(u)).filter(sh => sh && !lostIds.has(sh.uid));
      // Wipe: guest/local flips to fail (settle fail below). Shared already settled —
      // keep the server verdict so the report matches the wallet.
      if (!survivors.length && report.lost.length) {
        report.wipe = true;
        if (!sharedPaid) { success = false; report.success = false; }
      }

      if (success) {
        const rewardMult = window.Boosts ? (1 + Boosts.mag("contractReward")) : 1;
        const gross = stationHaul
          ? Math.round(m.reward.credits || 0)
          : Math.round(m.reward.credits * (m.faction ? Rep.rewardMult(m.faction) : 1) * rewardMult);
        report.credits = Economy.afterTax(gross);
        report.taxed = gross - report.credits;
        if (!sharedHaul) s.credits += report.credits;
        s.stats.contractsDone = (s.stats.contractsDone || 0) + 1;
        if (m.faction && !stationHaul) Rep.onContract(m.faction, m.type, m.danger);
        if (!stationHaul) {
          const bias = { safe: 0, low: 0.1, moderate: 0.25, high: 0.45, extreme: 0.7 }[m.danger] || 0;
          if (Math.random() < (m.reward.itemChance || 0)) {
            const it = Items.gen({ bias });
            s.items[it.uid] = it; report.items.push(it);
            if (window.Assets) Assets.parkGear(it.uid, s.currentSystem);
            if (Math.random() < bias * 0.4) {
              const it2 = Items.gen({ bias }); s.items[it2.uid] = it2; report.items.push(it2);
              if (window.Assets) Assets.parkGear(it2.uid, s.currentSystem);
            }
          }
          if (Math.random() < (m.reward.stockChance || 0)) {
            const c = Util.pick(COMMODITIES.filter(x => !x.craftOnly)) || Util.pick(COMMODITIES);
            const qty = Util.randInt(8, 40);
            const held = s.positions[c.id] || 0, avg = s.avgCost[c.id] || 0;
            s.positions[c.id] = held + qty;
            s.avgCost[c.id] = held + qty > 0 ? (held * avg) / (held + qty) : 0; // granted free
            if (window.Assets) Assets.parkBlocks(s.currentSystem, c.id, qty);
            report.stock = { commId: c.id, name: c.name, qty };
          }
          // High-danger jobs can pay a Workshop blueprint (CRAFTING_AND_MATERIALS §3.5).
          const danger = m.danger || "";
          if (window.Workshop && (danger === "high" || danger === "extreme")
              && Math.random() < (WORKSHOPCFG.missionBlueprintChance || 0)) {
            const pool = Workshop.dropPool("mission");
            if (pool.length) {
              const bp = Util.pick(pool);
              const gr = Workshop.grantBlueprint(bp.id);
              if (gr.ok) report.blueprint = bp.name;
            }
          }
        }
        if (stationHaul && m.contractId && window.Stations && !sharedHaul) {
          Stations.settleHaul(m.contractId, "success");
        }
        for (const sh of survivors) sh.status = "idle";
      } else {
        // failure: survivors are seized (smuggle jobs) or limp home damaged.
        // Ship losses were already rolled above with the failure-grade odds.
        for (const sh of survivors) {
          if (m.impound) {
            sh.status = "impounded";
            sh.retrieveCost = Fleet.impoundFine(sh);   // stamp = the half-value fee (display-legacy)
            report.impounded.push({ uid: sh.uid, name: sh.name, cost: sh.retrieveCost });
          } else sh.status = "idle";
        }
        if (stationHaul && m.contractId && window.Stations && !sharedHaul) {
          Stations.settleHaul(m.contractId, "fail");
        }
      }
      if (report.lost.length) s.ships = s.ships.filter(sh => !lostIds.has(sh.uid));
      s.reports.unshift(report);
      if (s.reports.length > 20) s.reports.length = 20;
      out.push(report);
    }
    if (out.length) {
      s.missions = s.missions.filter(m => !m.resolved);
      Economy.refreshNetWorth();
      Economy.checkAchievements();
      for (const r of out) {
        if (window.MissionStory) MissionStory.begin(r);
        Bus.emit("missionDone", r);
      }
    }
    return out;
  },
};

window.Missions = Missions;
