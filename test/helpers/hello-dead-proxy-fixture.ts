// Real child-process fixture: a HelloTransport request through a dead local
// proxy. The regression this guards: hellojs against a refused proxy can leave
// its promise unsettled with no ref'd handle, and the transport's unref'd wall
// clock let Node exit 0 with zero output. After the fix the ref'd wall clock
// fires: the process must emit exactly one JSON error line and exit nonzero.
// Only loopback is contacted (the proxy is dead, so the target is never
// reached).
import { HelloTransport } from "../../src/transport";

const proxyUrl = process.argv[2];
if (!proxyUrl) {
  console.error("usage: fixture <dead-proxy-url>");
  process.exit(2);
}

new HelloTransport({ proxyUrl })
  .request({
    method: "GET",
    url: "https://www.amctheatres.com/",
    headers: {},
    verifyTLS: true,
    followRedirect: false,
    timeoutMs: 500,
  })
  .then(
    (response) => {
      console.log(JSON.stringify({ status: response.status }));
      process.exit(0);
    },
    (error: unknown) => {
      console.log(
        JSON.stringify({
          timedOut: /hello transport timed out/.test(String(error)),
        }),
      );
      process.exit(3);
    },
  );
