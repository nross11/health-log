/** @jsx h */
// Compound Settings screen.
// - window.__ct(name): is a tracker on? (app.js uses it to hide things)
// - window.__ctCols(area, fallback): column count for the Log stats / Dashboard tiles
// - window.__compoundOpenSettings(): opens Settings (tab bar button in app.js)
// Settings live in the log's `settings` object, next to the app's own goals.
import { h, render, Fragment } from "preact";
import { useState, useMemo } from "preact/hooks";

const KEY = "foodlog:v5";
const LOCAL_BACKUP = "healthlog:local-backup";
const RELOAD_TAB = "compound:reopen-tab";

export const TRACKERS = [
  { id: "food", name: "Food", desc: "Calories and protein", color: "#5eead4" },
  { id: "training", name: "Training", desc: "Workouts, sets and personal bests", color: "#fb923c" },
  { id: "steps", name: "Steps", desc: "Your daily step count", color: "#c4b5fd" },
  { id: "weight", name: "Weight", desc: "Weigh-ins and your weekly average", color: "#7dd3fc" },
  { id: "drinking", name: "Drinking", desc: "Drinks per week", color: "#f0abfc" },
];

// Same defaults as the app (app.js), so an untouched value reads the same here.
const APP_DEFAULTS = { calTarget: 1500, proMin: 140, drinkMax: 3, calMargin: 0.1, proMargin: 0.05, stepTarget: 10000, sessionsPerWeek: 4, topOfRange: 12 };


// ---------- store ----------

function readLog() {
  try { return window.compoundStore ? window.compoundStore.read() : JSON.parse(localStorage.getItem(KEY) || "null"); }
  catch (e) { return null; }
}
function allOn() { return { food: true, training: true, steps: true, weight: true, drinking: true }; }
function trackersOf(settings) { return Object.assign(allOn(), (settings && settings.trackers) || {}); }

let cached = null;
function trackers() {
  if (!cached) cached = trackersOf((readLog() || {}).settings);
  return cached;
}
window.__ct = (name) => trackers()[name] !== false;
window.__ctCols = (area, fallback) => {
  const t = trackers();
  const n = area === "log"
    ? (t.food ? 2 : 0) + (t.steps ? 1 : 0) + (t.weight ? 1 : 0)
    : (t.food ? 2 : 0) + (t.training ? 1 : 0) + (t.steps ? 1 : 0) + (t.drinking ? 1 : 0);
  return n || fallback;
};

function flush() {
  const f = window.compoundStore && window.compoundStore.flush;
  if (!f) return Promise.resolve();
  return Promise.race([Promise.resolve(f()).catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
}

function reloadTo(tab) {
  try { sessionStorage.setItem(RELOAD_TAB, tab); } catch (e) {}
  location.reload();
}
function activeTab() {
  const b = [...document.querySelectorAll("button")].find((x) => /border-amber-400/.test(x.className) && /^(Log|Train|Dashboard)$/.test(x.textContent.trim()));
  return b ? b.textContent.trim() : "Log";
}

// Writes settings into the log, syncs, then reloads so the app picks them up.
async function saveSettings(patch, { tab } = {}) {
  window.compoundStore.write((d) => {
    // goalsVersion 2 stops the app resetting workouts/week on load.
    d.settings = Object.assign({}, d.settings || {}, patch, { goalsVersion: 2 });
  });
  await flush();
  reloadTo(tab || activeTab());
}

function signedInEmail() {
  try { return JSON.parse(localStorage.getItem("healthlog:sync") || "{}").email || null; } catch (e) { return null; }
}

// ---------- small pieces ----------

function Stepper({ label, value, onChange, step, min, max, suffix, wide }) {
  const v = Number(value) || 0;
  const clamp = (x) => Math.min(max, Math.max(min, Math.round(x * 100) / 100));
  return (
    <div class={"cs-row" + (wide ? " cs-row-wide" : "")}>
      <span class="cs-row-label">{label}</span>
      <div class="cs-stepper">
        <button type="button" class="cs-step" aria-label={"Less " + label} onClick={() => onChange(clamp(v - step))}>−</button>
        <label class="cs-step-field">
          <input type="number" inputMode="decimal" value={value} aria-label={label}
            onFocus={(e) => e.target.select()}
            onInput={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
            onBlur={() => onChange(clamp(v))} />
          {suffix ? <span>{suffix}</span> : null}
        </label>
        <button type="button" class="cs-step" aria-label={"More " + label} onClick={() => onChange(clamp(v + step))}>+</button>
      </div>
    </div>
  );
}

function TrackerIcon({ id }) {
  const p = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" };
  if (id === "food") return <svg {...p}><path d="M12 7c-1.5-1.5-5-1.8-6.5.8C4 10.5 5 15 7 18c1.2 1.8 2.6 3 4 2.4.6-.3 1.4-.3 2 0 1.4.6 2.8-.6 4-2.4 2-3 3-7.5 1.5-10.2C17 5.2 13.5 5.5 12 7z" /><path d="M12 7c0-2 1-3.5 3-4" /></svg>;
  if (id === "training") return <svg {...p}><path d="M6.5 6.5v11M17.5 6.5v11M3.5 9.5v5M20.5 9.5v5M6.5 12h11" /></svg>;
  if (id === "steps") return <svg {...p}><path d="M8 3c-1.7 0-3 2-3 4.5S6 12 8 12s3-1.5 3-4.5S9.7 3 8 3z" /><path d="M6 15h4v1.5a2 2 0 0 1-4 0z" /><path d="M16 7c-1.7 0-3 2-3 4.5S14 16 16 16s3-1.5 3-4.5S17.7 7 16 7z" /><path d="M14 19h4v.2a2 2 0 0 1-4 0z" /></svg>;
  if (id === "weight") return <svg {...p}><rect x="3.5" y="3.5" width="17" height="17" rx="4" /><path d="M8.5 9.5a5 5 0 0 1 7 0l-2.2 2.5h-2.6z" /></svg>;
  return <svg {...p}><path d="M8 3h8l-.5 5.5a3.5 3.5 0 0 1-7 0z" /><path d="M12 12v8M8.5 20h7" /></svg>;
}

function TrackerPicker({ value, onChange }) {
  return (
    <div class="cs-trackers">
      {TRACKERS.map((t) => {
        const on = value[t.id] !== false;
        return (
          <button type="button" class={"cs-tracker" + (on ? " on" : "")} style={on ? { borderColor: t.color } : null} aria-pressed={on}
            onClick={() => onChange(Object.assign({}, value, { [t.id]: !on }))}>
            <span class="cs-tracker-icon" style={on ? { color: t.color } : null}><TrackerIcon id={t.id} /></span>
            <span class="cs-tracker-text"><b>{t.name}</b><span>{t.desc}</span></span>
            <span class="cs-check" style={on ? { background: t.color, borderColor: t.color } : null}>
              {on ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0f172a" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Targets({ t, s, set }) {
  const any = TRACKERS.some((x) => t[x.id] !== false && x.id !== "weight");
  return (
    <Fragment>
      {t.food !== false && (
        <section class="cs-card">
          <h3 style={{ color: "#5eead4" }}>Food</h3>
          <Stepper label="Calories a day" value={s.calTarget} onChange={(v) => set({ calTarget: v })} step={50} min={800} max={6000} />
          <Stepper label="Protein a day, at least" value={s.proMin} onChange={(v) => set({ proMin: v })} step={5} min={0} max={400} suffix="g" />
          <details class="cs-more">
            <summary>Streak leeway</summary>
            <p class="cs-note">How far off a week's average can be and still keep the streak.</p>
            <Stepper label="Calories over by up to" value={Math.round(s.calMargin * 100)} onChange={(v) => set({ calMargin: (Number(v) || 0) / 100 })} step={1} min={0} max={50} suffix="%" />
            <Stepper label="Protein under by up to" value={Math.round(s.proMargin * 100)} onChange={(v) => set({ proMargin: (Number(v) || 0) / 100 })} step={1} min={0} max={50} suffix="%" />
          </details>
        </section>
      )}
      {t.training !== false && (
        <section class="cs-card">
          <h3 style={{ color: "#fb923c" }}>Training</h3>
          <Stepper label="Workouts a week" value={s.sessionsPerWeek} onChange={(v) => set({ sessionsPerWeek: v })} step={1} min={1} max={14} />
          <details class="cs-more">
            <summary>Progression</summary>
            <p class="cs-note">When every set of an exercise reaches this many reps two sessions in a row, it's flagged as ready for more weight.</p>
            <Stepper label="Top of rep range" value={s.topOfRange} onChange={(v) => set({ topOfRange: v })} step={1} min={3} max={30} suffix="reps" />
          </details>
        </section>
      )}
      {t.steps !== false && (
        <section class="cs-card">
          <h3 style={{ color: "#c4b5fd" }}>Steps</h3>
          <Stepper label="Steps a day" value={s.stepTarget} onChange={(v) => set({ stepTarget: v })} step={500} min={1000} max={40000} />
        </section>
      )}
      {t.drinking !== false && (
        <section class="cs-card">
          <h3 style={{ color: "#f0abfc" }}>Drinking</h3>
          <Stepper label="Drinks a week, at most" value={s.drinkMax} onChange={(v) => set({ drinkMax: v })} step={1} min={0} max={50} />
        </section>
      )}
      {!any && t.weight !== false && <p class="cs-note">Weight has no target. The Dashboard shows your weekly average and trend.</p>}
    </Fragment>
  );
}

// ---------- backup ----------

async function copyText(text) {
  try {
    if (navigator.clipboard) {
      await Promise.race([navigator.clipboard.writeText(text), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500))]);
      return true;
    }
  } catch (e) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    Object.assign(ta.style, { position: "fixed", top: "0", left: "0", opacity: "0", fontSize: "16px" });
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy"); document.body.removeChild(ta); return ok;
  } catch (e) { return false; }
}

function backupText() {
  const log = readLog() || {};
  return JSON.stringify(log, null, 2);
}

function Backup() {
  const [msg, setMsg] = useState(null);
  const [shown, setShown] = useState(null);
  const [paste, setPaste] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => {
    if (!paste.trim()) return null;
    try {
      const b = JSON.parse(paste);
      if (!b || typeof b !== "object" || (!b.days && !b.workouts)) return { error: "No days or workouts found in that backup." };
      return { ok: b, days: Object.keys(b.days || {}).length, workouts: Object.keys(b.workouts || {}).length };
    } catch (e) { return { error: "That isn't a valid backup (not JSON)." }; }
  }, [paste]);

  const onCopy = async () => {
    const t = backupText();
    if (await copyText(t)) setMsg("Copied. Paste it somewhere safe, like Notes.");
    else { setShown(t); setMsg("Couldn't copy automatically. Select the text below and copy it."); }
  };
  const onDownload = () => {
    const blob = new Blob([backupText()], { type: "application/json" });
    const a = document.createElement("a");
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `compound-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setMsg("Downloaded.");
  };
  const onFile = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { setPaste(String(r.result || "")); setConfirm(false); };
    r.readAsText(f);
  };
  const onRestore = async () => {
    if (!parsed || !parsed.ok) return;
    if (!confirm) { setConfirm(true); return; }
    setBusy(true);
    // Keep this device's current log as a safety copy before replacing it.
    try { const cur = localStorage.getItem(KEY); if (cur) localStorage.setItem(LOCAL_BACKUP, JSON.stringify({ savedAt: new Date().toISOString(), value: cur })); } catch (e) {}
    const data = parsed.ok;
    window.__compoundRestoring = true;
    try { await window.storage.set(KEY, JSON.stringify(data)); } finally { window.__compoundRestoring = false; }
    await flush();
    reloadTo("Log");
  };

  return (
    <div class="cs-backup">
      <Fragment>
          <p class="cs-note">A backup is your whole log as one block of text: days, workouts, exercises, foods and settings.</p>
          <div class="cs-btn-row">
            <button type="button" class="cs-btn-secondary" onClick={onCopy}>Copy backup</button>
            <button type="button" class="cs-btn-secondary" onClick={onDownload}>Download file</button>
          </div>
          {msg && <p class="cs-status" role="status">{msg}</p>}
          {shown && <textarea class="cs-textarea" readOnly rows={6} value={shown} onFocus={(e) => e.target.select()} />}
          <h4 class="cs-subhead">Restore</h4>
      </Fragment>
      <textarea class="cs-textarea" rows={4} placeholder="Paste a backup here" value={paste} onInput={(e) => { setPaste(e.target.value); setConfirm(false); }} aria-label="Backup to restore" />
      <label class="cs-file">or choose a backup file<input type="file" accept="application/json,.json,.txt" onChange={onFile} /></label>
      {parsed && parsed.error && <p class="cs-status cs-bad" role="status">{parsed.error}</p>}
      {parsed && parsed.ok && <p class="cs-status" role="status">Found {parsed.days} days and {parsed.workouts} workouts.</p>}
      <button type="button" class={confirm ? "cs-btn-danger" : "cs-btn-primary"} disabled={!parsed || !parsed.ok || busy} onClick={onRestore}>
        {busy ? "Restoring…" : confirm ? "Tap again to replace everything" : "Replace all data with this backup"}
      </button>
      <p class="cs-note">Restoring replaces everything in your log, on every device you're signed in on. Your current log is kept on this device as a safety copy.</p>
    </div>
  );
}

// ---------- Settings screen ----------

function initialSettings(log, defaults) {
  const s = Object.assign({}, defaults, (log && log.settings) || {});
  return { calTarget: s.calTarget, proMin: s.proMin, drinkMax: s.drinkMax, calMargin: s.calMargin, proMargin: s.proMargin, stepTarget: s.stepTarget, sessionsPerWeek: s.sessionsPerWeek, topOfRange: s.topOfRange };
}
function clean(s) {
  const out = {};
  for (const k of Object.keys(s)) out[k] = Number(s[k]) || 0;
  return out;
}

function Settings({ onClose }) {
  const log = readLog();
  const [t, setT] = useState(trackersOf(log && log.settings));
  const [s, setS] = useState(initialSettings(log, APP_DEFAULTS));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const email = signedInEmail();
  const none = !TRACKERS.some((x) => t[x.id] !== false);
  const set = (p) => { setS(Object.assign({}, s, p)); setDirty(true); };
  const save = async () => {
    setSaving(true);
    await saveSettings(Object.assign(clean(s), { trackers: t }), { tab: t.training === false && activeTab() === "Train" ? "Log" : undefined });
  };
  return (
    <div class="cs-screen" role="dialog" aria-label="Settings">
      <header class="cs-head">
        <h2>Settings</h2>
        <button type="button" class="cs-close" onClick={onClose} aria-label="Close settings">✕</button>
      </header>
      <div class="cs-body">
        <h3 class="cs-section">What you track</h3>
        <p class="cs-note">Anything turned off is hidden from Log and Dashboard. Its data is kept.</p>
        <TrackerPicker value={t} onChange={(v) => { setT(v); setDirty(true); }} />
        {none && <p class="cs-status cs-bad">Pick at least one.</p>}

        <h3 class="cs-section">Targets</h3>
        <Targets t={t} s={s} set={set} />

        <h3 class="cs-section">Backup</h3>
        <Backup />

        <h3 class="cs-section">Account</h3>
        <div class="cs-card cs-account">
          <span>{email ? <Fragment>Signed in as <b>{email}</b></Fragment> : "Signed in"}</span>
          {window.healthLogSignOut && <button type="button" class="cs-btn-secondary" onClick={() => window.healthLogSignOut()}>Sign out</button>}
        </div>
      </div>
      {dirty && (
        <footer class="cs-foot">
          <button type="button" class="cs-btn-primary" disabled={none || saving} onClick={save}>{saving ? "Saving…" : "Save changes"}</button>
        </footer>
      )}
    </div>
  );
}

// ---------- mounting ----------

let host = null;
function mountHost() {
  if (!host) {
    host = document.createElement("div");
    host.id = "compound-settings";
    document.body.appendChild(host);
  }
  document.documentElement.classList.add("cs-open");
  return host;
}
function close() {
  if (host) render(null, host);
  document.documentElement.classList.remove("cs-open");
}

window.__compoundOpenSettings = () => render(<Settings onClose={close} />, mountHost());
