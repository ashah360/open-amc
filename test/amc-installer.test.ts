import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const INSTALLER = path.join(ROOT, "install.sh");

const sandboxes: string[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

interface Sandbox {
  root: string;
  home: string;
  fakeBin: string;
  logDir: string;
  env: NodeJS.ProcessEnv;
}

/**
 * A sandbox with a temp HOME and fake git/npm/hermes/openclaw on PATH. Every
 * fake records its argv; fake `git clone` materializes a minimal open-amc
 * checkout whose bin/amc stub answers `doctor --json`. No network, and nothing
 * outside the sandbox is touched.
 */
function makeSandbox(
  options: { agents?: Array<"hermes" | "openclaw"> } = {},
): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "amc-installer-"));
  sandboxes.push(root);
  const home = path.join(root, "home");
  const fakeBin = path.join(root, "fakebin");
  const logDir = path.join(root, "logs");
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  const fake = (name: string, body: string) => {
    const file = path.join(fakeBin, name);
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
  };

  fake(
    "git",
    [
      `echo "git $*" >> "$FAKE_LOG_DIR/git.log"`,
      // Materialize a minimal open-amc checkout on clone (last arg is dest).
      `if [ "$1" = "clone" ]; then`,
      `  dest="\${@: -1}"`,
      `  mkdir -p "$dest/bin" "$dest/.git"`,
      `  printf '%s' '{"name":"@ashah360/open-amc","version":"0.1.4"}' > "$dest/package.json"`,
      `  printf '%s' '{"name":"@ashah360/open-amc","lockfileVersion":3,"packages":{"node_modules/playwright-core":{"version":"1.62.1"}}}' > "$dest/package-lock.json"`,
      `  printf '%s\\n' '---' 'name: open-amc' '---' > "$dest/SKILL.md"`,
      `  {`,
      `    echo '#!/usr/bin/env bash'`,
      `    echo 'echo "amc $*" >> "$FAKE_LOG_DIR/amc.log"'`,
      `    echo 'if [ "\${1:-}" = "doctor" ]; then echo "{\\"kind\\":\\"doctor\\"}"; exit "\${FAKE_DOCTOR_EXIT:-0}"; fi'`,
      `  } > "$dest/bin/amc"`,
      `  chmod +x "$dest/bin/amc"`,
      `fi`,
      `exit 0`,
    ].join("\n"),
  );
  // Fake npm records argv and, like real npm, materializes playwright-core in
  // the cwd module tree when asked to install it (FAKE_NPM_SKIP_PLAYWRIGHT=1
  // models an npm that silently failed to deliver it).
  fake(
    "npm",
    [
      `echo "npm $*" >> "$FAKE_LOG_DIR/npm.log"`,
      `case "$*" in`,
      `  *playwright-core@*)`,
      `    if [ "\${FAKE_NPM_SKIP_PLAYWRIGHT:-0}" != "1" ]; then`,
      `      mkdir -p node_modules/playwright-core`,
      `      printf '%s' '{"name":"playwright-core","version":"1.62.1","main":"index.js"}' > node_modules/playwright-core/package.json`,
      `      printf '%s' 'module.exports = {};' > node_modules/playwright-core/index.js`,
      `    fi`,
      `    ;;`,
      `esac`,
      `exit 0`,
    ].join("\n"),
  );
  // Agent-platform fakes model the REAL contracts observed on this host:
  // `skills install` records argv and exits 0 even on a fetch failure, and
  // installation is proven independently by `skills list`. `hermes` supports
  // `--now` only when its `--help` advertises it (FAKE_<AGENT>_NOW=1). The
  // listed skill is controlled by FAKE_<AGENT>_LISTED (default present).
  for (const agent of options.agents ?? []) {
    const upper = agent.toUpperCase();
    fake(
      agent,
      [
        `log="$FAKE_LOG_DIR/${agent}.log"`,
        `if [ "\${1:-} \${2:-}" = "skills install" ] && [ "\${3:-}" = "--help" ]; then`,
        `  echo "Usage: ${agent} skills install <identifier> [--category c] [--name n] [--force] [--yes]"`,
        `  [ "\${FAKE_${upper}_NOW:-0}" = "1" ] && echo "      --now    refresh the current session"`,
        `  exit 0`,
        `fi`,
        `if [ "\${1:-} \${2:-}" = "skills install" ]; then`,
        `  echo "${agent} $*" >> "$log"`,
        `  exit 0`,
        `fi`,
        `if [ "\${1:-} \${2:-}" = "skills list" ]; then`,
        `  [ "\${FAKE_${upper}_LISTED:-1}" = "1" ] && echo "open-amc  Buy AMC movie tickets"`,
        `  echo "some-other-skill  unrelated" ; exit 0`,
        `fi`,
        `echo "${agent} $*" >> "$log"`,
        `exit 0`,
      ].join("\n"),
    );
  }

  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${fakeBin}:/usr/bin:/bin`,
    FAKE_LOG_DIR: logDir,
    OPEN_AMC_REPOSITORY: "https://git.example.test/open-amc.git",
    // OPEN_AMC_REF deliberately NOT overridden: assert the production pin.
  };
  return { root, home, fakeBin, logDir, env };
}

function runInstaller(
  sandbox: Sandbox,
  args: string[] = [],
  extraEnv: NodeJS.ProcessEnv = {},
): { status: number; output: string } {
  try {
    const output = execFileSync("bash", [INSTALLER, ...args], {
      env: { ...sandbox.env, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (error) {
    const failed = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: failed.status ?? 1,
      output: `${failed.stdout ?? ""}${failed.stderr ?? ""}`,
    };
  }
}

function logOf(sandbox: Sandbox, name: string): string {
  const file = path.join(sandbox.logDir, `${name}.log`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

describe("install.sh", () => {
  it("passes bash -n", () => {
    execFileSync("bash", ["-n", INSTALLER]);
  });

  it("clones the production pin, builds, symlinks, verifies doctor, and installs both agents (auto)", () => {
    const sandbox = makeSandbox({ agents: ["hermes", "openclaw"] });
    // Spaces in the install path must be handled.
    const installDir = path.join(sandbox.home, "open amc", "app");
    const binDir = path.join(sandbox.home, ".local", "bin");
    const { status, output } = runInstaller(sandbox, ["--agent", "auto"], {
      OPEN_AMC_HOME: installDir,
      BIN_DIR: binDir,
    });
    expect(status).toBe(0);

    // Pinned clone of the overridable repository at the production tag.
    const git = logOf(sandbox, "git");
    expect(git).toContain(
      `clone --branch v0.1.4 --depth 1 https://git.example.test/open-amc.git ${installDir}`,
    );
    // Dependencies installed inside the checkout.
    expect(logOf(sandbox, "npm")).toContain("npm install --no-audit --no-fund");
    // The exact lock-pinned playwright-core lands in the PRIVATE checkout
    // (auth repair capability), never globally.
    expect(logOf(sandbox, "npm")).toContain(
      "npm install --no-audit --no-fund --no-save playwright-core@1.62.1",
    );
    expect(logOf(sandbox, "npm")).not.toMatch(/(^|\s)(-g|--global)(\s|$)/m);
    expect(
      existsSync(
        path.join(installDir, "node_modules", "playwright-core", "index.js"),
      ),
    ).toBe(true);
    // CLI symlink points at the checkout's wrapper.
    const link = path.join(binDir, "amc");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(path.join(installDir, "bin", "amc"));
    // Doctor verification actually ran through the symlink.
    expect(logOf(sandbox, "amc")).toContain("amc doctor --json");
    // Hermes got the pinned raw root SKILL URL, noninteractive with --yes.
    // This host's Hermes does NOT advertise --now, so it is omitted.
    expect(logOf(sandbox, "hermes")).toContain(
      "skills install https://raw.githubusercontent.com/ashah360/open-amc/v0.1.4/SKILL.md --yes",
    );
    expect(logOf(sandbox, "hermes")).not.toContain("--now");
    // OpenClaw got the local checkout root, global, with a stable name.
    expect(logOf(sandbox, "openclaw")).toContain(
      `skills install ${installDir} --global --as open-amc`,
    );
    // PATH warning: BIN_DIR is not on the sandbox PATH.
    expect(output).toContain("not on your PATH");
  });

  it("is idempotent: a rerun updates the same checkout instead of recloning", () => {
    const sandbox = makeSandbox();
    const installDir = path.join(sandbox.home, ".open-amc", "app");
    const first = runInstaller(sandbox, ["--agent", "none"], {
      OPEN_AMC_HOME: installDir,
    });
    expect(first.status).toBe(0);
    const second = runInstaller(sandbox, ["--agent", "none"], {
      OPEN_AMC_HOME: installDir,
    });
    expect(second.status).toBe(0);
    const git = logOf(sandbox, "git");
    expect(git.match(/clone /g)).toHaveLength(1);
    expect(git).toContain(
      `-C ${installDir} fetch --force --tags origin v0.1.4`,
    );
    // The exact fetched ref is checked out, so a stale local branch with the
    // same name can never win over the fresh fetch.
    expect(git).toContain(
      `-C ${installDir} checkout --force --detach FETCH_HEAD`,
    );
  });

  it("supports a testable ref/repository override without changing the default pin", () => {
    const sandbox = makeSandbox();
    const installDir = path.join(sandbox.home, "custom", "checkout");
    const { status } = runInstaller(sandbox, ["--agent", "none"], {
      OPEN_AMC_HOME: installDir,
      OPEN_AMC_REF: "my-test-branch",
      OPEN_AMC_REPOSITORY: "https://mirror.example.test/fork.git",
    });
    expect(status).toBe(0);
    expect(logOf(sandbox, "git")).toContain(
      `clone --branch my-test-branch --depth 1 https://mirror.example.test/fork.git ${installDir}`,
    );
  });

  it("refuses a nonempty target it does not own, without deleting anything", () => {
    const sandbox = makeSandbox();
    const foreign = path.join(sandbox.home, "precious");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(path.join(foreign, "keep.txt"), "do not touch");
    const { status, output } = runInstaller(sandbox, ["--agent", "none"], {
      OPEN_AMC_HOME: foreign,
    });
    expect(status).not.toBe(0);
    expect(output).toContain("refusing");
    expect(readFileSync(path.join(foreign, "keep.txt"), "utf8")).toBe(
      "do not touch",
    );
  });

  it("refuses a foreign git checkout at the target", () => {
    const sandbox = makeSandbox();
    const foreign = path.join(sandbox.home, "other-repo");
    mkdirSync(path.join(foreign, ".git"), { recursive: true });
    writeFileSync(
      path.join(foreign, "package.json"),
      JSON.stringify({ name: "someone-else" }),
    );
    const { status, output } = runInstaller(sandbox, ["--agent", "none"], {
      OPEN_AMC_HOME: foreign,
    });
    expect(status).not.toBe(0);
    expect(output).toContain("refusing");
  });

  it("installs the CLI and prints exact later commands when no agent platform exists", () => {
    const sandbox = makeSandbox({ agents: [] });
    const { status, output } = runInstaller(sandbox, ["--agent", "auto"]);
    expect(status).toBe(0);
    expect(output).toContain(
      "hermes skills install https://raw.githubusercontent.com/ashah360/open-amc/v0.1.4/SKILL.md --yes",
    );
    expect(output).toContain("--global --as open-amc");
    expect(output).not.toContain("--now");
  });

  it("detects hermes alone under --agent auto and verifies it", () => {
    const sandbox = makeSandbox({ agents: ["hermes"] });
    const { status } = runInstaller(sandbox, ["--agent", "auto"]);
    expect(status).toBe(0);
    expect(logOf(sandbox, "hermes")).toContain("skills install");
    expect(logOf(sandbox, "openclaw")).toBe("");
  });

  it("appends --now only when this Hermes advertises it in --help", () => {
    const sandbox = makeSandbox({ agents: ["hermes"] });
    const { status } = runInstaller(sandbox, ["--agent", "hermes"], {
      FAKE_HERMES_NOW: "1",
    });
    expect(status).toBe(0);
    expect(logOf(sandbox, "hermes")).toContain("--yes --now");
  });

  it("fails when hermes install exits 0 but the skill is not listed", () => {
    const sandbox = makeSandbox({ agents: ["hermes"] });
    const { status, output } = runInstaller(sandbox, ["--agent", "hermes"], {
      FAKE_HERMES_LISTED: "0",
    });
    expect(status).not.toBe(0);
    expect(output).toContain("did not register the open-amc skill");
  });

  it("fails when openclaw install exits 0 but the skill is not listed", () => {
    const sandbox = makeSandbox({ agents: ["openclaw"] });
    const { status, output } = runInstaller(sandbox, ["--agent", "openclaw"], {
      FAKE_OPENCLAW_LISTED: "0",
    });
    expect(status).not.toBe(0);
    expect(output).toContain("did not register the open-amc skill");
  });

  it("fails with an actionable error when playwright-core cannot be resolved after install", () => {
    const sandbox = makeSandbox();
    const { status, output } = runInstaller(sandbox, ["--agent", "none"], {
      FAKE_NPM_SKIP_PLAYWRIGHT: "1",
    });
    expect(status).not.toBe(0);
    expect(output).toContain("playwright-core");
    expect(output).toContain("auth repair");
  });

  it("verifies playwright-core resolution from the checkout module tree on idempotent reruns", () => {
    const sandbox = makeSandbox();
    const installDir = path.join(sandbox.home, ".open-amc", "app");
    expect(
      runInstaller(sandbox, ["--agent", "none"], { OPEN_AMC_HOME: installDir })
        .status,
    ).toBe(0);
    expect(
      runInstaller(sandbox, ["--agent", "none"], { OPEN_AMC_HOME: installDir })
        .status,
    ).toBe(0);
    // Both runs installed the exact pin into the same private checkout.
    const pinned = logOf(sandbox, "npm").match(
      /--no-save playwright-core@1\.62\.1/g,
    );
    expect(pinned).toHaveLength(2);
  });

  it("fails (does not claim success) when doctor verification fails", () => {
    const sandbox = makeSandbox();
    const { status } = runInstaller(sandbox, ["--agent", "none"], {
      FAKE_DOCTOR_EXIT: "1",
    });
    expect(status).not.toBe(0);
  });

  it("rejects unknown options and invalid agents", () => {
    const sandbox = makeSandbox();
    expect(runInstaller(sandbox, ["--bogus"]).status).toBe(2);
    expect(runInstaller(sandbox, ["--agent", "skynet"]).status).toBe(2);
  });
});
