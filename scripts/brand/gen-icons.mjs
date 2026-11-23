// Logo B, the cook, in the product (run gen-logos.mjs first):
//   - docs/img/logo-light.svg and logo-dark.svg, the README's lockup;
//   - the dashboard's app icon and favicon: the 16px cut, inlined as data: URLs between the logo markers in
//     dashboard/dashboard.html (the page loads nothing from elsewhere; its CSP allows img-src data: only);
//   - plugins/kitchen/assets/icon.png, the plugin's 1024 px icon (the full mark on a white tile).
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs CHROMIUM=/path/to/chrome-headless-shell node scripts/brand/gen-icons.mjs
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "..", "..");
const logo = (f) => fs.readFileSync(path.join(here, "logos", f), "utf8");

// 1. The README's lockup.
fs.copyFileSync(path.join(here, "logos", "logo-b-light.svg"), path.join(root, "docs", "img", "logo-light.svg"));
fs.copyFileSync(path.join(here, "logos", "logo-b-dark.svg"), path.join(root, "docs", "img", "logo-dark.svg"));

// 2. The dashboard. Its theme can differ from the system's (the Theme button), so the app icon comes in two fixed
// colourings, swapped by the page's own theme rules; the favicon keeps the system-following one.
const PALETTE = { light: { ink: "#18181b", acc: "#d9480f" }, dark: { ink: "#ededf0", acc: "#ff8a3d" } };
const fixed = (svg, k) =>
  svg
    .replace(/<style>[\s\S]*?<\/style>/, `<style>.ink{fill:${PALETTE[k].ink}}.inks{fill:none;stroke:${PALETTE[k].ink};stroke-linecap:round;stroke-linejoin:round}.accs{fill:none;stroke:${PALETTE[k].acc};stroke-linecap:round;stroke-linejoin:round}</style>`)
    .replace(/<title>.*?<\/title>/, "");
const data = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg.replace(/\n/g, "")).toString("base64")}`;
const small = logo("logo-b-mark-16.svg");
const css = [
  "/* logo:start (scripts/brand/gen-icons.mjs writes this block: logo B, the cook, 16px cut) */",
  `:root{--logo:url("${data(fixed(small, "light"))}")}`,
  `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--logo:url("${data(fixed(small, "dark"))}")}}`,
  `:root[data-theme="dark"]{--logo:url("${data(fixed(small, "dark"))}")}`,
  "/* logo:end */",
].join("\n");
const favicon = `<!-- favicon:start --><link rel="icon" type="image/svg+xml" href="${data(small)}"><!-- favicon:end -->`;
const page = path.join(root, "dashboard", "dashboard.html");
let html = fs.readFileSync(page, "utf8");
const swap = (re, text, what) => {
  if (!re.test(html)) throw new Error(`dashboard.html has no ${what} markers`);
  html = html.replace(re, () => text);
};
swap(/\/\* logo:start[\s\S]*?\/\* logo:end \*\//, css, "logo");
swap(/<!-- favicon:start -->[\s\S]*?<!-- favicon:end -->/, favicon, "favicon");
fs.writeFileSync(page, html);

// 3. The plugin icon: a PNG (the plugin directories take no SVG), 1024 px.
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
await p.setContent(
  `<body style="margin:0;background:transparent"><div style="width:1024px;height:1024px;border-radius:224px;background:#fff;display:grid;place-items:center"><img style="width:720px;height:720px" src="${data(fixed(logo("logo-b-mark.svg"), "light"))}"></div></body>`,
);
const icon = path.join(root, "plugins", "kitchen", "assets", "icon.png");
fs.mkdirSync(path.dirname(icon), { recursive: true });
await p.screenshot({ path: icon, omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
await b.close();
console.log("docs/img/logo-{light,dark}.svg, dashboard/dashboard.html (app icon, favicon), plugins/kitchen/assets/icon.png");
