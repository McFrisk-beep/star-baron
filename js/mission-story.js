/* mission-story.js — completed Fleet contracts open a Dispatches after-action
   report with flavor text. Payout already landed in Missions.resolve; this is
   the inbox narrative (Continue to file). Mirrors SurveyStory's ephemeral
   thread pattern without changing mission outcomes.                           */

const MissionStory = {
  PORTRAIT: 2,

  // Type → outcome lines. Tokens: {TITLE} {SYS} {CREDITS} {SHIPS} {LOST} {ITEM}
  LINES: {
    transport: {
      ok: [
        "Cargo master at {SYS} signed the chit. {TITLE} — clean drop, no drama.",
        "Hold empty, manifests sealed. {SYS} customs waved you through. {CREDITS}.",
        "Freight's where it belongs. Broker calls {TITLE} a model run.",
      ],
      fail: [
        "The load never made {SYS}. {TITLE} dies on the paperwork.",
        "Dock clerks shrug. Whatever you were hauling isn't on their pad.",
        "Route fell apart short of {SYS}. Contract void — and the gossip starts.",
      ],
    },
    escort: {
      ok: [
        "Convoy intact at {SYS}. Escorts earned their keep on {TITLE}.",
        "Probing attacks peeled off. Clients tip their hats. {CREDITS}.",
        "Formation held. {TITLE} closes with every hull still answering hail.",
      ],
      fail: [
        "Convoy scattered. {TITLE} is a black mark on the escort boards.",
        "You lost the formation before {SYS}. Survivors want words.",
        "Escort screen collapsed. The cargo — and the reputation — took the hit.",
      ],
    },
    combat: {
      ok: [
        "Hostiles broken over {SYS}. {TITLE} is in the win column. {CREDITS}.",
        "Field secured. Gun crews want a drink; the contract wants a signature.",
        "Mop-up complete. Whoever hired {TITLE} got what they paid for.",
      ],
      fail: [
        "The engagement went wrong. {TITLE} ends with retreat burns and excuses.",
        "Hostile line held. You didn't. Report filed under 'regrettable'.",
        "Combat loss near {SYS}. The boards will remember the silhouette.",
      ],
    },
    smuggle: {
      ok: [
        "Dark run complete. Dockmaster at {SYS} never saw a thing. {CREDITS}.",
        "Quiet offload. {TITLE} pays in unmarked crates and thin smiles.",
        "Patrols blinked. Your holds are lighter; your ledger heavier.",
      ],
      fail: [
        "Patrol lights. {TITLE} dies in a customs bay.",
        "Someone talked. The dark run got very bright near {SYS}.",
        "Smuggle blown. What's left of the cargo is evidence.",
      ],
    },
    assassinate: {
      ok: [
        "Target removed. {TITLE} never happened, officially. {CREDITS}.",
        "Clean exit from {SYS}. The client already knows.",
        "One less name on someone's list. Yours stays off it — for now.",
      ],
      fail: [
        "The shot missed or the cover did. {TITLE} is a liability now.",
        "Exfil under fire. Target still breathing; contract isn't.",
        "Botched run near {SYS}. Burn the channel.",
      ],
    },
    charter: {
      ok: [
        "Charter closed. Hulls back on the board. {CREDITS}.",
        "{TITLE} — convoy accounted for. Ops files the chit. {CREDITS}.",
        "Return burn complete. {TITLE} is off the active list. {CREDITS}.",
      ],
      pending: [
        "Wing is docked and accounted for. Ledger hasn't cleared — Ops says buy it out if you want the salvage now.",
        "{TITLE} — hulls home, chit unsigned. The charter board owes you.",
        "Return burn complete. Payment is stuck upstream; Ops recommends the buy-out.",
      ],
      fail: [
        "{TITLE} ends without a returning wing. Ops stamps the loss.",
        "No hulls answered the recall. Charter wiped.",
        "The charter board writes {TITLE} off. Bad day in the lanes.",
      ],
    },
  },
  FALLBACK: {
    ok: ["{TITLE} complete. Ops stamps it done. {CREDITS}."],
    fail: ["{TITLE} failed. Ops stamps it louder."],
  },

  s() { return window.Game && window.Game.state; },

  _pick(report) {
    const bag = (this.LINES[report && report.type] || this.FALLBACK);
    if (report && report.deferred && bag.pending) return Util.pick(bag.pending);
    return Util.pick(bag[report && report.success ? "ok" : "fail"] || this.FALLBACK.ok);
  },

  _fill(text, ctx) {
    return String(text || "")
      .replace(/\{TITLE\}/g, ctx.title)
      .replace(/\{SYS\}/g, ctx.sys)
      .replace(/\{CREDITS\}/g, ctx.credits)
      .replace(/\{SHIPS\}/g, ctx.ships)
      .replace(/\{LOST\}/g, ctx.lost)
      .replace(/\{ITEM\}/g, ctx.item);
  },

  _facts(report) {
    const bits = [];
    if (report.success) {
      if (report.credits) bits.push(`+${Util.credits(report.credits)}c wired`);
      if (report.stock) bits.push(`+${report.stock.qty} ${report.stock.name} in hold`);
      if ((report.items || []).length) {
        const n = report.items.length;
        bits.push(n === 1 ? `salvage: ${report.items[0].name}` : `${n} accessories recovered`);
      }
    } else if (report.deferred) {
      // Phase-3 deferred close: hulls returned, ledger pay not minted.
      bits.push("payout pending — Buy out the charter to recover salvage");
    } else {
      bits.push(report.wipe ? "total loss — no ships returned" : "contract failed");
    }
    if ((report.lost || []).length)
      bits.push(`lost ${report.lost.map(x => x.name).join(", ")}`);
    if ((report.impounded || []).length)
      bits.push(`${report.impounded.length} ship(s) impounded — retrieve from Fleet`);
    if ((report.damaged || []).length)
      bits.push(`damage: ${report.damaged.map(x => `${x.name} −${x.pct}%`).join(", ")}`);
    return bits.length ? bits.join(" · ") : (report.success ? "All quiet." : "No further comment.");
  },

  // Open (or refresh) a Dispatches after-action for this mission report.
  begin(report) {
    const st = this.s(); if (!st || !report || !window.Story) return null;
    const id = "mrep_" + report.uid;
    const story = Story.s();
    // Don't reopen a filed / already-active thread for the same mission.
    if (story.prog[id]) return null;

    const sys = report.sysName || "the site";
    const ctx = {
      title: report.title || "Contract",
      sys,
      credits: report.credits ? `+${Util.credits(report.credits)}c` : "pay pending",
      ships: "the wing",
      lost: (report.lost || []).map(x => x.name).join(", ") || "none",
      item: (report.items && report.items[0] && report.items[0].name) || "gear",
    };
    const flavor = this._fill(this._pick(report), ctx);
    const facts = this._facts(report);

    const steps = [{
      key: "open",
      text: `Fleet Ops after-action — ${report.title || "contract"}.\n\n${flavor}\n\nLedger: ${facts}`,
      continue: {
        label: "File the report",
        reply: "Report filed.",
        end: true,
      },
      replies: [
        { label: "Any word on the wing?", reply: "Status on the ships?",
          ack: (report.lost || []).length
            ? `We lost ${(report.lost || []).map(x => x.name).join(", ")}. The rest are accounted for.`
            : (report.impounded || []).length
              ? "Survivors are in impound — pay the fine under Owned Ships."
              : "Wing is on the board. Damage reports attached if any." },
        { label: "Say less.", reply: "File it.",
          ack: report.success ? "Already did. Get back on the boards."
            : report.deferred ? "Buy it out when you're ready — Ops filed the chit."
            : "Filed under lessons. Next contract." },
      ],
    }];

    const sl = {
      id, kind: "job", from: "Fleet Ops", portrait: this.PORTRAIT,
      outro: report.deferred
        ? `Fleet Ops: “${report.title} — hulls home, payout pending.”`
        : report.success
          ? `Fleet Ops: “${report.title} — closed successful.”`
          : `Fleet Ops: “${report.title} — closed unsuccessful.”`,
      steps, _missionReport: true, _reportUid: report.uid,
    };

    story.ephemeral = story.ephemeral || {};
    story.ephemeral[id] = sl;
    story.prog[id] = { step: 0, base: Story.snap(st), status: "active", accepted: true };
    Story._postIn(sl, steps[0]);
    if (window.UI && UI.bumpComms) UI.bumpComms();
    Bus.emit("missionDebrief", { report, id });
    return { id, sl };
  },

  // After a pull / offline catch-up: open threads for any reports that never got one.
  openPending(reports) {
    if (!reports || !reports.length) return 0;
    let n = 0;
    for (const r of reports) {
      if (!r || r.type === "survey" || r.awaitingDebrief) continue;
      if (this.begin(r)) n++;
    }
    return n;
  },
};

window.MissionStory = MissionStory;
