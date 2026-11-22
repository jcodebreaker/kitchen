// Optional module for cli surfaces: run the app's command the way a user types
// it, one process per call, and keep the last output in the instance state so
// the generic `read` primitive (which the engine's `wait:` polls) can see it.
// Use from app.mjs:
//
//   import { terminalPrimitives } from "./lib/terminal.mjs";
//   primitives: { ...terminalPrimitives({ command: (ctx) => ["python3", "-m", "tasks"], env: (ctx) => ({ TASKS_DB: ctx.state.db }) }) }
//
// Drive step: `- cli: { argv: [add, "Buy milk", --tag, home] }`, optionally `stdin: "y"`.
// Each call writes cmd.txt, stdout.txt, stderr.txt into --out (stamped evidence).
// A command that ran is a step that ran, whatever its exit code: out is
// {exit, stdout, stderr} and the criterion's expect decides (`exit 1`,
// `contains "…"`), so a bug whose current code exits non-zero can be reproduced.
// The step fails only when the command could not run (not found, timed out), or
// when the drive pins `expect_exit` and the exit differs (a setup step that must
// succeed: `expect_exit: 0`).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appEnv } from "./common.mjs";

// A list (drive flow array), a JSON array string, or a plain string split like a shell
// line ("done 1 2", 'add "Buy milk" --tag home'): a spec's proof line can only pass strings.
const splitWords = (s) => {
  const out = [];
  let cur = "";
  let q = null;
  let any = false;
  for (const ch of s) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
};
const asArgv = (v) => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim().startsWith("[")) return JSON.parse(v).map(String);
  if (v === undefined || v === "") return [];
  return typeof v === "string" ? splitWords(v) : [String(v)];
};

export function terminalPrimitives({ command, env = () => ({}), cwd = (ctx) => ctx.src, timeoutMs = 60000 }) {
  return {
    cli: {
      args: {
        argv: 'arguments after the command: a list, or one string split like a shell line ("done 1 2")',
        stdin: "optional text typed on stdin",
        expect_exit: "optional: fail the step unless the exit code is this one (default: any exit code is ok; assert it in the expect)",
      },
      does: "run the app's command once; out is {exit, stdout, stderr}; ok whenever it ran (any exit code), unless expect_exit is given and differs",
      run(ctx, a) {
        const [bin, ...pre] = command(ctx);
        const argv = [...pre, ...asArgv(a.argv)];
        const r = spawnSync(bin, argv, {
          cwd: cwd(ctx),
          env: appEnv(env(ctx)),
          input: a.stdin === undefined ? "" : `${a.stdin}\n`,
          encoding: "utf8",
          timeout: timeoutMs,
        });
        // The Toolkit could not run it at all: that is a failed step, not an exit code.
        if (r.error) return { ok: false, out: { error: r.error.code === "ETIMEDOUT" ? `timed out after ${timeoutMs} ms` : String(r.error.message) } };
        const exit = r.status ?? (r.signal ? 128 : 1);
        const files = [];
        if (ctx.out) {
          for (const [f, text] of [
            ["cmd.txt", [bin, ...argv].map((x) => JSON.stringify(x)).join(" ")],
            ["stdout.txt", r.stdout ?? ""],
            ["stderr.txt", r.stderr ?? ""],
          ]) {
            fs.writeFileSync(path.join(ctx.out, f), text);
            files.push(path.join(ctx.out, f));
          }
        }
        ctx.state.last = { argv, exit, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
        const ok = a.expect_exit === undefined || a.expect_exit === "" || exit === Number(a.expect_exit);
        return { ok, out: { exit, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() }, files };
      },
    },
    read: {
      args: { target: "stdout (default) | stderr | exit" },
      does: "the last cli call's stdout, stderr or exit code; ok:false before any call",
      run(ctx, a) {
        const last = ctx.state.last;
        if (!last) return { ok: false, out: "no cli call yet" };
        const t = a.target === undefined || a.target === "body" ? "stdout" : String(a.target);
        if (!["stdout", "stderr", "exit"].includes(t)) return { ok: false, out: `no target ${t} (stdout, stderr, exit)` };
        return { ok: true, out: String(last[t]).trim() };
      },
    },
  };
}
