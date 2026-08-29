#!/usr/bin/env node
// Packs the package, installs the tarball into a throwaway directory, and proves
// that both a Node/TypeScript-style import and the installed `amc` bin work from
// the packed artifact (not the source tree). Additionally proves a clean
// Git-style install: a copy of only the tracked files (no pre-existing dist)
// must build its own dist via the `prepare` lifecycle and yield a working bin.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const work = mkdtempSync(path.join(tmpdir(), "amc-pack-smoke-"));

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

try {
  run("npm", ["run", "build"], repoRoot);
  run("npm", ["pack", "--pack-destination", work], repoRoot);
  const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack produced no tarball");

  const consumer = path.join(work, "consumer");
  mkdirSync(consumer, { recursive: true });
  run("npm", ["init", "-y"], consumer);
  run("npm", ["install", path.join(work, tarball)], consumer);

  // (1) Importable client surface resolves and constructs with the default transport.
  writeFileSync(
    path.join(consumer, "import-check.cjs"),
    [
      "const api = require('@ashah360/open-amc');",
      "if (typeof api.createAmcClient !== 'function') throw new Error('createAmcClient missing');",
      "const client = api.createAmcClient();",
      "for (const ns of ['showtimes','inventory','auth','orders','checkout','refunds']) {",
      "  if (!client[ns]) throw new Error('missing namespace: ' + ns);",
      "}",
      "if (typeof client.close !== 'function') throw new Error('close missing');",
      "client.close().then(() => console.log('import-check ok'));",
    ].join("\n"),
  );
  const importOut = run("node", ["import-check.cjs"], consumer);
  if (!importOut.includes("import-check ok")) throw new Error("import smoke failed");

  // (2) Installed bin prints help and exits cleanly.
  const helpOut = run("node", [path.join("node_modules", ".bin", "amc"), "--help"], consumer);
  if (!/Usage:\s+amc/.test(helpOut)) throw new Error("amc --help did not render usage");

  // (3) Git-style install: only tracked working-tree files (no dist), then a
  // plain `npm install` must build dist through `prepare` (no lifecycle
  // recursion: prepare -> build -> tsc only) and produce a working bin.
  const gitCopy = path.join(work, "git-src");
  mkdirSync(gitCopy, { recursive: true });
  run("bash", [
    "-c",
    `cd ${JSON.stringify(repoRoot)} && git ls-files -z | tar --null -T - -cf - | tar -xf - -C ${JSON.stringify(gitCopy)}`,
  ], repoRoot);
  if (existsSync(path.join(gitCopy, "dist"))) {
    throw new Error("git-style copy unexpectedly contains a prebuilt dist");
  }
  run("npm", ["install", "--no-audit", "--no-fund"], gitCopy);
  if (!existsSync(path.join(gitCopy, "dist", "cli.js"))) {
    throw new Error("git-style install did not build dist via prepare");
  }
  const gitHelp = run("node", [path.join(gitCopy, "dist", "cli.js"), "--help"], gitCopy);
  if (!/Usage:\s+amc/.test(gitHelp)) {
    throw new Error("git-style installed bin did not render usage");
  }

  console.log("pack smoke passed:", tarball);
} finally {
  rmSync(work, { recursive: true, force: true });
}
