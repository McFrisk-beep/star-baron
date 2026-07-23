/* auth-ui.js — the account button + register/login modal. Talks to Cloud for
   auth and to Store/Game for the save sync. On a successful login/register we
   reconcile the local and cloud saves (keep the newer one) and reload so the
   game boots cleanly from the chosen save. Hidden entirely when cloud is off.

   Also: confirm-password on register, post-register email confirmation copy,
   forgot-password (Supabase reset email), and change-password while signed in
   (including the PASSWORD_RECOVERY landing from a reset link).                */

const AuthUI = {
  mode: "login",          // login | register | forgot
  busy: false,
  _fromRecovery: false,   // set when opened via a reset-password email link
  r: {},

  t(key, fallback) { return window.I18n ? I18n.t(key, fallback) : (fallback || key); },

  init() {
    const $ = id => document.getElementById(id);
    this.r = {
      btn: $("btn-account"),
      modal: $("auth-modal"),
      out: $("auth-signedout"), in: $("auth-signedin"),
      tabsWrap: $("auth-tabs"),
      email: $("auth-email"), pass: $("auth-pass"), pass2: $("auth-pass2"),
      passWrap: $("auth-pass-wrap"), pass2Wrap: $("auth-pass2-wrap"),
      passRules: $("auth-pass-rules"),
      forgotWrap: $("auth-forgot-wrap"), forgot: $("auth-forgot"),
      err: $("auth-err"), ok: $("auth-ok"),
      submit: $("auth-submit"), cancel: $("auth-cancel"),
      who: $("auth-who"), note: $("auth-note"), title: $("auth-title"),
      signout: $("auth-signout"), close: $("auth-close2"),
      tabs: document.querySelectorAll(".auth-tab"),
      accountHome: $("auth-account-home"),
      changeWrap: $("auth-changepass"),
      changeBtn: $("auth-changepass-btn"),
      changeNote: $("auth-changepass-note"),
      newPass: $("auth-newpass"), newPass2: $("auth-newpass2"),
      newPassRules: $("auth-newpass-rules"),
      changeErr: $("auth-changepass-err"), changeOk: $("auth-changepass-ok"),
      changeSubmit: $("auth-changepass-submit"), changeBack: $("auth-changepass-back"),
    };
    // No backend configured → no account UI at all (pure local/guest game).
    if (!window.Cloud || !Cloud.enabled) { if (this.r.btn) this.r.btn.classList.add("hidden"); return; }

    this.r.btn.classList.remove("hidden");   // reveal once cloud is live
    this.r.btn.onclick = () => this.open();
    this.r.cancel.onclick = () => {
      if (this.mode === "forgot") this.setMode("login");
      else this.closeModal();
    };
    this.r.close.onclick = () => this.closeModal();
    this.r.signout.onclick = () => this.doSignOut();
    this.r.submit.onclick = () => this.doSubmit();
    this.r.forgot.onclick = () => this.setMode("forgot");
    this.r.pass.addEventListener("keydown", e => { if (e.key === "Enter") this.doSubmit(); });
    this.r.pass2.addEventListener("keydown", e => { if (e.key === "Enter") this.doSubmit(); });
    this.r.pass.addEventListener("input", () => this.paintRules(this.r.passRules, this.r.pass.value));
    this.r.tabs.forEach(t => t.onclick = () => this.setMode(t.dataset.auth));

    this.r.changeBtn.onclick = () => this.showChangePass(true);
    this.r.changeBack.onclick = () => this.showChangePass(false);
    this.r.changeSubmit.onclick = () => this.doChangePassword();
    this.r.newPass2.addEventListener("keydown", e => { if (e.key === "Enter") this.doChangePassword(); });
    if (this.r.newPass) {
      this.r.newPass.addEventListener("input", () => this.paintRules(this.r.newPassRules, this.r.newPass.value));
      this.r.newPass.addEventListener("keydown", e => { if (e.key === "Enter") this.doChangePassword(); });
    }

    Bus.on("auth", () => {
      this.refresh();
      if (Cloud.isPasswordRecovery()) this.openRecovery();
    });
    this.refresh();
    if (Cloud.isPasswordRecovery()) this.openRecovery();
  },

  refresh() {
    if (!this.r.btn) return;
    const inUser = Cloud.signedIn();
    this.r.btn.textContent = inUser
      ? `👤 ${this.short(Cloud.email())}`
      : `👤 ${this.t("btn.signin", "Sign in")}`;
    this.r.btn.classList.toggle("signed-in", inUser);
  },
  short(email) { return email && email.length > 16 ? email.slice(0, 14) + "…" : (email || "account"); },

  open() {
    const inUser = Cloud.signedIn();
    this.r.out.classList.toggle("hidden", inUser);
    this.r.in.classList.toggle("hidden", !inUser);
    this.r.title.textContent = inUser
      ? this.t("auth.account", "Account")
      : this.t("auth.title", "Sign in / Register");
    if (inUser) {
      this.r.who.textContent = Cloud.email() || "your account";
      this.showChangePass(!!this._fromRecovery);
    } else {
      this.setMode("login");
      this.clearMsg();
    }
    this.r.modal.classList.remove("hidden");
  },
  closeModal() {
    this.r.modal.classList.add("hidden");
    this._fromRecovery = false;
  },

  // Landing from a Supabase "reset password" email link.
  openRecovery() {
    Cloud.clearPasswordRecovery();
    this._fromRecovery = true;
    this.r.out.classList.add("hidden");
    this.r.in.classList.remove("hidden");
    this.r.title.textContent = this.t("auth.setNewPass", "Set new password");
    this.r.who.textContent = Cloud.email() || "your account";
    this.showChangePass(true);
    if (this.r.changeNote) {
      this.r.changeNote.textContent = this.t(
        "auth.recoveryNote",
        "Choose a new password to finish resetting your account."
      );
    }
    this.r.modal.classList.remove("hidden");
  },

  // Password policy for register + change/reset: 8+, 1 digit, 1 special.
  passRules(pass) {
    const p = pass || "";
    return {
      len: p.length >= 8,
      num: /\d/.test(p),
      special: /[^A-Za-z0-9]/.test(p),
    };
  },
  passStrong(pass) {
    const r = this.passRules(pass);
    return !!(r.len && r.num && r.special);
  },
  paintRules(root, pass) {
    if (!root) return;
    const r = this.passRules(pass);
    for (const box of root.querySelectorAll("input[data-rule]")) {
      const ok = !!r[box.dataset.rule];
      box.checked = ok;
      if (box.parentElement) box.parentElement.classList.toggle("ok", ok);
    }
  },

  showChangePass(on) {
    if (!this.r.accountHome || !this.r.changeWrap) return;
    this.r.accountHome.classList.toggle("hidden", !!on);
    this.r.changeWrap.classList.toggle("hidden", !on);
    this.clearChangeMsg();
    if (on) {
      if (this.r.newPass) this.r.newPass.value = "";
      if (this.r.newPass2) this.r.newPass2.value = "";
      this.paintRules(this.r.newPassRules, "");
      if (!this._fromRecovery && this.r.changeNote) {
        this.r.changeNote.textContent = this.t(
          "auth.changePassNote",
          "Choose a new password for your account."
        );
      }
      this.r.title.textContent = this._fromRecovery
        ? this.t("auth.setNewPass", "Set new password")
        : this.t("auth.changePass", "Change password");
    } else {
      this._fromRecovery = false;
      this.r.title.textContent = this.t("auth.account", "Account");
    }
  },

  setMode(mode) {
    this.mode = mode;
    const isForgot = mode === "forgot";
    const isRegister = mode === "register";
    if (this.r.tabsWrap) this.r.tabsWrap.classList.toggle("hidden", isForgot);
    this.r.tabs.forEach(t => t.classList.toggle("active", t.dataset.auth === mode));
    if (this.r.passWrap) this.r.passWrap.classList.toggle("hidden", isForgot);
    if (this.r.pass2Wrap) this.r.pass2Wrap.classList.toggle("hidden", !isRegister);
    if (this.r.passRules) this.r.passRules.classList.toggle("hidden", !isRegister);
    if (this.r.forgotWrap) this.r.forgotWrap.classList.toggle("hidden", mode !== "login");
    if (this.r.pass) {
      this.r.pass.autocomplete = isRegister ? "new-password" : "current-password";
      if (isForgot) this.r.pass.value = "";
    }
    if (this.r.pass2 && !isRegister) this.r.pass2.value = "";
    if (isRegister) this.paintRules(this.r.passRules, this.r.pass ? this.r.pass.value : "");
    this.r.submit.textContent = this.submitLabel();
    this.r.cancel.textContent = isForgot
      ? this.t("auth.backToLogin", "Back to log in")
      : this.t("auth.guest", "Play as guest");
    this.r.note.textContent = isForgot
      ? this.t("auth.forgotNote", "Enter your account email and we'll send a reset link if it exists.")
      : isRegister
        ? this.t("auth.registerNote", "We'll email a confirmation link — confirm before logging in. Your progress syncs after you sign in.")
        : this.t("auth.note", "Your cloud save syncs across every device you log in on.");
    this.clearMsg();
  },

  submitLabel() {
    if (this.mode === "register") return this.t("auth.create", "Create account");
    if (this.mode === "forgot") return this.t("auth.sendReset", "Send reset link");
    return this.t("auth.login", "Log in");
  },

  clearMsg() {
    this.r.err.classList.add("hidden"); this.r.err.textContent = "";
    if (this.r.ok) { this.r.ok.classList.add("hidden"); this.r.ok.textContent = ""; }
  },
  showErr(msg) {
    if (this.r.ok) { this.r.ok.classList.add("hidden"); this.r.ok.textContent = ""; }
    this.r.err.textContent = msg; this.r.err.classList.remove("hidden");
  },
  showOk(msg) {
    this.r.err.classList.add("hidden"); this.r.err.textContent = "";
    if (!this.r.ok) return;
    this.r.ok.textContent = msg; this.r.ok.classList.remove("hidden");
  },
  clearChangeMsg() {
    if (this.r.changeErr) { this.r.changeErr.classList.add("hidden"); this.r.changeErr.textContent = ""; }
    if (this.r.changeOk) { this.r.changeOk.classList.add("hidden"); this.r.changeOk.textContent = ""; }
  },
  showChangeErr(msg) {
    if (this.r.changeOk) { this.r.changeOk.classList.add("hidden"); this.r.changeOk.textContent = ""; }
    if (!this.r.changeErr) return;
    this.r.changeErr.textContent = msg; this.r.changeErr.classList.remove("hidden");
  },
  showChangeOk(msg) {
    if (this.r.changeErr) { this.r.changeErr.classList.add("hidden"); this.r.changeErr.textContent = ""; }
    if (!this.r.changeOk) return;
    this.r.changeOk.textContent = msg; this.r.changeOk.classList.remove("hidden");
  },

  setBusy(b) {
    this.busy = b;
    this.r.submit.disabled = b;
    this.r.submit.textContent = b ? this.t("auth.working", "Working…") : this.submitLabel();
  },
  setChangeBusy(b) {
    this.busy = b;
    if (this.r.changeSubmit) {
      this.r.changeSubmit.disabled = b;
      this.r.changeSubmit.textContent = b
        ? this.t("auth.working", "Working…")
        : this.t("auth.updatePass", "Update password");
    }
  },

  async doSubmit() {
    if (this.busy) return;
    const email = (this.r.email.value || "").trim();
    const pass = this.r.pass.value || "";
    if (!email || !email.includes("@")) return this.showErr(this.t("auth.errEmail", "Enter a valid email."));

    if (this.mode === "forgot") {
      this.clearMsg(); this.setBusy(true);
      try {
        await Cloud.resetPassword(email);
        this.setBusy(false);
        this.showOk(this.t(
          "auth.resetSent",
          "If an account exists for that email, a reset link is on its way. Check your inbox (and spam folder)."
        ));
      } catch (e) {
        this.setBusy(false);
        this.showErr(this.friendly(e));
      }
      return;
    }

    if (this.mode === "register") {
      this.paintRules(this.r.passRules, pass);
      if (!this.passStrong(pass)) {
        return this.showErr(this.t(
          "auth.errPassRules",
          "Password needs 8+ characters, a number, and a special character."
        ));
      }
      const pass2 = this.r.pass2.value || "";
      if (pass2 !== pass) return this.showErr(this.t("auth.errPassMatch", "Passwords do not match."));
    } else if (pass.length < 1) {
      return this.showErr(this.t("auth.errPassLen", "Enter your password."));
    }

    this.clearMsg(); this.setBusy(true);
    try {
      if (this.mode === "register") {
        const res = await Cloud.signUp(email, pass);
        if (!res.session) {   // email-confirmation is on: no session yet
          this.setBusy(false);
          this.setMode("login");
          this.showOk(this.t(
            "auth.confirmSent",
            "Account created — check your email for a confirmation link, then confirm your address before logging in."
          ));
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

  async doChangePassword() {
    if (this.busy) return;
    const pass = (this.r.newPass && this.r.newPass.value) || "";
    const pass2 = (this.r.newPass2 && this.r.newPass2.value) || "";
    this.paintRules(this.r.newPassRules, pass);
    if (!this.passStrong(pass)) {
      return this.showChangeErr(this.t(
        "auth.errPassRules",
        "Password needs 8+ characters, a number, and a special character."
      ));
    }
    if (pass !== pass2) return this.showChangeErr(this.t("auth.errPassMatch", "Passwords do not match."));
    this.clearChangeMsg(); this.setChangeBusy(true);
    try {
      await Cloud.updatePassword(pass);
      this.setChangeBusy(false);
      const ok = this.t("auth.passUpdated", "Password updated.");
      this.showChangeOk(ok);
      if (window.UI) UI.toast(ok, "good");
      if (this._fromRecovery) {
        this._fromRecovery = false;
        setTimeout(() => {
          this.showChangePass(false);
          this.closeModal();
        }, 700);
      }
    } catch (e) {
      this.setChangeBusy(false);
      this.showChangeErr(this.friendly(e));
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
    if (remote) {
      // Stamp cloud → local BEFORE reload. Otherwise a guest save written after
      // the last Sign out (newer lastSeenAt, 1,500c) can win Store.load()'s
      // "keep newer local" check and then autosave over the real cloud row.
      Store._cloudReady = true;
      Store.localSave(Store._stampOwner(remote));
      return "cloud";
    }
    const local = Store.localLoad();
    if (local) {
      try {
        Store._cloudReady = true;
        Store._stampOwner(local);
        await Cloud.saveRemote(local);
        Store.localSave(local);
      } catch (e) {}
      return "uploaded";
    }
    return "fresh";
  },

  async doSignOut() {
    if (this.busy) return;
    if (!confirm(this.t(
      "auth.signOutConfirm",
      "Sign out? This device returns to a fresh game. Your progress stays safe in the cloud and comes back when you log in."
    ))) return;
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
    if (/invalid login/i.test(m)) return this.t("auth.errBadLogin", "Wrong email or password.");
    if (/already registered|already exists/i.test(m)) {
      return this.t("auth.errExists", "That email is already registered — try logging in.");
    }
    if (/email not confirmed/i.test(m)) {
      return this.t("auth.errUnconfirmed", "Confirm your email first — check your inbox for the link.");
    }
    if (/rate limit|too many/i.test(m)) return this.t("auth.errRate", "Too many attempts — please wait a moment.");
    if (/network|fetch/i.test(m)) return this.t("auth.errNet", "Network error — check your connection.");
    if (/same password|should be different/i.test(m)) {
      return this.t("auth.errSamePass", "New password must be different from the current one.");
    }
    return m;
  },
};

window.AuthUI = AuthUI;
