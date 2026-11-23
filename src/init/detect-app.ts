// How QA starts the app (ADR 0016 §3), found in the repo's own files like the checks are: package.json scripts,
// a Makefile, Django's manage.py. Pure apart from reading files; nothing runs. The app gets its port in $PORT (and
// `{port}` in the command), so two jobs can run theirs at once.
import fs from "node:fs";
import path from "node:path";

export type DetectedApp = { start: string; health: string; reset?: string; from: string };

const read = (repo: string, f: string) => {
  try {
    return fs.readFileSync(path.join(repo, f), "utf8");
  } catch {
    return null;
  }
};

/** A health path the code serves, if one is obvious ("/healthz", "/health", "/api/health"); else "/". */
function healthPath(repo: string, files: string[]): string {
  const text = files.map((f) => read(repo, f) ?? "").join("\n");
  for (const p of ["/healthz", "/api/health", "/health"]) if (text.includes(`"${p}"`) || text.includes(`'${p}'`) || text.includes(`\`${p}\``)) return p;
  return "/";
}

export function detectApp(repo: string): DetectedApp | null {
  const pkg = read(repo, "package.json");
  if (pkg) {
    let scripts: Record<string, string> = {};
    let main = "";
    try {
      const j = JSON.parse(pkg) as { scripts?: Record<string, string>; main?: string };
      scripts = j.scripts ?? {};
      main = j.main ?? "";
    } catch {}
    const pm = fs.existsSync(path.join(repo, "pnpm-lock.yaml")) ? "pnpm" : fs.existsSync(path.join(repo, "yarn.lock")) ? "yarn" : "npm";
    const run = (s: string) => (pm === "npm" ? (s === "start" ? "npm start" : `npm run ${s}`) : `${pm} ${s}`);
    const name = ["start", "dev", "serve"].find((s) => scripts[s]);
    if (name) {
      const reset = ["db:reset", "reset", "seed", "db:seed"].find((s) => scripts[s]);
      const entry = /node\s+(\S+\.m?[jt]s)/.exec(scripts[name])?.[1];
      const files = [entry, main, "server.js", "server.ts", "src/server.ts", "src/index.ts", "index.js", "app.js"].filter((f): f is string => !!f);
      return { start: run(name), health: healthPath(repo, files), ...(reset ? { reset: run(reset) } : {}), from: `package.json scripts.${name}` };
    }
  }
  if (fs.existsSync(path.join(repo, "manage.py"))) return { start: "python manage.py runserver 127.0.0.1:{port}", health: "/", from: "manage.py (Django)" };
  const mk = read(repo, "Makefile");
  const target = mk && ["run", "serve", "dev", "start"].find((t) => new RegExp(`^${t}:`, "m").test(mk));
  if (target) return { start: `make ${target}`, health: "/", from: `Makefile target ${target}` };
  return null;
}
