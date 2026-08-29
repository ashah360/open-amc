import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const AGENTS = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
const SKILL = readFileSync(
  path.join(ROOT, "skills", "open-amc", "SKILL.md"),
  "utf8",
);
const TEMPLATE = readFileSync(
  path.join(ROOT, "templates", "amc-capabilities.template.cjs"),
  "utf8",
);
const README = readFileSync(path.join(ROOT, "README.md"), "utf8");

describe("agent docs", () => {
  it("skill has valid frontmatter meeting the Hermes in-repo skill contract", () => {
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(SKILL);
    expect(frontmatter).not.toBeNull();
    const body = frontmatter![1]!;
    const field = (key: string) =>
      new RegExp(`(?:^|\\n)${key}:\\s*(.+)`).exec(body)?.[1]?.trim();
    expect(field("name")).toBe("open-amc");
    const description = field("description");
    expect(description).toBeTruthy();
    expect(description!.length).toBeLessThanOrEqual(60);
    expect(description!.endsWith(".")).toBe(true);
    expect(field("version")).toBeTruthy();
    expect(field("author")).toContain("Arman (ashah360), Hermes Agent");
    expect(field("license")).toBe("MIT");
    // POSIX shells only; Windows is not audited and must not be claimed.
    expect(body).toMatch(/^platforms: \[linux, macos\]$/m);
    expect(body).toMatch(
      /^metadata:\n {2}hermes:\n {4}tags: \[amc, tickets, showtimes, cli, commerce\]\n {4}related_skills: \[\]$/m,
    );
    expect(body).not.toContain("audited-platforms");
    expect(body).not.toMatch(/^tags:/m);
    expect(body).not.toMatch(/^related:/m);
    expect(body).not.toContain("AGENTS.md");
    expect(body).not.toContain("README");
  });

  it("documents the proven variadic seat grammar and the help-exempt JSON contract", () => {
    for (const doc of [AGENTS, SKILL]) {
      expect(doc).toContain("--seat A2 A3");
      expect(doc).not.toContain("--seat A2 --seat A3");
    }
    expect(README).toContain("--seat A2 A3");
    // Help/usage output is exempt from the JSON envelope (PR #3); the skill
    // must not claim every command emits JSON.
    expect(SKILL).toMatch(/non-help command invocations accept `--json`/i);
    expect(SKILL).not.toMatch(/All commands accept `--json`/);
    expect(README).toMatch(/non-help/i);
    expect(README).not.toMatch(/`--json` to any command/);
  });

  it("states the browser boundary truthfully and completes refund commands", () => {
    // Ordinary reads never open browsers; explicit repair can escalate via
    // --listing-url OR a deliberately configured browserRepair capability.
    expect(AGENTS).toMatch(/Ordinary reads never open a browser/i);
    expect(AGENTS).toMatch(/deliberately configured/i);
    expect(AGENTS).not.toMatch(/only when you pass\s+`--listing-url`/i);
    // Refund quick reference must be copy-paste complete.
    const refundRow = /\| Refunds \|(.+)\|/.exec(SKILL)?.[1] ?? "";
    expect(refundRow).toContain(
      "refund preview --confirmation <n> --email <e>",
    );
    expect(refundRow).toContain("refund submit --confirmation <n> --email <e>");
    expect(refundRow).toContain(
      "refund reconcile --confirmation <n> --email <e>",
    );
  });

  it("uses the exact public clone URL and permits downstream composition", () => {
    for (const doc of [AGENTS, SKILL]) {
      expect(doc).toContain("https://github.com/ashah360/open-amc.git");
    }
    // Orchestration does not ship here, but building on the primitives is
    // explicitly permitted — no blanket prohibition remains.
    expect(AGENTS).not.toMatch(/should be built around it/i);
    expect(AGENTS).toMatch(/compose their own/i);
    expect(SKILL).not.toMatch(/do not build loops around the CLI/i);
    expect(SKILL).toMatch(/one fenced\s+commerce writer/i);
    expect(SKILL).toMatch(/respect provider\s+limits/i);
  });

  it("does not advertise the retired receiptIdentity capability", () => {
    for (const text of [AGENTS, SKILL, TEMPLATE]) {
      expect(text).not.toContain("receiptIdentity");
    }
  });

  it("docs teach the safe flows and boundaries", () => {
    for (const doc of [AGENTS, SKILL]) {
      expect(doc).toContain("checkout preview");
      expect(doc).toContain("checkout submit");
      expect(doc).toContain("theater resolve");
      expect(doc).toContain("auth repair");
      expect(doc).toContain("doctor");
      expect(doc).toContain("reconcile");
      expect(doc.toLowerCase()).toContain("bearer-like");
      expect(doc).toMatch(/3DS/);
    }
    expect(AGENTS).toMatch(/no watchers/i);
    expect(SKILL).toMatch(/never blind-retry|no retry loops/i);
  });

  it("contains no machine-local paths or private identifiers", () => {
    for (const [label, text] of [
      ["AGENTS.md", AGENTS],
      ["SKILL.md", SKILL],
      ["template", TEMPLATE],
    ] as const) {
      expect(text, label).not.toMatch(/\/home\/[a-z]+\//);
      expect(text, label).not.toMatch(/\/Users\/[a-z]+\//i);
      expect(text, label).not.toMatch(/C:\\\\/);
      // Ten-digit provider confirmation-number-like literals.
      expect(text, label).not.toMatch(/\b0\d{9}\b/);
      // Real showtime ids from captures (145xxxxxx range) and real dates.
      expect(text, label).not.toMatch(/\b145\d{6}\b/);
      expect(text, label).not.toMatch(/1Password/i);
      expect(text, label).not.toMatch(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
      );
    }
  });

  it("template fails closed and ships no card material", () => {
    expect(TEMPLATE).toContain("createAmcCapabilities");
    expect(TEMPLATE).toMatch(/fail(s)? closed/i);
    expect(TEMPLATE).not.toMatch(/\b(?:4\d{15}|5[1-5]\d{14}|3[47]\d{13})\b/);
    // The factory must throw until a real vault adapter is implemented.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require(
      path.join(ROOT, "templates", "amc-capabilities.template.cjs"),
    ) as {
      createAmcCapabilities: () => {
        cardProvider: { getCard: (v: string, o?: string) => Promise<unknown> };
      };
    };
    const capabilities = loaded.createAmcCapabilities();
    return expect(
      capabilities.cardProvider.getCard("vault://anything"),
    ).rejects.toThrow(/not configured/);
  });
});
