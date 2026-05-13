# Implementation Phases — @openclaw/marmot

## Waterfall Approach

Each phase must be **complete and tested** before moving to the next.

---

## Phase 1: Project Scaffold + Plugin Registration

**Goal**: OpenClaw discovers and loads the plugin. No messaging yet.

- [x] Create repo: `~/projects/openclaw-marmot`
- [x] Create `package.json` with `openclaw` metadata
- [x] Create `openclaw.plugin.json` with channel config schema
- [x] Create `tsconfig.json` (ESM, Node 22+, strict)
- [x] Create `src/index.ts` — plugin entry point
- [x] Create `src/channel-entry.ts` — `defineBundledChannelEntry`
- [x] Create `src/setup-entry.ts` — `defineBundledChannelSetupEntry`
- [x] Create `src/api.ts` — re-exports: `marmotPlugin`, `marmotSetupPlugin`
- [x] Create `src/types.ts` — shared TypeScript types
- [ ] Install OpenClaw plugin SDK dependency
- [ ] Build and verify: `openclaw plugins install --link .` from project dir
- [ ] Restart gateway and verify: `openclaw plugins list` shows marmot
- [ ] Verify: `openclaw plugins inspect marmot --runtime --json` shows channel config

**Deliverable**: Plugin loads, shows in `plugins list`, gateway starts without error.

---

## Phase 2: Daemon Lifecycle

**Goal**: Plugin can start/stop/health-check the marmot-cli daemon.

- [ ] `src/daemon.ts` — spawn daemon, track PID, pipe stdout/stderr
- [ ] `src/daemon.ts` — `ping()` health check via JSON-RPC
- [ ] `src/daemon.ts` — auto-restart on crash (exponential backoff)
- [ ] `src/daemon.ts` — `identityNpub()` — get default identity npub
- [ ] `src/daemon.ts` — `listGroups()` — list all groups
- [ ] Wire daemon lifecycle into `gateway.startAccount`
- [ ] Test: plugin starts daemon on gateway boot
- [ ] Test: plugin detects daemon crash and restarts
- [ ] Test: plugin connects to already-running daemon (autoStart: false)

**Deliverable**: Gateway starts → marmot daemon auto-starts → `ping` returns pong.

---

## Phase 3: Inbound Polling + Normalization

**Goal**: New marmot messages appear in OpenClaw agent sessions.

- [ ] `src/monitor.ts` — `monitorMarmotProvider()` main loop
- [ ] `src/monitor.ts` — poll `chats list` for all conversations
- [ ] `src/monitor.ts` — poll `dm messages --group <hex> --after <ts>` for new DMs
- [ ] `src/monitor.ts` — poll `groups messages --group <hex> --after <ts>` for group messages
- [ ] `src/normalize.ts` — parse marmot output format → OpenClaw channel envelope
- [ ] `src/normalize.ts` — extract timestamp, sender npub, text content
- [ ] Wire monitor into gateway lifecycle (start/stop with abortSignal)
- [ ] Track `lastSeenTimestamps: Map<groupId, number>` in monitor state
- [ ] Skip self-messages (sender === our npub)
- [ ] Apply DM policy (open/allowlist/disabled) before dispatching
- [ ] Apply group policy before dispatching
- [ ] Test: send DM from White Noise → appears in OpenClaw session
- [ ] Test: send group message → appears in OpenClaw session
- [ ] Test: self-messages are skipped

**Deliverable**: Messages sent from White Noise arrive in OpenClaw within ~5s.

---

## Phase 4: Outbound Sending

**Goal**: OpenClaw agent can reply to marmot messages.

- [ ] `src/outbound.ts` — `sendMarmotMessage()` via daemon RPC `send_message`
- [ ] `src/outbound.ts` — `resolveMarmotOutboundTarget()` — parse target strings
- [ ] Wire outbound into `createChatChannelPlugin` outbound config
- [ ] Handle DM routing: `marmot:<npub>` → find/create DM group → send
- [ ] Handle group routing: `marmot:group:<hex>` → send directly
- [ ] Handle text chunking (marmot has no explicit limit, but cap at ~4000 chars)
- [ ] Test: OpenClaw agent reply → marmot DM → appears in White Noise
- [ ] Test: OpenClaw agent reply → marmot group → appears in White Noise

**Deliverable**: Full round-trip: White Noise → OpenClaw → reply → White Noise.

---

## Phase 5: Security + Config

**Goal**: DM policy, group policy, and allowFrom work correctly.

- [ ] `src/security.ts` — `createRestrictSendersChannelSecurity` adapter
- [ ] DM policy: `open` (anyone), `allowlist` (npubs), `disabled` (no DMs)
- [ ] Group policy: `open` (any group), `allowlist` (specific groups), `disabled`
- [ ] `src/config.ts` — config schema validation, defaults
- [ ] Wire security adapter into `createChatChannelPlugin`
- [ ] Wire allowlist adapter
- [ ] Test: DM from unknown npub with `dmPolicy: "allowlist"` → blocked
- [ ] Test: DM from allowed npub → passes through
- [ ] Test: Group message with `groupPolicy: "disabled"` → blocked

**Deliverable**: Security policies enforced, config validated.

---

## Phase 6: Setup Wizard

**Goal**: First-time setup via `openclaw setup marmot`.

- [ ] `src/setup.ts` — check marmot-cli binary exists
- [ ] `src/setup.ts` — create default identity if none exists
- [ ] `src/setup.ts` — publish KeyPackage to relays
- [ ] `src/setup.ts` — write config to openclaw.json
- [ ] Wire setup wizard into channel entry
- [ ] Test: fresh install → `openclaw setup marmot` → config written → daemon starts

**Deliverable**: New users can set up marmot channel interactively.

---

## Phase 7: Polish + Testing

**Goal**: Production-ready.

- [ ] Error handling: daemon crash recovery, relay failures, epoch mismatches
- [ ] Logging: structured logging via OpenClaw runtime
- [ ] Health status: probe daemon, report status to OpenClaw
- [ ] Heartbeat: typing indicators (if daemon supports), status probes
- [ ] Edge cases: empty messages, very long messages, special characters
- [ ] Multi-identity support (future)
- [ ] Unit tests for normalize, outbound, daemon
- [ ] README finalization
- [ ] ClawHub publish dry-run

**Deliverable**: Plugin is stable, documented, ready for ClawHub.