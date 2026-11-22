// $KITCHEN_HOME (default ~/.kitchen): engine-owned, per machine, shared across repos.
// Holds slots.json, the scrubbed git/gh config for untrusted processes, and the
// engine key that signs manifest heads. Mode 700; the key file is mode 600.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const kitchenHome = (): string => process.env.KITCHEN_HOME || path.join(os.homedir(), ".kitchen");

export function ensureHome(home = kitchenHome()): string {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

export class EngineKeyError extends Error {}

/**
 * The engine key (32 random bytes, hex). Created on first use with mode 600.
 * A key file readable by group or others is refused rather than silently fixed:
 * it may already have leaked.
 */
export function engineKey(home = kitchenHome()): Buffer {
  ensureHome(home);
  const file = path.join(home, "engine.key");
  try {
    fs.writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const st = fs.statSync(file);
  if (st.mode & 0o077) throw new EngineKeyError(`${file} has mode ${(st.mode & 0o777).toString(8)}; it must be 600`);
  const hex = fs.readFileSync(file, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new EngineKeyError(`${file} is not a 32-byte hex key`);
  return Buffer.from(hex, "hex");
}
