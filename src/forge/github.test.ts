import { describe, expect, it } from "vitest";
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
    expect(ciOf([{ bucket: "cancel" }])).toBe("cancelled");
    expect(ciOf([{ bucket: "cancel" }, { bucket: "pending" }])).toBe("pending");
    expect(ciOf([{ bucket: "cancel" }, { bucket: "fail" }])).toBe("fail");
  });
  it("marks Kitchen's comments with their key", () => {
    expect(marker("001-x/report-comment")).toBe("<!-- kitchen:001-x/report-comment -->");
  });
});
