/**
 * Runtime API — marmot plugin runtime store.
 *
 * Mirrors Signal's pattern: createPluginRuntimeStore gives us
 * get/set/clear functions for runtime state (daemon handle, monitor state, etc.)
 * that the gateway injects before starting the provider.
 */

import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { MarmotRuntimeState } from "./types.js";

export const {
  setRuntime: setMarmotRuntime,
  clearRuntime: clearMarmotRuntime,
  tryGetRuntime: tryGetMarmotRuntime,
  getRuntime: getMarmotRuntime,
} = createPluginRuntimeStore<MarmotRuntimeState>({
  pluginId: "marmot",
  errorMessage: "Marmot runtime not initialized",
});