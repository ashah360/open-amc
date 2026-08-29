import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const AUDIT = path.join(ROOT, "scripts", "privacy_audit.py");

describe("privacy audit detectors", () => {
  it("passes its fixture-driven self-test (git specs, shorthands, pins)", () => {
    const stdout = execFileSync("python3", [AUDIT, "--self-test"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(stdout).toContain("privacy self-test passed");
  });

  it("still passes the full tree audit", () => {
    const stdout = execFileSync("python3", [AUDIT], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(stdout).toContain("privacy audit passed");
  });
});
