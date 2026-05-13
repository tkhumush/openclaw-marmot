/**
 * Normalize — parse marmot-cli output into OpenClaw channel envelopes.
 *
 * marmot-cli message output format:
 *   Messages in '<group name>' (newest first):
 *     [1778591294] npub16q3kvq68q8a: Hey Alice! Bob here.
 *     [1778591214] npub16y4nacm24yu: Hello Bob!
 *     (2 messages)
 */

import type { ParsedMarmotMessage } from "./types.js";

/** Parse a single message line from marmot-cli output.
 *
 *  Input:  "[1778591294] npub16q3kvq68q8a: Hey Alice! Bob here."
 *  Output: { timestamp: 1778591294, senderNpub: "npub16q3kvq68q8a", text: "Hey Alice! Bob here." }
 *
 *  Returns null if the line doesn't match the expected format.
 */
export function parseMessageLine(
  line: string,
  groupId: string,
  isGroup: boolean
): ParsedMarmotMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Match: [timestamp] npubXXXXX: message text
  const match = trimmed.match(
    /^\[(\d+)\]\s+(npub[a-zA-Z0-9]+):\s(.*)$/
  );

  if (!match) return null;

  const [, timestampStr, senderNpub, text] = match;
  if (!timestampStr || !senderNpub || text === undefined) return null;

  return {
    timestamp: parseInt(timestampStr, 10),
    senderNpub,
    text: text.trim(),
    groupId,
    isGroup,
  };
}

/** Parse all messages from a marmot-cli output block */
export function parseMessagesOutput(
  output: string,
  groupId: string,
  isGroup: boolean
): ParsedMarmotMessage[] {
  const lines = output.split("\n");
  const messages: ParsedMarmotMessage[] = [];

  for (const line of lines) {
    const parsed = parseMessageLine(line, groupId, isGroup);
    if (parsed) {
      messages.push(parsed);
    }
  }

  return messages;
}

/** Filter messages newer than a given timestamp */
export function filterNewMessages(
  messages: ParsedMarmotMessage[],
  afterTimestamp: number
): ParsedMarmotMessage[] {
  return messages.filter((msg) => msg.timestamp > afterTimestamp);
}

/** Check if a line is metadata (not a message) */
export function isMetadataLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("Messages in") ||
    trimmed.startsWith("(") || // e.g., "(2 messages)"
    trimmed === "" ||
    trimmed.startsWith("Nostr ID:") ||
    trimmed.startsWith("---")
  );
}

/**
 * Build an OpenClaw-compatible inbound message context from a parsed marmot message.
 *
 * This mirrors how Signal creates inbound context from SSE events.
 * Returns null for self-messages (sender === our npub).
 */
export function buildInboundContext(
  msg: ParsedMarmotMessage,
  ourNpub: string
) {
  // Skip self-messages
  if (msg.senderNpub === ourNpub) return null;

  return {
    channel: "marmot",
    chatId: msg.isGroup ? msg.groupId : msg.senderNpub,
    senderId: msg.senderNpub,
    text: msg.text,
    timestamp: msg.timestamp,
    groupId: msg.isGroup ? msg.groupId : undefined,
    chatType: msg.isGroup ? ("group" as const) : ("direct" as const),
  };
}