// Compound log helpers: one-tap chips for recent and frequent items,
// autocomplete from Foods and recent entries, and a "save to Foods" offer.
// The Log screen lives in the compiled app.js, so this attaches to its entry
// box from outside and logs by filling the box and pressing the app's own
// "Log it" button. It reads the log from the on-device copy (localStorage).
(function () {
  "use strict";

  var KEY = "foodlog:v5";
  var PLACEHOLDER = "Food, weight, or steps";
  var MAX_CHIPS = 8;
  var MAX_SUGGEST = 6;
  var LOOKBACK_DAYS = 30;

  function readLog() {
    try { return JSON.parse(localStorage.getItem(KEY) || "null") || {}; } catch (e) { return {}; }
  }
  function lc(s) { return String(s || "").toLowerCase().trim(); }
  function fmtNum(n) { return String(Math.round(n * 10) / 10); }

  // The text that logs an entry again, exactly as it was.
  function entryText(e, known) {
    if (e.food && known[lc(e.food)]) {
      var f = known[lc(e.food)];
      if (e.unit === "g" && e.qty) return fmtNum(e.qty) + "g " + f.name;
      if (e.unit === "unit" && e.qty) return (e.qty === 1 ? "" : fmtNum(e.qty) + " ") + f.name;
      return f.name;
    }
    return e.name + " " + (e.estimate ? "~" : "") + Math.round(e.cal || 0) + "/" + Math.round(e.pro || 0);
  }
  function entryLabel(e) {
    var n = String(e.name).charAt(0).toUpperCase() + String(e.name).slice(1);
    return n.length > 26 ? n.slice(0, 25) + "…" : n;
  }

  function knownFoods(log) {
    var map = {};
    (log.known || []).forEach(function (f) { if (f && f.name) map[lc(f.name)] = f; });
    return map;
  }

  // Most-logged items in the last 30 days, ties broken by most recent.
  function recentItems(log) {
    var known = knownFoods(log);
    var days = log.days || {};
    var dates = Object.keys(days).sort().reverse();
    var cutoff = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
    var byText = {};
    var order = 0;
    dates.forEach(function (d) {
      if (d < cutoff) return;
      var entries = (days[d] && days[d].entries) || [];
      for (var i = entries.length - 1; i >= 0; i--) {
        var e = entries[i];
        if (!e || !e.name) continue;
        var text = entryText(e, known);
        var k = lc(text);
        if (!byText[k]) byText[k] = { text: text, label: entryLabel(e), count: 0, last: order, alcohol: !!e.alcohol };
        byText[k].count++;
        order++;
      }
    });
    return Object.keys(byText).map(function (k) { return byText[k]; })
      .sort(function (a, b) { return b.count - a.count || a.last - b.last; });
  }

  function suggestions(log, typed) {
    var q = lc(typed);
    if (q.length < 2 || /\d+\s*\/\s*\d+/.test(q)) return [];
    var words = q.split(/\s+/);
    function hit(name) {
      var n = lc(name);
      return words.every(function (w) { return n.indexOf(w) >= 0; });
    }
    var out = [];
    var seen = {};
    // Saved foods first: tapping one fills the name so an amount can follow.
    (log.known || []).forEach(function (f) {
      if (!f || !f.name || !hit(f.name) || seen[lc(f.name)]) return;
      seen[lc(f.name)] = 1;
      var hint = f.basis === "g" ? "per 100g" : "per " + (f.unitLabel || "serving");
      out.push({ fill: f.name + " ", label: f.name, hint: hint });
    });
    recentItems(log).forEach(function (r) {
      if (!hit(r.label) || seen[lc(r.label)]) return;
      seen[lc(r.label)] = 1;
      out.push({ fill: r.text, label: r.label, hint: "recent" });
    });
    return out.slice(0, MAX_SUGGEST);
  }

  // ---------- talking to the app's entry box ----------
  var setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  function fill(box, text) {
    setValue.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function submit(box, text) {
    fill(box, text);
    // Let React apply the new value before pressing the button.
    setTimeout(function () {
      var btn = box.parentElement && box.parentElement.querySelector('button[aria-label="Log it"]');
      if (btn && !btn.disabled) btn.click();
    }, 0);
  }

  // ---------- UI ----------
  var css = document.createElement("style");
  css.textContent =
    ".cmp-strip{display:flex;gap:6px;overflow-x:auto;padding:0 0 8px;margin:0 -2px;scrollbar-width:none;-webkit-overflow-scrolling:touch}" +
    ".cmp-strip::-webkit-scrollbar{display:none}" +
    ".cmp-strip:empty{display:none}" +
    ".cmp-chip{flex:none;display:inline-flex;align-items:center;gap:6px;max-width:220px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;" +
    "border-radius:999px;padding:6px 11px;font:500 12px/1.2 -apple-system,system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}" +
    ".cmp-chip:active{background:#334155}" +
    ".cmp-chip small{color:#64748b;font-weight:400}" +
    ".cmp-chip.cmp-drink{border-color:rgba(196,181,253,.35)}" +
    ".cmp-chip.cmp-save{border-style:dashed;border-color:#f59e0b;color:#fcd34d;background:transparent}";
  document.head.appendChild(css);

  var strip = document.createElement("div");
  strip.className = "cmp-strip";
  strip.setAttribute("aria-label", "Quick add");
  var pendingSave = null; // { text } offered after a typed cal/protein entry

  function chip(label, hint, cls, onTap, title) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "cmp-chip" + (cls ? " " + cls : "");
    b.textContent = label;
    if (hint) { var s = document.createElement("small"); s.textContent = hint; b.appendChild(s); }
    if (title) b.title = title;
    // Keep focus (and the phone keyboard) on the entry box.
    b.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
    b.addEventListener("click", onTap);
    return b;
  }

  function render(box) {
    var log = readLog();
    var typed = box.value;
    strip.textContent = "";
    if (typed.trim()) {
      suggestions(log, typed).forEach(function (s) {
        strip.appendChild(chip(s.label, s.hint, "", function () { fill(box, s.fill); box.focus(); }, "Fill in " + s.label));
      });
      return;
    }
    if (pendingSave) {
      var ps = pendingSave;
      strip.appendChild(chip("Save " + ps.name + " to Foods", "", "cmp-save", function () {
        pendingSave = null;
        submit(box, "save " + ps.name + " " + ps.cal + "/" + ps.pro + " per serving");
      }, "Next time, just type " + ps.name));
    }
    recentItems(log).slice(0, MAX_CHIPS).forEach(function (r) {
      strip.appendChild(chip(r.label, "", r.alcohol ? "cmp-drink" : "", function () { submit(box, r.text); }, "Log " + r.text + " again"));
    });
  }

  // After a typed "name cal/protein" for a food that isn't saved, offer to save it.
  function noteSubmitted(text) {
    var m = /^(.*?[a-z].*?)\s+(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*g?$/i.exec(String(text || "").trim());
    var eng = window.compoundEngine;
    if (!m || /~\s*$/.test(m[1]) || /^(save|learn|remember|add)\b/i.test(m[1]) ||
        (eng && eng.correction && eng.correction(String(text).trim()))) { pendingSave = null; return; }
    var name = m[1].trim();
    if (/\b(yesterday|today|ago|on\s+\w+)\b/i.test(name)) { pendingSave = null; return; }
    if (knownFoods(readLog())[lc(name)]) { pendingSave = null; return; }
    pendingSave = { name: name, cal: m[2], pro: m[3] };
  }

  var attachedTo = null;
  function attach(box) {
    if (attachedTo === box && strip.isConnected) return;
    attachedTo = box;
    var bar = box.parentElement && box.parentElement.parentElement;
    if (!bar) return;
    bar.insertBefore(strip, bar.firstChild);
    box.addEventListener("input", function () { render(box); });
    box.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) noteSubmitted(box.value);
    });
    var btn = box.parentElement.querySelector('button[aria-label="Log it"]');
    if (btn) btn.addEventListener("click", function () { noteSubmitted(box.value); }, true);
    render(box);
  }

  function scan() {
    var box = document.querySelector('textarea[placeholder="' + PLACEHOLDER + '"]');
    if (box) { attach(box); markCells(); }
  }

  // Re-render after the app saves (its writes land in localStorage).
  var lsSetItem = Storage.prototype.setItem;
  var renderSoon = null;
  Storage.prototype.setItem = function (k, v) {
    lsSetItem.apply(this, arguments);
    if (k === KEY && attachedTo) {
      clearTimeout(renderSoon);
      renderSoon = setTimeout(function () { if (attachedTo && !attachedTo.value.trim()) render(attachedTo); }, 50);
    }
  };

  // ---------- tap the steps or weight tile to type a number ----------
  // The Log header's stat cells are plain divs in app.js; find them by their
  // label ("lb", "steps", "/ 10k steps") and handle taps with one listener.
  function statKind(cell) {
    var label = cell && cell.children[1];
    if (!label) return null;
    var t = label.textContent.trim();
    if (t === "lb" || t === "kg") return "weight";
    if (/steps$/.test(t)) return "steps";
    return null;
  }
  function findStatCell(el) {
    while (el && el !== document.body) {
      if (el.classList && el.classList.contains("min-w-0") && statKind(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  css.textContent +=
    ".cmp-tap{cursor:pointer;border-radius:10px;margin:-6px;padding:6px;-webkit-tap-highlight-color:transparent}" +
    ".cmp-tap:active{background:rgba(148,163,184,.08)}" +
    ".cmp-sheet-bg{position:fixed;inset:0;z-index:9998;background:rgba(2,6,23,.6);display:flex;align-items:flex-end;justify-content:center}" +
    ".cmp-sheet{width:100%;max-width:480px;background:#0f172a;border-top:1px solid #334155;border-radius:16px 16px 0 0;" +
    "padding:18px 16px calc(env(safe-area-inset-bottom,0px) + 18px);font:14px/1.4 -apple-system,system-ui,sans-serif;color:#e2e8f0}" +
    ".cmp-sheet h3{margin:0 0 12px;font-size:15px;font-weight:600}" +
    ".cmp-row{display:flex;gap:8px;align-items:center}" +
    ".cmp-row input{flex:1;min-width:0;background:#1e293b;border:1px solid #334155;border-radius:12px;color:#f1f5f9;" +
    "font:600 22px/1.2 -apple-system,system-ui,sans-serif;padding:10px 12px;outline:none}" +
    ".cmp-row input:focus{border-color:#fbbf24}" +
    ".cmp-unit{color:#64748b;font-size:14px}" +
    ".cmp-btns{display:flex;gap:8px;margin-top:14px}" +
    ".cmp-btns button{flex:1;border:0;border-radius:12px;padding:11px;font:600 14px -apple-system,system-ui,sans-serif;cursor:pointer}" +
    ".cmp-save{background:#fbbf24;color:#0f172a}.cmp-cancel{background:#1e293b;color:#cbd5e1}";

  function markCells() {
    var cells = document.querySelectorAll("div.min-w-0");
    for (var i = 0; i < cells.length; i++) {
      var k = statKind(cells[i]);
      if (k && !cells[i].classList.contains("cmp-tap")) {
        cells[i].classList.add("cmp-tap");
        cells[i].setAttribute("role", "button");
        cells[i].setAttribute("aria-label", k === "steps" ? "Enter steps" : "Enter weight");
      }
    }
  }

  function openNumberSheet(kind) {
    var box = attachedTo;
    if (!box || !box.isConnected) return;
    var bg = document.createElement("div");
    bg.className = "cmp-sheet-bg";
    var unit = kind === "steps" ? "steps" : "lb";
    bg.innerHTML = '<form class="cmp-sheet"><h3></h3><div class="cmp-row"><input type="text" autocomplete="off">' +
      '<span class="cmp-unit"></span></div><div class="cmp-btns"><button type="button" class="cmp-cancel">Cancel</button>' +
      '<button type="submit" class="cmp-save">Save</button></div></form>';
    var form = bg.querySelector("form");
    var input = bg.querySelector("input");
    bg.querySelector("h3").textContent = kind === "steps" ? "Steps for this day" : "Weight";
    bg.querySelector(".cmp-unit").textContent = unit;
    input.setAttribute("inputmode", kind === "steps" ? "numeric" : "decimal");
    input.placeholder = kind === "steps" ? "e.g. 11200" : "e.g. 173.5";
    function close() { if (bg.parentNode) bg.parentNode.removeChild(bg); }
    bg.addEventListener("click", function (ev) { if (ev.target === bg) close(); });
    bg.querySelector(".cmp-cancel").addEventListener("click", close);
    input.addEventListener("keydown", function (ev) { if (ev.key === "Escape") close(); });
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var v = input.value.replace(/,/g, "").trim();
      if (kind === "steps" && /^\d+(\.\d+)?k$/i.test(v)) v = String(Math.round(parseFloat(v) * 1000));
      if (!/^\d+(\.\d+)?$/.test(v)) { input.focus(); input.select(); return; }
      close();
      // Goes through the normal logging path, so it lands on the day being viewed.
      submit(box, kind === "steps" ? "steps " + Math.round(Number(v)) : "weighed " + v);
    });
    document.body.appendChild(bg);
    input.focus();
  }

  document.addEventListener("click", function (ev) {
    var cell = findStatCell(ev.target);
    if (!cell || !attachedTo || !attachedTo.isConnected) return;
    openNumberSheet(statKind(cell));
  });

  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();

  window.compoundLogAssist = { recentItems: recentItems, suggestions: suggestions, entryText: entryText };
})();
