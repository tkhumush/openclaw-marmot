/**
 * Setup entry — defines the bundled setup entry for channel onboarding.
 *
 * Used by `openclaw setup marmot` to guide users through initial configuration.
 * Phase 6 will fill in the actual setup wizard.
 */

import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "marmotSetupPlugin",
  },
});