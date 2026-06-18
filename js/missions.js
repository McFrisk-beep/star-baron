/* missions.js — active contract missions. A mission runs through phases:
   an outbound leg (bar fills left→right), one or two on-site "work" phases with
   flavor text, then a return leg (bar drains right→left). On completion it rolls
   success vs the computed chance and pays out, or inflicts losses / impound.   */

const Missions = {
  s() { return window.Game.state; },

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
    const leg = (total * 0.3) / speed;
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

  launch(contract, uids) {
    const s = this.s();
    uids = uids.filter(u => { const sh = Fleet.ship(u); return sh && sh.status === "idle"; });
    if (!uids.length) return { ok: false, msg: "Select at least one idle ship." };
    if (window.Senate && uids.some(u => Senate.shipClassBanned(Fleet.ship(u).cls)))
      return { ok: false, msg: "A senate edict bars one of those ship classes from contract work." };
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
    };
    for (const u of uids) Fleet.ship(u).status = "mission";
    s.missions.push(mission);
    Economy.refreshNetWorth();
    Bus.emit("missionLaunched", mission);
    return { ok: true, mission };
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
  resolveMatured(now) {
    const s = this.s();
    const out = [];
    for (const m of s.missions) {
      if (m.resolved || now - m.startedAt < m.totalMs) continue;
      m.resolved = true;
      const success = Math.random() < m.successChance;
      const report = { uid: m.uid, title: m.title, type: m.type, success, ts: now,
        credits: 0, items: [], stock: null, lost: [], impounded: [] };

      if (success) {
        const gross = Math.round(m.reward.credits * (m.faction ? Rep.rewardMult(m.faction) : 1));
        report.credits = Economy.afterTax(gross);                 // Baron Tier earnings tax
        report.taxed = gross - report.credits;
        s.credits += report.credits;
        s.stats.contractsDone = (s.stats.contractsDone || 0) + 1;
        if (m.faction) Rep.onContract(m.faction, m.type, m.danger);
        const bias = { safe: 0, low: 0.1, moderate: 0.25, high: 0.45, extreme: 0.7 }[m.danger] || 0;
        if (Math.random() < (m.reward.itemChance || 0)) {
          const it = Items.gen({ bias });
          s.items[it.uid] = it; report.items.push(it);
          if (Math.random() < bias * 0.4) { const it2 = Items.gen({ bias }); s.items[it2.uid] = it2; report.items.push(it2); }
        }
        if (Math.random() < (m.reward.stockChance || 0)) {
          const c = Util.pick(COMMODITIES);
          const qty = Util.randInt(8, 40);
          const held = s.positions[c.id] || 0, avg = s.avgCost[c.id] || 0;
          s.positions[c.id] = held + qty;
          s.avgCost[c.id] = held + qty > 0 ? (held * avg) / (held + qty) : 0; // granted free
          report.stock = { commId: c.id, name: c.name, qty };
        }
        for (const u of m.shipUids) { const sh = Fleet.ship(u); if (sh) sh.status = "idle"; }
      } else {
        // failure consequences depend on the job — bigger stakes at higher Baron Tiers
        const riskMult = 1 + (m.stakeTier || 0) * BAZAARCFG.tierRiskMult;
        for (const u of m.shipUids) {
          const sh = Fleet.ship(u); if (!sh) continue;
          if (m.impound) {
            sh.status = "impounded";
            sh.retrieveCost = Math.round(((Fleet.shipDef(sh.type).price || 2000) * 0.5) * riskMult) || 1500;
            report.impounded.push({ uid: sh.uid, name: sh.name, cost: sh.retrieveCost });
          } else {
            const baseLoss = { safe: 0.05, low: 0.15, moderate: 0.3, high: 0.5, extreme: 0.7 }[m.danger] || 0.2;
            const lossP = Util.clamp(baseLoss * riskMult, 0, 0.9);
            if (Math.random() < lossP) report.lost.push({ uid: sh.uid, name: sh.name });
            else sh.status = "idle";
          }
        }
        if (report.lost.length) {
          const lostIds = new Set(report.lost.map(x => x.uid));
          s.ships = s.ships.filter(sh => !lostIds.has(sh.uid));
        }
      }
      s.reports.unshift(report);
      if (s.reports.length > 20) s.reports.length = 20;
      out.push(report);
    }
    if (out.length) {
      s.missions = s.missions.filter(m => !m.resolved);
      Economy.refreshNetWorth();
      Economy.checkAchievements();
      for (const r of out) Bus.emit("missionDone", r);
    }
    return out;
  },
};

window.Missions = Missions;
