# @openclaw/marmot — Implementation Plan

## Overview

Build a native OpenClaw channel plugin that bridges `marmot-cli` (Marmot Protocol / MLS over Nostr) into OpenClaw's messaging pipeline, following the same pattern as the built-in `@openclaw/signal` plugin.

## Architecture Reference: How Signal Works

The Signal plugin (`@openclaw/signal`) follows this pattern:

1. **Daemon lifecycle**: `spawnSignalDaemon()` auto-starts `signal-cli daemon` as subprocess with built args, pipes stdout/stderr, tracks exit via `exitedPromise`
2. **Inbound**: `runSignalSseLoop()` connects to `signal-cli`'s HTTP SSE endpoint, `createSignalEventHandler()` parses `event === "receive"` events, normalizes into OpenClaw channel envelope, dispatches to agent/reply pipeline via `inboundDebouncer`
3. **Outbound**: `sendFormattedSignalText()` / `sendFormattedSignalMedia()` via `signal-cli` JSON-RPC
4. **Plugin factory**: `createChatChannelPlugin({ base, security, pairing, threading, outbound })` builds the ChannelPlugin object
5. **Entries**: `defineBundledChannelEntry` + `defineBundledChannelSetupEntry` in `channel-entry.ts` + `setup-entry.ts`
6. **Manifest**: `openclaw.plugin.json` with `id`, `channels[]`, `channelConfigs.<id>.schema`
7. **Package**: `package.json` with `openclaw.extensions`, `openclaw.setupEntry`, `openclaw.channel` metadata

## marmot-cli Daemon Architecture

### RPC Server (port 9222, JSON-RPC over TCP)

The daemon runs two things in parallel:
1. **JSON-RPC TCP server** — one JSON object per line, accepts RPC calls
2. **Live WebSocket subscription** — persistent connection to Nostr relays; pushes new events to local SQLite DB in real-time

Available RPC methods:

| Method | Params | Returns |
|---|---|---|
| `ping` | — | `{"pong": true}` |
| `identity_npub` | — | `{"npub": "npub1..."}` |
| `list_groups` | — | `{"groups": [{"nostr_id": "<hex>", "name": "<str>"}]}` |
| `send_message` | `group_id`, `content`, `publish` | `{"sent": true, "event_id": "<hex>", "published": bool}` |
| `receive` | — | `{"new_messages": N, "new_welcomes": N}` |

### CLI Subprocess (for polling read)

- `marmot-cli dm messages --group <hex> [--limit N] [--after <ts>]` — read DM messages with pagination
- `marmot-cli groups messages --group <hex> [--limit N] [--after <ts>]` — read group messages
- `marmot-cli chats list [--limit N]` — all conversations with last message preview
- `marmot-cli dm list` — list all DMs with group IDs
- `marmot-cli groups list` — list all named groups with IDs

### Message Output Format (for parsing)

```
Messages in '<Direct Message>' (newest first):
  [1778591294] npub16q3kvq68q8a: Hey Alice! Bob here.
  [1778591214] npub16y4nacm24yu: Hello Bob!
  (2 messages)
```

Parse pattern: `\[<unix-ts>\] <npub-prefix>: <content>`

---

## Plugin Design

### Inbound Message Flow

#### Phase 1: Polling (MVP)

The daemon auto-processes incoming events into the local SQLite DB. The plugin polls `dm messages` and `groups messages` for each group, tracking the last-seen timestamp. New messages are normalized and dispatched to OpenClaw.

```
Nostr Relay → Daemon WebSocket → SQLite DB (auto-stored)
                                        ↓
                                Plugin polls every 5s
                                        ↓
                                New messages → normalize → OpenClaw inbound
```

**Implementation**: 
- `monitorMarmotProvider()` — main monitor function (like `monitorSignalProvider()`)
- `pollMarmotMessages()` — polls CLI for new messages since last-seen timestamp
- State tracked in `lastSeenTimestamps: Map<groupId, number>`
- Uses `--after <ts>` flag on `dm messages` / `groups messages` for incremental fetch
- Auto-accept group invitations on receive (or queue for approval depending on groupPolicy)

**Pros**: Simple, no daemon changes needed, works today
**Cons**: Up to 5s latency, polling overhead

#### Phase 2: Daemon Event Streaming (future)

Add a `subscribe` RPC method to the marmot-cli daemon that pushes new message events over the JSON-RPC connection as they arrive. The plugin maintains a persistent connection and processes events in real-time.

```
Nostr Relay → Daemon WebSocket → SQLite DB + push event over RPC connection
                                        ↓
                                Plugin receives in real-time → normalize → OpenClaw inbound
```

**Pros**: Real-time (<1s latency), no polling
**Cons**: Requires marmot-cli daemon code changes (new RPC method + event push)

### Outbound Message Flow

Use daemon RPC `send_message` for sending. The plugin resolves OpenClaw outbound targets to marmot group IDs.

```
OpenClaw agent reply → message tool → plugin outbound → daemon RPC send_message → relay
```

**Implementation**:
- `sendMarmotMessage({ groupId, content, publish })` — calls daemon RPC
- `resolveMarmotOutboundTarget(target)` — resolves OpenClaw target string to marmot group ID
- Target formats: `marmot:<npub>` (DM), `marmot:group:<hex>` (group)

### Inbound Normalization

marmot-cli output:
```
[1778591294] npub16q3kvq68q8a: Hey Alice! Bob here.
```

OpenClaw channel envelope needs:
- `channel`: `"marmot"`
- `chatId`: group nostr-id (hex) for groups, or sender npub for DMs
- `senderId`: sender npub
- `text`: message content
- `timestamp`: unix timestamp
- `groupId`: nostr-group-id (for group messages)
- `isGroup`: boolean

### Session Key Mapping

- **DM**: `marmot:<npub>` — routes to agent main session
- **Group**: `marmot:group:<nostr-group-id>` — routes to isolated session

### Daemon Lifecycle

- **autoStart: true**: Spawn `marmot-cli daemon --listen <host>:<port>` as a subprocess
- Health check via `ping` RPC every 30s
- Auto-restart on crash with exponential backoff (1s initial, 10s max, factor 2, jitter 0.2 — same as Signal)
- **autoStart: false**: Connect to existing daemon at `daemonHost:daemonPort`

### Security Model

- `dmPolicy`: `"open"` (default) — anyone with our npub can DM
  - `"allowlist"` — only npubs in `allowFrom`
  - `"pairing"` — new senders get a pairing code (future)
  - `"disabled"` — no DMs
- `allowFrom`: list of npubs for `allowlist` policy
- `groupPolicy`: `"open"` (default) — auto-accept group invitations
  - `"allowlist"` — only groups from `groupAllowFrom`
  - `"disabled"` — no groups
- `groupAllowFrom`: list of nostr-group-ids or npubs

---

## Project Structure

```
@openclaw/marmot/
├── package.json                    # NPM package with openclaw metadata
├── openclaw.plugin.json            # Plugin manifest (id, channels, configSchema)
├── tsconfig.json                   # TypeScript config (ESM, Node 22+)
├── src/
│   ├── index.ts                    # Plugin entry point (registers runtime)
│   ├── channel-entry.ts            # defineBundledChannelEntry
│   ├── setup-entry.ts             # defineBundledChannelSetupEntry
│   ├── api.ts                      # Re-exports: marmotPlugin, marmotSetupPlugin
│   ├── daemon.ts                   # Daemon lifecycle (spawn, health, restart)
│   ├── monitor.ts                  # Inbound message polling
│   ├── outbound.ts                 # Message sending via daemon RPC
│   ├── normalize.ts                # marmot message → OpenClaw channel envelope
│   ├── config.ts                   # Config schema, defaults, validation
│   ├── security.ts                 # DM policy, group policy, allowFrom
│   └── types.ts                    # Shared TypeScript types
├── test/
│   ├── daemon.test.ts
│   ├── monitor.test.ts
│   ├── outbound.test.ts
│   └── normalize.test.ts
├── PLAN.md                         # This file
└── README.md
```

---

## Configuration Schema

### openclaw.plugin.json

```json
{
  "id": "marmot",
  "activation": { "onStartup": false },
  "channels": ["marmot"],
  "configSchema": {},
  "channelConfigs": {
    "marmot": {
      "schema": {
        "type": "object",
        "required": ["dmPolicy", "groupPolicy"],
        "properties": {
          "enabled": { "type": "boolean", "default": true },
          "cliPath": { "type": "string", "default": "marmot-cli" },
          "daemonHost": { "type": "string", "default": "127.0.0.1" },
          "daemonPort": { "type": "integer", "default": 9222 },
          "autoStart": { "type": "boolean", "default": true },
          "identityName": { "type": "string", "default": "default" },
          "dmPolicy": {
            "type": "string",
            "enum": ["open", "allowlist", "pairing", "disabled"],
            "default": "open"
          },
          "allowFrom": {
            "type": "array",
            "items": { "type": "string" },
            "default": []
          },
          "groupPolicy": {
            "type": "string",
            "enum": ["open", "allowlist", "disabled"],
            "default": "open"
          },
          "groupAllowFrom": {
            "type": "array",
            "items": { "type": "string" },
            "default": []
          },
          "pollIntervalMs": { "type": "integer", "default": 5000 },
          "startupTimeoutMs": { "type": "integer", "default": 30000 }
        }
      },
      "label": "Marmot",
      "description": "End-to-end encrypted Nostr messaging via MLS (Marmot Protocol)",
      "uiHints": {
        "cliPath": { "label": "CLI Path", "help": "Path to marmot-cli binary" },
        "daemonPort": { "label": "Daemon Port", "help": "JSON-RPC daemon port" },
        "identityName": { "label": "Identity", "help": "marmot-cli identity name to use" },
        "dmPolicy": { "label": "DM Policy", "help": "Who can send you direct messages" },
        "groupPolicy": { "label": "Group Policy", "help": "Who can add you to groups" }
      }
    }
  }
}
```

### package.json (openclaw section)

```json
{
  "name": "@openclaw/marmot",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "openclaw": {
    "extensions": ["./dist/index.js"],
    "setupEntry": "./dist/setup-entry.js",
    "channel": {
      "id": "marmot",
      "label": "Marmot",
      "selectionLabel": "Marmot (marmot-cli)",
      "detailLabel": "Marmot Protocol MLS",
      "docsPath": "/channels/marmot",
      "docsLabel": "marmot",
      "blurb": "End-to-end encrypted Nostr messaging via MLS. Requires marmot-cli.",
      "cliAddOptions": [
        {
          "flags": "--marmot-npub <npub>",
          "description": "Marmot identity npub"
        },
        {
          "flags": "--daemon-port <port>",
          "description": "Marmot daemon JSON-RPC port"
        }
      ]
    },
    "compat": {
      "pluginApi": 1,
      "minGatewayVersion": "0.50.0"
    }
  }
}
```

---

## Implementation Phases

### Phase 1: Minimum Viable Plugin (v0.1.0)

**Goal**: Get marmot messages flowing into and out of OpenClaw.

| # | Task | Description |
|---|------|-------------|
| 1 | Project scaffold | package.json, tsconfig.json, openclaw.plugin.json, src/ structure |
| 2 | Channel entry | `defineBundledChannelEntry` + `defineBundledChannelSetupEntry` |
| 3 | Plugin factory | `createChatChannelPlugin({ base, security, outbound })` |
| 4 | Daemon lifecycle | Spawn `marmot-cli daemon`, health check via `ping`, auto-restart |
| 5 | Inbound polling | `monitorMarmotProvider()` — poll `dm messages` / `groups messages` every 5s |
| 6 | Message normalization | Parse marmot output → OpenClaw channel envelope |
| 7 | Outbound sending | `send_message` via daemon RPC |
| 8 | DM session routing | DMs → agent main session |
| 9 | Group session routing | Groups → isolated sessions |
| 10 | Config | Basic config schema with required fields |
| 11 | Setup wizard | Check marmot-cli installed, create identity, publish keypackage |

### Phase 2: Robustness (v0.2.0)

| # | Task | Description |
|---|------|-------------|
| 12 | Pairing flow | DM approval via `openclaw pairing approve marmot <CODE>` |
| 13 | Reactions | `messages react` CLI command → kind 7 emoji reactions |
| 14 | Message deletion | `messages delete` CLI command |
| 15 | Group management | Invite/remove/promote/demote via CLI |
| 16 | Error handling | Relay failures, epoch mismatches, KeyPackage rotation, daemon crash recovery |
| 17 | Multi-identity | Support `identityName` config for non-default identities |
| 18 | Stale group cleanup | Detect and handle orphaned groups from deleted identities |
| 19 | Tests | Unit tests for daemon, monitor, outbound, normalize |

### Phase 3: Real-time Streaming (v0.3.0)

| # | Task | Description |
|---|------|-------------|
| 20 | Daemon `subscribe` RPC | Add event push over JSON-RPC connection to marmot-cli |
| 21 | Real-time inbound | Replace polling with persistent RPC connection + event handler |
| 22 | Remove polling | Deprecate `pollIntervalMs` config |

### Phase 4: Polish (v1.0.0)

| # | Task | Description |
|---|------|-------------|
| 23 | Media support | Image/file sending when marmot-cli supports it |
| 24 | ClawHub publish | `clawhub package publish @openclaw/marmot` |
| 25 | marmot-cli GitHub releases | Pre-built binaries for Linux x64/arm64, macOS |
| 26 | Setup wizard (full) | Download marmot-cli binary, create identity, configure relays |
| 27 | Docs | Channel docs in OpenClaw docs format |

---

## Key Differences from Signal

| Aspect | Signal | marmot |
|--------|--------|--------|
| Transport | HTTP SSE (signal-cli) | JSON-RPC TCP + polling (v1) |
| Identity | Phone number (E.164) | Nostr npub |
| Groups | Signal groups (base64 ID) | MLS groups (hex nostr-id) |
| Pairing | SMS/QR code verification | KeyPackage exchange (no verification yet) |
| Typing indicators | Supported | Not supported by MLS protocol |
| Read receipts | Supported | Not supported |
| Reactions | Supported | Supported (kind 7) |
| Media | Attachments via signal-cli | Not yet (text only in v1) |
| Daemon binary | signal-cli (Java/native) | marmot-cli (Rust) |
| Inbound latency | Real-time via SSE | ~5s via polling (v1), <1s (v3) |

---

## Open Questions

1. **npm package name**: `@openclaw/marmot` or `openclaw-marmot`? (Need to check ClawHub naming conventions)
2. **Daemon auto-receive**: Does the daemon's WebSocket subscription auto-trigger `receive` processing, or does the plugin need to call `receive` RPC periodically? (Testing suggests daemon auto-processes, but need to verify)
3. **Group invitation handling**: Should `groupPolicy: "open"` auto-accept invitations via `groups join`, or just auto-process via `receive`? (Current behavior: `receive` fetches invitations, `groups join` accepts them)
4. **npub resolution**: How to map sender npub to display name? (marmot-cli `users show <npub>` fetches kind 0, but this is an extra relay call per new sender)
5. **marmot-cli distribution**: GitHub releases with pre-built binaries? crates.io `cargo install`? Both?
6. **Daemon `subscribe` RPC design**: Should it push full message objects, or just group-id + "new messages available" hints?