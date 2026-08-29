import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAmcCli } from "../src/cli";
import type { AmcClient } from "../src/client";

const ROOT = path.resolve(__dirname, "..");

function stubClient(): AmcClient {
  return {
    showtimes: { list: vi.fn() },
    inventory: { get: vi.fn(), getBatch: vi.fn() },
    auth: {
      status: vi.fn(async () => ({
        provider: "amc" as const,
        account: "personal" as const,
        status: "valid" as const,
      })),
      bootstrap: vi.fn(),
      clear: vi.fn(),
      repair: vi.fn(),
    },
    orders: {
      createCart: vi.fn(),
      get: vi.fn(),
      extendExpiration: vi.fn(),
      release: vi.fn(),
    },
    checkout: { preview: vi.fn(), submit: vi.fn(), reconcile: vi.fn() },
    refunds: { preview: vi.fn(), submit: vi.fn(), reconcile: vi.fn() },
    close: vi.fn(async () => undefined),
  } as unknown as AmcClient;
}

const cleanups: Array<() => void> = [];
const ENV_KEYS = ["AMC_CAPABILITY_MODULE", "AMC_HELLO_PROFILE_PATH"];
const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "amc-doctor-setup-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  writeFileSync(file, contents);
  return file;
}

describe("doctor reaches a redacted report on broken setup (production wiring)", () => {
  it("diagnoses a missing capability module instead of crashing before dispatch", async () => {
    process.env.AMC_CAPABILITY_MODULE = "/nonexistent-module-sentinel.cjs";
    const output: string[] = [];
    const code = await runAmcCli(["node", "amc", "doctor", "--json"], {
      // Real capability loading and setup path; only the network client is stubbed.
      createClient: () => stubClient(),
      writeOut: (line) => output.push(line),
      writeErr: (line) => output.push(line),
    });
    expect(code).toBe(0);
    expect(output).toHaveLength(1);
    const raw = output[0]!;
    const doctor = JSON.parse(raw);
    expect(doctor.kind).toBe("doctor");
    expect(doctor.setup.capabilityModule).toBe("invalid");
    expect(doctor.capabilities.moduleConfigured).toBe(true);
    expect(doctor.recommendedAction.action).toBe("fix-configuration");
    for (const leak of [
      "nonexistent-module-sentinel",
      "Cannot find module",
      "Require stack",
      "MODULE_NOT_FOUND",
    ]) {
      expect(raw).not.toContain(leak);
    }
  });

  it("diagnoses a malformed hello profile instead of failing before doctorReport", async () => {
    const profile = tempFile("profile-sentinel.json", "{ not json !!");
    process.env.AMC_HELLO_PROFILE_PATH = profile;
    const output: string[] = [];
    const code = await runAmcCli(["node", "amc", "doctor", "--json"], {
      createClient: () => stubClient(),
      writeOut: (line) => output.push(line),
      writeErr: (line) => output.push(line),
    });
    expect(code).toBe(0);
    expect(output).toHaveLength(1);
    const raw = output[0]!;
    const doctor = JSON.parse(raw);
    expect(doctor.kind).toBe("doctor");
    expect(doctor.setup.client).toBe("invalid");
    expect(doctor.transport.profileConfigured).toBe(true);
    expect(doctor.auth.status).toBe("unknown");
    expect(doctor.recommendedAction.action).toBe("fix-configuration");
    expect(raw).not.toContain("profile-sentinel");
    expect(raw).not.toContain(path.dirname(profile));
  });

  it("non-doctor commands fail closed with a typed, redacted setup error (JSON)", async () => {
    process.env.AMC_CAPABILITY_MODULE = "/nonexistent-module-sentinel.cjs";
    const output: string[] = [];
    const code = await runAmcCli(["node", "amc", "auth", "status", "--json"], {
      createClient: () => stubClient(),
      writeOut: (line) => output.push(line),
      writeErr: (line) => output.push(line),
    });
    expect(code).toBe(1);
    expect(output).toHaveLength(1);
    const { error } = JSON.parse(output[0]!);
    expect(error.code).toBe("AMC_CLI_SETUP");
    for (const leak of [
      "nonexistent-module-sentinel",
      "Cannot find module",
      "Require stack",
      "MODULE_NOT_FOUND",
    ]) {
      expect(output[0]!).not.toContain(leak);
    }
  });

  it("non-doctor human output also avoids leaking setup paths", async () => {
    const profile = tempFile("profile-sentinel.json", "{ nope");
    process.env.AMC_HELLO_PROFILE_PATH = profile;
    const out: string[] = [];
    const err: string[] = [];
    const code = await runAmcCli(["node", "amc", "auth", "status"], {
      createClient: () => stubClient(),
      writeOut: (line) => out.push(line),
      writeErr: (line) => err.push(line),
    });
    expect(code).toBe(1);
    expect(out).toHaveLength(0);
    const text = err.join("\n");
    expect(text).toContain("AMC_HELLO_PROFILE_PATH");
    expect(text).not.toContain("profile-sentinel");
    expect(text).not.toContain(path.dirname(profile));
  });

  it("enters redacted doctor mode even after global options (--checkout-session X doctor)", async () => {
    process.env.AMC_CAPABILITY_MODULE = "/nonexistent-module-sentinel.cjs";
    const output: string[] = [];
    const code = await runAmcCli(
      ["node", "amc", "--checkout-session", "X", "doctor", "--json"],
      {
        createClient: () => stubClient(),
        writeOut: (line) => output.push(line),
        writeErr: (line) => output.push(line),
      },
    );
    expect(code).toBe(0);
    expect(output).toHaveLength(1);
    const doctor = JSON.parse(output[0]!);
    expect(doctor.kind).toBe("doctor");
    expect(doctor.setup.capabilityModule).toBe("invalid");
    expect(output[0]!).not.toContain("nonexistent-module-sentinel");
  });

  it("subprocess: doctor --json emits exactly one redacted report with both failures", () => {
    const profile = tempFile("profile-sentinel.json", "{ malformed");
    const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
    const stdout = execFileSync(tsx, ["src/cli.ts", "doctor", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        AMC_CAPABILITY_MODULE: "/nonexistent-module-sentinel.cjs",
        AMC_HELLO_PROFILE_PATH: profile,
      },
    });
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const doctor = JSON.parse(lines[0]!);
    expect(doctor.kind).toBe("doctor");
    expect(doctor.setup).toEqual({
      capabilityModule: "invalid",
      client: "invalid",
    });
    expect(doctor.auth.status).toBe("unknown");
    for (const leak of [
      "nonexistent-module-sentinel",
      "profile-sentinel",
      "Require stack",
      "MODULE_NOT_FOUND",
      path.dirname(profile),
    ]) {
      expect(stdout).not.toContain(leak);
    }
  });
});
