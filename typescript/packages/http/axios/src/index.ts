import { createRequire } from "node:module";
import * as http from "node:http";
import * as https from "node:https";
import { x402Client, x402ClientConfig, x402HTTPClient } from "@x402/core/client";
import {
  MAX_CONTROL_PLANE_RESPONSE_BYTES,
  readLimitedBody,
  ResponseBodyTooLargeError,
} from "@x402/core/http";
import { type PaymentRequired } from "@x402/core/types";
import { type AxiosInstance, type AxiosError, type InternalAxiosRequestConfig } from "axios";

type X402RetryConfig = InternalAxiosRequestConfig & { __is402Retry?: boolean };
type AxiosHeaderRecord = Record<string, string>;
type AxiosNodeTransport = {
  request: (
    options: http.RequestOptions & { protocol?: string },
    callback: (response: http.IncomingMessage) => void,
  ) => http.ClientRequest;
};

const CONTROL_PLANE_LIMITED: unique symbol = Symbol("x402ControlPlaneLimited");
const require = createRequire(import.meta.url);

type DownloadLimitedConfig = InternalAxiosRequestConfig & {
  [CONTROL_PLANE_LIMITED]?: boolean;
};

/**
 * Resolves the final absolute URL for an Axios 402 response.
 *
 * @param config - Original Axios request configuration
 * @param response - Axios error response, if present
 * @returns Absolute request URL (prefers final URL after redirects)
 */
function resolveAxiosRequestUrl(
  config: InternalAxiosRequestConfig,
  response?: AxiosError["response"],
): string {
  const responseUrl =
    (response?.request as { responseURL?: string } | undefined)?.responseURL ??
    (response?.request as { res?: { responseUrl?: string } } | undefined)?.res?.responseUrl;

  if (responseUrl) {
    return responseUrl;
  }

  const url = config.url ?? "";
  if (config.baseURL) {
    try {
      return new URL(url, config.baseURL).href;
    } catch {
      return url || config.baseURL;
    }
  }

  return url;
}

/**
 * Clones Axios headers into a plain record so the caller's Axios instance can
 * normalize them for the retry request.
 *
 * @param headers - Headers from the caller's original Axios request config.
 * @returns Serializable headers for Axios to normalize in the caller's instance.
 */
function cloneAxiosHeaders(headers: InternalAxiosRequestConfig["headers"]): AxiosHeaderRecord {
  const source =
    typeof headers.toJSON === "function"
      ? (headers.toJSON() as Record<string, unknown>)
      : (headers as unknown as Record<string, unknown>);

  return Object.entries(source).reduce<AxiosHeaderRecord>((acc, [key, value]) => {
    if (value !== undefined && value !== null && typeof value !== "function") {
      acc[key] = String(value);
    }

    return acc;
  }, {});
}

/**
 * Sets a header on a retry header record.
 *
 * @param headers - Headers object to update.
 * @param key - Header name.
 * @param value - Header value.
 */
function setAxiosHeader(headers: AxiosHeaderRecord, key: string, value: string): void {
  headers[key] = value;
}

/**
 * Loads axios's follow-redirects transport so wrapping `config.transport`
 * does not disable redirects.
 *
 * @returns The follow-redirects http/https transports, if resolvable
 */
function loadFollowRedirects():
  | { http: AxiosNodeTransport; https: AxiosNodeTransport }
  | undefined {
  try {
    const axiosPackage = require.resolve("axios/package.json");
    return createRequire(axiosPackage)("follow-redirects") as {
      http: AxiosNodeTransport;
      https: AxiosNodeTransport;
    };
  } catch {
    return undefined;
  }
}

/**
 * Chooses the Node transport axios would have used for this request.
 *
 * @param config - Axios request configuration
 * @returns The http, https, or follow-redirects transport
 */
function resolveNodeTransport(config: InternalAxiosRequestConfig): AxiosNodeTransport {
  if (config.transport) {
    return config.transport as AxiosNodeTransport;
  }

  const url = config.url ?? "";
  const isHttpsRequest =
    /^https:/i.test(url) || (!/^http:/i.test(url) && /^https:/i.test(config.baseURL ?? ""));
  if (config.maxRedirects === 0) {
    return isHttpsRequest ? https : http;
  }

  const follow = loadFollowRedirects();
  if (!follow) {
    return isHttpsRequest ? https : http;
  }
  return isHttpsRequest ? follow.https : follow.http;
}

/**
 * Caps axios's in-adapter buffer when the status is already known to be 402.
 *
 * @param config - Axios request configuration to mutate
 */
function applyControlPlaneDownloadLimit(config: DownloadLimitedConfig): void {
  const current = config.maxContentLength;
  if (current == null || current < 0 || current > MAX_CONTROL_PLANE_RESPONSE_BYTES) {
    config.maxContentLength = MAX_CONTROL_PLANE_RESPONSE_BYTES;
  }
  config[CONTROL_PLANE_LIMITED] = true;
}

/**
 * Wraps a Node transport so a 402 applies {@link applyControlPlaneDownloadLimit}
 * before axios starts buffering chunks.
 *
 * @param transport - Axios or follow-redirects transport
 * @param config - Axios request configuration closed over by the adapter
 * @returns A transport that limits 402 bodies during download
 */
function wrapNodeTransport(
  transport: AxiosNodeTransport,
  config: DownloadLimitedConfig,
): AxiosNodeTransport {
  return {
    request(options, callback) {
      return transport.request(options, response => {
        if (response.statusCode === 402) {
          applyControlPlaneDownloadLimit(config);
        }
        callback(response);
      });
    },
  };
}

/**
 * Wraps the fetch used by axios's fetch adapter so a 402 body is read through
 * {@link readLimitedBody} before axios buffers it.
 *
 * @param config - Axios request configuration to mutate
 */
function wrapFetchForControlPlane(config: DownloadLimitedConfig): void {
  const inner = config.env?.fetch ?? globalThis.fetch.bind(globalThis);
  config.env = {
    ...config.env,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await inner(input, init);
      if (response.status !== 402) {
        return response;
      }
      const text = await readLimitedBody(response);
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  };
}

/**
 * Installs download-time 402 caps on the axios http and fetch adapters.
 *
 * @param config - Axios request configuration
 * @returns The same config, with transport and fetch wrappers installed
 */
function installDownloadLimits(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
  const limited = config as DownloadLimitedConfig;
  wrapFetchForControlPlane(limited);
  if (typeof process !== "undefined" && process.versions?.node) {
    limited.transport = wrapNodeTransport(resolveNodeTransport(limited), limited);
  }
  return limited;
}

/**
 * Maps adapter-level overflow errors back to {@link ResponseBodyTooLargeError}.
 *
 * @param error - Rejection from axios or a wrapped fetch adapter
 * @returns The size-limit error when this was a 402 overflow, otherwise undefined
 */
function controlPlaneLimitError(error: unknown): ResponseBodyTooLargeError | undefined {
  if (error instanceof ResponseBodyTooLargeError) {
    return error;
  }
  if (error instanceof Error && error.cause instanceof ResponseBodyTooLargeError) {
    return error.cause;
  }

  const axiosError = error as AxiosError & { cause?: unknown };
  if (axiosError.cause instanceof ResponseBodyTooLargeError) {
    return axiosError.cause;
  }

  const config = axiosError.config as DownloadLimitedConfig | undefined;
  if (
    config?.[CONTROL_PLANE_LIMITED] &&
    axiosError.code === "ERR_BAD_RESPONSE" &&
    typeof axiosError.message === "string" &&
    axiosError.message.includes("maxContentLength")
  ) {
    return new ResponseBodyTooLargeError(MAX_CONTROL_PLANE_RESPONSE_BYTES);
  }

  return undefined;
}

/**
 * Converts an Axios response body into a fetch BodyInit so {@link readLimitedBody}
 * can apply the same control-plane cap used by the fetch client.
 *
 * @param data - Axios `response.data` for a 402 payment-required response
 * @returns A BodyInit that {@link readLimitedBody} can stream, or null when empty
 */
function toAxiosBodyInit(data: unknown): BodyInit | null {
  if (data == null) {
    return null;
  }
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    return data;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data;
  }
  if (typeof ReadableStream !== "undefined" && data instanceof ReadableStream) {
    return data;
  }
  return JSON.stringify(data);
}

/**
 * Clones an Axios internal request config so a retry can treat HTTP 402 as a successful
 * response status for validation (so the interceptor can handle payment flow).
 *
 * @param config - Original Axios request configuration for the outgoing request.
 * @returns Request config with copied headers and validateStatus that returns true for 402.
 */
function createX402RetryConfig(config: InternalAxiosRequestConfig): X402RetryConfig {
  const originalValidateStatus = config.validateStatus;

  return {
    ...config,
    headers: cloneAxiosHeaders(config.headers) as InternalAxiosRequestConfig["headers"],
    validateStatus: status => {
      if (status === 402) {
        return true;
      }

      return originalValidateStatus
        ? originalValidateStatus(status)
        : status >= 200 && status < 300;
    },
  };
}

/**
 * Wraps an Axios instance with x402 payment handling.
 *
 * This function adds an interceptor to automatically handle 402 Payment Required responses
 * by creating and sending payment headers. It will:
 * 1. Intercept 402 responses
 * 2. Parse the payment requirements
 * 3. Create a payment header using the configured x402HTTPClient
 * 4. Retry the request with the payment header
 *
 * @param axiosInstance - The Axios instance to wrap
 * @param client - Configured x402Client instance for handling payments
 * @returns The wrapped Axios instance that handles 402 responses automatically
 *
 * @example
 * ```typescript
 * import axios from 'axios';
 * import { wrapAxiosWithPayment, x402Client } from '@x402/axios';
 * import { ExactEvmScheme } from '@x402/evm';
 * import { privateKeyToAccount } from 'viem/accounts';
 *
 * const account = privateKeyToAccount('0x...');
 * const client = new x402Client()
 *   .register('eip155:*', new ExactEvmScheme(account));
 *
 * const api = wrapAxiosWithPayment(axios.create(), client);
 *
 * // Make a request that may require payment
 * const response = await api.get('https://api.example.com/paid-endpoint');
 * ```
 *
 * @throws {Error} If no schemes are provided
 * @throws {Error} If the request configuration is missing
 * @throws {Error} If a payment has already been attempted for this request
 * @throws {Error} If there's an error creating the payment header
 */
export function wrapAxiosWithPayment(
  axiosInstance: AxiosInstance,
  client: x402Client | x402HTTPClient,
): AxiosInstance {
  const httpClient = client instanceof x402HTTPClient ? client : new x402HTTPClient(client);

  if (typeof axiosInstance.defaults.adapter !== "function") {
    axiosInstance.defaults.adapter = ["http", "fetch", "xhr"];
  }
  axiosInstance.interceptors.request.use(installDownloadLimits);

  axiosInstance.interceptors.response.use(
    response => response,
    async (error: AxiosError) => {
      const tooLarge = controlPlaneLimitError(error);
      if (tooLarge) {
        return Promise.reject(tooLarge);
      }

      if (!error.response || error.response.status !== 402) {
        return Promise.reject(error);
      }

      const originalConfig = error.config;
      if (!originalConfig || !originalConfig.headers) {
        return Promise.reject(new Error("Missing axios request configuration"));
      }

      // Check if this is already a retry to prevent infinite loops
      if ((originalConfig as X402RetryConfig).__is402Retry) {
        return Promise.reject(error);
      }

      try {
        const response = error.response!; // Already validated above
        await readLimitedBody(new Response(toAxiosBodyInit(response.data)));

        // Parse payment requirements from response
        let paymentRequired: PaymentRequired;
        try {
          // Create getHeader function for case-insensitive header lookup
          const getHeader = (name: string) => {
            const value = response.headers[name] ?? response.headers[name.toLowerCase()];
            return typeof value === "string" ? value : undefined;
          };

          // Try to get from headers first (v2), then from body (v1)
          const body = response.data as PaymentRequired | undefined;

          paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, body);
        } catch (parseError) {
          return Promise.reject(
            new Error(
              `Failed to parse payment requirements: ${parseError instanceof Error ? parseError.message : "Unknown error"}`,
            ),
          );
        }

        // Run payment required hooks
        const requestUrl = resolveAxiosRequestUrl(originalConfig, error.response);
        const hookHeaders = await httpClient.handlePaymentRequired(paymentRequired, requestUrl);
        if (hookHeaders) {
          const hookConfig = createX402RetryConfig(originalConfig);
          Object.entries(hookHeaders).forEach(([key, value]) => {
            setAxiosHeader(hookConfig.headers, key, value);
          });
          const hookResponse = await axiosInstance.request(hookConfig);
          if (hookResponse.status !== 402) {
            return hookResponse; // Hook succeeded
          }
          await readLimitedBody(new Response(toAxiosBodyInit(hookResponse.data)));
          // Hook's retry got 402, fall through to payment
        }

        // Create payment payload
        let paymentPayload;
        try {
          paymentPayload = await client.createPaymentPayload(paymentRequired);
        } catch (paymentError) {
          return Promise.reject(
            new Error(
              `Failed to create payment payload: ${paymentError instanceof Error ? paymentError.message : "Unknown error"}`,
            ),
          );
        }

        // Encode payment header
        const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

        const paidConfig = createX402RetryConfig(originalConfig);
        paidConfig.__is402Retry = true;

        // Add payment headers to the request
        Object.entries(paymentHeaders).forEach(([key, value]) => {
          setAxiosHeader(paidConfig.headers, key, value);
        });

        // Add CORS header to expose payment response
        setAxiosHeader(
          paidConfig.headers,
          "Access-Control-Expose-Headers",
          "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
        );

        // Retry the request with payment
        const secondResponse = await axiosInstance.request(paidConfig);

        // Fire payment response hooks and handle recovery
        const getResponseHeader = (name: string) => {
          const value = secondResponse.headers[name] ?? secondResponse.headers[name.toLowerCase()];
          return typeof value === "string" ? value : undefined;
        };
        const result = await httpClient.processPaymentResult(
          paymentPayload,
          getResponseHeader,
          secondResponse.status,
        );

        if (result.recovered) {
          // Retry once with a fresh payload after recovery.
          const freshPayload = await client.createPaymentPayload(paymentRequired);
          const retryHeaders = httpClient.encodePaymentSignatureHeader(freshPayload);
          const retryConfig = createX402RetryConfig(originalConfig);
          Object.entries(retryHeaders).forEach(([key, value]) => {
            setAxiosHeader(retryConfig.headers, key, value);
          });
          setAxiosHeader(
            retryConfig.headers,
            "Access-Control-Expose-Headers",
            "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
          );
          const retryResponse = await axiosInstance.request(retryConfig);
          // Process the final retry result without another recovery attempt.
          const getRetryHeader = (name: string) => {
            const value = retryResponse.headers[name] ?? retryResponse.headers[name.toLowerCase()];
            return typeof value === "string" ? value : undefined;
          };
          await httpClient.processPaymentResult(freshPayload, getRetryHeader, retryResponse.status);
          return retryResponse;
        }

        return secondResponse;
      } catch (retryError) {
        return Promise.reject(retryError);
      }
    },
  );

  return axiosInstance;
}

/**
 * Wraps an Axios instance with x402 payment handling using a configuration object.
 *
 * @param axiosInstance - The Axios instance to wrap
 * @param config - Configuration options including scheme registrations and selectors
 * @returns The wrapped Axios instance that handles 402 responses automatically
 *
 * @example
 * ```typescript
 * import axios from 'axios';
 * import { wrapAxiosWithPaymentFromConfig } from '@x402/axios';
 * import { ExactEvmScheme } from '@x402/evm';
 * import { privateKeyToAccount } from 'viem/accounts';
 *
 * const account = privateKeyToAccount('0x...');
 *
 * const api = wrapAxiosWithPaymentFromConfig(axios.create(), {
 *   schemes: [
 *     { network: 'eip155:*', client: new ExactEvmScheme(account) }
 *   ]
 * });
 *
 * const response = await api.get('https://api.example.com/paid-endpoint');
 * ```
 */
export function wrapAxiosWithPaymentFromConfig(
  axiosInstance: AxiosInstance,
  config: x402ClientConfig,
): AxiosInstance {
  const client = x402Client.fromConfig(config);
  return wrapAxiosWithPayment(axiosInstance, client);
}

// Re-export types and utilities for convenience
export { x402Client, x402HTTPClient } from "@x402/core/client";
export type {
  HTTPResourceResponse,
  PaymentPolicy,
  SchemeRegistration,
  SelectPaymentRequirements,
  x402ClientConfig,
} from "@x402/core/client";
export { decodePaymentResponseHeader, ResponseBodyTooLargeError } from "@x402/core/http";
export type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
