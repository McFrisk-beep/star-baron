/* story.js — "Dispatches": a lightweight story / quest layer surfaced in Comms.

   A contact messages you on a private channel; you either complete an OBJECTIVE
   (tracked automatically from live game state) or pick a REPLY (a branching
   choice); completing a step pays a REWARD — credits, a ship, a component, an
   extractor, an accessory, or a temporary industry TAX BREAK. Storylines come in
   two flavors: serialized `arc`s (multi-chapter) and one-off `job`s.

   The engine is data-driven and save-safe: progress lives in state.story and old
   saves get it via the normal migrate() default. Objectives read persistent
   counters (s.stats.*, fleet, etc.), so a periodic pump from the game loop is all
   that's needed — no bespoke tracking per quest. Content is in STORYLINES at the
   bottom; add freely. Rewards are applied to LOCAL state (see note in grant()). */

const Story = {
  MAX_ACTIVE: 2,            // keep the inbox calm: at most N storylines mid-flight
  ARRIVAL_GAP_MS: 45_000,  // min real-time gap between new storyline arrivals
  INBOX_MAX: 60,
  TAX_PERMANENT: 8.64e15,  // sentinel "until" for a permanent break (JSON-safe, unlike Infinity)

  s() {
    const st = window.Game && window.Game.state; if (!st) return null;
    if (!st.story) st.story = { prog: {}, inbox: [], unread: 0, lastArrivalAt: 0, taxBreakPct: 0, taxBreakUntil: 0 };
    return st.story;
  },

  init() {
    // Objectives read persistent state, so the loop pump suffices; we also nudge
    // on key events so a finished objective lights up immediately.
    if (window.Bus) for (const ev of ["trade", "missionDone", "shipBuy", "unlock", "rep", "order", "dock"])
      Bus.on(ev, () => this.check(Date.now()));
  },

  // ---- trackable snapshot (baseline for "do N more X" delta objectives) ----
  snap(s) {
    return {
      trades: s.stats.trades || 0,
      contracts: s.stats.contractsDone || 0,
      ships: (s.ships || []).length,
      extractors: Object.keys(s.extractors || {}).length,
      components: Object.keys(s.components || {}).length,
      industries: (s.industries || []).length,
      systems: (s.unlockedSystems || []).length,
      credits: s.credits || 0,
      netWorth: window.Economy ? Math.round(Economy.netWorth()) : (s.credits || 0),
    };
  },

  storyline(id) { return STORYLINES.find(x => x.id === id) || null; },

  // ---- main pump (called from the game loop + key events) -----------------
  check(now = Date.now()) {
    const st = window.Game && window.Game.state; if (!st) return false;
    const story = this.s(); const prog = story.prog;
    let changed = false;

    // 1) advance any active auto-objective step whose goal is now met
    for (const id in prog) {
      const p = prog[id]; if (p.status !== "active") continue;
      const sl = this.storyline(id); if (!sl) continue;
      const step = sl.steps[p.step]; if (!step || step.choices) continue;   // choice steps wait for input
      if (step.goal && step.goal.done(st, p.base)) { this._complete(id, step.reward); changed = true; }
    }

    // 2) start one eligible new storyline (throttled so they never dump at once)
    const active = Object.values(prog).filter(p => p.status === "active").length;
    if (active < this.MAX_ACTIVE && now - (story.lastArrivalAt || 0) >= this.ARRIVAL_GAP_MS) {
      for (const sl of STORYLINES) {
        if (prog[sl.id]) continue;                         // already started or done
        if (typeof sl.trigger === "function" && !sl.trigger(st)) continue;
        prog[sl.id] = { step: 0, base: this.snap(st), status: "active" };
        this._postIn(sl, sl.steps[0]);
        story.lastArrivalAt = now;
        changed = true;
        break;                                             // one arrival per pump = paced drip
      }
    }
    if (changed && window.Game) window.Game.requestSave();
    return changed;
  },

  _complete(id, reward) {
    const st = window.Game.state; const sl = this.storyline(id); const p = this.s().prog[id];
    const sum = this.grant(reward, st);
    if (sum) this._postReward(sl, sum);
    this._advance(sl, p, null);
  },

  // Player taps a reply on a choice step.
  choose(id, idx) {
    const st = window.Game.state; const p = this.s().prog[id]; const sl = this.storyline(id);
    if (!p || !sl || p.status !== "active") return { ok: false };
    const step = sl.steps[p.step]; if (!step || !step.choices) return { ok: false };
    const ch = step.choices[idx]; if (!ch) return { ok: false };
    if (typeof ch.require === "function" && !ch.require(st)) return { ok: false, msg: ch.requireMsg || "You can't do that yet." };
    if (ch.cost && (st.credits || 0) < ch.cost) return { ok: false, msg: "Not enough credits." };
    if (ch.cost) st.credits -= ch.cost;
    this._postOut(sl, ch.reply || ch.label);
    const sum = this.grant(ch.reward, st);
    if (sum) this._postReward(sl, sum);
    this._advance(sl, p, ch);
    window.Game.requestSave();
    return { ok: true };
  },

  // Move a storyline to its next step, honoring choice branching (goto / end).
  _advance(sl, p, choice) {
    const st = window.Game.state;
    let next = p.step + 1;
    if (choice) { if (choice.end) next = sl.steps.length; else if (choice.goto != null) next = sl.steps.findIndex(x => x.key === choice.goto); }
    if (next >= 0 && next < sl.steps.length) { p.step = next; p.base = this.snap(st); this._postIn(sl, sl.steps[next]); }
    else { p.status = "done"; if (sl.outro) this._postReward(sl, sl.outro); }
  },

  // ---- rewards ------------------------------------------------------------
  // NOTE: rewards mutate LOCAL state (credits, fleet, storage, tax break). This
  // works fully for guest / offline play; for signed-in players the economic
  // fields are server-authoritative, so persistent server-side payout would need
  // a dedicated RPC — a deliberate follow-up, flagged rather than faked here.
  grant(reward, s) {
    if (!reward) return "";
    const bits = [];
    if (reward.credits) { s.credits += reward.credits; bits.push("+" + (window.Util ? Util.credits(reward.credits) : reward.credits)); }
    if (reward.ship && window.Fleet) {
      s.ships.push(Fleet.makeShip(reward.ship));
      const sc = SHIP_CATALOG.transport.concat(SHIP_CATALOG.escort, SHIP_CATALOG.main).find(x => x.id === reward.ship);
      bits.push("ship — " + (sc ? sc.name : reward.ship));
    }
    if (reward.component && window.Components) { const c = Components.acquire(Components.gen()); bits.push("component — " + c.name); }
    if (reward.extractor && window.Extractors) { const e = Extractors.acquire(Extractors.gen()); bits.push("extractor — " + e.name); }
    if (reward.item && window.Items) { const it = Items.gen(reward.item === true ? {} : { rarity: reward.item }); s.items[it.uid] = it; bits.push("gear — " + it.name); }
    if (reward.taxBreak) {
      const st = this.s(); const now = Date.now();
      st.taxBreakPct = Math.max(st.taxBreakPct || 0, reward.taxBreak.pct);
      st.taxBreakUntil = reward.taxBreak.ms ? now + reward.taxBreak.ms : this.TAX_PERMANENT;
      bits.push(`industry tax −${Math.round(reward.taxBreak.pct * 100)}%` + (reward.taxBreak.ms ? ` for ${Util.duration(reward.taxBreak.ms)}` : ""));
    }
    if (window.Economy && Economy.refreshNetWorth) Economy.refreshNetWorth();
    return bits.length ? "Reward: " + bits.join(" · ") : "";
  },

  // Active industry tax relief (fraction). Read by Industries.taxRate().
  taxRelief(now = Date.now()) { const st = this.s(); return (st && st.taxBreakUntil && now < st.taxBreakUntil) ? (st.taxBreakPct || 0) : 0; },

  // ---- inbox / view model -------------------------------------------------
  _push(m) {
    const st = this.s();
    m.id = "m" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    m.ts = m.ts || Date.now();
    st.inbox.push(m);
    if (st.inbox.length > this.INBOX_MAX) st.inbox = st.inbox.slice(-this.INBOX_MAX);
    const onComms = window.UI && UI.page === "comms";
    if (!onComms) { st.unread = (st.unread || 0) + 1; if (window.UI && UI.bumpComms) UI.bumpComms(); }
    if (window.Bus) Bus.emit("story", m);
    if (onComms && window.UI && UI.renderDispatches) UI.renderDispatches();
  },
  _postIn(sl, step) { this._push({ arc: sl.id, from: sl.from, portrait: sl.portrait, text: step.text, type: "in" }); },
  _postOut(sl, text) { this._push({ arc: sl.id, from: "You", portrait: null, text, type: "out" }); },
  _postReward(sl, text) { this._push({ arc: sl.id, from: sl.from, portrait: sl.portrait, text, type: "reward" }); },

  markRead() { const st = this.s(); if (st) st.unread = 0; },

  // Current actionable prompts (objectives in progress + open choices).
  activeGoals() {
    const st = window.Game && window.Game.state; const out = []; if (!st) return out;
    const prog = this.s().prog;
    for (const id in prog) {
      const p = prog[id]; if (p.status !== "active") continue;
      const sl = this.storyline(id); if (!sl) continue;
      const step = sl.steps[p.step]; if (!step) continue;
      if (step.goal) out.push({ arc: id, from: sl.from, kind: sl.kind, desc: step.goal.desc, done: !!step.goal.done(st, p.base) });
      else if (step.choices) out.push({ arc: id, from: sl.from, kind: sl.kind, choices: step.choices.map((c, i) => ({
        i, label: c.label, cost: c.cost || 0,
        ok: (typeof c.require !== "function" || c.require(st)) && (!c.cost || (st.credits || 0) >= c.cost),
      })) });
    }
    return out;
  },
  inbox() { const st = this.s(); return st ? st.inbox : []; },
};

/* ============================================================================
   STORYLINES — CONTENT. Add freely. Each storyline:
     id       unique key (also the save key)
     kind     "arc" (serialized, escalating) | "job" (one-off)
     from     sender name        portrait  index into assets/portraits
     trigger  (state) => bool — when it first arrives
     outro    optional sign-off posted when the storyline ends
     steps[]  each step is EITHER an objective or a choice:
       { key?, text, goal: { desc, done: (state, base) => bool }, reward }
       { key?, text, choices: [ { label, reply?, cost?, require?, reward?, goto?, end? } ] }
   `base` is a snapshot taken when the step began — use it for "do N MORE" goals.
   Reward fields: { credits, ship:<catalogId>, component:true, extractor:true,
                    item:true|"rare"|…, taxBreak:{ pct, ms? (omit = permanent) } }
   ========================================================================== */
const STORYLINES = [
  // Episodic onboarding job — arrives right after your first trade.
  {
    id: "first_contact", kind: "job", from: "Quartermaster Vel", portrait: 4,
    trigger: s => (s.stats.trades || 0) >= 1,
    outro: "Vel: “Knew you had it in you. The Guild's watching now.”",
    steps: [
      { text: "New blood on the exchange? The Guild rewards initiative. Turn a profit — push your net worth past 5,000 credits — and I'll wire you a starter kit.",
        goal: { desc: "Reach 5,000c net worth", done: s => (window.Economy ? Economy.netWorth() : s.credits) >= 5000 },
        reward: { credits: 1500, component: true } },
    ],
  },

  // Serialized arc — a shady benefactor who escalates toward a moral choice.
  {
    id: "broker", kind: "arc", from: "The Broker", portrait: 7,
    trigger: s => (s.stats.trades || 0) >= 4,
    outro: "The Broker: “Pleasure doing business. I'll be in touch when the stakes are higher.”",
    steps: [
      { key: "s1", text: "I read ledgers, Baron, and yours interests me. Prove it isn't luck — close three more trades — and the first cut is yours.",
        goal: { desc: "Complete 3 more trades", done: (s, b) => (s.stats.trades || 0) - b.trades >= 3 },
        reward: { credits: 6000, item: "rare" } },
      { key: "s2", text: "Respectable. But the black lanes chew up the unarmed. Put a real warship on your books and we'll talk bigger numbers.",
        goal: { desc: "Own an escort warship", done: s => (s.ships || []).some(sh => sh.cls === "escort") },
        reward: { credits: 4000, component: true } },
      { key: "s3", text: "Last thing. A… discreet shipment through Sable Reach. Customs looks the other way — for a friend. Are you in, or out?",
        choices: [
          { label: "Run it — for the payday", reply: "Send the coordinates.", reward: { credits: 12000, ship: "frigate", taxBreak: { pct: 0.10, ms: 30 * 60 * 1000 } }, end: true },
          { label: "Walk away — stay clean", reply: "Not my kind of cargo.", reward: { credits: 4000 }, end: true },
        ] },
    ],
  },

  // Episodic job — bootstraps the Industries loop with a free extractor.
  {
    id: "foundry_grant", kind: "job", from: "Foreman Dax", portrait: 2,
    trigger: s => (window.Economy ? Economy.netWorth() : s.credits) >= 15000,
    outro: "Dax: “Bring me ore and we'll both eat. Grant's yours — go build something.”",
    steps: [
      { text: "Navos needs feedstock and you've got the capital. Run two contracts to prove you deliver, and the Foundry will grant you an extractor to start your own works in Industries.",
        goal: { desc: "Complete 2 contracts", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 2 },
        reward: { extractor: true, credits: 3000 } },
    ],
  },
];

window.Story = Story;
window.STORYLINES = STORYLINES;
