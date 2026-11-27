// Health Log sync layer.
// The app reads and writes through window.storage; this file provides that
// object, keeps localStorage as the on-device copy, and syncs the main log
// key with the signed-in user's copy on the server. It loads app.js once the
// user is signed in (or right away when offline, using the local copy).
(function () {
  "use strict";

  var KEY = "foodlog:v5";
  var META = "healthlog:sync";
  var BACKUP = "healthlog:local-backup";
  var PUSH_DELAY = 1200;

  // ---------- small helpers ----------
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function readMeta() {
    try { return Object.assign({ version: 0, dirty: false, email: null }, JSON.parse(lsGet(META) || "{}")); }
    catch (e) { return { version: 0, dirty: false, email: null }; }
  }
  var meta = readMeta();
  function saveMeta() { lsSet(META, JSON.stringify(meta)); }

  function api(path, opts) {
    opts = opts || {};
    var headers = { "Accept": "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(path, {
      method: opts.method || "GET",
      headers: headers,
      credentials: "same-origin",
      cache: "no-store",
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data };
      });
    });
  }

  function backupLocal(value) {
    if (value) lsSet(BACKUP, JSON.stringify({ savedAt: new Date().toISOString(), value: value }));
  }

  // ---------- status pill (only shown when something needs attention) ----------
  var pill;
  function status(text, action) {
    if (!pill) {
      pill = document.createElement("div");
      pill.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 76px);" +
        "z-index:9999;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:999px;padding:6px 14px;" +
        "font:500 12px/1.4 -apple-system,system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4);display:none;cursor:default";
      document.body.appendChild(pill);
    }
    if (!text) { pill.style.display = "none"; return; }
    pill.textContent = text;
    pill.onclick = action || null;
    pill.style.cursor = action ? "pointer" : "default";
    pill.style.display = "block";
  }

  // ---------- pushing local changes ----------
  var pushTimer = null;
  var pushing = null;
  var signedOut = false;

  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, PUSH_DELAY);
  }

  function push() {
    clearTimeout(pushTimer);
    if (pushing) { return pushing.then(function () { if (meta.dirty) return push(); }); }
    if (!meta.dirty || signedOut) return Promise.resolve();
    var value = lsGet(KEY);
    if (value == null) return Promise.resolve();
    var base = meta.version;
    pushing = api("/api/data?key=" + encodeURIComponent(KEY), { method: "PUT", body: { value: value, baseVersion: base } })
      .then(function (r) {
        if (r.status === 200) {
          meta.version = r.data.version;
          // Only clear dirty if nothing changed while we were uploading.
          if (lsGet(KEY) === value) meta.dirty = false;
          saveMeta();
          status(null);
        } else if (r.status === 409) {
          // Another device saved newer data first. Keep ours as a backup, take theirs.
          backupLocal(value);
          adoptServer(r.data);
          meta.conflict = true; saveMeta();
          location.reload();
        } else if (r.status === 401) {
          signedOut = true;
          status("Signed out. Tap to sign in and sync", function () { location.reload(); });
        } else if (r.status === 413) {
          status("Log too large to sync. Saved on this device only");
        } else {
          status("Couldn't sync. Will retry");
        }
      })
      .catch(function () { status("Offline. Changes saved on this device"); })
      .then(function () {
        pushing = null;
        // Retry later if something is still unsent; "online"/foreground events also retry.
        if (meta.dirty && !signedOut) { clearTimeout(pushTimer); pushTimer = setTimeout(push, 15000); }
      });
    return pushing;
  }

  function adoptServer(server) {
    if (server.value != null) lsSet(KEY, server.value);
    meta.version = server.version || 0;
    meta.dirty = false;
    saveMeta();
  }

  // ---------- the storage object the app uses ----------
  window.storage = {
    get: async function (k) { var v = lsGet(k); return v === null ? null : { key: k, value: v }; },
    set: async function (k, v) {
      if (!lsSet(k, v)) return null;
      if (k === KEY) { meta.dirty = true; saveMeta(); schedulePush(); }
      return { key: k, value: v };
    },
    delete: async function (k) { lsDel(k); return { key: k, deleted: true }; },
    list: async function (prefix) {
      prefix = prefix || "";
      var keys = [];
      try { keys = Object.keys(localStorage).filter(function (k) { return k.indexOf(prefix) === 0; }); } catch (e) {}
      return { keys: keys };
    },
  };

  // ---------- first sync on load ----------
  function reconcile() {
    return api("/api/data?key=" + encodeURIComponent(KEY)).then(function (r) {
      if (r.status !== 200) throw new Error("data " + r.status);
      var server = r.data;
      var local = lsGet(KEY);
      if (server.value == null) {
        // Nothing on the server yet: this device's log becomes the synced copy.
        meta.version = 0;
        if (local != null) { meta.dirty = true; saveMeta(); return push(); }
        saveMeta();
        return;
      }
      if (server.version === meta.version) {
        if (meta.dirty) return push();
        return;
      }
      // The server has a different copy. If this device has changes the server
      // never saw (or was never synced), keep a backup before replacing it.
      if (local != null && local !== server.value && (meta.dirty || meta.version === 0)) backupLocal(local);
      adoptServer(server);
    });
  }

  // When the app comes back to the foreground, pick up changes from other devices.
  var checking = false;
  function checkForUpdates() {
    if (checking || signedOut || document.visibilityState !== "visible") return;
    if (meta.dirty) { push(); return; }
    checking = true;
    api("/api/data?meta=1&key=" + encodeURIComponent(KEY)).then(function (r) {
      if (r.status === 401) { signedOut = true; status("Signed out. Tap to sign in and sync", function () { location.reload(); }); return; }
      if (r.status === 200 && r.data.version > meta.version && !meta.dirty) {
        return api("/api/data?key=" + encodeURIComponent(KEY)).then(function (full) {
          if (full.status === 200 && !meta.dirty) { adoptServer(full.data); location.reload(); }
        });
      }
      if (r.status === 200) status(null);
    }).catch(function () {}).then(function () { checking = false; });
  }

  // ---------- sign-in screen ----------
  function showSignIn(config) {
    return new Promise(function (resolve) {
      var root = document.createElement("div");
      root.id = "hl-signin";
      root.style.cssText = "min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;" +
        "padding:24px;background:#111827;color:#e2e8f0;font:15px/1.5 -apple-system,system-ui,sans-serif;text-align:center";
      root.innerHTML =
        '<img src="icon-192.png" alt="" width="72" height="72" style="border-radius:16px">' +
        '<div><div id="hl-name" style="font-size:22px;font-weight:700;color:#f8fafc"></div>' +
        '<div style="color:#94a3b8;margin-top:4px">Sign in to keep your log in sync across your devices.</div></div>' +
        '<div id="hl-gbtn" style="min-height:44px"></div>' +
        '<div id="hl-err" style="color:#f87171;font-size:13px;min-height:20px"></div>';
      document.getElementById("root").appendChild(root);
      root.querySelector("#hl-name").textContent = document.title; // app name lives in index.html
      var err = root.querySelector("#hl-err");

      function done(data) {
        root.remove();
        resolve(data);
      }
      function onCredential(resp) {
        err.textContent = "";
        api("/api/auth/google", { method: "POST", body: { credential: resp.credential } }).then(function (r) {
          if (r.status === 200) done(r.data);
          else if (r.data.error === "not_invited") err.textContent = "This Google account hasn't been invited yet.";
          else err.textContent = "Sign-in didn't work. Please try again.";
        }).catch(function () { err.textContent = "No connection. Check your internet and try again."; });
      }

      var isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
      if (isLocal) {
        var dev = document.createElement("button");
        dev.textContent = "Dev sign-in (local only)";
        dev.style.cssText = "background:#334155;color:#fff;border:0;border-radius:8px;padding:10px 16px;font:inherit";
        dev.onclick = function () {
          api("/api/auth/dev", { method: "POST", body: { email: "dev@example.com" } }).then(function (r) {
            if (r.status === 200) done(r.data); else err.textContent = "Dev sign-in is off (set DEV_LOGIN=1 in .dev.vars).";
          });
        };
        root.insertBefore(dev, err);
      }

      if (!config.googleClientId) {
        if (!isLocal) err.textContent = "Sign-in isn't set up yet.";
        return;
      }
      var s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = function () {
        google.accounts.id.initialize({
          client_id: config.googleClientId,
          callback: onCredential,
          auto_select: true,
          itp_support: true,
        });
        google.accounts.id.renderButton(root.querySelector("#hl-gbtn"), {
          theme: "filled_black", size: "large", shape: "pill", text: "signin_with", width: 260,
        });
      };
      s.onerror = function () { err.textContent = "Couldn't load Google sign-in. Check your connection."; };
      document.head.appendChild(s);
    });
  }

  // ---------- boot ----------
  function loadApp() {
    var s = document.createElement("script");
    s.src = "app.js";
    document.body.appendChild(s);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") checkForUpdates(); else if (meta.dirty) push();
    });
    window.addEventListener("online", function () { if (meta.dirty) push(); else checkForUpdates(); });
    if (meta.conflict) {
      meta.conflict = false; saveMeta();
      status("Another device saved first, so its log was kept. This device's last changes were set aside.", function () { status(null); });
    }
  }

  function boot() {
    api("/api/me").then(function (r) {
      if (r.status === 200) return r.data;
      if (r.status === 401) {
        return api("/api/config").then(function (c) { return showSignIn(c.data || {}); });
      }
      throw new Error("me " + r.status);
    }).then(function (user) {
      // A different person signed in on this device: don't mix their logs.
      if (meta.email && user.email && meta.email !== user.email) {
        backupLocal(lsGet(KEY));
        ["foodlog:v5", "foodlog:v4", "foodlog:v3", "foodlog:v2"].forEach(lsDel);
        meta.version = 0; meta.dirty = false;
      }
      meta.email = user.email; saveMeta();
      return reconcile();
    }).then(function () {
      loadApp();
    }).catch(function () {
      // Offline or server trouble: run on this device's copy and sync later.
      loadApp();
      status("Offline. Changes saved on this device");
    });
  }

  window.healthLogSignOut = function () {
    return api("/api/logout", { method: "POST", body: {} }).then(function () { location.reload(); });
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
