// Generates the three Kitchen logo directions as plain SVGs (no fonts: the wordmark is drawn as strokes), into
// scripts/brand/logos/. The user picked B, the cook; scripts/brand/gen-icons.mjs puts it in the product.
//   node scripts/brand/gen-logos.mjs
import fs from "node:fs";
import path from "node:path";
const out = path.resolve(path.dirname(new URL(import.meta.url).pathname), "logos");
fs.mkdirSync(out, { recursive: true });

// Theme: colours are CSS variables with light fallbacks; dark is a media query inside each file.
const style = (extra = "") => `<style>
.ink{fill:var(--k-ink,#18181b)}.inks{fill:none;stroke:var(--k-ink,#18181b);stroke-linecap:round;stroke-linejoin:round}
.acc{fill:var(--k-acc,#d9480f)}.accs{fill:none;stroke:var(--k-acc,#d9480f);stroke-linecap:round;stroke-linejoin:round}
.pap{fill:var(--k-paper,#fff)}.paps{fill:none;stroke:var(--k-paper,#fff);stroke-linecap:round;stroke-linejoin:round}
.acct{fill:none;stroke:var(--k-acc-tile,#ff8a3d);stroke-linecap:round;stroke-linejoin:round}
@media (prefers-color-scheme:dark){.ink{fill:var(--k-ink,#ededf0)}.inks{stroke:var(--k-ink,#ededf0)}.acc{fill:var(--k-acc,#ff8a3d)}.accs{stroke:var(--k-acc,#ff8a3d)}.pap{fill:var(--k-paper,#0f1011)}.paps{stroke:var(--k-paper,#0f1011)}.acct{stroke:var(--k-acc-tile,#d9480f)}}
${extra}</style>`;
const fixed = (svg, dark) => svg.replace(/<style>[\s\S]*?<\/style>/, () => {
  const c = dark ? { ink: "#ededf0", acc: "#ff8a3d", pap: "#0f1011", tile: "#d9480f" } : { ink: "#18181b", acc: "#d9480f", pap: "#ffffff", tile: "#ff8a3d" };
  return `<style>.ink{fill:${c.ink}}.inks{fill:none;stroke:${c.ink};stroke-linecap:round;stroke-linejoin:round}.acc{fill:${c.acc}}.accs{fill:none;stroke:${c.acc};stroke-linecap:round;stroke-linejoin:round}.pap{fill:${c.pap}}.paps{fill:none;stroke:${c.pap};stroke-linecap:round;stroke-linejoin:round}.acct{fill:none;stroke:${c.tile};stroke-linecap:round;stroke-linejoin:round}</style>`;
});

// ── wordmark: "kitchen", monoline, x-height 20, ascender 30, baseline y=0 ──
const S = 4.4, G = 8.2;
const glyphs = {
  k: { l: 0, r: 13, d: "M0,-30V0M12.5,-20L0.6,-8.6M5,-12.8L13,0" },
  i: { l: 0, r: 0, d: "M0,-20V0", dot: [0, -28.2] },
  t: { l: -5.5, r: 7, d: "M0,-27V-5.5Q0,0 5.5,0H7M-5.5,-20H6.5" },
  c: { l: 0, r: 17.2, d: "M17.2,-16.9A10,10 0 1 0 17.2,-3.1" },
  h: { l: 0, r: 16, d: "M0,-30V0M0,-12A8,8 0 0 1 16,-12V0" },
  e: { l: 0, r: 20, d: "M0,-10H20A10,10 0 1 0 17.2,-3.1" },
  n: { l: 0, r: 16, d: "M0,-20V0M0,-12A8,8 0 0 1 16,-12V0" },
};
// opts.tittle: "dot" | "check"
function wordmark(x, baseline, k, opts = {}) {
  let cx = 0, parts = [], tittle = "";
  for (const ch of "kitchen") {
    const g = glyphs[ch];
    const ox = cx - g.l;
    parts.push(`<path transform="translate(${ox.toFixed(2)},0)" d="${g.d}"/>`);
    if (g.dot) {
      tittle = opts.tittle === "check"
        ? `<path class="accs" stroke-width="${S * 0.92}" d="M${(ox - 2.2).toFixed(2)},-29.4l2.9,3l5.8,-7.4"/>`
        : `<circle class="${opts.accDot ? "acc" : "ink"}" cx="${ox.toFixed(2)}" cy="${g.dot[1]}" r="${(S * 0.66).toFixed(2)}"/>`;
    }
    cx = ox + g.r + G;
  }
  const w = (cx - G) * k;
  return { w, svg: `<g transform="translate(${x},${baseline}) scale(${k})"><g class="inks" stroke-width="${S}">${parts.join("")}</g>${tittle}</g>` };
}

// ── marks, each in a 64×64 box ──
const brace = (x, y, flip) => `<path transform="translate(${x},${y})${flip ? " scale(-1,1)" : ""}" d="M5.5,0C2.6,0 2.6,1.6 2.6,3.6V5.2C2.6,6.8 1.6,7.6 0,7.6C1.6,7.6 2.6,8.4 2.6,10V11.6C2.6,13.6 2.6,15.2 5.5,15.2"/>`;
function arcs(cx, cy, r, n, gap, start) {
  let d = "";
  for (let i = 0; i < n; i++) {
    const a0 = ((start + i * (360 / n) + gap / 2) * Math.PI) / 180, a1 = ((start + (i + 1) * (360 / n) - gap / 2) * Math.PI) / 180;
    d += `M${(cx + r * Math.cos(a0)).toFixed(2)},${(cy + r * Math.sin(a0)).toFixed(2)}A${r},${r} 0 0 1 ${(cx + r * Math.cos(a1)).toFixed(2)},${(cy + r * Math.sin(a1)).toFixed(2)}`;
  }
  return d;
}
const marks = {
  // A: K as a stem and a chevron: the letter, and a prompt turned to face it.
  a: `<rect class="ink" x="4" y="4" width="56" height="56" rx="15"/><path class="paps" stroke-width="7.6" d="M23,19V45"/><path class="acct" stroke-width="7.6" d="M45.5,19L32.5,32L45.5,45"/>`,
  // B: the agent is the pot: lid and knob for a head, handles for arms, steam that rises as { }.
  b: `<g transform="translate(0,3)"><g class="accs" stroke-width="3.4">${brace(19.2, 1.6)}${brace(44.8, 1.6, true)}</g><circle class="ink" cx="32" cy="17.4" r="3"/><path class="inks" stroke-width="5.2" d="M13,24.6H51M6.6,37.4H10.6M53.4,37.4H57.4"/><path class="ink" fill-rule="evenodd" d="M16.5,29.6H47.5A2.5,2.5 0 0 1 50,32.1V44A12,12 0 0 1 38,56H26A12,12 0 0 1 14,44V32.1A2.5,2.5 0 0 1 16.5,29.6ZM25.4,37.6a3.5,3.5 0 1 0 0.01,0ZM38.6,37.6a3.5,3.5 0 1 0 0.01,0Z"/></g>`,
  // C: a ticket enters, goes round the stages, and comes back in as a check.
  c: `<path class="inks" stroke-width="6.4" d="${arcs(32, 32, 23.5, 3, 30, -75)}"/><path class="accs" stroke-width="6.4" d="M22.6,32.8L29.4,39.6L41.6,25"/>`,
};
const potSmall = `<circle class="ink" cx="32" cy="8.500" r="4"/><path class="inks" stroke-width="7" d="M9,18.500H55M4.500,35H7M57,35H59.500"/><path class="ink" fill-rule="evenodd" d="M14,26H50A3,3 0 0 1 53,29V44A15,15 0 0 1 38,59H26A15,15 0 0 1 11,44V29A3,3 0 0 1 14,26ZM23.500,35.500a5,5 0 1 0 0.010,0ZM40.500,35.500a5,5 0 1 0 0.010,0Z"/>`;
const titles = { a: "Kitchen: K monogram", b: "Kitchen: the cook", c: "Kitchen: wordmark" };
const wrap = (w, h, body, title) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${title}"><title>${title}</title>${style()}${body}</svg>\n`;

const files = {};
for (const d of ["a", "b", "c"]) {
  files[`logo-${d}-mark.svg`] = wrap(64, 64, marks[d], titles[d]);
}
files["logo-b-mark-16.svg"] = wrap(64, 64, potSmall, "Kitchen: the cook, small sizes");
// A and B: symbol + wordmark. C: the wordmark leads, its tittle is the check; the track is its favicon.
{
  const wm = wordmark(80, 44, 1.2);
  files["logo-a.svg"] = wrap(Math.ceil(80 + wm.w + 8), 64, marks.a + wm.svg, "Kitchen");
  files["logo-b.svg"] = wrap(Math.ceil(80 + wm.w + 8), 64, marks.b + wm.svg, "Kitchen");
  const wc = wordmark(8, 52, 1.45, { tittle: "check" });
  files["logo-c.svg"] = wrap(Math.ceil(wc.w + 16), 64, wc.svg, "Kitchen");
}
// B, large: the same pot with its arms out, a whisk in one hand and a spatula in the other.
files["logo-b-character.svg"] = wrap(112, 96, `<g transform="translate(24,26)">${marks.b}</g>
<path class="inks" stroke-width="5.2" d="M31,66.4H22Q13,66.4 13,57.4V52M81,66.4H90Q99,66.4 99,57.4V52"/>
<path class="inks" stroke-width="3.6" d="M13,52V40M99,52V38"/>
<path class="inks" stroke-width="2.6" d="M13,40C3.5,31 6,12 13,12C20,12 22.500,31 13,40ZM13,40V13"/>
<path class="ink" fill-rule="evenodd" d="M95,10H103A3.500,3.500 0 0 1 106.500,13.500V34.500A3.500,3.500 0 0 1 103,38H95A3.500,3.500 0 0 1 91.500,34.500V13.500A3.500,3.500 0 0 1 95,10ZM95.400,15.500V28.500H97.400V15.500ZM100.600,15.500V28.500H102.600V15.500Z"/>`, "Kitchen: the cook, with whisk and spatula");

for (const [name, svg] of Object.entries(files)) {
  fs.writeFileSync(path.join(out, name), svg);
  if (/^logo-[abc]\.svg$/.test(name)) {
    fs.writeFileSync(path.join(out, name.replace(".svg", "-light.svg")), fixed(svg, false));
    fs.writeFileSync(path.join(out, name.replace(".svg", "-dark.svg")), fixed(svg, true));
  }
}
fs.writeFileSync(path.join(out, "marks.json"), JSON.stringify({ marks, potSmall, files }));
console.log(Object.keys(files).join(" "));
