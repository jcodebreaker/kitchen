import assert from "node:assert/strict";
import { test } from "vitest";
import { redact } from "./redact.ts";

test("secret-looking strings are masked, the rest of the evidence kept", () => {
  const cases: [string, RegExp][] = [
    ["key AKIAABCDEFGHIJKLMNOP here", /key \[redacted\] here/],
    ["sk-ant-abcdefghijklmnopqrstuvwxyz0123", /^\[redacted\]$/],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", /^\[redacted\]$/],
    ["STRIPE_SECRET_KEY=sk_live_abcdef0123456789", /STRIPE_SECRET_KEY=\[redacted\]/],
    ['{"password": "hunter2hunter2"}', /"password": "\[redacted\]"/],
    ["Authorization: Bearer abc.def.ghi-jkl-mno", /Bearer \[redacted\]/],
    ["postgres://app:s3cretpw@db:5432/app", /postgres:\/\/app:\[redacted\]@db/],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----", /^\[redacted\]$/],
  ];
  for (const [input, want] of cases) assert.match(redact(input), want, input);
  const plain = '{"ok":true,"out":"Theme: Dark","files":[]} theme-dark Saved';
  assert.equal(redact(plain), plain, "ordinary evidence is untouched");
});
