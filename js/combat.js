/* combat.js — the shared seeded-randomness kit (and the fleet's radio).

   The battle choreographer that used to live here (Combat.script → the
   modal movie) is gone: fights are canvas-first now. js/encounters.js is
   the one engagement model and js/encounterscene.js the one renderer —
   everything plays out in the system scene, and the dispatch/fleet report
   is the record for anyone who missed it live.

   What remains is what the rest of the game leans on: the FNV-1a seed and
   the mulberry32 generator (missions, charters, voyages, encounters, the
   scene all draw their determinism from these) and the ship radio lines
   the scene's chatter bubbles pick from. */

const Combat = {
  // FNV-1a — any uid → deterministic seed (same fight every time).
  seedFrom(str) {
    let h = 2166136261;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  },
  _mk(seed) {   // mulberry32, same generator family as Galaxy._mk
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },

  // Ship radio, picked deterministically from the fight seed.
  LINES: {
    open:    ["Contacts on scope — weapons free.", "They're on us. All ships, engage!", "Form up. Here they come.", "Hostiles inbound — battle stations."],
    retreat: ["We're taking heavy damage — falling back!", "Break off! Regroup at the jump point!", "Too hot — get us out of here!"],
    wipe:    ["Mayday, mayday — we're going down!", "All hands, abandon ship!"],
    win:     ["Enemy line's broken — clean sweep.", "That's the last of them. Well fought.", "Hostiles routed. Securing the field."],
    pyrrhic: ["We won… barely. Tow the wrecks home.", "Victory. Count the cost later."],
    death:   ["Hull breach! We're going—", "Reactor's critical! Eject, ej—"],
    shields: ["Shields are down!", "Deflectors gone — brace for impact!"],
  },
};

window.Combat = Combat;
