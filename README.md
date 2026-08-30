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

## Give this to your agent

Three routes; any one is enough. Human checkout handoff is turnkey — agent-paid
checkout stays an optional capability you must supply yourself (a card vault is
never zero-config).

**A. Paste the repo URL with a prompt.** Your agent clones, installs, and reads
the root `AGENTS.md`/`SKILL.md`:

> Install https://github.com/ashah360/open-amc.git (tag v0.1.5, run
> `bash install.sh --agent auto`), then run
> `amc setup --theater-url "<official AMC theater URL>" --json`. After setup,
> find showtimes and hold my seats, then give me the checkout URL privately.

**B. One installer (Hermes and OpenClaw).** Auditable clone-then-run:

```bash
git clone --branch v0.1.5 --depth 1 https://github.com/ashah360/open-amc.git
bash open-amc/install.sh --agent hermes   # or: --agent openclaw | auto
```

or, as a convenience one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/ashah360/open-amc/v0.1.5/install.sh | bash -s -- --agent hermes
```

It pins v0.1.5 into `~/.open-amc/app` (override `OPEN_AMC_HOME`), installs the
exact lock-pinned `playwright-core` into that private checkout so `amc setup` /
`amc auth repair --listing-url ...` work out of the box (no browser download; an
installed Chrome/Chromium remains the prerequisite; nothing global), links
`~/.local/bin/amc` (override `BIN_DIR`), verifies `amc doctor --json`, and
installs the skill through the platform's native mechanism (Hermes: pinned raw
`SKILL.md` URL, noninteractive with `--yes` — start a new Hermes session
afterward; OpenClaw: the local checkout root with `--global --as open-amc`),
then verifies the skill is registered before reporting success. Rerunning
safely updates the same install.

Installing the skill manually later:

```bash
hermes skills install https://raw.githubusercontent.com/ashah360/open-amc/v0.1.5/SKILL.md --yes   # then start a new Hermes session
openclaw skills install <path-to-open-amc-checkout> --global --as open-amc
```

**C. One explicit setup, then talk normally.**

```bash
amc setup --theater-url "https://www.amctheatres.com/movie-theatres/<market>/<amc-...>/showtimes" --json
```

Then: "find IMAX showtimes tomorrow at my theater, hold E7 and E8, and send me
the checkout link."

> **Requirements.** Node.js >= 22; a real installed Chrome/Chromium (setup opens
> a VISIBLE Chrome once — headless is best-effort and often blocked); trusted
> residential-grade egress. This package is installed from Git, not npm.

## Install (manual)

```bash
git clone https://github.com/ashah360/open-amc.git
cd open-amc
npm install
```

`npm install` builds the CLI automatically. Node 22+ is required. The default transport uses the public
[`@unreleased/hellojs`](https://www.npmjs.com/package/@unreleased/hellojs) TLS
client; `undici` is bundled as an explicit alternative.

If you install the packaged tarball directly (rather than the checkout above,
whose dev install already includes it), setup and browser-backed auth repair
additionally need the optional peer:

```bash
npm install playwright-core   # required for `amc setup` / `amc auth repair --listing-url ...`
```

Without it those commands fail closed with `AMC_PLAYWRIGHT_SETUP_REQUIRED`.
`braintree-web` stays optional and is only needed if you explicitly configure
the agent-paid checkout capability (see
`templates/amc-capabilities.template.cjs`).

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

### Read reliability vs. write safety

Ordinary reads and the auth canary each perform **exactly one** bounded,
same-session retry past a transient direct-egress hiccup (an HTTP 429/5xx, a
200 whose body is an interstitial, or a TLS/socket error such as `EPROTO`),
which self-heals in practice. This is not a generic retry loop: it is single,
transient-classified, same-session, and never launches a browser. Consequential
**writes** (cart creation, checkout fulfillment, refunds) remain fail-closed,
with a bounded recovery only for outcomes that are provably NOT executed —
never more than two mutation dispatches total:

- A COMPLETE HTTP 429 (explicit rate-limit rejection) is redispatched exactly
  once in the same session; a persistent 429 surfaces as the typed
  `AMC_WRITE_RATE_LIMITED`.
- A COMPLETE anti-bot challenge (a Queue-it / legacy Cloudflare interstitial
  the edge blocked before the origin mutation) triggers exactly one bounded
  **direct** session re-admission — never a browser — followed by one
  redispatch; a persistent challenge surfaces as the typed
  `AMC_WRITE_CHALLENGED`, and if re-admission needs a browser it stops with
  `AMC_SESSION_REPAIR_REQUIRED` (zero redispatch).
- A COMPLETE **Cloudflare CAPTCHA** write response (HTML, Cloudflare-fronted,
  with a CAPTCHA/challenge body marker) is an interactive human boundary that
  immediate re-admission cannot clear. Cloudflare write reputation is
  egress/session-pair state, so retrying only burns another attempt. The first
  such response trips a persistent per-session **write-challenge circuit
  breaker** (a tiny `{observedAt, retryAt}` record in the session store): it
  does NOT redispatch and fails typed `AMC_WRITE_CHALLENGE_COOLDOWN` with a safe
  `retryAt` (default 30 minutes). While active, every write fails fast with that
  code and zero provider mutation; **reads stay available**. The breaker lifts
  lazily at `retryAt` (allowing one probe — another CAPTCHA re-arms it), or
  immediately after a successful explicit `amc auth repair` on a fresh
  egress/session, or on `amc auth clear`.
- A complete non-challenge **4xx** (e.g. `AMC_HTTP` 400/403) is a definite
  rejection: typed, one dispatch, not auto-retried.

Those cases are definite (nothing executed) and safe to rerun. A complete
**5xx** is different — it does not prove non-execution (the origin may have
mutated then failed), so it is treated like a transport error with **no
complete HTTP response**: genuinely ambiguous, one dispatch, never retried, and
surfaced as `AMC_WRITE_OUTCOME_UNKNOWN` (reconcile-only).

### Cross-process admission context

A successful `amc setup` (or `showtimes --theater-url`) persists the validated
canonical theater listing URL as non-secret context on the session. A later
separate process — e.g. `amc seats <id>` or a cart preflight, which carry no
theater URL — restores it so a challenged session can perform bounded **direct**
re-admission for that theater without demanding a fresh setup. This never
launches a browser implicitly; if direct admission genuinely needs one, the CLI
returns the actionable `AMC_SESSION_REPAIR_REQUIRED` telling you to run `amc
setup`. A legacy session without this context behaves as before.

### Ambiguous writes and reconciliation

Consequential mutations (cart creation, checkout fulfillment, refunds) are
dispatched **at most once**. On an ambiguous transport failure the client does a
bounded, same-process authoritative read to determine the true outcome. If it
still cannot, it throws a typed `CartCreationOutcomeUnknownError`,
`CheckoutOutcomeUnknownError`, or `RefundOutcomeUnknownError` carrying only safe
reconciliation context (order token, order number, showtime, seat names, line
numbers) — never card, session, or device material. Writes are never blindly
retried.

`orders.release` is likewise stateless when no recovery is wired: it dispatches
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
amc setup --theater-url <official AMC theater URL> [--browser-channel c] [--browser-executable p] [--cdp-url u] [--headless] [--date YYYY-MM-DD]
amc doctor
amc auth status | clear | bootstrap --from <file|-> | repair [--listing-url <url>] [--browser-channel c] [--browser-executable p] [--cdp-url u] [--headless]
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

### Cart recovery (durable by default in the CLI)

The `amc` CLI keeps two tiny durable stores under the same session store: an
**immutable cart-intent store** (the order token → original intent, written the
instant a token is received) and an **uncertainty ledger** (one marker per
outstanding write). There is no lifecycle state machine — the AMC order
projection is the sole source of truth for what a cart/order currently is, and
these stores only carry identity and outstanding uncertainty. This is what lets
a cart hold whose token was received survive across separate CLI processes. A
capability module's `recovery` bundle overrides the default; the library
`createAmcClient()` stays stateless unless you opt in. If `cart create` fails
after the provider returned a token (the hold exists but its details could not
be confirmed), the error is `AMC_CART_HOLD_UNCONFIRMED` with
`reconciliation.orderToken` — release it with
`amc order release --token <orderToken>` (or `amc checkout reconcile`); never
create another cart. After an ambiguous fulfillment, `amc checkout reconcile`
returns the confirmed purchase once the provider shows it, reports a typed
settling/unknown outcome while the bounded settle window is still open (never a
misleading "not purchased"), and otherwise reports no purchase while the cart
stays open for release or resubmit. `amc doctor` reports whether recovery is
available.

### Session storage and session repair

The CLI persists the AMC session jar in a private (mode-0600) file. By default
it lives under your OS home directory; set `AMC_SESSION_ROOT` to an absolute
path to store it elsewhere (e.g. a dedicated per-agent runtime directory). The
value is a path only — no secrets — and `amc doctor --json` reports just whether
it is configured, never its value.

Session repair is explicit and bounded. `amc auth repair --listing-url <official
AMC theater URL> [--browser-channel chrome | --browser-executable <path> |
--cdp-url <url>] [--headless]` runs exactly one repair: it clears admission in
the browser, waits for the anti-bot layer to settle (a browser-side GraphQL
AccessCheck), then exports cookies and validates them with a direct canary
before persisting. It is **one bounded operation, not a retry loop.**

A launched browser opens **visible/headful by default**, which clears AMC's
anti-bot layer far more reliably than headless; `--headless` is available for
advanced/server use but is best-effort and often blocked. `--cdp-url` attaches
to a Chrome you started yourself, so its headless/headful mode is your choice.
If repair returns `AMC_SESSION_REPAIR_REQUIRED` (stage
`browser-trust`/`post-repair-canary`), the browser or egress could not clear
AMC's anti-bot layer — use an ordinary, non-headless Chrome profile you already
use on amctheatres.com, or a different egress/proxy, rather than repeating the
command.

A launched repair browser runs on the **same egress as the CLI's direct
transport**: when `AMC_PROXY_URL` is set, `amc auth repair`/`amc setup` pass
that proxy (http/https/socks, with percent-encoded credentials supported for
http/https) to the launched Chrome, so the session it exports was actually
established through the CLI's configured egress. Proxy credentials never appear
in argv, logs, or error output. If Cloudflare presents a SIMPLE Turnstile
checkbox during repair, the repair clicks it itself — at most once, and only
inside Cloudflare's own challenge frame (never an ordinary page checkbox). A
visual/image/puzzle challenge is a human boundary: complete it by hand in the
visible window. Either way a click is never success proof — repair keeps
waiting and exports only after a browser-side Graph AccessCheck succeeds from
that same context, and a successful explicit repair also lifts the Cloudflare
write cooldown for one probe write. Not every challenge is solvable; a
challenge that never settles still fails typed within the bounded budget. Combining `--cdp-url` with `AMC_PROXY_URL`
fails closed with `AMC_CLI_SETUP`: the egress of a Chrome this CLI did not
launch cannot be verified, so launch the repair browser instead, or unset
`AMC_PROXY_URL` only if that Chrome genuinely shares the CLI's default egress.

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
