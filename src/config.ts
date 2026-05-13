/**
 * Config — Marmot channel configuration defaults, resolution, and helpers.
 *
 * Mirrors Signal's config pattern but for marmot-cli.
 */

import type { MarmotChannelConfig, MarmotAccountConfig } from "./types.js";

/** Default values for marmot channel config */
export const MARMOT_DEFAULTS = {
  cliPath: "marmot-cli",
  daemonHost: "127.0.0.1",
  daemonPort: 9222,
  autoStart: true,
  startupTimeoutMs: 30000,
  identityName: "default",
  dmPolicy: "open" as const,
  allowFrom: [] as Array<string | number>,
  groupPolicy: "open" as const,
  groupAllowFrom: [] as Array<string | number>,
  pollIntervalMs: 5000,
  textChunkLimit: 4000,
  historyLimit: 50,
};

/** Channel ID used throughout */
export const MARMOT_CHANNEL = "marmot";

/**
 * Resolve a raw config (from openclaw.json) into a fully-specified account config.
 * Matches the ChannelConfigAdapter.resolveAccount signature:
 *   (cfg: OpenClawConfig, accountId?: string | null) => MarmotAccountConfig
 */
export function resolveMarmotAccount(
  cfg: unknown,
  accountId?: string | null
): MarmotAccountConfig {
  const openclawCfg = cfg as Record<string, unknown>;
  const channels = (openclawCfg?.channels as Record<string, unknown>) ?? {};
  const marmotRaw = (channels.marmot as Record<string, unknown>) ?? {};
  const marmotCfg = marmotRaw as Partial<MarmotChannelConfig>;

  // Check for multi-account config
  const accountsRaw = marmotRaw.accounts as Record<string, Record<string, unknown>> | undefined;
  const accountCfg = accountsRaw?.[accountId ?? "default"] as Partial<MarmotChannelConfig> ?? marmotCfg;

  const merged = { ...MARMOT_DEFAULTS, ...accountCfg };
  const host = merged.daemonHost;
  const port = merged.daemonPort;
  const baseUrl = `http://${host}:${port}`;

  return {
    accountId: accountId ?? "default",
    name: merged.identityName,
    enabled: marmotCfg.enabled ?? true,
    configured: true,
    cliPath: merged.cliPath,
    daemonHost: merged.daemonHost,
    daemonPort: merged.daemonPort,
    autoStart: merged.autoStart,
    startupTimeoutMs: merged.startupTimeoutMs,
    identityName: merged.identityName,
    dmPolicy: merged.dmPolicy,
    allowFrom: merged.allowFrom ?? [],
    groupPolicy: merged.groupPolicy,
    groupAllowFrom: merged.groupAllowFrom ?? [],
    pollIntervalMs: merged.pollIntervalMs,
    textChunkLimit: merged.textChunkLimit,
    historyLimit: merged.historyLimit,
    baseUrl,
  };
}

/**
 * List account IDs from config.
 * Marmot uses a single-account model (like Signal's default account).
 */
export function listMarmotAccountIds(cfg: unknown): string[] {
  const openclawCfg = cfg as Record<string, unknown>;
  const channels = (openclawCfg?.channels as Record<string, unknown>) ?? {};
  const marmotCfg = (channels.marmot as Record<string, unknown>) ?? {};
  const accounts = marmotCfg.accounts as Record<string, unknown> | undefined;
  if (!accounts || typeof accounts !== "object") return ["default"];
  const ids = Object.keys(accounts);
  return ids.length > 0 ? ids : ["default"];
}

/**
 * Resolve the daemon base URL from config.
 */
export function resolveDaemonBaseUrl(cfg: Partial<MarmotChannelConfig>): string {
  const host = cfg.daemonHost ?? MARMOT_DEFAULTS.daemonHost;
  const port = cfg.daemonPort ?? MARMOT_DEFAULTS.daemonPort;
  return `http://${host}:${port}`;
}