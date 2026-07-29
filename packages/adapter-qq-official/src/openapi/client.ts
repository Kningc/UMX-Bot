import type { Logger } from "@qq-bot/plugin-sdk";
import type { TokenManager } from "../token-manager.js";
import {
  QqApiError,
  qqApiErrorFromPayload,
  qqApiErrorFromResponse
} from "./error.js";
import { QqRateLimiter } from "./rate-limiter.js";

export interface QqOpenApiRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  rateLimitKey?: string;
  idempotent?: boolean;
}

export interface QqOpenApiClientOptions {
  baseUrl: string;
  tokenManager: TokenManager;
  logger: Logger;
  timeoutMs: number;
  lifecycleSignal?: () => AbortSignal | undefined;
}

export interface QqOpenApiMetrics {
  requests: number;
  succeeded: number;
  failed: number;
  rateLimited: number;
  authRefreshes: number;
  retries: number;
  totalDurationMs: number;
  lastSuccessAt?: string;
}

export class QqOpenApiClient {
  private readonly baseUrl: string;
  private readonly limiter = new QqRateLimiter();
  private readonly metrics: QqOpenApiMetrics = {
    requests: 0,
    succeeded: 0,
    failed: 0,
    rateLimited: 0,
    authRefreshes: 0,
    retries: 0,
    totalDurationMs: 0
  };

  public constructor(private readonly options: QqOpenApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
  }

  public async request<T>(request: QqOpenApiRequest): Promise<T> {
    const endpoint = `${request.method} /${request.path.replace(/^\/+/u, "")}`;
    const rateLimitKey = request.rateLimitKey ?? endpoint;
    this.limiter.assertAvailable(rateLimitKey, endpoint);
    const startedAt = Date.now();
    this.metrics.requests += 1;
    let authRetried = false;
    let transientRetries = 0;

    for (;;) {
      const token = await this.options.tokenManager.get();
      let response: Response;
      try {
        response = await fetch(
          `${this.baseUrl}/${request.path.replace(/^\/+/u, "")}`,
          {
            method: request.method,
            headers: {
              authorization: `QQBot ${token}`,
              ...(request.body === undefined
                ? {}
                : { "content-type": "application/json" })
            },
            signal: this.requestSignal(),
            ...(request.body === undefined
              ? {}
              : { body: JSON.stringify(request.body) })
          }
        );
      } catch (cause) {
        const error = new QqApiError("QQ API network request failed", {
          httpStatus: 0,
          endpoint,
          retryable: true,
          kind: "transient",
          cause
        });
        if (request.idempotent && transientRetries < 2) {
          transientRetries += 1;
          this.metrics.retries += 1;
          await delay(100 * 2 ** transientRetries);
          continue;
        }
        this.logResult(endpoint, startedAt, error);
        this.recordFailure(error, startedAt);
        throw error;
      }

      let error: QqApiError;
      if (response.ok) {
        let parsedSuccess: { value: T; text: string };
        try {
          parsedSuccess = await parseSuccess<T>(response, endpoint);
        } catch (cause) {
          const invalidResponse =
            cause instanceof QqApiError
              ? cause
              : new QqApiError("QQ API response parsing failed", {
                  httpStatus: response.status,
                  endpoint,
                  retryable: false,
                  kind: "unknown",
                  cause
                });
          this.logResult(endpoint, startedAt, invalidResponse, response.status);
          this.recordFailure(invalidResponse, startedAt);
          throw invalidResponse;
        }
        const { value: result, text } = parsedSuccess;
        const payload =
          result && typeof result === "object"
            ? (result as {
                code?: number | string;
                err_code?: number | string;
                message?: string;
                msg?: string;
                trace_id?: string;
              })
            : undefined;
        const businessCode = payload?.err_code ?? payload?.code;
        if (
          businessCode === undefined ||
          businessCode === 0 ||
          businessCode === "0"
        ) {
          this.logResult(endpoint, startedAt, undefined, response.status);
          this.metrics.succeeded += 1;
          this.metrics.lastSuccessAt = new Date().toISOString();
          this.metrics.totalDurationMs += Date.now() - startedAt;
          return result;
        }
        error = qqApiErrorFromPayload(
          payload,
          response.status,
          response.headers,
          endpoint,
          text
        );
      } else {
        error = await qqApiErrorFromResponse(response, endpoint);
      }
      if (error.kind === "authentication" && !authRetried) {
        authRetried = true;
        this.metrics.authRefreshes += 1;
        this.metrics.retries += 1;
        this.options.tokenManager.invalidate(token);
        continue;
      }
      if (error.kind === "rate_limit") {
        this.limiter.block(rateLimitKey, error.retryAfterMs);
      }
      if (
        request.idempotent &&
        error.retryable &&
        transientRetries < 2
      ) {
        transientRetries += 1;
        this.metrics.retries += 1;
        await delay(
          error.retryAfterMs ?? 100 * 2 ** transientRetries
        );
        continue;
      }
      this.logResult(endpoint, startedAt, error, response.status);
      this.recordFailure(error, startedAt);
      throw error;
    }
  }

  public async uploadBinary(
    presignedUrl: string,
    data: Uint8Array
  ): Promise<void> {
    let url: URL;
    try {
      url = new URL(presignedUrl);
    } catch (cause) {
      throw new QqApiError("QQ upload returned an invalid presigned URL", {
        httpStatus: 0,
        endpoint: "PUT presigned-upload",
        retryable: false,
        kind: "invalid_request",
        cause
      });
    }
    if (url.protocol !== "https:") {
      throw new QqApiError("QQ presigned uploads must use HTTPS", {
        httpStatus: 0,
        endpoint: "PUT presigned-upload",
        retryable: false,
        kind: "invalid_request"
      });
    }
    let lastError: QqApiError | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "PUT",
          body: data,
          signal: this.requestSignal()
        });
        if (response.ok) {
          return;
        }
        lastError = await qqApiErrorFromResponse(
          response,
          "PUT presigned-upload"
        );
        if (!lastError.retryable) {
          throw lastError;
        }
      } catch (cause) {
        if (cause instanceof QqApiError) {
          if (!cause.retryable) {
            throw cause;
          }
          lastError = cause;
        } else {
          lastError = new QqApiError("QQ presigned upload failed", {
            httpStatus: 0,
            endpoint: "PUT presigned-upload",
            retryable: true,
            kind: "transient",
            cause
          });
        }
      }
      if (attempt < 2) {
        await delay(200 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  public getMetrics(): Readonly<QqOpenApiMetrics> {
    return { ...this.metrics };
  }

  private requestSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const lifecycle = this.options.lifecycleSignal?.();
    return lifecycle ? AbortSignal.any([timeout, lifecycle]) : timeout;
  }

  private logResult(
    endpoint: string,
    startedAt: number,
    error?: QqApiError,
    httpStatus?: number
  ): void {
    const data = {
      endpoint,
      durationMs: Date.now() - startedAt,
      httpStatus: error?.httpStatus ?? httpStatus,
      errCode: error?.errCode,
      traceId: error?.traceId,
      retryable: error?.retryable
    };
    if (error) {
      this.options.logger.warn(data, "QQ OpenAPI request failed");
    } else {
      this.options.logger.debug(data, "QQ OpenAPI request completed");
    }
  }

  private recordFailure(error: QqApiError, startedAt: number): void {
    this.metrics.failed += 1;
    this.metrics.totalDurationMs += Date.now() - startedAt;
    if (error.kind === "rate_limit") {
      this.metrics.rateLimited += 1;
    }
  }
}

async function parseSuccess<T>(
  response: Response,
  endpoint: string
): Promise<{ value: T; text: string }> {
  if (response.status === 204) {
    return { value: undefined as T, text: "" };
  }
  const text = await response.text();
  if (!text) {
    return { value: undefined as T, text };
  }
  try {
    return { value: JSON.parse(text) as T, text };
  } catch (cause) {
    throw new QqApiError("QQ API returned invalid JSON", {
      httpStatus: response.status,
      endpoint,
      retryable: false,
      kind: "unknown",
      responseSummary: text.slice(0, 2_000),
      cause
    });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.min(milliseconds, 30_000));
  });
}
