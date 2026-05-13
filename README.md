# @openclaw/marmot

OpenClaw channel plugin for [Marmot Protocol](https://github.com/marmot-protocol) — end-to-end encrypted Nostr messaging via MLS (RFC 9420).

## What This Is

A native OpenClaw channel plugin that integrates `marmot-cli` into OpenClaw's messaging pipeline, following the same architecture as the built-in Signal plugin.

## How It Works

- **Inbound**: Polls marmot-cli daemon for new messages every `pollIntervalMs`, dispatches to agent pipeline
- **Outbound**: Sends messages via marmot-cli daemon JSON-RPC (`send_message`, 30s timeout for relay publishing)
- **Daemon**: Auto-starts `marmot-cli daemon` as a subprocess, health-checks via `ping` RPC, auto-restarts on crash
- **Sessions**: DMs route to agent main session, named groups route to isolated sessions

## Prerequisites

- [OpenClaw](https://openclaw.ai) installed and running
- `marmot-cli` binary installed on the system (see [marmot-cli](https://github.com/tkhumush/marmot-cli))
- A default marmot identity created and set: `marmot-cli identity create --name default && marmot-cli identity set-default default`

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
      cliPath: "marmot-cli",       // path to the marmot-cli binary
      daemonHost: "127.0.0.1",
      daemonPort: 9222,
      autoStart: true,             // auto-spawn daemon if not running
      identityName: "default",     // marmot identity to use
      dmPolicy: "allowlist",       // "open" | "allowlist" — use allowlist until you have a pairing UI
      allowFrom: [
        "npub1..."                 // full bech32 npubs that can message your agent
      ],
      groupPolicy: "open",
      pollIntervalMs: 5000
    }
  }
}
```

**Use `dmPolicy: "allowlist"` in production.** With `"open"`, any Nostr user who obtains your agent's npub can send it messages. Populate `allowFrom` with the full bech32 npubs of users who should have access.

## Setting Up a DM Conversation

MLS requires an explicit invite before two parties can exchange messages. This is a one-time setup per user.

1. **User publishes their KeyPackage** — in White Noise: Settings → Identity → Publish KeyPackage. This must be done before the invite, or the invite will time out looking for it on relays.

2. **Create the DM group from marmot-cli** (do this from the identity your agent uses):
   ```bash
   marmot-cli dm create --recipient <user-npub> --publish
   ```
   This creates the MLS group and sends a wrapped welcome invitation to the user's relay inbox. The marmot identity becomes the group admin. Note the group's nostr-id from `marmot-cli dm list`.

3. **User accepts the invite** — the invite appears in White Noise as a new DM conversation. The user taps to accept.

4. **Wait for the first message before replying.** Due to how MLS epoch sequencing works, the agent should not send the first message immediately after creating the group. Wait for the user to send a message first; this ensures both parties are at the same epoch before the agent replies. See [Known Issues](#known-issues) for the technical background.

## Logging

The 5-second polling pattern produces `[marmot-daemon] agent storage initialized` lines in the OpenClaw log every poll cycle. This is normal — it reflects `marmot-cli daemon`'s internal context reload on each `receive` call. It is not a crash loop.

Brief `connect ECONNREFUSED` errors during OpenClaw gateway restarts are also expected. The plugin handles these gracefully and resumes polling once the daemon is back up.

## Known Issues

### First message after invite may be dropped ([#3](https://github.com/tkhumush/openclaw-marmot/issues/3))

When `dm create` runs, it creates the MLS group (epoch 0) and immediately adds the member (epoch 1) in the same operation. OpenMLS does not retain app-message secrets for the solo epoch 0. If the invited user's first message was encrypted at epoch 0 (before their welcome is processed), decryption fails silently.

**Workaround:** Have the user send two messages if the first one doesn't appear. The second message will be at epoch 1 and will decrypt correctly.

### Sender npub truncated in CLI message output ([marmot-cli #1](https://github.com/tkhumush/marmot-cli/issues/1))

`marmot-cli dm messages` truncates sender npubs in its text output (e.g. `npub1abc123` instead of the full 59-character bech32). The plugin works around this by seeding a `knownNpubs` table from `config.allowFrom` on every poll cycle, then resolving truncated prefixes before the allowlist check. Once marmot-cli exposes full `sender_npub` in its RPC message responses, this workaround can be removed.

### CLI text-scraping for message polling ([#2](https://github.com/tkhumush/openclaw-marmot/issues/2))

The monitor currently calls `marmot-cli dm messages` as a subprocess and parses the text output. This is fragile and will be replaced with a native RPC `get_messages` method once marmot-cli exposes it.

## Troubleshooting

**No messages arriving from White Noise:**
- Confirm `dmPolicy` and `allowFrom` are set correctly. With `allowlist`, the sender's full npub must be in `allowFrom`.
- Run `marmot-cli receive` manually to force a relay fetch.
- Check that the DM group exists: `marmot-cli dm list`.

**Agent replies not arriving in White Noise:**
- `send_message` publishes to relays before returning and can take up to 30 seconds if damus.io is under load. This is normal.
- Check OpenClaw logs for `dispatch error (final): marmot RPC send_message timed out` — if this appears, the relay was unreachable. The plugin's 30s timeout handles most cases.

**Daemon won't start / EADDRINUSE:**
- A previous daemon process may still be holding port 9222. Kill it: `pkill -f 'marmot-cli daemon'`, then restart OpenClaw.

**Invite not appearing in White Noise:**
- Ensure the user published a KeyPackage *before* you ran `dm create`. If the KeyPackage wasn't on the relays at invite time, the welcome was never sent. Delete the group and retry: `marmot-cli dm create --recipient <npub> --publish`.

## Status

Working. Two-way MLS-encrypted messaging confirmed with White Noise iOS (2026-05-13).

Open issues tracking structural improvements are filed at [tkhumush/openclaw-marmot](https://github.com/tkhumush/openclaw-marmot/issues) and [tkhumush/marmot-cli](https://github.com/tkhumush/marmot-cli/issues).

## License

MIT
