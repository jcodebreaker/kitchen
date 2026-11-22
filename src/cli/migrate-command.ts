// `kitchen migrate [--dry-run]` (src/migrate/migrate.ts): print every change as a diff; without --dry-run, write it.
import { applyMigration, planMigration, unifiedDiff } from "../migrate/migrate.ts";
import type { Out } from "./commands.ts";

export function migrate(repo: string, o: { dryRun: boolean }, out: Out): number {
  const { changes, notes } = planMigration(repo);
  for (const n of notes) out(`migrate: ${n}`);
  if (!changes.length) {
    out("migrate: nothing to change");
    return 0;
  }
  for (const c of changes) {
    out(`migrate: ${c.file}: ${c.why}`);
    out(unifiedDiff(c.before ?? "", c.after, c.file).trimEnd());
  }
  if (o.dryRun) {
    out(`migrate: dry run, ${changes.length} file(s) would change, the repo is not migrated; run \`kitchen migrate\` to write them`);
    return 1;
  }
  applyMigration(repo, changes);
  out(`migrate: ${changes.length} file(s) written (${changes.map((c) => c.file).join(", ")}); review and commit them`);
  return 0;
}
