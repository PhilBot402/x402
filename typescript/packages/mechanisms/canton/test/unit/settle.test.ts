/**
 * Facilitator settle reports success only when the funds-moved read proves
 * delivery. An unreadable confirmation is settlement_pending once; the next
 * settle re-reads and then succeeds or fails terminally. It does not relay
 * again, and it does not keep a replay cache after that retry.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactCantonScheme } from "../../src/exact/facilitator/scheme.js";
import { encodeInlinePaymentPayload } from "../../src/inline-payload.js";
import { SubmissionOutcomeUnknownError } from "../../src/ledger/transfer-factory.js";
import { decodePrepared } from "../../src/prepared-transfer.js";
import type { ExecuteResult, FacilitatorCantonSigner } from "../../src/signer.js";

const FIX = fileURLToPath(new URL("../../src/__fixtures__/", import.meta.url));
const CC_RAW = readFileSync(FIX + "mainnet-transfer-preapproval-0.1.21.b64", "utf8").trim();
const CC = JSON.parse(readFileSync(FIX + "mainnet-0.1.21.json", "utf8")).transfer as {
  sender: string;
  receiver: string;
  amount: string;
  instrumentId: { admin: string; id: string };
};
const FAC = "facilitator::1220" + "ff".repeat(32);
const NETWORK = "canton:mainnet" as const;
const CC_FACTORY = (() => {
  const decoded = decodePrepared(CC_RAW);
  return decoded.nodes.find(node => node.nodeId === decoded.roots[0])!.exercise!.contractId!;
})();

beforeEach(() => {
  const prep = decodePrepared(CC_RAW).preparationTime ?? 0n;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Number(prep / 1000n) + 1000);
});
afterEach(() => vi.useRealTimers());

function payload(): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "exact", network: NETWORK } as never,
    payload: {
      ...encodeInlinePaymentPayload({
        preparedTransactionBytes: Buffer.from(CC_RAW, "base64"),
        preparedTxHash: "ab".repeat(32),
        signatureB64: Buffer.alloc(64, 7).toString("base64"),
      }),
    },
  };
}

function requirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: "100000000",
    asset: "CC",
    payTo: CC.receiver,
    maxTimeoutSeconds: 60,
    extra: {
      assetTransferMethod: "transfer-factory",
      feePayer: FAC,
      instrumentId: CC.instrumentId,
      executeBeforeSeconds: 120,
    },
  };
}

function signer(over: Partial<FacilitatorCantonSigner> = {}): FacilitatorCantonSigner {
  return {
    getAddresses: () => [FAC],
    verifySignature: async () => ({ verified: true, preparedTxHashHex: "cd".repeat(32) }),
    fetchPreapproval: async () => ({
      receiver: CC.receiver,
      dso: CC.instrumentId.admin,
      expiresAt: new Date(Date.now() + 1_000_000_000).toISOString(),
    }),
    registryBaseUrl: () => undefined,
    resolveTransferFactoryId: async () => CC_FACTORY,
    executeSubmission: async () => ({ updateId: "1220-settled", transferred: true }),
    ...over,
  };
}

describe("ExactCantonScheme.settle", () => {
  it("returns success only when the read proves funds moved", async () => {
    const scheme = new ExactCantonScheme(signer());
    const settle = await scheme.settle(payload(), requirements());
    expect(settle).toMatchObject({ success: true, transaction: "1220-settled" });
  });

  it("returns execute_failed when the committed transfer did not deliver", async () => {
    const scheme = new ExactCantonScheme(
      signer({
        executeSubmission: async () => ({
          updateId: "1220-empty",
          transferred: false,
          confirmInconclusive: false,
        }),
      }),
    );
    const settle = await scheme.settle(payload(), requirements());
    expect(settle.success).toBe(false);
    expect(settle.errorReason).toBe("invalid_exact_canton_execute_failed");
    expect(settle.transaction).toBe("1220-empty");
  });

  it("returns settlement_pending when confirmation is unreadable, then succeeds on one re-read", async () => {
    const executes: string[] = [];
    const confirms: string[] = [];
    const scheme = new ExactCantonScheme(
      signer({
        executeSubmission: async () => {
          executes.push("execute");
          const pending: ExecuteResult = {
            updateId: "1220-pending",
            transferred: false,
            confirmInconclusive: true,
          };
          return pending;
        },
        confirmSubmission: async args => {
          confirms.push(args.updateId ?? "");
          return { updateId: "1220-pending", transferred: true };
        },
      }),
    );

    const first = await scheme.settle(payload(), requirements());
    expect(first).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
      transaction: "1220-pending",
    });

    const second = await scheme.settle(payload(), requirements());
    expect(second).toMatchObject({ success: true, transaction: "1220-pending" });
    expect(executes).toEqual(["execute"]);
    expect(confirms).toEqual(["1220-pending"]);
  });

  it("the pending retry fails terminally when the re-read is still unreadable", async () => {
    const executes: string[] = [];
    const scheme = new ExactCantonScheme(
      signer({
        executeSubmission: async () => {
          executes.push("execute");
          return { updateId: "1220-pending", transferred: false, confirmInconclusive: true };
        },
        confirmSubmission: async () => ({
          updateId: "1220-pending",
          transferred: false,
          confirmInconclusive: true,
        }),
      }),
    );

    const first = await scheme.settle(payload(), requirements());
    expect(first.errorReason).toBe("settlement_pending");

    const second = await scheme.settle(payload(), requirements());
    expect(second.success).toBe(false);
    expect(second.errorReason).toBe("unexpected_canton_ledger_error");
    expect(second.transaction).toBe("1220-pending");
    expect(executes).toEqual(["execute"]);
  });

  it("does not keep the pending entry after the retry, so a later settle relays again", async () => {
    let calls = 0;
    const scheme = new ExactCantonScheme(
      signer({
        executeSubmission: async () => {
          calls += 1;
          return { updateId: "1220-pending", transferred: false, confirmInconclusive: true };
        },
        confirmSubmission: async () => ({
          updateId: "1220-pending",
          transferred: false,
          confirmInconclusive: true,
        }),
      }),
    );

    await scheme.settle(payload(), requirements());
    await scheme.settle(payload(), requirements());
    const third = await scheme.settle(payload(), requirements());
    expect(third.errorReason).toBe("settlement_pending");
    expect(calls).toBe(2);
  });

  it("returns settlement_pending for an unknown execute that names the submission", async () => {
    const scheme = new ExactCantonScheme(
      signer({
        executeSubmission: async () => {
          throw new SubmissionOutcomeUnknownError(new Error("timeout"), {
            submissionId: "sub-1",
            beginExclusive: 4,
          });
        },
        confirmSubmission: async args => {
          expect(args.submissionId).toBe("sub-1");
          expect(args.beginExclusive).toBe(4);
          return { updateId: "1220-later", transferred: true };
        },
      }),
    );

    const first = await scheme.settle(payload(), requirements());
    expect(first).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
      transaction: "sub-1",
    });
    const second = await scheme.settle(payload(), requirements());
    expect(second).toMatchObject({ success: true, transaction: "1220-later" });
  });

  it("returns a terminal ledger error when an unknown execute names no submission", async () => {
    const scheme = new ExactCantonScheme(
      signer({
        executeSubmission: async () => {
          throw new SubmissionOutcomeUnknownError(new Error("timeout"));
        },
      }),
    );
    const settle = await scheme.settle(payload(), requirements());
    expect(settle.success).toBe(false);
    expect(settle.errorReason).toBe("unexpected_canton_ledger_error");
    expect(settle.transaction).toBe("");
  });

  it("returns execute_failed for a definite execute refusal", async () => {
    const scheme = new ExactCantonScheme(
      signer({
        executeSubmission: async () => {
          throw new Error("SUBMISSION_FAILED");
        },
      }),
    );
    const settle = await scheme.settle(payload(), requirements());
    expect(settle.errorReason).toBe("invalid_exact_canton_execute_failed");
  });
});
