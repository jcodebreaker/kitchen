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
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appEnv } from "./common.mjs";

const asArgv = (v) => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim().startsWith("[")) return JSON.parse(v).map(String);
  if (v === undefined || v === "") return [];
  return [String(v)];
};

export function terminalPrimitives({ command, env = () => ({}), cwd = (ctx) => ctx.src, timeoutMs = 60000 }) {
  return {
    cli: {
      args: {
        argv: "list of arguments after the command",
        stdin: "optional text typed on stdin",
        expect_exit: "optional exit code that counts as ok (default 0)",
      },
      does: "run the app's command once; out is {exit, stdout, stderr}; ok when the exit code is the expected one",
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
        const exit = r.status ?? 1;
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
        const want = a.expect_exit === undefined ? 0 : Number(a.expect_exit);
        return { ok: exit === want, out: { exit, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() }, files };
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
