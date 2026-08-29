---
name: open-amc
description: Buy AMC movie tickets safely with the amc CLI.
version: 1.0.1
author: Arman (ashah360), Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [amc, tickets, showtimes, cli, commerce]
    related_skills: []
---

# AMC ticket operations with the `amc` CLI

Operate the unofficial `amc` CLI (from the open-amc repository) to resolve
an official AMC theater, list showtimes, inspect seats, hold seats in exactly
one cart, and either hand the human a first-party checkout URL or complete
checkout of that same cart after the human approves the exact total.

## Install and readiness (do this first)

Source of truth: https://github.com/ashah360/open-amc.git, pinned release tag
`v0.1.2`. To update later, rerun the same installer (it safely updates the same
checkout and symlink).

1. In your terminal tool, check whether the CLI already exists:
   `command -v amc && amc doctor --json`. If `doctor` reports ready, skip to
   setup or straight to reads.
2. If `amc` is missing, install it (Node.js >= 22 required). Either run the
   pinned installer from a clone (auditable):
   `git clone --branch v0.1.2 --depth 1 https://github.com/ashah360/open-amc.git
   && bash open-amc/install.sh --agent auto`
   or the documented one-liner:
   `curl -fsSL https://raw.githubusercontent.com/ashah360/open-amc/v0.1.2/install.sh | bash -s -- --agent auto`.
   The installer puts `amc` at `~/.local/bin/amc`; ensure that is on PATH.
3. One explicit setup (opens a visible installed Chrome once; needs a real
   Chrome and trusted egress):
   `amc setup --theater-url "<official theater URL from the user>" --json`.
   Success returns `{"kind":"setup","cli":"ready","auth":"valid",...}` with a
   `nextCommand`. On failure follow the error's guidance; do not loop setup.
4. Payment (agent self-checkout only) stays an explicitly optional,
   user-supplied capability: a secret-manager-backed CardProvider module (copy
   `templates/amc-capabilities.template.cjs`), exported via
   `AMC_CAPABILITY_MODULE`. Without it, stop after the checkout URL handoff —
   human checkout handoff is fully supported with zero payment config.

## Quick reference

| Step | Command |
| --- | --- |
| One-time setup | `amc setup --theater-url "<official URL>" --json` |
| Readiness | `amc doctor --json` |
| Resolve theater | `amc theater resolve --url "<official URL>" --json` |
| Showtimes | `amc showtimes --theater-url "<official URL>" --date YYYY-MM-DD --json` |
| Seats | `amc seats <showtime-id> --available-only --json` |
| Repair session | `amc auth repair --listing-url "<official URL>" --browser-channel chrome --json` |
| Create the one cart | `amc cart create --showtime <id> --seat <name...> --json` |
| Preview existing cart | `amc checkout preview --token <orderToken> --email <email> --json` |
| Submit same cart | `amc checkout submit --token <orderToken> [--email <email>] [--vault <pointer>] --json` (`--email`/`--vault` default to configured `defaultReceiptEmail`/`defaultVaultPointer`) |
| Release cart | `amc order release --token <orderToken> --json` |
| Reconcile unknown write | `amc checkout reconcile --token <orderToken> --email <email> --json` |
| Refunds | `amc refund preview --confirmation <n> --email <e>` → human approval → `amc refund submit --confirmation <n> --email <e>` → `amc refund reconcile --confirmation <n> --email <e>` |

All non-help command invocations accept `--json` and emit one stable JSON
object; failures emit `{"error":{"code","message",...}}`. Help/usage output
(`--help`, `help`) is plain text and exempt from the JSON envelope.

## Procedure: hold seats and hand off to the human

1. `amc doctor --json`; follow `recommendedAction` if not `none`.
2. `amc theater resolve --url "<URL the user gave>" --json`. Only official
   `https://www.amctheatres.com/movie-theatres/<market>/<amc-...>` URLs are
   accepted; anything else fails with `AMC_THEATER_URL` — do not work around
   it.
3. `amc showtimes --theater-url ... --date ... --json`, then
   `amc seats <showtime-id> --available-only --json`; confirm the exact seats
   with the user.
4. `amc cart create --showtime <id> --seat A2 A3 --json` (the variadic
   `--seat` takes all seat names after one flag). This is the
   ONLY cart write. Output includes `orderToken`, `seats`, `total`,
   `expiresAt`, and `checkoutUrl`.
5. Give the human the `checkoutUrl` privately and stop. The URL is
   bearer-like: never post it publicly, never log it.

## Procedure: self-checkout of the SAME cart (only with explicit approval)

1. `amc checkout preview --token <orderToken> --email <email> --json` — never
   create a new cart for this. Note the exact `seats`, `total`, `expiresAt`.
2. Show the human the exact seats and total; proceed only after they approve
   that exact amount in conversation. The CLI takes no approval artifact —
   asking is your responsibility.
3. `amc checkout submit --token <orderToken> --email <email>
   [--vault <pointer>] --json`. Submit re-reads that exact cart and the
   service fails closed unless it is still the same open, unexpired cart.
4. If it fails because the cart changed, expired, or closed, re-preview, show
   the human the new quote, get fresh approval, and try once more.
5. If it fails with `AMC_WRITE_OUTCOME_UNKNOWN`, do NOT resubmit: run
   `amc checkout reconcile --token <orderToken> --email <email> --json` and
   report the result. Never release a cart after an ambiguous submit.
6. On an interactive payment challenge (3DS / user action required), stop and
   hand the flow to the human.

## Procedure: session repair (explicit, at most once)

`AMC_SESSION_REPAIR_REQUIRED` is the only auth-repair trigger code. It covers
every direct-admission failure — interactive challenge, typed admission
failure, or a TLS/network block of the admission requests. Other error codes
(e.g. `AMC_HTTP`, `AMC_WRITE_OUTCOME_UNKNOWN`, raw network errors after a
valid session) are not fixed by repair. If a read fails with
`AMC_SESSION_REPAIR_REQUIRED`:

1. `amc auth repair --listing-url "<official theater URL>" --browser-channel
   chrome --json` (or `--browser-executable <path>` / `--cdp-url <url>`). A
   launched browser opens visible/headful by default (most reliable);
   `--headless` exists for servers but is best-effort and often blocked.
2. Re-run the failed read once. If it fails again, stop and report — no retry
   loops.

Success is only reported after the direct read canary validates the repaired
session; a browser page rendering is not success by itself. Repair first waits
(one bounded operation, up to ~40s) for a browser-side GraphQL AccessCheck to
settle before exporting cookies. If it fails with `AMC_SESSION_REPAIR_REQUIRED`
(stage `browser-trust` or `post-repair-canary`), the browser/egress could not
clear the anti-bot layer: switch to an ordinary non-headless Chrome profile you
already use on amctheatres.com, or a different egress — do not loop `auth
repair`.

Explicit browser repair also self-aligns the direct-transport fingerprint (it
reads the browser's own signature from the fixed `https://tls.peet.ws/api/all`
endpoint, strips all identifying fields, and persists only the minimal
signature), so later CLI processes and commerce writes work without a manual
Peet profile or `AMC_HELLO_PROFILE_PATH`. Ordinary reads never contact that
endpoint.

## Pitfalls

- One cart per purchase. The self-checkout path consumes the existing
  `orderToken`; creating a second cart for the same seats is a bug.
- Never strand a cart. The CLI journals cart tokens privately by default. If
  `cart create` returns `AMC_CART_HOLD_UNCONFIRMED`, the hold EXISTS: read
  `error.reconciliation.orderToken` and run
  `amc order release --token <orderToken>` (or `amc checkout reconcile`) — never
  create another cart for the same seats.
- No payment without the human approving the exact total shown by
  `checkout preview`. `buy --confirm` is retired and fails closed.
- Never blind-retry any write; reconcile instead.
- No watcher/warmer/remediation orchestration ships here; none of it exists to
  reuse. For custom orchestration, build on the library API, respect provider
  limits, maintain one fenced commerce writer, and do not blind-retry writes.
  Carts expire (see `expiresAt`; `amc order extend` exists for one explicit
  extension).
- Never echo the checkout URL, session contents, or vault pointers into logs,
  issues, or chat transcripts other than the private reply to the buyer.

## Verification

- After cart create: JSON has `orderToken`, `checkoutUrl`, `total`,
  `expiresAt` in the future.
- After submit: JSON has `confirmationNumber` and `chargedTotal` equal to the
  approved total.
- After anything ambiguous: `checkout reconcile` (or `refund reconcile`)
  reports the definitive state.

## Copy-paste prompts for a zero-context agent

> Install Open AMC (clone https://github.com/ashah360/open-amc.git at tag
> v0.1.2 and run `bash install.sh --agent auto`, or use the documented
> installer one-liner), then run
> `amc setup --theater-url "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes" --json`.
> Once setup reports ready, find IMAX showtimes for 2030-01-15, list available
> seats for the 7pm show, hold seats E7 and E8 in one cart with
> `amc cart create`, and give me the checkout URL privately. Do not pay.

> I approve paying exactly $44.00 for cart <orderToken>. Run
> `amc checkout preview` for that token and confirm the total is exactly
> $44.00. If it is, run `amc checkout submit` for the same token with my
> configured vault pointer. If the total or seats differ from what I
> approved, stop and ask me again.
