import { describe, expect, it } from "vitest";
import {
  FingerprintSanitizeError,
  MAX_RAW_FINGERPRINT_BYTES,
  sanitizePeetFingerprint,
} from "../src/client/fingerprint";
import { HelloTransport } from "../src/transport";

// A capture matching the EXACT live tls.peet.ws schema keys that previously
// caused a false rejection: shared_keys (with key-byte values),
// PSK_Key_Exchange_Mode, master_secret_data / extended_master_secret_data,
// plus client_random / session_id and top-level ip/tcpip/donate.
function liveCapture(): Record<string, unknown> {
  return {
    ip: "203.0.113.7:51000",
    donate: "https://tls.peet.ws/donate",
    tcpip: { ip: { ttl: 64 }, tcp: { window: 65535 } },
    http_version: "h2",
    method: "GET",
    tls: {
      ciphers: ["TLS_AES_128_GCM_SHA256", "TLS_AES_256_GCM_SHA384"],
      extensions: [
        { name: "supported_groups (10)", supported_groups: ["X25519 (29)"] },
        {
          name: "application_layer_protocol_negotiation (16)",
          protocols: ["h2", "http/1.1"],
        },
        { name: "supported_versions (43)", versions: ["TLS 1.3", "TLS 1.2"] },
        {
          name: "key_share (51)",
          shared_keys: [
            { "X25519 (29)": "SENTINEL_KEYBYTES_9f8e7d6c5b4a" },
            { "P-256 (23)": "SENTINEL_KEYBYTES_0011223344" },
          ],
        },
        {
          name: "psk_key_exchange_modes (45)",
          PSK_Key_Exchange_Mode: "PSK with (EC)DHE key establishment (1)",
        },
        {
          name: "extended_master_secret (23)",
          master_secret_data: "SENTINEL_MASTER_SECRET_abcdef",
          extended_master_secret_data: "SENTINEL_EXT_MASTER_SECRET_123456",
        },
      ],
      ja3: "771,4865-4866,10-16-43-51-45-23,29,0",
      ja3_hash: "hash3",
      ja4: "t13d1516h2_aaaa_bbbb",
      peetprint: "pp",
      peetprint_hash: "pph",
      client_random: "SENTINEL_CLIENT_RANDOM_deadbeef",
      session_id: "SENTINEL_SESSION_ID_cafebabe",
    },
    http2: {
      akamai_fingerprint: "1:65536,4:6291456|15663105|0|m,a,s,p",
      akamai_fingerprint_hash: "ah",
      sent_frames: [
        {
          frame_type: "SETTINGS",
          settings: [
            "HEADER_TABLE_SIZE = 65536",
            "INITIAL_WINDOW_SIZE = 6291456",
          ],
        },
        { frame_type: "WINDOW_UPDATE", increment: 15663105 },
        {
          frame_type: "HEADERS",
          flags: ["EndStream", "EndHeaders"],
          headers: [
            ":method: GET",
            ":authority: www.amctheatres.com",
            ":scheme: https",
            ":path: /",
            "user-agent: Mozilla/5.0 Chrome/147",
          ],
        },
      ],
    },
    user_agent: "Mozilla/5.0 Chrome/147",
  };
}

// A synthetic peet.ws-shaped capture carrying identifying/ephemeral fields
// that must never persist.
function rawCapture(overrides: Record<string, unknown> = {}) {
  return {
    ip: "203.0.113.7:52344",
    http_version: "h2",
    method: "GET",
    tls: {
      ja3: "771,4865-4866,0-23-65281,29-23,0",
      ja3_hash: "abc123",
      ja4: "t13d1516h2_8daaf6152771_e5627efa2ab1",
      peetprint: "greased-signature",
      ciphers: ["TLS_AES_128_GCM_SHA256"],
      extensions: [
        { name: "server_name (0)" },
        { name: "session_ticket (35)" },
      ],
      client_random: "deadbeefdeadbeefdeadbeefdeadbeef",
      session_id: "cafebabecafebabecafebabecafebabe",
    },
    http2: { akamai_fingerprint: "1:65536;...", sent_frames: [] },
    tcpip: { ip: { ttl: 64 }, tcp: { window: 65535 } },
    donate: "buy me a coffee",
    user_agent: "Mozilla/5.0 (Macintosh) Chrome/147.0.0.0 Safari/537.36",
    ...overrides,
  };
}

describe("sanitizePeetFingerprint", () => {
  it("strips every identifying / ephemeral field and keeps the stable signature", () => {
    const { peet } = sanitizePeetFingerprint(rawCapture());
    const serialized = JSON.stringify(peet);

    // Identifying / ephemeral values are gone.
    expect(peet).not.toHaveProperty("ip");
    expect(peet).not.toHaveProperty("tcpip");
    expect(peet).not.toHaveProperty("donate");
    expect(serialized).not.toContain("203.0.113.7");
    expect(serialized).not.toContain("deadbeef");
    expect(serialized).not.toContain("cafebabe");
    const tls = peet.tls as Record<string, unknown>;
    expect(tls).not.toHaveProperty("client_random");
    expect(tls).not.toHaveProperty("session_id");

    // The stable signature the profile needs is preserved.
    expect(tls.ja3).toBe("771,4865-4866,0-23-65281,29-23,0");
    expect(tls.peetprint).toBe("greased-signature");
    expect(peet.user_agent).toContain("Chrome/147");
    expect(peet.http2).toBeDefined();
  });

  it("derives a stable, non-secret name from the sanitized signature only", () => {
    const a = sanitizePeetFingerprint(rawCapture());
    // A different ephemeral secret must NOT change the derived name.
    const b = sanitizePeetFingerprint(
      rawCapture({
        tls: {
          ...rawCapture().tls,
          client_random: "0".repeat(32),
          session_id: "1".repeat(32),
        },
      }),
    );
    expect(a.name).toBe(b.name);
    expect(a.name).toMatch(/^amc-fp-[0-9a-f]{16}$/);

    // A different IP must NOT change the name either.
    const c = sanitizePeetFingerprint(rawCapture({ ip: "198.51.100.9:1" }));
    expect(c.name).toBe(a.name);
  });

  it("changes the name when the actual signature changes", () => {
    const a = sanitizePeetFingerprint(rawCapture());
    const b = sanitizePeetFingerprint(
      rawCapture({ tls: { ...rawCapture().tls, ja3: "771,1-2,3,4,5" } }),
    );
    expect(a.name).not.toBe(b.name);
  });

  it("rejects a capture without tls or user_agent", () => {
    expect(() => sanitizePeetFingerprint({ user_agent: "x" })).toThrow(
      FingerprintSanitizeError,
    );
    expect(() => sanitizePeetFingerprint({ tls: {} })).toThrow(
      FingerprintSanitizeError,
    );
    expect(() => sanitizePeetFingerprint("not an object")).toThrow(
      FingerprintSanitizeError,
    );
  });

  it("rejects an over-large capture before processing it", () => {
    const huge = rawCapture({ padding: "x".repeat(MAX_RAW_FINGERPRINT_BYTES) });
    expect(() => sanitizePeetFingerprint(huge)).toThrow(
      FingerprintSanitizeError,
    );
  });
});

describe("live tls.peet.ws schema (regression: structural key names retained)", () => {
  it("retains shared_keys group names and PSK_Key_Exchange_Mode while stripping key bytes", () => {
    const { peet } = sanitizePeetFingerprint(liveCapture());
    const serialized = JSON.stringify(peet);

    for (const sentinel of [
      "SENTINEL_KEYBYTES",
      "SENTINEL_MASTER_SECRET",
      "SENTINEL_EXT_MASTER_SECRET",
      "SENTINEL_CLIENT_RANDOM",
      "SENTINEL_SESSION_ID",
      "203.0.113.7",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(serialized).not.toContain("tcpip");
    expect(serialized).not.toContain("master_secret_data");
    expect(serialized).not.toContain("client_random");
    expect(serialized).not.toContain("session_id");

    const extensions = (
      peet.tls as { extensions: Array<Record<string, unknown>> }
    ).extensions;
    const keyShare = extensions.find((e) =>
      String(e.name).startsWith("key_share"),
    )!;
    const shared = keyShare.shared_keys as Array<Record<string, unknown>>;
    // Group names retained, values redacted to empty (fromPeet reads keys only).
    expect(Object.keys(shared[0]!)).toEqual(["X25519 (29)"]);
    expect(Object.values(shared[0]!)).toEqual([""]);
    const psk = extensions.find((e) =>
      String(e.name).startsWith("psk_key_exchange_modes"),
    )!;
    expect(psk.PSK_Key_Exchange_Mode).toContain("(EC)DHE");
  });

  it("sanitizes to material HelloTransport.adoptFingerprint accepts", async () => {
    const fingerprint = sanitizePeetFingerprint(liveCapture());
    const transport = new HelloTransport();
    expect(await transport.adoptFingerprint(fingerprint)).toBe(true);
    expect(transport.profile).toBe(fingerprint.name);
  });
});
