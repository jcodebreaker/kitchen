// ADR 0023: one profile per tool (the flat form still means the active tool's), what each tool can run listed from
// the tool and its providers (stand-in fetch, no network), a change written to kitchen.yaml with its comments kept,
// and `models check` only ever through the tool's own CLI (a stand-in here: never a paid request in tests).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { loadConfig, modelFor, parseConfig, profileOf } from "../config.ts";
import { act } from "../dashboard/actions.ts";
import { checkCommand, checkModels, listModels, parseCodexConfig, roleOf, setModel } from "./models.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-models-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const repo = (yaml: string) => {
  const r = path.join(root, `r${++n}`);
  fs.mkdirSync(r);
  fs.writeFileSync(path.join(r, "kitchen.yaml"), yaml);
  return r;
};

test("profiles: the flat form is the active tool's; each tool keeps its own; a tool's profile wins over the flat keys", () => {
  const old = parseConfig("models: { reviewer: opus, qa: cheap }\n");
  assert.equal(modelFor(old, "reviewer"), "opus");
  assert.equal(modelFor(old, "qa"), "haiku", "a tier through the tool's table");
  assert.equal(modelFor(old, "intake"), "opus");
  const both = parseConfig(
    "agent: { tool: claude }\nmodels:\n  reviewer: sonnet\n  claude: { reviewer: fable, builder: sonnet }\n  codex: { intake: gpt-5.4, builder: gpt-5.4-mini }\n",
  );
  assert.equal(modelFor(both, "reviewer"), "fable", "the tool's own profile wins");
  assert.equal(modelFor(both, "builder"), "sonnet");
  assert.equal(modelFor(both, "intake", "codex"), "gpt-5.4");
  assert.equal(modelFor(both, "reviewer", "codex"), "gpt-5.6-terra", "the flat keys aren't the inactive tool's");
  const codex = parseConfig("agent: { tool: codex }\nmodels:\n  claude: { reviewer: opus }\n  codex: { reviewer: gpt-5.4 }\n");
  assert.equal(modelFor(codex, "reviewer"), "gpt-5.4", "switching agent.tool keeps each tool's choices");
  assert.equal(modelFor(codex, "reviewer", "claude"), "opus");
  assert.deepEqual(profileOf(codex, "claude"), { intake: "strong", builder: "strong", qa: "medium", reviewer: "opus" });
  assert.throws(() => parseConfig("models: { claude: { tester: opus } }\n"), /models\.claude/);
});

test("set writes the tool's profile into kitchen.yaml, comments kept; a bad value changes nothing", () => {
  const r = repo("# my comment\nagent: { tool: claude }\nmodels: { qa: cheap } # tiers\n");
  assert.deepEqual(setModel(r, "reviewer", "opus"), { tool: "claude", role: "reviewer", model: "opus" });
  const text = fs.readFileSync(path.join(r, "kitchen.yaml"), "utf8");
  assert.match(text, /# my comment/);
  assert.match(text, /# tiers/);
  assert.equal(modelFor(loadConfig(r), "reviewer"), "opus");
  assert.equal(modelFor(loadConfig(r), "qa"), "haiku", "the other lanes as they were");
  setModel(r, "builder", "gpt-5.4-mini", "codex");
  assert.equal(modelFor(loadConfig(r), "builder", "codex"), "gpt-5.4-mini");
  assert.equal(modelFor(loadConfig(r), "builder"), "opus");
  assert.throws(() => setModel(r, "qa", "opus; rm -rf"), /a tier .* or a model name/);
  assert.equal(roleOf("review"), "reviewer");
  assert.equal(roleOf("build"), "builder");
  assert.equal(roleOf("tester"), null);
});

test("the dashboard's models-set is the same verb", async () => {
  const r = repo("agent: { tool: claude }\n");
  const ok = await act(r, "models-set", { lane: "review", model: "fable" });
  assert.deepEqual(ok, { ok: true, lines: ["Claude Code · review runs on fable from the next lane a job starts"] });
  assert.equal(modelFor(loadConfig(r), "reviewer"), "fable");
  await assert.rejects(act(r, "models-set", { lane: "tester", model: "x" }), /lane/);
});

test("listing: Claude Code's aliases, plus Anthropic's models API with a key; Codex's providers and their /models", async () => {
  const r = repo("agent: { tool: claude }\nmodels: { claude: { reviewer: opus } }\n");
  const asked: string[] = [];
  const fake = (async (u: string, init?: { headers?: Record<string, string> }) => {
    asked.push(`${u} ${JSON.stringify(init?.headers ?? {})}`);
    if (u.startsWith("https://api.anthropic.com/v1/models"))
      return new Response(JSON.stringify({ data: [{ id: "claude-opus-5-5" }, { id: "claude-sonnet-5" }] }));
    if (u === "http://127.0.0.1:1/v1/models") return new Response(JSON.stringify({ data: [{ id: "qwen-coder" }] }));
    return new Response("nope", { status: 500 });
  }) as unknown as typeof fetch;
  const none = await listModels(r, { env: {}, fetch: fake });
  assert.deepEqual(
    none.choices.map((c) => c.id),
    ["fable", "opus", "sonnet", "haiku"],
  );
  assert.equal(asked.length, 0, "no key: no request");
  assert.deepEqual(
    none.lanes.map((l) => [l.lane, l.model]),
    [
      ["intake", "opus"],
      ["build", "opus"],
      ["QA", "sonnet"],
      ["review", "opus"],
    ],
  );
  const withKey = await listModels(r, { env: { ANTHROPIC_API_KEY: "k" }, fetch: fake });
  assert.ok(withKey.choices.some((c) => c.id === "claude-opus-5-5" && c.from === "Anthropic models API"));
  assert.match(asked[0], /"x-api-key":"k"/);

  const home = path.join(root, "codex-home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "config.toml"),
    'model = "gpt-5.4-mini"\nmodel_provider = "local"\n\n[model_providers.local]\nname = "Local"\nbase_url = "http://127.0.0.1:1/v1"\n\n[model_providers.azure]\nbase_url = "https://x.example/v1"\nenv_key = "AZURE_KEY"\n',
  );
  const cx = await listModels(r, { tool: "codex", env: {}, fetch: fake, codexHome: home });
  assert.deepEqual(
    cx.choices.map((c) => [c.id, c.from]),
    [
      ["gpt-5.4-mini", "~/.codex/config.toml"],
      ["qwen-coder", "Local"],
      ["gpt-5.6-terra", "kitchen.yaml"],
    ],
  );
  assert.match(cx.notes.join("\n"), /AZURE_KEY isn't set/);
  assert.deepEqual(parseCodexConfig('# c\nmodel = "m" # x\n[model_providers."p"]\nbase_url = "u"\n').providers, { p: { base_url: "u" } });
});

test("check sends one tiny request per distinct chosen model, through the tool's CLI (a stand-in binary here)", async () => {
  const r = repo("agent: { tool: claude }\nmodels: { claude: { intake: opus, builder: sonnet, qa: sonnet, reviewer: fable } }\n");
  const runs: string[][] = [];
  const rs = await checkModels(r, {
    env: { KITCHEN_CLAUDE_BIN: "/fake/claude" },
    run: async (argv) => {
      runs.push(argv);
      return argv.includes("fable") ? { code: 1, out: "model not found" } : { code: 0, out: "ok" };
    },
  });
  assert.deepEqual(
    runs.map((a) => a.slice(0, 4)),
    [
      ["/fake/claude", "-p", "--model", "opus"],
      ["/fake/claude", "-p", "--model", "sonnet"],
      ["/fake/claude", "-p", "--model", "fable"],
    ],
  );
  assert.deepEqual(
    rs.map((x) => [x.model, x.lanes.join(","), x.ok]),
    [
      ["opus", "intake", true],
      ["sonnet", "build,QA", true],
      ["fable", "review", false],
    ],
  );
  assert.deepEqual(checkCommand("codex", "gpt-5.4", { KITCHEN_CODEX_BIN: "/fake/codex" }).slice(0, 4), ["/fake/codex", "exec", "-m", "gpt-5.4"]);
});
