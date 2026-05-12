# @openclaw/marmot

OpenClaw channel plugin for [Marmot Protocol](https://github.com/marmot-protocol) — end-to-end encrypted Nostr messaging via MLS (RFC 9420).

## What This Is

A native OpenClaw channel plugin that integrates `marmot-cli` into OpenClaw's messaging pipeline, following the same architecture as the built-in Signal plugin.

## How It Works

- **Inbound**: Polls marmot-cli daemon for new messages, normalizes into OpenClaw channel envelope, dispatches to agent pipeline
- **Outbound**: Sends messages via marmot-cli daemon JSON-RPC (`send_message`)
- **Daemon**: Auto-starts `marmot-cli daemon` as a subprocess, health-checks via `ping` RPC, auto-restarts on crash
- **Sessions**: DMs route to agent main session, groups route to isolated sessions

## Prerequisites

- [OpenClaw](https://openclaw.ai) installed and running
- `marmot-cli` binary installed on the system (see [marmot-cli](https://github.com/tkhumush/marmot-cli))

## Installation

```bash
# Install from ClawHub (once published)
openclaw plugins install clawhub:@openclaw/marmot

# Or from GitHub
openclaw plugins install github:tkhumush/openclaw-marmot

# Restart gateway
openclaw gateway restart
```

## Configuration

Add to your `openclaw.json`:

```json5
{
  channels: {
    marmot: {
      enabled: true,
      cliPath: "marmot-cli",
      daemonHost: "127.0.0.1",
      daemonPort: 9222,
      autoStart: true,
      identityName: "default",
      dmPolicy: "open",
      allowFrom: [],
      groupPolicy: "open",
      pollIntervalMs: 5000
    }
  }
}
```

## Status

🚧 **Pre-release** — This plugin is under active development. See [PLAN.md](./PLAN.md) for the roadmap.

## License

MIT