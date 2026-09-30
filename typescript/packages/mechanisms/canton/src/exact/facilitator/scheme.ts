/**
 * Canton facilitator implementation of the `exact` scheme.
 *
 * `verify` proves the payer-signed inline transfer against the merchant's
 * requirements (see verify-inline.ts). `settle` re-verifies, then relays the
 * signed transaction through the injected `FacilitatorCantonSigner`
 * (ExecuteSubmission) and reports success only after that read proves funds
 * moved. A timeout or unreadable confirmation is `settlement_pending`. Core
 * retries `settle` once with the same payload; that retry re-reads the same
 * submission and then returns success or a terminal failure. There is no
 * further retry and no replay cache.
 */
import { createHash } from "node:crypto";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  VerifyResponse,
  SettleResponse,
} from "@x402/core/types";
import { CANTON_CAIP_FAMILY } from "../../constants.js";
import type { CantonErrorCode } from "../../types.js";
import type {
  ConfirmSubmissionArgs,
  ExecuteResult,
  FacilitatorCantonSigner,
  CantonSchemeConfig,
} from "../../signer.js";
import { verifyInlineTransfer, type InlineVerifyResult } from "./verify-inline.js";
import { SubmissionOutcomeUnknownError } from "../../ledger/transfer-factory.js";

/** Core non-terminal settle code. `@x402/core` retries `settle` exactly once
 *  when `errorReason` is this value and `transaction` is non-empty. */
const SETTLEMENT_PENDING = "settlement_pending";

/** Cap on in-flight pending settles remembered for that one retry. */
const MAX_PENDING_SETTLES = 256;

/** What one execute/confirm read means for the settle response. */
type ExecuteClass =
  | { kind: "confirmed"; updateId: string }
  | { kind: "pending"; transaction: string }
  | { kind: "rejected"; transaction: string }
  | { kind: "unknown"; transaction: string };

/** One relay waiting for the core pending retry. Dropped on that retry. */
interface PendingSettle extends ConfirmSubmissionArgs {
  transaction: string;
}

/**
 * Classify a funds-moved read. `allowPending` is true only on the first settle
 * of this payload; the retry must resolve to success or a terminal failure.
 *
 * @param exec - The execute or confirm read.
 * @param allowPending - Whether an unreadable confirmation may stay non-terminal.
 * @returns The settle class for this read.
 */
function classifyExecute(exec: ExecuteResult, allowPending: boolean): ExecuteClass {
  const updateId = exec.updateId;
  if (exec.transferred && exec.confirmInconclusive !== true && updateId.length > 0) {
    return { kind: "confirmed", updateId };
  }
  if (exec.confirmInconclusive === true) {
    if (allowPending && updateId.length > 0) return { kind: "pending", transaction: updateId };
    return { kind: "unknown", transaction: updateId };
  }
  return { kind: "rejected", transaction: updateId };
}

/** Options for the Canton facilitator scheme. */
export interface CantonFacilitatorOptions extends CantonSchemeConfig {
  /** The Global Synchronizer id this facilitator settles on, advertised in the
   *  402 `extra.synchronizerId` via {@link ExactCantonScheme.getExtra}. */
  synchronizerId?: string;
  /** The exact Canton networks this scheme serves. When set, requirements on
   *  any other network are rejected with `invalid_network`.
   *  {@link registerExactCantonScheme} sets it from its `networks`. */
  networks?: readonly Network[];
}

/** Facilitator-side `exact` scheme for Canton networks. */
export class ExactCantonScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = CANTON_CAIP_FAMILY;
  /** In-flight relays keyed by the prepared-transaction hash. Holds only what
   *  the single `settlement_pending` retry needs in order to re-read. A later
   *  settle of the same payload relays again. */
  private readonly pendingSettle = new Map<string, PendingSettle>();

  /**
   * Construct the facilitator-side Canton exact scheme.
   *
   * @param signer - Ledger access + facilitator relaying key(s).
   * @param options - Trust anchors, registry config, and the synchronizer id.
   */
  constructor(
    private readonly signer: FacilitatorCantonSigner,
    private readonly options: CantonFacilitatorOptions = {},
  ) {}

  /**
   * Mechanism `extra` for the /supported response: this facilitator's feePayer
   * and the synchronizer it settles on.
   *
   * @param _ - The network identifier (unused; one facilitator identity here).
   * @returns The `{ feePayer, synchronizerId }` extra, or undefined when neither is set.
   */
  getExtra(_: Network): Record<string, unknown> | undefined {
    const feePayer = this.signer.getAddresses()[0];
    const extra: Record<string, unknown> = {};
    if (feePayer) extra.feePayer = feePayer;
    if (this.options.synchronizerId) extra.synchronizerId = this.options.synchronizerId;
    return Object.keys(extra).length > 0 ? extra : undefined;
  }

  /**
   * Facilitator parties that relay (and pay the Global Synchronizer traffic).
   *
   * @param _ - The network identifier (unused).
   * @returns The facilitator relaying parties.
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Validate a payer-signed inline transfer against the merchant's requirements.
   *
   * @param payload - The x402 payment payload (inline carriage).
   * @param requirements - The merchant's payment requirements.
   * @returns Whether the payment is valid, with the proven payer or a reason.
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const r = await verifyInlineTransfer(payload, requirements, this.signer, this.options);
    if (r.ok) {
      return { isValid: true, payer: r.payer };
    }
    return {
      isValid: false,
      invalidReason: r.reason ?? "invalid_exact_canton_malformed_payload",
      ...(r.payer ? { payer: r.payer } : {}),
    };
  }

  /**
   * Verify, then relay the signed transaction and confirm funds moved.
   * Success requires that confirmation. A timeout or unreadable confirmation
   * returns `settlement_pending` so core can retry this call once.
   *
   * @param payload - The x402 payment payload (inline carriage).
   * @param requirements - The merchant's payment requirements.
   * @returns The settlement result: on success the on-ledger updateId.
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const network = requirements.network;
    const v = await verifyInlineTransfer(payload, requirements, this.signer, this.options);
    // Nothing is submitted without the transfer kind verify established: a
    // wrong funds-moved signal would misreport a delivered payment.
    if (!v.ok || !v.preparedTransactionBytes || !v.transferKind) {
      return this.settleFailure(
        v.reason ?? "invalid_exact_canton_malformed_payload",
        network,
        v.payer,
      );
    }

    const key = createHash("sha256").update(v.preparedTransactionBytes).digest("hex");
    const pending = this.pendingSettle.get(key);
    if (pending) {
      this.pendingSettle.delete(key);
      return this.confirmPending(pending, network);
    }

    let exec: ExecuteResult;
    try {
      exec = await this.signer.executeSubmission({
        preparedTransactionBytes: v.preparedTransactionBytes,
        signatureB64: v.signatureB64 ?? "",
        payer: v.payer,
        hashingSchemeVersion: v.hashingSchemeVersion ?? "HASHING_SCHEME_VERSION_V2",
        // Verify established the transfer kind from the signed bytes and the
        // signer's registry map; settle uses that, never a second lookup.
        transferKind: v.transferKind,
      });
    } catch (err) {
      return this.settleFromExecuteError(err, key, v, network);
    }
    return this.settleFromExecuteResult(exec, key, v.payer, v.transferKind, network);
  }

  /**
   * Map a successful relay's funds-moved read onto success, pending, or failure.
   *
   * @param exec - The execute read.
   * @param key - Prepared-transaction hash for the one pending retry.
   * @param payer - The proven payer.
   * @param transferKind - Funds-moved signal verify selected.
   * @param network - The requirements' network.
   * @returns The settle response.
   */
  private settleFromExecuteResult(
    exec: ExecuteResult,
    key: string,
    payer: string,
    transferKind: "amulet" | "registry",
    network: Network,
  ): SettleResponse {
    const classified = classifyExecute(exec, true);
    if (classified.kind === "pending") {
      this.rememberPending(key, {
        transaction: classified.transaction,
        payer,
        transferKind,
        updateId: exec.updateId,
      });
    }
    return this.responseForClass(classified, network, payer);
  }

  /**
   * Map an execute throw. A definite refusal is terminal and retryable by the
   * payer with fresh inputs. An unknown outcome that names the submission is
   * the one non-terminal pending response. An unknown outcome with no id is
   * terminal: core cannot retry a pending settle that has no transaction.
   *
   * @param err - The error thrown by `executeSubmission`.
   * @param key - Prepared-transaction hash for the one pending retry.
   * @param verified - The verify result, including payer and transfer kind.
   * @param network - The requirements' network.
   * @returns The settle response.
   */
  private settleFromExecuteError(
    err: unknown,
    key: string,
    verified: InlineVerifyResult,
    network: Network,
  ): SettleResponse {
    if (!(err instanceof SubmissionOutcomeUnknownError)) {
      return this.settleFailure("invalid_exact_canton_execute_failed", network, verified.payer);
    }
    const transaction = err.context.updateId || err.context.submissionId || "";
    if (!transaction || !verified.transferKind) {
      return this.settleFailure("unexpected_canton_ledger_error", network, verified.payer);
    }
    this.rememberPending(key, {
      transaction,
      payer: verified.payer,
      transferKind: verified.transferKind,
      ...(err.context.updateId !== undefined ? { updateId: err.context.updateId } : {}),
      ...(err.context.submissionId !== undefined ? { submissionId: err.context.submissionId } : {}),
      ...(err.context.beginExclusive !== undefined
        ? { beginExclusive: err.context.beginExclusive }
        : {}),
    });
    return this.settlePending(transaction, network, verified.payer);
  }

  /**
   * The one core retry: re-read the relay already submitted. Success only if
   * that read proves funds moved. Still unreadable, or no confirm hook, is a
   * terminal ledger error. A definite non-delivery is `execute_failed`.
   *
   * @param pending - The relay recorded when this payload first returned pending.
   * @param network - The requirements' network.
   * @returns The settle response. Never `settlement_pending`.
   */
  private async confirmPending(pending: PendingSettle, network: Network): Promise<SettleResponse> {
    const confirm = this.signer.confirmSubmission;
    if (!confirm) {
      return this.settleFailure(
        "unexpected_canton_ledger_error",
        network,
        pending.payer,
        pending.transaction,
      );
    }
    try {
      const exec = await confirm({
        payer: pending.payer,
        transferKind: pending.transferKind,
        ...(pending.updateId !== undefined ? { updateId: pending.updateId } : {}),
        ...(pending.submissionId !== undefined ? { submissionId: pending.submissionId } : {}),
        ...(pending.beginExclusive !== undefined ? { beginExclusive: pending.beginExclusive } : {}),
      });
      return this.responseForClass(classifyExecute(exec, false), network, pending.payer);
    } catch {
      return this.settleFailure(
        "unexpected_canton_ledger_error",
        network,
        pending.payer,
        pending.transaction,
      );
    }
  }

  /**
   * Remember one in-flight relay for the pending retry, dropping the oldest
   * entry when the map is at its cap.
   *
   * @param key - Prepared-transaction hash.
   * @param pending - What the retry needs in order to re-read.
   */
  private rememberPending(key: string, pending: PendingSettle): void {
    const atCapacity =
      this.pendingSettle.size >= MAX_PENDING_SETTLES && !this.pendingSettle.has(key);
    if (atCapacity) {
      const oldest = this.pendingSettle.keys().next().value;
      if (typeof oldest === "string") this.pendingSettle.delete(oldest);
    }
    this.pendingSettle.set(key, pending);
  }

  /**
   * Build the settle response for a classified read.
   *
   * @param classified - The funds-moved classification.
   * @param network - The requirements' network.
   * @param payer - The proven payer.
   * @returns The settle response.
   */
  private responseForClass(
    classified: ExecuteClass,
    network: Network,
    payer: string,
  ): SettleResponse {
    switch (classified.kind) {
      case "confirmed":
        return { success: true, payer, transaction: classified.updateId, network };
      case "pending":
        return this.settlePending(classified.transaction, network, payer);
      case "rejected":
        return this.settleFailure(
          "invalid_exact_canton_execute_failed",
          network,
          payer,
          classified.transaction,
        );
      case "unknown":
        return this.settleFailure(
          "unexpected_canton_ledger_error",
          network,
          payer,
          classified.transaction,
        );
      default: {
        const unexpected: never = classified;
        throw new Error(`unexpected settle class: ${String(unexpected)}`);
      }
    }
  }

  /**
   * Build the non-terminal pending response. `transaction` must be non-empty
   * or core will not retry.
   *
   * @param transaction - Update id, or the submission id when the update is not known yet.
   * @param network - The requirements' network.
   * @param payer - The proven payer.
   * @returns The pending settle response.
   */
  private settlePending(transaction: string, network: Network, payer: string): SettleResponse {
    return {
      success: false,
      errorReason: SETTLEMENT_PENDING,
      transaction,
      network,
      ...(payer ? { payer } : {}),
    };
  }

  /**
   * Build a failed SettleResponse.
   *
   * @param reason - The Canton error code.
   * @param network - The requirements' network.
   * @param payer - The proven payer, when known.
   * @param transaction - Update or submission id, when one is known.
   * @returns The failure response.
   */
  private settleFailure(
    reason: CantonErrorCode,
    network: Network,
    payer: string,
    transaction = "",
  ): SettleResponse {
    return {
      success: false,
      errorReason: reason,
      transaction,
      network,
      ...(payer ? { payer } : {}),
    };
  }
}
