import assert from "node:assert/strict";
import { test } from "vitest";
import { jobIdOf, nextNumber, slugify, titleOf } from "./store.ts";

test("job ids are NNN-slug, numbered after the highest in use", () => {
  assert.equal(nextNumber([]), 1);
  assert.equal(nextNumber(["001-a", "007-b", ".create.lock", "junk", "003-c"]), 8);
  assert.equal(jobIdOf(8, "Add a Dark-mode toggle!"), "008-add-a-dark-mode-toggle");
  assert.equal(jobIdOf(1234, "x"), "1234-x");
});

test("slugs are short, lowercase and never empty", () => {
  assert.equal(slugify("  Héllo,   Wörld  "), "hello-world");
  assert.equal(slugify("!!!"), "ticket");
  const long = slugify("a very long title that goes on and on past the forty character mark");
  assert.ok(long.length <= 40 && !long.endsWith("-"), long);
});

test("a prompt ticket's title is its first non-empty line", () => {
  assert.equal(titleOf("\n\n  Fix the login bug \nmore detail"), "Fix the login bug");
  assert.equal(titleOf("x".repeat(100)).length, 72);
});
