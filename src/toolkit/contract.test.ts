import { describe, expect, it } from "vitest";
import { loadDrive } from "../proof/drive-format.ts";
import { globRe, MISSING_TARGET, oneJsonLine, PLACEHOLDER, parseFeature, planProbes, touched, unmatchedGlobs, upUrlProblem, validate } from "./contract.ts";

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

describe("the contract, held harder (W2 review)", () => {
  it("stdout is exactly one JSON object line", () => {
    expect(oneJsonLine('{"ok":true}\n').ok).toBe(true);
    const two = oneJsonLine('[dev] hi\n{"ok":true}\n');
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.why).toMatch(/2 lines/);
    expect(oneJsonLine("").ok).toBe(false);
    expect(oneJsonLine("[1]").ok).toBe(false);
  });
  it("up's url: http(s) for web and api, any absolute URL for cli", () => {
    expect(upUrlProblem("web", "http://127.0.0.1:31000")).toBeNull();
    expect(upUrlProblem("web", "x")).toMatch(/not an absolute URL/);
    expect(upUrlProblem("api", "file:///tmp/db")).toMatch(/must be http/);
    expect(upUrlProblem("cli", "file:///tmp/db")).toBeNull();
  });
  it("doctor needs a check; describe needs a known surface", () => {
    expect(validate("doctor", { status: "ok", checks: [] }).ok).toBe(false);
    expect(validate("describe", { ...describeOk, surface: undefined }).ok).toBe(false);
    expect(validate("describe", { ...describeOk, surface: "desktop" }).ok).toBe(false);
  });
  it("a feature without paths is refused", () =>
    expect(() => parseFeature("f", feature.replace('paths: [server.js, "views/settings/**"]   # comment\n', ""))).toThrow(/no paths/));
  it("probes every primitive once, then the refusals", () => {
    const d = validate("describe", { ...describeOk, primitives: [...describeOk.primitives, "toggle"] });
    if (!d.ok) throw new Error(d.why);
    const withToggle = feature.replace("  - login: { as: $user }", "  - login: { as: $user }\n  - toggle: { who: $user }");
    const p = planProbes(d.value, [{ drive: loadDrive(withToggle, "settings.toggle"), args: { user: "bob" } }]);
    const names = describeOk.primitives.map((x) => (typeof x === "string" ? x : x.name));
    expect(p.filter((x) => x.expect !== "refuse").map((x) => x.primitive)).toEqual([...names, "toggle"]);
    expect(p.find((x) => x.primitive === "toggle")?.args).toEqual({ who: "bob" });
    expect(p.find((x) => x.primitive === "login")?.args).toEqual({ as: "alice" });
    expect(p.find((x) => x.primitive === "read" && x.expect === "refuse")?.args).toEqual({ target: MISSING_TARGET });
    expect(p.filter((x) => x.expect === "refuse" && (x.primitive === "open" || x.primitive === "http"))).toHaveLength(4);
    expect(p.find((x) => x.dupFlag)?.primitive).toBe("read");
  });
  it("a primitive no drive or table entry covers: ok:true with no args, or its declared args as placeholders", () => {
    const d = validate("describe", { ...describeOk, primitives: [...describeOk.primitives, "frobnicate", { name: "export", args: { format: "csv|json" } }] });
    if (!d.ok) throw new Error(d.why);
    const p = planProbes(d.value, []);
    expect(p.find((x) => x.primitive === "frobnicate")).toMatchObject({ args: {}, expect: "ok", uncovered: "none" });
    expect(p.find((x) => x.primitive === "export")).toMatchObject({ args: { format: PLACEHOLDER }, expect: "shape", uncovered: "placeholder" });
    expect(p.find((x) => x.primitive === "press")).toMatchObject({ args: { target: MISSING_TARGET }, expect: "shape" });
    expect(p.find((x) => x.primitive === "login")?.uncovered).toBeUndefined();
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
  it("names the globs that match no file", () =>
    expect(unmatchedGlobs(["server.js", "srver.js", "views/**"], ["server.js", "views/a.html"])).toEqual(["srver.js"]));
  it("lists the changed files a Toolkit depends on", () => {
    expect(touched(["README.md", "server.js", ".kitchen/toolkit/bin/dev"], [".kitchen/toolkit/**", "server.js"])).toEqual([
      "server.js",
      ".kitchen/toolkit/bin/dev",
    ]);
  });
});
