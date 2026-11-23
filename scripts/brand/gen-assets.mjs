// README images: terminal shots from the real recorded run (docs/img/quickstart.json), the how-it-works diagram, the
// three "why" icons, all into docs/img/. Needs playwright-core and a Chromium (headless shell), and cwebp:
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs CHROMIUM=/path/to/chrome-headless-shell node scripts/brand/gen-assets.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const img = new URL("../../docs/img/", import.meta.url).pathname;
const tmp = fs.mkdtempSync(`${os.tmpdir()}/kitchen-brand-`);
const rec = JSON.parse(fs.readFileSync(img + "quickstart.json", "utf8"));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const T = {
  light: { bg: "#ffffff", bar: "#f6f6f7", line: "#dcdce0", fg: "#18181b", mute: "#6b6b74", faint: "#b4b4bc", ok: "#1f8a4c", bad: "#c63a3a", act: "#d9480f", box: "#ffffff", sub: "#f7f7f8" },
  dark: { bg: "#0f1011", bar: "#151617", line: "#2f3035", fg: "#ededf0", mute: "#8e8f97", faint: "#4a4b52", ok: "#4cc38a", bad: "#f2686b", act: "#ff8a3d", box: "#1a1b1e", sub: "#141516" },
};

// ── terminals ──
const line = (l) => {
  const m = l.match(/^(\s*)([✓✗…])(\s.*)$/);
  if (m) {
    const cls = m[2] === "✓" ? "ok" : m[2] === "✗" ? "bad" : "dim";
    return `${m[1]}<span class="${cls}">${m[2]}</span>${m[2] === "…" || m[2] === "✗" ? `<span class="dim">${esc(m[3])}</span>` : esc(m[3])}`;
  }
  if (/^(Done|Next|\d+ job)/.test(l)) return `<b>${esc(l)}</b>`;
  if (/^\s{6}/.test(l) || /^runner:/.test(l)) return `<span class="dim">${esc(l)}</span>`;
  return esc(l);
};
const term = (steps, t) => `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:transparent;padding:0}
.term{width:900px;border:1px solid ${t.line};border-radius:12px;overflow:hidden;background:${t.bg};color:${t.fg};font:13px/1.55 "SF Mono",ui-monospace,Menlo,monospace;-webkit-font-smoothing:antialiased}
.bar{height:34px;background:${t.bar};border-bottom:1px solid ${t.line};display:flex;align-items:center;gap:7px;padding:0 13px;font:500 12px -apple-system,sans-serif;color:${t.mute}}
.bar i{width:11px;height:11px;border-radius:50%;background:${t.faint}}.bar span{margin:0 auto;transform:translateX(-27px)}
pre{margin:0;padding:16px 20px 18px;font:inherit;white-space:pre-wrap;word-break:break-word}
.p{color:${t.act}}.cmd{font-weight:600}.ok{color:${t.ok}}.bad{color:${t.bad}}.dim{color:${t.mute}}b{font-weight:600}
</style><div class="term"><div class="bar"><i></i><i></i><i></i><span>~/code/e-library</span></div><pre>${steps
  .map((s) => `<span class="p">$</span> <span class="cmd">${esc(s.cmd)}</span>\n${s.out.replace(/^\n+/, "").split("\n").map(line).join("\n")}`)
  .join("\n\n")}</pre></div>`;
const step = (prefix) => rec.steps.find((s) => s.cmd.startsWith(prefix));
const terms = { "term-init": [step("kitchen init")], "term-ticket": [step("kitchen ticket")] };

// ── how it works ──
function how(t) {
  const X = [20, 248, 476, 704], W = 196, H = 84, Y1 = 26, Y2 = 196;
  const box = (c, y, title, l1, l2, o = {}) => `<g><rect x="${X[c]}" y="${y}" width="${W}" height="${H}" rx="12" fill="${o.sub ? t.sub : t.box}" stroke="${o.acc ? t.act : t.line}" stroke-width="${o.acc ? 1.5 : 1}"/>
<text x="${X[c] + 16}" y="${y + 30}" class="t">${title}</text><text x="${X[c] + 16}" y="${y + 51}" class="${o.mono ? "m" : "s"}">${l1}</text><text x="${X[c] + 16}" y="${y + 68}" class="s">${l2}</text></g>`;
  const arrow = (d, acc) => `<path d="${d}" fill="none" stroke="${acc ? t.act : t.mute}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#${acc ? "ha" : "hm"})"/>`;
  const my = Y1 + H / 2, ry = Y2 + H / 2, cx = (c) => X[c] + W / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 920 344" width="920" height="344" role="img" aria-label="How Kitchen works: you tell Claude Code or Codex what you want; the runner moves the job; one fresh worker per step writes into the job folder; the runner proves the work by driving your app through the Toolkit; you read the Report and merge.">
<defs><marker id="hm" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1.5,1.5L8,5L1.5,8.5" fill="none" stroke="${t.mute}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>
<marker id="ha" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1.5,1.5L8,5L1.5,8.5" fill="none" stroke="${t.act}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Helvetica,Arial,sans-serif}.t{font-size:15px;font-weight:600;fill:${t.fg}}.s{font-size:12.5px;fill:${t.mute}}.m{font-size:12px;fill:${t.mute};font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace}.l{font-size:12px;fill:${t.mute}}.la{font-size:12px;fill:${t.act};font-weight:600}</style>
<rect width="920" height="344" rx="14" fill="${t.bg}"/>
${box(0, Y1, "You", "say what you want,", "in plain words", { sub: true })}
${box(1, Y1, "Front desk", "Claude Code or Codex", "files it as a ticket")}
${box(2, Y1, "Runner", "plain code: moves the job,", "decides pass or fail")}
${box(3, Y1, "Workers", "one fresh agent per step:", "build, review, report")}
${box(0, Y2, "Report", "what changed and the proof.", "You merge.", { acc: true })}
${box(1, Y2, "Your app", "the real thing, running", "on your machine", { sub: true })}
${box(2, Y2, "Toolkit", "starts your app, clicks,", "reads, takes screenshots")}
${box(3, Y2, "Job folder", ".kitchen/jobs/&lt;id&gt;/", "state and signed evidence", { mono: true })}
${[0, 1, 2].map((c) => arrow(`M${X[c] + W + 5},${my}H${X[c + 1] - 6}`)).join("")}
${arrow(`M${cx(2)},${Y1 + H + 6}V${Y2 - 7}`, true)}<text x="${cx(2) + 10}" y="${(Y1 + H + Y2) / 2 + 4}" class="la">runs every proof</text>
${arrow(`M${X[2] - 5},${ry}H${X[1] + W + 6}`, true)}
${arrow(`M${X[2] + W + 5},${ry}H${X[3] - 6}`)}
${arrow(`M${cx(3)},${Y1 + H + 6}V${Y2 - 7}`)}<text x="${cx(3) + 10}" y="${(Y1 + H + Y2) / 2 + 4}" class="l">one file each</text>
${arrow(`M${cx(3)},${Y2 + H + 6}V312Q${cx(3)},320 ${cx(3) - 8},320H${cx(0) + 8}Q${cx(0)},320 ${cx(0)},312V${Y2 + H + 7}`)}<text x="${(cx(0) + cx(3)) / 2}" y="336" text-anchor="middle" class="l">the evidence becomes the Report</text>
${arrow(`M${cx(0)},${Y2 - 6}V${Y1 + H + 7}`)}<text x="${cx(0) + 10}" y="${(Y1 + H + Y2) / 2 + 4}" class="l">you read it, you merge</text>
</svg>\n`;
}
for (const k of ["light", "dark"]) fs.writeFileSync(`${img}how-it-works-${k}.svg`, how(T[k]));

// ── why icons: one accent that reads on white and on GitHub's dark ──
const A = "#e8590c";
const ico = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="${A}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`;
fs.writeFileSync(img + "why-driven.svg", ico(`<rect x="3.500" y="5.500" width="25" height="18" rx="3.500"/><path d="M14.500,12.500l8.500,3.200l-3.700,1.600l-1.600,3.700z" fill="${A}" stroke-width="1.400"/><path d="M11.500,27.500h9"/>`));
fs.writeFileSync(img + "why-evidence.svg", ico(`<path d="M16,3.500l10,3.600v7.400c0,6.400-4.200,11.200-10,13.500c-5.800-2.300-10-7.100-10-13.500V7.100z"/><path d="M11.400,15.800l3.400,3.400l6-7.200"/>`));
fs.writeFileSync(img + "why-merge.svg", ico(`<circle cx="9" cy="7.500" r="3"/><circle cx="9" cy="24.500" r="3"/><circle cx="23" cy="16" r="3"/><path d="M9,10.500v11M9,10.500c0,4 4.500,5.500 11,5.500"/>`));

const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
for (const [name, steps] of Object.entries(terms)) for (const k of ["light", "dark"]) {
  const p = await b.newPage({ viewport: { width: 960, height: 700 }, deviceScaleFactor: 2 });
  await p.setContent(term(steps, T[k]));
  const png = `${tmp}/${name}-${k}.png`;
  await (await p.$(".term")).screenshot({ path: png, omitBackground: true });
  execFileSync("cwebp", ["-quiet", "-lossless", png, "-o", `${img}${name}-${k}.webp`]);
  await p.close();
}
await b.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fs.readdirSync(img).join(" "));
