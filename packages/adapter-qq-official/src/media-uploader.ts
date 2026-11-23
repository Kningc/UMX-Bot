import type { OutgoingMedia, OutgoingMessage } from "@umx-bot/plugin-sdk";
import { QQ_HEAD_CHECKSUM_BYTES } from "@umx-bot/plugin-sdk-qq";
import type { QqOpenApiClient } from "./openapi/client.js";
import {
  digest,
  mediaSizeLimits,
  multipartThreshold,
  type QqMediaUploadResponse,
  type QqUploadPrepareResponse,
  qqMediaTypes
} from "./protocol.js";

export interface QqMediaUpload {
  fileInfo: string;
  ttl?: number;
  raw: QqMediaUploadResponse;
}

interface CachedUpload {
  fileInfo: string;
  expiresAt: number;
  raw: QqMediaUploadResponse;
}

/** Upper bound for remembered file_info entries; oldest entries are evicted first. */
export const MEDIA_CACHE_LIMIT = 512;

/**
 * Uploads rich media to QQ and remembers reusable file_info values.
 *
 * The cache is bounded: expired entries are pruned on every insert and the
 * least recently used entry is evicted once the limit is reached, so a
 * long-running process cannot grow it without limit.
 */
export class QqMediaUploader {
  private readonly cache = new Map<string, CachedUpload>();

  public constructor(
    private readonly openApi: QqOpenApiClient,
    private readonly cacheLimit = MEDIA_CACHE_LIMIT
  ) {}

  public get cacheSize(): number {
    return this.cache.size;
  }

  public async upload(
    resource: string,
    media: OutgoingMedia,
    conversationId: string,
    scope: OutgoingMessage["scope"]
  ): Promise<QqMediaUpload> {
    const cacheKey = this.cacheKey(media, conversationId, scope);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      // Refresh recency so frequently reused media survives eviction.
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return {
        fileInfo: cached.fileInfo,
        ttl:
          cached.expiresAt === Number.POSITIVE_INFINITY
            ? 0
            : Math.max(0, Math.floor((cached.expiresAt - Date.now()) / 1_000)),
        raw: cached.raw
      };
    }
    this.cache.delete(cacheKey);
    const body: Record<string, unknown> = {
      file_type: qqMediaTypes[media.type],
      srv_send_msg: false
    };
    if (media.filename) {
      body.file_name = media.filename;
    }
    if (media.source.type === "url") {
      let url: URL;
      try {
        url = new URL(media.source.url);
      } catch {
        throw new Error(`invalid ${media.type} URL`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`${media.type} URL must use HTTP or HTTPS`);
      }
      body.url = url.toString();
    } else if (media.source.type === "data") {
      if (media.source.data.byteLength === 0) {
        throw new Error(`${media.type} data cannot be empty`);
      }
      const limit = mediaSizeLimits[media.type];
      if (media.source.data.byteLength > limit) {
        throw new Error(
          `${media.type} exceeds QQ size limit of ${Math.round(limit / 1024 / 1024)} MiB`
        );
      }
      if (media.source.data.byteLength > multipartThreshold) {
        const multipart = await this.uploadMultipart(
          resource,
          media,
          media.source.data,
          conversationId,
          scope
        );
        this.remember(cacheKey, multipart);
        return multipart;
      }
      body.file_data = Buffer.from(media.source.data).toString("base64");
    } else {
      validateStreamSource(media);
      const multipart = await this.uploadMultipart(
        resource,
        media,
        media.source,
        conversationId,
        scope
      );
      this.remember(cacheKey, multipart);
      return multipart;
    }

    const result = await this.openApi.request<QqMediaUploadResponse>({
      method: "POST",
      path: resource,
      body,
      rateLimitKey: ["media", scope, conversationId].join(":")
    });
    if (!result.file_info) {
      throw new Error("QQ media upload response did not include file_info");
    }
    const upload = {
      fileInfo: result.file_info,
      ...(result.ttl !== undefined ? { ttl: result.ttl } : {}),
      raw: result
    };
    this.remember(cacheKey, upload);
    return upload;
  }

  private cacheKey(
    media: OutgoingMedia,
    conversationId: string,
    scope: OutgoingMessage["scope"]
  ): string {
    const source =
      media.source.type === "url"
        ? media.source.url
        : media.source.type === "data"
          ? digest("sha1", media.source.data)
          : requireChecksum(media, "sha1");
    return [scope, conversationId, media.type, source].join("\u001f");
  }

  private remember(key: string, upload: QqMediaUpload): void {
    if (upload.ttl === undefined) {
      return;
    }
    const now = Date.now();
    this.cache.delete(key);
    for (const [cachedKey, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(cachedKey);
      }
    }
    while (this.cache.size >= this.cacheLimit) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
    this.cache.set(key, {
      fileInfo: upload.fileInfo,
      expiresAt:
        upload.ttl === 0
          ? Number.POSITIVE_INFINITY
          : now + Math.max(0, upload.ttl - 5) * 1_000,
      raw: upload.raw
    });
  }

  private async uploadMultipart(
    fileResource: string,
    media: OutgoingMedia,
    source: Uint8Array | Extract<OutgoingMedia["source"], { type: "stream" }>,
    conversationId: string,
    scope: OutgoingMessage["scope"]
  ): Promise<QqMediaUpload> {
    const prepareResource = fileResource.replace(
      /\/files$/u,
      "/upload_prepare"
    );
    const finishResource = fileResource.replace(
      /\/files$/u,
      "/upload_part_finish"
    );
    const filename =
      media.filename ??
      `upload.${media.type === "image" ? "png" : media.type === "video" ? "mp4" : media.type === "audio" ? "silk" : "bin"}`;
    const size = source instanceof Uint8Array ? source.byteLength : source.size;
    const md5 =
      source instanceof Uint8Array
        ? digest("md5", source)
        : requireChecksum(media, "md5");
    const sha1 =
      source instanceof Uint8Array
        ? digest("sha1", source)
        : requireChecksum(media, "sha1");
    const md5_10m =
      source instanceof Uint8Array
        ? digest("md5", source.subarray(0, QQ_HEAD_CHECKSUM_BYTES))
        : requireChecksum(media, "md5", QQ_HEAD_CHECKSUM_BYTES);
    const prepare = await this.openApi.request<QqUploadPrepareResponse>({
      method: "POST",
      path: prepareResource,
      body: {
        file_type: qqMediaTypes[media.type],
        file_size: String(size),
        file_name: filename,
        md5,
        sha1,
        md5_10m
      },
      rateLimitKey: `media-prepare:${scope}:${conversationId}`
    });
    if (!prepare.upload_id || !prepare.parts?.length) {
      throw new Error(
        "QQ multipart prepare response did not include upload_id and parts"
      );
    }
    const parts = [...prepare.parts].sort(
      (left, right) => (left.index ?? -1) - (right.index ?? -1)
    );
    const streamReader =
      source instanceof Uint8Array
        ? undefined
        : new AsyncPartReader(source.stream, source.size);
    let offset = 0;
    for (const [expectedIndex, part] of parts.entries()) {
      if (
        part.index !== expectedIndex ||
        !part.presigned_url ||
        !part.block_size
      ) {
        throw new Error("QQ multipart prepare returned an invalid part list");
      }
      const requestedSize = Number(part.block_size);
      if (!Number.isSafeInteger(requestedSize) || requestedSize <= 0) {
        throw new Error("QQ multipart prepare returned an invalid block size");
      }
      const chunk =
        source instanceof Uint8Array
          ? source.subarray(
              offset,
              Math.min(offset + requestedSize, source.byteLength)
            )
          : await streamReader!.read(requestedSize);
      if (chunk.byteLength === 0) {
        throw new Error("QQ multipart prepare returned too many parts");
      }
      await this.openApi.uploadBinary(part.presigned_url, chunk);
      await this.openApi.request<void>({
        method: "POST",
        path: finishResource,
        body: {
          upload_id: prepare.upload_id,
          part_index: part.index,
          block_size: String(chunk.byteLength),
          md5: digest("md5", chunk)
        },
        rateLimitKey: `media-finish:${scope}:${conversationId}`
      });
      offset += chunk.byteLength;
    }
    if (offset !== size) {
      throw new Error("QQ multipart prepare did not cover the whole file");
    }
    await streamReader?.assertComplete();
    const result = await this.openApi.request<QqMediaUploadResponse>({
      method: "POST",
      path: fileResource,
      body: {
        file_type: qqMediaTypes[media.type],
        srv_send_msg: false,
        file_name: filename,
        upload_id: prepare.upload_id
      },
      rateLimitKey: `media-merge:${scope}:${conversationId}`
    });
    if (!result.file_info) {
      throw new Error("QQ multipart merge response did not include file_info");
    }
    return {
      fileInfo: result.file_info,
      ...(result.ttl !== undefined ? { ttl: result.ttl } : {}),
      raw: result
    };
  }
}

export function requireChecksum(
  media: OutgoingMedia,
  algorithm: string,
  bytes?: number
): string {
  if (media.source.type !== "stream") {
    throw new Error("checksums are only available for streaming media");
  }
  const checksum = media.source.checksums.find(
    (candidate) =>
      candidate.algorithm.toLowerCase() === algorithm.toLowerCase() &&
      candidate.bytes === bytes
  );
  if (!checksum) {
    const coverage =
      bytes === undefined ? "the complete stream" : `the first ${bytes} bytes`;
    throw new Error(
      `${media.type} stream requires a ${algorithm} checksum for ${coverage}`
    );
  }
  return checksum.digest;
}

export function validateStreamSource(media: OutgoingMedia): void {
  if (media.source.type !== "stream") {
    return;
  }
  const limit = mediaSizeLimits[media.type];
  if (!Number.isSafeInteger(media.source.size) || media.source.size <= 0) {
    throw new Error(`${media.type} stream size must be a positive integer`);
  }
  if (media.source.size > limit) {
    throw new Error(
      `${media.type} exceeds QQ size limit of ${Math.round(limit / 1024 / 1024)} MiB`
    );
  }
  for (const [name, value, length] of [
    ["md5", requireChecksum(media, "md5"), 32],
    ["sha1", requireChecksum(media, "sha1"), 40],
    ["md5_first_10m", requireChecksum(media, "md5", QQ_HEAD_CHECKSUM_BYTES), 32]
  ] as const) {
    if (!new RegExp(`^[a-f0-9]{${length}}$`, "iu").test(value)) {
      throw new Error(`${media.type} stream ${name} must be a hex digest`);
    }
  }
}

class AsyncPartReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current: Uint8Array | undefined;
  private currentOffset = 0;
  private consumed = 0;

  public constructor(
    stream: AsyncIterable<Uint8Array>,
    private readonly expectedSize: number
  ) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  public async read(size: number): Promise<Uint8Array> {
    const remainingExpected = this.expectedSize - this.consumed;
    const output = new Uint8Array(Math.min(size, remainingExpected));
    let written = 0;
    while (written < output.byteLength) {
      if (!this.current || this.currentOffset >= this.current.byteLength) {
        const next = await this.iterator.next();
        if (next.done) {
          throw new Error("QQ media stream ended before its declared size");
        }
        if (
          !(next.value instanceof Uint8Array) ||
          next.value.byteLength === 0
        ) {
          throw new Error(
            "QQ media stream chunks must be non-empty Uint8Array values"
          );
        }
        this.current = next.value;
        this.currentOffset = 0;
      }
      const available = this.current.byteLength - this.currentOffset;
      const take = Math.min(available, output.byteLength - written);
      output.set(
        this.current.subarray(this.currentOffset, this.currentOffset + take),
        written
      );
      this.currentOffset += take;
      written += take;
      this.consumed += take;
    }
    return output;
  }

  public async assertComplete(): Promise<void> {
    if (
      this.consumed !== this.expectedSize ||
      (this.current && this.currentOffset < this.current.byteLength)
    ) {
      throw new Error("QQ media stream does not match its declared size");
    }
    const next = await this.iterator.next();
    if (!next.done) {
      throw new Error("QQ media stream exceeds its declared size");
    }
  }
}
