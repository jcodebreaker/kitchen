import { describe, expect, it } from "vitest";
import { commentBody, placeholderSource, render, verdictRows } from "./report.ts";
import { smithPolicy } from "./toolkit.ts";

const VERDICT = `VERDICT: PASS
HEAD: abc
ROUND: 1

| criterion | decided by | result | evidence | why |
|---|---|---|---|---|
| C1 | engine | PASS | e3 e4 | expect held |
| C2 | verifier | PASS | e7 | looks right \\| dark |
`;

describe("report (W4 placeholder) and PR comment", () => {
  it("reads the verdict table", () => {
    expect(verdictRows(VERDICT)).toEqual([
      { id: "C1", by: "engine", result: "PASS", evidence: ["e3", "e4"], why: "expect held" },
      { id: "C2", by: "verifier", result: "PASS", evidence: ["e7"], why: "looks right | dark" },
    ]);
  });
  it("cites only evidence stamped for the head, so the render never refuses its own template", () => {
    const stamped = new Map([
      ["e3", "head1"],
      ["e4", "old"],
      ["e7", "head1"],
    ]);
    const src = placeholderSource({
      title: "Dark <b>",
      ticket: "t",
      criteria: [
        { id: "C1", text: "a" },
        { id: "C2", text: "b" },
      ],
      rows: verdictRows(VERDICT),
      head: "head1",
      stamped,
    });
    expect(src).toContain("{{e3}}");
    expect(src).not.toContain("{{e4}}");
    expect(src).toContain("Dark &lt;b&gt;");
    expect("html" in render(src, stamped, "head1")).toBe(true);
  });
  it("comment: one row per criterion with links and a thumbnail", () => {
    const body = commentBody({
      job: "001-x",
      head: "abcdef1234567",
      rows: verdictRows(VERDICT),
      folder: "https://github.com/a/b/tree/kitchen-evidence/001-x",
      link: (id) => `u/${id}`,
      thumb: (id) => (id === "e7" ? "raw/e7.png" : null),
    });
    expect(body).toContain("| C1 | PASS | engine | [e3](u/e3) [e4](u/e4) |  |");
    expect(body).toContain('<img src="raw/e7.png" width="160">');
  });
});

describe("smith commit policy", () => {
  it("keeps Toolkit primitive files, refuses app code and feature drives", () => {
    expect(smithPolicy(".kitchen/toolkit/bin/dev")).toBeNull();
    expect(smithPolicy(".kitchen/toolkit/lib/sql.mjs")).toBeNull();
    expect(smithPolicy("server.js")).toMatch(/Toolkit only/);
    expect(smithPolicy(".kitchen/toolkit/features/settings.md")).toMatch(/feature drives/);
  });
});
