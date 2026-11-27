// Patches the prebuilt app bundle (app.js) for Settings and onboarding.
// app.js has no source in this repo, so these are exact text replacements.
// Each one must match exactly once, or the script stops without writing.
// The script is idempotent: run it again on a freshly rebuilt app.js.
//
//   node scripts/patch-app.mjs
//
// What it does:
// - adds a Settings button to the tab bar (opens settings.js's screen)
// - hides the Train tab, Log stats and Dashboard sections for trackers the
//   user turned off (settings.trackers; anything missing counts as on)
// - moves backup export/import out of the Dashboard (now in Settings),
//   leaving the Data check there
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../app.js", import.meta.url);
let src = readFileSync(FILE, "utf8");

const MARK = "/*compound-settings-patch*/";
if (src.includes(MARK)) {
  console.log("app.js is already patched.");
  process.exit(0);
}

let n = 0;
function replaceOnce(find, replace, label) {
  const first = src.indexOf(find);
  if (first < 0) throw new Error(`Not found: ${label}`);
  if (src.indexOf(find, first + 1) >= 0) throw new Error(`Found more than once: ${label}`);
  src = src.slice(0, first) + replace + src.slice(first + find.length);
  n++;
}
function removeBetween(startText, endText, label) {
  const a = src.indexOf(startText);
  if (a < 0 || src.indexOf(startText, a + 1) >= 0) throw new Error(`Start not unique: ${label}`);
  const b = src.indexOf(endText, a);
  if (b < 0) throw new Error(`End not found: ${label}`);
  src = src.slice(0, a) + src.slice(b);
  n++;
}

// 0. Fallback so the app still runs if settings.js didn't load.
src = MARK + 'window.__ct=window.__ct||function(){return!0};window.__ctCols=window.__ctCols||function(k,d){return d};\n' + src;

// 1. Tab bar: hide Train when training is off, add a Settings button.
replaceOnce(
  '(0,w.jsx)("div",{className:"flex border-b border-slate-800",children:[["log","Log"],["train","Train"],["history","Dashboard"]].map(([b,C])=>',
  '(0,w.jsx)("div",{className:"flex border-b border-slate-800",children:[...[["log","Log"],["train","Train"],["history","Dashboard"]].filter(([b])=>b!=="train"||__ct("training")).map(([b,C])=>',
  "tab bar start",
);
replaceOnce(
  ',children:C},b))}),a==="log"&&o&&',
  ',children:C},b)),(0,w.jsx)("button",{onClick:()=>window.__compoundOpenSettings&&window.__compoundOpenSettings(),"aria-label":"Settings",title:"Settings",className:"px-4 text-slate-500 hover:text-slate-300 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-amber-400",children:(0,w.jsxs)("svg",{width:20,height:20,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round","aria-hidden":"true",children:[(0,w.jsx)("path",{d:"M4 7h9M18 7h2M4 17h3M12 17h8"}),(0,w.jsx)("circle",{cx:15.5,cy:7,r:2.2}),(0,w.jsx)("circle",{cx:9.5,cy:17,r:2.2})]})},"settings")]}),a==="log"&&o&&',
  "tab bar end",
);

// 2. Log header: calorie streak flame and the four stat cells.
replaceOnce('_t.calStreak>0&&(0,w.jsxs)("span",{className:"flex items-center gap-1 text-xs text-amber-400 tabular-nums"',
  '__ct("food")&&_t.calStreak>0&&(0,w.jsxs)("span",{className:"flex items-center gap-1 text-xs text-amber-400 tabular-nums"', "log flame");
replaceOnce('(0,w.jsxs)("div",{className:"grid grid-cols-4 gap-2",children:[(0,w.jsxs)("div",{className:"min-w-0",children:[(0,w.jsx)("div",{className:"text-2xl font-semibold tabular-nums text-teal-300 leading-none",children:Hf})',
  '(0,w.jsxs)("div",{className:"grid gap-2",style:{gridTemplateColumns:`repeat(${__ctCols("log",4)},minmax(0,1fr))`},children:[__ct("food")&&(0,w.jsxs)("div",{className:"min-w-0",children:[(0,w.jsx)("div",{className:"text-2xl font-semibold tabular-nums text-teal-300 leading-none",children:Hf})', "log calories");
replaceOnce('(0,w.jsxs)("div",{className:"min-w-0",children:[(0,w.jsx)("div",{className:`text-2xl font-semibold tabular-nums leading-none ${Ul>=I.proMin',
  '__ct("food")&&(0,w.jsxs)("div",{className:"min-w-0",children:[(0,w.jsx)("div",{className:`text-2xl font-semibold tabular-nums leading-none ${Ul>=I.proMin', "log protein");
replaceOnce('(0,w.jsxs)("div",{className:"min-w-0",children:[Na.steps==null?',
  '__ct("steps")&&(0,w.jsxs)("div",{className:"min-w-0",children:[Na.steps==null?', "log steps");
replaceOnce('(0,w.jsxs)("div",{className:"min-w-0",children:[Na.weight==null?',
  '__ct("weight")&&(0,w.jsxs)("div",{className:"min-w-0",children:[Na.weight==null?', "log weight");

// 3. Dashboard streak tiles.
replaceOnce('(0,w.jsxs)("div",{className:"grid grid-cols-5 gap-1.5 mb-3",children:[(0,w.jsx)(Gm,{icon:Yd,',
  '(0,w.jsxs)("div",{className:"grid gap-1.5 mb-3",style:{gridTemplateColumns:`repeat(${__ctCols("tiles",5)},minmax(0,1fr))`},children:[__ct("food")&&(0,w.jsx)(Gm,{icon:Yd,', "tile calories");
replaceOnce('(0,w.jsx)(Gm,{icon:Zd,', '__ct("food")&&(0,w.jsx)(Gm,{icon:Zd,', "tile protein");
replaceOnce('(0,w.jsx)(Gm,{icon:ep,', '__ct("training")&&(0,w.jsx)(Gm,{icon:ep,', "tile workouts");
replaceOnce('(0,w.jsx)(Gm,{icon:ap,', '__ct("steps")&&(0,w.jsx)(Gm,{icon:ap,', "tile steps");
replaceOnce('(0,w.jsx)(Gm,{icon:yc,value:_t.drinkStreak', '__ct("drinking")&&(0,w.jsx)(Gm,{icon:yc,value:_t.drinkStreak', "tile drinks");
replaceOnce('(0,w.jsxs)("p",{className:"mb-3 text-[11px] text-slate-600",children:["Streaks hold within ",',
  '__ct("food")&&(0,w.jsxs)("p",{className:"mb-3 text-[11px] text-slate-600",children:["Streaks hold within ",', "streak note");

// 4. Dashboard "this week" line.
replaceOnce('(0,w.jsxs)("span",{className:"tabular-nums",children:[_t.thisWeek.avgCal," cal avg"]})',
  '__ct("food")&&(0,w.jsxs)("span",{className:"tabular-nums",children:[_t.thisWeek.avgCal," cal avg"]})', "week cal");
replaceOnce('(0,w.jsxs)("span",{className:"tabular-nums",children:[_t.thisWeek.avgPro,"g protein avg"]})',
  '__ct("food")&&(0,w.jsxs)("span",{className:"tabular-nums",children:[_t.thisWeek.avgPro,"g protein avg"]})', "week protein");
replaceOnce('(0,w.jsxs)("span",{className:"tabular-nums",children:[_t.thisWeek.drinks,"/",I.drinkMax," drinks"]})',
  '__ct("drinking")&&(0,w.jsxs)("span",{className:"tabular-nums",children:[_t.thisWeek.drinks,"/",I.drinkMax," drinks"]})', "week drinks");
replaceOnce('_t.thisWeekSteps&&(0,w.jsxs)("span",{className:"tabular-nums",children:[_t.thisWeekSteps.avg',
  '__ct("steps")&&_t.thisWeekSteps&&(0,w.jsxs)("span",{className:"tabular-nums",children:[_t.thisWeekSteps.avg', "week steps");
replaceOnce('(0,w.jsxs)("span",{className:"tabular-nums",children:[_t.thisWeekSessions?',
  '__ct("training")&&(0,w.jsxs)("span",{className:"tabular-nums",children:[_t.thisWeekSessions?', "week workouts");

// 5. Dashboard sections.
replaceOnce('(0,w.jsxs)("div",{className:"flex items-center justify-between mb-4",children:[(0,w.jsxs)("div",{className:"flex gap-3 text-xs",children:[',
  '__ct("food")&&(0,w.jsxs)("div",{className:"flex items-center justify-between mb-4",children:[(0,w.jsxs)("div",{className:"flex gap-3 text-xs",children:[', "calorie legend");
replaceOnce('Ao.length===0?(0,w.jsx)("p"', '!__ct("food")?null:Ao.length===0?(0,w.jsx)("p"', "calorie chart");
replaceOnce('(0,w.jsxs)("div",{className:"mt-8 pt-6 border-t border-slate-800",children:[(0,w.jsx)("div",{className:"text-[10px] uppercase tracking-[0.15em] text-slate-500 mb-3",children:"Weight \\u2014 weekly average"})',
  '__ct("weight")&&(0,w.jsxs)("div",{className:"mt-8 pt-6 border-t border-slate-800",children:[(0,w.jsx)("div",{className:"text-[10px] uppercase tracking-[0.15em] text-slate-500 mb-3",children:"Weight \\u2014 weekly average"})', "weight section");
replaceOnce('(0,w.jsxs)("div",{className:"mt-8 pt-6 border-t border-slate-800",children:[(0,w.jsx)("div",{className:"text-[10px] uppercase tracking-[0.15em] text-slate-500 mb-3",children:"Training"})',
  '__ct("training")&&(0,w.jsxs)("div",{className:"mt-8 pt-6 border-t border-slate-800",children:[(0,w.jsx)("div",{className:"text-[10px] uppercase tracking-[0.15em] text-slate-500 mb-3",children:"Training"})', "training section");
replaceOnce('(0,w.jsxs)("div",{className:"mt-8 pt-6 border-t border-slate-800",children:[(0,w.jsxs)("div",{className:"flex items-baseline justify-between mb-3",children:[(0,w.jsx)("span",{className:"text-[10px] uppercase tracking-[0.15em] text-slate-500",children:"Steps"})',
  '__ct("steps")&&(0,w.jsxs)("div",{className:"mt-8 pt-6 border-t border-slate-800",children:[(0,w.jsxs)("div",{className:"flex items-baseline justify-between mb-3",children:[(0,w.jsx)("span",{className:"text-[10px] uppercase tracking-[0.15em] text-slate-500",children:"Steps"})', "steps section");

// 6. Backup moves to Settings. The Dashboard keeps the Data check.
replaceOnce('(0,w.jsx)("span",{children:"Backup"})', '(0,w.jsx)("span",{children:"Data check"})', "backup title");
removeBetween('(0,w.jsxs)("div",{className:"flex gap-2",children:[(0,w.jsxs)("button",{onClick:MF,',
  '(0,w.jsxs)("div",{className:"pt-2 border-t border-slate-800",children:[(0,w.jsxs)("div",{className:"text-[10px] uppercase tracking-[0.15em] text-slate-500 mb-2",children:["Data check"', "backup controls");
replaceOnce('"Import overwrites everything \\u2014 days, workouts, exercises and settings. Download a copy first."',
  '"Backup and restore are in Settings (the sliders button next to Dashboard)."', "backup note");

writeFileSync(FILE, src);
console.log(`Patched app.js (${n} replacements).`);
