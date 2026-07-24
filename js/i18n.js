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
      "nav.exchange": "Exchange", "nav.fleet": "Fleet", "nav.starmap": "Star Map", "nav.systems": "Star Systems", "nav.bazaar": "Bazaar",
      "nav.industries": "Industries", "nav.senate": "Senate", "nav.barons": "Barons",
      "nav.milestones": "Milestones", "nav.comms": "Comms", "nav.hub": "Hub",
      "hub.hint": "Walk with arrows / WASD (or tap) — step up to a station to open it. The tabs below still work too.",
      "hub.open": "Open {x}",
      "systems.title": "Star Systems", "systems.sub": "dock to trade at local prices",
      "exchange.title": "Galactic Exchange",
      "market.commodity": "Commodity", "market.price": "Price", "market.trend": "Trend",
      "market.held": "Held", "market.pnl": "P&L", "market.trade": "Trade",
      "orders.title": "Standing Orders & Alerts", "orders.sub": "auto-fill while you're docked",
      "orders.buyBelow": "Buy below", "orders.sellAbove": "Sell above",
      "orders.alertBelow": "Alert: drops to", "orders.alertAbove": "Alert: rises to",
      "orders.price": "price", "orders.qty": "qty", "orders.add": "Add",
      "orders.empty": "No standing orders. Set a buy-below, sell-above, or price alert — they fire automatically while you're docked here.",
      "exchange.pricesAt": "prices at",
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
      "auth.confirmPass": "Confirm password", "auth.confirmPassPh": "re-enter password",
      "auth.passPh": "at least 8 characters", "auth.forgot": "Forgot password?",
      "auth.ruleLen": "At least 8 characters",
      "auth.ruleNum": "At least 1 number",
      "auth.ruleSpecial": "At least 1 special character",
      "auth.account": "Account", "auth.signedInAs": "Signed in as",
      "auth.signedInNote": "Your progress saves to the cloud automatically.",
      "auth.changePass": "Change password", "auth.signOut": "Sign out", "auth.close": "Close",
      "auth.changePassNote": "Choose a new password for your account.",
      "auth.newPass": "New password", "auth.confirmNewPass": "Confirm new password",
      "auth.updatePass": "Update password", "auth.back": "Back",
      "auth.setNewPass": "Set new password",
      "auth.recoveryNote": "Choose a new password to finish resetting your account.",
      "auth.create": "Create account", "auth.sendReset": "Send reset link",
      "auth.backToLogin": "Back to log in", "auth.working": "Working…",
      "auth.registerNote": "We'll email a confirmation link — confirm before logging in. Your progress syncs after you sign in.",
      "auth.forgotNote": "Enter your account email and we'll send a reset link if it exists.",
      "auth.confirmSent": "Account created — check your email for a confirmation link, then confirm your address before logging in.",
      "auth.resetSent": "If an account exists for that email, a reset link is on its way. Check your inbox (and spam folder).",
      "auth.passUpdated": "Password updated.",
      "auth.errEmail": "Enter a valid email.",
      "auth.errPassLen": "Enter your password.",
      "auth.errPassRules": "Password needs 8+ characters, a number, and a special character.",
      "auth.errPassMatch": "Passwords do not match.",
      "auth.errBadLogin": "Wrong email or password.",
      "auth.errExists": "That email is already registered — try logging in.",
      "auth.errUnconfirmed": "Confirm your email first — check your inbox for the link.",
      "auth.errRate": "Too many attempts — please wait a moment.",
      "auth.errNet": "Network error — check your connection.",
      "auth.errSamePass": "New password must be different from the current one.",
      "auth.signOutConfirm": "Sign out? This device returns to a fresh game. Your progress stays safe in the cloud and comes back when you log in.",
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
      "nav.exchange": "取引所", "nav.fleet": "艦隊", "nav.starmap": "星図", "nav.systems": "星系", "nav.bazaar": "バザール",
      "nav.industries": "産業", "nav.senate": "元老院", "nav.barons": "男爵",
      "nav.milestones": "実績", "nav.comms": "通信", "nav.hub": "拠点",
      "hub.hint": "矢印／WASD（またはタップ）で移動 — 施設に近づいて開く。下のタブも使えます。",
      "hub.open": "{x}を開く",
      "systems.title": "星系", "systems.sub": "ドッキングして現地価格で取引",
      "exchange.title": "銀河取引所",
      "market.commodity": "商品", "market.price": "価格", "market.trend": "傾向",
      "market.held": "保有", "market.pnl": "損益", "market.trade": "取引",
      "orders.title": "指値注文・アラート", "orders.sub": "停泊中に自動で約定します",
      "orders.buyBelow": "指値買い（以下）", "orders.sellAbove": "指値売り（以上）",
      "orders.alertBelow": "アラート：下落で通知", "orders.alertAbove": "アラート：上昇で通知",
      "orders.price": "価格", "orders.qty": "数量", "orders.add": "追加",
      "orders.empty": "指値注文はありません。指値買い・指値売り・価格アラートを設定すると、この地に停泊中は自動で発動します。",
      "exchange.pricesAt": "の相場",
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
      "auth.confirmPass": "パスワード確認", "auth.confirmPassPh": "パスワードを再入力",
      "auth.passPh": "8文字以上", "auth.forgot": "パスワードを忘れた？",
      "auth.ruleLen": "8文字以上",
      "auth.ruleNum": "数字を1つ以上",
      "auth.ruleSpecial": "記号を1つ以上",
      "auth.account": "アカウント", "auth.signedInAs": "サインイン中",
      "auth.signedInNote": "進行状況は自動的にクラウドに保存されます。",
      "auth.changePass": "パスワード変更", "auth.signOut": "サインアウト", "auth.close": "閉じる",
      "auth.changePassNote": "新しいパスワードを設定してください。",
      "auth.newPass": "新しいパスワード", "auth.confirmNewPass": "新しいパスワード確認",
      "auth.updatePass": "パスワードを更新", "auth.back": "戻る",
      "auth.setNewPass": "新しいパスワードを設定",
      "auth.recoveryNote": "アカウント復旧を完了するには、新しいパスワードを設定してください。",
      "auth.create": "アカウント作成", "auth.sendReset": "リセットリンクを送信",
      "auth.backToLogin": "ログインに戻る", "auth.working": "処理中…",
      "auth.registerNote": "確認メールを送信します。ログイン前にメールアドレスを確認してください。サインイン後に進行状況が同期されます。",
      "auth.forgotNote": "アカウントのメールアドレスを入力してください。登録されていればリセットリンクを送信します。",
      "auth.confirmSent": "アカウントを作成しました。確認メールのリンクを開き、メールアドレスを確認してからログインしてください。",
      "auth.resetSent": "そのメールアドレスのアカウントがあれば、リセットリンクを送信しました。受信箱（と迷惑メール）を確認してください。",
      "auth.passUpdated": "パスワードを更新しました。",
      "auth.errEmail": "有効なメールアドレスを入力してください。",
      "auth.errPassLen": "パスワードを入力してください。",
      "auth.errPassRules": "パスワードは8文字以上で、数字と記号をそれぞれ1つ以上含めてください。",
      "auth.errPassMatch": "パスワードが一致しません。",
      "auth.errBadLogin": "メールアドレスまたはパスワードが違います。",
      "auth.errExists": "そのメールアドレスは登録済みです — ログインしてください。",
      "auth.errUnconfirmed": "先にメールアドレスを確認してください — 受信箱のリンクを開いてください。",
      "auth.errRate": "試行回数が多すぎます — しばらく待ってください。",
      "auth.errNet": "ネットワークエラー — 接続を確認してください。",
      "auth.errSamePass": "新しいパスワードは現在のものと違うものにしてください。",
      "auth.signOutConfirm": "サインアウトしますか？この端末は新規ゲームに戻ります。進行状況はクラウドに残っており、ログインすると戻ります。",
    },
  },
};

window.I18n = I18n;
