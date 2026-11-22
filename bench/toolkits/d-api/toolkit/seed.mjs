// Builds the seed snapshot: an empty orders DB with the catalog, from the app's own schema.
// Usage: node seed.mjs <schema.sql> <out.db>
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [schema, outFile] = process.argv.slice(2);
mkdirSync(dirname(outFile), { recursive: true });
rmSync(outFile, { force: true });
const db = new DatabaseSync(outFile);
db.exec(readFileSync(schema, "utf8"));
db.close();
