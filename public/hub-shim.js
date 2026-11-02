/*
 * hub-shim.js — connects the Schedule Hub page to Supabase.
 *
 * The page was written for claude.ai, where it calls window.claude.use("db"),
 * use("user") and use("downloads"). This file provides those same calls,
 * backed by Supabase, so the page code stays almost unchanged:
 *
 *   db.doc("schedule/main")  → public.schedule_documents (live, versioned)
 *   db.doc("schedule/log")   → public.schedule_history (read-only change history)
 *   user.can / id / profiles → public.profiles and the signed-in user's role
 *   downloads.save           → a normal browser download
 *
 * Saves go through the save_document() function, which rejects a save made
 * from an out-of-date copy, so two editors can't silently overwrite each other.
 */
(function () {
  "use strict";

  var POLL_MS = 60000; // safety net in case a live update is missed
  var versions = {};   // path -> version this browser last saw from the server
  var shown = {};      // path -> version last handed to the page
  var refreshers = {}; // path -> function that re-fetches and emits

  function snap(data) { return { exists: data != null, data: function () { return data; } }; }
  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }

  function ctx() { return window.PCCAuth.ready; }

  // ---------- account bar ----------
  var ROLE_LABEL = { viewer: "Viewer", editor: "Editor", admin: "Admin" };
  function accountBar(c) {
    var p = c.profile;
    if (document.getElementById("pcc-acct")) return;
    var css = document.createElement("style");
    css.textContent =
      "#pcc-acct{background:var(--surface-2);border-bottom:1px solid var(--line);font-size:.82rem;color:var(--muted)}" +
      "#pcc-acct .in{display:flex;gap:.25rem .9rem;align-items:center;justify-content:flex-end;flex-wrap:wrap;min-height:32px;padding-top:4px;padding-bottom:4px}" +
      "#pcc-acct b{color:var(--text);font-weight:600}" +
      "#pcc-acct button,#pcc-acct a{background:none;border:0;padding:0;font:inherit;color:var(--brand);cursor:pointer;text-decoration:underline}" +
      "#pcc-acct .role{border:1px solid var(--line);border-radius:999px;padding:0 8px;background:var(--surface)}" +
      "@media print{#pcc-acct{display:none}}";
    document.head.appendChild(css);
    var bar = document.createElement("div");
    bar.id = "pcc-acct";
    bar.innerHTML =
      '<div class="wrap in"><span>Signed in as <b></b></span><span class="role"></span>' +
      '<button type="button" data-a="name"></button>' +
      (p.role === "admin" ? '<a href="admin.html">Manage users &amp; history</a>' : "") +
      '<button type="button" data-a="out">Sign out</button></div>';
    bar.querySelector("b").textContent = p.full_name || p.email;
    bar.querySelector(".role").textContent = ROLE_LABEL[p.role] || p.role;
    var nameBtn = bar.querySelector('[data-a="name"]');
    nameBtn.textContent = p.full_name ? "Change name" : "Add your name";
    nameBtn.addEventListener("click", function () {
      var v = window.prompt("Your name, as it should appear in the change history:", p.full_name || "");
      if (v == null) return;
      window.PCCAuth.client.rpc("update_my_name", { p_name: v }).then(function (res) {
        if (res.error) return window.alert("Couldn't save your name: " + res.error.message);
        p.full_name = v.trim() || null;
        bar.querySelector("b").textContent = p.full_name || p.email;
        nameBtn.textContent = p.full_name ? "Change name" : "Add your name";
      });
    });
    bar.querySelector('[data-a="out"]').addEventListener("click", function () { window.PCCAuth.signOut(); });
    var app = document.getElementById("app");
    app.parentNode.insertBefore(bar, app);
  }

  // ---------- documents ----------
  function client() { return window.PCCAuth.client; }

  function fetchMain(path) {
    return client().from("schedule_documents").select("data,version").eq("path", path).maybeSingle()
      .then(function (res) {
        if (res.error) throw res.error;
        versions[path] = res.data ? res.data.version : 0;
        return res.data ? res.data.data : null;
      });
  }

  function fetchLog() {
    return client().from("schedule_history").select("changed_at,changed_by,summary")
      .eq("path", "schedule/main").order("id", { ascending: false }).limit(300)
      .then(function (res) {
        if (res.error) throw res.error;
        return {
          entries: res.data.map(function (r) { return { at: r.changed_at, by: r.changed_by, summary: r.summary || "Saved" }; }),
        };
      });
  }

  function mapSaveError(e, path) {
    var code = e && e.code, msg = String((e && e.message) || "");
    if (code === "40001" || /version_conflict/.test(msg)) {
      setTimeout(function () { if (refreshers[path]) refreshers[path](true); }, 0);
      return err("conflict", "Someone else saved first.");
    }
    if (code === "42501" || code === "PGRST301") return err("invalid_argument", msg);
    if (code === "54000") return err("quota_exceeded", msg);
    return err("unavailable", msg);
  }

  function docRef(path) {
    var isLog = path === "schedule/log";
    var load = isLog ? fetchLog : function () { return fetchMain(path); };
    return {
      get: function () { return load().then(snap); },

      set: function (data, opts) {
        if (isLog) return Promise.resolve(); // history is written by the database on every save
        return client().rpc("save_document", {
          p_path: path,
          p_data: data,
          p_expected_version: versions[path] || 0,
          p_summary: (opts && opts.summary) || null,
        }).then(function (res) {
          if (res.error) throw mapSaveError(res.error, path);
          versions[path] = res.data;
          shown[path] = res.data; // the page already shows this data
        });
      },

      onSnapshot: function (next, onError) {
        var failures = 0, busy = false, again = false;
        function emit(force) {
          if (busy) { again = true; return; }
          busy = true;
          load().then(function (d) {
            failures = 0;
            if (force || versions[path] !== shown[path]) {
              shown[path] = versions[path];
              next(snap(d));
            }
          }, function (e) {
            failures += 1;
            console.error("Schedule fetch failed", e);
            if (failures === 3 && onError) onError(e);
          }).finally(function () {
            busy = false;
            if (again) { again = false; emit(); }
          });
        }
        refreshers[path] = emit;
        emit();

        var channel = client().channel("doc-" + path.replace(/[^a-z0-9]/gi, "-"))
          .on("postgres_changes",
            { event: "*", schema: "public", table: "schedule_documents", filter: "path=eq." + path },
            function () { emit(); })
          .subscribe(function (status) {
            if (status === "SUBSCRIBED") { failures = 0; emit(); } // catch up after (re)connecting
          });

        var timer = setInterval(function () { if (!document.hidden) emit(); }, POLL_MS);
        function onWake() { if (!document.hidden) emit(); }
        document.addEventListener("visibilitychange", onWake);
        window.addEventListener("online", onWake);

        return function unsubscribe() {
          clearInterval(timer);
          document.removeEventListener("visibilitychange", onWake);
          window.removeEventListener("online", onWake);
          client().removeChannel(channel);
          delete refreshers[path];
        };
      },
    };
  }

  var db = { doc: docRef };

  // ---------- user ----------
  function makeUser(c) {
    var p = c.profile;
    return {
      can: function (perm) {
        return Promise.resolve(perm === "data.write" ? (p.role === "editor" || p.role === "admin") : false);
      },
      id: function () { return Promise.resolve(p.id); },
      profiles: function (ids) {
        if (!ids || !ids.length) return Promise.resolve({});
        return client().from("profiles").select("id,full_name,email").in("id", ids).then(function (res) {
          var out = {};
          (res.data || []).forEach(function (r) { out[r.id] = { name: r.full_name || r.email }; });
          return out;
        });
      },
    };
  }

  // ---------- downloads ----------
  var downloads = {
    save: function (opts) {
      var blob = new Blob([opts.data], { type: "text/plain;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = opts.filename || "download.txt";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return Promise.resolve();
    },
  };

  window.claude = window.claude || {};
  window.claude.use = function (name) {
    return ctx().then(function (c) {
      accountBar(c);
      if (name === "db") return db;
      if (name === "user") return makeUser(c);
      if (name === "downloads") return downloads;
      throw err("unavailable", "Unavailable: " + name);
    });
  };
})();
