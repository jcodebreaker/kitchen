import { describe, expect, it } from "vitest";
import { smithPolicy } from "./toolkit.ts";

describe("smith commit policy", () => {
  it("keeps Toolkit primitive files, refuses app code and feature drives", () => {
    expect(smithPolicy(".kitchen/toolkit/bin/dev")).toBeNull();
    expect(smithPolicy(".kitchen/toolkit/lib/sql.mjs")).toBeNull();
    expect(smithPolicy("server.js")).toMatch(/Toolkit only/);
    expect(smithPolicy(".kitchen/toolkit/features/settings.md")).toMatch(/feature drives/);
  });
});
