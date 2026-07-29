import { QqApiError } from "./error.js";

export class QqRateLimiter {
  private readonly blockedUntil = new Map<string, number>();

  public assertAvailable(key: string, endpoint: string): void {
    const until = this.blockedUntil.get(key) ?? 0;
    const retryAfterMs = until - Date.now();
    if (retryAfterMs <= 0) {
      this.blockedUntil.delete(key);
      return;
    }
    throw new QqApiError("QQ API rate limit is still active", {
      httpStatus: 429,
      endpoint,
      retryable: true,
      kind: "rate_limit",
      retryAfterMs
    });
  }

  public block(key: string, retryAfterMs: number | undefined): void {
    const duration = Math.max(250, retryAfterMs ?? 1_000);
    this.blockedUntil.set(
      key,
      Math.max(this.blockedUntil.get(key) ?? 0, Date.now() + duration)
    );
  }
}
