# Agent guide: open-amc

Typed, single-operation AMC showtime/seat/cart/checkout/refund client with a
thin `amc` CLI. Unofficial; not affiliated with AMC. Every command is one
bounded operation: **no watchers, no polling loops, no remediation daemons, no
proxy fleets, and no cart warmers ship in this repository.** Callers may
compose their own applications responsibly on top of the public primitives
(this repo intentionally enables that): keep one fenced commerce writer,
respect provider limits, and never blind-retry writes.

## Install (public Git; pinned installer preferred)

```bash
git clone --branch v0.1.4 --depth 1 https://github.com/ashah360/open-amc.git
bash open-amc/install.sh --agent auto   # installs ~/.local/bin/amc + the skill
```

(Manual alternative: `git clone https://github.com/ashah360/open-amc.git && cd
open-amc && npm install`, then run `node dist/cli.js ...` or `npm link`.)
Requires Node >= 22 and, for setup/repair, a real installed Chrome. Then one
explicit setup (opens a visible Chrome once), and verify readiness:

```bash
amc setup --theater-url "<official AMC theater URL>" --json
amc doctor --json
```

## Ground rules (non-negotiable)

- Reads are safe; **writes are explicit**. Cart creation, checkout submit,
  release, and refund submit are the only provider writes.
- **No payment without the human's explicit go-ahead.** Show the human the
  exact seats and total from `checkout preview` and proceed only after they
  approve in your conversation; the CLI does not (and cannot) enforce that
  conversation. `checkout submit` re-reads the exact cart named by `--token`
  at submit time, and the service fails closed unless it is the same open,
  unexpired cart.
- **Never retry a failed write blindly.** On `AMC_WRITE_OUTCOME_UNKNOWN` (a
  transport failure with no complete HTTP response — bytes may have left), run
  the matching `reconcile` command; the JSON error carries the safe
  reconciliation identifiers (order token, order number, seats). Built-in
  recovery handles the two cases that are provably NOT executed, each with a
  single bounded redispatch and no action from you: a COMPLETE HTTP 429 is
  redispatched once in the same session (persistent → typed
  `AMC_WRITE_RATE_LIMITED`), and a COMPLETE anti-bot challenge (the edge
  rejected the request before the mutation ran) triggers exactly one bounded
  **direct** session re-admission — never a browser — then one redispatch
  (persistent → typed `AMC_WRITE_CHALLENGED`; if re-admission needs a browser
  it stops with `AMC_SESSION_REPAIR_REQUIRED`). Those typed codes are definite
  failures safe to rerun later — not unknown outcomes. A complete non-challenge
  **4xx** (e.g. `AMC_HTTP` 400/403) is likewise a definite rejection, not
  auto-retried. A complete **5xx**, however, is NOT proof of non-execution (the
  origin may have mutated then failed): it stays `AMC_WRITE_OUTCOME_UNKNOWN`
  (reconcile-only), exactly like a transport error with no complete response.
- **A cart hold is never stranded.** The CLI keeps a private immutable
  cart-intent store (order token → original intent) plus a small uncertainty
  ledger (one marker per outstanding write); there is no lifecycle state
  machine — the AMC order projection is the sole truth. If `cart create` fails
  after the provider issued a token, the error is `AMC_CART_HOLD_UNCONFIRMED`
  with `reconciliation.orderToken` — the cart EXISTS. Release it with
  `amc order release --token <orderToken>` (or reconcile); do **not** create
  another cart. After an ambiguous fulfillment, `amc checkout reconcile`
  returns the confirmed purchase once the provider shows it, reports a typed
  settling/unknown outcome while the bounded settle window is still open (never
  a misleading "not purchased"), and otherwise reports no purchase while the
  cart stays open for release or resubmit.
- **Stop on 3DS / user-action-required.** Interactive payment challenges are a
  human boundary; report and stop.
- The `checkoutUrl` returned by `cart create` is **bearer-like**: anyone
  holding it can act on the cart. Hand it only to the buying human. Never post
  it anywhere public and never log it.
- Ordinary reads never open a browser. Only the explicit `amc auth repair`
  command can escalate to one — either via `--listing-url` (built-in
  Playwright wiring) or via a deliberately configured `browserRepair`
  capability module. When the bounded direct Queue-it admission phase cannot
  establish a usable session — an interactive challenge, a typed admission
  failure, or a TLS/network block of those admission requests — it fails with
  the stable code `AMC_SESSION_REPAIR_REQUIRED`, the only auth-repair trigger.
  Outside that admission phase the guarantee does not hold: a raw transport/TLS
  error (e.g. `EPROTO`) can still surface directly from a read, and any error
  after a validated session keeps its own typed/raw code. Treat a bare
  transport error on a read the same way — re-run once, then run `amc auth
  repair` — but do not assume every such error is pre-mapped.
- A successful `amc setup`/`showtimes --theater-url` persists the validated
  canonical theater URL on the session, so a later `seats`/cart process (which
  has no theater URL) can perform bounded direct re-admission for that theater.
  This never launches a browser implicitly; a genuine browser-required
  admission still returns `AMC_SESSION_REPAIR_REQUIRED` telling the user to run
  `amc setup`.

## The two purchase paths (both start with one cart)

```bash
# 0) Resolve the official theater URL the user gave you (any AMC theater;
#    there is no built-in venue default anywhere):
amc theater resolve --url "https://www.amctheatres.com/movie-theatres/<market>/<amc-...>/showtimes" --json

# 1) Find a showtime and seats:
amc showtimes --theater-url "<official url>" --date 2030-01-15 --json
amc seats <showtime-id> --available-only --json

# 2) Create EXACTLY ONE cart (the only cart write on either path);
#    the variadic --seat takes all seat names after one flag:
amc cart create --showtime <id> --seat A2 A3 --json
#    -> { orderToken, seats, total, expiresAt, checkoutUrl }
```

**Path A — human handoff (default):** stop here. Give the human the
`checkoutUrl`; they pay on amctheatres.com themselves.

**Path B — agent self-checkout (only after the human explicitly approves the
exact total):** consume the SAME `orderToken`; never create a second cart.

```bash
amc checkout preview --token <orderToken> --email <email> --json
#    -> exact seats/total/expiry
# ... show the human the exact seats and total; get their explicit "yes" ...
amc checkout submit --token <orderToken> --email <email> \
  [--vault <vault-pointer>] --json
```

`--email` and `--vault` fall back to one-time configured capability defaults
(`defaultReceiptEmail`, `defaultVaultPointer`); with both configured,
`amc checkout submit --token <orderToken> --json` is sufficient.

`checkout submit` freshly re-reads the same cart and submits exactly that
cart; the service fails closed before any payment unless the cart is still
open and unexpired. Payment additionally requires a capability module (see
`templates/amc-capabilities.template.cjs`) — payment is optional and is
**not** turnkey until you implement a real secret-manager-backed
CardProvider.

Cleanup and recovery:

```bash
amc order release --token <orderToken>          # explicit cart release
amc checkout reconcile --token <t> --email <e>  # after an unknown checkout outcome
amc refund preview|submit|reconcile ...         # refunds use the same preview-then-submit discipline
```

The old `amc buy --confirm` one-shot is retired and fails closed; `amc buy`
still quotes without writing.

## Auth repair (explicit only)

```bash
amc auth status --json
amc auth repair --json                          # bounded direct repair only
amc auth repair --listing-url "<official theater url>" \
  --browser-channel chrome --json               # built-in Playwright repair
```

Browser repair needs the optional `playwright-core` dependency and an
installed Chrome/Chromium you select (`--browser-channel`,
`--browser-executable`, or `--cdp-url`); nothing is downloaded implicitly.
Success is only reported after the direct read canary validates the exported
session. Retry policy: repair once, re-run the failed read once, then stop and
report.

A launched browser (`--browser-channel`/`--browser-executable`) opens
**visible/headful** by default, which clears AMC's anti-bot layer far more
reliably than headless. `--headless` is available for advanced/server use but is
best-effort and is often blocked; on a `browser-trust` failure the guidance
below applies. `--cdp-url` connects to a Chrome you already launched, so the
headless/headful choice is yours.

Browser repair is one bounded operation: after the listing renders it runs a
harmless browser-side GraphQL AccessCheck and waits (up to ~40s) for the
anti-bot layer (Cloudflare jsd) to settle before exporting cookies, so a
premature 200 listing never yields a broken session. If the browser can't
establish trust, or the post-export direct canary is still challenged/blocked,
repair fails with `AMC_SESSION_REPAIR_REQUIRED` (stage `browser-trust` or
`post-repair-canary`) — never a raw `AMC_CHALLENGE`. The fix is to use an
ordinary, non-headless Chrome profile you already use on amctheatres.com, or a
different egress/proxy; do **not** loop `amc auth repair`, which just re-hits
the same wall.

Explicit browser repair also self-aligns the direct transport fingerprint:
after admission it reads the browser's own TLS/H2/header signature from the
fixed endpoint `https://tls.peet.ws/api/all` through that same browser, strips
every identifying/ephemeral field (IP, tcp/ip, TLS client_random/session_id/key
bytes), and persists only the minimal signature in the private session record.
A later CLI process then adopts it automatically — no manual Peet capture and no
`AMC_HELLO_PROFILE_PATH` needed. Ordinary reads never contact that endpoint or
launch a browser. `AMC_HELLO_PROFILE_PATH` remains an advanced manual override
that, when set, always wins over the auto-aligned fingerprint.

## More

- Portable agent skill: `skills/open-amc/SKILL.md`.
- Library API and JSON error envelope: `README.md`.
- Capability module template: `templates/amc-capabilities.template.cjs`.

## Maintainer note (public launch)

This repository is a clean single-snapshot import authored under the GitHub
noreply address; reachable history carries no personal author emails. Any
future history rewrite or repository visibility change remains an **owner
decision**; nothing in this repository rewrites history.
