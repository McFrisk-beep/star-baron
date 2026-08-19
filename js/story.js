/* story.js — "Dispatches": a lightweight story / quest layer surfaced in Comms.

   A contact messages you on a private channel; you either complete an OBJECTIVE
   (tracked automatically from live game state) or pick a REPLY (a branching
   choice); completing a step pays a REWARD — credits, a ship, a component, an
   extractor, an accessory, faction REP, or a temporary industry TAX BREAK.
   Storylines come in two flavors: serialized `arc`s (multi-chapter) and one-off
   `job`s. Choices / steps may `set` FLAGS on state.story.flags so a smuggle run
   today can make someone furious (or grateful) in a later dispatch.

   The engine is data-driven and save-safe: progress lives in state.story and old
   saves get it via the normal migrate() default. Objectives read persistent
   counters (s.stats.*, fleet, etc.), so a periodic pump from the game loop is all
   that's needed — no bespoke tracking per quest. Content is in STORYLINES at the
   bottom; add freely. Rewards are applied to LOCAL state (see note in grant()). */

const Story = {
  MAX_ACTIVE: 2,            // keep the inbox calm: at most N storylines mid-flight
  ARRIVAL_GAP_MS: 45_000,  // min real-time gap between new storyline arrivals
  MAX_CONTACTS: 30,        // mailbox keeps the 30 most-recently-active conversations
  INBOX_MAX: 300,          // hard message cap across all conversations (safety net)
  TAX_PERMANENT: 8.64e15,  // sentinel "until" for a permanent break (JSON-safe, unlike Infinity)

  s() {
    const st = window.Game && window.Game.state; if (!st) return null;
    if (!st.story) st.story = { prog: {}, inbox: [], unread: 0, lastArrivalAt: 0, taxBreakPct: 0, taxBreakUntil: 0, flags: {}, ephemeral: {} };
    st.story.flags ||= {};
    st.story.prog ||= {};
    st.story.inbox ||= [];
    st.story.ephemeral ||= {};
    return st.story;
  },

  // Cross-story memory. Truthy values stick; falsy clears the key.
  flag(k) { const f = this.s(); return !!(f && f.flags && f.flags[k]); },
  setFlags(obj) {
    if (!obj) return;
    const f = this.s(); if (!f) return;
    const flags = f.flags ||= {};
    for (const k of Object.keys(obj)) { if (obj[k]) flags[k] = true; else delete flags[k]; }
  },
  done(id) { const p = this.s() && this.s().prog[id]; return !!(p && p.status === "done"); },
  declined(id) { const p = this.s() && this.s().prog[id]; return !!(p && p.status === "declined"); },
  started(id) { return !!(this.s() && this.s().prog[id]); },

  init() {
    // Objectives read persistent state, so the loop pump suffices; we also nudge
    // on key events so a finished objective lights up immediately.
    if (window.Bus) for (const ev of ["trade", "missionDone", "shipBuy", "unlock", "rep", "order", "dock"])
      Bus.on(ev, () => this.check(Date.now()));
  },

  // ---- trackable snapshot (baseline for "do N more X" delta objectives) ----
  snap(s) {
    const out = {};
    for (const m of this.METRICS) out[m.id] = this.metricVal(m.id, s);
    return out;
  },

  // ---- data-driven conditions -------------------------------------------
  // Built-in storylines carry real trigger/goal functions; admin-authored
  // ones (STORY_CUSTOM) can't — functions don't survive JSON round-trips to
  // the cloud. So custom missions describe their gates declaratively as a
  // { metric, op, value, delta? } condition, evaluated here. METRICS is the
  // single source of truth: the admin editor builds its dropdowns from it,
  // snap() baselines every metric, and metricVal() reads them live.
  METRICS: [
    { id: "netWorth",   label: "Net worth" },
    { id: "credits",    label: "Credits (cash)" },
    { id: "trades",     label: "Trades completed" },
    { id: "contracts",  label: "Contracts completed" },
    { id: "ships",      label: "Ships owned" },
    { id: "escorts",    label: "Escort warships owned" },
    { id: "extractors", label: "Extractors owned" },
    { id: "components", label: "Components owned" },
    { id: "industries", label: "Industries owned" },
    { id: "systems",    label: "Systems unlocked" },
  ],
  metricVal(metric, s) {
    switch (metric) {
      case "netWorth":   return window.Economy ? Math.round(Economy.netWorth()) : (s.credits || 0);
      case "credits":    return s.credits || 0;
      case "trades":     return s.stats.trades || 0;
      case "contracts":  return s.stats.contractsDone || 0;
      case "ships":      return (s.ships || []).length;
      case "escorts":    return (s.ships || []).filter(sh => sh.cls === "escort").length;
      case "extractors": return Object.keys(s.extractors || {}).length;
      case "components": return Object.keys(s.components || {}).length;
      case "industries": return (s.industries || []).length;
      case "systems":    return (s.unlockedSystems || []).length;
      default:           return 0;
    }
  },
  // Evaluate one declarative condition. `delta` compares against the step's
  // baseline snapshot ("do N MORE"); absolute otherwise. A missing/blank
  // condition means "no gate" → true (defensive: custom data is a trust
  // boundary — never throw on a malformed row).
  evalCond(cond, s, base) {
    if (!cond || !cond.metric) return true;
    let cur = this.metricVal(cond.metric, s);
    if (cond.delta && base) cur -= (base[cond.metric] || 0);
    const target = +cond.value || 0;
    switch (cond.op) {
      case ">":  return cur >  target;
      case "<":  return cur <  target;
      case "<=": return cur <= target;
      case "==": return cur === target;
      default:   return cur >= target;   // ">=" is the sensible default
    }
  },
  // Trigger / goal / require may be a shipped function OR a custom condition.
  _trigger(sl, st)      { return typeof sl.trigger === "function" ? sl.trigger(st) : this.evalCond(sl.triggerCond, st, null); },
  _goalDone(step, st, base) { const g = step.goal; if (!g) return true; return typeof g.done === "function" ? g.done(st, base) : this.evalCond(g.cond, st, base); },
  _reqOk(ch, st)        { return typeof ch.require === "function" ? ch.require(st) : this.evalCond(ch.cond, st, null); },

  // Built-in + admin-authored + ephemeral survey debriefs. Custom rows are
  // validated here (cloud trust boundary): only well-formed entries survive,
  // and a custom id can never shadow a shipped one.
  all() {
    const ids = new Set(STORYLINES.map(s => s.id));
    const custom = (window.STORY_CUSTOM || []).filter(sl =>
      sl && sl.id && !ids.has(sl.id) && Array.isArray(sl.steps) && sl.steps.length);
    const eph = Object.values(this.s().ephemeral || {}).filter(sl => sl && sl.id && Array.isArray(sl.steps));
    return STORYLINES.concat(custom, eph);
  },
  storyline(id) {
    const raw = this.all().find(x => x.id === id) || null;
    return raw ? this._withOverrides(raw) : null;
  },

  // Admin text overlays (STORY_OVERRIDES) — keep built-in functions, swap copy.
  _withOverrides(sl) {
    const o = (window.STORY_OVERRIDES || {})[sl.id];
    if (!o) return sl;
    const out = Object.assign({}, sl);
    if (o.from != null && o.from !== "") out.from = o.from;
    if (o.outro != null) out.outro = o.outro;
    out.steps = (sl.steps || []).map((step, i) => {
      const key = step.key || String(i);
      const os = (o.steps && (o.steps[key] || o.steps[String(i)])) || null;
      if (!os) return step;
      const merged = Object.assign({}, step);
      if (os.text != null) merged.text = os.text;
      if (os.replies) merged.replies = os.replies;
      if (os.goal && step.goal) merged.goal = Object.assign({}, step.goal, { desc: os.goal.desc != null ? os.goal.desc : step.goal.desc });
      if (os.accept && step.accept) merged.accept = Object.assign({}, step.accept, os.accept);
      if (os.decline && step.decline) merged.decline = Object.assign({}, step.decline, os.decline);
      if (os.choices && step.choices) {
        merged.choices = step.choices.map((c, ci) => {
          const oc = os.choices[ci]; if (!oc) return c;
          return Object.assign({}, c, {
            label: oc.label != null ? oc.label : c.label,
            reply: oc.reply != null ? oc.reply : c.reply,
            ack: oc.ack != null ? oc.ack : c.ack,
          });
        });
      }
      if (os.continue && step.continue) merged.continue = Object.assign({}, step.continue, os.continue);
      return merged;
    });
    return out;
  },

  // ---- main pump (called from the game loop + key events) -----------------
  check(now = Date.now()) {
    const st = window.Game && window.Game.state; if (!st) return false;
    const story = this.s(); const prog = story.prog;
    let changed = false;

    // 1) advance any active auto-objective step whose goal is now met
    for (const id in prog) {
      const p = prog[id]; if (p.status !== "active") continue;
      const sl = this.storyline(id); if (!sl) continue;
      const step = sl.steps[p.step]; if (!step) continue;
      if (step.choices || (step.options && !step.goal)) continue;   // choice steps wait for input
      if (step.accept && !p.accepted) continue;                     // job not accepted yet — don't track
      if (step.goal && this._goalDone(step, st, p.base)) { this._complete(id, step.reward); changed = true; }
    }

    // 2) start one eligible new storyline (throttled so they never dump at once).
    // Survey / mission-report debriefs are force-opened and don't consume MAX_ACTIVE.
    const active = Object.keys(prog).filter(id => {
      if (prog[id].status !== "active") return false;
      const sl = this.storyline(id);
      // Unresolvable (admin deleted the mission, ephemeral row lost): step 1
      // above skips it, so it can never complete. Counting it wedges the slot
      // forever and new dispatches silently stop.
      if (!sl) return false;
      return !(sl._survey || sl._missionReport);
    }).length;
    if (active < this.MAX_ACTIVE && now - (story.lastArrivalAt || 0) >= this.ARRIVAL_GAP_MS) {
      for (const sl of this.all()) {
        if (sl._survey || sl._missionReport) continue;     // ephemeral threads opened by Missions / Expeditions
        if (prog[sl.id]) continue;                         // already started or done
        if (!this._trigger(sl, st)) continue;
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
    const step = sl && sl.steps[p.step];
    if (step && step.set) this.setFlags(step.set);
    if (reward && reward.set) this.setFlags(reward.set);
    const sum = this.grant(reward, st);
    if (sum) this._postReward(sl, sum);
    // Objective steps may `end` / `goto` like choices (branching penance forks, etc.).
    this._advance(sl, p, (step && (step.end || step.goto != null)) ? step : null);
  },

  // Player taps a reply on a choice step. May return a Promise when a survey
  // debrief hits Phase 3 app_survey_debrief (async ledger).
  choose(id, idx) {
    const st = window.Game.state; const p = this.s().prog[id]; const sl = this.storyline(id);
    if (!p || !sl || p.status !== "active") return { ok: false };
    const step = sl.steps[p.step]; const list = step && (step.choices || step.options); if (!list) return { ok: false };
    const ch = list[idx]; if (!ch) return { ok: false };
    if (!this._reqOk(ch, st)) return { ok: false, msg: ch.requireMsg || "You can't do that yet." };
    // Paid branches: when the cloud ledger owns credits, the debit would stick
    // (app_commit accepts decreases) while the promised credit/item/rep reward
    // is reverted by the next server slice — a guaranteed net loss. Until an
    // app_story_grant RPC delivers rewards server-side, don't charge either:
    // the bribe/donation happens narratively, the wallet stays untouched.
    // ponytail: charge cost inside the story RPC once rewards persist online.
    const ledgerLocal = this._ledgerLocal();
    if (ch.cost && ledgerLocal) {
      if ((st.credits || 0) < ch.cost) return { ok: false, msg: "Not enough credits." };
      st.credits -= ch.cost;
    }
    this._postOut(sl, ch.reply || ch.label);

    const afterGrant = (sum, advanceTo) => {
      if (sum && typeof sum.then === "function") {
        return sum.then(s => {
          if (s) this._postReward(sl, s);
          this._advance(sl, p, advanceTo);
          window.Game.requestSave();
          return { ok: true };
        });
      }
      if (sum) this._postReward(sl, sum);
      this._advance(sl, p, advanceTo);
      window.Game.requestSave();
      return { ok: true };
    };

    // Risky survey (etc.) choices: roll chance, then success/fail acks + rewards.
    if (ch.chance != null) {
      const okRoll = Math.random() < +ch.chance;
      if (okRoll) {
        if (ch.ack) this._postIn(sl, { text: ch.ack });
        if (ch.set) this.setFlags(ch.set);
        return afterGrant(this.grant(ch.reward, st), ch.success || ch);
      }
      if (ch.failAck) this._postIn(sl, { text: ch.failAck });
      else if (ch.ack) this._postIn(sl, { text: ch.ack });
      if (ch.failSet) this.setFlags(ch.failSet);
      return afterGrant(this.grant(ch.failReward || ch.reward, st), ch.fail || { end: true });
    }

    if (ch.ack) this._postIn(sl, { text: ch.ack });
    if (ch.set) this.setFlags(ch.set);
    return afterGrant(this.grant(ch.reward, st), ch);
  },

  // Move a storyline to its next step, honoring choice branching (goto / end).
  _advance(sl, p, choice) {
    const st = window.Game.state;
    let next = p.step + 1;
    if (choice) { if (choice.end) next = sl.steps.length; else if (choice.goto != null) next = sl.steps.findIndex(x => x.key === choice.goto); }
    if (next >= 0 && next < sl.steps.length) { p.step = next; p.base = this.snap(st); p.accepted = false; p.replied = false; this._postIn(sl, sl.steps[next]); }
    else {
      p.status = "done";
      delete p.base;          // the delta baseline is dead once nothing tracks it
      if (sl.outro) this._postReward(sl, sl.outro);
      // Drop ephemeral survey / mission-report threads once finished (save bloat).
      if ((sl._survey || sl._missionReport) && this.s().ephemeral) delete this.s().ephemeral[sl.id];
    }
  },

  // ---- rewards ------------------------------------------------------------
  // NOTE: rewards mutate LOCAL state (credits, fleet, storage, tax break). This
  // works fully for guest / offline play; for signed-in players the economic
  // fields are server-authoritative — a local grant of credits/ships/items/rep
  // is silently reverted by the next app_commit slice. Rather than fake a
  // payout that evaporates seconds later, skip those grants and say so; flags,
  // blueprints and tax breaks live on client-owned keys and still stick.
  // ponytail: an app_story_grant RPC (server-side reward catalog) re-enables
  // the volatile grants for signed-in players.
  _ledgerLocal() { return !(window.Economy && Economy.softIncomeLocal && !Economy.softIncomeLocal()); },
  grant(reward, s) {
    if (!reward) return "";
    const bits = [];
    const ledgerLocal = this._ledgerLocal();
    let withheld = false;
    if (reward.credits) {
      if (ledgerLocal) { s.credits += reward.credits; bits.push("+" + (window.Util ? Util.credits(reward.credits) : reward.credits)); }
      else withheld = true;
    }
    if (reward.ship && window.Fleet) {
      if (ledgerLocal) {
        s.ships.push(Fleet.makeShip(reward.ship));
        const sc = SHIP_CATALOG.transport.concat(SHIP_CATALOG.escort, SHIP_CATALOG.main).find(x => x.id === reward.ship);
        bits.push("ship — " + (sc ? sc.name : reward.ship));
      } else withheld = true;
    }
    if (reward.component && window.Components) {
      if (ledgerLocal) { const c = Components.acquire(Components.gen()); bits.push("component — " + c.name); }
      else withheld = true;
    }
    if (reward.extractor && window.Extractors) {
      if (ledgerLocal) { const e = Extractors.acquire(Extractors.gen()); bits.push("extractor — " + e.name); }
      else withheld = true;
    }
    if (reward.item && window.Items) {
      if (ledgerLocal) { const it = Items.gen(reward.item === true ? {} : { rarity: reward.item }); s.items[it.uid] = it; bits.push("gear — " + it.name); }
      else withheld = true;
    }
    if (reward.blueprint && window.Workshop) {
      const gr = Workshop.grantBlueprint(reward.blueprint);
      if (gr.ok) bits.push("blueprint — " + ((gr.blueprint && gr.blueprint.name) || reward.blueprint));
    }
    if (reward.taxBreak) {
      const st = this.s(); const now = Date.now();
      st.taxBreakPct = Math.max(st.taxBreakPct || 0, reward.taxBreak.pct);
      st.taxBreakUntil = reward.taxBreak.ms ? now + reward.taxBreak.ms : this.TAX_PERMANENT;
      bits.push(`industry tax −${Math.round(reward.taxBreak.pct * 100)}%` + (reward.taxBreak.ms ? ` for ${Util.duration(reward.taxBreak.ms)}` : ""));
    }
    // Faction standing nudge (can be negative — smuggle now, League later).
    // Rep is server-owned too (app_commit forces it), so it joins the withheld set.
    if (reward.rep && window.Rep && typeof reward.rep === "object" && !Array.isArray(reward.rep)) {
      if (ledgerLocal) {
        for (const f of Object.keys(reward.rep)) {
          const d = +reward.rep[f] || 0; if (!d) continue;
          Rep.change(f, d);
          const name = (window.FACTIONS && FACTIONS[f] && FACTIONS[f].name) || f;
          bits.push(`${name} ${d > 0 ? "+" : ""}${d}`);
        }
      } else withheld = true;
    }
    if (withheld) bits.push("(material spoils lost in transit — story payouts reach the cloud ledger in a later phase)");
    if (reward.set) this.setFlags(reward.set);
    // Survey debrief payout (Dispatches mini-story) — summary is the whole line.
    // May return a Promise when Phase 3 app_survey_debrief is live.
    if (reward._survey && window.SurveyStory) {
      const summary = SurveyStory.applyOutcome(reward._survey);
      const finish = s => {
        if (window.Economy && Economy.refreshNetWorth) Economy.refreshNetWorth();
        return s || (bits.length ? "Reward: " + bits.join(" · ") : "");
      };
      return (summary && typeof summary.then === "function") ? summary.then(finish) : finish(summary);
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
    // your own lines read themselves; an inbound is read only if you're already
    // looking at that conversation, otherwise it lights the mailbox.
    m.read = (m.type === "out") || (window.UI && UI.page === "comms" && UI.commsTab === "dispatches" && UI._dispatchArc === m.arc);
    st.inbox.push(m);
    this._pruneContacts();
    if (st.inbox.length > this.INBOX_MAX) st.inbox = st.inbox.slice(-this.INBOX_MAX);
    if (!m.read && window.UI) {
      if (UI.page !== "comms" && UI.bumpComms) UI.bumpComms();
      else if (UI.page === "comms" && UI.commsTab !== "dispatches" && UI.pingCommsTab) UI.pingCommsTab("dispatches");
    }
    this._recountUnread();
    if (window.Bus) Bus.emit("story", m);
    if (window.UI && UI.page === "comms" && UI.commsTab === "dispatches" && UI.renderDispatches) UI.renderDispatches();
  },
  _postIn(sl, step) { this._push({ arc: sl.id, from: sl.from, portrait: sl.portrait, text: step.text, type: "in" }); },
  _postOut(sl, text) { this._push({ arc: sl.id, from: "You", portrait: null, text, type: "out" }); },
  _postReward(sl, text) { this._push({ arc: sl.id, from: sl.from, portrait: sl.portrait, text, type: "reward" }); },

  // Keep only the 30 most-recently-active conversations (drop whole threads).
  _pruneContacts() {
    const st = this.s(); const lastTs = {};
    for (const m of st.inbox) lastTs[m.arc] = Math.max(lastTs[m.arc] || 0, m.ts);
    const arcs = Object.keys(lastTs);
    if (arcs.length <= this.MAX_CONTACTS) return;
    const keep = new Set(arcs.sort((a, b) => lastTs[b] - lastTs[a]).slice(0, this.MAX_CONTACTS));
    st.inbox = st.inbox.filter(m => keep.has(m.arc));
  },
  _recountUnread() { const st = this.s(); st.unread = st.inbox.filter(m => !m.read && m.type !== "out").length; },
  markRead() { this._recountUnread(); },   // opening Comms clears the numeric badge; per-thread dots persist

  // Mark one conversation read (called when you open its thread).
  openConversation(arc) {
    const st = this.s(); for (const m of st.inbox) if (m.arc === arc) m.read = true;
    this._recountUnread();
  },

  // ---- mailbox view models ------------------------------------------------
  // One row per conversation, newest first, capped at MAX_CONTACTS.
  conversations() {
    const st = this.s(); const byArc = {};
    for (const m of st.inbox) (byArc[m.arc] || (byArc[m.arc] = [])).push(m);
    const rows = Object.keys(byArc).map(arc => {
      const msgs = byArc[arc]; const last = msgs[msgs.length - 1];
      const sl = this.storyline(arc); const p = this.s().prog[arc];
      const sv = (p && p.status === "active") ? this.stepView(arc) : { type: (p && p.status) || "done" };
      return {
        arc, from: sl ? sl.from : last.from, portrait: sl ? sl.portrait : last.portrait,
        kind: sl ? sl.kind : "job", ts: last.ts, snippet: last.text,
        unread: msgs.filter(m => !m.read && m.type !== "out").length,
        status: p ? p.status : "done",
        action: !!(sv && (sv.type === "gate" || sv.type === "choice" || (sv.type === "objective" && !sv.done))),
      };
    });
    rows.sort((a, b) => b.ts - a.ts);
    return rows.slice(0, this.MAX_CONTACTS);
  },
  thread(arc) { return this.s().inbox.filter(m => m.arc === arc); },

  // The current interactive prompt for a conversation: an accept/decline GATE,
  // an in-progress OBJECTIVE, a branching CHOICE — each may also offer flavor
  // REPLIES (pure colour). Returns null when the storyline has ended.
  stepView(arc) {
    const st = window.Game && window.Game.state; const p = this.s().prog[arc]; const sl = this.storyline(arc);
    if (!st || !p || !sl) return null;
    if (p.status !== "active") return { type: "done", status: p.status };
    const step = sl.steps[p.step]; if (!step) return { type: "done", status: "done" };
    const replies = (!p.replied && step.replies) ? step.replies.map((r, i) => ({ i, label: typeof r === "string" ? r : r.label })) : [];
    const choices = step.choices || (step.options && !step.goal ? step.options : null);
    if (choices) return {
      type: "choice", replies, from: sl.from, kind: sl.kind,
      buttons: choices.map((c, i) => ({ i, label: c.label, cost: c.cost || 0,
        ok: this._reqOk(c, st) && (!c.cost || (st.credits || 0) >= c.cost) })),
    };
    if (step.goal) {
      if (step.accept && !p.accepted) return {
        type: "gate", from: sl.from, kind: sl.kind, desc: step.goal.desc, replies,
        accept: { label: (step.accept.label) || "Accept" },
        decline: step.decline ? { label: step.decline.label || "Decline" } : null,
      };
      return { type: "objective", from: sl.from, kind: sl.kind, desc: step.goal.desc, done: !!this._goalDone(step, st, p.base), replies };
    }
    // Dialogue beat with no objective — player Continues (and may banter via replies).
    return { type: "info", from: sl.from, kind: sl.kind, replies,
      continueLabel: (step.continue && step.continue.label) || "Continue" };
  },

  // Single dispatcher for every dialog button the UI renders.
  act(arc, action) {
    const st = window.Game.state; const p = this.s().prog[arc]; const sl = this.storyline(arc);
    if (!p || !sl || p.status !== "active") return { ok: false };
    const step = sl.steps[p.step]; if (!step) return { ok: false };
    if (action === "accept") {
      if (!step.accept || p.accepted) return { ok: false };
      p.accepted = true; p.base = this.snap(st);           // (re)baseline delta goals at accept time
      this._postOut(sl, step.accept.reply || "Understood. I'm in.");
      if (step.accept.ack) this._postIn(sl, { text: step.accept.ack });
      if (step.accept.set) this.setFlags(step.accept.set);
      window.Game.requestSave(); return { ok: true };
    }
    if (action === "decline") {
      if (!step.decline) return { ok: false };
      this._postOut(sl, step.decline.reply || "I'll pass.");
      if (step.decline.ack) this._postIn(sl, { text: step.decline.ack });
      if (step.decline.set) this.setFlags(step.decline.set);
      if (step.decline.reward) {
        const sum = this.grant(step.decline.reward, st);
        if (sum) this._postReward(sl, sum);
      }
      if (step.decline.goto != null || step.decline.end) this._advance(sl, p, step.decline);
      else { p.status = "declined"; if (step.decline.outro) this._postReward(sl, step.decline.outro); }
      window.Game.requestSave(); return { ok: true };
    }
    if (action === "continue") {
      // Info beat: no goal / no branching choices. Advances the thread.
      if (step.goal || step.choices || (step.options && !step.goal)) return { ok: false };
      if (step.continue && step.continue.reply) this._postOut(sl, step.continue.reply);
      if (step.set) this.setFlags(step.set);
      if (step.continue && step.continue.set) this.setFlags(step.continue.set);
      this._advance(sl, p, step.continue || null);
      window.Game.requestSave(); return { ok: true };
    }
    if (action.startsWith("choice:")) return this.choose(arc, +action.slice(7));
    if (action.startsWith("reply:")) {
      const r = step.replies && step.replies[+action.slice(6)]; if (r == null) return { ok: false };
      this._postOut(sl, typeof r === "string" ? r : (r.reply || r.label));
      p.replied = true;
      if (typeof r === "object" && r.ack) this._postIn(sl, { text: r.ack });
      if (typeof r === "object" && r.set) this.setFlags(r.set);
      window.Game.requestSave(); return { ok: true };
    }
    return { ok: false };
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
     steps[]  objective, choice, or info (Continue) beats:
       objective  { key?, text, goal, reward?, accept?, decline?, replies?, set? }
       choice     { key?, text, choices: [{ label, reply?, ack?, cost?, require?,
                    reward?, set?, goto?, end? }], replies? }
       info       { key?, text, continue?: { label?, reply?, goto?, end? }, set?, replies? }
   Flags: choice/accept/decline/continue/step/reward may `set: { flag: true }`.
   Later triggers read Story.flag("x") / Story.done("id"). That's how a smuggle
   run today makes Customs furious next week.
   Reward fields: { credits, ship, component, extractor, item, blueprint, taxBreak, rep:{faction:Δ}, set }
   ========================================================================== */
const STORYLINES = [

  // ── Early Guild hook ────────────────────────────────────────────────────
  {
    id: "first_contact", kind: "job", from: "Quartermaster Vel", portrait: 4,
    trigger: s => (s.stats.trades || 0) >= 1,
    outro: "Vel: “Knew you had it in you. The Guild's watching now.”",
    steps: [
      { text: "Channel open. You're new on the boards and the Guild still pretends to care about new blood. Push your net worth past 5,000 and I'll wire a starter kit. Interested — or are you just noise on the tape?",
        accept: { label: "Accept the job", reply: "I'm listening. What's the target?", ack: "Good. Net worth past 5,000. Don't make me look soft for vouching.", set: { vel_accepted: true } },
        decline: { label: "Not now", reply: "Maybe later.", ack: "Suit yourself. The offer cools fast out here.", set: { vel_declined: true }, outro: "Vel: “The Guild has a long memory for people who waste its time.”" },
        goal: { desc: "Reach 5,000c net worth", done: s => (window.Economy ? Economy.netWorth() : s.credits) >= 5000 },
        reward: { credits: 1500, component: true },
        replies: [
          { label: "Who is the Guild, really?", reply: "Who backs the Guild?", ack: "Traders who got rich enough to write the rules. Then pretended the rules were natural law." },
          "5K? Easy money.",
        ] },
    ],
  },

  // Pure dialogue — world texture, no payout. Sets a tiny flag for later.
  {
    id: "dock_philosopher", kind: "job", from: "Skipper Juno", portrait: 1,
    trigger: s => (s.stats.trades || 0) >= 2 && !Story.started("dock_philosopher"),
    outro: "Juno: “Fly ugly. Die rich. Or the other way round — the lanes don't care.”",
    steps: [
      { text: "You the new baron on Navos? Don't look like much. Neither did I, before the belt took three fingers and gave me a hold full of regrets.",
        continue: { label: "Go on…" },
        replies: ["I've heard worse openers.", { label: "What do you want?", reply: "If this is a pitch, spit it out.", ack: "Not a pitch. A warning dressed as small talk." }] },
      { text: "Listen. Out here the exchange isn't a market — it's a weather system. Barons seed storms so the small hulls drown. The Senate votes theatre. The factions smile with knives. You climbing? Fine. Just know the view from the top is other people's wreckage.",
        choices: [
          { label: "I'll climb anyway", reply: "Then I'll climb. Wreckage and all.", ack: "Ha. Honest. Rare. Keep an eye on Sable Reach — storms brew pretty there.", set: { juno_climber: true }, end: true },
          { label: "Sounds like cope", reply: "Sounds like someone who quit climbing.", ack: "Maybe. Or maybe I learned the ladder was greased. Your funeral, kid.", set: { juno_dismissed: true }, end: true },
          { label: "Buy her a drink (500c)", reply: "Let me buy the next round. Talk more.", cost: 500, ack: "…Alright. One drink. Name's Juno. If you ever need a quiet lane past Helix's inspectors, you ask. Quietly.", set: { juno_friend: true }, end: true },
        ] },
    ],
  },

  // ── Overarching vibe arc: the market as throne ──────────────────────────
  {
    id: "quiet_ladder", kind: "arc", from: "The Ledger", portrait: 0,
    trigger: s => (s.stats.trades || 0) >= 3,
    outro: "The Ledger: “The books remain open. So do the knives.”",
    steps: [
      { key: "l0", text: "You have begun to leave ink on the boards. I am The Ledger. I do not sell tips. I narrate consequences. Reply when you are ready to hear what this game actually is.",
        choices: [
          { label: "I'm listening", reply: "Speak.", ack: "Good. Most barons only listen to price.", goto: "l1" },
          { label: "Who are you?", reply: "A name would help.", ack: "Names are for people who can still be sued. Call me a margin note in your empire.", goto: "l1" },
        ],
        replies: [{ label: "Is this a scam?", reply: "If this is a shakedown, say so.", ack: "If I wanted your credits, I would already have them." }] },
      { key: "l1", text: "Cosmocrat is not a victory screen. It is a tax bracket with a crown. Every tier above Baron — Magnate, Tycoon, Oligarch — buys a louder title and a hungrier revenue service. The house always raises the vig on winners. That is the vibe. Prove you can still breathe under it: grow past 12,000 net.",
        goal: { desc: "Reach 12,000c net worth", done: s => (window.Economy ? Economy.netWorth() : s.credits) >= 12000 },
        reward: { credits: 2000 },
        replies: [
          { label: "Why tell me this?", reply: "Why warn a stranger?", ack: "Because strangers become Cosmocrats. Or corpses with ticker symbols." },
        ] },
      { key: "l2", text: "Four banners carve the sky: Mining Combine (ore & gas), Agri-Collective (grain & luxury), Free-Trade League (chips & 'law'), The Syndicate (everything the League pretends not to sell). Help one, bruise its rival. That is not politics. That is the order book wearing a flag.",
        choices: [
          { label: "I'll pick a side eventually", reply: "I'll choose when it pays.", ack: "Transactional. The lanes respect that more than speeches.", set: { ledger_pragmatist: true }, goto: "l3" },
          { label: "I'll play all four", reply: "I don't kneel. I arbitrage.", ack: "Ambitious. The Senate loves ambitious fools — they fund elections.", set: { ledger_arbitrageur: true }, goto: "l3" },
          { label: "Law first — League", reply: "Someone has to keep the lanes clean.", ack: "The League's cleanliness is a product. Margins excellent.", set: { ledger_lawful: true }, goto: "l3" },
        ] },
      { key: "l3", text: "Next lesson needs dirt under the nails. Run a contract — any contract — and watch how quickly 'reputation' becomes a discount coupon with blood on it.",
        goal: { desc: "Complete 1 contract", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 1 },
        reward: { credits: 2500, item: true },
        replies: ["Contracts I can do.", { label: "Blood?", reply: "Blood on a coupon?", ack: "Ask anyone who failed a smuggle run. Ask their ship." }] },
      { key: "l4", text: "You felt it. Good. Now the quiet part: the Star Map is not exploration — it is enclosure. Permits. Extractors. Taxes. Barons who only flip commodities are tourists. Barons who own the rock under the commodity write history. Plant a flag: own an industry, or at least unlock another system.",
        goal: { desc: "Own 1 industry OR unlock 2+ systems",
          done: s => (s.industries || []).length >= 1 || (s.unlockedSystems || []).length >= 2 },
        reward: { credits: 4000, component: true },
        replies: [{ label: "Enclosure?", reply: "Harsh word for development.", ack: "Development is what winners call enclosure after the deed is filed." }] },
      { key: "l5", text: "Final note for this chapter. The rival barons on your board are not NPCs. They are the weather forecast. They compound while you sleep. The chat feed lies for sport. The Senate passes edicts that bite your hulls. And somewhere above 'Potentate' the title Cosmocrat waits — not as glory, as gravity. How do you intend to wear it?",
        choices: [
          { label: "As a builder", reply: "I'll build until the map has my name on it.", ack: "Then the Combine and Collective will court you. The Syndicate will meter your shadow.", set: { path_builder: true }, reward: { credits: 3000 }, end: true },
          { label: "As a predator", reply: "I'll eat the board before it eats me.", ack: "Then watch Customs. Predators leave heat-signatures.", set: { path_predator: true }, reward: { credits: 3000, item: "rare" }, end: true },
          { label: "As a ghost", reply: "I'll take the money and leave no speech.", ack: "Rare honesty. Ghosts survive Senate seasons. Remember that when the Ledger writes again.", set: { path_ghost: true }, reward: { credits: 3000, taxBreak: { pct: 0.05, ms: 45 * 60 * 1000 } }, end: true },
        ] },
    ],
  },

  // ── Broker arc (flags feed later payoffs) ───────────────────────────────
  {
    id: "broker", kind: "arc", from: "The Broker", portrait: 7,
    trigger: s => (s.stats.trades || 0) >= 4,
    outro: "The Broker: “Pleasure doing business. The lanes remember who flinched.”",
    steps: [
      { key: "s1", text: "I read ledgers, Baron, and yours interests me. Prove it isn't luck — close three more trades — and the first cut is yours.",
        goal: { desc: "Complete 3 more trades", done: (s, b) => (s.stats.trades || 0) - b.trades >= 3 },
        reward: { credits: 6000, item: "rare" },
        replies: [
          { label: "Who are you, exactly?", reply: "Who am I talking to?", ack: "A friend with liquidity. That's all you need — until you need more." },
          "Three trades. Watch me.",
        ] },
      { key: "s2", text: "Respectable. But the black lanes chew up the unarmed. Put a real warship on your books and we'll talk bigger numbers.",
        goal: { desc: "Own an escort warship", done: s => (s.ships || []).some(sh => sh.cls === "escort") },
        reward: { credits: 4000, component: true },
        replies: ["Already shopping.", { label: "Why the muscle?", reply: "Expecting trouble?", ack: "Always. It's why I'm still breathing." }] },
      { key: "s3", text: "Last thing. A discreet shipment through Sable Reach — pharmaceutical precursors the League calls 'contraband' and the belt calls 'Tuesday.' Customs looks the other way for a friend. In, or out?",
        choices: [
          { label: "Run it — for the payday", reply: "Send the coordinates.",
            ack: "Coordinates burned to your nav. If Helix's inspectors sniff this, you never knew me.",
            set: { broker_smuggle: true, heat_customs: true },
            reward: { credits: 12000, ship: "frigate", taxBreak: { pct: 0.10, ms: 30 * 60 * 1000 }, rep: { syndicate: 8, free_trade: -6 } }, end: true },
          { label: "Walk away — stay clean", reply: "Not my kind of cargo.",
            ack: "Pity. Clean hands photograph well. They also starve in a downturn.",
            set: { broker_clean: true, league_favor: true },
            reward: { credits: 4000, rep: { free_trade: 4 } }, end: true },
          { label: "Tip Customs anonymously", reply: "I'll pass — and maybe Customs should hear about your lane.",
            ack: "…Bold. Stupid. Occasionally profitable. Don't sleep near airlocks.",
            set: { broker_betrayed: true, heat_syndicate: true },
            reward: { credits: 2000, rep: { free_trade: 10, syndicate: -12 } }, end: true },
        ] },
    ],
  },

  {
    id: "foundry_grant", kind: "job", from: "Foreman Dax", portrait: 2,
    trigger: s => (window.Economy ? Economy.netWorth() : s.credits) >= 15000,
    outro: "Dax: “Bring me ore and we'll both eat. Grant's yours — go build something.”",
    steps: [
      { text: "Navos Foundry speaking. We need feedstock and you've got capital. The Combine loves barons who dig. Run two contracts to prove you deliver, and we'll grant an extractor so you can open works on the Star Map. Deal?",
        accept: { label: "Take the grant", reply: "I'll run your contracts.", ack: "Two contracts. Then the rig is yours. Don't plant it on a Collective world unless you like paperwork wars.", set: { dax_deal: true } },
        decline: { label: "Pass for now", reply: "Not my line of work.", set: { dax_declined: true }, outro: "Dax: “Fair enough. Ore doesn't haul itself, though.”" },
        goal: { desc: "Complete 2 contracts", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 2 },
        reward: { extractor: true, credits: 3000, rep: { mining_combine: 5 } },
        replies: [
          { label: "What's the catch?", reply: "Gratis extractors make me nervous.", ack: "Catch is tax. Catch is permits. Catch is every rival smelling fresh yield." },
        ] },
    ],
  },

  // ── Consequence: smuggle → Customs heat ─────────────────────────────────
  {
    id: "customs_audit", kind: "arc", from: "Inspector Helix", portrait: 8,
    trigger: s => Story.flag("heat_customs") && (window.Economy ? Economy.netWorth() : s.credits) >= 25000,
    outro: "Helix: “The League's memory is longer than your warp trail.”",
    steps: [
      { key: "h0", text: "Free-Trade League Customs. Inspector Helix. A shipment matching your silhouette slipped Sable Reach without a seal. Amusing coincidence — or a confession waiting to happen?",
        choices: [
          { label: "Deny everything", reply: "I haul licensed goods. Check the manifests.", ack: "Manifests can be poetry. Fine. Prove your 'virtue' on the open market.", goto: "h1" },
          { label: "Bribe her (8,000c)", reply: "Perhaps we can settle this quietly.", cost: 8000,
            ack: "…Credits received. This buys silence, not affection. The Syndicate still owes you a shadow.",
            set: { helix_bribed: true }, reward: { rep: { free_trade: -2 } }, goto: "h_bribe" },
          { label: "Confess & cooperate", reply: "It was a one-time favor. I'll cooperate.",
            ack: "Cooperation noted. The League loves penitents who still have liquidity.",
            set: { helix_cooperated: true }, goto: "h2" },
        ],
        replies: [{ label: "Jurisdiction?", reply: "What authority do you have on my channel?", ack: "Enough to freeze a docking bay. Smile less." }] },
      { key: "h1", text: "Then be useful. Move clean tech volume — three more trades — while my auditors watch. Slip once and I reclassify you as Syndicate-adjacent. Permanently, in the ways that matter.",
        goal: { desc: "Complete 3 more trades", done: (s, b) => (s.stats.trades || 0) - b.trades >= 3 },
        reward: { credits: 3000, rep: { free_trade: 6 }, set: { helix_cleared: true } },
        end: true,
        replies: ["You'll get your trades."] },
      { key: "h_bribe", text: "One more thing, since we're intimate now. A League courier is light on escort through the belt. Keep it breathing and I'll misfile last month's anomaly.",
        goal: { desc: "Complete 1 contract", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 1 },
        reward: { credits: 5000, rep: { free_trade: 3 }, set: { helix_cleared: true } },
        end: true },
      { key: "h2", text: "Penance is practical. Deliver two contracts under League eyes. Do that and I downgrade you from 'suspect' to 'useful idiot.' That's a promotion, out here.",
        goal: { desc: "Complete 2 contracts", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 2 },
        reward: { credits: 6000, item: "rare", rep: { free_trade: 8, syndicate: -4 }, set: { helix_cleared: true } },
        end: true },
    ],
  },

  // Consequence: stayed clean → League soft open
  {
    id: "league_voucher", kind: "job", from: "Inspector Helix", portrait: 8,
    trigger: s => Story.flag("broker_clean") && !Story.flag("heat_customs") && (s.stats.trades || 0) >= 8,
    outro: "Helix: “Stay boring. Boring barons die of old age.”",
    steps: [
      { text: "Helix again — softer channel. Word is you refused a Sable Reach gray-haul. The League notices abstinence when abstinence is expensive. Want a voucher? Move some legitimate volume and we'll shave your next headaches.",
        accept: { label: "Take the voucher", reply: "I'll play it straight.", ack: "Three trades. Clean ones. Then the thank-you." },
        decline: { label: "No favors", reply: "I don't collect IOUs from customs.", outro: "Helix: “Pride noted. Pride is taxable.”" },
        goal: { desc: "Complete 3 more trades", done: (s, b) => (s.stats.trades || 0) - b.trades >= 3 },
        reward: { credits: 7000, taxBreak: { pct: 0.08, ms: 40 * 60 * 1000 }, rep: { free_trade: 10 }, set: { league_voucher: true } },
        replies: [{ label: "Why the kindness?", reply: "Customs doesn't do kindness.", ack: "Correct. We do incentives. Don't romanticize it." }] },
    ],
  },

  // Consequence: smuggle OR tip → Syndicate responds
  {
    id: "mother_coil", kind: "arc", from: "Mother Coil", portrait: 3,
    trigger: s => (Story.flag("broker_smuggle") || Story.flag("broker_betrayed")) && (window.Economy ? Economy.netWorth() : s.credits) >= 30000,
    outro: "Coil: “The family is a market with better manners.”",
    steps: [
      { key: "c0", text: "Sweetheart. Mother Coil. The Syndicate's nicer voice. The Broker mentioned you — fondly or furiously, depending which rumor I like today. Shall we talk like adults?",
        choices: [
          { label: "Talk", reply: "I'm listening.", goto: "c1" },
          { label: "I'm not Syndicate", reply: "Wrong number.", ack: "Everyone says that before the second favor. Channel stays warm.", set: { coil_brushed: true }, end: true },
        ] },
      { key: "c1",
        text: "If you ran the Broker's Sable haul, I have a kiss. If you burned the Broker to Customs, I have a curriculum. Either way: do a quiet favor and the family files you under 'useful.'",
        choices: [
          { label: "Do the favor", reply: "Send the details.", ack: "A quiet escort job. Complete a contract. Come back breathing.", goto: "c2" },
          { label: "Name your price for leaving me alone", reply: "How much for silence?", ack: "Silence is 6,000 — or a future favor. Credits are cleaner.", goto: "c_pay" },
        ] },
      { key: "c_pay", text: "Pay the courtesy and we pretend you're furniture. Or don't, and we remember your silhouette.",
        choices: [
          { label: "Pay 6,000c", reply: "Take it. We're done.", cost: 6000, ack: "Polite. I adore polite.", set: { coil_paid: true }, reward: { rep: { syndicate: 2 } }, end: true },
          { label: "Hard pass", reply: "No.", ack: "Brave. Bravery photographs well on wanted boards.", set: { heat_syndicate: true }, reward: { rep: { syndicate: -6 } }, end: true },
        ] },
      { key: "c2", text: "Details are in your contract board's shadow. Finish one job. The family will know.",
        goal: { desc: "Complete 1 contract", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 1 },
        reward: { credits: 9000, item: "rare", rep: { syndicate: 10, free_trade: -3 }, set: { coil_friend: true } },
        replies: [{ label: "What am I really hauling?", reply: "What's in the crates?", ack: "Medicine, munitions, or melodrama — pick the story you can sleep with." }] },
    ],
  },

  // Rival — expanded with flags
  {
    id: "rival_kravern", kind: "job", from: "Baron Kravern", portrait: 9,
    trigger: s => (window.Economy ? Economy.netWorth() : s.credits) >= 40000,
    outro: "Kravern: “We'll see how long that swagger lasts.”",
    steps: [
      { text: "So you're the upstart the feed won't shut up about. Cute. I'll pay 5,000 for you to stay out of the Sable luxury lanes — a courtesy between predators. Or you can bark. Barking is free.",
        choices: [
          { label: "Take the hush money", reply: "Money's money. Consider me gone.",
            ack: "Smart. Cowards live longer; survivors get called smart later.",
            set: { kravern_paid: true }, reward: { credits: 5000 }, end: true },
          { label: "Tell him where to shove it", reply: "I trade where I like, Kravern.",
            ack: "Then you've bought a rival. Congratulations on the purchase.",
            set: { kravern_spited: true }, reward: { item: "rare" }, end: true },
          { label: "Counter — pay HIM off", reply: "I'll give you 3,000 to lose my address.",
            cost: 3000, ack: "…Unexpected. Fine. Temporary truce. Temporary is my favorite word.",
            set: { kravern_truce: true }, reward: { credits: 0 }, end: true },
        ],
        replies: [{ label: "Who whispers about me?", reply: "Who's whispering?", ack: "Everyone with a portfolio and a personality disorder." }] },
    ],
  },

  // Kravern payoff if you took hush money — he comes back angrier about luxury
  {
    id: "kravern_collects", kind: "job", from: "Baron Kravern", portrait: 9,
    trigger: s => Story.flag("kravern_paid") && (window.Economy ? Economy.netWorth() : s.credits) >= 80000,
    outro: "Kravern: “Next time the courtesy costs a fleet.”",
    steps: [
      { text: "Remember our little courtesy? Luxury ticks moved through Sable anyway — maybe not your holds, maybe your cousins. I don't do refunds. I do escalations. Pay 12,000 for an extended blind eye, or we stop being polite in the order books.",
        choices: [
          { label: "Pay the 12,000", reply: "Take your vig.", cost: 12000, ack: "See? Civilization.", set: { kravern_paid2: true }, end: true },
          { label: "Refuse — go to war in the spreads", reply: "We're done pretending.",
            ack: "Finally. Meet me in the luxury books. Bring tears.",
            set: { kravern_war: true }, reward: { item: "rare", rep: { agri_collective: -4 } }, end: true },
          { label: "Offer a partnership", reply: "Split the lane. Partners pay better than victims.",
            ack: "…Partnership. Bold word. Fine — prove you can move volume. Two trades. Then we talk percentages.",
            goto: "k_part" },
        ] },
      { key: "k_part", text: "Clock's running, partner. Two trades. Don't embarrass me.",
        goal: { desc: "Complete 2 more trades", done: (s, b) => (s.stats.trades || 0) - b.trades >= 2 },
        reward: { credits: 8000, rep: { agri_collective: 4 }, set: { kravern_partner: true } } },
    ],
  },

  // Spite payoff — he tries to kneecap you with a "gift"
  {
    id: "kravern_gift", kind: "job", from: "Baron Kravern", portrait: 9,
    trigger: s => Story.flag("kravern_spited") && (s.stats.contractsDone || 0) >= 3,
    outro: "Kravern: “Enjoy the present. Return policy is violence.”",
    steps: [
      { text: "Still swaggering? Adorable. I left you a 'gift' opportunity — a contract run so ugly even the Syndicate tips its hat. Take it and live, or keep hiding in grain futures.",
        accept: { label: "Take the ugly job", reply: "Send it.", ack: "One contract. Try not to die in a way that trends.", set: { kravern_gift_taken: true } },
        decline: { label: "Pass", reply: "Keep your gifts.", set: { kravern_gift_refused: true }, outro: "Kravern: “Cowardice logged.”" },
        goal: { desc: "Complete 1 contract", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 1 },
        reward: { credits: 11000, item: "rare" },
        replies: [{ label: "Why help me?", reply: "Why the charity?", ack: "Not charity. Sport. I want you tall when I cut you down." }] },
    ],
  },

  // ── Faction worldbuilding jobs ──────────────────────────────────────────
  {
    id: "combine_blast", kind: "job", from: "Foreman Dax", portrait: 2,
    trigger: s => Story.done("foundry_grant") && (s.stats.contractsDone || 0) >= 3,
    outro: "Dax: “Rock don't lie. People do. Keep digging.”",
    steps: [
      { text: "Belt-side. Combine shaft 17 cracked a seam and the Collective is already screaming about 'dust rights.' I need a baron who can move mineral volume without giving a speech. Two trades. You in?",
        accept: { label: "I'll move the ore", reply: "Send the tickers.", ack: "Good. Ignore the picket drones. They're union and poetry." },
        decline: { label: "Too political", reply: "I don't do dust wars.", outro: "Dax: “Everything's a dust war if you wait long enough.”" },
        goal: { desc: "Complete 2 more trades", done: (s, b) => (s.stats.trades || 0) - b.trades >= 2 },
        reward: { credits: 5500, rep: { mining_combine: 8, agri_collective: -3 }, set: { combine_helped: true } },
        replies: [
          { label: "What's a dust right?", reply: "Explain dust rights.", ack: "Legal fiction meaning 'we got here first with bigger drills.' The Senate rubber-stamps whoever bribed lunch." },
        ] },
    ],
  },

  {
    id: "collective_table", kind: "arc", from: "Lysa Greencrown", portrait: 10,
    trigger: s => (window.Economy ? Economy.netWorth() : s.credits) >= 35000,
    outro: "Lysa: “Hunger is a market too. We simply set the table.”",
    steps: [
      { key: "a0", text: "Agri-Collective outreach — Lysa. We grow what the Combine can't drill. Luxury and grain keep empires polite. A Combine-friendly baron has been undercutting harvest futures. Care to balance the scales — or are you already married to ore?",
        choices: [
          { label: "Hear her out", reply: "Balancing scales sounds profitable.", goto: "a1" },
          { label: "I'm Combine-leaning", reply: "I dig. I don't farm.",
            ack: "Honesty. Rude, but edible. We'll remember the flavor.",
            set: { collective_refused: true }, reward: { rep: { agri_collective: -2 } }, end: true },
          { label: "Not interested", reply: "Pass.", set: { collective_refused: true }, end: true },
        ],
        replies: [{ label: "Greencrown?", reply: "That's a title?", ack: "A nickname the feed gave me after three famine short-squeezes. I kept it. Branding." }] },
      { key: "a1", text: "Move agri or luxury volume — three trades — and dine with us in the ledgers. Or take a Collective contract if you prefer bruises to spreadsheets.",
        goal: { desc: "Complete 3 more trades OR 1 contract",
          done: (s, b) => ((s.stats.trades || 0) - b.trades >= 3) || ((s.stats.contractsDone || 0) - b.contracts >= 1) },
        reward: { credits: 6500, rep: { agri_collective: 9, mining_combine: -3 }, set: { collective_helped: true } },
        replies: ["Consider the table set."] },
      { key: "a2", text: "One last taste. The Syndicate has been slipping stimulants into festival spice. Tip us a quiet contract run to 'correct' a shipment — or look away and keep your Syndicate options warm.",
        choices: [
          { label: "Correct the shipment", reply: "I'll run the correction.",
            ack: "A contract, then. The festival must not jitter.",
            set: { spice_corrected: true }, goto: "a3" },
          { label: "Look away", reply: "Not my festival.",
            ack: "Pragmatic. The Syndicate will toast you. We will not.",
            set: { spice_ignored: true }, reward: { rep: { syndicate: 3, agri_collective: -2 } }, end: true },
        ] },
      { key: "a3", text: "Correction is live. Finish it.",
        goal: { desc: "Complete 1 contract", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 1 },
        reward: { credits: 7000, item: true, rep: { agri_collective: 6, syndicate: -5 }, set: { collective_inner: true } } },
    ],
  },

  // Archivist lore dump — mostly dialogue, light objective
  {
    id: "archivist_wren", kind: "arc", from: "Archivist Wren", portrait: 5,
    // 3 systems start unlocked — wait for a 4th (or real trade mileage) so Wren
    // doesn't eat an early MAX_ACTIVE slot and starve the onboarding threads.
    trigger: s => (s.unlockedSystems || []).length >= 4 || (s.stats.trades || 0) >= 10,
    outro: "Wren: “History is just prices with better fonts.”",
    steps: [
      { key: "w0", text: "Archive ping. Wren. I hoard context the way you hoard margin. Want the short history of why every baron eventually hates the Senate — or shall I let you discover it via lien?",
        choices: [
          { label: "Educate me", reply: "I'll take the short history.", goto: "w1" },
          { label: "Skip the lecture", reply: "I learn by bleeding.", ack: "Traditionalist. Respect. Channel closed until you own more sky.", set: { wren_skipped: true }, end: true },
        ] },
      { key: "w1", text: "Before the Baron Tiers, the lanes were wild margin. Then the Guild and League wrote 'stability': docking fees, prestige taxes, industry permits. Stability means the winners pay rent to the story of civilization. The Senate is that story's casting committee.",
        continue: { label: "Keep going" },
        replies: [{ label: "Who funds the Senate?", reply: "Who pays the senators?", ack: "Sector capitals, faction PACs, and barons who think a bill is cheaper than a war." }] },
      { key: "w2", text: "Sable Reach was a free anchorage once. Then luxury houses and Syndicate clinics arrived in the same week. Now it's where reputations go to be laundered or buried. You've traded enough to feel the undertow. One more system unlocked — or one industry planted — and I'll send a relic from the archive.",
        goal: { desc: "Unlock another system OR own an industry",
          done: (s, b) => ((s.unlockedSystems || []).length - (b.systems || 0) >= 1) || ((s.industries || []).length - (b.industries || 0) >= 1) },
        reward: { credits: 4000, item: "rare", set: { wren_student: true } } },
      { key: "w3", text: "Last postcard. Cosmocrat — the final tier — was a joke title in an old satire about traders who taxed each other until only one could afford breakfast. They printed it on a plaque. Someone took the plaque seriously. Now you chase it. Isn't that delicious?",
        choices: [
          { label: "Darkly funny", reply: "Darkly funny. I'll still chase it.", ack: "As will they all. See you in the footnotes.", set: { wren_dark: true }, end: true },
          { label: "I'll rewrite the joke", reply: "Then I'll be the one who changes the ending.", ack: "Write hard. The archive prefers ink to optimism.", set: { wren_rewriter: true }, reward: { credits: 1500 }, end: true },
        ] },
    ],
  },

  // Senate politics vignette
  {
    id: "senate_aide", kind: "arc", from: "Aide Pell", portrait: 6,
    trigger: s => (window.Economy ? Economy.netWorth() : s.credits) >= 50000,
    outro: "Pell: “Democracy is just liquidity with a gavel.”",
    steps: [
      { key: "p0", text: "Senate aide Pell — off-ledger channel. A bill is gestating that loves tariffs and hates barons with fleets. My senator needs a 'community voice.' That's you, if you can sound like one.",
        choices: [
          { label: "What do you need?", reply: "Define 'community voice.'", goto: "p1" },
          { label: "I don't lobby", reply: "I trade. I don't lobby.",
            ack: "Everyone lobbies. Some of you just call it 'market making.'",
            set: { pell_refused: true }, end: true },
        ] },
      { key: "p1", text: "Option A: donate 10,000 to the 'stability fund' and we stall the bill. Option B: look civic — complete a public-facing contract — and we quote your 'heroism' in committee. Option C: tip the Syndicate to lean on a rival senator. Messy. Effective.",
        choices: [
          { label: "Donate 10,000c", reply: "Take the donation.", cost: 10000,
            ack: "Stability purchased. For a session or two.",
            set: { pell_donor: true }, reward: { rep: { free_trade: 4 }, taxBreak: { pct: 0.06, ms: 35 * 60 * 1000 } }, end: true },
          { label: "Do the civic contract", reply: "I'll play hero.", ack: "One contract. Smile for the minutes.", goto: "p2" },
          { label: "Tip the Syndicate", reply: "Lean on them. Quietly.",
            require: s => Story.flag("coil_friend") || Story.flag("broker_smuggle"),
            requireMsg: "You lack Syndicate introductions — pick another option.",
            ack: "Message passed through Coil's cousins. Don't ask for minutes of that meeting.",
            set: { pell_dirty: true }, reward: { credits: 4000, rep: { syndicate: 5, free_trade: -4 } }, end: true },
        ] },
      { key: "p2", text: "Civic theatre is live. Finish a contract and I'll see your name misspelled approvingly in the record.",
        goal: { desc: "Complete 1 contract", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 1 },
        reward: { credits: 6000, rep: { free_trade: 5 }, set: { pell_hero: true } } },
    ],
  },

  // Juno callback if you bought her a drink
  {
    id: "juno_lane", kind: "job", from: "Skipper Juno", portrait: 1,
    trigger: s => Story.flag("juno_friend") && (s.stats.trades || 0) >= 12,
    outro: "Juno: “Lane's yours. Don't put my name in a log.”",
    steps: [
      { text: "You bought the drink. I keep receipts in my liver. Helix is sniffing the belt again — I can burn you a gray lane past her pickets. No payout from me. Just safer math. Want it?",
        choices: [
          { label: "I'll take the lane", reply: "Burn it.", ack: "Done. If you smuggle, she may still smell smoke — but she'll smell it later.", set: { juno_lane: true }, end: true },
          { label: "I stay clean", reply: "Appreciate it. I'll stay on sealed routes.", ack: "Boring. Healthy. Text me when healthy gets expensive.", set: { juno_clean: true }, end: true },
        ],
        replies: [{ label: "Why risk this?", reply: "Why help me?", ack: "Because the drink was good. And because Helix once impounded my cat. Long story. Hateful woman." }] },
    ],
  },

  // Black box — choice of buyer, consequences later
  {
    id: "black_box", kind: "arc", from: "Unknown Transponder", portrait: 11,
    trigger: s => (s.stats.contractsDone || 0) >= 2 && (window.Economy ? Economy.netWorth() : s.credits) >= 20000,
    outro: "Transponder: “Signal ends. Guilt does not.”",
    steps: [
      { key: "b0", text: "…hello? If you can read this, a courier died on my deck and left a sealed black box. Nav says you're the nearest baron who isn't currently on fire. Will you take it?",
        choices: [
          { label: "I'll take the box", reply: "Transfer coordinates.", ack: "Thank you — I think. Don't open it. Opening is how courier stories end.", set: { box_held: true }, goto: "b1" },
          { label: "Not my problem", reply: "Space it and move on.", ack: "Cold. Correct, maybe. Signing off.", set: { box_refused: true }, end: true },
        ] },
      { key: "b1", text: "Box is in your hold (metaphorically — check your conscience). Three buyers already pinged: League Customs wants it 'for evidence,' Mother Coil wants it 'for family,' Archivist Wren wants it 'for context.' Who gets the hot potato?",
        choices: [
          { label: "Give it to Customs (Helix)", reply: "Helix can have it.",
            ack: "League thanks you with paperwork and a thin smile.",
            set: { box_to_helix: true }, reward: { credits: 5000, rep: { free_trade: 8, syndicate: -4 } }, end: true },
          { label: "Give it to Mother Coil", reply: "Coil's family can handle it.",
            ack: "A courier arrives humming. You did not hear the hum.",
            set: { box_to_coil: true }, reward: { credits: 8000, item: "rare", rep: { syndicate: 8, free_trade: -5 } }, end: true },
          { label: "Give it to Wren", reply: "The archive should hold it.",
            ack: "Wren already forged a receipt dated last year. Impressive.",
            set: { box_to_wren: true }, reward: { credits: 3500, item: true, rep: { free_trade: 2 } }, end: true },
          { label: "Sell to Kravern", reply: "Kravern pays for secrets.",
            ack: "He pays. He also talks. Expect weather.",
            set: { box_to_kravern: true }, reward: { credits: 10000 }, end: true },
        ] },
    ],
  },

  // Box fallout — Helix angry if box went to Coil
  {
    id: "helix_box_rage", kind: "job", from: "Inspector Helix", portrait: 8,
    trigger: s => Story.flag("box_to_coil") && Story.done("black_box"),
    outro: "Helix: “Evidence is not a gift shop.”",
    steps: [
      { text: "That black box was League evidence. It sniffed Syndicate. You smell like a decision I dislike. Fine: buy back my patience with two clean contracts, or stay marked.",
        accept: { label: "I'll make it right", reply: "Two contracts. Clean.", ack: "Clock runs. So does my temper." },
        decline: { label: "I stand by it", reply: "I'd do it again.", set: { heat_customs: true }, reward: { rep: { free_trade: -8 } }, outro: "Helix: “Marked, then.”" },
        goal: { desc: "Complete 2 contracts", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 2 },
        reward: { credits: 4000, rep: { free_trade: 5 }, set: { helix_box_settled: true } } },
    ],
  },

  // Box fallout — Coil pleased / Wren follow-up
  {
    id: "wren_box", kind: "job", from: "Archivist Wren", portrait: 5,
    trigger: s => Story.flag("box_to_wren"),
    outro: "Wren: “Context secured. Nightmares optional.”",
    steps: [
      { text: "The box contained route tables for a war that hasn't been declared yet — Combine vs Collective skirmish projections. Knowledge is a derivative. Want a copy of the summary, or blissful ignorance?",
        choices: [
          { label: "Give me the summary", reply: "Knowledge, please.",
            ack: "Summary burned to you. When the war tickers jump, remember who whispered first.",
            set: { wren_war_tables: true }, reward: { credits: 2500, item: "rare" }, end: true },
          { label: "Keep it sealed", reply: "Some doors stay shut.",
            ack: "Adult choice. Rare in this profession.",
            set: { wren_box_sealed: true }, end: true },
        ] },
    ],
  },

  // Ghost freighter — atmospheric, path_ghost synergy
  {
    id: "ghost_freighter", kind: "arc", from: "MV Pale Margin", portrait: 11,
    trigger: s => (s.stats.trades || 0) >= 15,
    outro: "Pale Margin: “Signal fades. Hulls don't.”",
    steps: [
      { key: "g0", text: "Automated beacon. MV Pale Margin. Crew: 0. Cargo: disputed. The ship thinks it still has a captain. It would like to be wrong — or right — with your help.",
        continue: { label: "Query the beacon" },
        replies: [{ label: "Is this a trap?", reply: "Trap?", ack: "Probability of trap: non-zero. Probability of salvage: also non-zero. Welcome to the lanes." }] },
      { key: "g1", text: "Options logged: (1) Claim salvage — file with League, pay fees, gain a clean story. (2) Quiet strip — Syndicate scrap values, dirty story. (3) Leave it drifting — some wrecks are shrines.",
        choices: [
          { label: "Claim salvage — League way", reply: "I'll file it clean.",
            ack: "Filing… accepted. Complete a contract as 'recovery theatre' and the fee waives.",
            set: { ghost_league: true }, goto: "g2" },
          { label: "Quiet strip — Syndicate way", reply: "Strip it. Quietly.",
            ack: "Scrap crews inbound. Pay 2,000 for silence on the channel.",
            set: { ghost_syndicate: true }, goto: "g3" },
          { label: "Leave the shrine", reply: "Let it drift.",
            ack: "Logged. The dead thank you in currencies you can't spend.",
            set: { ghost_shrine: true }, end: true },
        ] },
      { key: "g2", text: "Recovery theatre pending. One contract.",
        goal: { desc: "Complete 1 contract", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 1 },
        reward: { credits: 7500, component: true, rep: { free_trade: 4 }, set: { ghost_claimed: true } },
        end: true },
      { key: "g3", text: "Silence tax: 2,000c — or walk and the beacon starts naming you.",
        choices: [
          { label: "Pay 2,000c", reply: "Paid. Strip it.", cost: 2000,
            ack: "Scrap wired. Don't decorate with their hull numbers.",
            reward: { credits: 9000, item: true, rep: { syndicate: 5, free_trade: -3 } }, end: true },
          { label: "Walk", reply: "I'm out.", ack: "Beacon resumes. Helix will love this.", set: { heat_customs: true }, end: true },
        ] },
    ],
  },

  // Ledger chapter 2 — after quiet_ladder, keyed to path flags
  {
    id: "quiet_ladder_ii", kind: "arc", from: "The Ledger", portrait: 0,
    trigger: s => Story.done("quiet_ladder") && (window.Economy ? Economy.netWorth() : s.credits) >= 100000,
    outro: "The Ledger: “Chapter closed. The vig continues.”",
    steps: [
      { key: "q0", text: "Chapter two. You chose a posture — builder, predator, or ghost. The board has since tried to sand it off you. Shall we inventory the scars?",
        continue: { label: "Inventory them" } },
      { key: "q1", text: "Builders grow industries and learn tax is a love language. Predators stack escorts and enemies. Ghosts bribe fewer headlines and more inspectors. None of you escape Baron Tier gravity — the higher you climb, the louder the revenue choir. Show me you can still expand: five trades from this mark, or two contracts.",
        goal: { desc: "Complete 5 more trades OR 2 contracts",
          done: (s, b) => ((s.stats.trades || 0) - b.trades >= 5) || ((s.stats.contractsDone || 0) - b.contracts >= 2) },
        reward: { credits: 12000, item: "rare" } },
      { key: "q2", text: "Closing argument. The vibe of this empire is simple: every friendship is a future invoice. Every smuggle is a future audit. Every rival you humiliate learns patience. Knowing that — do you double down, or soften?",
        choices: [
          { label: "Double down", reply: "Double down. Invoice me later.",
            ack: "Noted. The Ledger underlines your name.",
            set: { ledger_doubled: true },
            reward: { credits: 5000 }, end: true },
          { label: "Soften — keep doors open", reply: "I'll leave a few doors open.",
            ack: "Doors are liabilities. Also exits. Wise.",
            set: { ledger_softened: true },
            reward: { credits: 5000, taxBreak: { pct: 0.1, ms: 60 * 60 * 1000 } }, end: true },
        ] },
    ],
  },

  // Vel follow-up
  {
    id: "vel_second", kind: "job", from: "Quartermaster Vel", portrait: 4,
    trigger: s => Story.done("first_contact") && (s.stats.trades || 0) >= 6,
    outro: "Vel: “Guild eyes stay open. Try not to blink wrong.”",
    steps: [
      { text: "Vel again. Starter kit treat you kind? The Guild wants a warmer body on the contract board — one job — and they'll pretend it was your idea. Also, between us: if you've been running gray for the Broker, wash your hands before you shake mine.",
        accept: { label: "I'll take a Guild job", reply: "Post it.", ack: "One contract. Make it look professional." },
        decline: { label: "I'm fine solo", reply: "I'll pass on Guild theatre.", set: { vel_solo: true }, outro: "Vel: “Solo barons make excellent cautionary tales.”" },
        goal: { desc: "Complete 1 contract", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 1 },
        reward: { credits: 4500, component: true, set: { vel_guild: true } },
        replies: [
          { label: "About the Broker…", reply: "What do you know about the Broker?",
            ack: "Enough to suggest mouthwash if you said yes — and better docking windows if you said no." },
        ] },
    ],
  },

  // War-table tip if Wren shared projections
  {
    id: "war_weather", kind: "job", from: "Archivist Wren", portrait: 5,
    trigger: s => Story.flag("wren_war_tables") && (window.Economy ? Economy.netWorth() : s.credits) >= 60000,
    outro: "Wren: “When the tickers scream, whisper that I was early.”",
    steps: [
      { text: "War weather. Combine and Collective are one insult from a formal clash — your board will show it as category spikes and slumps. I can mark you a speculative seat: lean Combine, lean Collective, or sell blankets to both.",
        choices: [
          { label: "Lean Combine", reply: "Mark me Combine.", set: { war_lean_combine: true },
            reward: { credits: 3000, rep: { mining_combine: 6, agri_collective: -3 } }, end: true },
          { label: "Lean Collective", reply: "Mark me Collective.", set: { war_lean_collective: true },
            reward: { credits: 3000, rep: { agri_collective: 6, mining_combine: -3 } }, end: true },
          { label: "Sell blankets to both", reply: "I sell to both. Always.",
            ack: "The ghost's choice — or the arbitrageur's. Either way, bring volume.",
            set: { war_lean_both: true }, goto: "ww1" },
        ] },
      { key: "ww1", text: "Prove the neutrality: three trades while everyone else picks a flag.",
        goal: { desc: "Complete 3 more trades", done: (s, b) => (s.stats.trades || 0) - b.trades >= 3 },
        reward: { credits: 8000, item: "rare", set: { war_profiteer: true } } },
    ],
  },

  // Mirror baron — identity weirdness, dialogue heavy
  {
    id: "mirror_baron", kind: "job", from: "Baron (?)", portrait: 0,
    trigger: s => (window.Economy ? Economy.netWorth() : s.credits) >= 70000,
    outro: "?: “If they toast your name, check the spelling on the invoice.”",
    steps: [
      { text: "Funny thing. Someone on the open feed is trading under a handle that parses as yours in three dialects. Either you've cloned, or you're being worn. How do we play it?",
        choices: [
          { label: "Expose them — go loud", reply: "Out them. Loud.",
            ack: "Broadcast queued. You'll make friends with auditors and enemies with impersonators.",
            set: { mirror_exposed: true }, reward: { credits: 2000, rep: { free_trade: 3 } }, end: true },
          { label: "Hire them", reply: "If they're good, put them on payroll.",
            ack: "Pragmatic. 4,000c finds a 'consultant' who stops wearing your face.",
            set: { mirror_hired: true }, goto: "m1" },
          { label: "Ignore it", reply: "Imitation is free advertising.",
            ack: "Until it isn't. Flag planted in the soft sand.",
            set: { mirror_ignored: true }, end: true },
        ],
        replies: [{ label: "Is this you, Ledger?", reply: "Ledger — is this one of yours?", ack: "The Ledger does not wear faces. It weighs them." }] },
      { key: "m1", text: "Consultant fee: 4,000c. Pay and the mirror cracks politely.",
        choices: [
          { label: "Pay 4,000c", reply: "Paid.", cost: 4000, ack: "Face returned. Mostly.", reward: { item: true }, end: true },
          { label: "Changed my mind — expose them", reply: "On second thought, burn them.", set: { mirror_exposed: true }, reward: { rep: { free_trade: 2 } }, end: true },
        ] },
    ],
  },

  // Spice widow — luxury lane color
  {
    id: "spice_widow", kind: "arc", from: "Madam Cinder", portrait: 10,
    trigger: s => (window.Economy ? Economy.netWorth() : s.credits) >= 45000 && (s.stats.trades || 0) >= 8,
    outro: "Cinder: “Luxury is hunger in nicer clothes.”",
    steps: [
      { key: "s0", text: "Madam Cinder — Sable luxury houses. My spouse died holding a short position on festival spice. Poetic. Ruinous. I need a living baron to push three trades through the luxury books so the house doesn't auction my bones.",
        accept: { label: "Help the house", reply: "I'll move luxury volume.", ack: "Bless your spreads. Three trades.", set: { cinder_helped: true } },
        decline: { label: "I don't do sob stories", reply: "Condolences. No.",
          ack: "Noted. If you ever buy spice, check for glass.",
          set: { cinder_spurned: true }, outro: "Cinder: “Widows remember.”" },
        goal: { desc: "Complete 3 more trades", done: (s, b) => (s.stats.trades || 0) - b.trades >= 3 },
        reward: { credits: 6000, rep: { agri_collective: 5 } },
        replies: [{ label: "How did they die?", reply: "How does a short position kill?", ack: "Margin call. Airlock. Same gesture, different hardware." }] },
      { key: "s1", text: "You kept the house upright. One favor deserves a fork in the road: I can introduce you to Kravern's rivals in luxury — or to Coil's perfume couriers. Both smell like money. Different aftertastes.",
        choices: [
          { label: "Luxury rivals (legit)", reply: "Introduce me clean.", set: { cinder_legit: true }, reward: { credits: 3000, item: true, rep: { agri_collective: 3 } }, end: true },
          { label: "Perfume couriers (gray)", reply: "Introduce me to Coil's side.",
            ack: "Brave. Or bored. I'll ping Coil that you smell expensive.",
            set: { cinder_gray: true, heat_customs: true }, reward: { credits: 5000, rep: { syndicate: 4, free_trade: -2 } }, end: true },
        ] },
    ],
  },

  // If you spurned Cinder, she poisons the well later
  {
    id: "cinder_glass", kind: "job", from: "Madam Cinder", portrait: 10,
    trigger: s => Story.flag("cinder_spurned") && (window.Economy ? Economy.netWorth() : s.credits) >= 90000,
    outro: "Cinder: “Glass in the spice. Metaphorically. Mostly.”",
    steps: [
      { text: "Remember declining a widow? The house survived without you — and now we're shorting barons who collect sob stories as tax write-offs. Pay 7,000 for a peace ribbon, or enjoy unexpected volatility in your luxury book.",
        choices: [
          { label: "Pay 7,000c for peace", reply: "Take the ribbon money.", cost: 7000, set: { cinder_peace: true }, end: true },
          { label: "Eat the volatility", reply: "Do your worst.", set: { cinder_feud: true }, reward: { item: "rare", rep: { agri_collective: -6 } }, end: true },
        ] },
    ],
  },

  // Path-specific Ledger whispers (short)
  {
    id: "ledger_builder", kind: "job", from: "The Ledger", portrait: 0,
    trigger: s => Story.flag("path_builder") && ((s.industries || []).length >= 1 || Object.keys(s.extractors || {}).length >= 1),
    outro: "The Ledger: “Foundations remember who poured them.”",
    steps: [
      { text: "Builder. You planted machines on someone else's sky. The permit office calls that civilization. The locals call it Tuesday. Own the contradiction: finish one more contract to fund a second foundation myth.",
        goal: { desc: "Complete 1 contract", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 1 },
        reward: { credits: 5000, extractor: true, set: { builder_rooted: true } },
        replies: [{ label: "Is this praise?", reply: "Praise, or warning?", ack: "Both. The tax office sends both in the same envelope." }] },
    ],
  },
  {
    id: "ledger_predator", kind: "job", from: "The Ledger", portrait: 0,
    trigger: s => Story.flag("path_predator") && (s.ships || []).filter(sh => sh.cls === "escort").length >= 1,
    outro: "The Ledger: “Teeth dull. Appetites don't.”",
    steps: [
      { text: "Predator. Your escorts cast a longer shadow than your balance sheet. Good. Shadows spook rivals — and Customs. Run a hard contract. Come back with the shadow intact.",
        goal: { desc: "Complete 1 contract", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 1 },
        reward: { credits: 7000, item: "rare", set: { predator_fed: true } },
        replies: ["The shadow holds."] },
    ],
  },
  {
    id: "ledger_ghost", kind: "job", from: "The Ledger", portrait: 0,
    trigger: s => Story.flag("path_ghost") && (Story.flag("juno_lane") || Story.flag("helix_bribed") || Story.flag("broker_clean")),
    outro: "The Ledger: “Invisibility is just a quieter invoice.”",
    steps: [
      { text: "Ghost. You've already bought a lane, a bribe, or a clean alibi. That is craft. Craft needs maintenance: three quiet trades, no speeches.",
        goal: { desc: "Complete 3 more trades", done: (s, b) => (s.stats.trades || 0) - b.trades >= 3 },
        reward: { credits: 6000, taxBreak: { pct: 0.08, ms: 50 * 60 * 1000 }, set: { ghost_practiced: true } },
        replies: [{ label: "Anyone watching?", reply: "Who's watching ghosts?", ack: "Everyone who profits from believing you aren't there." }] },
    ],
  },

  // Betraying the Broker → hitman flavor
  {
    id: "broker_revenge", kind: "job", from: "The Broker", portrait: 7,
    trigger: s => Story.flag("broker_betrayed") && (s.stats.trades || 0) >= 10,
    outro: "The Broker: “Next tip won't be financial.”",
    steps: [
      { text: "You tipped Customs. Charming. I don't do refunds; I do curricula. Pay 15,000 tuition for continued breathing lessons — or run a humiliating errand contract while my associates watch.",
        choices: [
          { label: "Pay 15,000c tuition", reply: "Tuition paid.", cost: 15000, set: { broker_tuition: true }, ack: "Graduated. Barely.", end: true },
          { label: "Do the errand", reply: "I'll run your errand.", ack: "One contract. Wear something you don't mind bleeding on.", goto: "br1" },
        ] },
      { key: "br1", text: "Errand is live.",
        goal: { desc: "Complete 1 contract", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 1 },
        reward: { credits: 2000, rep: { syndicate: -2 }, set: { broker_errand: true } } },
    ],
  },

  // Early pure-dialogue: radio night
  {
    id: "night_radio", kind: "job", from: "Voidband Host", portrait: 6,
    trigger: s => (s.stats.trades || 0) >= 5,
    outro: "Host: “You're listening to Voidband — where the charts go to cry.”",
    steps: [
      { text: "You're on Voidband night shift — accidental open mic. Say something the lanes will misquote for a week. What's your thesis?",
        choices: [
          { label: "“Buy the rumor”", reply: "Buy the rumor. Sell the funeral.", ack: "Classic. Timeless. Wrong often enough to stay interesting.", set: { radio_degen: true }, end: true },
          { label: "“Build the rock”", reply: "Own the rock under the ticker.", ack: "Industrialcore. The Combine just blushed in binary.", set: { radio_builder: true }, end: true },
          { label: "Stay silent", reply: "…", ack: "Dead air. Respect. The audience hates it. I don't.", set: { radio_silent: true }, end: true },
        ],
        replies: [{ label: "How did you get this channel?", reply: "How are you on my private band?", ack: "Nothing's private after the first profit." }] },
    ],
  },

  // Survey pitch — points players at Star Map surveys + survey hulls
  {
    id: "survey_pitch", kind: "job", from: "Cartographer Nil", portrait: 1,
    trigger: s => (s.stats.trades || 0) >= 7,
    outro: "Nil: “Blank spots on the map are just unpaid invoices.”",
    steps: [
      { text: "Cartographer Nil. The Star Map is full of uncharted outposts the hubs pretend aren't there. Survey them. When your ship returns, you'll get a debrief in Dispatches — choices, odds, scars. Interested in learning the trade?",
        continue: { label: "Tell me more" },
        replies: [{ label: "Why not auto-loot?", reply: "Why a debrief instead of auto-pay?", ack: "Because barons who don't choose become cargo." }] },
      { text: "Buy a Survey hull in the Shipyard if you can — Probe Skiff, Survey Cutter, Deep Mapper. Bolt on a Deep Scanner from Gear. Weak scan means pushing a wreck can fail. The % is on the button. Prove you've looked: unlock another system or finish a contract while you shop.",
        goal: { desc: "Unlock a system OR complete 1 contract",
          done: (s, b) => ((s.unlockedSystems || []).length - (b.systems || 0) >= 1) || ((s.stats.contractsDone || 0) - b.contracts >= 1) },
        reward: { credits: 2500, item: true, set: { nil_student: true } },
        replies: ["I'll chart something."] },
    ],
  },

  {
    id: "dock_rats", kind: "job", from: "Dockrat Pew", portrait: 2,
    trigger: s => (s.stats.trades || 0) >= 3,
    outro: "Pew: “Rats remember who shared the crumbs.”",
    steps: [
      { text: "Heard you're stacking paper. Dockrats keep the real weather — which inspector naps, which crane leaks. Buy us a round (800c) or ignore us and enjoy surprises.",
        choices: [
          { label: "Buy the round (800c)", reply: "Drinks on me.", cost: 800, ack: "Bless. Helix's third shift naps after cycle twenty. You're welcome.", set: { dockrat_friend: true }, end: true },
          { label: "Ignore the rats", reply: "I don't tip vermin.", ack: "Vermin bite cables. Sleep light.", set: { dockrat_spurned: true }, end: true },
        ] },
    ],
  },
  {
    id: "dock_rats_bite", kind: "job", from: "Dockrat Pew", portrait: 2,
    trigger: s => Story.flag("dockrat_spurned") && (s.stats.trades || 0) >= 14,
    outro: "Pew: “Told you. Cables.”",
    steps: [
      { text: "Remember ignoring us? A 'random' inspection wave is eyeing your next contract. Pay 5,000 for us to misfile the tip, or walk into it.",
        choices: [
          { label: "Pay 5,000c", reply: "Fine. Misfile it.", cost: 5000, set: { dockrat_paid: true }, end: true },
          { label: "Walk into it", reply: "I'll take the heat.", set: { dockrat_feud: true }, reward: { rep: { free_trade: -3 } }, end: true },
        ] },
    ],
  },

  {
    id: "combine_widow", kind: "arc", from: "Shaft-Boss Rhee", portrait: 5,
    trigger: s => Story.flag("combine_helped") && (window.Economy ? Economy.netWorth() : s.credits) >= 55000,
    outro: "Rhee: “Rock remembers. So do widows.”",
    steps: [
      { text: "Shaft-Boss Rhee. You moved Combine ore when the Collective screamed. There's a sealed gallery under Korrin the board won't chart. Want a look — or a quiet dividend?",
        choices: [
          { label: "Chart the gallery", reply: "Send coordinates.", ack: "One contract-shaped 'survey' of the political kind. Finish a job; I'll wire the rest.", goto: "r1" },
          { label: "Take the dividend", reply: "Just pay me.", reward: { credits: 4000 }, set: { rhee_dividend: true }, end: true },
        ] },
      { key: "r1", text: "Job's live. Don't die photogenically.",
        goal: { desc: "Complete 1 contract", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 1 },
        reward: { credits: 7000, rep: { mining_combine: 6 }, set: { rhee_gallery: true } } },
    ],
  },

  {
    id: "league_sermon", kind: "job", from: "Inspector Helix", portrait: 8,
    trigger: s => Story.flag("league_voucher") || Story.flag("helix_cleared"),
    outro: "Helix: “Law is a product. Stay subscribed.”",
    steps: [
      { text: "Sermon, unpaid. The League isn't 'good' — it's predictable. Predictable lanes compound. If you've been flirting with Coil, wash your manifests. If you've been clean, stay boring. Reply with a creed.",
        choices: [
          { label: "I prefer predictable", reply: "Predictable pays.", ack: "Then keep your scanners dull and your paperwork loud.", set: { helix_creed_law: true }, end: true },
          { label: "I prefer profitable", reply: "Predictable is a tax on imagination.", ack: "Imagination is what Customs budgets for.", set: { helix_creed_edge: true }, end: true },
        ] },
    ],
  },

  {
    id: "void_lullaby", kind: "job", from: "The Ledger", portrait: 0,
    trigger: s => Story.done("quiet_ladder") && (s.stats.trades || 0) >= 20,
    outro: "The Ledger: “Lullabies are just compound interest in 3/4 time.”",
    steps: [
      { text: "Interlude. While you sleep, rivals compound, wars roll, surveys wait in your inbox. The vibe is not adventure — it is attrition with better lighting. Acknowledge, and take a breath of credits.",
        choices: [
          { label: "Acknowledge", reply: "Attrition with better lighting. Noted.", reward: { credits: 2000 }, set: { ledger_lullaby: true }, end: true },
        ],
        replies: [{ label: "Is this motivational?", reply: "Motivational?", ack: "No. Accounting." }] },
    ],
  },

  {
    id: "smuggler_hymn", kind: "arc", from: "Mother Coil", portrait: 3,
    trigger: s => Story.flag("coil_friend") && (s.stats.contractsDone || 0) >= 4,
    outro: "Coil: “Family hymns have no chorus — only verses that collect.”",
    steps: [
      { text: "Family dinner. We need a verse sung quietly — one contract that never happened. Sing, or send flowers to Customs instead.",
        choices: [
          { label: "Sing the verse", reply: "I'll take the quiet job.", goto: "h1", set: { coil_hymn: true } },
          { label: "Send flowers to Customs", reply: "I'd rather tip Helix.",
            ack: "Betrayal with stationery. Bold.",
            set: { coil_hymn_betray: true, heat_syndicate: true },
            reward: { rep: { syndicate: -8, free_trade: 6 } }, end: true },
        ] },
      { key: "h1", text: "The verse is live. One contract.",
        goal: { desc: "Complete 1 contract", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 1 },
        reward: { credits: 10000, item: "rare", rep: { syndicate: 8 }, set: { coil_inner: true } } },
    ],
  },

  {
    id: "flagship_envy", kind: "job", from: "Baron Kravern", portrait: 9,
    trigger: s => (window.Economy ? Economy.netWorth() : s.credits) >= 120000,
    outro: "Kravern: “Nice chair. Try not to die in it.”",
    steps: [
      { text: "Saw your flagship offers rotating in the Bazaar. Cute that the yard hides the good chairs. Each rarity stacks another empire effect — industry, safer routes, survey lenses, tax knives. Steal a better seat, or keep cosplaying in that starter throne.",
        choices: [
          { label: "I'll upgrade", reply: "Already shopping.", set: { kravern_flag_taunt: true }, end: true },
          { label: "This throne is fine", reply: "I like my chair.", ack: "Stockholm syndrome is free.", set: { kravern_flag_loyal: true }, end: true },
        ] },
    ],
  },

  {
    id: "agri_feast", kind: "job", from: "Lysa Greencrown", portrait: 10,
    trigger: s => Story.flag("collective_helped") && !Story.flag("spice_ignored"),
    outro: "Lysa: “Feasts end. Ledgers don't.”",
    steps: [
      { text: "Festival season. The Collective wants a baron who can move luxury without jitter. Three trades — or one clean contract — and you'll dine in the footnotes.",
        accept: { label: "I'll feast", reply: "Set the table.", ack: "Three trades or a contract. Bring appetite." },
        decline: { label: "Fasting", reply: "Not this season.", outro: "Lysa: “More spice for the jittering, then.”" },
        goal: { desc: "Complete 3 more trades OR 1 contract",
          done: (s, b) => ((s.stats.trades || 0) - b.trades >= 3) || ((s.stats.contractsDone || 0) - b.contracts >= 1) },
        reward: { credits: 5500, rep: { agri_collective: 5 }, set: { agri_feast: true } } },
    ],
  },

  // The Last Aegis — one-of-a-kind craftable hull (CRAFTING_AND_MATERIALS §3.4).
  // Blueprint is mission-chain only; never in random contract/expedition pools.
  {
    id: "last_aegis", kind: "arc", from: "Archivist Wren", portrait: 5,
    trigger: s => (s.stats.contractsDone || 0) >= 8
      && (window.Economy ? Economy.netWorth() : s.credits) >= 250000
      && !(window.Workshop && Workshop.burned("ship_last_aegis"))
      && !(window.Workshop && Workshop.known("ship_last_aegis")),
    outro: "Wren: “One hull. One forge. Don't waste the ending.”",
    steps: [
      { key: "a0", text: "Encrypted packet. Subject: Last Aegis. Pre-Guild keel plan, thought erased. I can reconstruct the blueprint — if you prove you won't sell the skeleton to the highest bidder. Two hard contracts from this mark. High or extreme. No theatre.",
        accept: { label: "I'll earn it", reply: "Name the proof.", ack: "Two high/extreme contracts. Then we talk forgings.", set: { aegis_hunt: true } },
        decline: { label: "Too steep", reply: "Not my war.", ack: "Then the archive stays shut. Some endings prefer dust.", set: { aegis_refused: true }, outro: "Wren: “Refused. Logged.”" },
        goal: { desc: "Complete 2 more contracts", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 2 },
        reward: { credits: 8000 },
        replies: [
          { label: "What is the Aegis?", reply: "What was the Last Aegis?",
            ack: "A shield that outlived its empire. Stats suggest it still could." },
        ] },
      { key: "a1", text: "Proof accepted. The yard still needs feedstock theatre — voidstone, matrices, antimatter — but first: one more extreme push so Customs writes you as inevitable, not lucky. One contract.",
        goal: { desc: "Complete 1 more contract", done: (s, b) => (s.stats.contractsDone || 0) - b.contracts >= 1 },
        reward: { credits: 12000, item: "rare" } },
      { key: "a2", text: "Here. Blueprint: The Last Aegis. File it in the Workshop. Craft once — the plate burns on completion. If you already forged it in some other life, this packet is ash.",
        choices: [
          { label: "Take the blueprint", reply: "I'll forge it once.",
            ack: "Then don't queue two. The slips remember greed.",
            reward: { blueprint: "bp_ship_last_aegis", set: { aegis_blueprint: true } }, end: true },
        ] },
    ],
  },
];

// Admin-authored missions (edited in the admin console → Missions tab, persisted
// to the cloud via Content). Declarative-only: triggers/goals are { metric, op,
// value } conditions, not functions, so they serialize. Merged with STORYLINES
// by Story.all(). Empty by default; a stored override fills it at boot.
const STORY_CUSTOM = [];
// Admin text overlays for built-in missions (id → { from, outro, steps:{ key|index → fields } }).
const STORY_OVERRIDES = {};

window.Story = Story;
window.STORYLINES = STORYLINES;
window.STORY_CUSTOM = STORY_CUSTOM;
window.STORY_OVERRIDES = STORY_OVERRIDES;
