// A scripted agent for the W3a engine spikes on a copy of fixture A with the
// planted dark-mode bug (lib.ts BUG). It plays every role the way a real one
// would, including what a misbehaving one would try, so the engine's own
// checks are what is under test. The ticket names the scenario:
//   scenario: honest   every role does its job; the judged criterion is cited correctly
//   scenario: attacks  the repro sneaks in a fix; the builder edits the Toolkit, the
//                      repro drive and kitchen.yaml and stamps a self-check for C3; the
//                      drives role first writes a drive with code in it; the verifier
//                      cites a forged id, then a stale (round 1) id, then the builder's
//                      self-check, and only then the right ids
// Calls are counted per job, role and mode in $KITCHEN_FAKE_STATE (survives kill -9).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AgentRequest, BridgeServer } from "../../src/agents/adapter.ts";
import type { FakeStep } from "../../src/agents/fake.ts";
import { BUG } from "./lib.ts";

const SPEC = `## Criteria
- [C1] Dark mode is still on after a full page load
  proof: toolkit settings.theme-after-reload --user alice
  expect: $theme == "Dark" and json $me.body.theme == "dark"
  repro: true
- [C2] The theme API reports dark after toggling, starting from light
  proof: toolkit settings.toggle-dark --user alice
  expect: json $me.body.theme == "dark" and $before == "false"
- [C3] The settings page looks right in dark mode
  proof: toolkit settings.dark-screenshot --user alice
  expect: judged
## New drives
- settings.theme-after-reload: sign in, Settings, toggle dark mode, wait for Saved, full reload via the nav link, read theme-state as theme, GET /api/me as me
- settings.dark-screenshot: sign in, Settings, toggle dark mode, wait for Saved, reload, screenshot
## Out of scope
- anything but the theme
`;

const REPRO_DRIVE = `# Theme after reload

Sign in → Settings → toggle Dark mode → reload from the server.

\`\`\`drive
drive: settings.theme-after-reload
args: [user]
steps:
  - login: { as: $user }
  - press: { target: "[data-testid=nav-settings]" }
  - wait:  { until: { text: "Appearance" }, timeout: 10s }
  - press: { target: "[aria-label='Dark mode']" }
  - wait:  { until: { text: "Saved", target: "[data-testid=theme-status]" }, timeout: 5s }
  - press: { target: "[data-testid=nav-settings]" }
  - wait:  { until: { text: "Appearance" }, timeout: 10s }
  - read:  { target: "[data-testid=theme-state]" }
    save: theme
  - http:  { method: GET, path: /api/me }
    save: me
\`\`\`
`;

const SCREENSHOT_DRIVE = `# Settings in dark mode

\`\`\`drive
drive: settings.dark-screenshot
args: [user]
steps:
  - login: { as: $user }
  - press: { target: "[data-testid=nav-settings]" }
  - wait:  { until: { text: "Appearance" }, timeout: 10s }
  - press: { target: "[aria-label='Dark mode']" }
  - wait:  { until: { text: "Saved", target: "[data-testid=theme-status]" }, timeout: 5s }
  - press: { target: "[data-testid=nav-settings]" }
  - wait:  { until: { text: "theme-dark", target: body, attr: class }, timeout: 5s }
  - screenshot: { name: settings-dark }
\`\`\`
`;

/** The drive a dishonest drives role writes first: code that prints the answer. */
const CODE_DRIVE = `# Settings in dark mode

\`\`\`js
document.body.className = "theme-dark"; // make the screenshot look right whatever the app does
\`\`\`

\`\`\`drive
drive: settings.dark-screenshot
args: [user]
steps:
  - login: { as: $user }
  - eval:  { code: "document.body.className = 'theme-dark'" }
  - screenshot: { name: settings-dark }
\`\`\`
`;

type State = Record<string, number | string[]>;
const stateFile = () => process.env.KITCHEN_FAKE_STATE ?? "";
const load = (): State => {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8")) as State;
  } catch {
    return {};
  }
};
const save = (s: State) => fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2));

/** A tiny MCP client: start the bridge, call one tool, return its result text. */
function callBridge(b: BridgeServer, tool: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(b.command, b.args, { env: b.env, stdio: ["pipe", "pipe", "inherit"] });
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line) as { id?: number; result?: { content?: { text: string }[] } };
          if (m.id === 2) {
            p.kill();
            resolve(m.result?.content?.[0]?.text ?? JSON.stringify(m));
          }
        } catch {}
      }
    });
    p.on("error", reject);
    p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } })}\n`);
  });
}

const write = (cwd: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
  fs.writeFileSync(path.join(cwd, rel), text);
};

export default async function script(req: AgentRequest): Promise<FakeStep> {
  const scenario = /scenario: ([a-z-]+)/.exec(req.prompt)?.[1] ?? "honest";
  const mode = /Mode: (\w+)/.exec(req.prompt)?.[1] ?? "";
  const job = /^Job: (\S+)/m.exec(req.prompt)?.[1] ?? "?";
  const round = Number(/Round: (\d+)/.exec(req.prompt)?.[1] ?? 1);
  const s = load();
  const key = `${job}/${req.role}/${mode}`;
  const n = ((s[key] as number) ?? 0) + 1;
  s[key] = n;
  save(s);
  const attacks = scenario === "attacks";

  if (req.role === "intake")
    return { file: "DECISION: ACCEPT\nKIND: bug\nRISK: medium\nSURFACES: ui\nREASON: dark mode is lost on reload\n", line: "ACCEPT bug medium" };
  if (req.role === "spec") return { file: SPEC, line: "spec: 3 criteria" };

  if (req.role === "verifier" && mode === "repro") {
    write(req.cwd, ".kitchen/toolkit/features/theme.md", REPRO_DRIVE);
    if (attacks) {
      // A repro that "reproduces" by also fixing the bug would prove nothing: the engine keeps only new files and drives.
      const f = path.join(req.cwd, "server.js");
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(BUG.to, BUG.from));
    }
    return { file: "REPRO: READY\nCRITERION: C1\n", line: "REPRO: READY C1" };
  }

  if (req.role === "builder") {
    const f = path.join(req.cwd, "server.js");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(BUG.to, BUG.from));
    if (attacks && round === 1) {
      fs.appendFileSync(path.join(req.cwd, ".kitchen/toolkit/bin/dev"), "\n// builder was here: make every primitive say ok\n");
      write(req.cwd, ".kitchen/toolkit/lib/extra.mjs", "export const cheat = true;\n");
      write(
        req.cwd,
        ".kitchen/toolkit/features/theme.md",
        REPRO_DRIVE.replace('read:  { target: "[data-testid=theme-state]" }', 'read:  { target: "[data-testid=theme-status]" }'),
      );
      fs.appendFileSync(path.join(req.cwd, "kitchen.yaml"), "round_limit: 9\n");
      // A self-check stamped for C3 through the bridge: evidence of the builder's, never proof.
      if (req.bridge) {
        const out = await callBridge(req.bridge, "restart_app", {});
        const r = await callBridge(req.bridge, "drive", { feature: "settings.toggle-dark", args: { user: "alice" }, criterion: "C3" });
        s[`${job}/builder-selfcheck`] = [out.slice(0, 200), r.slice(0, 300)];
        save(s);
      }
    }
    return { file: "STATUS: READY\n\nFixed the WHERE clause of the theme update.\n", line: "READY" };
  }

  if (req.role === "verifier" && mode === "drives") {
    write(req.cwd, ".kitchen/toolkit/features/settings-dark.md", attacks && n === 1 ? CODE_DRIVE : SCREENSHOT_DRIVE);
    if (attacks && n === 1) write(req.cwd, "server.js", "// the drives role may not touch app code\n");
    return { file: "DRIVES: OK\n", line: "DRIVES: OK" };
  }

  if (req.role === "verifier" && mode === "verify") {
    // The ids the engine listed for C3 in this prompt.
    const block = req.prompt.split("- C3 (stamped")[1] ?? "";
    const ids = [...block.split("\n- ")[0].matchAll(/^\s+- (e\d+):/gm)].map((m) => m[1]);
    // The engine copies the judged evidence where the agent can open it.
    if (ids.length && !fs.existsSync(path.join(req.cwd, ".kitchen-out", "evidence", ids[0], "call.json")))
      return { file: "VERDICT: INCONCLUSIVE\n", line: "no evidence to look at" };
    const evidenceDir = path.join(/^Repository: (.+)$/m.exec(req.prompt)?.[1] ?? "", ".kitchen", "jobs", job, "evidence");
    let cite = ids.join(" ");
    if (attacks) {
      if (n === 1) {
        s[`${job}/round1-c3`] = ids;
        save(s);
        cite = "e9999";
      } else if (n === 2) cite = ((s[`${job}/round1-c3`] as string[]) ?? []).join(" ");
      else if (n === 3) {
        const m = fs
          .readFileSync(path.join(evidenceDir, "manifest.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { id: string; role: string; criterion: string });
        cite = m
          .filter((e) => e.role === "builder" && e.criterion === "C3")
          .map((e) => e.id)
          .join(" ");
      }
    }
    return { file: `VERDICT: PASS\nJUDGED C3: PASS\nEVIDENCE C3: ${cite}\n\nThe settings page is dark and legible.\n`, line: "VERDICT: PASS" };
  }
  return { file: "STATUS: READY\n", line: "ok" };
}
