#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { Command, CommanderError } from "commander";
import { createAmcClient, AmcClient, AmcClientConfig } from "./client";
import { FileSessionStore } from "./auth-session";
import { HelloTransport, registerHelloProfileFromPeet } from "./transport";
import { AmcBrowserRefresher } from "./client/browser-refresh";
import { availableOrdinarySeats } from "./client/seat-layout";
import { adoptPersistedFingerprint } from "./client/runtime";
import {
  ResolvedAmcTheater,
  resolveOfficialAmcTheaterUrl,
} from "./client/theater-url";
import { createPurchaseSnapshot } from "./commerce/purchase-snapshot";
import { AmcCheckoutCapabilities } from "./commerce/wiring";
import {
  CheckoutPreview,
  RefundPreview,
  UnknownOutcomeReconciliation,
  UnknownWriteOutcomeError,
} from "./commerce/service";
import { amcCheckoutUrl } from "./commerce/handoff";

/**
 * Optional operational capabilities the CLI loads from an explicit CommonJS
 * module (never from bundled defaults). The public package ships no card
 * provider, proxy, identity, or browser implementation.
 */
export interface AmcCliCapabilities extends AmcCheckoutCapabilities {
  browserRepair?: AmcBrowserRefresher;
  /** Opaque pointer the card provider understands. Never a raw card value. */
  defaultVaultPointer?: string;
  /**
   * One-time configured receipt email so checkout/refund commands can run with
   * just the provider identifiers (`--email` remains an explicit override).
   */
  defaultReceiptEmail?: string;
}

/** Command-local configuration for the built-in explicit browser repair. */
export interface BuiltInBrowserRepairOptions {
  /** Canonical official AMC listing URL used to prove admission. */
  listingUrl: string;
  /** Installed Chrome/Chromium channel (e.g. "chrome"). */
  channel?: string;
  /** Explicit Chrome/Chromium executable path. */
  executablePath?: string;
  /** Connect to an already-running Chrome over CDP instead of launching. */
  cdpUrl?: string;
}

export interface AmcCliDependencies {
  /** Injected client (tests). When absent one is built from env/flags. */
  client?: AmcClient;
  /** Factory override (tests). Defaults to createAmcClient. */
  createClient?: (config: AmcClientConfig) => AmcClient;
  /** Injected capabilities (tests). When absent they are loaded from a module. */
  capabilities?: AmcCliCapabilities;
  /**
   * Factory for the command-local browser repair used by
   * `auth repair --listing-url ...`. Defaults to the shipped Playwright
   * adapter (optional playwright-core, never an implicit browser download).
   * Only the explicit repair command ever invokes this.
   */
  createBrowserRepair?: (
    options: BuiltInBrowserRepairOptions,
  ) => AmcBrowserRefresher;
  writeOut?: (line: string) => void;
  writeErr?: (line: string) => void;
}

export async function runAmcCli(
  argv: readonly string[] = process.argv,
  dependencies: AmcCliDependencies = {},
): Promise<number> {
  const writeOut =
    dependencies.writeOut ??
    ((line: string) => process.stdout.write(`${line}\n`));
  const writeErr =
    dependencies.writeErr ??
    ((line: string) => process.stderr.write(`${line}\n`));

  // Detected from raw argv so the JSON contract holds even when Commander
  // fails before option parsing completes (missing options, unknown commands).
  const jsonRequested = argv.includes("--json");

  // `doctor` must reach a redacted report even when CLI configuration is
  // broken (bad capability module, malformed transport profile); every other
  // command keeps failing closed on a broken setup. Detection is conservative:
  // it skips global options (and the value of --checkout-session) rather than
  // mistaking an option value for the command word.
  const wantsDoctor = isDoctorInvocation(argv.slice(2));

  // When the CLI builds its own client it also owns the transport it created and
  // must close it (createAmcClient does not close an injected transport). When a
  // client is injected (tests), the CLI manages no transport.
  let ownedTransport: HelloTransport | undefined;
  let capabilities: AmcCliCapabilities = {};
  let client: AmcClient;
  const setup: DoctorSetupStatus = {
    capabilityModule: process.env.AMC_CAPABILITY_MODULE
      ? "ok"
      : "not-configured",
    client: "ok",
  };
  const failSetup = (error: unknown): number => {
    if (jsonRequested) {
      writeOut(JSON.stringify(jsonErrorEnvelope(error)));
    } else {
      writeErr(
        `fatal: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return 1;
  };
  try {
    capabilities = dependencies.capabilities ?? loadCliCapabilities();
  } catch (error) {
    if (!wantsDoctor) return failSetup(error);
    // Doctor mode: record the typed status only; the raw error may carry
    // module paths or require stacks and is never emitted.
    setup.capabilityModule = "invalid";
    capabilities = {};
  }
  try {
    if (dependencies.client) {
      client = dependencies.client;
    } else {
      const built = await buildClient(
        dependencies.createClient ?? createAmcClient,
        capabilities,
      );
      client = built.client;
      ownedTransport = built.transport;
    }
  } catch (error) {
    if (!wantsDoctor) return failSetup(error);
    setup.client = "invalid";
    client = unavailableAmcClient();
  }

  let commandExitCode = 0;
  const program = new Command()
    .name("amc")
    .description(
      "Unofficial AMC reads and confirmation-bound commerce operations",
    )
    .option("--checkout-session <id>", "stable owner id for a checkout flow")
    .option("--json", "emit stable JSON output", false)
    .exitOverride()
    .configureOutput({
      writeOut: (value) => writeOut(trimTrailingNewline(value)),
      // Commander usage/error text is replaced by the JSON envelope when
      // --json is present; it must never interleave with machine output.
      writeErr: (value) => {
        if (!jsonRequested) writeErr(trimTrailingNewline(value));
      },
    });

  const execute = async (
    command: Command,
    action: () => Promise<Record<string, unknown>>,
    human: (result: Record<string, unknown>) => string[],
  ): Promise<void> => {
    const json = Boolean(command.optsWithGlobals().json);
    try {
      const result = await action();
      if (json) writeOut(JSON.stringify(result));
      else for (const line of human(result)) writeOut(line);
    } catch (error) {
      commandExitCode = 1;
      if (json) writeOut(JSON.stringify(jsonErrorEnvelope(error)));
      else
        writeErr(
          `error: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
  };

  const receiptEmail = (explicit?: string): string => {
    const email = explicit ?? capabilities.defaultReceiptEmail;
    if (!email) {
      throw new Error(
        "a receipt email is required (pass --email or configure defaultReceiptEmail in the capability module)",
      );
    }
    return email;
  };

  const vaultPointer = (explicit?: string): string => {
    const pointer = explicit ?? capabilities.defaultVaultPointer;
    if (!pointer) {
      throw new Error(
        "a payment vault pointer is required (pass --vault or configure a capability module)",
      );
    }
    return pointer;
  };

  const seatNamesOf = (raw: string[]): string[] => {
    const names = [...new Set(raw.map((name) => name.trim().toUpperCase()))];
    if (names.length === 0 || names.length !== raw.length) {
      throw new Error("seat names must be non-empty and unique");
    }
    return names;
  };

  buildAuthCommands(
    program,
    client,
    execute,
    dependencies.createBrowserRepair ?? builtInPlaywrightBrowserRepair,
  );

  const theater = program
    .command("theater")
    .description("Official AMC theater operations");
  theater
    .command("resolve")
    .requiredOption(
      "--url <url>",
      "official amctheatres.com theater/showtimes URL",
    )
    .description("Resolve an official theater URL into a typed descriptor")
    .action(async (options: { url: string }, command: Command) => {
      await execute(
        command,
        async () =>
          resolveOfficialAmcTheaterUrl(options.url) as unknown as Record<
            string,
            unknown
          >,
        (result) => [
          `${String(result.name)} (${String(result.slug)})`,
          `Listing: ${String(result.url)}`,
        ],
      );
    });

  program
    .command("showtimes")
    .requiredOption(
      "--theater-url <url>",
      "official amctheatres.com theater/showtimes URL (any official AMC theater)",
    )
    .requiredOption("--date <date>", "listing date (YYYY-MM-DD)")
    .option("--movie <text>", "case-insensitive movie title filter")
    .option("--format <text>", "case-insensitive format filter")
    .description("List dated showtimes")
    .action(async (options: ShowtimesOptions, command: Command) => {
      await execute(
        command,
        async () => ({
          showtimes: await client.showtimes.list({
            venue: showtimesVenue(options),
            date: options.date,
            ...(options.movie ? { movie: options.movie } : {}),
            ...(options.format ? { format: options.format } : {}),
          }),
        }),
        (result) => {
          const showtimes = result.showtimes as Array<Record<string, unknown>>;
          if (showtimes.length === 0) return ["No matching showtimes."];
          return showtimes.map(
            (s) =>
              `${s.id}  ${s.time}  ${s.movieTitle}  [${s.format}]  ${s.availability}`,
          );
        },
      );
    });

  program
    .command("seats <showtime-id...>")
    .option("--available-only", "show available ordinary seats only", false)
    .description(
      "Read one or more seating layouts; multiple IDs use one request",
    )
    .action(
      async (
        showtimeIds: string[],
        options: { availableOnly: boolean },
        command: Command,
      ) => {
        await execute(
          command,
          async () => {
            if (showtimeIds.length === 1) {
              const showtimeId = showtimeIds[0]!;
              const layout = await client.inventory.get(showtimeId);
              return {
                showtimeId,
                columns: layout.columns,
                rows: layout.rows,
                seats: options.availableOnly
                  ? availableOrdinarySeats(layout)
                  : layout.seats,
              };
            }
            const batch = await client.inventory.getBatch(showtimeIds);
            return {
              observedAt: batch.observedAt,
              showtimes: Object.fromEntries(
                batch.results.map((r) =>
                  r.status === "error"
                    ? [
                        r.showtimeId,
                        {
                          status: "error",
                          showtimeId: r.showtimeId,
                          error: { code: r.code, message: r.message },
                        },
                      ]
                    : [
                        r.showtimeId,
                        {
                          status: "ok",
                          showtimeId: r.showtimeId,
                          columns: r.layout.columns,
                          rows: r.layout.rows,
                          seats: options.availableOnly
                            ? availableOrdinarySeats(r.layout)
                            : r.layout.seats,
                          prices: r.layout.prices,
                        },
                      ],
                ),
              ),
            };
          },
          (result) => {
            if ("showtimes" in result) {
              const showtimes = result.showtimes as Record<
                string,
                Record<string, unknown>
              >;
              return Object.values(showtimes).map((s) =>
                s.status === "error"
                  ? `Showtime ${String(s.showtimeId)}: ERROR ${String((s.error as Record<string, unknown>).message)}`
                  : `Showtime ${String(s.showtimeId)}: ${String(s.columns)}x${String(s.rows)}, ${(s.seats as unknown[]).length} seats`,
              );
            }
            const seats = result.seats as unknown[];
            return [
              `Showtime ${String(result.showtimeId)}: ${String(result.columns)}x${String(result.rows)}, ${seats.length} seats`,
            ];
          },
        );
      },
    );

  program
    .command("doctor")
    .description(
      "Report configuration/readiness (bounded reads only; no writes, no browser)",
    )
    .action(async (_options: unknown, command: Command) => {
      await execute(
        command,
        () =>
          doctorReport(
            setup.client === "ok" ? client : undefined,
            capabilities,
            setup,
          ),
        (result) => doctorHumanLines(result),
      );
    });

  const order = program.command("order").description("Order token operations");
  order
    .command("get")
    .requiredOption("--token <token>", "order token")
    .requiredOption("--email <email>", "order email")
    .description("Read a cart/order projection")
    .action(
      async (options: { token: string; email: string }, command: Command) => {
        await execute(
          command,
          () =>
            client.orders.get({
              orderToken: options.token,
              email: options.email,
            }) as Promise<unknown> as Promise<Record<string, unknown>>,
          (result) => [
            `Order ${String(result.orderToken)}: ${String(result.status)}, total $${String(result.total)}, expires ${String(result.expiresAt)}`,
          ],
        );
      },
    );
  order
    .command("extend")
    .requiredOption("--token <token>", "order token")
    .description("Extend an open order's expiration")
    .action(async (options: { token: string }, command: Command) => {
      await execute(
        command,
        () =>
          client.orders.extendExpiration({
            orderToken: options.token,
          }) as Promise<unknown> as Promise<Record<string, unknown>>,
        (result) => [
          `Order ${String(result.orderToken)} now expires ${String(result.expiresAt)}`,
        ],
      );
    });
  order
    .command("release")
    .requiredOption("--token <token>", "order token")
    .description("Release an open cart")
    .action(async (options: { token: string }, command: Command) => {
      const session = command.optsWithGlobals().checkoutSession as
        string | undefined;
      await execute(
        command,
        async () => {
          await client.orders.release(
            options.token,
            session ? { checkoutSessionId: session } : undefined,
          );
          return { released: true };
        },
        () => ["Cart released."],
      );
    });

  program
    .command("cart")
    .description("Cart operations")
    .command("create")
    .requiredOption("--showtime <id>", "showtime ID")
    .requiredOption("--seat <name...>", "seat name(s)")
    .option("--adult <count>", "adult ticket count")
    .description("Create a hold for exact seats from live inventory")
    .action(
      async (
        options: { showtime: string; seat: string[]; adult?: string },
        command: Command,
      ) => {
        const session = command.optsWithGlobals().checkoutSession as
          string | undefined;
        await execute(
          command,
          async () => {
            const names = seatNamesOf(options.seat);
            const snapshot = await snapshotFor(
              client,
              options.showtime,
              names,
              options.adult,
            );
            const cart = await client.orders.createCart(
              snapshot.cartIntent,
              session ? { checkoutSessionId: session } : undefined,
            );
            return {
              ...(cart as unknown as Record<string, unknown>),
              checkoutUrl: amcCheckoutUrl(cart.orderToken),
            };
          },
          (result) => [
            `Cart ${String(result.orderToken)} open, total $${String(result.total)}, expires ${String(result.expiresAt)}`,
            `First-party checkout (bearer-like; share only with the buyer): ${String(result.checkoutUrl)}`,
          ],
        );
      },
    );

  program
    .command("buy")
    .requiredOption("--showtime <id>", "showtime ID")
    .requiredOption("--seat <name...>", "seat name(s)")
    .option("--adult <count>", "adult ticket count")
    .option(
      "--confirm",
      "retired; use checkout preview + checkout submit",
      false,
    )
    .description("Quote seats without any write (the one-shot buy is retired)")
    .action(
      async (
        options: {
          showtime: string;
          seat: string[];
          adult?: string;
          confirm: boolean;
        },
        command: Command,
      ) => {
        await execute(
          command,
          async () => {
            // `buy --confirm` used to create a cart AND charge it in one
            // opaque shot, leaving the calling agent no chance to show the
            // human the exact cart first. It fails closed with zero writes.
            if (options.confirm) {
              throw new UnsafeBuyConfirmError();
            }
            const names = seatNamesOf(options.seat);
            const snapshot = await snapshotFor(
              client,
              options.showtime,
              names,
              options.adult,
            );
            return {
              kind: "quote",
              showtimeId: snapshot.showtimeId,
              seats: snapshot.seats.map((s) => s.name),
              ticketPrice: snapshot.ticketPrice,
              convenienceFee: snapshot.convenienceFee,
              tax: snapshot.tax,
              total: snapshot.expectedTotal,
            };
          },
          (result) => [
            `Quote: ${String((result.seats as string[]).join(", "))}, $${String(result.total)}. Use cart create, then checkout preview/submit.`,
          ],
        );
      },
    );

  const checkout = program
    .command("checkout")
    .description("Two-phase checkout of an EXISTING cart (never a new one)");
  checkout
    .command("preview")
    .requiredOption("--token <token>", "existing order token")
    .option(
      "--email <email>",
      "receipt email to bind (defaults to configured defaultReceiptEmail)",
    )
    .description(
      "Read the exact live cart (seats, total, expiry) without writing",
    )
    .action(
      async (options: { token: string; email?: string }, command: Command) => {
        await execute(
          command,
          async () =>
            publicCheckoutPreview(
              await client.checkout.preview({
                orderToken: options.token,
                email: receiptEmail(options.email),
              }),
            ),
          (result) => [
            `Cart ${String(result.orderToken)}: $${String(result.total)}, seats ${(result.seats as Array<{ name: string }>).map((s) => s.name).join(", ")}, expires ${String(result.expiresAt)}`,
            `Or hand off: ${String(result.checkoutUrl)}`,
          ],
        );
      },
    );
  checkout
    .command("submit")
    .requiredOption(
      "--token <token>",
      "existing order token identifying the cart",
    )
    .option(
      "--email <email>",
      "receipt email override (defaults to configured defaultReceiptEmail)",
    )
    .option(
      "--vault <pointer>",
      "payment vault pointer override (defaults to configured defaultVaultPointer)",
    )
    .description(
      "Checkout the SAME existing cart; the service fails closed unless it is open and unexpired",
    )
    .action(
      async (
        options: {
          token: string;
          email?: string;
          vault?: string;
        },
        command: Command,
      ) => {
        await execute(
          command,
          async () => {
            const email = receiptEmail(options.email);
            const pointer = vaultPointer(options.vault);
            // Freshly re-read the exact cart identified by the order token.
            // No CartCreateOrder happens on this path; the only write is the
            // fulfillment of the already-open order, bound to this fresh
            // preview's provider-internal confirmationToken. The service
            // enforces OPEN/unexpired/same-cart invariants and never blindly
            // retries an unknown-outcome write (reconcile is the only follow-up).
            const fresh = await client.checkout.preview({
              orderToken: options.token,
              email,
            });
            const purchase = await client.checkout.submit({
              preview: fresh,
              confirmationToken: fresh.confirmationToken,
              email,
              vaultPointer: pointer,
            });
            return purchase as unknown as Record<string, unknown>;
          },
          (result) => [
            `Order ${String(result.confirmationNumber)} confirmed for $${String(result.chargedTotal)}.`,
          ],
        );
      },
    );
  checkout
    .command("reconcile")
    .requiredOption("--token <token>", "order token")
    .option(
      "--email <email>",
      "order email (defaults to configured defaultReceiptEmail)",
    )
    .description("Read-only outcome check after an unknown checkout write")
    .action(
      async (options: { token: string; email?: string }, command: Command) => {
        await execute(
          command,
          async () => {
            const purchase = await client.checkout.reconcile({
              orderToken: options.token,
              email: receiptEmail(options.email),
            });
            return purchase
              ? {
                  purchased: true,
                  ...(purchase as unknown as Record<string, unknown>),
                }
              : { purchased: false, orderToken: options.token };
          },
          (result) =>
            result.purchased
              ? [
                  `Purchase confirmed: ${String(result.confirmationNumber)} for $${String(result.chargedTotal)}.`,
                ]
              : ["No confirmed purchase exists for this order token."],
        );
      },
    );

  const refund = program.command("refund").description("Refund operations");
  refund
    .command("preview")
    .requiredOption("--confirmation <number>", "confirmation number")
    .option(
      "--email <email>",
      "order email (defaults to configured defaultReceiptEmail)",
    )
    .option("--lines <lines>", "comma-separated line numbers (default full)")
    .description("Preview a refund consequence without cancelling")
    .action(async (options: RefundOptions, command: Command) => {
      await execute(
        command,
        async () =>
          publicRefundPreview(
            await client.refunds.preview(
              refundQuery(options, receiptEmail(options.email)),
            ),
          ),
        (result) => [
          `Refund quote: $${String(result.refundTotal)} refund; $${String(result.nonRefundableFee)} fee retained.`,
        ],
      );
    });
  refund
    .command("submit")
    .requiredOption("--confirmation <number>", "confirmation number")
    .option(
      "--email <email>",
      "order email (defaults to configured defaultReceiptEmail)",
    )
    .option("--lines <lines>", "comma-separated line numbers (default full)")
    .description("Refund the requested confirmation/lines from a fresh preview")
    .action(async (options: RefundOptions, command: Command) => {
      await execute(
        command,
        async () => {
          const email = receiptEmail(options.email);
          // Freshly preview the exact requested order/lines, then submit
          // bound to that preview's provider-internal confirmationToken.
          // Unknown outcomes are reconcile-only; nothing is retried.
          const preview = await client.refunds.preview(
            refundQuery(options, email),
          );
          return client.refunds.submit({
            preview,
            confirmationToken: preview.confirmationToken,
            email,
          }) as Promise<unknown> as Promise<Record<string, unknown>>;
        },
        (result) => [
          `Refund ${String(result.status)}: $${String(result.refundTotal)}; $${String(result.nonRefundableFee)} fee retained.`,
        ],
      );
    });
  refund
    .command("reconcile")
    .requiredOption("--confirmation <number>", "confirmation number")
    .option(
      "--email <email>",
      "order email (defaults to configured defaultReceiptEmail)",
    )
    .description("Read-only order/refund state check after an unknown outcome")
    .action(
      async (
        options: { confirmation: string; email?: string },
        command: Command,
      ) => {
        await execute(
          command,
          async () => {
            if (!/^\d+$/.test(options.confirmation)) {
              throw new Error("invalid AMC confirmation number");
            }
            const snapshot = await client.refunds.reconcile({
              orderNumber: options.confirmation,
              email: receiptEmail(options.email),
            });
            return snapshot as unknown as Record<string, unknown>;
          },
          (result) => [
            `Order ${String(result.orderNumber)} is ${String(result.status)}; charged $${String(result.chargedTotal)}, fee $${String(result.nonRefundableFee)}.`,
            ...(result.lines as Array<Record<string, unknown>>).map(
              (line) =>
                `  line ${String(line.lineNumber)} (${String(line.label)}): ${String(line.status)}, refundable $${String(line.refundableAmount)}`,
            ),
          ],
        );
      },
    );

  try {
    await program.parseAsync([...argv]);
    return commandExitCode;
  } catch (error) {
    if (
      error instanceof CommanderError &&
      error.code === "commander.helpDisplayed"
    )
      return 0;
    if (error instanceof CommanderError) {
      if (jsonRequested) {
        writeOut(
          JSON.stringify({
            error: {
              code: "AMC_USAGE",
              message: trimErrorPrefix(error.message),
            },
          } satisfies AmcCliJsonError),
        );
      }
      return error.exitCode || 1;
    }
    if (jsonRequested) {
      writeOut(JSON.stringify(jsonErrorEnvelope(error)));
    } else {
      const message = error instanceof Error ? error.message : String(error);
      writeErr(`fatal: ${message}`);
    }
    return 1;
  } finally {
    await client.close().catch(() => undefined);
    if (ownedTransport) await ownedTransport.close().catch(() => undefined);
  }
}

interface ShowtimesOptions {
  theaterUrl: string;
  date: string;
  movie?: string;
  format?: string;
}

function showtimesVenue(options: ShowtimesOptions): ResolvedAmcTheater {
  return resolveOfficialAmcTheaterUrl(options.theaterUrl);
}
interface RefundOptions {
  confirmation: string;
  email?: string;
  lines?: string;
}

function refundQuery(
  options: RefundOptions,
  email: string,
): {
  orderNumber: string;
  email: string;
  lineNumbers?: string[];
} {
  if (!/^\d+$/.test(options.confirmation)) {
    throw new Error("invalid AMC confirmation number");
  }
  const lineNumbers = options.lines
    ? options.lines
        .split(",")
        .map((line) => line.trim())
        .filter(Boolean)
    : undefined;
  return {
    orderNumber: options.confirmation,
    email,
    ...(lineNumbers && lineNumbers.length > 0 ? { lineNumbers } : {}),
  };
}

function buildAuthCommands(
  program: Command,
  client: AmcClient,
  execute: (
    command: Command,
    action: () => Promise<Record<string, unknown>>,
    human: (result: Record<string, unknown>) => string[],
  ) => Promise<void>,
  createBrowserRepair: (
    options: BuiltInBrowserRepairOptions,
  ) => AmcBrowserRefresher,
): void {
  const auth = program.command("auth").description("Manage the AMC session");
  auth
    .command("status")
    .description("Validate the saved AMC session")
    .action(async (_options: unknown, command: Command) => {
      await execute(
        command,
        () =>
          client.auth.status() as Promise<unknown> as Promise<
            Record<string, unknown>
          >,
        (result) => [
          `AMC session: ${String(result.status)}`,
          ...(typeof result.instruction === "string"
            ? [result.instruction]
            : []),
        ],
      );
    });
  auth
    .command("clear")
    .description("Remove the AMC session")
    .action(async (_options: unknown, command: Command) => {
      await execute(
        command,
        async () => {
          await client.auth.clear();
          return { provider: "amc", account: "personal", status: "missing" };
        },
        () => ["AMC session cleared."],
      );
    });
  auth
    .command("bootstrap")
    .requiredOption(
      "--from <file>",
      "scoped cookie bundle file, or - for stdin",
    )
    .description("Import and validate a scoped AMC session bundle")
    .action(async (options: { from: string }, command: Command) => {
      await execute(
        command,
        async () => {
          const bytes =
            options.from === "-"
              ? readFileSync(0)
              : readFileSync(path.resolve(options.from));
          await client.auth.bootstrap(bytes);
          return { provider: "amc", account: "personal", status: "valid" };
        },
        () => ["AMC session bootstrapped."],
      );
    });
  auth
    .command("repair")
    .option(
      "--listing-url <url>",
      "official amctheatres.com theater URL; enables the built-in browser repair",
    )
    .option(
      "--browser-channel <channel>",
      "installed Chrome/Chromium channel for the built-in repair (e.g. chrome)",
    )
    .option(
      "--browser-executable <path>",
      "explicit Chrome/Chromium executable path for the built-in repair",
    )
    .option(
      "--cdp-url <url>",
      "connect to an already-running Chrome over CDP instead of launching",
    )
    .description(
      "Explicitly repair the session (direct-only unless --listing-url or a browser capability is wired)",
    )
    .action(
      async (
        options: {
          listingUrl?: string;
          browserChannel?: string;
          browserExecutable?: string;
          cdpUrl?: string;
        },
        command: Command,
      ) => {
        await execute(
          command,
          async () => {
            if (
              !options.listingUrl &&
              (options.browserChannel ||
                options.browserExecutable ||
                options.cdpUrl)
            ) {
              throw new Error(
                "browser flags require --listing-url <official AMC theater URL>",
              );
            }
            if (options.listingUrl) {
              // Validate the URL shape and derive the canonical listing URL
              // before any browser dependency is touched.
              const resolved = resolveOfficialAmcTheaterUrl(options.listingUrl);
              const browserRepair = createBrowserRepair({
                listingUrl: resolved.url,
                ...(options.browserChannel
                  ? { channel: options.browserChannel }
                  : {}),
                ...(options.browserExecutable
                  ? { executablePath: options.browserExecutable }
                  : {}),
                ...(options.cdpUrl ? { cdpUrl: options.cdpUrl } : {}),
              });
              await client.auth.repair({
                browserRepair,
                listingUrl: resolved.url,
              });
            } else {
              await client.auth.repair(undefined);
            }
            return { provider: "amc", account: "personal", status: "valid" };
          },
          () => ["AMC session repaired."],
        );
      },
    );
}

/**
 * The default built-in browser repair: the shipped Playwright adapter, loaded
 * lazily so playwright-core stays an optional dependency and ordinary commands
 * never touch it. Launch configuration is entirely caller-selected; nothing is
 * downloaded implicitly.
 */
function builtInPlaywrightBrowserRepair(
  options: BuiltInBrowserRepairOptions,
): AmcBrowserRefresher {
  const adapter = createRequire(__filename)(
    "./capabilities/browser/playwright",
  ) as typeof import("./capabilities/browser/playwright");
  const runtime = new adapter.PlaywrightBrowserRuntime(
    options.cdpUrl
      ? { kind: "cdp", endpointURL: options.cdpUrl }
      : {
          kind: "launch",
          headless: false,
          ...(options.channel ? { channel: options.channel } : {}),
          ...(options.executablePath
            ? { executablePath: options.executablePath }
            : {}),
        },
  );
  return new adapter.PlaywrightAmcBrowserRefresher({
    runtime,
    listingUrl: options.listingUrl,
  });
}

async function snapshotFor(
  client: AmcClient,
  showtime: string,
  names: string[],
  adult?: string,
) {
  if (!/^\d+$/.test(showtime)) throw new Error("invalid AMC showtime id");
  const adultCount = adult === undefined ? names.length : positiveCount(adult);
  if (adultCount !== names.length) {
    throw new Error("adult ticket count must match seat count");
  }
  const layout = await client.inventory.get(showtime);
  return createPurchaseSnapshot({
    showtimeId: showtime,
    seatNames: names,
    adultCount,
    layout,
    observedAt: new Date().toISOString(),
  });
}

async function buildClient(
  factory: (config: AmcClientConfig) => AmcClient,
  capabilities: AmcCliCapabilities,
): Promise<{ client: AmcClient; transport: HelloTransport }> {
  const proxyUrl = process.env.AMC_PROXY_URL;
  let profileName: string | undefined;
  const profilePath = process.env.AMC_HELLO_PROFILE_PATH;
  if (profilePath && existsSync(profilePath)) {
    profileName = process.env.AMC_HELLO_PROFILE_NAME ?? "amc-browser";
    let profile: unknown;
    try {
      profile = JSON.parse(readFileSync(profilePath, "utf8"));
    } catch {
      // Parse/read errors would echo the configured path; never emit it.
      throw new CliSetupError(
        "the AMC_HELLO_PROFILE_PATH profile could not be read or parsed as JSON; correct or unset AMC_HELLO_PROFILE_PATH, then run `amc doctor --json`",
      );
    }
    await registerHelloProfileFromPeet(profileName, profile);
  }
  const transport = new HelloTransport({
    ...(profileName ? { profile: profileName } : {}),
    ...(proxyUrl ? { proxyUrl } : {}),
    // A manually pinned profile (AMC_HELLO_PROFILE_PATH) is an explicit
    // operator override and always wins over auto-aligned fingerprints.
    ...(profileName ? { allowFingerprintAdoption: false } : {}),
  });
  const store = new FileSessionStore(
    process.env.AMC_SESSION_ROOT
      ? { root: path.resolve(process.env.AMC_SESSION_ROOT) }
      : {},
  );
  const checkout: AmcCheckoutCapabilities = {
    ...(capabilities.cardProvider
      ? { cardProvider: capabilities.cardProvider }
      : {}),
    ...(capabilities.challengeHandler
      ? { challengeHandler: capabilities.challengeHandler }
      : {}),
    ...(capabilities.recovery ? { recovery: capabilities.recovery } : {}),
  };
  const client = factory({
    transport,
    store,
    ...(capabilities.browserRepair
      ? { browserRepair: capabilities.browserRepair }
      : {}),
    checkout,
  });
  // Fresh-process self-alignment: if a prior explicit browser repair persisted
  // a browser-derived fingerprint, adopt it on this process's direct transport
  // before any command runs (covers reads AND commerce). A manual profile pin
  // refuses adoption, so the operator override still wins.
  await adoptPersistedFingerprint(transport, store);
  return { client, transport };
}

/**
 * The public contract for AMC_CAPABILITY_MODULE: a CommonJS module exporting a
 * no-argument `createAmcCapabilities` factory. The CLI intentionally passes no
 * context — a capability module reads its own configuration and must never
 * receive session contents or secrets from the CLI.
 */
export type CreateAmcCapabilities = () => AmcCliCapabilities;

function loadCliCapabilities(): AmcCliCapabilities {
  const configured = process.env.AMC_CAPABILITY_MODULE;
  if (!configured) return {};
  let loaded: unknown;
  try {
    loaded = createRequire(__filename)(path.resolve(configured));
  } catch {
    // Loader errors carry machine paths and require stacks; never emit them.
    throw new CliSetupError(
      "the AMC_CAPABILITY_MODULE module could not be loaded; correct or unset AMC_CAPABILITY_MODULE, then run `amc doctor --json`",
    );
  }
  if (!isRecord(loaded) || typeof loaded.createAmcCapabilities !== "function") {
    throw new Error(
      "AMC_CAPABILITY_MODULE must export createAmcCapabilities()",
    );
  }
  const capabilities: unknown = (
    loaded.createAmcCapabilities as CreateAmcCapabilities
  )();
  if (!isRecord(capabilities)) {
    throw new Error("createAmcCapabilities() must return an object");
  }
  return capabilities as AmcCliCapabilities;
}

/**
 * The single stable JSON error envelope every `--json` failure emits, on both
 * command failures and parse/usage failures. `operation` and `reconciliation`
 * are present only for typed unknown-outcome errors, and `reconciliation`
 * carries only the explicitly allowlisted safe identifiers from
 * {@link UnknownOutcomeReconciliation} — never stacks, causes, cookies,
 * request bodies, card/session material, URLs, or raw provider errors.
 */
export interface AmcCliJsonError {
  error: {
    code: string;
    message: string;
    operation?: "cart" | "checkout" | "refund" | "release";
    reconciliation?: UnknownOutcomeReconciliation;
  };
}

const CLI_OPERATIONS = new Set(["cart", "checkout", "refund", "release"]);

function trimTrailingNewline(value: string): string {
  return value.replace(/\n$/, "");
}

/** Commander prefixes usage messages with "error: "; the envelope carries a code. */
function trimErrorPrefix(message: string): string {
  return message.replace(/^error:\s*/, "");
}

function jsonErrorEnvelope(error: unknown): AmcCliJsonError {
  const message = error instanceof Error ? error.message : String(error);
  const rawCode =
    error && typeof error === "object" && "code" in error
      ? (error as { code: unknown }).code
      : undefined;
  const envelope: AmcCliJsonError = {
    error: {
      code: typeof rawCode === "string" ? rawCode : "AMC_ERROR",
      message,
    },
  };
  if (!(error instanceof UnknownWriteOutcomeError)) return envelope;
  const operation = (error as { operation?: unknown }).operation;
  if (typeof operation === "string" && CLI_OPERATIONS.has(operation)) {
    envelope.error.operation = operation as
      "cart" | "checkout" | "refund" | "release";
  }
  const reconciliation = safeReconciliation(
    (error as { reconciliation?: unknown }).reconciliation,
  );
  if (reconciliation) envelope.error.reconciliation = reconciliation;
  return envelope;
}

/**
 * Copies only the allowlisted, correctly-typed reconciliation identifiers.
 * Unknown keys and non-string(-array) values are dropped, never serialized.
 */
function safeReconciliation(
  value: unknown,
): UnknownOutcomeReconciliation | undefined {
  if (!isRecord(value)) return undefined;
  const out: UnknownOutcomeReconciliation = {};
  for (const key of ["orderToken", "orderNumber", "showtimeId"] as const) {
    if (typeof value[key] === "string") out[key] = value[key];
  }
  for (const key of ["seatNames", "lineNumbers"] as const) {
    const entry = value[key];
    if (
      Array.isArray(entry) &&
      entry.every((item): item is string => typeof item === "string")
    ) {
      out[key] = [...entry];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function publicRefundPreview(preview: RefundPreview): Record<string, unknown> {
  return {
    kind: "refund-quote",
    orderNumber: preview.orderNumber,
    scope: preview.scope,
    lineNumbers: preview.lineNumbers,
    refundTotal: preview.refundTotal,
    remainingRefundableTotal: preview.remainingRefundableTotal,
    nonRefundableFee: preview.nonRefundableFee,
    chargedTotal: preview.chargedTotal,
    status: preview.status,
  };
}

/**
 * The CLI projection of a checkout preview. The service-internal single-use
 * confirmationToken is intentionally NOT exposed; `checkout submit` re-reads
 * the cart and binds a fresh confirmationToken itself at submit time.
 */
function publicCheckoutPreview(
  preview: CheckoutPreview,
): Record<string, unknown> {
  return {
    kind: "checkout-preview",
    orderToken: preview.orderToken,
    showtimeId: preview.showtimeId,
    seats: preview.seats,
    tickets: preview.tickets,
    total: preview.total,
    expiresAt: preview.expiresAt,
    emailBinding: preview.emailBinding,
    observedAt: preview.observedAt,
    checkoutUrl: amcCheckoutUrl(preview.orderToken),
  };
}

/** Finds the first positional command word, skipping global option values. */
function isDoctorInvocation(tokens: readonly string[]): boolean {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--checkout-session") {
      index++; // its value is not a command word
      continue;
    }
    if (token.startsWith("-")) continue;
    return token === "doctor";
  }
  return false;
}

/**
 * Typed, deliberately value-free setup failure. Raw loader/parser errors can
 * carry absolute paths, require stacks, or module contents; this error names
 * only the environment variable to fix and never its value.
 */
class CliSetupError extends Error {
  readonly code = "AMC_CLI_SETUP";
}

/** Typed CLI setup outcome surfaced by `doctor` instead of raw errors. */
interface DoctorSetupStatus {
  capabilityModule: "ok" | "not-configured" | "invalid";
  client: "ok" | "invalid";
}

/**
 * A stand-in assigned only in doctor mode when configuration failure prevented
 * building the real client. Only `doctor` dispatches in that state; any other
 * accidental use fails with a typed message carrying no configuration values.
 */
function unavailableAmcClient(): AmcClient {
  const fail = async (): Promise<never> => {
    throw new Error(
      "AMC client is unavailable because CLI configuration is broken; run `amc doctor --json`",
    );
  };
  return {
    showtimes: { list: fail },
    inventory: { get: fail, getBatch: fail },
    auth: { status: fail, bootstrap: fail, clear: fail, repair: fail },
    orders: {
      createCart: fail,
      get: fail,
      extendExpiration: fail,
      release: fail,
    },
    checkout: { preview: fail, submit: fail, reconcile: fail },
    refunds: { preview: fail, submit: fail, reconcile: fail },
    close: async () => undefined,
  } as unknown as AmcClient;
}

/**
 * Deterministic readiness report. Every environment-derived fact is reduced to
 * presence/readability booleans or typed statuses — never a path, URL,
 * credential, module value, or raw error/require stack — and the only network
 * activity is the existing bounded auth status read (skipped entirely when
 * setup failed). It performs no provider write and never opens a browser.
 */
async function doctorReport(
  client: AmcClient | undefined,
  capabilities: AmcCliCapabilities,
  setup: DoctorSetupStatus,
): Promise<Record<string, unknown>> {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const sessionRoot = process.env.AMC_SESSION_ROOT;
  const profilePath = process.env.AMC_HELLO_PROFILE_PATH;
  let auth: Record<string, unknown>;
  if (!client) {
    auth = { status: "unknown", reason: "configuration" };
  } else {
    try {
      const status = await client.auth.status();
      auth = {
        status: status.status,
        ...(status.instruction ? { instruction: status.instruction } : {}),
      };
    } catch (error) {
      auth = {
        status: "unreachable",
        code:
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "AMC_ERROR",
      };
    }
  }
  const setupBroken =
    setup.capabilityModule === "invalid" || setup.client === "invalid";
  const recommendedAction = setupBroken
    ? {
        action: "fix-configuration",
        command:
          "correct or unset AMC_CAPABILITY_MODULE / AMC_HELLO_PROFILE_PATH, then re-run amc doctor --json",
      }
    : nodeMajor < 22
      ? { action: "upgrade-node", command: "install Node.js >= 22" }
      : auth.status === "valid"
        ? { action: "none" }
        : {
            action: "auth-repair",
            // Directly executable for the common installed-Chrome path;
            // --browser-executable <path> or --cdp-url <url> are alternatives.
            command:
              "amc auth repair --listing-url <official AMC theater URL> --browser-channel chrome --json",
          };
  return {
    kind: "doctor",
    setup: { ...setup },
    node: { version: process.versions.node, supported: nodeMajor >= 22 },
    sessionStore: {
      rootConfigured: Boolean(sessionRoot),
      ...(sessionRoot ? { rootExists: existsSync(sessionRoot) } : {}),
    },
    transport: {
      profileConfigured: Boolean(profilePath),
      ...(profilePath ? { profileReadable: existsSync(profilePath) } : {}),
      proxyConfigured: Boolean(process.env.AMC_PROXY_URL),
    },
    playwright: {
      playwrightCoreInstalled: canResolve("playwright-core"),
    },
    capabilities: {
      moduleConfigured: Boolean(process.env.AMC_CAPABILITY_MODULE),
      cardProvider: Boolean(capabilities.cardProvider),
      challengeHandler: Boolean(capabilities.challengeHandler),
      recovery: Boolean(capabilities.recovery),
      browserRepair: Boolean(capabilities.browserRepair),
      defaultVaultPointer: Boolean(capabilities.defaultVaultPointer),
      defaultReceiptEmail: Boolean(capabilities.defaultReceiptEmail),
    },
    auth,
    recommendedAction,
  };
}

function doctorHumanLines(result: Record<string, unknown>): string[] {
  const node = result.node as Record<string, unknown>;
  const auth = result.auth as Record<string, unknown>;
  const recommended = result.recommendedAction as Record<string, unknown>;
  const capabilities = result.capabilities as Record<string, unknown>;
  const playwright = result.playwright as Record<string, unknown>;
  const sessionStore = result.sessionStore as Record<string, unknown>;
  return [
    `Node ${String(node.version)}: ${node.supported ? "supported" : "UNSUPPORTED (need >= 22)"}`,
    `Session store root configured: ${String(sessionStore.rootConfigured)}`,
    `Playwright core installed: ${String(playwright.playwrightCoreInstalled)}`,
    `Payment capability present: ${String(capabilities.cardProvider)}`,
    `AMC session: ${String(auth.status)}`,
    recommended.action === "none"
      ? "Ready."
      : `Next: ${String(recommended.command ?? recommended.action)}`,
  ];
}

function canResolve(specifier: string): boolean {
  try {
    createRequire(__filename).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/** `buy --confirm` is retired: it created and charged a cart in one shot. */
class UnsafeBuyConfirmError extends Error {
  readonly code = "AMC_BUY_CONFIRM_RETIRED";
  constructor() {
    super(
      "buy --confirm is retired because it created and charged a cart in one opaque shot; run `amc cart create`, then `amc checkout preview` and `amc checkout submit --token <orderToken> --email <email>`",
    );
  }
}

function positiveCount(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("ticket count must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("ticket count must be a positive integer");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (require.main === module) {
  void runAmcCli().then((code) => {
    process.exitCode = code;
  });
}
