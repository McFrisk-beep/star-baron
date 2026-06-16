/* auth-ui.js — the account button + register/login modal. Talks to Cloud for
   auth and to Store/Game for the save sync. On a successful login/register we
   reconcile the local and cloud saves (keep the newer one) and reload so the
   game boots cleanly from the chosen save. Hidden entirely when cloud is off.  */

const AuthUI = {
  mode: "login",
  busy: false,
  r: {},

  init() {
    const $ = id => document.getElementById(id);
    this.r = {
      btn: $("btn-account"),
      modal: $("auth-modal"),
      out: $("auth-signedout"), in: $("auth-signedin"),
      email: $("auth-email"), pass: $("auth-pass"),
      err: $("auth-err"), submit: $("auth-submit"), cancel: $("auth-cancel"),
      who: $("auth-who"), note: $("auth-note"), title: $("auth-title"),
      signout: $("auth-signout"), close: $("auth-close2"),
      tabs: document.querySelectorAll(".auth-tab"),
    };
    // No backend configured → no account UI at all (pure local/guest game).
    if (!window.Cloud || !Cloud.enabled) { if (this.r.btn) this.r.btn.classList.add("hidden"); return; }

    this.r.btn.classList.remove("hidden");   // reveal once cloud is live
    this.r.btn.onclick = () => this.open();
    this.r.cancel.onclick = () => this.closeModal();
    this.r.close.onclick = () => this.closeModal();
    this.r.signout.onclick = () => this.doSignOut();
    this.r.submit.onclick = () => this.doSubmit();
    this.r.pass.addEventListener("keydown", e => { if (e.key === "Enter") this.doSubmit(); });
    this.r.tabs.forEach(t => t.onclick = () => this.setMode(t.dataset.auth));

    Bus.on("auth", () => this.refresh());
    this.refresh();
  },

  refresh() {
    if (!this.r.btn) return;
    const inUser = Cloud.signedIn();
    this.r.btn.textContent = inUser ? `👤 ${this.short(Cloud.email())}` : "👤 Sign in";
    this.r.btn.classList.toggle("signed-in", inUser);
  },
  short(email) { return email && email.length > 16 ? email.slice(0, 14) + "…" : (email || "account"); },

  open() {
    const inUser = Cloud.signedIn();
    this.r.out.classList.toggle("hidden", inUser);
    this.r.in.classList.toggle("hidden", !inUser);
    this.r.title.textContent = inUser ? "Account" : "Sign in / Register";
    if (inUser) this.r.who.textContent = Cloud.email() || "your account";
    else { this.setMode("login"); this.clearErr(); }
    this.r.modal.classList.remove("hidden");
  },
  closeModal() { this.r.modal.classList.add("hidden"); },

  setMode(mode) {
    this.mode = mode;
    this.r.tabs.forEach(t => t.classList.toggle("active", t.dataset.auth === mode));
    this.r.submit.textContent = mode === "register" ? "Create account" : "Log in";
    this.r.note.textContent = mode === "register"
      ? "We'll create your account and sync your current progress to it."
      : "Your cloud save syncs across every device you log in on.";
    this.clearErr();
  },
  clearErr() { this.r.err.classList.add("hidden"); this.r.err.textContent = ""; },
  showErr(msg) { this.r.err.textContent = msg; this.r.err.classList.remove("hidden"); },
  setBusy(b) { this.busy = b; this.r.submit.disabled = b; this.r.submit.textContent = b ? "Working…" : (this.mode === "register" ? "Create account" : "Log in"); },

  async doSubmit() {
    if (this.busy) return;
    const email = (this.r.email.value || "").trim();
    const pass = this.r.pass.value || "";
    if (!email || !email.includes("@")) return this.showErr("Enter a valid email.");
    if (pass.length < 6) return this.showErr("Password must be at least 6 characters.");
    this.clearErr(); this.setBusy(true);
    try {
      if (this.mode === "register") {
        const res = await Cloud.signUp(email, pass);
        if (!res.session) {   // email-confirmation is on: no session yet
          this.setBusy(false);
          this.showErr("Account created! Check your email to confirm, then log in.");
          this.setMode("login");
          return;
        }
      } else {
        await Cloud.signIn(email, pass);
      }
      const how = await this.syncOnLogin();
      // freeze local writes so the reload loads the synced/cloud save cleanly
      // instead of beforeunload overwriting it with the pre-login state.
      if (window.Game) { Game._noSave = true; if (Game.stopSchedulers) Game.stopSchedulers(); }
      const msg = how === "cloud" ? "Signed in — loading your saved progress…"
        : how === "uploaded" ? "Signed in — your current progress is now saved to this account…"
        : how === "error" ? "Signed in, but cloud is unreachable — check the 'saves' table."
        : "Signed in.";
      UI.toast(msg, how === "error" ? "warn" : "good");
      setTimeout(() => location.reload(), how === "error" ? 1300 : 350);
    } catch (e) {
      this.setBusy(false);
      this.showErr(this.friendly(e));
    }
  },

  // On login: the account's CLOUD save always wins if it exists (the reload then
  // loads it). We only upload the local game when the account has no cloud save
  // yet — i.e. a brand-new account claiming the progress you're holding. This
  // avoids ever clobbering real cloud progress with a fresh post-logout game.
  async syncOnLogin() {
    let remote;
    try { remote = await Cloud.loadRemote(); }
    catch (e) { console.warn("[Auth] remote load failed — leaving cloud untouched:", e); return "error"; }
    if (remote) return "cloud";                       // account has a save → use it
    const local = Store.localLoad();
    if (local) { try { await Cloud.saveRemote(local); } catch (e) {} return "uploaded"; }
    return "fresh";
  },

  async doSignOut() {
    if (this.busy) return;
    if (!confirm("Sign out? This device returns to a fresh game. Your progress stays safe in the cloud and comes back when you log in.")) return;
    this.busy = true;
    // Stop any further local writes BEFORE clearing — otherwise the page's
    // beforeunload/autosave would re-persist the old state right after we wipe it.
    if (window.Game) { Game._noSave = true; if (Game.stopSchedulers) Game.stopSchedulers(); }
    // 1) push the latest state up so nothing is lost, 2) end the session,
    // 3) wipe the local save so the next session starts as a brand-new player.
    try { await Store.flush(window.Game ? Game.snapshot() : null); } catch (e) {}
    try { await Cloud.signOut(); } catch (e) {}
    Store.localClear();
    location.reload();   // boots into defaultState() — base credits, no fleet, etc.
  },

  friendly(e) {
    const m = (e && e.message) ? e.message : String(e);
    if (/invalid login/i.test(m)) return "Wrong email or password.";
    if (/already registered|already exists/i.test(m)) return "That email is already registered — try logging in.";
    if (/rate limit|too many/i.test(m)) return "Too many attempts — please wait a moment.";
    if (/network|fetch/i.test(m)) return "Network error — check your connection.";
    return m;
  },
};

window.AuthUI = AuthUI;
