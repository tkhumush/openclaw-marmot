/**
 * Monitor — marmot inbound message polling.
 *
 * Polls marmot-cli for new messages in all conversations and dispatches
 * them to the OpenClaw agent/reply pipeline.
 *
 * Mirrors Signal's monitorSignalProvider pattern but uses polling
 * instead of SSE (Phase 1). The polling runs inside gateway.startAccount
 * until the abort signal fires.
 *
 * Phase 3+ will add daemon subscribe RPC for real-time push.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MarmotAccountConfig, MonitorState, ParsedMarmotMessage } from "./types.js";
import { MarmotDaemonClient } from "./daemon.js";
import { parseMessagesOutput, filterNewMessages, buildInboundContext } from "./normalize.js";
import { isDmSenderAllowed, isGroupAllowed } from "./security.js";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";

const execFileAsync = promisify(execFile);

/** Known npubs to resolve truncated sender npubs from CLI output.
 *  marmot-cli truncates npubs in display (e.g. "npub1nje4ghpkjsx" instead of full).
 *  We match the truncated prefix against this set to recover the full npub.
 */
let knownNpubs: string[] = [];

/** Resolve a potentially truncated npub to its full form */
function resolveNpub(truncated: string): string {
  if (truncated.length >= 59) return truncated; // already full
  const match = knownNpubs.find((full) => full.startsWith(truncated));
  return match ?? truncated;
}

/** Create a fresh monitor state */
export function createMonitorState(): MonitorState {
  return {
    lastSeenTimestamps: new Map(),
    lastPollAt: 0,
    started: false,
  };
}

/** Execute a marmot-cli command and return stdout */
async function execMarmotCli(
  cliPath: string,
  args: string[],
  timeoutMs = 15000
): Promise<string> {
  const { stdout } = await execFileAsync(cliPath, args, {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

/** Get all DM conversations from marmot-cli
 *
 *  marmot-cli dm list output format:
 *    'dm:npub1...' (nostr-id: hex)     — old format
 *    '<DM with npub1...>' (nostr-id: hex)  — new format (resolving npub)
 */
async function listDmConversations(
  cliPath: string
): Promise<Array<{ groupId: string; peer: string }>> {
  try {
    const output = await execMarmotCli(cliPath, ["dm", "list"]);
    const conversations: Array<{ groupId: string; peer: string }> = [];
    for (const line of output.split("\n")) {
      // Match both (Group: hex) and (nostr-id: hex) formats
      const match = line.match(/\((?:Group|nostr-id):\s*([a-f0-9]+)\)/i);
      const peerMatch = line.match(/(npub[a-zA-Z0-9]+)/i);
      if (match?.[1]) {
        conversations.push({
          groupId: match[1],
          peer: peerMatch?.[1] ?? "",
        });
      }
    }
    return conversations;
  } catch {
    return [];
  }
}

/** Get all group conversations from marmot-cli
 *
 *  marmot-cli groups list output format:
 *    'group-name' (nostr-id: hex)
 */
async function listGroupConversations(
  cliPath: string
): Promise<Array<{ groupId: string; name: string }>> {
  try {
    const output = await execMarmotCli(cliPath, ["groups", "list"]);
    const groups: Array<{ groupId: string; name: string }> = [];
    for (const line of output.split("\n")) {
      // Match both (Group: hex) and (nostr-id: hex) formats
      const match = line.match(/\((?:Group|nostr-id):\s*([a-f0-9]+)\)/i);
      const nameMatch = line.match(/'([^']+)'/);
      if (match?.[1]) {
        groups.push({
          groupId: match[1],
          name: nameMatch?.[1] ?? match[1],
        });
      }
    }
    return groups;
  } catch {
    return [];
  }
}

/** Fetch new messages for a specific group since a given timestamp */
async function fetchMessagesSince(
  cliPath: string,
  groupId: string,
  sinceTimestamp: number,
  isGroup: boolean
): Promise<ParsedMarmotMessage[]> {
  const subcommand = isGroup ? "groups" : "dm";
  const args = [subcommand, "messages", "--group", groupId];

  if (sinceTimestamp > 0) {
    args.push("--after", sinceTimestamp.toString());
  }

  try {
    const output = await execMarmotCli(cliPath, args);
    const messages = parseMessagesOutput(output, groupId, isGroup);
    // Resolve truncated npubs to full form
    for (const msg of messages) {
      msg.senderNpub = resolveNpub(msg.senderNpub);
    }
    return filterNewMessages(messages, sinceTimestamp);
  } catch (err) {
    // One failing group shouldn't break the whole poll
    console.error(`[marmot-monitor] Error fetching messages for ${groupId}:`, err);
    return [];
  }
}

/**
 * Main polling loop — polls for new messages and dispatches to OpenClaw.
 *
 * This mirrors monitorSignalProvider but uses CLI polling instead of SSE.
 * Called from gateway.startAccount, runs until abort signal fires.
 *
 * Phase 3 integration will wire this into the OpenClaw dispatch pipeline
 * via the channelRuntime reply mechanism.
 */
export async function monitorMarmotProvider(params: {
  accountId: string;
  config: MarmotAccountConfig;
  ourNpub: string;
  abortSignal: AbortSignal;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
  channelRuntime?: any; // ChannelRuntimeSurface for dispatching inbound messages
  cfg: any; // OpenClawConfig for routing/dispatch
}): Promise<void> {
  const { accountId, config, ourNpub, abortSignal, log, channelRuntime, cfg } = params;
  const state = createMonitorState();
  const client = new MarmotDaemonClient(config.baseUrl);

  // Initial receive to populate the DB with latest messages
  try {
    await client.receive();
    log?.info?.(`[${accountId}] initial receive completed`);
  } catch {
    // Non-fatal — the daemon's WebSocket subscription may already handle this
  }

  log?.info?.(`[${accountId}] marmot monitor starting (poll every ${config.pollIntervalMs}ms)`);

  while (!abortSignal.aborted) {
    try {
      // 1. Get all groups via RPC (full data, no truncation)
      const groupsResult = await client.listGroups();
      const allGroups = groupsResult.groups ?? [];

      // 2. Update known npub set for resolving truncated sender npubs from CLI output.
      // Seed from allowFrom (full npubs we already know) so the allowlist check
      // works even when group names are empty and don't contain npubs.
      for (const npub of (config.allowFrom ?? []).filter((v): v is string => typeof v === "string")) {
        if (!knownNpubs.includes(npub)) knownNpubs.push(npub);
      }
      for (const g of allGroups) {
        if (g.name) {
          const npubMatch = g.name.match(/(npub[a-zA-Z0-9]+)/);
          if (npubMatch && !knownNpubs.includes(npubMatch[1])) {
            knownNpubs.push(npubMatch[1]);
          }
        }
      }
      if (!knownNpubs.includes(ourNpub)) {
        knownNpubs.push(ourNpub);
      }

      // 3. Classify groups into DMs and named groups
      // DMs: groups with name starting "dm:", "<DM", or empty name (1:1 conversations)
      // Named groups: groups with a meaningful name that's not a DM pattern
      const dms = allGroups.filter(
        (g) => !g.name || g.name.startsWith("dm:") || g.name.startsWith("<DM")
      );
      const namedGroups = allGroups.filter(
        (g) => g.name && !g.name.startsWith("dm:") && !g.name.startsWith("<DM")
      );

      if (!state.started) {
        log?.info?.(`[${accountId}] groups: ${allGroups.length} total, ${dms.length} DMs, ${namedGroups.length} named`);
        log?.info?.(`[${accountId}] DM groups: ${dms.map((g) => g.name + "=" + g.nostr_id.slice(0, 8)).join(", ")}`);
      }

      // 4. Poll each DM for new messages
      for (const dm of dms) {
        if (abortSignal.aborted) break;

        const groupId = dm.nostr_id;
        const lastSeen = state.lastSeenTimestamps.get(groupId) ?? 0;
        const messages = await fetchMessagesSince(
          config.cliPath,
          groupId,
          lastSeen,
          false
        );

        if (messages.length > 0) {
          log?.info?.(`[${accountId}] DM ${dm.name} (${groupId.slice(0, 8)}): ${messages.length} new messages (lastSeen=${lastSeen})`);
        }

        for (const msg of messages) {
          if (abortSignal.aborted) break;

          log?.info?.(`[${accountId}] DM msg from ${msg.senderNpub.slice(0, 12)}... in ${groupId.slice(0, 8)}: "${msg.text.slice(0, 50)}" (ts=${msg.timestamp})`);

          // Check DM policy
          if (!isDmSenderAllowed(msg.senderNpub, config)) {
            log?.info?.(`[${accountId}] DM from ${msg.senderNpub.slice(0, 12)}... blocked by dmPolicy=${config.dmPolicy}`);
            // Still advance watermark so we don't re-process
            if (msg.timestamp > (state.lastSeenTimestamps.get(groupId) ?? 0)) {
              state.lastSeenTimestamps.set(groupId, msg.timestamp);
            }
            continue;
          }

          // Skip self-messages
          if (msg.senderNpub === ourNpub) {
            // Still advance watermark
            if (msg.timestamp > (state.lastSeenTimestamps.get(groupId) ?? 0)) {
              state.lastSeenTimestamps.set(groupId, msg.timestamp);
            }
            continue;
          }

          // Dispatch inbound DM to OpenClaw
          if (channelRuntime) {
            try {
              await dispatchInboundDirectDmWithRuntime({
                cfg,
                runtime: { channel: channelRuntime },
                channel: "marmot",
                channelLabel: "Marmot",
                accountId,
                peer: { kind: "direct", id: msg.senderNpub },
                senderId: msg.senderNpub,
                senderAddress: msg.senderNpub,
                recipientAddress: ourNpub,
                conversationLabel: `DM with ${msg.senderNpub}`,
                rawBody: msg.text,
                messageId: `marmot-${msg.groupId}-${msg.timestamp}`,
                timestamp: msg.timestamp,
                deliver: async (payload) => {
                  // Outbound delivery — send via marmot daemon
                  const client = new MarmotDaemonClient(config.baseUrl);
                  const result = await client.sendMessage(msg.groupId, payload.text ?? "");
                  log?.info?.(`[${accountId}] delivered reply to ${msg.senderNpub}: ${result.event_id ?? "ok"}`);
                },
                onRecordError: (err) => log?.error?.(`[${accountId}] record error: ${err}`),
                onDispatchError: (err, info) => log?.error?.(`[${accountId}] dispatch error (${info.kind}): ${err}`),
              });
              log?.info?.(`[${accountId}] dispatched inbound DM from ${msg.senderNpub}`);
            } catch (err) {
              log?.error?.(`[${accountId}] failed to dispatch inbound DM: ${err}`);
            }
          } else {
            log?.info?.(`[${accountId}] no channelRuntime — skipping dispatch (message from ${msg.senderNpub} dropped)`);
          }

          // Update last seen timestamp
          if (msg.timestamp > (state.lastSeenTimestamps.get(groupId) ?? 0)) {
            state.lastSeenTimestamps.set(groupId, msg.timestamp);
          }
        }
      }

      // 5. Poll each named group for new messages
      for (const group of namedGroups) {
        if (abortSignal.aborted) break;

        // Check group policy
        if (!isGroupAllowed(group.nostr_id, config)) continue;

        const groupId = group.nostr_id;
        const lastSeen = state.lastSeenTimestamps.get(groupId) ?? 0;
        const messages = await fetchMessagesSince(
          config.cliPath,
          groupId,
          lastSeen,
          true
        );

        for (const msg of messages) {
          if (abortSignal.aborted) break;

          // Skip self-messages
          if (msg.senderNpub === ourNpub) continue;

          // TODO: Group dispatch — use dispatchInboundGroupMessageWithRuntime when available
          if (channelRuntime) {
            try {
              await dispatchInboundDirectDmWithRuntime({
                cfg,
                runtime: { channel: channelRuntime },
                channel: "marmot",
                channelLabel: "Marmot",
                accountId,
                peer: { kind: "direct", id: msg.senderNpub },
                senderId: msg.senderNpub,
                senderAddress: msg.senderNpub,
                recipientAddress: ourNpub,
                conversationLabel: group.name ?? groupId,
                rawBody: msg.text,
                messageId: `marmot-${groupId}-${msg.timestamp}`,
                timestamp: msg.timestamp,
                deliver: async (payload) => {
                  const client = new MarmotDaemonClient(config.baseUrl);
                  const result = await client.sendMessage(groupId, payload.text ?? "");
                  log?.info?.(`[${accountId}] delivered group reply to ${groupId}: ${result.event_id ?? "ok"}`);
                },
                onRecordError: (err) => log?.error?.(`[${accountId}] record error: ${err}`),
                onDispatchError: (err, info) => log?.error?.(`[${accountId}] dispatch error (${String(info.kind)}): ${err}`),
              });
              log?.info?.(`[${accountId}] dispatched inbound group msg from ${msg.senderNpub} in ${group.name ?? groupId}`);
            } catch (err) {
              log?.error?.(`[${accountId}] failed to dispatch group msg: ${err}`);
            }
          }

          // Update last seen timestamp
          if (msg.timestamp > (state.lastSeenTimestamps.get(groupId) ?? 0)) {
            state.lastSeenTimestamps.set(groupId, msg.timestamp);
          }
        }
      }

      state.lastPollAt = Date.now();
      if (!state.started) {
        state.started = true;
        log?.info?.(`[${accountId}] marmot monitor started`);
      }
    } catch (err) {
      log?.error?.(`[marmot-monitor] Poll error: ${err}`);
    }

    // Wait for next poll interval
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, config.pollIntervalMs);
      abortSignal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  log?.info?.(`[${accountId}] marmot monitor stopped`);
}