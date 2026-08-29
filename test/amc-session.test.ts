import { describe, expect, it } from "vitest";
import {
  AmcSession,
  applySetCookieLines,
  cookieHeaderFor,
  decodeAmcBootstrap,
  decodeAmcSession,
  encodeAmcSession,
} from "../src/client/session";
import { sanitizePeetFingerprint } from "../src/client/fingerprint";

const session: AmcSession = {
  version: 1,
  origin: "https://www.amctheatres.com",
  profile: "chrome147-mac",
  exportedAt: "2030-01-15T07:00:00.000Z",
  cookies: [
    {
      name: "root",
      value: "one",
      domain: ".amctheatres.com",
      path: "/",
      expires: -1,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "seat",
      value: "two",
      domain: "www.amctheatres.com",
      path: "/showtimes",
      expires: 2_000,
      secure: true,
      httpOnly: false,
      sameSite: "None",
    },
    {
      name: "expired",
      value: "gone",
      domain: ".amctheatres.com",
      path: "/",
      expires: 999,
      secure: true,
      httpOnly: false,
      sameSite: "Lax",
    },
  ],
};

describe("AMC opaque browser session", () => {
  it("normalizes a real-shape raw CDP cookie export only at bootstrap", () => {
    const raw = {
      cookies: [
        {
          name: "fractional",
          value: "one",
          domain: ".amctheatres.com",
          path: "/",
          expires: 1_797_123_456.987,
          size: 13,
          httpOnly: true,
          secure: true,
          session: false,
          sameSite: "None",
          priority: "Medium",
          sameParty: false,
          sourceScheme: "Secure",
          sourcePort: 443,
        },
        {
          name: "missing_same_site",
          value: "two",
          domain: "www.amctheatres.com",
          path: "/showtimes",
          expires: 0,
          httpOnly: false,
          secure: true,
          session: true,
        },
        {
          name: "unknown_same_site",
          value: "three",
          domain: ".amctheatres.com",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: true,
          session: false,
          sameSite: "Unspecified",
        },
        {
          name: "foreign",
          value: "ignored",
          domain: ".example.com",
          path: "/",
          expires: 1_797_123_456.1,
          httpOnly: true,
          secure: true,
          session: false,
          sameSite: "Lax",
        },
      ],
    };

    const converted = decodeAmcBootstrap(
      Buffer.from(JSON.stringify(raw)),
      new Date("2030-01-15T07:30:00.000Z"),
    );

    expect(converted).toEqual({
      version: 1,
      origin: "https://www.amctheatres.com",
      profile: "chrome147-mac",
      exportedAt: "2030-01-15T07:30:00.000Z",
      cookies: [
        {
          name: "fractional",
          value: "one",
          domain: ".amctheatres.com",
          path: "/",
          expires: 1_797_123_456,
          httpOnly: true,
          secure: true,
          sameSite: "None",
        },
        {
          name: "missing_same_site",
          value: "two",
          domain: "www.amctheatres.com",
          path: "/showtimes",
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
        },
        {
          name: "unknown_same_site",
          value: "three",
          domain: ".amctheatres.com",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
        },
      ],
    });
    expect(decodeAmcSession(encodeAmcSession(converted))).toEqual(converted);
    expect(() => decodeAmcSession(Buffer.from(JSON.stringify(raw)))).toThrow(
      /session shape drifted/,
    );
    expect(() =>
      decodeAmcSession(
        Buffer.from(
          JSON.stringify({
            ...session,
            cookies: [{ ...session.cookies[0], expires: 1_797_123_456.75 }],
          }),
        ),
      ),
    ).toThrow(/cookie 0/);
    const withoutSameSite: Record<string, unknown> = { ...session.cookies[0]! };
    delete withoutSameSite.sameSite;
    expect(() =>
      decodeAmcSession(
        Buffer.from(
          JSON.stringify({
            ...session,
            cookies: [withoutSameSite],
          }),
        ),
      ),
    ).toThrow(/cookie 0/);
  });

  it("rejects raw CDP exports without valid AMC cookies or required fields", () => {
    const cookie = {
      name: "valid",
      value: "one",
      domain: ".amctheatres.com",
      path: "/",
      expires: 1_797_123_456.5,
      httpOnly: true,
      secure: true,
      session: false,
    };

    expect(() =>
      decodeAmcBootstrap(
        Buffer.from(
          JSON.stringify({ cookies: [{ ...cookie, domain: ".example.com" }] }),
        ),
      ),
    ).toThrow(/allowed AMC cookies/);
    expect(() =>
      decodeAmcBootstrap(
        Buffer.from(
          JSON.stringify({ cookies: [{ ...cookie, secure: "true" }] }),
        ),
      ),
    ).toThrow(/cookie 0 drifted/);
    expect(() =>
      decodeAmcBootstrap(
        Buffer.from(
          JSON.stringify({ cookies: [{ ...cookie, expires: "session" }] }),
        ),
      ),
    ).toThrow(/cookie 0 drifted/);
  });

  it("round-trips a strict opaque session and applies only matching live cookies", () => {
    const decoded = decodeAmcSession(encodeAmcSession(session));
    expect(
      cookieHeaderFor(
        decoded,
        "https://www.amctheatres.com/showtimes/900000004/seats",
        1_000,
      ),
    ).toBe("seat=two; root=one");
    expect(
      cookieHeaderFor(decoded, "https://graph.amctheatres.com/", 1_000),
    ).toBe("root=one");
    expect(() => decodeAmcSession(Buffer.from('{"version":2}'))).toThrow(
      /session shape drifted/,
    );
    expect(() =>
      decodeAmcSession(
        Buffer.from(
          JSON.stringify({
            ...session,
            cookies: [
              ...session.cookies,
              {
                ...session.cookies[0],
                name: "foreign",
                domain: ".example.com",
              },
            ],
          }),
        ),
      ),
    ).toThrow(/session shape drifted/);
  });

  it("round-trips a browser-derived fingerprint and re-strips identifying residue", () => {
    const fingerprint = sanitizePeetFingerprint({
      http_version: "h2",
      tls: { ja3: "771,4865,0,29,0", peetprint: "sig" },
      user_agent: "Mozilla/5.0 Chrome/147",
    });
    const withFp = decodeAmcSession(
      encodeAmcSession({ ...session, fingerprint } as AmcSession),
    );
    expect(withFp.fingerprint?.name).toBe(fingerprint.name);
    expect(withFp.fingerprint?.name).toMatch(/^amc-fp-[0-9a-f]{16}$/);
    expect(withFp.fingerprint?.peet.tls).toEqual({
      ja3: "771,4865,0,29,0",
      peetprint: "sig",
    });

    // A tampered record that smuggles identifying fields back in is re-stripped
    // on decode, so the persisted result never carries them.
    const tampered = decodeAmcSession(
      Buffer.from(
        JSON.stringify({
          ...session,
          fingerprint: {
            name: withFp.fingerprint!.name,
            peet: {
              ...fingerprint.peet,
              ip: "203.0.113.7",
              tcpip: { tcp: { window: 1 } },
              tls: {
                ...(fingerprint.peet.tls as Record<string, unknown>),
                client_random: "deadbeef",
              },
            },
          },
        }),
      ),
    );
    const serialized = JSON.stringify(tampered.fingerprint);
    expect(serialized).not.toContain("203.0.113.7");
    expect(serialized).not.toContain("deadbeef");
    expect(serialized).not.toContain("tcpip");
    expect(tampered.fingerprint?.name).toBe(withFp.fingerprint!.name);
  });

  it("drops a malformed persisted fingerprint instead of trusting it", () => {
    const decoded = decodeAmcSession(
      Buffer.from(
        JSON.stringify({ ...session, fingerprint: { name: "x", peet: {} } }),
      ),
    );
    expect(decoded.fingerprint).toBeUndefined();
    expect(decoded.cookies.length).toBeGreaterThan(0);
  });

  it("persists provider Set-Cookie rotation and deletion with exact domain/path matching", () => {
    const rotated = applySetCookieLines(
      session,
      "https://www.amctheatres.com/showtimes/900000004/seats",
      [
        "seat=rotated; Path=/showtimes; Secure; HttpOnly; SameSite=Lax",
        "root=; Max-Age=0; Domain=.amctheatres.com; Path=/; Secure",
        "new_sensor=fresh; Domain=.amctheatres.com; Path=/; Secure",
      ],
      1_000_000,
    );

    expect(
      cookieHeaderFor(
        rotated,
        "https://www.amctheatres.com/showtimes/900000004/seats",
        1_000,
      ),
    ).toBe("seat=rotated; new_sensor=fresh");
    expect(rotated.cookies.some((cookie) => cookie.name === "root")).toBe(
      false,
    );
  });

  it("persists parent-domain and graph-host-only GraphQL cookie rotations", () => {
    const rotated = applySetCookieLines(
      session,
      "https://graph.amctheatres.com/",
      [
        "graph_host=scoped; Path=/; Secure",
        "root=rotated; Domain=.amctheatres.com; Path=/; Secure; HttpOnly",
      ],
      1_000_000,
    );

    expect(
      cookieHeaderFor(rotated, "https://graph.amctheatres.com/", 1_000),
    ).toBe("root=rotated; graph_host=scoped");
    expect(rotated.cookies.some((cookie) => cookie.name === "graph_host")).toBe(
      true,
    );
  });
});
