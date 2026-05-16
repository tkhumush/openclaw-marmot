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

import type { MarmotAccountConfig, MonitorState, ParsedMarmotMessage } from "./types.js";
import { MarmotDaemonClient } from "./daemon.js";
import { isDmSenderAllowed, isGroupAllowed } from "./security.js";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import {
  createStatusReactionController,
  type StatusReactionEmojis,
} from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";

const STATUS_EMOJIS: StatusReactionEmojis = {
  queued:     "📬",
  thinking:   "🧠",
  tool:       "⚙️",
  coding:     "⚙️",
  web:        "🔍",
  done:       "✅",
  error:      "❌",
  stallSoft:  "⏳",
  stallHard:  "🔴",
  compacting: "🗜️",
};

/** Create a fresh monitor state */
export function createMonitorState(): MonitorState {
  return {
    lastSeenTimestamps: new Map(),
    lastInboundEventIds: new Map(),
    lastPollAt: 0,
    started: false,
  };
}

/** Fetch new messages for a group via daemon RPC (replaces CLI text scraping) */
async function fetchMessagesSince(
  client: MarmotDaemonClient,
  groupId: string,
  sinceTimestamp: number,
  isGroup: boolean
): Promise<ParsedMarmotMessage[]> {
  try {
    const result = await client.getMessages(groupId, {
      limit: 50,
      after: sinceTimestamp > 0 ? sinceTimestamp : undefined,
    });
    return result.messages.map((m) => ({
      timestamp: m.timestamp,
      senderNpub: m.sender_npub,
      text: m.content,
      groupId,
      isGroup,
      eventId: m.event_id,
    }));
  } catch (err) {
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

      // 2. On first poll, seed all groups with the current timestamp so that
      // messages received before this restart are not re-dispatched to the agent.
      if (!state.started) {
        const nowSecs = Math.floor(Date.now() / 1000);
        for (const g of allGroups) {
          if (!state.lastSeenTimestamps.has(g.nostr_id)) {
            state.lastSeenTimestamps.set(g.nostr_id, nowSecs);
          }
        }
      }

      // 4. Classify groups into DMs and named groups
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

      // 5. Poll each DM for new messages
      for (const dm of dms) {
        if (abortSignal.aborted) break;

        const groupId = dm.nostr_id;
        const lastSeen = state.lastSeenTimestamps.get(groupId) ?? 0;
        const messages = await fetchMessagesSince(
          client,
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

          // Track the event_id of the most recent inbound message per group
          // (used as the reaction target for status emoji)
          if (msg.eventId) {
            state.lastInboundEventIds.set(groupId, msg.eventId);
          }

          // Dispatch inbound DM to OpenClaw
          if (channelRuntime) {
            try {
              const reactionGroupId = groupId;
              const reactionEventId = msg.eventId;
              const reactionClient = new MarmotDaemonClient(config.baseUrl);

              const statusController = createStatusReactionController({
                enabled: !!reactionEventId,
                adapter: {
                  setReaction: async (emoji) => {
                    if (!reactionEventId) return;
                    try {
                      await reactionClient.sendReaction(reactionGroupId, reactionEventId, emoji);
                    } catch (err) {
                      log?.error?.(`[${accountId}] reaction send failed: ${err}`);
                    }
                  },
                },
                initialEmoji: STATUS_EMOJIS.queued!,
                emojis: STATUS_EMOJIS,
                onError: (err) => log?.error?.(`[${accountId}] status reaction error: ${err}`),
              });

              // Wrap channelRuntime to inject onToolStart and onCompactionStart
              // into the reply dispatcher's replyOptions.
              const wrappedRuntime = {
                ...channelRuntime,
                reply: {
                  ...channelRuntime.reply,
                  dispatchReplyWithBufferedBlockDispatcher: async (params: any) => {
                    return channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
                      ...params,
                      replyOptions: {
                        ...params.replyOptions,
                        onToolStart: async (info: { name?: string }) => {
                          statusController.setTool(info.name);
                          return params.replyOptions?.onToolStart?.(info);
                        },
                        onCompactionStart: async () => {
                          statusController.setCompacting();
                          return params.replyOptions?.onCompactionStart?.();
                        },
                      },
                    });
                  },
                },
              };

              await statusController.setThinking();

              await dispatchInboundDirectDmWithRuntime({
                cfg,
                runtime: { channel: wrappedRuntime },
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
                  const sendClient = new MarmotDaemonClient(config.baseUrl);
                  const result = await sendClient.sendMessage(msg.groupId, payload.text ?? "");
                  log?.info?.(`[${accountId}] delivered reply to ${msg.senderNpub}: ${result.event_id ?? "ok"}`);
                  await statusController.setDone();
                },
                onRecordError: (err) => log?.error?.(`[${accountId}] record error: ${err}`),
                onDispatchError: async (err, info) => {
                  log?.error?.(`[${accountId}] dispatch error (${info.kind}): ${err}`);
                  await statusController.setError();
                },
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

      // 6. Poll each named group for new messages
      for (const group of namedGroups) {
        if (abortSignal.aborted) break;

        // Check group policy
        if (!isGroupAllowed(group.nostr_id, config)) continue;

        const groupId = group.nostr_id;
        const lastSeen = state.lastSeenTimestamps.get(groupId) ?? 0;
        const messages = await fetchMessagesSince(
          client,
          groupId,
          lastSeen,
          true
        );

        for (const msg of messages) {
          if (abortSignal.aborted) break;

          // Skip self-messages
          if (msg.senderNpub === ourNpub) continue;

          if (msg.eventId) {
            state.lastInboundEventIds.set(groupId, msg.eventId);
          }

          // TODO: Group dispatch — use dispatchInboundGroupMessageWithRuntime when available
          if (channelRuntime) {
            try {
              const reactionGroupId = groupId;
              const reactionEventId = msg.eventId;
              const reactionClient = new MarmotDaemonClient(config.baseUrl);

              const statusController = createStatusReactionController({
                enabled: !!reactionEventId,
                adapter: {
                  setReaction: async (emoji) => {
                    if (!reactionEventId) return;
                    try {
                      await reactionClient.sendReaction(reactionGroupId, reactionEventId, emoji);
                    } catch (err) {
                      log?.error?.(`[${accountId}] reaction send failed: ${err}`);
                    }
                  },
                },
                initialEmoji: STATUS_EMOJIS.queued!,
                emojis: STATUS_EMOJIS,
                onError: (err) => log?.error?.(`[${accountId}] status reaction error: ${err}`),
              });

              const wrappedRuntime = {
                ...channelRuntime,
                reply: {
                  ...channelRuntime.reply,
                  dispatchReplyWithBufferedBlockDispatcher: async (params: any) => {
                    return channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
                      ...params,
                      replyOptions: {
                        ...params.replyOptions,
                        onToolStart: async (info: { name?: string }) => {
                          statusController.setTool(info.name);
                          return params.replyOptions?.onToolStart?.(info);
                        },
                        onCompactionStart: async () => {
                          statusController.setCompacting();
                          return params.replyOptions?.onCompactionStart?.();
                        },
                      },
                    });
                  },
                },
              };

              await statusController.setThinking();

              await dispatchInboundDirectDmWithRuntime({
                cfg,
                runtime: { channel: wrappedRuntime },
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
                  const sendClient = new MarmotDaemonClient(config.baseUrl);
                  const result = await sendClient.sendMessage(groupId, payload.text ?? "");
                  log?.info?.(`[${accountId}] delivered group reply to ${groupId}: ${result.event_id ?? "ok"}`);
                  await statusController.setDone();
                },
                onRecordError: (err) => log?.error?.(`[${accountId}] record error: ${err}`),
                onDispatchError: async (err, info) => {
                  log?.error?.(`[${accountId}] dispatch error (${String(info.kind)}): ${err}`);
                  await statusController.setError();
                },
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