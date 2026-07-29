import { describe, expect, it } from "vitest";
import {
  QQ_HEAD_CHECKSUM_BYTES,
  qqKeyboardTemplate,
  qqStreamingChecksums,
  qqWakeupDelivery
} from "./index.js";

describe("QQ plugin SDK extensions", () => {
  it("constructs namespaced platform extensions", () => {
    expect(qqWakeupDelivery("interaction-1")).toEqual({
      type: "platform",
      platform: "qq-official",
      mode: "wakeup",
      idempotencyKey: "interaction-1"
    });
    expect(qqKeyboardTemplate("template-1")).toEqual({
      platform: "qq-official",
      kind: "keyboard-template",
      id: "template-1"
    });
  });

  it("describes QQ multipart checksums using the neutral checksum model", () => {
    expect(
      qqStreamingChecksums({
        md5: "a",
        sha1: "b",
        first10MiBMd5: "c"
      })
    ).toEqual([
      { algorithm: "md5", digest: "a" },
      { algorithm: "sha1", digest: "b" },
      {
        algorithm: "md5",
        digest: "c",
        bytes: QQ_HEAD_CHECKSUM_BYTES
      }
    ]);
  });
});
