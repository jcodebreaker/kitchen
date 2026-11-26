// healthz-version: /healthz reports package.json's version and keeps its other fields.
import { call, done, expect } from "./_lib.mjs";

const h = await call("GET", "/healthz", null);
expect(h.status === 200, `/healthz answered ${h.status}`);
expect(h.body?.version === "0.3.1", `version is ${JSON.stringify(h.body?.version)}, want "0.3.1"`);
expect(h.body?.ok === true && h.body?.books === 6, `ok or books changed: ${JSON.stringify(h.body)}`);
done();
