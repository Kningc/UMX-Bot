import type {
  MediaChecksum,
  MessageDelivery,
  MessageKeyboard
} from "@qq-bot/plugin-sdk";

export const QQ_PLATFORM = "qq-official" as const;
export const QQ_HEAD_CHECKSUM_BYTES = 10_002_432 as const;

export function qqWakeupDelivery(idempotencyKey: string): MessageDelivery {
  return {
    type: "platform",
    platform: QQ_PLATFORM,
    mode: "wakeup",
    idempotencyKey
  };
}

export function qqKeyboardTemplate(id: string): MessageKeyboard {
  return {
    platform: QQ_PLATFORM,
    kind: "keyboard-template",
    id
  };
}

export function qqStreamingChecksums(input: {
  md5: string;
  sha1: string;
  first10MiBMd5: string;
}): readonly MediaChecksum[] {
  return [
    { algorithm: "md5", digest: input.md5 },
    { algorithm: "sha1", digest: input.sha1 },
    {
      algorithm: "md5",
      digest: input.first10MiBMd5,
      bytes: QQ_HEAD_CHECKSUM_BYTES
    }
  ];
}
