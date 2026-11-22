// Toolkit for `tasks`, a terminal task tracker (python3 -m tasks, SQLite in $TASKS_DB).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, appEnv } from "./lib/common.mjs";
import { terminalPrimitives } from "./lib/terminal.mjs";

const PY = "python3";
const tasksEnv = (db) => ({ TASKS_DB: db, PYTHONDONTWRITEBYTECODE: "1" });

/** Snapshot of the seeded DB, cached by the content hash of seed + migrations + code. */
function snapshotFor(src) {
  const h = crypto.createHash("sha256");
  for (const d of ["seed", "tasks", "tasks/migrations"]) {
    const dir = path.join(src, d);
    for (const f of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isFile() && !f.endsWith(".pyc")) h.update(f).update(fs.readFileSync(p));
    }
  }
  const dir = path.join(os.tmpdir(), "kitchen-toolkit-tasks-cache");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `seed-${h.digest("hex").slice(0, 16)}.db`);
}

function buildSnapshot(src) {
  const snap = snapshotFor(src);
  if (fs.existsSync(snap)) return snap;
  const tmp = `${snap}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  const r = run(PY, ["-m", "tasks", "import", "seed/demo.csv"], { cwd: src, env: appEnv(tasksEnv(tmp)) });
  if (r.code !== 0 || !fs.existsSync(tmp)) throw new Error(`seeding failed: ${r.stderr ?? ""}`);
  fs.renameSync(tmp, snap);
  return snap;
}

function restore(ctx) {
  fs.mkdirSync(path.dirname(ctx.state.db), { recursive: true });
  fs.rmSync(`${ctx.state.db}-journal`, { force: true });
  fs.copyFileSync(buildSnapshot(ctx.state.src ?? ctx.src), ctx.state.db);
}

const cli = (ctx, args) => run(PY, ["-m", "tasks", ...args], { cwd: ctx.src, env: appEnv(tasksEnv(ctx.state.db)) });

export default {
  name: "tasks",
  surface: "cli",
  ports: { needs: 1, order: ["unused"] }, // no server; the slot's first port is simply not used
  parallel: true, // one SQLite file per instance id
  externals: [],

  async seedUsers() {
    return []; // no accounts
  },

  async prepare(ctx) {
    const v = run(PY, ["-c", "import sys;print('%d.%d'%sys.version_info[:2]);sys.exit(sys.version_info<(3,11))"]);
    if (v.code !== 0) throw new Error(`python3 >= 3.11 required, found ${(v.stdout ?? "").trim() || "none"}`);
    const snap = buildSnapshot(ctx.src);
    return { python: v.stdout.trim(), snapshot: path.basename(snap) };
  },

  async up(ctx) {
    ctx.state.db = path.join(ctx.stateDir, "data", "tasks.db");
    restore(ctx);
    ctx.save();
    const r = cli(ctx, ["list", "--all", "--json"]);
    if (r.code !== 0 || JSON.parse(r.stdout).length < 6) throw new Error(`seeded DB not usable: ${r.stderr}`);
    return { url: `file://${ctx.state.db}` };
  },

  doctor(ctx) {
    return {
      "database file exists": () => fs.existsSync(ctx.state.db) || `${ctx.state.db} missing`,
      "tasks CLI opens the database": () => cli(ctx, ["stats", "--json"]).code === 0 || "tasks stats failed",
      "database has tasks": () => JSON.parse(cli(ctx, ["stats", "--json"]).stdout).total > 0 || "no tasks",
    };
  },

  async reset(ctx) {
    restore(ctx);
    delete ctx.state.last;
  },

  async down() {}, // nothing is started; the data dir stays with the logs

  primitives: {
    ...terminalPrimitives({
      command: () => [PY, "-m", "tasks"],
      env: (ctx) => tasksEnv(ctx.state.db),
    }),
    seed: {
      args: {},
      does: "put this instance's database back to the seed snapshot (6 tasks) so a drive starts from known state",
      run(ctx) {
        restore(ctx);
        return { ok: true, out: "database restored to seed" };
      },
    },
  },
};
