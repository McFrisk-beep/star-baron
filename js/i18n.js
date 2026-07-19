/* i18n.js — lightweight EN/JP localization for the persistent UI shell.

   No build step, no framework: static HTML carries `data-i18n` (textContent),
   `data-i18n-ph` (placeholder) or `data-i18n-title` (title) keys, and I18n.apply()
   swaps them for the active language. JS-generated labels call I18n.t(key).

   Scope note (ponytail): this covers the always-visible chrome (top bar, nav,
   Exchange, Comms, Star Map, Settings, section headings, common modals) plus the
   Exchange action buttons. Procedural/flavor content (randomized chat, news, TV,
   NPC lines) and data-driven names (commodities, ships, factions in data.js /
   flavor.js) remain English — translating that whole corpus is a separate,
   much larger effort; the framework here makes it extendable when wanted.        */

const I18n = {
  lang: "en",

  s() { return window.Game && Game.state; },

  init() {
    const st = this.s();
    this.lang = (st && st.settings && st.settings.lang === "jp") ? "jp" : "en";
    this.apply();
  },

  set(lang) {
    this.lang = lang === "jp" ? "jp" : "en";
    const st = this.s();
    if (st && st.settings) st.settings.lang = this.lang;
    this.apply();
  },

  // Look up a key for the active language; fall back to English, then the key.
  t(key, fallback) {
    const d = this.dict[this.lang] || this.dict.en;
    if (d && d[key] != null) return d[key];
    if (this.dict.en[key] != null) return this.dict.en[key];
    return fallback != null ? fallback : key;
  },

  // Swap every tagged element in the DOM to the active language.
  apply(root = document) {
    document.documentElement.lang = this.lang === "jp" ? "ja" : "en";
    document.body && document.body.classList.toggle("lang-jp", this.lang === "jp");
    for (const el of root.querySelectorAll("[data-i18n]")) {
      const v = this.t(el.getAttribute("data-i18n"));
      if (v != null) el.textContent = v;
    }
    for (const el of root.querySelectorAll("[data-i18n-ph]")) el.setAttribute("placeholder", this.t(el.getAttribute("data-i18n-ph")));
    for (const el of root.querySelectorAll("[data-i18n-title]")) el.setAttribute("title", this.t(el.getAttribute("data-i18n-title")));
    // let the UI refresh JS-generated labels once it's ready
    if (window.UI && UI.rows && typeof UI.onLangChange === "function") UI.onLangChange();
  },

  dict: {
    en: {
      "brand.sub": "galactic exchange",
      "hud.credits": "Credits", "hud.networth": "Net Worth", "hud.rank": "Rank",
      "hud.location": "Location", "hud.sentiment": "Sentiment", "hud.title": "Title", "hud.cycle": "Cycle",
      "hud.rankTip": "Your place among the galaxy's barons",
      "hud.sentimentTip": "Market sentiment",
      "hud.titleTip": "Your Baron Tier — ascend in the Barons tab",
      "btn.starmap": "🗺 Star Map", "btn.signin": "Sign in", "btn.admin": "🛠 Admin",
      "btn.help": "❔ Help", "btn.settings": "⚙ Settings",
      "nav.exchange": "Exchange", "nav.fleet": "Fleet", "nav.bazaar": "Bazaar",
      "nav.industries": "Industries", "nav.senate": "Senate", "nav.barons": "Barons",
      "nav.milestones": "Milestones", "nav.comms": "Comms",
      "exchange.title": "Galactic Exchange",
      "market.commodity": "Commodity", "market.price": "Price", "market.trend": "Trend",
      "market.held": "Held", "market.pnl": "P&L", "market.trade": "Trade",
      "orders.title": "Standing Orders & Alerts", "orders.sub": "auto-fill while you're docked",
      "orders.buyBelow": "Buy below", "orders.sellAbove": "Sell above",
      "orders.alertBelow": "Alert: drops to", "orders.alertAbove": "Alert: rises to",
      "orders.price": "price", "orders.qty": "qty", "orders.add": "Add",
      "btn.buy": "Buy", "btn.sell": "Sell", "btn.buyMax": "Buy Max", "btn.sellAll": "Sell All",
      "fleet.routes": "Trade Routes", "fleet.missions": "Active Missions", "fleet.reports": "Mission Reports",
      "fleet.owned": "Owned Ships", "fleet.inventory": "Inventory",
      "industries.title": "Industries",
      "industries.legend": "Build factories, mines & farms on planets from the Star Map (open a system, pick a planet). They produce that planet's commodity slowly into your tradeable stock while you're away. Licences depend on your standing with the controlling faction; strikes & faction wars can halt a line.",
      "barons.leaderboard": "Baron Leaderboard",
      "milestones.title": "Milestones",
      "comms.broadcast": "Broadcast", "comms.chat": "Chat", "comms.chatSub": "galactic trader channel",
      "comms.newswire": "NEWSWIRE", "comms.newswireLog": "Newswire log",
      "comms.ticker": "Standby for galactic bulletins…", "comms.signal": "SIGNAL ACQUIRING…",
      "sm.galaxy": "Galaxy", "sm.title": "GALACTIC CHART", "sm.close": "✕ Close",
      "legend.rising": "rising", "legend.falling": "falling", "legend.localEvent": "local event", "legend.tradeHub": "trade hub",
      "chamber.title": "INTERGALACTIC SENATE", "chamber.replay": "▶ Replay vote", "chamber.close": "✕ Close",
      "settings.title": "Settings", "settings.language": "Language",
      "settings.mute": "Mute audio", "settings.reduced": "Reduce motion",
      "settings.reset": "Reset Save", "settings.close": "Close",
      "settings.note": "Cosmocrat · saves to this browser only.",
      "tut.skip": "Skip ✕", "tut.back": "◂ Back", "tut.next": "Next ▸",
      "wywa.title": "While You Were Away", "wywa.collect": "Collect & Continue",
      "trade.title": "Trade Terminal", "trade.close": "Close Trade Screen",
      "common.cancel": "Cancel", "common.ok": "OK", "common.continue": "Continue ▸",
      "auth.title": "Sign in / Register", "auth.login": "Log in", "auth.register": "Register",
      "auth.email": "Email", "auth.password": "Password", "auth.guest": "Play as guest",
      "auth.note": "Your cloud save syncs across every device you log in on.",
    },
    jp: {
      "brand.sub": "銀河取引所",
      "hud.credits": "クレジット", "hud.networth": "純資産", "hud.rank": "順位",
      "hud.location": "現在地", "hud.sentiment": "市況", "hud.title": "称号", "hud.cycle": "サイクル",
      "hud.rankTip": "銀河の男爵たちの中でのあなたの順位",
      "hud.sentimentTip": "市場のセンチメント",
      "hud.titleTip": "あなたの男爵位 —「男爵」タブで昇位できます",
      "btn.starmap": "🗺 星図", "btn.signin": "サインイン", "btn.admin": "🛠 管理",
      "btn.help": "❔ ヘルプ", "btn.settings": "⚙ 設定",
      "nav.exchange": "取引所", "nav.fleet": "艦隊", "nav.bazaar": "バザール",
      "nav.industries": "産業", "nav.senate": "元老院", "nav.barons": "男爵",
      "nav.milestones": "実績", "nav.comms": "通信",
      "exchange.title": "銀河取引所",
      "market.commodity": "商品", "market.price": "価格", "market.trend": "傾向",
      "market.held": "保有", "market.pnl": "損益", "market.trade": "取引",
      "orders.title": "指値注文・アラート", "orders.sub": "停泊中に自動で約定します",
      "orders.buyBelow": "指値買い（以下）", "orders.sellAbove": "指値売り（以上）",
      "orders.alertBelow": "アラート：下落で通知", "orders.alertAbove": "アラート：上昇で通知",
      "orders.price": "価格", "orders.qty": "数量", "orders.add": "追加",
      "btn.buy": "購入", "btn.sell": "売却", "btn.buyMax": "全力買い", "btn.sellAll": "全部売却",
      "fleet.routes": "交易ルート", "fleet.missions": "進行中の任務", "fleet.reports": "任務報告",
      "fleet.owned": "所有艦", "fleet.inventory": "在庫",
      "industries.title": "産業",
      "industries.legend": "星図から惑星に工場・鉱山・農場を建設できます（系を開き、惑星を選択）。留守の間も、その惑星の商品をゆっくりと取引可能な在庫として生産します。許認可は支配派閥との友好度に左右され、ストライキや派閥戦争で操業が止まることもあります。",
      "barons.leaderboard": "男爵ランキング",
      "milestones.title": "実績",
      "comms.broadcast": "放送", "comms.chat": "チャット", "comms.chatSub": "銀河トレーダーチャンネル",
      "comms.newswire": "ニュース速報", "comms.newswireLog": "ニュース速報ログ",
      "comms.ticker": "銀河ニュースを待機中…", "comms.signal": "信号を受信中…",
      "sm.galaxy": "銀河", "sm.title": "銀河図", "sm.close": "✕ 閉じる",
      "legend.rising": "上昇", "legend.falling": "下落", "legend.localEvent": "現地イベント", "legend.tradeHub": "交易拠点",
      "chamber.title": "銀河元老院", "chamber.replay": "▶ 投票を再生", "chamber.close": "✕ 閉じる",
      "settings.title": "設定", "settings.language": "言語",
      "settings.mute": "消音", "settings.reduced": "モーションを軽減",
      "settings.reset": "セーブをリセット", "settings.close": "閉じる",
      "settings.note": "Cosmocrat · セーブはこのブラウザにのみ保存されます。",
      "tut.skip": "スキップ ✕", "tut.back": "◂ 戻る", "tut.next": "次へ ▸",
      "wywa.title": "留守中の出来事", "wywa.collect": "受け取って続行",
      "trade.title": "取引端末", "trade.close": "取引画面を閉じる",
      "common.cancel": "キャンセル", "common.ok": "OK", "common.continue": "続ける ▸",
      "auth.title": "サインイン / 登録", "auth.login": "ログイン", "auth.register": "登録",
      "auth.email": "メールアドレス", "auth.password": "パスワード", "auth.guest": "ゲストとしてプレイ",
      "auth.note": "クラウドセーブは、ログインしたすべての端末で同期されます。",
    },
  },
};

window.I18n = I18n;
