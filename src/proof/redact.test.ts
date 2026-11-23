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

test("only secret-named keys are masked: author and title stay, markup stays intact", () => {
  const keep = [
    "GET /books?author=tolkien</code> then more",
    "{ author: 'J.R.R. Tolkien', title: 'The Hobbit' }",
    "<code>author=tolkien</code> and <code>title=hobbit</code>",
    "<pre>author: &#39;J.R.R. Tolkien&#39;</pre>",
    "monkey=bananas123 authority=registrar session",
  ];
  for (const k of keep) assert.equal(redact(k), k, k);
  const cases: [string, string][] = [
    ["<code>token=abcdef123456</code> after", "<code>token=[redacted]</code> after"],
    ["<td>password: &quot;hunter2hunter2&quot;</td>", "<td>password: &quot;[redacted]&quot;</td>"],
    ["X-Auth-Token: abcdefgh12345", "X-Auth-Token: [redacted]"],
    ["Cookie: sid=abcdef123456; theme=dark", "Cookie: [redacted]; theme=dark"],
    ["sessionId=0123456789abcdef", "sessionId=[redacted]"],
    ['{"apiKey":"abcdef0123456789"}', '{"apiKey":"[redacted]"}'],
    ["DB_PASSWORD=correcthorse", "DB_PASSWORD=[redacted]"],
    ["auth=abcdefgh1234", "auth=[redacted]"],
  ];
  for (const [input, want] of cases) assert.equal(redact(input), want, input);
});
