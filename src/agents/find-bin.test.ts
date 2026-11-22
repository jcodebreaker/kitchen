import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeBin, findBin } from "./find-bin.ts";

function bin(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "claude");
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  return p;
}

describe("findBin", () => {
  const root = mkdtempSync(join(tmpdir(), "kitchen-findbin-"));
  const fakeTmp = join(root, "T"); // stands in for the OS temp folder
  const shim = join(fakeTmp, "some-terminal-shims", "abc");
  const installed = join(root, "usr", "local", "bin");
  bin(shim);
  const installedBin = bin(installed);

  it("skips a session shim in the temp folder and returns the installed binary", () => {
    expect(findBin("claude", `${shim}:${installed}`, fakeTmp)).toBe(installedBin);
  });

  it("falls back to the bare name when only a session shim is on PATH", () => {
    expect(findBin("claude", shim, fakeTmp)).toBe("claude");
  });

  it("skips entries with no executable of that name", () => {
    expect(findBin("claude", `${join(root, "empty")}:${installed}`, fakeTmp)).toBe(installedBin);
  });

  it("KITCHEN_CLAUDE_BIN wins", () => {
    expect(claudeBin({ KITCHEN_CLAUDE_BIN: "/x/claude", PATH: installed }, fakeTmp)).toBe("/x/claude");
    expect(claudeBin({ PATH: `${shim}:${installed}` }, fakeTmp)).toBe(installedBin);
  });
});
