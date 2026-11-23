import type { MessageKeyboard } from "@umx-bot/plugin-sdk";
import { QQ_PLATFORM } from "@umx-bot/plugin-sdk-qq";
import { qqButtonStyles } from "./protocol.js";

export function serializeQqKeyboard(
  keyboard: MessageKeyboard
): Record<string, unknown> {
  if ("platform" in keyboard) {
    if (
      keyboard.platform !== QQ_PLATFORM ||
      keyboard.kind !== "keyboard-template"
    ) {
      throw new Error(
        `QQ adapter does not support ${keyboard.platform} keyboard kind "${keyboard.kind}"`
      );
    }
    const templateId = keyboard.id.trim();
    if (!templateId) {
      throw new Error("QQ keyboard templateId cannot be empty");
    }
    return { id: templateId };
  }
  if (keyboard.rows.length === 0 || keyboard.rows.length > 5) {
    throw new Error("QQ keyboard must contain between 1 and 5 rows");
  }
  return {
    content: {
      rows: keyboard.rows.map((row, rowIndex) => {
        if (row.length === 0 || row.length > 5) {
          throw new Error(
            "QQ keyboard rows must contain between 1 and 5 buttons"
          );
        }
        return {
          buttons: row.map((button, buttonIndex) => {
            const label = button.label.trim();
            if (label.length === 0 || label.length > 10) {
              throw new Error(
                "QQ keyboard button labels must be 1-10 characters"
              );
            }
            const actionData =
              button.action === "link" ? button.url.trim() : button.data.trim();
            if (!actionData) {
              throw new Error("QQ keyboard button action data cannot be empty");
            }
            if (actionData.length > 1024) {
              throw new Error("QQ keyboard button action data is too long");
            }
            if (button.action === "link") {
              const url = new URL(actionData);
              if (url.protocol !== "http:" && url.protocol !== "https:") {
                throw new Error("QQ keyboard links must use HTTP or HTTPS");
              }
            }
            const permission = button.visibleTo?.userIds?.length
              ? {
                  type: 0,
                  specify_user_ids: [...button.visibleTo.userIds]
                }
              : {
                  type:
                    button.visibleTo?.minimumRole === "admin" ||
                    button.visibleTo?.minimumRole === "owner"
                      ? 1
                      : 2
                };
            return {
              id: button.id ?? `${rowIndex + 1}-${buttonIndex + 1}`,
              render_data: {
                label,
                visited_label: label,
                style: qqButtonStyles[button.style ?? "default"]
              },
              action: {
                type:
                  button.action === "link"
                    ? 0
                    : button.action === "callback"
                      ? 1
                      : 2,
                permission,
                data: actionData,
                ...(button.action === "command"
                  ? {
                      enter: button.enter ?? true,
                      reply: button.reply ?? false,
                      unsupport_tips: `请手动发送 ${actionData}`
                    }
                  : {})
              }
            };
          })
        };
      })
    }
  };
}
