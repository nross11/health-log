// Compound logging engine.
// The app was built to send each typed entry to an AI model and get back a
// small JSON instruction ("add this food", "set steps", "log these sets").
// This file answers those requests on the device instead, with plain
// parsing rules, so logging needs no AI and no API key. It speaks the same
// JSON the app already understands, so the stored data format is unchanged.
(function (root) {
  "use strict";

  // ---------- shared helpers ----------
  var MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  var WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

  function norm(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9.%\s-]/g, " ").replace(/\s+/g, " ").trim();
  }
  function singular(w) {
    if (w.length > 3 && /ies$/.test(w)) return w.slice(0, -3) + "y";
    if (w.length > 3 && /(ches|shes|xes|oes)$/.test(w)) return w.slice(0, -2);
    if (w.length > 2 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
    return w;
  }
  function words(s) { return norm(s).split(" ").filter(Boolean).map(singular); }
  function num(s) { return Number(String(s).replace(/,/g, "")); }
  function fmt(n) { return String(Math.round(n * 10) / 10); }
  function titleCase(s) {
    return String(s).trim().replace(/\s+/g, " ").replace(/\b([a-z])/g, function (m) { return m.toUpperCase(); });
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parseIso(s) { var p = s.split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(s, n) { var d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); }
  function niceDate(s) {
    var d = parseIso(s);
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }
  function grab(re, text) { var m = re.exec(text); return m ? m[1] : null; }
  function grabJson(label, text) {
    var m = new RegExp("^" + label + ": (.*)$", "m").exec(text);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }
  function lastUserLine(messages) {
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "user") continue;
      var c = messages[i].content;
      if (Array.isArray(c)) return { text: null, hasImage: c.some(function (p) { return p && p.type === "image"; }) };
      var lines = String(c).split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
      return { text: lines[lines.length - 1] || "", earlier: lines.slice(0, -1) };
    }
    return { text: "" };
  }
  function previousUserText(messages) {
    var seen = 0;
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "user" || typeof messages[i].content !== "string") continue;
      var lines = messages[i].content.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
      for (var j = lines.length - 1; j >= 0; j--) { if (seen++ === 1) return lines[j]; }
    }
    return null;
  }

  // ---------- dates: "yesterday", "on nov 19", "saturday", "2 days ago" ----------
  // Returns { date: "YYYY-MM-DD" | null, rest: text without the date words }.
  function pullDate(text, today) {
    var t = " " + text + " ";
    var date = null;
    function take(re, fn) {
      if (date) return;
      var m = re.exec(t);
      if (!m) return;
      var d = fn(m);
      if (d) { date = d; t = t.replace(m[0], " "); }
    }
    take(/\s(?:on\s+)?yesterday\b/i, function () { return addDays(today, -1); });
    take(/\s(?:on\s+)?today\b/i, function () { return today; });
    take(/\s(\d+)\s+days?\s+ago\b/i, function (m) { return addDays(today, -Number(m[1])); });
    take(/\s(?:on\s+)?(\d{4}-\d{2}-\d{2})\b/i, function (m) { return m[1]; });
    take(/\s(?:on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i, function (m) {
      return monthDay(today, MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)), Number(m[2]));
    });
    take(/\s(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i, function (m) {
      return monthDay(today, MONTHS.indexOf(m[2].toLowerCase().slice(0, 3)), Number(m[1]));
    });
    take(/\s(?:(?:on|last)\s+(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\.?|(?:on\s+|last\s+)?(sun|mon|tues|wednes|thurs|fri|satur)day)\b/i, function (m) {
      m[1] = m[1] || m[2];
      var want = WEEKDAYS.indexOf(m[1].toLowerCase().slice(0, 3));
      for (var back = 1; back <= 7; back++) {
        var d = addDays(today, -back);
        if (parseIso(d).getDay() === want) return d;
      }
      return null;
    });
    return { date: date, rest: t.replace(/\s+/g, " ").trim() };
  }
  function monthDay(today, month, day) {
    if (month < 0 || day < 1 || day > 31) return null;
    var y = Number(today.slice(0, 4));
    var s = y + "-" + pad(month + 1) + "-" + pad(day);
    return s > today ? (y - 1) + "-" + pad(month + 1) + "-" + pad(day) : s;
  }

  // ---------- food log ----------
  var ALCOHOL = /\b(beer|ipa|lager|stout|ale|cider|wine|prosecco|champagne|cocktail|margarita|martini|negroni|spritz|vodka|gin|rum|tequila|whiskey|whisky|bourbon|scotch|sake|hard seltzer)\b/i;

  var FOOD_HELP = 'Try "chicken bowl 650/45", "200g yogurt", "weighed 173.5" or "12k steps".';

  function foodEngine(system, messages) {
    var library = grabJson("FOOD LIBRARY", system) || [];
    var logged = (function () {
      var m = /^LOGGED ON [^:]*: (.*)$/m.exec(system);
      try { return m ? JSON.parse(m[1]) : []; } catch (e) { return []; }
    })();
    var today = grab(/^TODAY: (\d{4}-\d{2}-\d{2})/m, system) || iso(new Date());
    var viewing = grab(/^VIEWING: (\d{4}-\d{2}-\d{2})/m, system) || today;
    var stepsLogged = Number(grab(/^STEPS ALREADY LOGGED ON [^:]*: (\d+)/m, system)) || 0;

    var input = lastUserLine(messages).text || "";
    var out = { reply: "", add: [], remove: [], learn: [], weight: null, steps: null, date: null };
    var dated = pullDate(input, today);
    var text = dated.rest;
    if (dated.date) {
      if (dated.date > today) return reply(out, "That date is in the future, so nothing was logged.");
      if (dated.date !== viewing) out.date = dated.date;
    }
    var targetDay = out.date || viewing;
    var dayNote = out.date ? " to " + niceDate(out.date) : "";

    if (!text) return reply(out, "Nothing to log. " + FOOD_HELP);

    // Undo / remove
    if (/^(undo|undo last|remove last|delete last)$/i.test(text)) {
      if (!logged.length || out.date) return reply(out, "Nothing to undo on this day.");
      out.remove.push(logged[logged.length - 1].name);
      return reply(out, "Removed " + logged[logged.length - 1].name + ".");
    }
    var rm = /^(?:remove|delete|undo)\s+(.+)$/i.exec(text);
    if (rm) {
      var hit = findLogged(logged, rm[1]);
      if (!hit) return reply(out, 'Nothing logged matches "' + rm[1] + '".');
      out.remove.push(hit.name);
      return reply(out, "Removed " + hit.name + ".");
    }

    // Save to library: "save greek yogurt 59/10 per 100g", "save egg 70/6 per egg"
    var sv = /^(?:save|learn|remember|add)\s+(.+?)\s+(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(?:g\b)?\s*(?:(?:per|\/|a|each)\s+(.+))?(?:\s+to\s+(?:foods|library))?$/i.exec(text);
    if (sv && /^(save|learn|remember)\b/i.test(text) || (sv && /\bto\s+(foods|library)\b/i.test(text))) {
      var per = (sv[4] || "").replace(/\s+to\s+(foods|library)$/i, "").trim();
      var name = titleCase(sv[1].replace(/\s+to\s+(foods|library)$/i, ""));
      var item = { name: name, cal: Math.round(num(sv[2])), pro: Math.round(num(sv[3])), servingG: null, unitLabel: null, alcohol: ALCOHOL.test(sv[1]) };
      if (/^100\s*g(rams?)?$/i.test(per)) { item.basis = "g"; }
      else { item.basis = "unit"; item.unitLabel = per ? per.replace(/^(1|one|a)\s+/i, "") : "serving"; }
      out.learn.push(item);
      return reply(out, "OK");
    }

    var replies = [];
    var parts = splitItems(text);
    for (var i = 0; i < parts.length; i++) {
      var r = parseFoodPart(parts[i], library, stepsLogged, out);
      if (r.error) return reply({ reply: "", add: [], remove: [], learn: [], weight: null, steps: null, date: null }, r.error);
      replies.push(r.text);
    }
    return reply(out, joinReplies(replies) + dayNote + ".");
  }

  function splitItems(text) {
    var pieces = text.split(/\s*(?:;|\n|\s\+\s|\band then\b)\s*/i).filter(Boolean);
    var outp = [];
    pieces.forEach(function (p) {
      // Split on commas or " and " only when every piece has its own numbers.
      var byComma = p.split(/\s*,\s*(?![0-9]{3}\b)|\s+and\s+/i).filter(Boolean);
      if (byComma.length > 1 && byComma.every(function (b) { return /\d/.test(b) || /^(undo)$/i.test(b); })) outp.push.apply(outp, byComma);
      else outp.push(p);
    });
    return outp;
  }

  function parseFoodPart(part, library, stepsLogged, out) {
    var p = part.trim();

    // Weight: "weighed 173.5", "weight 173.5", "173.5 lb", "w 173.5"
    var w = /^(?:i\s+)?(?:weighed(?:\s+in)?(?:\s+at)?|weight(?:\s+(?:is|was))?|wt|w)\s*:?\s*(\d{2,3}(?:\.\d+)?)\s*(?:lbs?|pounds)?$/i.exec(p) ||
            /^(\d{2,3}(?:\.\d+)?)\s*(?:lbs?|pounds)$/i.exec(p);
    if (w) {
      var lb = num(w[1]);
      if (lb < 100 || lb > 400) return { error: "Weight should be in pounds, between 100 and 400." };
      out.weight = lb;
      return { text: "weight " + fmt(lb) + " lb" };
    }

    // Steps: "12k steps", "12,345 steps", "steps 12000", "another 2k steps", "walked 9000 steps"
    var s = /^(?:i\s+)?(?:walked|did|had|got)?\s*(another|plus|\+)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:more\s+)?steps?$/i.exec(p) ||
            /^steps\s*:?\s*(another|plus|\+)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?$/i.exec(p);
    if (s) {
      var n = num(s[2]) * (s[3] ? 1000 : 1);
      if (s[1]) n += stepsLogged;
      n = Math.round(n);
      if (n <= 0 || n >= 200000) return { error: "That step count looks off." };
      out.steps = n;
      return { text: (s[1] ? "steps, now " : "") + n.toLocaleString("en-US") + (s[1] ? "" : " steps") };
    }

    // Calories/protein given: "chicken bowl 650/45", "650/45 chicken bowl", "burrito 900 cal 40g protein"
    var cp = /^(.*?)\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(?:g)?\s*(.*)$/i.exec(p);
    var cp2 = /^(.*?)\s*(\d+(?:\.\d+)?)\s*(?:cal|cals|kcal|calories)\b[\s,]*(?:(\d+(?:\.\d+)?)\s*(?:g|grams?)?\s*(?:p|pro|protein)\b)?\s*(.*)$/i.exec(p);
    var m = cp || cp2;
    if (m) {
      var name = (m[1] + " " + (m[4] || "")).replace(/\s+/g, " ").replace(/^[-–:,\s]+|[-–:,\s]+$/g, "");
      if (!name) return { error: 'Add a name, like "chicken bowl ' + m[2] + "/" + (m[3] || 0) + '".' };
      var cal = Math.round(num(m[2])), pro = Math.round(num(m[3] || 0));
      if (cal > 5000) return { error: "Calories over 5,000 for one item looks like a typo." };
      // Typed numbers win: keep the name as typed, even if it resembles a saved food.
      out.add.push({ food: null, qty: null, unit: null, name: name, cal: cal, pro: pro, estimate: false, alcohol: ALCOHOL.test(name) });
      return { text: name + " " + cal + " cal / " + pro + "g" };
    }

    // Library food with an amount: "200g yogurt", "yogurt 200g", "2 eggs", "eggs x2", "half a bagel", "yogurt"
    var qty = null, unit = null, rest = p;
    var g1 = /^(\d+(?:\.\d+)?)\s*(?:g|grams?)\s+(?:of\s+)?(.+)$/i.exec(p) || /^(.+?)\s+(\d+(?:\.\d+)?)\s*(?:g|grams?)$/i.exec(p);
    var u1 = /^(\d+(?:\.\d+)?|a|an|one|two|three|four|half(?:\s+an?)?)\s+(?:x\s+)?(.+)$/i.exec(p) || /^(.+?)\s+(?:x\s*)?(\d+(?:\.\d+)?)$/i.exec(p);
    if (g1) {
      var gNum = /^\d/.test(g1[1]) ? g1[1] : g1[2];
      rest = /^\d/.test(g1[1]) ? g1[2] : g1[1];
      qty = num(gNum); unit = "g";
    } else if (u1) {
      var words2 = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, half: 0.5, "half a": 0.5, "half an": 0.5 };
      var a = u1[1], b = u1[2];
      if (/^\d/.test(b) && !/^\d/.test(a)) { rest = a; qty = num(b); }
      else { rest = b; qty = words2[a.toLowerCase()] != null ? words2[a.toLowerCase()] : num(a); }
      unit = "unit";
    }
    var food = matchLibrary(library, rest);
    if (food) {
      var basisG = /100g/.test(String(food.basis));
      if (unit === "g" && !basisG) return { error: food.name + " is saved " + food.basis + ", not per gram. Say how many, or give cal/protein." };
      if (unit === "unit" && basisG && !food.usualPortionG) return { error: food.name + " is saved per 100g. Say how many grams, like \"150g " + food.name.toLowerCase() + "\"." };
      if (unit === "unit" && basisG) { qty = qty * food.usualPortionG; unit = "g"; }
      if (qty == null && basisG && !food.usualPortionG) return { error: food.name + " is saved per 100g. Say how many grams." };
      if (qty == null) { qty = basisG ? food.usualPortionG : 1; unit = basisG ? "g" : "unit"; }
      var factor = unit === "g" ? qty / 100 : qty;
      out.add.push({ food: food.name, qty: qty, unit: unit, name: food.name, cal: Math.round(food.cal * factor), pro: Math.round(food.pro * factor), estimate: false, alcohol: !!food.alcohol });
      return { text: (unit === "g" ? fmt(qty) + "g " : (qty !== 1 ? fmt(qty) + " x " : "")) + food.name };
    }

    if (/^(hi|hey|hello|help|\?)/i.test(p)) return { error: FOOD_HELP };
    return { error: 'I don\'t know "' + p + '". Add cal/protein, like "' + p + ' 400/30", or save it to Foods first.' };
  }

  function matchLibrary(library, name) {
    var q = words(name).join(" ");
    if (!q) return null;
    var exact = library.filter(function (f) { return words(f.name).join(" ") === q; });
    if (exact.length) return exact[0];
    var qw = q.split(" ");
    var hits = library.filter(function (f) {
      var fw = words(f.name);
      return qw.every(function (w) { return fw.indexOf(w) >= 0; });
    });
    return hits.length === 1 ? hits[0] : null;
  }

  function findLogged(logged, name) {
    var q = norm(name);
    for (var i = logged.length - 1; i >= 0; i--) if (norm(logged[i].name) === q) return logged[i];
    var qw = words(name);
    for (var j = logged.length - 1; j >= 0; j--) {
      var lw = words(logged[j].name);
      if (qw.every(function (w) { return lw.indexOf(w) >= 0; })) return logged[j];
    }
    return null;
  }

  function joinReplies(list) {
    return "Logged " + list.join(", ");
  }

  function reply(out, text) { out.reply = text; return out; }

  // ---------- workout sets ----------
  var ALIASES = { db: "dumbbell", dbs: "dumbbell", bb: "barbell", kb: "kettlebell", ohp: "overhead press", rdl: "romanian deadlift", tri: "tricep", tricep: "tricep", triceps: "tricep", bi: "bicep", bicep: "bicep", biceps: "bicep", ext: "extension", pulldown: "pulldown", lat: "lat" };
  var MODIFIERS = ["incline", "side", "lateral", "rear", "split", "decline", "seated", "standing", "close", "wide", "reverse", "single", "one", "low", "high", "cable", "machine", "barbell", "dumbbell", "kettlebell", "smith", "hammer", "front", "sumo", "bulgarian", "lying", "preacher", "landmine", "trap", "ez"];

  function exWords(s) {
    return norm(s).split(" ").filter(Boolean).map(function (w) { return ALIASES[w] || w; }).join(" ").split(" ").map(singular);
  }

  function matchExercise(known, name) {
    var qw = exWords(name);
    if (!qw.length) return { none: true };
    var exact = known.filter(function (k) { return exWords(k.name).join(" ") === qw.join(" "); });
    if (exact.length) return { ex: exact[0] };
    var scored = [];
    known.forEach(function (k) {
      var kw = exWords(k.name);
      if (!qw.every(function (w) { return kw.indexOf(w) >= 0; })) return;
      // A movement-changing word the user didn't say makes it a different exercise...
      // unless it's the only word that tells two variants apart.
      var extraMods = kw.filter(function (w) { return MODIFIERS.indexOf(w) >= 0 && qw.indexOf(w) < 0; });
      scored.push({ ex: k, extra: kw.length - qw.length, mods: extraMods.length });
    });
    if (!scored.length) return { none: true };
    scored.sort(function (a, b) { return a.mods - b.mods || a.extra - b.extra; });
    if (scored.length > 1 && scored[0].mods === scored[1].mods && scored[0].extra === scored[1].extra) {
      return { ambiguous: scored.slice(0, 3).map(function (s) { return s.ex.name; }) };
    }
    // If the best guess needs a movement word the user didn't type and another variant exists, ask.
    if (scored[0].mods > 0 && scored.length > 1) return { ambiguous: scored.slice(0, 3).map(function (s) { return s.ex.name; }) };
    return { ex: scored[0].ex };
  }

  var TRAIN_HELP = 'Try "bench 4x10 at 55", "55x10, 55x9", "plank 45s" or "undo".';

  function trainEngine(system, messages) {
    var known = grabJson("KNOWN EXERCISES", system) || [];
    var session = grabJson("LOGGED THIS SESSION", system) || [];
    var out = { reply: "", sets: [], createExercise: [], removeLast: false };
    var text = (lastUserLine(messages).text || "").trim();

    if (/^(undo|undo last|remove last|delete last|scratch that)$/i.test(text)) {
      if (!session.length) return reply(out, "Nothing to undo.");
      out.removeLast = true;
      return reply(out, "Removed the last set.");
    }

    // "yes" after a "create it?" question
    if (/^(y|yes|yep|yeah|do it|create it|ok|okay)$/i.test(text)) {
      var prev = previousUserText(messages);
      var name = prev && pendingCreate[norm(prev)];
      if (!name) return reply(out, "Yes to what? " + TRAIN_HELP);
      text = "create " + name + " " + prev.slice(prev.toLowerCase().indexOf(name.toLowerCase()) + name.length).trim();
      text = text.trim();
    }

    var created = null;
    var cr = /^(?:create|add)\s+(?:a\s+)?(?:new\s+)?(?:exercise\s+)?(?:called\s+)?(.+?)(?:\s+as\s+an?\s+exercise)?$/i.exec(text);
    if (cr) {
      var specStart = cr[1].search(/\s\d|\s(?:x|bw|bodyweight)\b/i);
      var exName = titleCase(specStart > 0 ? cr[1].slice(0, specStart) : cr[1]);
      var spec = specStart > 0 ? cr[1].slice(specStart).trim() : "";
      if (!known.some(function (k) { return k.name.toLowerCase() === exName.toLowerCase(); })) {
        out.createExercise.push(exName);
        known = known.concat([{ name: exName, timed: false }]);
      }
      created = exName;
      if (!spec) return reply(out, "Created " + exName + ".");
      text = exName + " " + spec;
    }

    var parsed = parseSets(text);
    if (parsed.error) return reply(out, parsed.error);

    var exercise;
    if (parsed.name) {
      var mt = matchExercise(known, parsed.name);
      if (mt.ambiguous) return reply(out, "Which one: " + mt.ambiguous.join(", ") + "?");
      if (mt.none) {
        var cand = titleCase(parsed.name);
        pendingCreate[norm(text)] = cand;
        return reply(out, 'No exercise called "' + cand + '". Say yes to create it.');
      }
      exercise = mt.ex;
    } else {
      var last = session[session.length - 1];
      if (!last) return reply(out, "Which exercise? " + TRAIN_HELP);
      exercise = known.filter(function (k) { return k.name === last.exercise; })[0] || { name: last.exercise };
    }

    var timed = !!exercise.timed || parsed.timed;
    parsed.sets.forEach(function (s) {
      out.sets.push({ exercise: exercise.name, reps: s.reps, weight: timed ? 0 : s.weight, unit: timed ? "sec" : "reps" });
    });
    var first = parsed.sets[0];
    var allSame = parsed.sets.every(function (s) { return s.reps === first.reps && s.weight === first.weight; });
    var desc = timed ? first.reps + " sec"
      : first.reps + " reps" + (first.weight ? " x " + fmt(first.weight) + " lb" : "");
    var count = parsed.sets.length;
    var msg = (created && out.createExercise.length ? "Created " + created + ". " : "") +
      exercise.name + ": " + (count === 1 ? desc : allSame ? count + " sets of " + desc : count + " sets");
    return reply(out, msg + ".");
  }
  var pendingCreate = {};

  // Parses set descriptions. Returns { name, sets: [{reps, weight}], timed } or { error }.
  function parseSets(text) {
    var t = " " + text.toLowerCase().replace(/[,;]+/g, " , ").replace(/\s+/g, " ") + " ";
    t = t.replace(/(\d)\s*(?:lbs?|pounds|#)\b/g, "$1 lb ").replace(/@/g, " at ");
    var timed = /\d\s*(s|sec|secs|seconds?)\b/.test(t) || /\b(\d+)\s*min\b/.test(t);
    var sets = [];
    var firstNum = t.search(/\s(?:x\s*)?\d/);
    var name = (firstNum >= 0 ? t.slice(0, firstNum) : t).replace(/\b(at|for|of|sets?|reps?|x)\s*$/g, "").trim();
    var spec = firstNum >= 0 ? t.slice(firstNum) : "";
    if (!spec.trim()) return { error: "How many reps and what weight? " + TRAIN_HELP };

    var bw = /\b(bw|bodyweight|body weight)\b/.test(spec);
    var weightAt = /\bat\s+(\d+(?:\.\d+)?)/.exec(spec) || /(\d+(?:\.\d+)?)\s*lb\b/.exec(spec);
    var weight = weightAt ? num(weightAt[1]) : 0;
    var m;

    if (timed) {
      // "plank 45s", "plank 3x45s", "3 sets of 60 sec"
      if ((m = /(\d+)\s*x\s*(\d+)\s*(?:s|sec|secs|seconds?)\b/.exec(spec)) || (m = /(\d+)\s*sets?\s*(?:of\s*)?(\d+)\s*(?:s|sec|secs|seconds?)\b/.exec(spec))) {
        for (var i = 0; i < Number(m[1]); i++) sets.push({ reps: Number(m[2]), weight: 0 });
      } else if ((m = /(\d+)\s*min/.exec(spec))) {
        sets.push({ reps: Number(m[1]) * 60, weight: 0 });
      } else {
        var secs = spec.match(/(\d+)\s*(?:s|sec|secs|seconds?)\b/g) || [];
        secs.forEach(function (s) { sets.push({ reps: parseInt(s, 10), weight: 0 }); });
      }
    } else if ((m = /(\d+)\s*x\s*(\d+)\s*x\s*(\d+(?:\.\d+)?)/.exec(spec))) {
      // "4x10x55" = sets x reps x weight
      for (var a = 0; a < Number(m[1]); a++) sets.push({ reps: Number(m[2]), weight: num(m[3]) });
    } else if ((m = /(\d+)\s*sets?\s*(?:of\s*)?(\d+)(?:\s*reps?)?/.exec(spec)) || (m = /(\d+)\s*reps?\s*(?:x\s*\d+(?:\.\d+)?\s*lb\s*)?,?\s*(\d+)\s*sets?/.exec(spec) && [null, /(\d+)\s*sets?/.exec(spec)[1], /(\d+)\s*reps?/.exec(spec)[1]])) {
      // "3 sets of 10 at 50", "10 reps x 55 lb, 3 sets"
      for (var b = 0; b < Number(m[1]); b++) sets.push({ reps: Number(m[2]), weight: bw ? 0 : weight });
    } else if ((m = /(\d+)\s*x\s*(\d+)\s*(?:reps?)?\s*(?:at|lb)\s*(\d+(?:\.\d+)?)?/.exec(spec)) && /\bat\b/.test(spec)) {
      // "4x10 at 55" = sets x reps at weight
      for (var c = 0; c < Number(m[1]); c++) sets.push({ reps: Number(m[2]), weight: weight });
    } else if (/\d+(?:\.\d+)?\s*x\s*\d+/.test(spec)) {
      // "55x10, 55x10, 50x8" = weight x reps per set; small first number = sets x reps (bodyweight)
      var pairs = spec.match(/\d+(?:\.\d+)?\s*x\s*\d+/g);
      if (pairs.length === 1) {
        var pp = pairs[0].split("x").map(function (s) { return num(s.trim()); });
        if (pp[0] <= 10 && !/lb/.test(spec)) {
          for (var d = 0; d < pp[0]; d++) sets.push({ reps: pp[1], weight: bw ? 0 : weight });
        } else {
          sets.push({ reps: pp[1], weight: pp[0] });
        }
      } else {
        pairs.forEach(function (pr) {
          var q = pr.split("x").map(function (s) { return num(s.trim()); });
          sets.push({ reps: q[1], weight: q[0] });
        });
      }
    } else if ((m = /(\d+)\s*reps?/.exec(spec))) {
      // "10 reps at 50", "12 reps bw"
      sets.push({ reps: Number(m[1]), weight: bw ? 0 : weight });
    } else if ((m = /^\s*(\d+)\s*$/.exec(spec))) {
      sets.push({ reps: Number(m[1]), weight: 0 });
    }

    sets = sets.filter(function (s) { return s.reps > 0 && s.reps < 1000 && s.weight >= 0 && s.weight < 2000; });
    if (!sets.length) return { error: "Couldn't read the sets. " + TRAIN_HELP };
    if (sets.length > 20) return { error: "That's more than 20 sets. Check the numbers." };
    return { name: name || null, sets: sets, timed: timed };
  }

  // ---------- the stand-in for the AI endpoint ----------
  function respond(body) {
    var system = String(body.system || "");
    var messages = Array.isArray(body.messages) ? body.messages : [];
    var result;
    if (/logging engine for a food tracker/.test(system)) result = foodEngine(system, messages);
    else if (/logging engine for a workout tracker/.test(system)) result = trainEngine(system, messages);
    else if (/which muscle group an exercise primarily trains/.test(system)) result = {}; // pick muscles from the dropdown instead
    else return { status: 501, error: "Screenshot import is turned off for now. Log sets by typing them, or wait for the Fitbod connection." };
    return { status: 200, result: result };
  }

  var api = { respond: respond, foodEngine: foodEngine, trainEngine: trainEngine, parseSets: parseSets, pullDate: pullDate };

  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }
  root.compoundEngine = api;

  // Answer the app's AI requests locally.
  var realFetch = root.fetch.bind(root);
  root.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url !== "/api/ai") return realFetch(input, init);
    var body = {};
    try { body = JSON.parse((init && init.body) || "{}"); } catch (e) {}
    var r;
    try { r = respond(body); } catch (e) { r = { status: 500, error: "Couldn't read that. " + FOOD_HELP }; }
    var payload = r.status === 200
      ? { content: [{ type: "text", text: JSON.stringify(r.result) }] }
      : { type: "error", error: { message: r.error } };
    return Promise.resolve(new Response(JSON.stringify(payload), { status: r.status, headers: { "Content-Type": "application/json" } }));
  };
})(typeof window !== "undefined" ? window : this);
