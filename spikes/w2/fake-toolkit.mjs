#!/usr/bin/env node
// A fake Toolkit for spikes/w2/probe.ts: no app, no Docker, answers from a
// table. FAULTS (rewritten by the spike per variant) breaks it the ways the
// W2 review found a broken Toolkit could still pass `toolkit check`:
//   okAll       every primitive answers ok:true (missing targets, other origins, a duplicated flag)
//   stdoutLogs  logs go to stdout next to the JSON line
//   twoDescribe describe prints two JSON lines
//   frobnicate  describe lists a primitive bin/dev doesn't implement
//   badUrl      up says url:"x"
//   noChecks    doctor says checks:[]
const FAULTS = new Set([]);

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
let dup = null;
for (const a of argv) {
  if (!a.startsWith("--")) {
    pos.push(a);
    continue;
  }
  const eq = a.indexOf("=");
  const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
  if (k in flags) dup = k;
  flags[k] = eq > 0 ? a.slice(eq + 1) : true;
}
const say = (o, code) => {
  if (FAULTS.has("stdoutLogs")) process.stdout.write(`[dev] ${pos[0]} running\n`);
  process.stdout.write(`${JSON.stringify(o)}\n`);
  process.exit(code ?? (o.ok === false || o.status === "fail" ? 1 : 0));
};
if (dup && !FAULTS.has("okAll")) say({ ok: false, status: "fail", out: `flag --${dup} given twice`, why: "dup", files: [] }, 2);
const state = path.join(process.env.KITCHEN_TOOLKIT_STATE || os.tmpdir(), "kitchen-fake-toolkit");
const prims = ["read", "open", "reload", "press", "type", "screenshot", "login", "http", ...(FAULTS.has("frobnicate") ? ["frobnicate"] : [])];
const sameOrigin = (p) => {
  try {
    return new URL(p, "http://127.0.0.1:1").origin === "http://127.0.0.1:1";
  } catch {
    return false;
  }
};
const cmd = pos[0];
switch (cmd) {
  case "describe": {
    const src = flags.src || path.resolve(import.meta.dirname, "..", "..", "..");
    const fdir = path.join(src, ".kitchen", "toolkit", "features");
    const features = fs.existsSync(fdir)
      ? fs
          .readdirSync(fdir)
          .filter((f) => f.endsWith(".md") && f !== "README.md")
          .map((f) => `features/${f}`)
      : [];
    const d = { contract: 1, surface: "web", primitives: prims, features, seed_users: ["alice"], externals: [], ports: { needs: 1 }, parallel: true };
    if (FAULTS.has("twoDescribe")) process.stdout.write(`${JSON.stringify({ ...d, toolkit: "draft" })}\n`);
    say(d);
    break;
  }
  case "prepare":
    say({ status: "ok", secs: 0 });
    break;
  case "up":
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, String(flags.id)), "up");
    say({ status: "ready", url: FAULTS.has("badUrl") ? "x" : `http://127.0.0.1:${String(flags.ports).split(",")[0]}` });
    break;
  case "doctor":
    say({ status: "ok", checks: FAULTS.has("noChecks") ? [] : [{ name: "up", ok: fs.existsSync(path.join(state, String(flags.id))) }] });
    break;
  case "reset":
  case "down":
    say({ status: "ok" });
    break;
  default: {
    if (!prims.includes(cmd) || (cmd === "frobnicate" && FAULTS.has("frobnicate"))) say({ status: "fail", why: `unknown command ${cmd}` }, 2);
    if (FAULTS.has("okAll")) say({ ok: true, out: "ok", files: [] });
    if (cmd === "read")
      say(flags.target === "body" || flags.target === undefined ? { ok: true, out: "hello", files: [] } : { ok: false, out: "no such element", files: [] });
    if (cmd === "open" || cmd === "http")
      say(sameOrigin(String(flags.path ?? "/")) ? { ok: true, out: "/", files: [] } : { ok: false, out: "leaves the app: refused", files: [] });
    if (cmd === "screenshot") {
      fs.writeFileSync(path.join(String(flags.out), "shot.png"), "png");
      say({ ok: true, out: "shot.png", files: ["shot.png"] });
    }
    say({ ok: true, out: null, files: [] });
  }
}
