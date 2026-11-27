import type { ResolvedEnvironmentConfig } from "../types.js";
import { buildAntigravitySetup } from "./antigravity.js";
import { buildClaudeSetup } from "./claude.js";
import type { HarnessSetup } from "./types.js";

export type { HarnessFile, HarnessSetup } from "./types.js";

export function buildHarnessSetup(config: ResolvedEnvironmentConfig): HarnessSetup {
  return config.agent === "antigravity" ? buildAntigravitySetup(config) : buildClaudeSetup(config);
}
