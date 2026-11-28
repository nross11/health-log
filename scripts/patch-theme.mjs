// Patches the prebuilt app bundle (app.js) for the Ember "Meters" look.
// app.js has no source in this repo, so these are exact text replacements,
// in the same style as patch-app.mjs. Each must match exactly once, or the
// script stops without writing. Run it after patch-app.mjs; it is idempotent.
//
//   node scripts/patch-theme.mjs
//
// What it does:
// - swaps the chart and streak colors for the Ember palette
// - tags the tab bar, the active tab, the Log numbers and the input bar with
//   cx-* classes that theme.css styles
// - adds a big screen title: "Today's numbers" (or the day's name) on Log,
//   "This week" on Dashboard
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../app.js", import.meta.url);
let src = readFileSync(FILE, "utf8");

const MARK = "/*compound-theme-patch*/";
if (src.includes(MARK)) {
  console.log("app.js already has the theme patch.");
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

// Ember palette: orange calories, amber protein, bone steps/weight.
replaceOnce(
  'Yn="#5eead4",So="#fbbf24",Lo="#c4b5fd",Cn="#1e293b",Cr="#64748b"',
  'Yn="#FF5B14",So="#FFC23D",Lo="#F6EFE8",Cn="#2A221D",Cr="#9C8F84"',
  "palette constants"
);
replaceOnce('Ao.length,"#cbd5e1"]', 'Ao.length,"#F6EFE8"]', "days-logged color");
replaceOnce('style:{color:n?r:"#475569"}', 'style:{color:n?r:"#5A5049"}', "inactive streak color");

// App shell and tab bar.
replaceOnce(
  'className:"min-h-screen bg-slate-900 text-slate-100 flex flex-col",children:(0,w.jsxs)("div",{className:"w-full max-w-xl mx-auto',
  'className:"cx-app min-h-screen bg-slate-900 text-slate-100 flex flex-col",children:(0,w.jsxs)("div",{className:"w-full max-w-xl mx-auto',
  "app shell"
);
replaceOnce('className:"flex border-b border-slate-800"', 'className:"cx-tabs flex border-b border-slate-800"', "tab bar");
replaceOnce('"text-slate-100 border-b-2 border-amber-400 -mb-px"', '"cx-on text-slate-100 border-b-2 border-amber-400 -mb-px"', "active tab");

// Log: title + meters.
replaceOnce(
  '(0,w.jsxs)("div",{className:"grid gap-2",style:{gridTemplateColumns:`repeat(${__ctCols("log",4)}',
  '(0,w.jsx)("h1",{className:"cx-title",children:Gr(U)==="Today"?"Today\'s numbers":Gr(U)}),(0,w.jsxs)("div",{className:"cx-meters grid gap-2",style:{gridTemplateColumns:`repeat(${__ctCols("log",4)}',
  "log numbers"
);
replaceOnce(
  'vF=({value:e,onChange:t,onSend:a,placeholder:r,busy:n})=>(0,w.jsx)("div",{className:"px-4 py-3 border-t border-slate-800 bg-slate-900"',
  'vF=({value:e,onChange:t,onSend:a,placeholder:r,busy:n})=>(0,w.jsx)("div",{className:"cx-input px-4 py-3 border-t border-slate-800 bg-slate-900"',
  "input bar"
);

// Dashboard title.
replaceOnce(
  'a==="history"&&(0,w.jsxs)("div",{className:"flex-1 overflow-y-auto px-4 py-4",children:[',
  'a==="history"&&(0,w.jsxs)("div",{className:"flex-1 overflow-y-auto px-4 py-4",children:[(0,w.jsx)("h1",{className:"cx-title cx-title-dash",children:"This week"}),',
  "dashboard title"
);

// No streak leeway: drop the "within 10% / 5%" note from the Dashboard.
replaceOnce(
  '"Streaks hold within ",Math.round(I.calMargin*100),"% over on calories and ",Math.round(I.proMargin*100),"% under on protein. All except drinks need 7/7 days logged."',
  '"Streaks count weeks you hit your goals. All except drinks need 7/7 days logged."',
  "streak note"
);
// No streak leeway: streak thresholds are the goals themselves.
replaceOnce(
  'lse=e=>Math.round(e.calTarget*(1+(e.calMargin??0))),use=e=>Math.round(e.proMin*(1-(e.proMargin??0)))',
  'lse=e=>Math.round(e.calTarget),use=e=>Math.round(e.proMin)',
  "streak thresholds"
);

src = MARK + src;
writeFileSync(FILE, src);
console.log(`Patched app.js (${n} replacements).`);
