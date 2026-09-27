/**
 * Solana RPC helpers for Swig e2e setup.
 *
 * Public devnet is a free-tier endpoint. One setup run creates a Swig account,
 * an ATA, and a funding transfer, and each confirmation polls signature status.
 * Shared CI IPs hit HTTP 429 (`HTTP error (429): Too Many Requests`) on that
 * burst. The kit transport does not retry, so the setup process exits.
 */

import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type Rpc,
  type RpcTransport,
  type SolanaRpcApi,
} from "@solana/kit";

/** Public devnet fallback when neither SVM_RPC_URL nor SVM_TESTNET_RPC_URL is set. */
export const DEVNET_RPC_URL = "https://api.devnet.solana.com";

const RPC_RATE_LIMIT_ATTEMPTS = 6;
const RPC_RATE_LIMIT_BASE_DELAY_MS = 1_000;
const RPC_RATE_LIMIT_MAX_DELAY_MS = 30_000;

const PUBLIC_DEVNET_POLL_MS = 1_000;
const DEDICATED_RPC_INITIAL_POLL_MS = 250;
const DEDICATED_RPC_INITIAL_WINDOW_MS = 2_000;
const DEDICATED_RPC_FALLBACK_POLL_MS = 1_000;

type Sleep = (ms: number) => Promise<void>;

export type RpcRateLimitRetryOptions = {
  sleep?: Sleep;
  maxAttempts?: number;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * SVM_RPC_URL wins when the workflow or harness sets it. SVM_TESTNET_RPC_URL is
 * the catalog override stored in e2e/.env. Blank values fall through to public devnet.
 */
export function resolveSwigRpcUrl(input: { svmRpcUrl?: string; svmTestnetRpcUrl?: string }): string {
  const explicit = input.svmRpcUrl?.trim();
  if (explicit) {
    return explicit;
  }
  const testnet = input.svmTestnetRpcUrl?.trim();
  if (testnet) {
    return testnet;
  }
  return DEVNET_RPC_URL;
}

export function isRetryableRpcRateLimit(error: unknown): boolean {
  if (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    return error.context.statusCode === 429;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("429") && error.message.includes("Too Many Requests");
}

function retryAfterHeader(error: unknown): string | null {
  if (!isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    return null;
  }
  return error.context.headers.get("retry-after");
}

/**
 * Prefer a positive Retry-After (delta-seconds or HTTP-date). Otherwise use
 * exponential backoff. Both are capped so a bad header cannot stall setup.
 */
export function rpcRateLimitDelayMs(
  attempt: number,
  retryAfter: string | null,
  nowMs: number = Date.now(),
): number {
  if (retryAfter !== null) {
    const trimmed = retryAfter.trim();
    if (/^\d+$/.test(trimmed)) {
      const delay = Number(trimmed) * 1_000;
      if (delay > 0) {
        return Math.min(delay, RPC_RATE_LIMIT_MAX_DELAY_MS);
      }
    } else {
      const retryDate = Date.parse(retryAfter);
      if (!Number.isNaN(retryDate)) {
        const delay = retryDate - nowMs;
        if (delay > 0) {
          return Math.min(delay, RPC_RATE_LIMIT_MAX_DELAY_MS);
        }
      }
    }
  }

  const exponential = RPC_RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt;
  return Math.min(exponential, RPC_RATE_LIMIT_MAX_DELAY_MS);
}

/**
 * Retry HTTP 429 from the Solana RPC transport.
 * The same signed transaction bytes are submitted again; a signature the
 * cluster already processed is rejected, so a retried send is idempotent.
 */
export function withRpcRateLimitRetry(
  inner: RpcTransport,
  options: RpcRateLimitRetryOptions = {},
): RpcTransport {
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? RPC_RATE_LIMIT_ATTEMPTS;

  return async <TResponse>(config: Parameters<RpcTransport>[0]): Promise<TResponse> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await inner<TResponse>(config);
      } catch (error) {
        lastError = error;
        if (!isRetryableRpcRateLimit(error) || attempt === maxAttempts - 1) {
          throw error;
        }
        const delayMs = rpcRateLimitDelayMs(attempt, retryAfterHeader(error));
        console.log(
          `⏳ Solana RPC rate limited (429); retrying in ${delayMs}ms (${attempt + 1}/${maxAttempts - 1})`,
        );
        await sleep(delayMs);
      }
    }
    throw lastError;
  };
}

export function createRateLimitedSolanaRpc(rpcUrl: string): Rpc<SolanaRpcApi> {
  const transport = withRpcRateLimitRetry(createDefaultRpcTransport({ url: rpcUrl }));
  return createSolanaRpcFromTransport(transport);
}

/**
 * Dedicated RPCs keep the facilitator signer's 250ms-then-1s poll. Public
 * devnet uses 1s so create + ATA confirmation does not burn the free-tier budget
 * before the funding transfer.
 */
export function signaturePollDelayMs(rpcUrl: string, elapsedMs: number): number {
  if (rpcUrl === DEVNET_RPC_URL) {
    return PUBLIC_DEVNET_POLL_MS;
  }
  if (elapsedMs < DEDICATED_RPC_INITIAL_WINDOW_MS) {
    return DEDICATED_RPC_INITIAL_POLL_MS;
  }
  return DEDICATED_RPC_FALLBACK_POLL_MS;
}
