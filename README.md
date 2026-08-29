# Open AMC (`open-amc`)

Give Open AMC to Hermes, OpenClaw, or another capable agent and it gains AMC
showtime, seat, cart, checkout, and refund abilities. Ask for a movie and seats;
your agent can inspect live availability, hold an exact cart, and either hand
you AMC's checkout link or complete checkout using your configured payment
capability.

Underneath, Open AMC is a typed TypeScript library with a machine-readable `amc`
CLI, built for agents to operate reliably without hidden context.

> **Unofficial.** This project is not affiliated with, endorsed by, or sponsored
> by AMC Entertainment. "AMC" and related names are trademarks of their
> respective owners. No AMC logos or assets are included. You are responsible for
> using this software in accordance with AMC's terms of service and applicable
> law.

## Install

```bash
git clone https://github.com/ashah360/open-amc.git
cd open-amc
npm install
```

`npm install` builds the CLI automatically. Node 22+ is required. The default transport uses the public
[`@unreleased/hellojs`](https://www.npmjs.com/package/@unreleased/hellojs) TLS
client; `undici` is bundled as an explicit alternative.

## Library usage (recommended)

```ts
import {
  createAmcClient,
  resolveOfficialAmcTheaterUrl,
} from "@ashah360/open-amc";

const client = createAmcClient(); // public HelloJS transport, GraphQL-first reads

try {
  // Any official AMC theater URL works; this is just one example theater.
  const theater = resolveOfficialAmcTheaterUrl(
    "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes",
  );
  const showtimes = await client.showtimes.list({
    venue: theater,
    date: "2030-01-15",
  });

  const layout = await client.inventory.get(showtimes[0]!.id);
  const batch = await client.inventory.getBatch([showtimes[0]!.id]);

  const status = await client.auth.status();
} finally {
  await client.close(); // release pooled sockets
}
```

### API shape

The client is organized into small namespaces:

- `client.showtimes.list(query)`
- `client.inventory.get(showtimeId)` / `client.inventory.getBatch(ids)`
- `client.auth.status()` / `bootstrap(bundle)` / `clear()` / `repair()`
- `client.orders.createCart(intent)` / `get({ orderToken, email })` /
  `extendExpiration({ orderToken })` / `release(orderToken)`
- `client.checkout.preview(...)` / `submit(...)` / `reconcile(...)`
- `client.refunds.preview(...)` / `submit(...)` / `reconcile(...)`
- `client.close()`

Domain types and every typed error are exported from the package root. Advanced
building blocks live under subpath exports:

- `@ashah360/open-amc/transport` — `Transport` contract, `HelloTransport`,
  `NativeTransport`.
- `@ashah360/open-amc/capabilities/browser` — browser session-repair and
  browser-commerce contracts and the built-in Aside adapters (kept as
  compatibility aliases).
- `@ashah360/open-amc/playwright` — the **portable, concrete Playwright
  browser capability** (recommended): `PlaywrightAmcBrowserRefresher`,
  `PlaywrightFraudNetDeviceDataProvider`, and the `PlaywrightBrowserRuntime`
  connection abstraction. See [Playwright browser capability](#playwright-browser-capability).
- `@ashah360/open-amc/capabilities/payment` — Braintree tokenization, Kount /
  FraudNet, and checkout-readiness building blocks.
- `@ashah360/open-amc/recovery` — the optional durable operation store.

## Configuration and capabilities

`createAmcClient(config?)` takes only explicit seams; nothing browser-, card-,
proxy-, or identity-related is ever wired implicitly.

```ts
const client = createAmcClient({
  // Transport: default HelloJS, or inject your own / configure profile+proxy.
  hello: { profile: "amc-browser", proxyUrl: "http://127.0.0.1:8080" },
  // transport: new NativeTransport(),

  // Session jar persistence. Defaults to an in-memory store, so an imported
  // client writes NO hidden filesystem state. Pass a FileSessionStore explicitly
  // for durable, cross-process persistence (the `amc` CLI does this).
  // store: new FileSessionStore({ root: "/path/to/private/runtime" }),

  // Explicit browser session-repair capability (see below). None by default.
  // browserRepair,

  // Explicit checkout capabilities. Direct GraphQL cart/order/refund work with
  // none of these; payment fulfillment requires a card provider.
  checkout: {
    // cardProvider,      // you supply card material behind an ephemeral lease
    // challengeHandler,  // interactive 3DS / hosted-frame payment handler
    // recovery,          // optional durable operation store for crash recovery
  },
});
```

### Direct-only defaults and browser escalation

Routine reads, order lookups, and expiration extension are **direct-only** — and
they stay direct-only even when a browser capability is configured. When AMC
serves a real waiting-room / Cloudflare challenge that bounded direct Queue-it
admission cannot clear, automatic repair throws a typed
`AmcSessionRepairRequiredError` instead of autonomously opening a browser tab.

Only the explicit `client.auth.repair()` operation is allowed to escalate
direct → browser, and only when you injected a `browserRepair` capability.
Browser session repair may only acquire/validate/export AMC-scoped session state
— it never executes or retries a commerce write. Browser payment / hosted-frame
/ 3DS is a separate, always explicit capability; interactive 3DS surfaces a typed
user-action-required result.

Explicit browser repair additionally self-aligns the direct transport
fingerprint so the plain HelloJS reads and commerce writes match the browser
that cleared admission. After semantic admission it reads the browser's own
TLS/H2/header signature from the fixed endpoint `https://tls.peet.ws/api/all`
through that browser's egress, immediately strips every identifying/ephemeral
field (client IP, tcp/ip stack, TLS `client_random`/`session_id`/key bytes),
and persists only the minimal signature in the private (mode-0600) session
record under a stable hash-derived name. A later CLI process adopts it
automatically before its first request — no manual Peet capture and no
`AMC_HELLO_PROFILE_PATH`. Ordinary reads never contact that endpoint. Setting
`AMC_HELLO_PROFILE_PATH` remains an advanced manual override and always wins
over the auto-aligned fingerprint.

### Playwright browser capability

Chromium is an explicit, optional capability used for exactly two things:
(a) collecting real Braintree FraudNet `deviceData`, and (b) optional AMC
session/admission repair. AMC reads and checkout stay raw API calls over
HelloJS/TLS — the browser never drives OrderFulfill.

The package ships **one coherent Playwright adapter** built on `playwright-core`,
so there is no duplicate Chrome/Playwright stack. `playwright-core` does **not**
bundle or download a browser; it drives whatever Chromium/Chrome you point it at.
Browser dependencies are optional peer dependencies: `npm install
@ashah360/open-amc` never installs Playwright and **never downloads Chromium via
a postinstall hook**. If you import `@ashah360/open-amc/playwright` without the
optional dependency (or browser), the first launch/connect throws a single typed
`PlaywrightSetupError` telling you exactly what to install.

The `PlaywrightBrowserRuntime` supports four connection shapes:

```ts
import {
  PlaywrightBrowserRuntime,
  PlaywrightAmcBrowserRefresher,
  PlaywrightFraudNetDeviceDataProvider,
} from "@ashah360/open-amc/playwright";

// (1) Playwright-managed Chromium, installed explicitly (no postinstall):
//     npm install playwright-core && npx playwright install chromium
const managed = new PlaywrightBrowserRuntime({ kind: "launch", headless: true });

// (2) An already-installed Chrome, by channel or executable path (no download).
const installedChrome = new PlaywrightBrowserRuntime({
  kind: "launch",
  channel: "chrome",
});

// (3) An existing Chrome you started with --remote-debugging-port, over CDP.
//     Cleanup disconnects this Playwright connection; your Chrome keeps running.
const overCdp = new PlaywrightBrowserRuntime({
  kind: "cdp",
  endpointURL: "http://127.0.0.1:9222",
});

// (4) A caller-owned Playwright Browser or BrowserContext (never closed for you).
// const reused = new PlaywrightBrowserRuntime({ kind: "context", context });

const browserRepair = new PlaywrightAmcBrowserRefresher({ runtime: managed });
```

`PlaywrightAmcBrowserRefresher` navigates an allowlisted AMC listing URL, proves
semantic admission, exports **only** AMC / AMC-GraphQL scoped cookies, and closes
only the pages/contexts/browsers it created — a caller-owned context is left
open. `PlaywrightFraudNetDeviceDataProvider` takes the short-lived Braintree
client-token authorization plus the fresh per-attempt fraud session id (passed to
`braintree.dataCollector.create` as `riskCorrelationId`), loads the pinned
`braintree-web` (exactly `3.144.0`) `client` + `data-collector` bundles from the
optional `braintree-web` dependency, runs `braintree.client.create` +
`braintree.dataCollector.create`, validates the returned correlation is bound to
that attempt (Braintree may truncate it to 32 characters), tears the collector
down, and returns only `{ deviceData, fresh, diagnostic }`. Neither surfaces the
authorization, cookies, request bodies, raw provider errors, card data, or URLs
through results, errors, or logs. Both honor a timeout budget and an `AbortSignal`
that also covers browser acquisition.

The built-in Aside adapters under `@ashah360/open-amc/capabilities/browser`
remain available as compatibility aliases; new integrations should prefer the
portable Playwright adapter.

### Ambiguous writes and reconciliation

Consequential mutations (cart creation, checkout fulfillment, refunds) are
dispatched **at most once**. On an ambiguous transport failure the client does a
bounded, same-process authoritative read to determine the true outcome. If it
still cannot, it throws a typed `CartCreationOutcomeUnknownError`,
`CheckoutOutcomeUnknownError`, or `RefundOutcomeUnknownError` carrying only safe
reconciliation context (order token, order number, showtime, seat names, line
numbers) — never card, session, or device material. Writes are never blindly
retried.

`orders.release` is likewise stateless and needs no journal: it dispatches
OrderDelete at most once and, on an ambiguous response, performs a bounded
authoritative read of the order's state, returning released only when the
provider proves it cancelled/expired and otherwise throwing a typed
`ReleaseOutcomeUnknownError`.

Imported client calls never create workflow files or require durable
persistence. To resume across processes/crashes with your own Postgres, Temporal,
or SQLite state, use the explicit reconcile methods, or opt into the durable
operation store from `@ashah360/open-amc/recovery`.

## CLI usage

The `amc` CLI is a thin adapter over the public client. It never accepts raw card
values; payment and browser capabilities are injected via an explicit capability
module (`AMC_CAPABILITY_MODULE`): a CommonJS module exporting a no-argument
`createAmcCapabilities()` factory (typed as `CreateAmcCapabilities` in
`@ashah360/open-amc/cli`). See `.env.example` for a synthetic example.

```text
amc doctor
amc auth status | clear | bootstrap --from <file|-> | repair [--listing-url <url>] [--browser-channel c] [--browser-executable p] [--cdp-url u]
amc theater resolve --url <official amctheatres.com theater URL>
amc showtimes --theater-url <official AMC theater URL> --date YYYY-MM-DD [--movie TEXT] [--format TEXT]
amc seats <showtime-id...> [--available-only]
amc order get --token <t> --email <e>
amc order extend --token <t>
amc order release --token <t>
amc cart create --showtime <id> --seat <name...> [--adult N]   # e.g. --seat A2 A3; output includes checkoutUrl
amc buy --showtime <id> --seat <name...>                       # quote only; --confirm is retired
amc checkout preview --token <t> [--email <e>]
amc checkout submit --token <t> [--email <e>] [--vault p]
amc checkout reconcile --token <t> [--email <e>]
amc refund preview --confirmation <n> [--email <e>] [--lines a,b]
amc refund submit  --confirmation <n> [--email <e>] [--lines a,b]
```

`--email` and `--vault` fall back to one-time configured capability defaults
(`defaultReceiptEmail`, `defaultVaultPointer`), so a configured agent can
check out with just `amc checkout submit --token <orderToken>`.

Agent-facing workflow documentation lives in `AGENTS.md` and
`skills/open-amc/SKILL.md`; a synthetic capability-module template is at
`templates/amc-capabilities.template.cjs`.

Add `--json` to any non-help command invocation for machine-readable output
(help/usage output is plain text and exempt from the JSON envelope). See
`.env.example` for optional configuration.

### JSON output contract

With `--json` (accepted before or after the subcommand), every command
invocation prints exactly one JSON object to stdout. Explicitly requested
informational exits — `--help`/`help`-style output — are exempt: they keep
their human-readable text and exit `0` even when `--json` is present.
Otherwise:

- **Success** (exit `0`): the command's result object, as today.
- **Any failure** (nonzero exit) — including missing/invalid options, unknown
  subcommands, validation errors, and runtime failures — a stable error
  envelope with no interleaved plain text:

```json
{ "error": { "code": "AMC_WRITE_OUTCOME_UNKNOWN", "message": "…" } }
```

`code` is the typed error's stable code, `AMC_USAGE` for parse/usage failures,
or `AMC_ERROR` when no code exists. For typed unknown-outcome errors the
envelope additionally carries `operation` (`cart` | `checkout` | `refund` |
`release`) and a `reconciliation` object restricted to the allowlisted safe
identifiers (`orderToken`, `orderNumber`, `showtimeId`, `seatNames`,
`lineNumbers`) so an agent can resume reconciliation. The error's public
`message` string is serialized verbatim; beyond that, no additional error
fields or properties are ever serialized — no stacks, causes, responses,
headers, cookies, request bodies, or other raw provider error material.

This is additive to the previous `{ "error": { "code", "message" } }` shape;
existing consumers keep working. Without `--json`, help and error text remain
human-readable (errors on stderr).

## Development

```bash
npm run format:check
npm run lint
npm run typecheck
npm run privacy:audit
npm test
npm run build
npm run pack:smoke   # packs, installs, and smoke-tests import + `amc --help`
```

Tests use only synthetic IDs, orders, sessions, and generated payloads. No live
provider requests or paid writes run in CI.

## License

MIT. See [LICENSE](./LICENSE).
