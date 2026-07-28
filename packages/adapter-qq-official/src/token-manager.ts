interface TokenResponse {
  access_token: string;
  expires_in: string | number;
}

export class TokenManager {
  private token?: { value: string; expiresAt: number };

  public constructor(
    private readonly appId: string,
    private readonly clientSecret: string,
    private readonly tokenUrl: string
  ) {}

  public async get(): Promise<string> {
    if (this.token && this.token.expiresAt - Date.now() > 60_000) {
      return this.token.value;
    }

    const response = await fetch(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
