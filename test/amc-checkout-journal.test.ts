import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../src/auth-session";
import {
  CheckoutJournalCorruptError,
  FileCheckoutJournal,
  RefundAttempt,
} from "../src/commerce/checkout-journal";
import { CartCreateIntent } from "../src/commerce/executor";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

describe("AMC checkout journal", () => {
  it("persists mutation boundaries and provider tokens under a stable intent key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amc-journal-"));
    roots.push(root);
    const journal = new FileCheckoutJournal(new FileSessionStore({ root }));
    const intent = createIntent();

    await journal.withIntentLock(intent, async () => {
      expect(await journal.load(intent)).toBeNull();
      await journal.save({
        version: 1,
        attemptId: journal.attemptId(intent),
        state: "PREPARED",
        intent,
        checkoutSessionId: "conversation-a",
        updatedAt: "2030-01-15T22:00:00.000Z",
      });
      await journal.save({
        version: 1,
        attemptId: journal.attemptId(intent),
        state: "CART_DISPATCHING",
        intent,
        checkoutSessionId: "conversation-a",
        updatedAt: "2030-01-15T22:00:01.000Z",
      });
      await journal.save({
        version: 1,
        attemptId: journal.attemptId(intent),
        state: "CART_OPEN",
        intent,
        checkoutSessionId: "conversation-a",
        orderToken: "00000000-0000-4000-8000-000000000002",
        updatedAt: "2030-01-15T22:00:02.000Z",
      });
    });

    expect(await journal.load(intent)).toMatchObject({
      state: "CART_OPEN",
      orderToken: "00000000-0000-4000-8000-000000000002",
      attemptId: journal.attemptId(intent),
      checkoutSessionId: "conversation-a",
      intent,
    });
    expect(
      await journal.loadByOrderToken("00000000-0000-4000-8000-000000000002"),
    ).toMatchObject({ state: "CART_OPEN", intent });
    expect(
      await journal.loadBySelection("900000005", ["H8", "H7"]),
    ).toMatchObject({
      state: "CART_OPEN",
      intent,
    });
    const equivalentMutation = { ...intent, expectedTotal: "55.57" as const };
    expect(journal.attemptId(equivalentMutation)).not.toBe(
      journal.attemptId(intent),
    );
    expect(await journal.loadByMutation(equivalentMutation)).toMatchObject({
      attemptId: journal.attemptId(intent),
    });
  });

  it("persists refund dispatch independently for legacy orders", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amc-journal-"));
    roots.push(root);
    const journal = new FileCheckoutJournal(new FileSessionStore({ root }));
    const refund: RefundAttempt = {
      version: 1,
      state: "REFUND_DISPATCHING",
      orderToken: "00000000-0000-4000-8000-000000000002",
      orderNumber: "0000000002",
      lineNumbers: ["1"],
      refundTotal: "28.99",
      nonRefundableFee: "2.99",
      updatedAt: "2030-01-15T22:00:00.000Z",
    };

    await journal.withRefundLock(
      refund.orderToken,
      refund.lineNumbers,
      async () => {
        await journal.saveRefund(refund);
      },
    );
    await expect(
      journal.loadRefund(refund.orderToken, refund.lineNumbers),
    ).resolves.toEqual(refund);
  });

  it("fails closed on malformed or unknown-version records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amc-journal-"));
    roots.push(root);
    const sessions = new FileSessionStore({ root });
    const journal = new FileCheckoutJournal(sessions);
    const intent = createIntent();
    await sessions.save(
      journal.key(intent),
      Buffer.from('{"version":2,"state":"PREPARED"}', "utf8"),
    );

    await expect(journal.load(intent)).rejects.toBeInstanceOf(
      CheckoutJournalCorruptError,
    );
  });
});

function createIntent(): CartCreateIntent {
  return {
    showtimeId: "900000005",
    seats: [
      {
        name: "H7",
        sku: "TICKET-RS-900000005-ADULT",
        quantity: 1,
        row: 9,
        column: 17,
      },
      {
        name: "H8",
        sku: "TICKET-RS-900000005-ADULT",
        quantity: 1,
        row: 9,
        column: 16,
      },
    ],
    waiveSubscriptionDiscounts: false,
    expectedTotal: "55.56",
    holdAcknowledgement: "CREATE_HOLD",
  };
}
