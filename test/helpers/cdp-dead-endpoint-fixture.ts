// Real child-process fixture: awaits a REAL PlaywrightBrowserRuntime.acquire()
// against the endpoint given in argv. The regression this guards: a dead CDP
// endpoint used to leave an unresolved, unref'd promise, letting Node exit 0
// with zero output bytes. After the fix the process must emit exactly one JSON
// error line and exit nonzero.
import { PlaywrightBrowserRuntime } from "../../src/capabilities/browser/playwright/runtime";

const endpoint = process.argv[2];
if (!endpoint) {
  console.error("usage: fixture <cdp-endpoint-url>");
  process.exit(2);
}

new PlaywrightBrowserRuntime({ kind: "cdp", endpointURL: endpoint })
  .acquire()
  .then(
    () => {
      console.log(JSON.stringify({ acquired: true }));
      process.exit(0);
    },
    (error: unknown) => {
      const typed = error as { code?: string; reason?: string };
      console.log(JSON.stringify({ code: typed.code, reason: typed.reason }));
      process.exit(3);
    },
  );
