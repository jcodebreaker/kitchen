import { describe, expect, it } from "vitest";
import { ciVerdict } from "./ready.ts";
import { smithPolicy, toleratedOnBase } from "./toolkit.ts";

describe("smith commit policy", () => {
  it("keeps Toolkit primitive files, refuses app code and feature drives", () => {
    expect(smithPolicy(".kitchen/toolkit/bin/dev")).toBeNull();
    expect(smithPolicy(".kitchen/toolkit/lib/sql.mjs")).toBeNull();
    expect(smithPolicy("server.js")).toMatch(/Toolkit only/);
    expect(smithPolicy(".kitchen/toolkit/features/settings.md")).toMatch(/feature drives/);
  });
  it("tolerates only drives that fail on the base and don't use the new primitive", () => {
    const t = toleratedOnBase(["settings.toggle-dark", "db.peek"], "sql");
    expect(t("settings.toggle-dark", ["login", "click"])).toBe(true);
    expect(t("db.peek", ["sql"])).toBe(false);
    expect(t("login", ["login"])).toBe(false);
  });
});

describe("Ready's reading of CI on the pushed HEAD", () => {
  const since = "2026-11-22T10:00:00.000Z";
  const at = (s: number) => new Date(Date.parse(since) + s * 1000);
  const base = { since, graceSec: 120 };
  it("no checks: green without workflow files, else wait out the grace window", () => {
    expect(ciVerdict({ ...base, ci: "none", hasWorkflows: false, now: at(1) }).ci).toBe("none");
    const w = ciVerdict({ ...base, ci: "none", hasWorkflows: true, now: at(10) });
    expect(w.ci).toBe("pending");
    expect(w.until).toBe(at(120).toISOString());
    expect(ciVerdict({ ...base, ci: "none", hasWorkflows: true, now: at(121) }).ci).toBe("none");
  });
  it("a cancelled run is read again once, then counts as red", () => {
    const first = ciVerdict({ ...base, ci: "cancelled", hasWorkflows: true, now: at(5) });
    expect(first).toMatchObject({ ci: "pending", firstCancel: true });
    const cancelledAt = at(5).toISOString();
    expect(ciVerdict({ ...base, ci: "cancelled", hasWorkflows: true, cancelledAt, now: at(60) }).ci).toBe("pending");
    expect(ciVerdict({ ...base, ci: "cancelled", hasWorkflows: true, cancelledAt, now: at(200) }).ci).toBe("fail");
    expect(ciVerdict({ ...base, ci: "pass", hasWorkflows: true, cancelledAt, now: at(200) }).ci).toBe("pass");
  });
});
