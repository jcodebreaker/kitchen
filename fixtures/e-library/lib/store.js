// The whole library lives in one JSON file (<DATA_DIR>/library.json). On first start it is
// created from seed.json. Every change rewrites the file (write to a temp file, then rename).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function openStore(dataDir, seedFile) {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "library.json");
  if (!existsSync(file)) writeFileSync(file, readFileSync(seedFile, "utf8"));
  const data = JSON.parse(readFileSync(file, "utf8"));

  const nextId = (rows) => rows.reduce((max, r) => Math.max(max, r.id), 0) + 1;

  return {
    file,
    data,
    nextId,
    save() {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
      renameSync(tmp, file);
    },
    /** The file is there and parses: what /healthz reports. */
    healthy() {
      try {
        JSON.parse(readFileSync(file, "utf8"));
        return true;
      } catch {
        return false;
      }
    },
  };
}
