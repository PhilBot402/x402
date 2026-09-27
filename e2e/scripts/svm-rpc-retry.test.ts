import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError, type RpcTransport } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import {
  DEVNET_RPC_URL,
  isRetryableRpcRateLimit,
  resolveSwigRpcUrl,
  rpcRateLimitDelayMs,
  signaturePollDelayMs,
  withRpcRateLimitRetry,
} from "./svm-rpc-retry";

function httpError(statusCode: number, retryAfter?: string): SolanaError {
  const headers = new Headers();
  if (retryAfter !== undefined) {
    headers.set("retry-after", retryAfter);
  }
  return new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    headers,
    message: statusCode === 429 ? "Too Many Requests" : "Server Error",
    statusCode,
  });
}

describe("resolveSwigRpcUrl", () => {
  it("prefers SVM_RPC_URL, then SVM_TESTNET_RPC_URL, then public devnet", () => {
    expect(
      resolveSwigRpcUrl({
        svmRpcUrl: "https://private.example",
        svmTestnetRpcUrl: "https://catalog.example",
      }),
    ).toBe("https://private.example");
    expect(resolveSwigRpcUrl({ svmTestnetRpcUrl: "https://catalog.example" })).toBe(
      "https://catalog.example",
    );
    expect(resolveSwigRpcUrl({})).toBe(DEVNET_RPC_URL);
  });

  it("treats blank values as unset", () => {
    expect(
      resolveSwigRpcUrl({
        svmRpcUrl: "  ",
        svmTestnetRpcUrl: " https://catalog.example ",
      }),
    ).toBe("https://catalog.example");
    expect(resolveSwigRpcUrl({ svmRpcUrl: "", svmTestnetRpcUrl: " " })).toBe(DEVNET_RPC_URL);
  });
});

describe("isRetryableRpcRateLimit", () => {
  it("retries only HTTP 429", () => {
    expect(isRetryableRpcRateLimit(httpError(429))).toBe(true);
    expect(isRetryableRpcRateLimit(httpError(500))).toBe(false);
    expect(isRetryableRpcRateLimit(new Error("HTTP error (429): Too Many Requests"))).toBe(true);
    expect(isRetryableRpcRateLimit(new Error("Transaction failed onchain"))).toBe(false);
    expect(isRetryableRpcRateLimit("429")).toBe(false);
  });
});

describe("rpcRateLimitDelayMs", () => {
  const nowMs = 1_700_000_000_000;

  it("uses exponential backoff when Retry-After is missing or unusable", () => {
    expect(rpcRateLimitDelayMs(0, null, nowMs)).toBe(1_000);
    expect(rpcRateLimitDelayMs(1, null, nowMs)).toBe(2_000);
    expect(rpcRateLimitDelayMs(4, null, nowMs)).toBe(16_000);
    expect(rpcRateLimitDelayMs(5, null, nowMs)).toBe(30_000);
    expect(rpcRateLimitDelayMs(0, "0", nowMs)).toBe(1_000);
    expect(rpcRateLimitDelayMs(0, "soon", nowMs)).toBe(1_000);
  });

  it("honors Retry-After and caps it", () => {
    expect(rpcRateLimitDelayMs(4, "2", nowMs)).toBe(2_000);
    expect(rpcRateLimitDelayMs(0, " 3 ", nowMs)).toBe(3_000);
    expect(rpcRateLimitDelayMs(0, "120", nowMs)).toBe(30_000);
    expect(rpcRateLimitDelayMs(0, new Date(nowMs + 5_000).toUTCString(), nowMs)).toBe(5_000);
  });
});

describe("signaturePollDelayMs", () => {
  it("polls public devnet once per second", () => {
    expect(signaturePollDelayMs(DEVNET_RPC_URL, 0)).toBe(1_000);
    expect(signaturePollDelayMs(DEVNET_RPC_URL, 5_000)).toBe(1_000);
  });

  it("keeps the short initial poll for a dedicated RPC", () => {
    const dedicated = "https://private.example";
    expect(signaturePollDelayMs(dedicated, 0)).toBe(250);
    expect(signaturePollDelayMs(dedicated, 1_999)).toBe(250);
    expect(signaturePollDelayMs(dedicated, 2_000)).toBe(1_000);
  });
});

describe("withRpcRateLimitRetry", () => {
  it("retries HTTP 429 and then returns the successful response", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const inner: RpcTransport = async () => {
      calls += 1;
      if (calls < 3) {
        throw httpError(429, "1");
      }
      return { ok: true } as never;
    };

    const transport = withRpcRateLimitRetry(inner, {
      sleep: async ms => {
        sleeps.push(ms);
      },
    });

    await expect(transport({ payload: { method: "getLatestBlockhash" } })).resolves.toEqual({
      ok: true,
    });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1_000, 1_000]);
  });

  it("does not retry other HTTP statuses", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const inner: RpcTransport = async () => {
      calls += 1;
      throw httpError(500);
    };

    const transport = withRpcRateLimitRetry(inner, { sleep });
    await expect(transport({ payload: { method: "sendTransaction" } })).rejects.toThrow(
      "HTTP error (500)",
    );
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops after the attempt budget", async () => {
    let calls = 0;
    const inner: RpcTransport = async () => {
      calls += 1;
      throw new Error("HTTP error (429): Too Many Requests");
    };

    const transport = withRpcRateLimitRetry(inner, {
      maxAttempts: 2,
      sleep: async () => {},
    });
    await expect(transport({ payload: { method: "sendTransaction" } })).rejects.toThrow(
      "HTTP error (429): Too Many Requests",
    );
    expect(calls).toBe(2);
  });
});
