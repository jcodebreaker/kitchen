import { describe, expect, it } from "vitest";
import { isText, stale } from "./evidence.ts";
import { ciOf, marker, numberOf } from "./github.ts";

describe("github forge (pure)", () => {
  it("reads the PR number gh printed", () => {
    expect(numberOf("https://github.com/acme/app/pull/42\n")).toBe(42);
    expect(numberOf("https://github.com/acme/app/issues/7")).toBe(7);
    expect(() => numberOf("created")).toThrow();
  });
  it("folds check rows into one CI state", () => {
    expect(ciOf([])).toBe("none");
    expect(ciOf([{ bucket: "pass" }, { bucket: "skipping" }])).toBe("pass");
    expect(ciOf([{ bucket: "pass" }, { bucket: "pending" }])).toBe("pending");
    expect(ciOf([{ bucket: "pending" }, { bucket: "fail" }])).toBe("fail");
    expect(ciOf([{ bucket: "cancel" }])).toBe("fail");
  });
  it("marks Kitchen's comments with their key", () => {
    expect(marker("001-x/report-comment")).toBe("<!-- kitchen:001-x/report-comment -->");
  });
});

describe("evidence branch (pure)", () => {
  const now = new Date("2026-11-22T00:00:00Z");
  it("prunes folders older than the retention, never the one being published or one without a date", () => {
    const folders = [
      { name: "001-old", at: "2026-10-01T00:00:00Z" },
      { name: "002-new", at: "2026-11-20T00:00:00Z" },
      { name: "003-undated", at: null },
      { name: "004-me", at: "2026-01-01T00:00:00Z" },
    ];
    expect(stale(folders, 30, now, "004-me")).toEqual(["001-old"]);
  });
  it("redacts text, not images", () => {
    expect(isText("call.json", Buffer.from("{}"))).toBe(true);
    expect(isText("shot.png", Buffer.from("plain"))).toBe(false);
    expect(isText("stdout", Buffer.from("hello"))).toBe(true);
    expect(isText("blob", Buffer.from([1, 0, 2]))).toBe(false);
  });
});
