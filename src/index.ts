/**
 * @openclaw/marmot — Plugin entry point.
 *
 * Registers the marmot channel plugin with OpenClaw.
 * The default export is the channel entry (defineBundledChannelEntry),
 * which tells OpenClaw how to discover and load the plugin.
 *
 * This file is what `openclaw plugins install --link .` reads to find
 * the channel entry.
 */

export { default } from "./channel-entry.js";