/** @jsx h */
// Compound Train screen: fast set logging for the gym.
import { h, render, Fragment } from "preact";
import { useState, useEffect, useRef, useMemo } from "preact/hooks";
import {
  MUSCLES, read, write, uid, todayIso, niceDate, sortedWorkouts, openWorkout, exerciseInfo, isTimed,
  workoutExercises, templateName, score, exerciseHistory, bestSet, fmtWeight, fmtSet, fmtDuration,
  weekStart, pref, setPref,
} from "./data.js";

// ---------- small pieces ----------

function useData() {
  const [, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  return [read(), refresh];
}

function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

let changedSinceLoad = false;
function save(mutate) {
  changedSinceLoad = true;
  write(mutate);
}

function Sheet({ title, onClose, children }) {
  return (
    <div class="ct-sheet-wrap" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="ct-sheet" role="dialog" aria-label={title}>
        <div class="ct-sheet-head">
          <span>{title}</span>
          <button class="ct-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Stepper({ value, onChange, step, label, suffix }) {
  const v = Number(value) || 0;
  return (
    <div class="ct-stepper">
      <button class="ct-step" onClick={() => onChange(Math.max(0, Math.round((v - step) * 100) / 100))} aria-label={"Less " + label}>−</button>
      <label class="ct-step-field">
        <input
          type="number"
          inputMode="decimal"
          value={value}
          aria-label={label}
          onFocus={(e) => e.target.select()}
          onInput={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        />
        <span>{suffix}</span>
      </label>
      <button class="ct-step" onClick={() => onChange(Math.round((v + step) * 100) / 100)} aria-label={"More " + label}>+</button>
    </div>
  );
}

// ---------- rest timer ----------

let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.15;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.25);
  } catch (e) {}
  try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
}
function primeAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) {}
}

function RestTimer({ rest, setRest }) {
  const now = useNow(!!rest);
  const fired = useRef(null);
  if (!rest) return null;
  const left = Math.ceil((rest.until - now) / 1000);
  if (left <= 0 && fired.current !== rest.until) { fired.current = rest.until; beep(); }
  const done = left <= 0;
  const pct = Math.max(0, Math.min(1, left / rest.total));
  return (
    <div class={"ct-rest" + (done ? " ct-rest-done" : "")}>
      <div class="ct-rest-bar" style={{ width: pct * 100 + "%" }} />
      <span class="ct-rest-label">{done ? "Rest over" : "Rest " + fmtDuration(left * 1000)}</span>
      <div class="ct-rest-btns">
        {!done && <button onClick={() => setRest({ ...rest, until: rest.until - 15000 })}>−15</button>}
        {!done && <button onClick={() => setRest({ ...rest, until: rest.until + 15000, total: rest.total + 15 })}>+15</button>}
        <button onClick={() => setRest(null)}>{done ? "OK" : "Skip"}</button>
      </div>
    </div>
  );
}

// ---------- exercise card in a session ----------

function ExerciseCard({ data, workout, name, index, count, onLogged, onMenu, onSwap, onHistory, live }) {
  const timed = isTimed(data, name);
  const info = exerciseInfo(data, name);
  const sets = (workout.sets || []).filter((s) => s.exercise === name);
  const history = useMemo(() => exerciseHistory(data, name, workout.id), [data, name, workout.id]);
  const last = history[0];
  const best = bestSet(history);

  // Prefill: same set number last time, else the last set done now, else last time's last set.
  const suggestion = (last && last.sets[sets.length]) || sets[sets.length - 1] || (last && last.sets[last.sets.length - 1]) || null;
  const [weight, setWeight] = useState(suggestion ? suggestion.weight : 0);
  const [reps, setReps] = useState(suggestion ? suggestion.reps : timed ? 30 : 10);
  const [editing, setEditing] = useState(null);
  const lastCount = useRef(sets.length);
  useEffect(() => {
    if (sets.length !== lastCount.current) {
      lastCount.current = sets.length;
      const next = (last && last.sets[sets.length]) || sets[sets.length - 1];
      if (next) { setWeight(next.weight); setReps(next.reps); }
    }
  }, [sets.length]);

  const log = () => {
    const r = Math.round(Number(reps) || 0);
    if (r <= 0) return;
    primeAudio();
    const set = { id: uid(), exercise: name, reps: r, weight: timed ? 0 : Math.max(0, Number(weight) || 0), unit: timed ? "sec" : "reps" };
    const isPr = history.length > 0 && score(set) > Math.max(score(best), ...sets.map(score));
    save((d) => { d.workouts[workout.id].sets = [...(d.workouts[workout.id].sets || []), set]; });
    onLogged(set, isPr);
  };

  const prIds = useMemo(() => {
    let bar = score(best);
    const ids = new Set();
    if (!history.length) return ids;
    for (const s of sets) if (score(s) > bar) { ids.add(s.id); bar = score(s); }
    return ids;
  }, [sets, best, history.length]);

  return (
    <section class={"ct-card" + (sets.length ? " ct-card-active" : "")}>
      <header class="ct-card-head">
        <button class="ct-card-title" onClick={onHistory}>
          <span>{name}</span>
        </button>
        <button class="ct-swap" onClick={onSwap} aria-label={"Swap " + name + " for another exercise"}>⇄ Swap</button>
        <button class="ct-icon" onClick={onMenu} aria-label={"Options for " + name}>⋯</button>
      </header>
      <div class="ct-last">
        {info.muscle && <span class="ct-tag">{info.muscle}</span>}{" "}
        {last ? <Fragment>Last · {niceDate(last.date)}: {last.sets.map(fmtSet).join(", ")}</Fragment> : <span class="ct-dim">First time</span>}
        {best && history.length > 1 && <span class="ct-best"> · Best {fmtSet(best)}</span>}
      </div>
      {sets.length > 0 && (
        <ol class="ct-sets">
          {sets.map((s, i) => (
            <li key={s.id}>
              <button class="ct-set" onClick={() => setEditing(s)}>
                <span class="ct-set-n">{i + 1}</span>
                <span>{s.unit === "sec" ? s.reps + " sec" : (s.weight ? fmtWeight(s.weight) + " lb × " : "") + s.reps + (s.weight ? "" : " reps")}</span>
                {prIds.has(s.id) && <span class="ct-pr">PR</span>}
              </button>
            </li>
          ))}
        </ol>
      )}
      {live !== false && (
        <div class="ct-entry">
          {!timed && <Stepper label="weight" suffix="lb" value={weight} onChange={setWeight} step={pref("weightStep", 5)} />}
          <Stepper label={timed ? "seconds" : "reps"} suffix={timed ? "sec" : "reps"} value={reps} onChange={setReps} step={timed ? 5 : 1} />
          <button class="ct-log" onClick={log} aria-label={"Log set " + (sets.length + 1) + " of " + name}>✓</button>
        </div>
      )}
      {editing && (
        <EditSet set={editing} timed={timed} onClose={() => setEditing(null)} workoutId={workout.id} />
      )}
    </section>
  );
}

function EditSet({ set, timed, workoutId, onClose }) {
  const [weight, setWeight] = useState(set.weight);
  const [reps, setReps] = useState(set.reps);
  const apply = (fn) => { save((d) => { const w = d.workouts[workoutId]; w.sets = fn(w.sets || []); }); onClose(); };
  return (
    <Sheet title={"Edit set · " + set.exercise} onClose={onClose}>
      <div class="ct-sheet-body">
        {!timed && <Stepper label="weight" suffix="lb" value={weight} onChange={setWeight} step={pref("weightStep", 5)} />}
        <Stepper label={timed ? "seconds" : "reps"} suffix={timed ? "sec" : "reps"} value={reps} onChange={setReps} step={timed ? 5 : 1} />
        <div class="ct-row">
          <button class="ct-btn ct-danger" onClick={() => apply((sets) => sets.filter((s) => s.id !== set.id))}>Delete set</button>
          <button class="ct-btn ct-primary" onClick={() => apply((sets) => sets.map((s) => s.id === set.id ? { ...s, weight: timed ? 0 : Number(weight) || 0, reps: Math.max(1, Math.round(Number(reps) || 0)) } : s))}>Save</button>
        </div>
      </div>
    </Sheet>
  );
}

// ---------- pick / create exercise ----------

function ExercisePicker({ data, title, exclude, prefer, onPick, onClose }) {
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [muscle, setMuscle] = useState("");
  const [timed, setTimed] = useState(false);
  const all = (data.exercises || []).filter((e) => !(exclude || []).includes(e.name));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = all.filter((e) => words.every((w) => e.name.toLowerCase().includes(w)))
    // When swapping, exercises for the same muscle come first.
    .sort((a, b) => (prefer ? (b.muscle === prefer) - (a.muscle === prefer) : 0) || a.name.localeCompare(b.name));
  const exact = all.some((e) => e.name.toLowerCase() === q.trim().toLowerCase());
  const create = () => {
    const name = q.trim().replace(/\s+/g, " ").replace(/\b([a-z])/g, (m) => m.toUpperCase());
    if (!name) return;
    save((d) => {
      if (!d.exercises.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
        d.exercises.push({ name, muscle: muscle || null, secondary: null, ...(timed ? { timed: true } : {}) });
      }
    });
    onPick(name);
  };
  return (
    <Sheet title={title} onClose={onClose}>
      <div class="ct-sheet-body">
        <input class="ct-search" placeholder="Search or type a new name" value={q} onInput={(e) => setQ(e.target.value)} autoFocus />
        {!creating && (
          <ul class="ct-list">
            {list.map((e) => (
              <li key={e.name}><button onClick={() => onPick(e.name)}><span>{e.name}</span>{e.muscle && <span class="ct-tag">{e.muscle}</span>}</button></li>
            ))}
            {q.trim() && !exact && (
              <li><button class="ct-create" onClick={() => setCreating(true)}>+ Create “{q.trim()}”</button></li>
            )}
            {!list.length && !q.trim() && <li class="ct-dim">No exercises yet. Type a name to create one.</li>}
          </ul>
        )}
        {creating && (
          <div class="ct-create-form">
            <label>Main muscle
              <select value={muscle} onChange={(e) => setMuscle(e.target.value)}>
                <option value="">—</option>
                {MUSCLES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label class="ct-check"><input type="checkbox" checked={timed} onChange={(e) => setTimed(e.target.checked)} /> Timed hold (log seconds)</label>
            <button class="ct-btn ct-primary" onClick={create}>Create and add</button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

// ---------- history for one exercise ----------

function ExerciseHistory({ data, name, onClose }) {
  const history = exerciseHistory(data, name, null);
  const best = bestSet(history);
  const points = history.slice(0, 20).reverse().map((h) => Math.max(...h.sets.map(score)));
  const info = exerciseInfo(data, name);
  const setMuscle = (m) => save((d) => { const e = d.exercises.find((x) => x.name === name); if (e) e.muscle = m || null; });
  return (
    <Sheet title={name} onClose={onClose}>
      <div class="ct-sheet-body">
        <div class="ct-stats">
          <div><b>{history.length}</b><span>sessions</span></div>
          <div><b>{best ? fmtSet(best) : "—"}</b><span>best set</span></div>
          <label><span>muscle</span>
            <select value={info.muscle || ""} onChange={(e) => setMuscle(e.target.value)}>
              <option value="">—</option>
              {MUSCLES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        </div>
        {points.length > 1 && <Spark points={points} />}
        <ul class="ct-hist">
          {history.map((hh) => (
            <li key={hh.id}><span class="ct-hist-date">{niceDate(hh.date)}</span><span>{hh.sets.map(fmtSet).join(", ")}</span></li>
          ))}
          {!history.length && <li class="ct-dim">No sets logged yet.</li>}
        </ul>
      </div>
    </Sheet>
  );
}

function Spark({ points }) {
  const w = 300, hgt = 60, min = Math.min(...points), max = Math.max(...points), span = max - min || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * (w - 8) + 4, hgt - 6 - ((p - min) / span) * (hgt - 12)]);
  return (
    <svg class="ct-spark" viewBox={`0 0 ${w} ${hgt}`} role="img" aria-label="Best set per session, oldest to newest">
      <polyline points={xy.map((p) => p.join(",")).join(" ")} fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      {xy.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={i === xy.length - 1 ? 3.5 : 2} fill="currentColor" />)}
    </svg>
  );
}

// ---------- a session (live or past) ----------

function Session({ data, workout, onDone }) {
  const live = !workout.closed;
  const now = useNow(live && !workout.end);
  const [rest, setRest] = useState(null);
  const [menu, setMenu] = useState(null);
  const [picker, setPicker] = useState(null); // { mode: "add" } | { mode: "swap", name }
  const [historyFor, setHistoryFor] = useState(null);
  const [toast, setToast] = useState(null);
  const [text, setText] = useState("");
  const [confirmFinish, setConfirmFinish] = useState(false);
  const names = workoutExercises(data, workout);

  const setOrder = (fn) => save((d) => { const w = d.workouts[workout.id]; w.order = fn(workoutExercises(d, w)); });

  const notStarted = live && !workout.start;
  const startClock = () => save((d) => { const w = d.workouts[workout.id]; if (!w.start) w.start = Date.now(); });
  const discard = () => { save((d) => { delete d.workouts[workout.id]; }); onDone(null); };

  const onLogged = (set, isPr) => {
    if (!workout.start) startClock();
    const secs = pref("restSec", 90);
    if (live && secs > 0) setRest({ until: Date.now() + secs * 1000, total: secs });
    if (isPr) flash("New best for " + set.exercise);
  };
  const flash = (msg) => { setToast(msg); setTimeout(() => setToast((t) => (t === msg ? null : t)), 2500); };

  // Typing shortcut: "bench 4x10 at 55", "55x9", "plank 45s", "undo"
  const submitText = () => {
    const t = text.trim();
    if (!t) return;
    const engine = window.compoundEngine;
    const sys = "You are the logging engine for a workout tracker.\nKNOWN EXERCISES: " +
      JSON.stringify((data.exercises || []).map((e) => ({ name: e.name, muscle: e.muscle, timed: !!e.timed }))) +
      "\nLOGGED THIS SESSION: " + JSON.stringify((workout.sets || []).map((s) => ({ exercise: s.exercise, reps: s.reps, weight: s.weight })));
    const r = engine.trainEngine(sys, [{ role: "user", content: t }]);
    save((d) => {
      const w = d.workouts[workout.id];
      for (const name of r.createExercise || []) {
        if (!d.exercises.some((e) => e.name.toLowerCase() === name.toLowerCase())) d.exercises.push({ name, muscle: null, secondary: null });
      }
      if (r.removeLast && w.sets.length) w.sets = w.sets.slice(0, -1);
      w.sets = [...(w.sets || []), ...(r.sets || []).map((s) => ({ id: uid(), ...s }))];
    });
    setText("");
    flash(r.reply);
    if ((r.sets || []).length) onLogged(r.sets[r.sets.length - 1], false);
  };

  const finish = () => {
    save((d) => { const w = d.workouts[workout.id]; w.end = w.end || Date.now(); w.closed = true; });
    onDone({ summary: workout.id });
  };

  const elapsed = workout.start ? (workout.end || now) - workout.start : 0;
  const sets = workout.sets || [];

  return (
    <div class="ct-session">
      <div class="ct-session-head">
        <button class="ct-back" onClick={() => onDone(null)} aria-label="Back">‹</button>
        <div class="ct-session-title">
          <b>{templateName(data, workout.template)}</b>
          <span class={notStarted ? "ct-setup" : ""}>{notStarted ? "Set up, then tap Start" : live ? fmtDuration(elapsed) : niceDate(workout.date)}{notStarted ? "" : " · " + sets.length + " set" + (sets.length === 1 ? "" : "s")}</span>
        </div>
        {notStarted && !sets.length && <button class="ct-btn ct-quiet" onClick={discard}>Discard</button>}
        {notStarted ? <button class="ct-btn ct-go" onClick={startClock}>▶ Start</button>
          : live ? <button class="ct-btn ct-primary" onClick={() => setConfirmFinish(true)}>Finish</button>
          : <button class="ct-btn" onClick={() => setMenu({ session: true })}>⋯</button>}
      </div>

      <div class="ct-cards">
        {names.map((n, i) => (
          <ExerciseCard key={workout.id + n} data={data} workout={workout} name={n} index={i} count={names.length}
            onLogged={onLogged} onMenu={() => setMenu({ name: n, index: i })} onSwap={() => setPicker({ mode: "swap", name: n })} onHistory={() => setHistoryFor(n)} live />
        ))}
        <button class="ct-add" onClick={() => setPicker({ mode: "add" })}>+ Add exercise</button>
      </div>

      {live && (
        <form class="ct-type" onSubmit={(e) => { e.preventDefault(); submitText(); }}>
          <input placeholder='Or type: "bench 4x10 at 55"' value={text} onInput={(e) => setText(e.target.value)} enterKeyHint="send" />
        </form>
      )}

      <RestTimer rest={rest} setRest={setRest} />
      {toast && <div class="ct-toast" role="status">{toast}</div>}

      {menu && menu.name && (
        <Sheet title={menu.name} onClose={() => setMenu(null)}>
          <div class="ct-menu">
            <button onClick={() => { setHistoryFor(menu.name); setMenu(null); }}>History and muscle</button>
            <button disabled={menu.index === 0} onClick={() => { setOrder((l) => { const a = [...l]; const [x] = a.splice(menu.index, 1); a.splice(menu.index - 1, 0, x); return a; }); setMenu(null); }}>Move up</button>
            <button disabled={menu.index === names.length - 1} onClick={() => { setOrder((l) => { const a = [...l]; const [x] = a.splice(menu.index, 1); a.splice(menu.index + 1, 0, x); return a; }); setMenu(null); }}>Move down</button>
            <button onClick={() => { setPicker({ mode: "swap", name: menu.name }); setMenu(null); }}>Swap for another exercise</button>
            <button class="ct-danger-text" onClick={() => {
              const n = menu.name;
              save((d) => { const w = d.workouts[workout.id]; w.order = workoutExercises(d, w).filter((x) => x !== n); w.sets = (w.sets || []).filter((s) => s.exercise !== n); });
              setMenu(null);
            }}>Remove from this workout{sets.some((s) => s.exercise === menu.name) ? " (deletes its sets)" : ""}</button>
          </div>
        </Sheet>
      )}

      {menu && menu.session && (
        <Sheet title="This workout" onClose={() => setMenu(null)}>
          <div class="ct-menu">
            <button onClick={() => { save((d) => { d.workouts[workout.id].closed = false; d.workouts[workout.id].date = d.workouts[workout.id].date; }); setMenu(null); }}>Reopen for logging</button>
            <button class="ct-danger-text" onClick={() => { if (confirm("Delete this whole workout?")) { save((d) => { delete d.workouts[workout.id]; }); onDone(null); } }}>Delete workout</button>
          </div>
        </Sheet>
      )}

      {picker && (
        <ExercisePicker data={data} title={picker.mode === "swap" ? "Swap " + picker.name : "Add exercise"} exclude={names}
          prefer={picker.mode === "swap" ? exerciseInfo(data, picker.name).muscle : null}
          onClose={() => setPicker(null)}
          onPick={(name) => {
            if (picker.mode === "swap") {
              const old = picker.name;
              save((d) => {
                const w = d.workouts[workout.id];
                w.order = workoutExercises(d, w).map((x) => (x === old ? name : x));
              });
            } else {
              setOrder((l) => [...l, name]);
            }
            setPicker(null);
          }} />
      )}

      {historyFor && <ExerciseHistory data={read()} name={historyFor} onClose={() => setHistoryFor(null)} />}

      {confirmFinish && (
        <Sheet title="Finish workout?" onClose={() => setConfirmFinish(false)}>
          <div class="ct-sheet-body">
            <p class="ct-dim">{sets.length} sets in {fmtDuration(elapsed)}.{!sets.length && " Nothing logged, so this will just close it."}</p>
            <div class="ct-row">
              <button class="ct-btn" onClick={() => setConfirmFinish(false)}>Keep going</button>
              <button class="ct-btn ct-primary" onClick={finish}>Finish</button>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}

// ---------- summary after finishing ----------

function Summary({ data, id, onClose }) {
  const w = data.workouts[id];
  if (!w) return null;
  const names = workoutExercises(data, w).filter((n) => (w.sets || []).some((s) => s.exercise === n));
  const volume = (w.sets || []).reduce((t, s) => t + (s.unit === "sec" ? 0 : s.weight * s.reps), 0);
  const prs = names.filter((n) => {
    const hist = exerciseHistory(data, n, id);
    if (!hist.length) return false;
    const best = score(bestSet(hist));
    return (w.sets || []).some((s) => s.exercise === n && score(s) > best);
  });
  return (
    <div class="ct-summary">
      <h2>Done · {templateName(data, w.template)}</h2>
      <div class="ct-stats">
        <div><b>{(w.sets || []).length}</b><span>sets</span></div>
        <div><b>{w.start && w.end ? fmtDuration(w.end - w.start) : "—"}</b><span>time</span></div>
        <div><b>{Math.round(volume).toLocaleString()}</b><span>lb moved</span></div>
      </div>
      {prs.length > 0 && <p class="ct-pr-line">New bests: {prs.join(", ")}</p>}
      <ul class="ct-hist">
        {names.map((n) => <li key={n}><span class="ct-hist-date">{n}</span><span>{w.sets.filter((s) => s.exercise === n).map(fmtSet).join(", ")}</span></li>)}
      </ul>
      <button class="ct-btn ct-primary ct-wide" onClick={onClose}>Done</button>
    </div>
  );
}

// ---------- home ----------

function Home({ data, onOpen, onStart }) {
  const open = openWorkout(data);
  const all = sortedWorkouts(data).filter((w) => (w.sets || []).length || !w.closed);
  const wk = weekStart(todayIso());
  const thisWeek = all.filter((w) => w.date >= wk && (w.sets || []).length).length;
  const target = (data.settings && data.settings.sessionsPerWeek) || 4;
  const [showAll, setShowAll] = useState(false);
  const [historyFor, setHistoryFor] = useState(null);
  const [exList, setExList] = useState(false);
  const [restOpen, setRestOpen] = useState(false);

  return (
    <div class="ct-home">
      {open ? (
        <button class="ct-resume" onClick={() => onOpen(open.id)}>
          <span>Resume {templateName(data, open.template)}</span>
          <span class="ct-dim">{open.start ? (open.sets || []).length + " sets so far" : "Not started yet"}</span>
        </button>
      ) : (
        <Fragment>
          <div class="ct-label">Start a workout</div>
          <div class="ct-templates">
            {(data.templates || []).map((t) => {
              const last = all.find((w) => w.template === t.id && (w.sets || []).length);
              return (
                <button key={t.id} class="ct-tpl" onClick={() => onStart(t.id)}>
                  <b>{t.name}</b>
                  <span>{last ? "Last " + niceDate(last.date, { month: "short", day: "numeric" }) : t.exercises.length + (t.exercises.length === 1 ? " exercise" : " exercises")}</span>
                </button>
              );
            })}
            <button class="ct-tpl ct-tpl-empty" onClick={() => onStart(null)}><b>Freestyle</b><span>Pick as you go</span></button>
          </div>
        </Fragment>
      )}

      <div class="ct-week">
        <span>This week</span>
        <div class="ct-dots">{Array.from({ length: Math.max(target, thisWeek) }, (_, i) => <i key={i} class={i < thisWeek ? "on" : ""} />)}</div>
        <span class="ct-dim">{thisWeek} of {target}</span>
      </div>

      <div class="ct-label ct-label-row">
        <span>Recent workouts</span>
        <span>
          <button class="ct-link" onClick={() => setExList(true)}>Exercises</button>
          <button class="ct-link" onClick={() => setRestOpen(true)}>Rest {pref("restSec", 90)}s</button>
        </span>
      </div>
      <ul class="ct-recent">
        {all.filter((w) => w.closed).slice(0, showAll ? 200 : 8).map((w) => {
          const exNames = workoutExercises(data, w).filter((n) => (w.sets || []).some((s) => s.exercise === n));
          return (
            <li key={w.id}>
              <button onClick={() => onOpen(w.id)}>
                <span class="ct-recent-top"><b>{templateName(data, w.template)}</b><span class="ct-dim">{niceDate(w.date)}</span></span>
                <span class="ct-dim ct-recent-sub">{(w.sets || []).length} sets{w.start && w.end && w.end - w.start > 60000 ? " · " + Math.round((w.end - w.start) / 60000) + " min" : ""} · {exNames.slice(0, 3).join(", ")}{exNames.length > 3 ? "…" : ""}</span>
              </button>
            </li>
          );
        })}
        {!all.some((w) => w.closed) && <li class="ct-dim ct-empty">Finished workouts show up here.</li>}
      </ul>
      {!showAll && all.filter((w) => w.closed).length > 8 && <button class="ct-link ct-more" onClick={() => setShowAll(true)}>Show all</button>}

      {exList && <ExercisePicker data={data} title="Exercises" onClose={() => setExList(false)} onPick={(n) => { setExList(false); setHistoryFor(n); }} />}
      {historyFor && <ExerciseHistory data={read()} name={historyFor} onClose={() => setHistoryFor(null)} />}
      {restOpen && (
        <Sheet title="Rest between sets" onClose={() => setRestOpen(false)}>
          <div class="ct-sheet-body">
            <div class="ct-chips">
              {[0, 60, 90, 120, 150, 180].map((s) => (
                <button key={s} class={pref("restSec", 90) === s ? "on" : ""} onClick={() => { setPref("restSec", s); setRestOpen(false); }}>{s ? s + "s" : "Off"}</button>
              ))}
            </div>
            <div class="ct-label">Weight buttons step by</div>
            <div class="ct-chips">
              {[1, 2.5, 5, 10].map((s) => (
                <button key={s} class={pref("weightStep", 5) === s ? "on" : ""} onClick={() => { setPref("weightStep", s); setRestOpen(false); }}>{s} lb</button>
              ))}
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}

// ---------- root ----------

function Train() {
  const [data, refresh] = useData();
  const [view, setView] = useState(() => {
    const open = openWorkout(read());
    return open ? { session: open.id } : { home: true };
  });

  // Re-render whenever the shared log changes (our writes, or a sync from another device).
  useEffect(() => {
    const onChange = () => refresh();
    window.addEventListener("compound:changed", onChange);
    return () => window.removeEventListener("compound:changed", onChange);
  }, []);

  // Sessions left open on earlier days are treated as finished.
  useEffect(() => {
    const today = todayIso();
    const stale = sortedWorkouts(read()).filter((w) => !w.closed && w.date < today);
    if (stale.length) save((d) => { for (const w of stale) { d.workouts[w.id].closed = true; d.workouts[w.id].end = d.workouts[w.id].end || d.workouts[w.id].start || null; } });
  }, []);

  const start = (templateId) => {
    const id = "w_" + todayIso() + "_" + uid();
    // Opens in setup: the clock starts when you tap Start (or log the first set).
    save((d) => { d.workouts[id] = { date: todayIso(), template: templateId, start: null, end: null, closed: false, sets: [] }; });
    setView({ session: id });
  };

  if (view.summary) return <Summary data={data} id={view.summary} onClose={() => setView({ home: true })} />;
  if (view.session && data.workouts && data.workouts[view.session]) {
    return <Session data={data} workout={{ id: view.session, ...data.workouts[view.session] }} onDone={(next) => setView(next || { home: true })} />;
  }
  return <Home data={data} onOpen={(id) => setView({ session: id })} onStart={start} />;
}

// ---------- mounting into the app's Train tab ----------

function mount() {
  const el = document.getElementById("compound-train");
  if (el && !el.dataset.mounted) {
    el.dataset.mounted = "1";
    render(<Train />, el);
  }
}

// When leaving Train after changes, reload so the Dashboard sees them.
let wasMounted = false;
const RELOAD_TAB = "compound:reopen-tab";
new MutationObserver(() => {
  const el = document.getElementById("compound-train");
  if (el) { wasMounted = true; mount(); return; }
  if (wasMounted) {
    wasMounted = false;
    if (changedSinceLoad) {
      const active = [...document.querySelectorAll("button")].find((b) => /border-amber-400/.test(b.className) && /^(Log|Dashboard)$/.test(b.textContent.trim()));
      try { sessionStorage.setItem(RELOAD_TAB, active ? active.textContent.trim() : "Log"); } catch (e) {}
      location.reload();
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

// After such a reload, return to the tab the user picked.
(function reopenTab() {
  let tab = null;
  try { tab = sessionStorage.getItem(RELOAD_TAB); sessionStorage.removeItem(RELOAD_TAB); } catch (e) {}
  if (!tab) return;
  const tryClick = (n) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === tab);
    if (b) b.click(); else if (n > 0) setTimeout(() => tryClick(n - 1), 100);
  };
  tryClick(50);
})();
