/**
 * Channel entry — the primary entry point that OpenClaw loads at startup.
 *
 * This file defines the bundled channel entry contract: it tells OpenClaw
 * how to discover the marmot plugin (api.ts → marmotPlugin) and how to
 * inject the runtime (runtime-api.ts → setMarmotRuntime).
 *
 * Mirrors exactly how Signal does it in extensions/signal/channel-entry.ts
 */

import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "marmot",
  name: "Marmot",
  description: "End-to-end encrypted Nostr messaging via MLS (Marmot Protocol)",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "marmotPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setMarmotRuntime",
  },
});