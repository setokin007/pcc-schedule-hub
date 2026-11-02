/*
 * auth.js — staff sign-in for the PCC Schedule Hub (shared by every page).
 *
 * Staff type their @polynesia.com address, receive a 6-digit code by email,
 * and enter it here. A code (not a clickable link) is used because corporate
 * mail scanners often open links in incoming email, which uses up one-time links.
 *
 * Exposes window.PCCAuth:
 *   client   the Supabase client (signed in once `ready` resolves)
 *   ready    Promise<{ session, profile }> — resolves after a successful sign-in
 *   signOut()
 *
 * The domain check here is only for friendly messages. The real check is in
 * the database (see supabase/migrations), so it can't be bypassed from the browser.
 */
(function () {
  "use strict";

  var cfg = window.PCC_CONFIG || {};
  var DOMAINS = (cfg.allowedDomains || ["polynesia.com"]).map(function (d) { return d.toLowerCase(); });
  var RESEND_SECONDS = 60;

  var resolveReady;
  var ready = new Promise(function (r) { resolveReady = r; });
  var isReady = false;

  function emailAllowed(email) {
    var m = /^[^@\s]+@([a-z0-9.-]+)$/i.exec(String(email || "").trim());
    return !!m && DOMAINS.indexOf(m[1].toLowerCase()) !== -1;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------- styles for the sign-in screen ----------
  var css = "" +
    ".pcc-login{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:16px;" +
    "background:var(--bg,#f2f6f5);color:var(--text,#1c2526);font:15px/1.5 var(--font-body,system-ui,sans-serif)}" +
    ".pcc-login .pl-box{width:100%;max-width:400px;background:var(--surface,#fff);border:1px solid var(--line,#d6e0df);" +
    "border-radius:14px;padding:28px 24px;box-shadow:0 2px 12px rgb(0 0 0/.06)}" +
    ".pcc-login .pl-mark{display:inline-block;background:#0f5c63;border-radius:10px;padding:6px 12px;line-height:0;margin-bottom:16px}" +
    ".pcc-login .pl-mark img{height:40px;width:auto}" +
    ".pcc-login h1{font:700 1.35rem/1.25 var(--font-display,system-ui,sans-serif);margin:0 0 .25rem}" +
    ".pcc-login p{margin:0 0 1rem;color:var(--muted,#5f6b6c)}" +
    ".pcc-login label{display:block;font-weight:500;font-size:.9rem;margin:0 0 .9rem}" +
    ".pcc-login input{display:block;width:100%;margin-top:4px;font:inherit;color:inherit;background:var(--surface,#fff);" +
    "border:1px solid var(--line,#d6e0df);border-radius:8px;padding:10px 12px;box-sizing:border-box}" +
    ".pcc-login input.pl-code{font-size:1.4rem;letter-spacing:.35em;text-align:center;font-variant-numeric:tabular-nums}" +
    ".pcc-login button{font:inherit;cursor:pointer}" +
    ".pcc-login .pl-go{width:100%;background:var(--brand,#0f5c63);color:var(--brand-ink,#fff);border:0;border-radius:8px;" +
    "padding:10px 14px;font-weight:600}" +
    ".pcc-login .pl-go:disabled{opacity:.6;cursor:default}" +
    ".pcc-login .pl-link{background:none;border:0;color:var(--brand,#0f5c63);padding:0;text-decoration:underline}" +
    ".pcc-login .pl-link:disabled{color:var(--muted,#5f6b6c);text-decoration:none;cursor:default}" +
    ".pcc-login .pl-row{display:flex;justify-content:space-between;gap:1rem;margin-top:1rem;font-size:.88rem;flex-wrap:wrap}" +
    ".pcc-login .pl-msg{margin:0 0 1rem;padding:8px 12px;border-radius:8px;font-size:.9rem}" +
    ".pcc-login .pl-msg.err{background:var(--closed-bg,#fdecec);color:var(--danger,#b42318)}" +
    ".pcc-login .pl-msg.ok{background:color-mix(in srgb,var(--brand,#0f5c63) 10%,transparent)}" +
    ".pcc-login .pl-fine{font-size:.8rem;margin:1.25rem 0 0}";

  var root = null;
  function mount() {
    if (root) return root;
    var style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    root = document.createElement("div");
    root.className = "pcc-login";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "pcc-login-title");
    document.body.appendChild(root);
    return root;
  }
  function unmount() { if (root) { root.remove(); root = null; } }

  function frame(inner) {
    return '<div class="pl-box">' +
      (cfg.logo !== false ? '<div class="pl-mark"><img src="logo.webp" alt="Polynesian Cultural Center"></div>' : "") +
      inner + "</div>";
  }

  function showFatal(text) {
    mount().innerHTML = frame('<h1 id="pcc-login-title">Schedule Hub</h1><div class="pl-msg err">' + esc(text) + "</div>");
  }

  // ---------- step 1: email ----------
  function showEmail(message, isError, prefill) {
    mount().innerHTML = frame(
      '<h1 id="pcc-login-title">Sign in to the Schedule Hub</h1>' +
      "<p>Use your " + esc(DOMAINS.map(function (d) { return "@" + d; }).join(" or ")) +
      " email. We'll send you a 6-digit code.</p>" +
      (message ? '<div class="pl-msg ' + (isError ? "err" : "ok") + '" role="status">' + esc(message) + "</div>" : "") +
      '<form novalidate><label>Work email<input type="email" name="email" autocomplete="email" inputmode="email" required ' +
      'placeholder="name@' + esc(DOMAINS[0]) + '" value="' + esc(prefill || "") + '"></label>' +
      '<button class="pl-go" type="submit">Send code</button></form>' +
      '<p class="pl-fine">Staff only. New accounts can view the schedule; an admin gives editing access.</p>'
    );
    var form = root.querySelector("form");
    var input = form.email;
    input.focus();
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var email = input.value.trim().toLowerCase();
      if (!emailAllowed(email)) {
        return showEmail("Please use your " + DOMAINS.map(function (d) { return "@" + d; }).join(" or ") + " email address.", true, email);
      }
      sendCode(email, form.querySelector("button"));
    });
  }

  function sendCode(email, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
    return client.auth.signInWithOtp({ email: email, options: { shouldCreateUser: true } }).then(function (res) {
      if (res.error) {
        var m = String(res.error.message || "");
        var status = res.error.status;
        if (/database error|only @/i.test(m)) return showEmail("That email can't sign in here. Use your work address.", true, email);
        if (status === 429 || /rate|seconds/i.test(m)) return showEmail("Too many attempts. Please wait a minute and try again.", true, email);
        return showEmail("Couldn't send the code: " + m, true, email);
      }
      showCode(email);
    }, function () {
      showEmail("Couldn't reach the sign-in service. Check your connection and try again.", true, email);
    });
  }

  // ---------- step 2: code ----------
  function showCode(email, message, isError) {
    mount().innerHTML = frame(
      '<h1 id="pcc-login-title">Check your email</h1>' +
      "<p>We sent a code to <b>" + esc(email) + "</b>. It expires in a few minutes.</p>" +
      (message ? '<div class="pl-msg ' + (isError ? "err" : "ok") + '" role="status">' + esc(message) + "</div>" : "") +
      '<form novalidate><label>Code<input class="pl-code" name="code" inputmode="numeric" autocomplete="one-time-code" ' +
      'pattern="[0-9]*" maxlength="10" required></label>' +
      '<button class="pl-go" type="submit">Sign in</button></form>' +
      '<div class="pl-row"><button class="pl-link" type="button" data-a="back">Use a different email</button>' +
      '<button class="pl-link" type="button" data-a="resend" disabled>Resend code</button></div>' +
      '<p class="pl-fine">Not in your inbox? Check Junk or Quarantine, or ask IT to allow mail from the sign-in sender.</p>'
    );
    var form = root.querySelector("form");
    var input = form.code;
    var resend = root.querySelector('[data-a="resend"]');
    input.focus();

    var left = RESEND_SECONDS;
    var timer = setInterval(function () {
      left -= 1;
      if (!root || !resend.isConnected) return clearInterval(timer);
      if (left <= 0) { clearInterval(timer); resend.disabled = false; resend.textContent = "Resend code"; }
      else resend.textContent = "Resend code (" + left + "s)";
    }, 1000);
    resend.textContent = "Resend code (" + left + "s)";

    root.querySelector('[data-a="back"]').addEventListener("click", function () { clearInterval(timer); showEmail("", false, email); });
    resend.addEventListener("click", function () {
      clearInterval(timer);
      client.auth.signInWithOtp({ email: email, options: { shouldCreateUser: true } }).then(function (res) {
        showCode(email, res.error ? "Couldn't resend: " + res.error.message : "A new code is on its way.", !!res.error);
      });
    });
    input.addEventListener("input", function () {
      input.value = input.value.replace(/\D/g, "").slice(0, 10);
    });
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var token = input.value.trim();
      if (token.length < 6) return showCode(email, "Enter the code from the email.", true);
      var btn = form.querySelector("button");
      btn.disabled = true; btn.textContent = "Signing in…";
      client.auth.verifyOtp({ email: email, token: token, type: "email" }).then(function (res) {
        if (res.error) {
          var m = String(res.error.message || "");
          if (res.error.status === 429) return showCode(email, "Too many attempts. Wait a minute, then try again.", true);
          return showCode(email, /expired|invalid/i.test(m) ? "That code didn't work or has expired. Try again or resend." : m, true);
        }
        clearInterval(timer);
        finish(res.data.session);
      }, function () { showCode(email, "Couldn't reach the sign-in service. Try again.", true); });
    });
  }

  // ---------- after sign-in ----------
  function loadProfile() {
    return client.rpc("get_me").then(function (res) {
      if (res.error) {
        var e = new Error(res.error.message);
        e.expired = res.status === 401 || /jwt|token/i.test(res.error.message || "");
        throw e;
      }
      return res.data && res.data.id ? res.data : null;
    });
  }

  function finish(session) {
    return loadProfile().then(function (profile) {
      if (!profile) {
        return client.auth.signOut().then(function () {
          showEmail("Your account isn't set up for the Schedule Hub. Ask an admin for help.", true);
        });
      }
      unmount();
      isReady = true;
      resolveReady({ session: session, profile: profile });
    }, function (err) {
      if (err && err.expired) {
        return client.auth.signOut().then(function () { showEmail("Your session expired. Please sign in again.", false); });
      }
      showEmail("Signed in, but couldn't load your access. Check your connection and reload.", true);
    });
  }

  function signOut() {
    return client.auth.signOut().finally(function () { location.reload(); });
  }

  // ---------- start ----------
  var client = null;
  function start() {
    if (!window.supabase || !window.supabase.createClient) return showFatal("The sign-in library didn't load. Reload the page.");
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return showFatal("This site isn't configured yet (missing SUPABASE_URL / SUPABASE_ANON_KEY).");
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    window.PCCAuth.client = client;

    client.auth.onAuthStateChange(function (event) {
      // Signed out in another tab, or the session could not be refreshed.
      if (event === "SIGNED_OUT" && isReady) location.reload();
    });

    client.auth.getSession().then(function (res) {
      var session = res.data && res.data.session;
      if (session) finish(session);
      else showEmail();
    }, function () { showEmail(); });
  }

  window.PCCAuth = { client: null, ready: ready, signOut: signOut, emailAllowed: emailAllowed };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
