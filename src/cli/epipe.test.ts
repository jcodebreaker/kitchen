import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import { quietOnEpipe } from "./epipe.ts";

test("EPIPE on stdout ends quietly with 0; another error still throws (review N3)", () => {
  const s = new EventEmitter();
  const codes: number[] = [];
  quietOnEpipe(s, (c) => codes.push(c));
  s.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  assert.deepEqual(codes, [0]);
  assert.throws(() => s.emit("error", Object.assign(new Error("boom"), { code: "EIO" })), /boom/);
});
