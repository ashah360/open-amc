import { execFileSync } from "node:child_process";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  PlaywrightBrowserRuntime,
  PlaywrightConnectionError,
  preflightCdpEndpoint,
} from "../src/capabilities/browser/playwright/runtime";
import {
  FakePlaywrightBrowser,
  fakePlaywrightModule,
} from "./helpers/fake-playwright";

const ROOT = path.resolve(__dirname, "..");

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

function serve(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    handler(req, res);
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

/** A loopback port that is GUARANTEED closed: bind, read, release. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const VERSION_BODY = JSON.stringify({
  Browser: "Chrome/147.0.0.0",
  "Protocol-Version": "1.3",
  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/synthetic",
});

describe("CDP endpoint preflight", () => {
  it("accepts a valid /json/version and lets acquire connect (endpoint path respected)", async () => {
    const { url, requests } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(VERSION_BODY);
    });
    const browser = new FakePlaywrightBrowser();
    const module = fakePlaywrightModule({ connect: browser });
    const runtime = new PlaywrightBrowserRuntime(
      { kind: "cdp", endpointURL: `${url}/base/` },
      { loadModule: async () => module },
    );

    const acquired = await runtime.acquire();
    expect(acquired.browserDisposal).toBe("disconnect");
    // The preflight hit the endpoint's own path + /json/version.
    expect(requests).toContain("/base/json/version");
    expect(module.chromium.connectCalls).toEqual([`${url}/base/`]);
  });

  it("rejects a refused endpoint as unreachable before touching playwright", async () => {
    const port = await closedPort();
    let moduleLoaded = false;
    const runtime = new PlaywrightBrowserRuntime(
      { kind: "cdp", endpointURL: `http://127.0.0.1:${port}` },
      {
        loadModule: async () => {
          moduleLoaded = true;
          return fakePlaywrightModule({ connect: new FakePlaywrightBrowser() });
        },
      },
    );

    const failure = await runtime.acquire().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlaywrightConnectionError);
    expect(failure).toMatchObject({
      code: "AMC_PLAYWRIGHT_CONNECTION_FAILED",
      reason: "unreachable",
    });
    // No endpoint/port leakage in the message.
    expect(String(failure)).not.toContain(String(port));
    expect(moduleLoaded).toBe(false);
  });

  it("rejects malformed JSON as invalid-response", async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not json at all");
    });
    await expect(preflightCdpEndpoint(url)).rejects.toMatchObject({
      code: "AMC_PLAYWRIGHT_CONNECTION_FAILED",
      reason: "invalid-response",
    });
  });

  it("rejects a JSON body without a usable CDP version shape", async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hello: "world" }));
    });
    await expect(preflightCdpEndpoint(url)).rejects.toMatchObject({
      reason: "invalid-response",
    });
  });

  it("does not follow redirects: a 3xx is invalid-response", async () => {
    const { url, requests } = await serve((_req, res) => {
      res.writeHead(302, {
        location: "http://elsewhere.example.test/json/version",
      });
      res.end();
    });
    await expect(preflightCdpEndpoint(url)).rejects.toMatchObject({
      reason: "invalid-response",
    });
    expect(requests).toEqual(["/json/version"]);
  });

  it("times out a silent endpoint with a bounded, ref'd budget", async () => {
    const { url } = await serve(() => {
      // Accept and never respond.
    });
    await expect(preflightCdpEndpoint(url, 200)).rejects.toMatchObject({
      reason: "timeout",
    });
  });

  it("rejects non-http(s) endpoints as invalid-response", async () => {
    await expect(
      preflightCdpEndpoint("ws://127.0.0.1:9222"),
    ).rejects.toMatchObject({ reason: "invalid-response" });
    await expect(preflightCdpEndpoint("not a url")).rejects.toMatchObject({
      reason: "invalid-response",
    });
  });

  it("bounds connectOverCDP itself: a post-preflight hang fails typed, not silent", async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(VERSION_BODY);
    });
    const module = {
      chromium: {
        launch: async () => {
          throw new Error("unused");
        },
        // Connect never settles: the ref'd budget must reject.
        connectOverCDP: () => new Promise<never>(() => undefined),
      },
    };
    const runtime = new PlaywrightBrowserRuntime(
      { kind: "cdp", endpointURL: url },
      {
        loadModule: async () => module as never,
        cdpConnectTimeoutMs: 150,
      },
    );

    const failure = await runtime.acquire().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlaywrightConnectionError);
    expect(failure).toMatchObject({ reason: "timeout" });
  });
});

describe("real child-process lifecycle with a dead proxy (hello transport)", () => {
  it("exits nonzero with one JSON error line instead of a silent exit 0", async () => {
    const port = await closedPort();
    const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
    const fixture = path.join(
      ROOT,
      "test",
      "helpers",
      "hello-dead-proxy-fixture.ts",
    );

    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync(tsx, [fixture, `http://127.0.0.1:${port}`], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failed = error as { status?: number; stdout?: string };
      status = failed.status ?? -1;
      stdout = failed.stdout ?? "";
    }

    expect(status).toBe(3);
    const lines = stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    // The transport either fails fast from the refused proxy or the REF'D wall
    // clock fires; both are typed rejections, never a silent natural exit.
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  }, 40_000);
});

describe("real child-process lifecycle with a dead CDP endpoint", () => {
  it("exits nonzero with exactly one JSON error line (never a silent exit 0)", async () => {
    const port = await closedPort();
    const endpoint = `http://127.0.0.1:${port}`;
    const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
    const fixture = path.join(
      ROOT,
      "test",
      "helpers",
      "cdp-dead-endpoint-fixture.ts",
    );

    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync(tsx, [fixture, endpoint], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failed = error as { status?: number; stdout?: string };
      status = failed.status ?? -1;
      stdout = failed.stdout ?? "";
    }

    // The historical bug: exit 0 with zero output bytes. Now: nonzero with one
    // stable JSON error line and no endpoint leakage.
    expect(status).toBe(3);
    const lines = stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      code: "AMC_PLAYWRIGHT_CONNECTION_FAILED",
      reason: "unreachable",
    });
    expect(stdout).not.toContain(String(port));
  }, 40_000);
});
