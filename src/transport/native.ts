import { request as undiciRequest, ProxyAgent, Dispatcher } from "undici";
import {
  RequestInput,
  ResponseOutput,
  Transport,
  extractSetCookieLines,
  extractSetCookieNames,
} from "./core";

/**
 * Native transport using Undici. Direct egress uses the default dispatcher;
 * home egress uses a ProxyAgent built from the runtime-resolved proxy URL.
 */
export class NativeTransport implements Transport {
  readonly name = "native";

  async request(input: RequestInput): Promise<ResponseOutput> {
    const start = performance.now();
    let dispatcher: Dispatcher | undefined;
    if (input.proxyUrl) {
      dispatcher = new ProxyAgent({ uri: input.proxyUrl });
    }
    try {
      const res = await undiciRequest(input.url, {
        method: input.method as Dispatcher.HttpMethod,
        headers: input.headers,
        body: input.body,
        dispatcher,
        maxRedirections: input.followRedirect ? 5 : 0,
        headersTimeout: input.timeoutMs,
        bodyTimeout: input.timeoutMs,
      });
      const bodyText = await res.body.text();
      const headers = normalizeHeaders(
        res.headers as Record<string, string | string[] | undefined>,
      );
      return {
        status: res.statusCode,
        headers,
        bodyText,
        timingMs: Math.round(performance.now() - start),
        transport: this.name,
        setCookieNames: extractSetCookieNames(
          res.headers as Record<string, string | string[] | undefined>,
        ),
        setCookies: extractSetCookieLines(
          res.headers as Record<string, string | string[] | undefined>,
        ),
      };
    } finally {
      if (dispatcher) await dispatcher.close().catch(() => undefined);
    }
  }
}

function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}
