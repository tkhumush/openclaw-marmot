/**
 * Security — DM policy, group policy, and allowFrom enforcement.
 *
 * Mirrors Signal's createRestrictSendersChannelSecurity pattern.
 */

import type { MarmotChannelConfig } from "./types.js";

/** Check if a DM sender is allowed based on dmPolicy */
export function isDmSenderAllowed(
  senderNpub: string,
  config: MarmotChannelConfig
): boolean {
  const policy = config.dmPolicy ?? "open";

  switch (policy) {
    case "open":
      return true;
    case "disabled":
      return false;
    case "allowlist": {
      const allowFrom = config.allowFrom ?? [];
      return allowFrom.includes(senderNpub) || allowFrom.includes("*");
    }
    case "pairing":
      // Phase 5+: pairing flow — for now, treat as allowlist
      return (config.allowFrom ?? []).includes(senderNpub);
    default:
      return false;
  }
}

/** Check if a group message is allowed based on groupPolicy */
export function isGroupAllowed(
  groupId: string,
  config: MarmotChannelConfig
): boolean {
  const policy = config.groupPolicy ?? "open";

  switch (policy) {
    case "open":
      return true;
    case "disabled":
      return false;
    case "allowlist": {
      const allowFrom = config.groupAllowFrom ?? [];
      return allowFrom.includes(groupId) || allowFrom.includes("*");
    }
    default:
      return false;
  }
}

/** Normalize an npub for comparison (strip marmot: prefix, lowercase) */
export function normalizeMarmotNpub(npub: string): string {
  return npub.replace(/^marmot:/i, "").trim().toLowerCase();
}

/** Normalize a group ID for comparison */
export function normalizeMarmotGroupId(id: string): string {
  return id.replace(/^marmot:group:/i, "").trim().toLowerCase();
}