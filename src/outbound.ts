/**
 * Outbound — send messages via marmot daemon RPC.
 *
 * Mirrors Signal's sendMessageSignal pattern but uses
 * marmot daemon's JSON-RPC send_message method over TCP.
 */

import { MarmotDaemonClient } from "./daemon.js";
import type { MarmotAccountConfig, ResolvedMarmotTarget } from "./types.js";

/** Resolve an OpenClaw outbound target string to a marmot target.
 *
 *  Target formats:
 *    marmot:<npub>           → DM with that npub
 *    marmot:group:<hex>      → Named MLS group
 *    <npub> (bare)           → DM with that npub (implicit marmot: prefix)
 *    group:<hex> (bare)      → Named MLS group
 */
export function resolveMarmotOutboundTarget(target: string): ResolvedMarmotTarget | null {
  const stripped = target.replace(/^marmot:/i, "").trim();

  if (!stripped) return null;

  // Group: group:<hex>
  const groupMatch = stripped.match(/^group:([a-f0-9]+)$/i);
  if (groupMatch?.[1]) {
    const groupId = groupMatch[1];
    return {
      peer: { kind: "group", id: groupId },
      chatType: "group",
      from: `group:${groupId}`,
      to: `group:${groupId}`,
    };
  }

  // DM: npub
  const npubMatch = stripped.match(/^(npub[a-zA-Z0-9]+)$/);
  if (npubMatch?.[1]) {
    const npub = npubMatch[1];
    return {
      peer: { kind: "direct", id: npub },
      chatType: "direct",
      from: `marmot:${npub}`,
      to: `marmot:${npub}`,
    };
  }

  return null;
}

/** Infer chat type from a raw target string */
export function inferMarmotTargetChatType(
  rawTo: string
): "direct" | "group" | undefined {
  let to = rawTo.trim();
  if (!to) return undefined;
  if (/^marmot:/i.test(to)) to = to.replace(/^marmot:/i, "").trim();
  if (!to) return undefined;
  if (/^group:/i.test(to)) return "group";
  if (/^npub/i.test(to)) return "direct";
  return "direct";
}

/** Send a text message via marmot daemon RPC */
export async function sendMarmotMessage(
  target: string,
  text: string,
  config: MarmotAccountConfig
): Promise<{ sent: boolean; eventId?: string }> {
  const resolved = resolveMarmotOutboundTarget(target);
  if (!resolved) {
    throw new Error(`Cannot resolve marmot outbound target: ${target}`);
  }

  // For DMs, find or create the DM group. For groups, send directly.
  let groupId: string;

  if (resolved.peer.kind === "group") {
    groupId = resolved.peer.id;
  } else {
    groupId = await findOrCreateDmGroup(resolved.peer.id, config);
  }

  const client = new MarmotDaemonClient(config.baseUrl);
  const result = await client.sendMessage(groupId, text, true);

  return {
    sent: result.sent,
    eventId: result.event_id,
  };
}

/** Find or create a DM group with a peer, using daemon RPC for reliable group ID lookup */
async function findOrCreateDmGroup(
  peerNpub: string,
  config: MarmotAccountConfig
): Promise<string> {
  const client = new MarmotDaemonClient(config.baseUrl);

  // 1. Check existing groups via RPC — DM groups have a name containing the peer npub
  //    or an empty name (White Noise DM convention).
  const findInGroups = (groups: Array<{ nostr_id: string; name?: string }>) =>
    groups.find((g) => g.name?.includes(peerNpub));

  try {
    const { groups } = await client.listGroups();
    const existing = findInGroups(groups);
    if (existing) return existing.nostr_id;
  } catch {
    // RPC unavailable — fall through to create
  }

  // 2. Create via CLI (dm create output has no parseable group ID).
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  try {
    await execFileAsync(
      config.cliPath,
      ["dm", "create", "--recipient", peerNpub, "--publish"],
      { timeout: 30000 }
    );
  } catch (err) {
    throw new Error(`Failed to create DM group with ${peerNpub}: ${err}`);
  }

  // 3. Re-fetch via RPC to get the newly created group's nostr_id.
  try {
    const { groups: updated } = await client.listGroups();
    const created = findInGroups(updated);
    if (created) return created.nostr_id;
  } catch {
    // fall through to error
  }

  throw new Error(`Could not find or create DM group with ${peerNpub}`);
}

/** Build a base session key for marmot outbound routing.
 *
 *  Session key format: marmot[:account]:<peer-kind>:<peer-id>
 *  Examples:
 *    marmot:npub1abc123
 *    marmot:group:abc123
 *    marmot:work:npub1abc123    (with account "work")
 */
export function buildMarmotBaseSessionKey(params: {
  cfg: unknown;
  agentId?: string;
  accountId?: string;
  peer: { kind: "direct" | "group"; id: string };
}): string {
  const { agentId, accountId, peer } = params;
  const parts = ["marmot"];

  if (accountId && accountId !== "default") {
    parts.push(accountId);
  }

  if (peer.kind === "group") {
    parts.push("group", peer.id);
  } else {
    parts.push(peer.id);
  }

  // Note: agentId is not included in the base session key.
  // OpenClaw handles agent scoping separately.

  return parts.join(":");
}