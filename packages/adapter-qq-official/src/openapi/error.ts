export type QqApiErrorKind =
  | "authentication"
  | "permission"
  | "rate_limit"
  | "content"
  | "delivery_rejected"
  | "quota"
  | "transient"
  | "invalid_request"
  | "unknown";

export interface QqApiErrorOptions {
  httpStatus: number;
  errCode?: number | string;
  traceId?: string;
  endpoint: string;
  retryable: boolean;
  kind: QqApiErrorKind;
  responseSummary?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

export class QqApiError extends Error {
  public readonly httpStatus: number;
  public readonly errCode: number | string | undefined;
  public readonly traceId: string | undefined;
  public readonly endpoint: string;
  public readonly retryable: boolean;
  public readonly kind: QqApiErrorKind;
  public readonly responseSummary: string | undefined;
  public readonly retryAfterMs: number | undefined;

  public constructor(message: string, options: QqApiErrorOptions) {
    super(message, options.cause === undefined ? undefined : {
      cause: options.cause
    });
    this.name = "QqApiError";
    this.httpStatus = options.httpStatus;
    this.errCode = options.errCode;
    this.traceId = options.traceId;
    this.endpoint = options.endpoint;
    this.retryable = options.retryable;
    this.kind = options.kind;
    this.responseSummary = options.responseSummary;
    this.retryAfterMs = options.retryAfterMs;
  }
}

interface ParsedErrorBody {
  code?: number | string;
  err_code?: number | string;
  message?: string;
  msg?: string;
  trace_id?: string;
}

export async function qqApiErrorFromResponse(
  response: Response,
  endpoint: string
): Promise<QqApiError> {
  const text = (await response.text()).slice(0, 2_000);
  let parsed: ParsedErrorBody | undefined;
  try {
    parsed = JSON.parse(text) as ParsedErrorBody;
  } catch {
    parsed = undefined;
  }
  return qqApiErrorFromPayload(
    parsed,
    response.status,
    response.headers,
    endpoint,
    text
  );
}

export function qqApiErrorFromPayload(
  parsed: ParsedErrorBody | undefined,
  httpStatus: number,
  headers: Headers,
  endpoint: string,
  responseSummary?: string
): QqApiError {
  const errCode = parsed?.err_code ?? parsed?.code;
  const traceId =
    headers.get("x-tps-trace-id") ??
    headers.get("x-trace-id") ??
    parsed?.trace_id;
  const kind = classifyError(
    httpStatus,
    errCode,
    parsed?.message ?? parsed?.msg
  );
  const retryAfterMs = parseRetryAfter(headers.get("retry-after"));
  return new QqApiError(
    parsed?.message ??
      parsed?.msg ??
      `QQ API request failed with HTTP ${httpStatus}`,
    {
      httpStatus,
      ...(errCode !== undefined ? { errCode } : {}),
      ...(traceId ? { traceId } : {}),
      endpoint,
      retryable: kind === "rate_limit" || kind === "transient",
      kind,
      ...(responseSummary ? { responseSummary } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
    }
  );
}

function classifyError(
  status: number,
  errCode: number | string | undefined,
  message: string | undefined
): QqApiErrorKind {
  if (status === 401) {
    return "authentication";
  }
  if (status === 403) {
    return "permission";
  }
  if (status === 429) {
    return "rate_limit";
  }
  if (status >= 500 || status === 408) {
    return "transient";
  }
  const numericCode = Number(errCode);
  if ([40034105, 304004, 304064, 40034127].includes(numericCode)) {
    return "permission";
  }
  if ([50002, 40034100].includes(numericCode)) {
    return "rate_limit";
  }
  if ([40034006, 304061, 40034011].includes(numericCode)) {
    return "content";
  }
  if ([40054013, 40054004].includes(numericCode)) {
    return "delivery_rejected";
  }
  if ([40034122, 40093002].includes(numericCode)) {
    return "quota";
  }
  if ([50001, 50055002, 40093001, 850027].includes(numericCode)) {
    return "transient";
  }
  const searchable = `${errCode ?? ""} ${message ?? ""}`.toLowerCase();
  if (/拒收|reject|关闭通知|delivery/.test(searchable)) {
    return "delivery_rejected";
  }
  if (/额度|quota|limit.*day|次数已用完/.test(searchable)) {
    return "quota";
  }
  if (/违规|敏感|content|审核/.test(searchable)) {
    return "content";
  }
  if (status >= 400 && status < 500) {
    return "invalid_request";
  }
  return "unknown";
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
