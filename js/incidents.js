/* incidents.js — random, choice-driven encounters. Every few minutes of active
   play a scenario pops up with 2–3 options; some are a gamble (a shown % to
   win). Outcomes are pure data (credits / reputation / a found item / an
   impounded ship) applied by resolve(). Reuses Rep, Items, the impound system,
   and the modal shell. Timers only run while the tab is visible, so incidents
   are active-play spice, never an idle interruption.

   ponytail: credit swings are flat ranges, not scaled to net worth — fine for
   now; scale by tier/net-worth here if late game makes them feel trivial.      */

const INCIDENTS = [
  { id: "pirate_toll", icon: "☠", title: "Pirate Toll",
    text: "A scarred corsair wing fans across the lanes near {SYS}. \"Pay the toll, baron — or we take it in scrap.\"",
    choices: [
      { label: "Pay them off", effects: { credits: [-900, -300] } },
      { label: "Fight through", chance: 0.55, effects: { credits: [500, 1500], rep: [["free_trade", 3]] }, fail: { shipImpound: true } },
      { label: "Burn for the gate", effects: {} },
    ] },
  { id: "distress", icon: "📡", title: "Distress Beacon",
    text: "A crippled hauler limps out of the dark off {SYS}, venting atmosphere and begging for aid.",
    choices: [
      { label: "Render aid", chance: 0.7, effects: { rep: [["agri_collective", 4]], item: true }, fail: { rep: [["agri_collective", 4]], credits: [-400, -100] } },
      { label: "Strip the wreck", effects: { credits: [200, 900], rep: [["agri_collective", -3]] } },
      { label: "Stay on course", effects: {} },
    ] },
  { id: "smuggler", icon: "📦", title: "A Quiet Offer",
    text: "A twitchy fixer slides onto a side channel: \"Move a few crates, no questions. The Syndicate remembers its friends.\"",
    choices: [
      { label: "Run the crates", effects: { credits: [600, 1800], rep: [["syndicate", 4], ["free_trade", -2]] } },
      { label: "Not today", effects: {} },
    ] },
  { id: "derelict", icon: "🛰", title: "Silent Derelict",
    text: "A derelict tumbles in {SYS}'s shadow, running lights dead. Could be a payday — could be a trap.",
    choices: [
      { label: "Board and strip it", chance: 0.6, effects: { item: true, credits: [100, 600] }, fail: { shipImpound: true } },
      { label: "Mark it and move on", effects: {} },
    ] },
  { id: "patrol", icon: "🎖", title: "Combine Patrol",
    text: "A Mining Combine patrol flags you down near {SYS}, rattling a tin for the \"miners' relief fund.\"",
    choices: [
      { label: "Donate generously", effects: { credits: [-700, -300], rep: [["mining_combine", 5]] } },
      { label: "Toss a token", effects: { credits: [-150, -50], rep: [["mining_combine", 1]] } },
      { label: "Wave them off", effects: { rep: [["mining_combine", -2]] } },
    ] },
  { id: "windfall", icon: "💠", title: "Misfiled Manifest",
    text: "A clerical slip at the {SYS} exchange tips a misrouted cargo lot your way. Finders keepers?",
    choices: [
      { label: "Claim the lot", chance: 0.75, effects: { credits: [700, 2000] }, fail: { credits: [-300, -100], rep: [["free_trade", -2]] } },
      { label: "Report it", effects: { rep: [["free_trade", 3]] } },
    ] },
];

const Incidents = {
  s() { return window.Game.state; },

  // Resolve a chosen option: roll any gamble, apply effects, return a summary.
  resolve(incident, choiceIdx) {
    const choice = incident.choices[choiceIdx];
    if (!choice) return { summary: "no effect" };
    const gamble = choice.chance != null;
    const won = gamble ? Math.random() < choice.chance : true;
    const out = this.apply((won ? choice.effects : choice.fail) || {});
    return { gamble, won, summary: out };
  },

  apply(eff) {
    const s = this.s(); const parts = [];
    if (eff.credits != null) {
      const amt = Array.isArray(eff.credits) ? Util.randInt(eff.credits[0], eff.credits[1]) : eff.credits;
      s.credits = Math.max(0, s.credits + amt);
      parts.push(`${amt >= 0 ? "+" : "−"}${Util.credits(Math.abs(amt))}c`);
    }
    for (const [f, d] of eff.rep || []) {
      Rep.change(f, d);
      parts.push(`${d >= 0 ? "+" : "−"}${Math.abs(d)} ${(FACTIONS[f] || {}).name || f}`);
    }
    if (eff.item) {
      const it = Items.gen({});
      if (Bazaar.inventoryUsed() < Bazaar.capacity()) { s.items[it.uid] = it; parts.push(`gained ${it.name}`); }
      else parts.push("found gear, but your hold was full");
    }
    if (eff.shipImpound) {
      const cand = Fleet.idle().filter(sh => !sh.mercenary);
      const sh = cand.length ? Util.pick(cand) : null;
      if (sh) { sh.status = "impounded"; sh.retrieveCost = Math.max(600, Math.round((Fleet.shipDef(sh.type).price || 2000) * 0.3)); parts.push(`${sh.name} impounded`); }
      else parts.push("no ship to seize — you slip away");
    }
    Economy.refreshNetWorth();
    return parts.join(" · ") || "no effect";
  },
};

window.INCIDENTS = INCIDENTS;
window.Incidents = Incidents;
