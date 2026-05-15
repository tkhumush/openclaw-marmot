/**
 * Types — shared TypeScript types for @openclaw/marmot.
 *
 * Aligned with OpenClaw plugin SDK interfaces.
 * MarmotAccountConfig is the "resolved account" type that gets passed
 * through config.resolveAccount and into the gateway/security/outbound adapters.
 */

/** Marmot channel configuration (from openclaw.json channels.marmot) */
export interface MarmotChannelConfig {
  enabled?: boolean;
  configWrites?: boolean;
  name?: string;
  cliPath?: string;
  daemonHost?: string;
  daemonPort?: number;
  autoStart?: boolean;
  startupTimeoutMs?: number;
  identityName?: string;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  allowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: Array<string | number>;
  pollIntervalMs?: number;
  textChunkLimit?: number;
  historyLimit?: number;
  reactionNotifications?: "off" | "own" | "all";
  actions?: {
    reactions?: boolean;
  };
}

/** Resolved account config with defaults applied.
 *  This is our TResolvedAccount type used throughout the plugin. */
export interface MarmotAccountConfig {
  accountId?: string | null;
  name: string;
  enabled: boolean;
  configured: boolean;
  cliPath: string;
  daemonHost: string;
  daemonPort: number;
  autoStart: boolean;
  startupTimeoutMs: number;
  identityName: string;
  dmPolicy: "open" | "allowlist" | "pairing" | "disabled";
  allowFrom: Array<string | number>;
  groupPolicy: "open" | "allowlist" | "disabled";
  groupAllowFrom: Array<string | number>;
  pollIntervalMs: number;
  textChunkLimit: number;
  historyLimit: number;
  baseUrl: string;
}

/** Daemon RPC method parameters */
export interface SendMessageParams {
  group_id: string;
  content: string;
  publish?: boolean;
}

/** Daemon RPC response types */
export interface PingResponse {
  pong: boolean;
}

export interface IdentityNpubResponse {
  npub: string;
}

export interface ListGroupsResponse {
  groups: Array<{
    nostr_id: string;
    name?: string;
  }>;
}

export interface SendMessageResponse {
  sent: boolean;
  event_id?: string;
  published?: boolean;
}

export interface ReceiveResponse {
  new_messages: number;
  new_welcomes: number;
}

/** Parsed marmot message from CLI output */
export interface ParsedMarmotMessage {
  timestamp: number;
  senderNpub: string;
  text: string;
  groupId: string;
  isGroup: boolean;
  eventId?: string;
}

/** Resolved outbound target */
export interface ResolvedMarmotTarget {
  peer: {
    kind: "direct" | "group";
    id: string;
  };
  chatType: "direct" | "group";
  from: string;
  to: string;
}

/** Daemon process state */
export interface DaemonState {
  process: import("child_process").ChildProcess | null;
  running: boolean;
  lastPing: number;
  restartCount: number;
  startedAt: number | null;
}

/** Monitor state for tracking seen messages */
export interface MonitorState {
  lastSeenTimestamps: Map<string, number>;
  lastInboundEventIds: Map<string, string>;
  lastPollAt: number;
  started: boolean;
}

/** Snapshot for gateway status reporting */
export interface MarmotAccountSnapshot {
  accountId: string;
  name?: string;
  enabled?: boolean;
  configured?: boolean;
  baseUrl?: string;
  lastError?: string | null;
  probe?: { version?: string; npub?: string };
  lastProbeAt?: number;
}

/** Full marmot runtime state accessible via plugin runtime store */
export interface MarmotRuntimeState {
  daemonProcess: import("child_process").ChildProcess | null;
  daemonRunning: boolean;
  monitorStarted: boolean;
  ourNpub?: string;
}