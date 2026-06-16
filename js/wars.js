/* wars.js — periodic faction wars. Two rivals clash: the aggressor's domain
   category spikes (blockade/scarcity) while the defender's slumps (disruption),
   a klaxon headline hits the newswire, and fresh contracts from either side pay
   a "war effort" bonus. A tradeable, dynamic-world event. Reuses FACTIONS
   rivalries, Broadcast.announce (screen + ticker + newswire + market shock), and
   the existing contract reward path.

   ponytail: the victor is a coin flip and the war is flavor+market, not yet
   swayed by the player's contracts. Track per-side contributions here if we
   want "pick a side" to decide the outcome.                                    */

const Wars = {
  s() { return window.Game.state; },

  // The active war, or null. Pure read — tick() does the clearing.
  active(now = Date.now()) { const w = this.s().war; return w && now < w.endsAt ? w : null; },
  atWar(faction, now = Date.now()) { const w = this.active(now); return !!w && (w.a === faction || w.b === faction); },

  // Distinct rivalry pairs derived from FACTIONS[*].rival.
  pairs() {
    const seen = new Set(), out = [];
    for (const f of Object.keys(FACTIONS)) {
      const r = FACTIONS[f].rival; if (!r) continue;
      const key = [f, r].sort().join(":"); if (seen.has(key)) continue;
      seen.add(key); out.push([f, r]);
    }
    return out;
  },

  start(now = Date.now()) {
    if (this.active(now)) return null;                         // one war at a time
    const pair = Util.pick(this.pairs()); if (!pair) return null;
    const [a, b] = Math.random() < 0.5 ? pair : [pair[1], pair[0]];   // randomize aggressor
    const catA = Util.pick(FACTIONS[a].domain), catB = Util.pick(FACTIONS[b].domain);
    const dur = WARCFG.durationMs / (window.Game.timeScale || 1);
    const war = { id: "war" + now, a, b, catA, catB, multA: WARCFG.spike, multB: WARCFG.slump,
      startedAt: now, endsAt: now + dur };
    this.s().war = war;
    const fa = FACTIONS[a].name, fb = FACTIONS[b].name;
    const entry = { id: war.id, faction: a, cat: catA, ts: now, dir: "up",
      headline: `${fa} go to war with ${fb}`,
      body: `Fighting flares across the lanes — ${catA} prices spike as ${fa} choke supply, while ${catB} slumps in the chaos. Trade the swing, or back a side on the contract board.` };
    Broadcast.announce(entry, [{ target: catA, mult: WARCFG.spike }, { target: catB, mult: WARCFG.slump }], dur, now);
    Bus.emit("war", { kind: "start", war });
    return war;
  },

  // Resolve a finished war: a victor is declared, a settling headline posts,
  // and the war clears. Safe to call every tick / on return from offline.
  tick(now = Date.now()) {
    const w = this.s().war;
    if (!w || now < w.endsAt) return;
    const winner = Math.random() < 0.5 ? w.a : w.b;
    const entry = { id: w.id + "_end", faction: winner, cat: FACTIONS[winner].domain[0], ts: now, dir: "down",
      headline: `${FACTIONS[winner].name} claim victory`,
      body: `The ${FACTIONS[w.a].name}–${FACTIONS[w.b].name} war winds down and the markets begin to settle.` };
    const s = this.s();
    s.newswire.unshift(entry);
    if (s.newswire.length > CONFIG.newswireMax) s.newswire.length = CONFIG.newswireMax;
    delete s.war;
    Bus.emit("news", entry);
    Bus.emit("war", { kind: "end", winner });
  },
};

window.Wars = Wars;
