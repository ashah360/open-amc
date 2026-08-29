import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

// The retired repository/package identifier, assembled from parts so this
// audit file itself never contains the stale literal it forbids. Natural
// language like "AMC client" (with a space) is deliberately NOT matched.
const STALE_ID = ["amc", "client"].join("-");
const STALE_PATTERN = new RegExp(STALE_ID, "i");

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

describe("identity audit (open-amc public-launch identity)", () => {
  it("no tracked path or file content carries the retired repo/package identifier", () => {
    const offenders: string[] = [];
    for (const file of trackedFiles()) {
      if (STALE_PATTERN.test(file)) offenders.push(`path: ${file}`);
      const text = readFileSync(path.join(ROOT, file), "utf8");
      if (STALE_PATTERN.test(text)) offenders.push(`content: ${file}`);
    }
    expect(offenders).toEqual([]);
  });

  it("package identity is the canonical @ashah360/open-amc with the amc bin", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as {
      name: string;
      bin: Record<string, string>;
      repository: { url: string };
      homepage: string;
    };
    expect(pkg.name).toBe("@ashah360/open-amc");
    expect(pkg.repository.url).toBe(
      "git+https://github.com/ashah360/open-amc.git",
    );
    expect(pkg.homepage).toBe("https://github.com/ashah360/open-amc#readme");
    // The CLI binary intentionally stays `amc`.
    expect(pkg.bin).toEqual({ amc: "dist/cli.js" });
  });

  it("lockfile root identity matches the canonical package name", () => {
    const lock = JSON.parse(
      readFileSync(path.join(ROOT, "package-lock.json"), "utf8"),
    ) as { name: string; packages: Record<string, { name?: string }> };
    expect(lock.name).toBe("@ashah360/open-amc");
    expect(lock.packages[""]!.name).toBe("@ashah360/open-amc");
  });

  it("retired checkout/refund ceremony API and flags do not reappear anywhere", () => {
    // Assembled from parts so this audit never matches itself. Only exact
    // API/flag identifiers are forbidden; natural-language words such as
    // "approval" or "quote" in prose remain fine.
    const staleCeremony = [
      "approval" + "Token",
      "quote" + "Hash",
      "--" + "approval",
      "--" + "quote-hash",
      "--" + "accept-total",
      "accept" + "Total",
      "Approval" + "MismatchError",
      "Quote" + "MismatchError",
      "AcceptedTotal" + "MismatchError",
      "AMC_" + "APPROVAL_STALE",
      "AMC_" + "QUOTE_STALE",
      "AMC_" + "ACCEPTED_TOTAL_MISMATCH",
      "checkout" + "ApprovalToken",
      "refund" + "ApprovalToken",
      "checkout" + "QuoteHash",
      "refund" + "QuoteHash",
    ];
    const offenders: string[] = [];
    for (const file of trackedFiles()) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      for (const term of staleCeremony) {
        if (text.includes(term)) offenders.push(`${term} in ${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("src carries no built-in theater slug/id/market default", () => {
    // Open AMC is fully dynamic across theaters: no venue constant may live
    // in public runtime/CLI source (including CLI help strings). Tests and
    // docs may use clearly labeled example theaters.
    const forbidden: Array<[string, RegExp]> = [
      ["metreon", /metreon/i],
      ["theater id 2325", /\b2325\b/],
      ["san-francisco literal", /san-francisco/i],
      ["concrete listing path", /\/movie-theatres\/[a-z0-9-]+\/amc-/],
    ];
    const offenders: string[] = [];
    for (const file of trackedFiles()) {
      if (!file.startsWith("src/")) continue;
      const text = readFileSync(path.join(ROOT, file), "utf8");
      for (const [label, pattern] of forbidden) {
        if (pattern.test(text)) offenders.push(`${label} in ${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("portable skill lives at skills/open-amc with YAML name open-amc", () => {
    const skillPath = path.join(ROOT, "skills", "open-amc", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const skill = readFileSync(skillPath, "utf8");
    expect(skill).toMatch(/^---\n(?:[\s\S]*?\n)?name: open-amc\n/);
  });
});
