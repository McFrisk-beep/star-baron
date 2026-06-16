/* feed.js — the scrolling alien chat. The standout differentiator: most lines
   are NOISE, a rare OMEN line is real SIGNAL that a news event is coming, and
   the feed visibly REACTS to the player's trades/runs.                        */

const Feed = {
  timer: null,
  lastOmenAt: 0,
  omenMinGapMs: 90 * 1000,   // don't spam omens

  // ---- token templating ---------------------------------------------------
  handle() {
    return Util.pick(NAME_PARTS.pre) + Util.pick(NAME_PARTS.post);
  },

  dirWord(commId) {
    const pct = Market.changePct(commId);
    const bucket = pct > 0.6 ? "up" : pct < -0.6 ? "down" : "flat";
    return Util.pick(DIRWORDS[bucket]);
  },

  fill(tpl, ctx = {}) {
    const c1 = ctx.comm || Util.pick(COMMODITIES);
    let c2 = Util.pick(COMMODITIES);
    if (c2.id === c1.id) c2 = COMMODITIES[(COMMODITIES.indexOf(c2) + 1) % COMMODITIES.length];
    const sys = ctx.sys || Util.pick(SYSTEMS);
    const priceComm = Util.pick(COMMODITIES);
    const pctComm = Util.pick(COMMODITIES);
    const pct = Market.changePct(pctComm.id);
    return tpl
      .replace(/\{COMM2\}/g, c2.name)
      .replace(/\{COMM\}/g, c1.name)
      .replace(/\{SYS\}/g, sys.name)
      .replace(/\{DIR\}/g, this.dirWord(c1.id))
      .replace(/\{HANDLE\}/g, this.handle())
      .replace(/\{PRICE\}/g, Util.price(Market.price(priceComm.id)))
      .replace(/\{PCT\}/g, (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%");
  },

  emit(text, opts = {}) {
    Bus.emit("chat", {
      portrait: opts.portrait ?? Util.randInt(0, CONFIG.portraitCount - 1),
      handle: opts.handle || this.handle(),
      text,
      kind: opts.kind || "banter",
      ts: Date.now(),
    });
  },

  // ---- scheduler ----------------------------------------------------------
  start() {
    this.stop();
    const loop = () => {
      this.tickOne();
      const delay = Util.randInt(CONFIG.chatMinMs, CONFIG.chatMaxMs);
      this.timer = setTimeout(loop, delay);
    };
    // first line soon so the feed isn't empty on load
    this.timer = setTimeout(loop, 1200);
  },
  stop() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } },

  // Fill the feed with a burst of chatter on load so returning players never
  // arrive to an empty channel (purely cosmetic; omens are excluded so we don't
  // schedule phantom news). Called once at boot.
  prime(n = 16) {
    for (let i = 0; i < n; i++) {
      const roll = Math.random();
      if (roll < 0.3) this.postNPC();
      else this.emit(this.fill(Util.pick(CHAT_LINES)), { kind: "banter" });
    }
  },

  tickOne() {
    const roll = Math.random();
    if (roll < 0.07 && Date.now() - this.lastOmenAt > this.omenMinGapMs) {
      this.postOmen();
    } else if (roll < 0.32) {
      this.postNPC();
    } else {
      this.emit(this.fill(Util.pick(CHAT_LINES)), { kind: "banter" });
    }
  },

  postNPC() {
    const npc = Util.pick(NPCS);
    this.emit(this.fill(Util.pick(npc.lines)), {
      portrait: npc.portrait, handle: npc.handle, kind: "npc",
    });
  },

  // An omen hints a coming news category. If real, the news fires in 5–15 min.
  postOmen() {
    this.lastOmenAt = Date.now();
    const omen = Util.pick(OMENS);
    const tipster = omen.real
      ? Util.pick(NPCS.filter(n => n.mood === "tipster" || n.mood === "veteran"))
      : Util.pick(NPCS.filter(n => n.mood === "scammer"));
    this.emit(this.fill(omen.line), {
      portrait: tipster ? tipster.portrait : Util.randInt(0, CONFIG.portraitCount - 1),
      handle: tipster ? tipster.handle : this.handle(),
      kind: omen.real ? "omen" : "scam",
    });
    if (omen.real && window.Broadcast) {
      const lead = Util.randInt(CONFIG.omenLeadMinMs, CONFIG.omenLeadMaxMs) / (window.Game.timeScale || 1);
      window.Broadcast.scheduleNews(omen.cat, lead);
    }
  },

  // ---- reactions to the player & the market -------------------------------
  react(kind, ctx) {
    const pool = REACTIONS[kind];
    if (!pool) return;
    this.emit(this.fill(Util.pick(pool), ctx), { kind: "reaction" });
  },

  wire() {
    Bus.on("trade", t => {
      if (t.value < 4000) return;                 // only whales get noticed
      const comm = COMMODITIES.find(c => c.id === t.commId);
      this.react(t.side === "buy" ? "bigBuy" : "bigSell", { comm });
    });
    Bus.on("runDone", d => {
      const comm = COMMODITIES.find(c => c.id === d.commId);
      const sys = SYSTEMS.find(s => s.id === d.to);
      this.react("runDone", { comm, sys });
    });
    Bus.on("shipBuy", () => this.react("shipBuy", {}));
    Bus.on("unlock", u => this.react("unlock", { sys: SYSTEMS.find(s => s.id === u.sysId) }));
    Bus.on("marketMove", m => {
      const comm = COMMODITIES.find(c => c.id === m.commId);
      if (m.kind === "newHigh") this.react("newHigh", { comm });
      else if (m.kind === "crash") this.react("crash", { comm });
    });
    Bus.on("news", n => {
      // A fired event gets immediate chatter so the feed and broadcast align.
      const comm = COMMODITIES.find(c => c.cat === n.cat) || Util.pick(COMMODITIES);
      this.emit(this.fill("BREAKING: {COMM} traders are losing their minds rn", { comm }),
        { kind: "reaction" });
    });
  },
};

window.Feed = Feed;
