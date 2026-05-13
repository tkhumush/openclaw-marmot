/**
 * Daemon — marmot-cli daemon lifecycle management and JSON-RPC client.
 *
 * Manages the marmot-cli daemon subprocess and provides a TCP-based
 * JSON-RPC client for ping, identity_npub, list_groups, send_message.
 *
 * Mirrors Signal's spawnSignalDaemon + signalRpcRequest patterns.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import type { MarmotAccountConfig, DaemonState } from "./types.js";

// ──────────────────────────────────────────────────────────
// Daemon spawning
// ──────────────────────────────────────────────────────────

/** Build daemon CLI args from account config */
function buildDaemonArgs(config: MarmotAccountConfig): string[] {
  const args: string[] = ["daemon"];
  args.push("--listen", `${config.daemonHost}:${config.daemonPort}`);
  return args;
}

/** Spawn the marmot-cli daemon as a subprocess */
export function spawnMarmotDaemon(
  config: MarmotAccountConfig,
  onLog?: (line: string) => void,
  onError?: (line: string) => void
): ChildProcess {
  const args = buildDaemonArgs(config);
  const proc = spawn(config.cliPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  proc.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      const trimmed = line.trim();
      if (trimmed) onLog?.(`[marmot-daemon] ${trimmed}`);
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      const trimmed = line.trim();
      if (trimmed) onError?.(`[marmot-daemon] ${trimmed}`);
    }
  });

  proc.on("exit", (code, signal) => {
    onLog?.(`[marmot-daemon] exited code=${code} signal=${signal}`);
  });

  return proc;
}

// ──────────────────────────────────────────────────────────
// Daemon health check
// ──────────────────────────────────────────────────────────

/** Wait for the marmot daemon to become healthy (respond to ping). */
export async function waitForMarmotDaemonReady(params: {
  baseUrl: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  logAfterMs?: number;
  logIntervalMs?: number;
  log?: (msg: string) => void;
}): Promise<void> {
  const {
    baseUrl,
    timeoutMs,
    abortSignal,
    logAfterMs = 10000,
    logIntervalMs = 3000,
    log,
  } = params;

  const client = new MarmotDaemonClient(baseUrl);
  const deadline = Date.now() + timeoutMs;
  let lastLogAt = 0;

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) {
      throw new Error("Marmot daemon startup aborted");
    }

    try {
      const result = await client.ping(3000);
      if (result?.pong) {
        log?.("[marmot-daemon] health check passed");
        return;
      }
    } catch {
      // Not ready yet
    }

    if (log && Date.now() - lastLogAt > logAfterMs) {
      log("[marmot-daemon] waiting for daemon to become ready...");
      lastLogAt = Date.now();
    }

    await sleepMs(Math.min(logIntervalMs, deadline - Date.now()));
  }

  throw new Error(`Marmot daemon did not become ready within ${timeoutMs}ms`);
}

// ──────────────────────────────────────────────────────────
// JSON-RPC client
// ──────────────────────────────────────────────────────────

/** JSON-RPC client for the marmot daemon over TCP */
export class MarmotDaemonClient {
  private host: string;
  private port: number;

  constructor(baseUrl: string) {
    // Parse http://host:port into host/port for TCP connection
    const url = new URL(baseUrl);
    this.host = url.hostname;
    this.port = parseInt(url.port, 10) || 9222;
  }

  /** Health check — returns pong if daemon is alive */
  async ping(timeoutMs = 5000): Promise<{ pong: boolean }> {
    return this.rpc("ping", {}, timeoutMs);
  }

  /** Get the default identity npub */
  async identityNpub(): Promise<{ npub: string }> {
    return this.rpc("identity_npub", {});
  }

  /** List all groups */
  async listGroups(): Promise<{
    groups: Array<{ nostr_id: string; name?: string }>;
  }> {
    return this.rpc("list_groups", {});
  }

  /** Send a message to a group */
  async sendMessage(
    groupId: string,
    content: string,
    publish = true
  ): Promise<{ sent: boolean; event_id?: string }> {
    // 30s: relay publishing (especially damus.io) can be slow under load
    return this.rpc("send_message", {
      group_id: groupId,
      content,
      publish,
    }, 30000);
  }

  /** Trigger a receive cycle (fetch new messages from relays) */
  async receive(): Promise<{ new_messages: number; new_welcomes: number }> {
    return this.rpc("receive", {});
  }

  /** Generic JSON-RPC call over TCP (line-delimited JSON) */
  private async rpc<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 10000
  ): Promise<T> {
    const requestId = Date.now();
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method,
      params,
    }) + "\n";

    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(
        { host: this.host, port: this.port },
        () => {
          socket.write(request);
        }
      );

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`marmot RPC ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      let buffer = "";

      socket.on("data", (data: Buffer) => {
        buffer += data.toString();
        // Try to parse complete JSON objects from the buffer
        const lines = buffer.split("\n");
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const response = JSON.parse(line);
            if (response.id === requestId) {
              clearTimeout(timer);
              socket.destroy();
              if (response.error) {
                reject(
                  new Error(
                    `marmot RPC error: ${response.error.message ?? JSON.stringify(response.error)}`
                  )
                );
              } else {
                resolve(response.result as T);
              }
              return;
            }
          } catch {
            // Not valid JSON or not our response, skip
          }
        }
        // Keep the last (incomplete) line in the buffer
        buffer = lines[lines.length - 1];
      });

      socket.on("error", (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`marmot RPC ${method} connection error: ${err.message}`));
      });

      socket.on("close", () => {
        clearTimeout(timer);
        // If we haven't resolved yet, this is an unexpected close
        reject(new Error(`marmot RPC ${method} connection closed before response`));
      });
    });
  }
}

// ──────────────────────────────────────────────────────────
// Daemon state management
// ──────────────────────────────────────────────────────────

/** Create a fresh daemon state tracker */
export function createDaemonState(): DaemonState {
  return {
    process: null,
    running: false,
    lastPing: 0,
    restartCount: 0,
    startedAt: null,
  };
}

/** Incremental backoff for daemon restarts */
export function computeBackoff(attempts: number): number {
  const BACKOFF_INITIAL_MS = 1000;
  const BACKOFF_MAX_MS = 10000;
  const BACKOFF_FACTOR = 2;
  const BACKOFF_JITTER = 0.2;

  const base = Math.min(
    BACKOFF_INITIAL_MS * Math.pow(BACKOFF_FACTOR, attempts),
    BACKOFF_MAX_MS
  );
  const jitter = base * BACKOFF_JITTER * Math.random();
  return base + jitter;
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}