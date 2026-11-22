// The W3b scripted agent: spikes/w3a/fake-agent.ts (fixture A, the planted dark-mode
// bug) plus what the later stages need:
//   reviewer-*   VERDICT: PASS (W4 builds the real lenses)
//   builder      when Ready left a merge with the base in progress, resolves the conflict
//                markers by taking the base's side, then makes the same fix as w3a's builder
//   smith        (scenario: primitive) adds a real, generic `sql` primitive to the Toolkit
//                in its own worktree: read-only SELECT through the slot's Postgres container
import fs from "node:fs";
import path from "node:path";
import type { AgentRequest } from "../../src/agents/adapter.ts";
import type { FakeStep } from "../../src/agents/fake.ts";
import w3a from "../w3a/fake-agent.ts";

/** Resolve `<<<<<<< … ======= … >>>>>>>` blocks to the second (incoming: the base's) side. */
export function takeTheirs(text: string): string {
  return text.replace(/<<<<<<< [^\n]*\n[\s\S]*?\n=======\n([\s\S]*?)>>>>>>> [^\n]*\n/g, "$1");
}

/** The `sql` primitive the scripted smith adds: a table entry plus a branch before the browser driver. */
export function addSqlPrimitive(toolkitDir: string) {
  const f = path.join(toolkitDir, "bin", "dev");
  let s = fs.readFileSync(f, "utf8");
  if (s.includes("  sql: {")) return;
  s = s.replace(
    "const PRIMITIVES = {\n",
    'const PRIMITIVES = {\n  sql: { args: { query: "one read-only SELECT (default: SELECT 1)" }, does: "rows of a read-only SELECT against the app database, as JSON" },\n',
  );
  s = s.replace(
    '  if (op === "http" && typeof args.body === "string") args.body = JSON.parse(args.body);',
    `  if (op === "sql") {
    const q = String(args.query ?? "SELECT 1").trim();
    if (!/^select\\b/i.test(q) || q.includes(";")) return out({ ok: false, out: "sql takes one read-only SELECT", files: [] });
    const env = readEnvFile(path.join(s.src, ".env.kitchen"));
    const r = run("docker", ["exec", s.container || containerName(id), "psql", "-U", env.POSTGRES_USER, "-d", env.POSTGRES_DB, "-At", "-v", "ON_ERROR_STOP=1", "-c", \`SELECT coalesce(json_agg(t), '[]'::json) FROM (\${q}) t\`], { quiet: true });
    if (r.code !== 0) return out({ ok: false, out: (r.stderr || "query failed").trim().split("\\n").pop(), files: [] });
    return out({ ok: true, out: JSON.parse(r.stdout.trim() || "[]"), files: [] });
  }
  if (op === "http" && typeof args.body === "string") args.body = JSON.parse(args.body);`,
  );
  fs.writeFileSync(f, s);
}

export default async function script(req: AgentRequest): Promise<FakeStep> {
  if (req.role.startsWith("reviewer")) return { file: "VERDICT: PASS\n\nNothing blocking.\n", line: "VERDICT: PASS" };
  if (req.role === "smith") {
    const gap = /Missing primitive: (\S+)/.exec(req.prompt)?.[1] ?? "?";
    if (gap !== "sql") return w3a(req);
    addSqlPrimitive(path.join(req.cwd, ".kitchen", "toolkit"));
    return { file: "STATUS: READY\nPRIMITIVE: sql\nSUMMARY: sql --query <SELECT>: rows as JSON\n", line: "READY sql" };
  }
  if (req.role === "builder") {
    for (const f of ["server.js"]) {
      const p = path.join(req.cwd, f);
      const t = fs.readFileSync(p, "utf8");
      if (t.includes("<<<<<<< ")) fs.writeFileSync(p, takeTheirs(t));
    }
  }
  return w3a(req);
}
