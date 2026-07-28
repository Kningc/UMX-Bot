interface TokenResponse {
  access_token: string;
  expires_in: string | number;
}

export class TokenManager {
  private token: { value: string; expiresAt: number } | undefined;
  private refreshPromise: Promise<string> | undefined;

  public constructor(
    private readonly appId: string,
    private readonly clientSecret: string,
    private readonly tokenUrl: string,
    private readonly requestTimeoutMs: number
  ) {}

  public async get(): Promise<string> {
    if (this.token && this.token.expiresAt - Date.now() > 60_000) {
      return this.token.value;
    }
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  public invalidate(value?: string): void {
    if (!value || this.token?.value === value) {
      this.token = undefined;
    }
  }

  private async refresh(): Promise<string> {
    const response = await fetch(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.clientSecret
      })
    });

    if (!response.ok) {
      throw new Error(
        `QQ access token request failed (${response.status}): ${await response.text()}`
      );
    }

    const result = (await response.json()) as Partial<TokenResponse>;
    if (!result.access_token || !result.expires_in) {
      throw new Error("QQ access token response is incomplete");
    }

    const expiresIn = Number(result.expires_in);
    if (!Number.isFinite(expiresIn)) {
      throw new Error("QQ access token expiry is invalid");
    }

    this.token = {
      value: result.access_token,
      expiresAt: Date.now() + expiresIn * 1_000
    };
    return result.access_token;
  }
}
