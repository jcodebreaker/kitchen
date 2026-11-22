import { describe, expect, it } from "vitest";
import { globRe, parseFeature, touched, validate } from "./contract.ts";

const describeOk = {
  contract: 1,
  surface: "web",
  primitives: ["read", "open", "reload", "press", "type", "screenshot", "login", { name: "http", args: { path: "/x" } }],
  features: ["features/settings.md"],
  seed_users: ["alice"],
  externals: [{ name: "stripe", mode: "mock" }],
  ports: { needs: 3, order: ["app", "db", "driver"] },
  parallel: true,
};

describe("describe", () => {
  it("accepts a full answer", () => expect(validate("describe", describeOk).ok).toBe(true));
  it("refuses a web Toolkit without the generic primitives", () => {
    const r = validate("describe", { ...describeOk, primitives: ["read", "press"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(/missing open, reload, type, screenshot, login, http/);
  });
  it("refuses lifecycle names as primitives, more ports than a slot, a wrong contract, an unknown external mode", () => {
    expect(validate("describe", { ...describeOk, primitives: [...describeOk.primitives, "up"] }).ok).toBe(false);
    expect(validate("describe", { ...describeOk, ports: { needs: 21 } }).ok).toBe(false);
    expect(validate("describe", { ...describeOk, contract: 2 }).ok).toBe(false);
    expect(validate("describe", { ...describeOk, externals: [{ name: "x", mode: "live" }] }).ok).toBe(false);
    expect(validate("describe", { ...describeOk, features: ["../x.md"] }).ok).toBe(false);
  });
  it("needs a JSON line", () => expect(validate("doctor", null)).toEqual({ ok: false, why: "doctor printed no JSON line on stdout" }));
  it("up is ready with a url or a fail with why", () => {
    expect(validate("up", { status: "ready", url: "http://127.0.0.1:1" }).ok).toBe(true);
    expect(validate("up", { status: "ready" }).ok).toBe(false);
    expect(validate("up", { status: "fail", why: "x" }).ok).toBe(true);
  });
});

const feature = `# Settings
\`\`\`drive
drive: settings.toggle
args: [user]
steps:
  - login: { as: $user }
\`\`\`
\`\`\`drive
drive: settings.look
steps:
  - read: { target: body }
\`\`\`
\`\`\`kitchen
paths: [server.js, "views/settings/**"]   # comment
check: { drive: settings.toggle, args: { user: alice } }
\`\`\`
`;

describe("feature files", () => {
  it("reads drives, paths and checks; arg-less drives are checked as they are", () => {
    const f = parseFeature("features/settings.md", feature);
    expect(f.paths).toEqual(["server.js", "views/settings/**"]);
    expect(f.checks).toEqual([
      { drive: "settings.toggle", args: { user: "alice" } },
      { drive: "settings.look", args: {} },
    ]);
  });
  it("refuses a check of an unknown drive, missing args, unknown keys, absolute paths", () => {
    expect(() => parseFeature("f", feature.replace("drive: settings.toggle, args", "drive: nope, args"))).toThrow(/doesn't define/);
    expect(() => parseFeature("f", feature.replace("args: { user: alice }", "args: {}"))).toThrow(/lacks args user/);
    expect(() => parseFeature("f", feature.replace("paths:", "pathz:"))).toThrow(/unknown key/);
    expect(() => parseFeature("f", feature.replace("server.js", "/etc/passwd"))).toThrow(/repo-relative/);
  });
});

describe("globs", () => {
  it("matches files, folders and ** across segments", () => {
    expect(globRe("server.js").test("server.js")).toBe(true);
    expect(globRe("db").test("db/001.sql")).toBe(true);
    expect(globRe("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globRe("src/**/*.ts").test("src/a/b.ts")).toBe(true);
    expect(globRe("src/**/*.ts").test("src/b.ts")).toBe(true);
    expect(globRe(".kitchen/toolkit/**").test(".kitchen/toolkit/bin/dev")).toBe(true);
    expect(globRe("a.b").test("axb")).toBe(false);
  });
  it("lists the changed files a Toolkit depends on", () => {
    expect(touched(["README.md", "server.js", ".kitchen/toolkit/bin/dev"], [".kitchen/toolkit/**", "server.js"])).toEqual([
      "server.js",
      ".kitchen/toolkit/bin/dev",
    ]);
  });
});
