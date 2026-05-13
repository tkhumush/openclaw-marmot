/**
 * Channel plugin definition — the core marmotPlugin object.
 *
 * Uses createChatChannelPlugin() to build the full channel plugin
 * following the same pattern as @openclaw/signal.
 *
 * Phase 1: Plugin registration skeleton — loads, shows in plugins list.
 * Phase 2+: Daemon lifecycle, inbound monitoring, outbound sending.
 */

import {
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
} from "openclaw/plugin-sdk/channel-plugin-common";
import {
  createRestrictSendersChannelSecurity,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  resolveMarmotOutboundTarget,
  inferMarmotTargetChatType,
  sendMarmotMessage,
  buildMarmotBaseSessionKey,
} from "./outbound.js";
import { MARMOT_CHANNEL, MARMOT_DEFAULTS, resolveMarmotAccount, listMarmotAccountIds } from "./config.js";
import { normalizeMarmotNpub } from "./security.js";
import { spawnMarmotDaemon, waitForMarmotDaemonReady, MarmotDaemonClient } from "./daemon.js";
import { monitorMarmotProvider } from "./monitor.js";
import type { MarmotAccountConfig } from "./types.js";

// ──────────────────────────────────────────────────────────
// Security adapter — DM policy + group policy
// ──────────────────────────────────────────────────────────

const marmotSecurity = createRestrictSendersChannelSecurity<MarmotAccountConfig>({
  channelKey: MARMOT_CHANNEL,
  resolveDmPolicy: (account: MarmotAccountConfig) => account.dmPolicy,
  resolveDmAllowFrom: (account: MarmotAccountConfig) => account.allowFrom,
  resolveGroupPolicy: (account: MarmotAccountConfig) => account.groupPolicy,
  surface: "Marmot groups",
  openScope: "any member",
  groupPolicyPath: "channels.marmot.groupPolicy",
  groupAllowFromPath: "channels.marmot.groupAllowFrom",
  mentionGated: false,
  normalizeDmEntry: (raw: string) => normalizeMarmotNpub(raw),
});

// ──────────────────────────────────────────────────────────
// Main plugin definition
// ──────────────────────────────────────────────────────────

export const marmotPlugin = createChatChannelPlugin<MarmotAccountConfig>({
  base: {
    id: MARMOT_CHANNEL,
    meta: {
      ...getChatChannelMeta(MARMOT_CHANNEL),
    },
    capabilities: {
      chatTypes: ["direct", "group"] as const,
      media: false,
      reactions: false,
    },
    reload: {
      configPrefixes: ["channels.marmot"],
    },
    config: {
      listAccountIds: (cfg: OpenClawConfig) => listMarmotAccountIds(cfg),
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
        resolveMarmotAccount(cfg, accountId),
      defaultAccountId: () => DEFAULT_ACCOUNT_ID,
      isConfigured: (account: MarmotAccountConfig) => account.configured,
      describeAccount: (account: MarmotAccountConfig) => ({
        accountId: account.accountId ?? "default",
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        baseUrl: account.baseUrl,
      }),
    },
    // Minimal setup adapter — will be expanded in Phase 6
    setup: {
      applyAccountConfig: (params: { cfg: OpenClawConfig; accountId: string; input: unknown }) => {
        // For now, just return cfg unchanged (Phase 6: wizard)
        return params.cfg;
      },
    },

    // Messaging adapter — target resolution, normalization, session keys
    messaging: {
      targetPrefixes: ["marmot"],
      normalizeTarget: (raw: string) => {
        const resolved = resolveMarmotOutboundTarget(raw);
        return resolved?.to ?? undefined;
      },
      parseExplicitTarget: ({ raw }: { raw: string }) => {
        const resolved = resolveMarmotOutboundTarget(raw);
        if (!resolved) return null;
        return {
          to: resolved.to,
          chatType: resolved.chatType as "direct" | "group",
        };
      },
      inferTargetChatType: ({ to }: { to: string }) =>
        inferMarmotTargetChatType(to),
      resolveOutboundSessionRoute: (params: {
        cfg: OpenClawConfig;
        agentId: string;
        accountId?: string | null;
        target: string;
        currentSessionKey?: string;
        resolvedTarget?: {
          to: string;
          kind: "user" | "group" | "channel";
          display?: string;
          source: "normalized" | "directory";
        };
        replyToId?: string | null;
        threadId?: string | number | null;
      }) => {
        const resolved = resolveMarmotOutboundTarget(params.target);
        if (!resolved) return null;
        return {
          sessionKey: buildMarmotBaseSessionKey({
            cfg: params.cfg,
            agentId: params.agentId,
            accountId: params.accountId ?? undefined,
            peer: resolved.peer,
          }),
          baseSessionKey: buildMarmotBaseSessionKey({
            cfg: params.cfg,
            peer: resolved.peer,
          }),
          ...resolved,
        };
      },
      targetResolver: {
        looksLikeId: (value: string) =>
          /^marmot:/i.test(value) || /^npub[a-zA-Z0-9]+$/i.test(value),
        hint: "<npub|marmot:npub|marmot:group:HEX>",
      },
    },

    // Gateway lifecycle — spawn daemon, start monitor, process messages
    gateway: {
      startAccount: async (ctx) => {
        const { account, abortSignal } = ctx;
        const log = ctx.log;
        const accountId = account.accountId ?? "default";

        log?.info(`[${accountId}] starting marmot provider (${account.baseUrl})`);

        // Set initial status
        ctx.setStatus({
          accountId,
          enabled: account.enabled,
          configured: account.configured,
          statusState: "starting",
        });

        // Phase 2: Spawn daemon if autoStart is enabled
        let daemonHandle: import("child_process").ChildProcess | null = null;
        let ourNpub: string | undefined;

        if (account.autoStart) {
          // If a daemon is already answering on the port, reuse it instead of spawning.
          const preCheck = new MarmotDaemonClient(account.baseUrl);
          let alreadyRunning = false;
          try {
            const r = await preCheck.ping(1500);
            alreadyRunning = r?.pong === true;
          } catch { /* not running yet */ }

          if (alreadyRunning) {
            log?.info(`[${accountId}] marmot daemon already running — skipping spawn`);
          } else {
            log?.info(`[${accountId}] spawning marmot daemon (autoStart=true)`);
            daemonHandle = spawnMarmotDaemon(account,
              (line) => log?.info(line),
              (line) => log?.error(line)
            );

            // Wait for daemon to become healthy; kill it if it never responds.
            try {
              await waitForMarmotDaemonReady({
                baseUrl: account.baseUrl,
                timeoutMs: account.startupTimeoutMs,
                abortSignal,
                log: log?.info,
              });
            } catch (err) {
              if (daemonHandle && !daemonHandle.killed) {
                daemonHandle.kill("SIGTERM");
              }
              log?.error(`[${accountId}] marmot daemon failed to start: ${err}`);
              throw err;
            }

            log?.info(`[${accountId}] marmot daemon ready`);
          }
        }

        // Get our npub for self-message filtering
        try {
          const client = new MarmotDaemonClient(account.baseUrl);
          const identity = await client.identityNpub();
          ourNpub = identity.npub;
          log?.info(`[${accountId}] our npub: ${ourNpub}`);
        } catch (err) {
          log?.error(`[${accountId}] failed to get identity npub: ${err}`);
        }

        // Update status to running
        ctx.setStatus({
          accountId,
          enabled: account.enabled,
          configured: account.configured,
          statusState: "running",
          connected: true,
          running: true,
        });

        // Phase 3+: Start monitoring for inbound messages
        const channelRuntime = ctx.channelRuntime;
        log?.info(`[${accountId}] channelRuntime available: ${!!channelRuntime}, keys: ${channelRuntime ? Object.keys(channelRuntime).join(',') : 'none'}`);

        await monitorMarmotProvider({
          accountId,
          config: account,
          ourNpub: ourNpub ?? "",
          abortSignal,
          log: log ?? undefined,
          channelRuntime,
          cfg: ctx.cfg,
        });

        // Cleanup on abort
        if (daemonHandle && !daemonHandle.killed) {
          daemonHandle.kill("SIGTERM");
        }

        log?.info(`[${accountId}] marmot provider stopped`);
      },
    },
  },

  // Security adapter
  security: marmotSecurity,

  // Outbound delivery — send messages via marmot daemon RPC
  outbound: {
    base: {
      deliveryMode: "direct" as const,
      textChunkLimit: MARMOT_DEFAULTS.textChunkLimit,
      sendFormattedText: async (ctx) => {
        const account = resolveMarmotAccount(ctx.cfg, ctx.accountId);
        const result = await sendMarmotMessage(ctx.to, ctx.text, account);
        return [{
          channel: MARMOT_CHANNEL as Exclude<string, "none">,
          messageId: result.eventId ?? `marmot-${Date.now()}`,
          to: ctx.to,
        }];
      },
      sendFormattedMedia: async () => {
        throw new Error("Marmot media sending not yet supported");
      },
    },
    attachedResults: {
      channel: MARMOT_CHANNEL,
    },
  },
});

/** Setup plugin — minimal stub for Phase 6. */
export const marmotSetupPlugin = {
  id: MARMOT_CHANNEL,
};
