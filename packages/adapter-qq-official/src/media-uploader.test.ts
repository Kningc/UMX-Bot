import { describe, expect, it } from "vitest";
import { QqMediaUploader } from "./media-uploader.js";
import type { QqOpenApiClient } from "./openapi/client.js";

function fakeOpenApi(ttl: number) {
  let uploads = 0;
  const client = {
    async request() {
      uploads += 1;
      return { file_info: `info-${uploads}`, ttl };
    }
  } as unknown as QqOpenApiClient;
  return { client, uploads: () => uploads };
}

const image = (url: string) => ({
  type: "image" as const,
  source: { type: "url" as const, url }
});

describe("QqMediaUploader cache", () => {
  it("stays bounded and evicts the least recently used entry", async () => {
    const api = fakeOpenApi(0);
    const uploader = new QqMediaUploader(api.client, 2);
    const upload = (url: string) =>
      uploader.upload("v2/groups/g/files", image(url), "g", "group");

    await upload("https://example.com/a.png");
    await upload("https://example.com/b.png");
    await upload("https://example.com/a.png"); // hit: a becomes most recent
    await upload("https://example.com/c.png"); // evicts b

    expect(uploader.cacheSize).toBe(2);
    expect(api.uploads()).toBe(3);
    await upload("https://example.com/a.png");
    expect(api.uploads()).toBe(3);
    await upload("https://example.com/b.png");
    expect(api.uploads()).toBe(4);
  });

  it("does not cache uploads without a ttl", async () => {
    const api = fakeOpenApi(0);
    const client = {
      async request() {
        return { file_info: "info" };
      }
    } as unknown as QqOpenApiClient;
    const uploader = new QqMediaUploader(client);
    await uploader.upload(
      "v2/users/u/files",
      image("https://example.com/a.png"),
      "u",
      "direct"
    );
    expect(uploader.cacheSize).toBe(0);
    expect(api.uploads()).toBe(0);
  });
});
