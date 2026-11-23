// The README's terminal demo: an animated SVG made from a real recorded run (quickstart.json, written by
// a measurement run on a fresh copy of fixtures/e-library). Each command is typed, then its real output
// appears line by line. Plain SVG + CSS, so GitHub renders it with no external host.
//   node docs/img/make-terminal-svg.mjs   →  docs/img/quickstart.svg
import fs from "node:fs";
import path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname);
const rec = JSON.parse(fs.readFileSync(path.join(dir, "quickstart.json"), "utf8"));

const W = 980;
const LH = 18;
const PAD = 18;
const TOP = 30;
const CHAR = 7.22; // 12px SF Mono / Menlo advance
const MAX = Math.floor((W - PAD * 2) / CHAR);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s) => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);
const color = (l) =>
  /^\s*✓/.test(l) ? "ok" : /^\s*✗/.test(l) ? "bad" : /^(Next|Done|run detached|ticket|\d+ job)/.test(l) ? "hi" : /^\s+(…|\|)/.test(l) ? "dim" : "";

const rows = [];
let t = 0.6;
for (const s of rec.steps) {
  const cmd = `$ ${s.cmd}`;
  const typeSecs = Math.min(1.6, 0.025 * cmd.length);
  rows.push({ text: clip(cmd), cls: "cmd", at: t, type: typeSecs });
  t += typeSecs + 0.35;
  if (s.wait) {
    rows.push({ text: `  … the job runs: intake → build → gate → verify → review → report (${Math.round(s.secs)}s, simulated agent)`, cls: "dim", at: t });
    t += 2.2;
  }
  for (const l of s.out.replace(/^\n+/, "").split("\n")) {
    rows.push({ text: clip(l), cls: color(l), at: t });
    t += 0.07;
  }
  t += 0.9;
}
const H = TOP + PAD + rows.length * LH + PAD;
const end = t + 6;
const pct = (x) => `${((x / end) * 100).toFixed(3)}%`;

let css = "";
const lines = rows.map((r, i) => {
  const y = TOP + PAD + (i + 1) * LH - 5;
  const id = `l${i}`;
  // Every line stays hidden until its moment, then shows for the rest of the loop.
  css += `#${id}{animation:${id} ${end.toFixed(2)}s steps(1,end) infinite}@keyframes ${id}{0%{opacity:0}${pct(r.at)}{opacity:1}100%{opacity:1}}\n`;
  if (r.type) {
    // A command is typed: a clip that widens over `type` seconds.
    const w = r.text.length * CHAR + 4;
    css += `#c${i}{animation:c${i} ${end.toFixed(2)}s linear infinite}@keyframes c${i}{0%{width:0}${pct(r.at)}{width:0}${pct(r.at + r.type)}{width:${w.toFixed(0)}px}100%{width:${w.toFixed(0)}px}}\n`;
    return `<clipPath id="k${i}"><rect id="c${i}" x="${PAD}" y="${y - 13}" height="${LH}" width="0"/></clipPath><text id="${id}" class="cmd" x="${PAD}" y="${y}" clip-path="url(#k${i})">${esc(r.text)}</text>`;
  }
  return `<text id="${id}"${r.cls ? ` class="${r.cls}"` : ""} x="${PAD}" y="${y}" xml:space="preserve">${esc(r.text)}</text>`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="kitchen: install, init, a ticket and its run, from a real recorded session">
<title>Kitchen quick start: npm i -g devkitchen, kitchen init, kitchen ticket, kitchen run --detach, kitchen status</title>
<style>
text{font:12px ui-monospace,"SF Mono",Menlo,Consolas,monospace;fill:#d6d9de;white-space:pre}
.cmd{fill:#ffffff;font-weight:600}.ok{fill:#7ee2a8}.bad{fill:#ff9b8f}.hi{fill:#9ecbff}.dim{fill:#8b929c}
.bar{fill:#8b929c;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
${css}</style>
<rect width="${W}" height="${H}" rx="10" fill="#0f1115"/>
<rect width="${W}" height="30" rx="10" fill="#1a1d23"/><rect y="20" width="${W}" height="10" fill="#1a1d23"/>
<circle cx="18" cy="15" r="5.5" fill="#ff5f57"/><circle cx="36" cy="15" r="5.5" fill="#febc2e"/><circle cx="54" cy="15" r="5.5" fill="#28c840"/>
<text class="bar" x="${W / 2}" y="19" text-anchor="middle">~/code/e-library</text>
${lines.join("\n")}
</svg>
`;
fs.writeFileSync(path.join(dir, "quickstart.svg"), svg);
console.log(`docs/img/quickstart.svg: ${rows.length} lines, ${end.toFixed(1)}s loop, ${(svg.length / 1024).toFixed(1)} KB`);
