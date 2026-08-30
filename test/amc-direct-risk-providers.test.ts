import { describe, expect, it } from "vitest";
import {
  AmcKountSessionProvider,
  KountFirstPartyCookieProvider,
  RiskHttpRequest,
  RiskHttpTransport,
  StoredAmcKountCookieProvider,
  SyntheticFraudNetDeviceDataProvider,
} from "../src/commerce/direct-risk-providers";
import {
  MemorySessionStore,
  SessionKey,
  SessionStore,
} from "../src/auth-session";
import { AMC_SESSION_KEY } from "../src/client/runtime";
import { decodeAmcSession, encodeAmcSession } from "../src/client/session";

const ORDER_TOKEN = "00000000-0000-4000-8000-000000000003";
const KOUNT_SESSION = "00000000000040008000000000000003";
const KDDCGID = "00000000-0000-4000-8000-000000000001";

/** A collect=true config with the full boolean flag set the SDK requires. */
const COLLECT_TRUE_CONFIG = JSON.stringify({
  collection: {
    collect: true,
    feature_flags: {
      app: true,
      page: true,
      ui: true,
      exp: true,
      battery: true,
      browser: true,
      passLoc: true,
    },
  },
});

describe("SyntheticFraudNetDeviceDataProvider", () => {
  it("emits a fresh Braintree-shaped correlation value", async () => {
    const provider = new SyntheticFraudNetDeviceDataProvider(
      () => "0123456789abcdef0123456789abcdef",
    );
    await expect(provider.collect()).resolves.toEqual({
      deviceData: '{"correlation_id":"0123456789abcdef0123456789abcdef"}',
      fresh: true,
    });
  });

  it("rejects malformed correlation values", async () => {
    const provider = new SyntheticFraudNetDeviceDataProvider(() => "too-short");
    await expect(provider.collect()).rejects.toThrow(/correlation ID/);
  });
});

describe("AmcKountSessionProvider", () => {
  it("performs the exact Kount Web Client 2.2.3 initialization sequence", async () => {
    const http = new FakeRiskHttp([
      { status: 201, bodyText: "" },
      {
        status: 200,
        bodyText: JSON.stringify({
          ttlms: 901000,
          collection: {
            collect: true,
            feature_flags: {
              app: true,
              page: true,
              ui: true,
              exp: true,
              battery: true,
              browser: true,
              da: false,
              passLoc: true,
            },
          },
        }),
      },
      { status: 200, bodyText: "" },
    ]);
    const provider = new AmcKountSessionProvider({
      http,
      firstPartyCookie: new FakeKountCookieProvider("existing-kount-cookie"),
      createKddcgid: () => KDDCGID,
    });

    await expect(
      provider.initialize({
        orderToken: ORDER_TOKEN,
        sessionId: KOUNT_SESSION,
      }),
    ).resolves.toEqual({ initialized: true, sessionId: KOUNT_SESSION });

    expect(http.requests).toEqual([
      {
        url: `https://ssl.kaptcha.com/session/${KOUNT_SESSION}?kddcgid=${KDDCGID}&impl=module&repo=npm`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "client-id": "602840",
          Origin: "https://www.amctheatres.com",
          Referer: "https://www.amctheatres.com/",
        },
      },
      {
        url: `https://ssl.kaptcha.com/cs/config?m=602840&s=${KOUNT_SESSION}&sv=2.2.3&kddcgid=${KDDCGID}&impl=module&repo=npm`,
        method: "GET",
        headers: {
          Accept: "*/*",
          Referer: "https://www.amctheatres.com/",
        },
      },
      {
        url: "https://ssl.kaptcha.com/cs/storecookie",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://www.amctheatres.com",
          Referer: "https://www.amctheatres.com/",
        },
        body: `m=602840&s=${KOUNT_SESSION}&sv=2.2.3&k=existing-kount-cookie&kddcgid=${KDDCGID}&impl=module&repo=npm`,
      },
    ]);
  });

  it("returns initialized immediately for a valid collect=false config (no collection run)", async () => {
    // Exact live shape: top keys collection+ttlms; collect=false; flags object.
    const http = new FakeRiskHttp([
      { status: 201, bodyText: "" },
      {
        status: 200,
        bodyText: JSON.stringify({
          collection: { collect: false, feature_flags: {} },
          ttlms: 900000,
        }),
      },
    ]);
    const cookie = new FakeKountCookieProvider("existing-kount-cookie");
    const provider = new AmcKountSessionProvider({
      http,
      firstPartyCookie: cookie,
      createKddcgid: () => KDDCGID,
    });

    await expect(
      provider.initialize({
        orderToken: ORDER_TOKEN,
        sessionId: KOUNT_SESSION,
      }),
    ).resolves.toEqual({ initialized: true, sessionId: KOUNT_SESSION });

    // Exactly session + config: no storecookie, no generatecookie, no writes.
    expect(http.requests.map((request) => request.url)).toEqual([
      `https://ssl.kaptcha.com/session/${KOUNT_SESSION}?kddcgid=${KDDCGID}&impl=module&repo=npm`,
      `https://ssl.kaptcha.com/cs/config?m=602840&s=${KOUNT_SESSION}&sv=2.2.3&kddcgid=${KDDCGID}&impl=module&repo=npm`,
    ]);
    expect(cookie.saved).toEqual([]);
  });

  it("accepts collect=false with a populated feature_flags object (flags not validated)", async () => {
    const http = new FakeRiskHttp([
      { status: 201, bodyText: "" },
      {
        status: 200,
        bodyText: JSON.stringify({
          collection: {
            collect: false,
            feature_flags: { app: "not-a-boolean" },
          },
        }),
      },
    ]);
    const provider = new AmcKountSessionProvider({
      http,
      firstPartyCookie: new FakeKountCookieProvider(null),
      createKddcgid: () => KDDCGID,
    });

    await expect(
      provider.initialize({
        orderToken: ORDER_TOKEN,
        sessionId: KOUNT_SESSION,
      }),
    ).resolves.toEqual({ initialized: true, sessionId: KOUNT_SESSION });
    expect(http.requests).toHaveLength(2);
  });

  it.each([
    [
      "missing first-party cookie",
      null,
      [
        { status: 201, bodyText: "" },
        { status: 200, bodyText: COLLECT_TRUE_CONFIG },
      ],
    ],
    ["rejected new-session post", "cookie", [{ status: 500, bodyText: "" }]],
    [
      "malformed config",
      "cookie",
      [
        { status: 201, bodyText: "" },
        { status: 200, bodyText: "{}" },
      ],
    ],
    [
      "nonboolean collect",
      "cookie",
      [
        { status: 201, bodyText: "" },
        {
          status: 200,
          bodyText: '{"collection":{"collect":"false","feature_flags":{}}}',
        },
      ],
    ],
    [
      "collect=false without feature_flags",
      "cookie",
      [
        { status: 201, bodyText: "" },
        { status: 200, bodyText: '{"collection":{"collect":false}}' },
      ],
    ],
    [
      "collect=true with incomplete feature flag booleans",
      "cookie",
      [
        { status: 201, bodyText: "" },
        {
          status: 200,
          bodyText: '{"collection":{"collect":true,"feature_flags":{}}}',
        },
      ],
    ],
    [
      "rejected cookie post",
      "cookie",
      [
        { status: 201, bodyText: "" },
        { status: 200, bodyText: COLLECT_TRUE_CONFIG },
        { status: 500, bodyText: "" },
      ],
    ],
  ])("fails closed for %s", async (_name, cookie, responses) => {
    const provider = new AmcKountSessionProvider({
      http: new FakeRiskHttp(responses),
      firstPartyCookie: new FakeKountCookieProvider(cookie),
      createKddcgid: () => KDDCGID,
    });

    await expect(
      provider.initialize({
        orderToken: ORDER_TOKEN,
        sessionId: KOUNT_SESSION,
      }),
    ).resolves.toEqual({ initialized: false, sessionId: KOUNT_SESSION });
  });

  it("does not send requests for a mismatched order-derived session", async () => {
    const http = new FakeRiskHttp([]);
    const provider = new AmcKountSessionProvider({
      http,
      firstPartyCookie: new FakeKountCookieProvider("cookie"),
      createKddcgid: () => KDDCGID,
    });

    await expect(
      provider.initialize({
        orderToken: ORDER_TOKEN,
        sessionId: "wrong-session",
      }),
    ).resolves.toEqual({ initialized: false, sessionId: "wrong-session" });
    expect(http.requests).toEqual([]);
  });
});

class FakeRiskHttp implements RiskHttpTransport {
  readonly requests: RiskHttpRequest[] = [];

  constructor(
    private readonly responses: Array<{ status: number; bodyText: string }>,
  ) {}

  request(
    input: RiskHttpRequest,
  ): Promise<{ status: number; bodyText: string }> {
    this.requests.push(structuredClone(input));
    const response = this.responses.shift();
    if (!response) return Promise.reject(new Error("unexpected risk request"));
    return Promise.resolve(response);
  }
}

class FakeKountCookieProvider implements KountFirstPartyCookieProvider {
  readonly saved: string[] = [];

  constructor(private readonly value: string | null) {}

  getCookie(): Promise<string | null> {
    return Promise.resolve(this.value);
  }

  setCookie(value: string): Promise<void> {
    this.saved.push(value);
    return Promise.resolve();
  }
}

class LockRecordingStore implements SessionStore {
  lockCount = 0;

  constructor(private readonly inner: SessionStore) {}

  load(key: SessionKey): Promise<Uint8Array | null> {
    return this.inner.load(key);
  }
  save(key: SessionKey, bytes: Uint8Array): Promise<void> {
    return this.inner.save(key, bytes);
  }
  remove(key: SessionKey): Promise<void> {
    return this.inner.remove(key);
  }
  withRefreshLock<T>(key: SessionKey, fn: () => Promise<T>): Promise<T> {
    this.lockCount += 1;
    return this.inner.withRefreshLock(key, fn);
  }
}

describe("AmcKountSessionProvider /cs/generatecookie fallback", () => {
  it("generates and persists a first-party cookie when none is present", async () => {
    const http = new FakeRiskHttp([
      { status: 201, bodyText: "" },
      { status: 200, bodyText: COLLECT_TRUE_CONFIG },
      { status: 200, bodyText: JSON.stringify({ value: "generated-kount" }) },
    ]);
    const cookie = new FakeKountCookieProvider(null);
    const provider = new AmcKountSessionProvider({
      http,
      firstPartyCookie: cookie,
      createKddcgid: () => KDDCGID,
    });

    await expect(
      provider.initialize({
        orderToken: ORDER_TOKEN,
        sessionId: KOUNT_SESSION,
      }),
    ).resolves.toEqual({ initialized: true, sessionId: KOUNT_SESSION });

    expect(cookie.saved).toEqual(["generated-kount"]);
    const urls = http.requests.map((request) => request.url);
    expect(urls.some((url) => url.includes("/cs/generatecookie?"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/cs/storecookie"))).toBe(false);
  });

  it("falls back to generation when storecookie is rejected with a 500", async () => {
    const http = new FakeRiskHttp([
      { status: 201, bodyText: "" },
      { status: 200, bodyText: COLLECT_TRUE_CONFIG },
      { status: 500, bodyText: "" },
      { status: 200, bodyText: JSON.stringify({ value: "regenerated" }) },
    ]);
    const cookie = new FakeKountCookieProvider("existing-cookie");
    const provider = new AmcKountSessionProvider({
      http,
      firstPartyCookie: cookie,
      createKddcgid: () => KDDCGID,
    });

    await expect(
      provider.initialize({
        orderToken: ORDER_TOKEN,
        sessionId: KOUNT_SESSION,
      }),
    ).resolves.toEqual({ initialized: true, sessionId: KOUNT_SESSION });
    expect(cookie.saved).toEqual(["regenerated"]);
  });

  it("fails closed when generation returns an invalid cookie payload", async () => {
    const http = new FakeRiskHttp([
      { status: 201, bodyText: "" },
      { status: 200, bodyText: COLLECT_TRUE_CONFIG },
      { status: 200, bodyText: "{}" },
    ]);
    const cookie = new FakeKountCookieProvider(null);
    const provider = new AmcKountSessionProvider({
      http,
      firstPartyCookie: cookie,
      createKddcgid: () => KDDCGID,
    });

    await expect(
      provider.initialize({
        orderToken: ORDER_TOKEN,
        sessionId: KOUNT_SESSION,
      }),
    ).resolves.toMatchObject({ initialized: false });
    expect(cookie.saved).toEqual([]);
  });
});

describe("StoredAmcKountCookieProvider persistence", () => {
  it("persists a generated cookie under the session refresh lock", async () => {
    const store = new LockRecordingStore(new MemorySessionStore());
    await store.save(
      AMC_SESSION_KEY,
      encodeAmcSession({
        version: 1,
        origin: "https://www.amctheatres.com",
        profile: "chrome147-mac",
        exportedAt: "2099-01-15T08:00:00.000Z",
        cookies: [
          {
            name: "clientside-cookie",
            value: "stale-kount",
            domain: ".amctheatres.com",
            path: "/",
            expires: -1,
            secure: true,
            httpOnly: false,
            sameSite: "Lax",
          },
        ],
      }),
    );
    const provider = new StoredAmcKountCookieProvider(store);

    await provider.setCookie("fresh-kount-value");

    expect(store.lockCount).toBe(1);
    const bytes = await store.load(AMC_SESSION_KEY);
    const session = decodeAmcSession(bytes!);
    const cookie = session.cookies.filter(
      (candidate) => candidate.name === "clientside-cookie",
    );
    expect(cookie).toHaveLength(1);
    expect(cookie[0]?.value).toBe("fresh-kount-value");
  });
});
