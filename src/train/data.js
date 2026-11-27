// Data helpers for the Train screen. Works on the same log object the rest
// of the app uses: { exercises, templates, workouts, ... } stored under
// "foodlog:v5". Workouts look like:
//   { date, template, start, end, closed, sets: [{ id, exercise, reps, weight, unit }], order? }

export const MUSCLES = ["Chest", "Back", "Shoulders", "Biceps", "Triceps", "Legs", "Core"];

export function store() {
  return window.compoundStore;
}

// A brand-new log may not have saved the app's default exercises and
// templates yet; fall back to the app's built-in defaults.
export function read() {
  const data = store().read() || {};
  if (!Array.isArray(data.templates) || !data.templates.length) data.templates = window.__compoundDefaultTemplates || [];
  if (!Array.isArray(data.exercises) || !data.exercises.length) data.exercises = window.__compoundDefaultExercises || [];
  return data;
}

export function write(mutate) {
  return store().write((data) => {
    const added = [];
    data.workouts = data.workouts || {};
    if (!Array.isArray(data.exercises) || !data.exercises.length) data.exercises = JSON.parse(JSON.stringify(window.__compoundDefaultExercises || []));
    if (!Array.isArray(data.templates) || !data.templates.length) data.templates = JSON.parse(JSON.stringify(window.__compoundDefaultTemplates || []));
    mutate(data);
  });
}

export function uid() {
  return Math.random().toString(36).slice(2, 9);
}

export function todayIso() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

export function niceDate(iso, opts) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = todayIso();
  if (iso === today) return "Today";
  const yd = new Date(); yd.setDate(yd.getDate() - 1);
  if (date.toDateString() === yd.toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-US", opts || { weekday: "short", month: "short", day: "numeric" });
}

export function sortedWorkouts(data) {
  return Object.entries(data.workouts || {})
    .map(([id, w]) => ({ id, ...w }))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.start || 0) - (a.start || 0));
}

export function openWorkout(data) {
  return sortedWorkouts(data).find((w) => !w.closed && w.date === todayIso()) || null;
}

export function exerciseInfo(data, name) {
  return (data.exercises || []).find((e) => e.name === name) || { name, muscle: null };
}

export function isTimed(data, name) {
  return !!exerciseInfo(data, name).timed;
}

// Exercises shown in a workout, in order: saved order, else template order,
// plus anything logged that isn't listed.
export function workoutExercises(data, w) {
  const tpl = (data.templates || []).find((t) => t.id === w.template);
  const base = Array.isArray(w.order) ? w.order : tpl ? tpl.exercises : [];
  const list = [...base];
  for (const s of w.sets || []) if (!list.includes(s.exercise)) list.push(s.exercise);
  return list;
}

export function templateName(data, id) {
  if (!id) return "Freestyle";
  const t = (data.templates || []).find((x) => x.id === id);
  return t ? t.name : "Workout";
}

// Estimated one-rep max (Epley). Bodyweight/timed sets score by reps/seconds.
export function score(set) {
  if (!set) return 0;
  if (set.unit === "sec" || !set.weight) return set.reps;
  return set.weight * (1 + set.reps / 30);
}

// Past sessions with this exercise, newest first, excluding one workout.
export function exerciseHistory(data, name, excludeId) {
  const out = [];
  for (const w of sortedWorkouts(data)) {
    if (w.id === excludeId) continue;
    const sets = (w.sets || []).filter((s) => s.exercise === name);
    if (sets.length) out.push({ id: w.id, date: w.date, template: w.template, sets });
  }
  return out;
}

export function bestSet(history) {
  let best = null;
  for (const h of history) for (const s of h.sets) if (!best || score(s) > score(best)) best = s;
  return best;
}

export function fmtWeight(n) {
  return String(Math.round(n * 100) / 100);
}

export function fmtSet(s) {
  if (s.unit === "sec") return s.reps + "s";
  if (!s.weight) return s.reps + " reps";
  return fmtWeight(s.weight) + "×" + s.reps;
}

export function fmtDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
}

export function weekStart(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const day = (date.getDay() + 6) % 7; // Monday first
  date.setDate(date.getDate() - day);
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

// Per-device preferences (rest time etc.)
export function pref(key, fallback) {
  try { const v = localStorage.getItem("compound:" + key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
}
export function setPref(key, value) {
  try { localStorage.setItem("compound:" + key, JSON.stringify(value)); } catch (e) {}
}
