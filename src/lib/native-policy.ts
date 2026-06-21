import type { JsonRecord } from "./protocol.js";

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; notice: string }> = [
  {
    pattern: /badge/i,
    notice: "Badge updates are not supported in Incodex.",
  },
  {
    pattern: /context-menu/i,
    notice: "Context menus are not supported in Incodex.",
  },
  {
    pattern: /notification/i,
    notice: "Desktop notifications are not supported in Incodex.",
  },
  {
    pattern: /power-save/i,
    notice: "Power-save controls are not supported in Incodex.",
  },
  {
    pattern: /window-mode/i,
    notice: "Window mode controls are not supported in Incodex.",
  },
];

export function getUnsupportedBridgeNotice(message: unknown): string | null {
  if (!isJsonRecord(message) || typeof message.type !== "string") {
    return null;
  }

  for (const blocked of BLOCKED_PATTERNS) {
    if (blocked.pattern.test(message.type)) {
      return blocked.notice;
    }
  }

  return null;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}
