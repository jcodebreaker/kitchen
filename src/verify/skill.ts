// The verify skill's skeleton (ADR 0017 §1): `kitchen init` writes `.claude/skills/verify-<app>/SKILL.md` and
// `features/README.md`, and the same files under `.agents/skills/` for Codex, filled from what init detected (how to
// start and reset the app, its health URL, the stable handles in its page code). No agent, no feature files: the
// first QA that touches a feature writes its file.
//
// Idempotent, and it never overwrites a person's edit: each generated file ends with a marker holding the hash of
// what Kitchen wrote. A file whose text still matches its marker is Kitchen's and may be refreshed; any other file
// (edited by a person, or by QA through a job) is kept as it is.
//
// The section shape (Launch, Doctor, Drive, Evidence, Cleanup; a README index with baseline preconditions, driving
// conventions and a feature entry contract) follows pstack's create-verification-skill (MIT © 2026 Lauren Tan, see
// NOTICE).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { slugify } from "../engine/store.ts";
import { SKILL_ROOTS, skillName } from "./map.ts";

const MARK = /\n?<!-- kitchen:generated ([0-9a-f]{12}) -->\s*$/;
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const stamp = (s: string) => `${s.trimEnd()}\n\n<!-- kitchen:generated ${hash(s.trimEnd())} -->\n`;
/** Kitchen wrote this text and nobody changed it since. */
export const untouched = (text: string) => {
  const m = MARK.exec(text);
  return !!m && hash(text.slice(0, m.index).trimEnd()) === m[1];
};

/** The app's name for the skill: package.json's name (without a scope), else the folder's. */
export function appName(repo: string): string {
  try {
    const n = (JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { name?: string }).name;
    if (n) return slugify(n.replace(/^@[^/]+\//, ""));
  } catch {}
  return slugify(path.basename(path.resolve(repo)));
}

const FRONT = /\.(html?|jsx?|tsx?|vue|svelte|erb|hbs|ejs|jinja2?|twig)$/;
const SKIP = new Set(["node_modules", ".git", ".kitchen", ".worktrees", "dist", "build", "coverage", ".claude", ".agents", "test", "tests", "__tests__"]);

/** Stable handles the page code already has (ids, aria-labels, test ids, form field names), at most `max`. */
export function detectHandles(repo: string, max = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (h: string) => {
    if (!seen.has(h) && out.length < max) {
      seen.add(h);
      out.push(h);
    }
  };
  const dirs = ["public", "src", "app", "pages", "components", "templates", "views", "static", "client", "web", "frontend"].filter((d) =>
    fs.existsSync(path.join(repo, d)),
  );
  const files: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4 || files.length > 200) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (FRONT.test(e.name) && !/\.(test|spec)\./.test(e.name)) files.push(p);
    }
  };
  for (const d of dirs) walk(path.join(repo, d), 0);
  // Only attributes of elements: an HTML/JSX tag, or the props of an `h("tag", { … })` / `createElement` call.
  const fmt: Record<string, (v: string) => string> = {
    id: (v) => `#${v}`,
    "aria-label": (v) => `[aria-label="${v}"]`,
    "data-testid": (v) => `[data-testid="${v}"]`,
    name: (v) => `[name="${v}"]`,
  };
  const attrs = (props: string) => {
    for (const m of props.matchAll(/["']?\b(id|name|aria-label|data-testid)["']?\s*[=:]\s*\{?["'`]([^"'`{}]{1,40})["'`]/g))
      if (m[1] !== "id" || /^[A-Za-z][\w-]*$/.test(m[2])) add(fmt[m[1]](m[2]));
  };
  for (const f of files.sort()) {
    const t = fs.readFileSync(f, "utf8");
    if (t.length > 400_000) continue;
    for (const m of t.matchAll(/<([a-zA-Z][\w-]*)(\s[^<>]*?)\/?>/g)) if (!["meta", "link", "script", "html"].includes(m[1].toLowerCase())) attrs(m[2]);
    for (const m of t.matchAll(/\b(?:h|createElement)\(\s*["']([a-z][\w-]*)["']\s*,\s*\{([^{}]*)\}/g)) attrs(m[2]);
  }
  return out;
}

export type SkillFacts = { name: string; app: Config["app"]; handles: string[]; seed: string | null };

export function skillFacts(repo: string, cfg: Config): SkillFacts {
  const seed = ["seed.json", "seed.sql", "db/seeds.rb", "prisma/seed.ts", "fixtures"].find((f) => fs.existsSync(path.join(repo, f))) ?? null;
  return { name: `verify-${appName(repo)}`, app: cfg.app, handles: detectHandles(repo), seed };
}

export function skillMd(f: SkillFacts): string {
  const app = f.name.replace(/^verify-/, "");
  const a = f.app;
  const launch = a.start
    ? [
        `- \`kitchen qa up <id>\` starts ${app} from the checkout you work in: \`${a.start}\` (kitchen.yaml \`app.start\`) on a free port in \`$PORT\`. It prints the URL; every other \`kitchen qa\` command follows it. \`<id>\` is what your brief names: the job, or the sweep or maintain run.`,
        `- Ready means \`${a.health}\` answers below 400 (it waits up to ${a.ready_timeout_sec}s). The app's output is \`app.log\` in your evidence folder.`,
        a.reset
          ? `- Fresh data: \`kitchen qa reset <id>\` stops the app, runs \`${a.reset}\` (kitchen.yaml \`app.reset\`) and starts it again on the seed data. Use it before a recipe that needs the seed state.`
          : "- No `app.reset` in kitchen.yaml: `kitchen qa reset <id>` only restarts, and the data is what earlier drives left. Order recipes so none depends on another's leftovers, and say so in your notes.",
      ]
    : [
        "- kitchen.yaml has no `app.start`: there is no app to launch. Check with the repo's tests and commands, saving their output as evidence. Add `app: { start: … }` to kitchen.yaml if there is an app.",
      ];
  const handles = f.handles.length
    ? `Handles found in the page code: ${f.handles.map((h) => `\`${h}\``).join(", ")}.`
    : "No ids or labels were found in the page code; prefer roles and visible text.";
  return `---
name: ${f.name}
description: "Check ${app} the way a person uses it: start it with kitchen qa, drive its pages and API, keep the evidence. Use to verify a change, to drive a feature from this skill's feature map (features/), or for a release sweep."
---

# Verify ${app}

How to start ${app}, drive it the way a user does, and keep proof a skeptical reviewer would accept. Kitchen's QA, merge-check and sweep agents follow it; \`features/\` says what to drive. Kitchen wrote this file from what it found in the repo: edit it freely (Kitchen never overwrites a file someone changed).

## Launch

${launch.join("\n")}

## Doctor

Run it before the first drive and after anything surprising:

- ${a.start ? `\`kitchen qa http <id> GET ${a.health} --name doctor\` answers below 400.` : "The repo's checks pass (kitchen.yaml `checks:`)."}
- Drive only the URL \`kitchen qa up\` printed for your \`<id>\`: never a port or an instance you didn't start, and never the person's own running copy.
- A page whose text file lists console errors before you acted is not worth driving: restart it (\`kitchen qa reset <id>\`) first.

## Drive

- Pages: \`kitchen qa page <id> <path> --name <feature>-<step>\` opens the page in Chromium (Playwright) and saves \`<name>.png\` and \`<name>.txt\` (final URL, title, visible text, console errors). To click or type first, pass \`--script <file.mjs>\`, a module whose \`export default async (page, ctx) => { … }\` drives \`page\`; \`ctx.url\` is the app's URL.
- API: \`kitchen qa http <id> <METHOD> <path> --name <feature>-<step> [--header 'K: v'] [--data '<json>']\` saves the request and response as \`<name>.http.txt\`.
- Stable handles, best first: roles and accessible names (\`page.getByRole("button", { name: "Save" })\`), labels (\`page.getByLabel("Search")\`), ids and test ids, then form field names. Never coordinates, tab order or CSS classes. ${handles}
- Wait for an observable end state (a row, a status, a URL), never a fixed sleep.

## Evidence

- Everything goes in the evidence folder your brief names (a job's QA folder, the merge-check folder, the sweep folder), named after the feature and step.
- Exercise the real user path, not internal setters or test-only routes. Capture the action and the resulting state, and a side effect where there is one (reload, or read it back through a second view).
- Open every screenshot you cite and look at it.

## Cleanup

- \`kitchen qa down <id>\` stops what \`kitchen qa up\` started, and nothing else. Never kill by process name.
- Cleanup never removes evidence: it stays in the evidence folder.

## Feature map

\`features/README.md\` is the index: baseline preconditions, driving conventions, the feature entry contract and the sweep order. Each \`features/<feature>.md\` is one user-facing feature: its sub-features, how a person gets to it, how to drive it with \`kitchen qa\`, its gotchas, and a last \`Code:\` line naming the files behind it. Kitchen drives a feature before every merge into staging that changes one of those files.
`;
}

export function readmeMd(f: SkillFacts): string {
  const app = f.name.replace(/^verify-/, "");
  const a = f.app;
  return `# ${app} feature map

The maintained description of what ${app} does for a person and how to check it. Read this index before driving the app, then the feature file you need; the launch and driving tools are in \`../SKILL.md\`. Kitchen's QA keeps it current: one file per user-facing feature, written by the first QA that touches the feature, updated by later ones.

## Baseline preconditions

- ${a.start ? `The app runs from \`kitchen qa up <id>\` (\`${a.start}\`), healthy at \`${a.health}\`.` : "There is no app to start (no `app.start`): features are checked with commands."}
- ${a.reset ? `Seed data: \`kitchen qa reset <id>\` puts it back (\`${a.reset}\`).` : "No reset command: the data is whatever earlier drives left."}${f.seed ? ` The seed is in \`${f.seed}\`.` : ""}
- Never drive an instance this run didn't start.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise.
- Prefer roles and accessible names, then labels, then ids, over CSS classes or position.
- Commands are literal: keep quoted names and flags as written.
- A mutation is proved by reading it back through a second view (a reload, another route).

## Proof and skip reporting

- Record the feature and step with every evidence file (name files \`<feature>-<step>\`).
- An unreachable path is reported with the command tried and the precondition that was missing, never as verified through another path.
- A recipe is never weakened to pass: fix how to reach something, never what is expected. A behaviour change on purpose is named by the ticket's intake (\`CHANGES: <feature>/<sub-feature>\`).

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing what a person can do. Then exactly four H2s, in this order:

1. \`Sub-features\`: short ids, one line each. Example line: - \`search-match\` finds books by title or author.
2. \`How to get to it (user POV)\`: every entry point a person uses.
3. \`Driving it with kitchen qa\`: a \`Preconditions:\` line and its bullets, then one bullet per step, each a bold label, the action, the exact command and the result you can see. Example step: - **Title match.** Type a title. Run \`kitchen qa page <id> / --name search-title --script search.mjs\`. Only the matching rows remain.
4. \`Gotchas\`: traps that waste or invalidate a run.

It ends with a \`Code:\` line naming the files or folders behind the feature, each in backticks. Example: Code: \`public/app.js\`, \`server.js\`. Kitchen drives the feature before every merge into staging that changes one of them.

## Sweep order

A full sweep (\`kitchen verify sweep\`) drives the features below top to bottom.

## Features

(None listed yet. The first QA that touches a feature adds its file; a feature not listed here is swept after the listed ones, by name. \`kitchen verify maintain\` keeps this list and its order: \`- [Title](./feature.md): what it covers.\`)
`;
}

export type SkillWrite = { path: string; did: "wrote" | "refreshed" | "kept" | "same" };

/** Write or refresh one file: missing → written; still Kitchen's → refreshed; changed by someone → kept. */
function put(file: string, text: string): SkillWrite["did"] {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return "wrote";
  }
  const have = fs.readFileSync(file, "utf8");
  if (have === text) return "same";
  if (!untouched(have)) return "kept";
  fs.writeFileSync(file, text);
  return "refreshed";
}

/**
 * The verify skill for both tools. An existing `verify-*` skill keeps its name. The Claude copy is written first;
 * the Codex copy mirrors it (it is only written where it is missing or still Kitchen's own).
 */
export function writeVerifySkill(repo: string, cfg: Config): { name: string; files: SkillWrite[] } {
  const facts = skillFacts(repo, cfg);
  const name = skillName(repo) ?? facts.name;
  const f = { ...facts, name };
  const files: SkillWrite[] = [];
  const gen: [string, string][] = [
    ["SKILL.md", stamp(skillMd(f))],
    ["features/README.md", stamp(readmeMd(f))],
  ];
  const [main, mirror] = SKILL_ROOTS;
  for (const [rel, text] of gen) {
    const p = path.join(repo, main, name, rel);
    files.push({ path: path.relative(repo, p), did: put(p, text) });
    const m = path.join(repo, mirror, name, rel);
    files.push({ path: path.relative(repo, m), did: put(m, fs.readFileSync(p, "utf8")) });
  }
  return { name, files };
}
