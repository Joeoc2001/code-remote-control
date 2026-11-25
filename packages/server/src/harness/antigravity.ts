import type { ResolvedAntigravityConfig } from "../types.js";
import {
  GIT_HYGIENE_HOOK_TIMEOUT_SECONDS,
  HOOKS_DIR,
  WORKSPACE_DIR,
  isRecord,
  jsonFile,
  stringEntries,
  type HarnessSetup,
} from "./types.js";

const SETTINGS_RELATIVE_PATH = "root/.gemini/antigravity-cli/settings.json";
const ONBOARDING_RELATIVE_PATH = "root/.gemini/antigravity-cli/cache/onboarding.json";
const HOOKS_RELATIVE_PATH = "root/.gemini/config/hooks.json";
const HOOK_GROUP = "crc";
const FORCED_ALLOWED_ACTIONS = ["command(*)", "write_file(*)", "read_file(*)", "read_url(*)", "mcp(*)"];
const QUESTION_TOOLS_MATCHER = "ask_question|ask_permission";
const EVERY_TOOL_MATCHER = "";

function buildAntigravityPermissions(permissions: unknown): Record<string, unknown> {
  const permissionsRecord = isRecord(permissions) ? permissions : {};

  return {
    ...permissionsRecord,
    allow: [...new Set([...stringEntries(permissionsRecord.allow), ...FORCED_ALLOWED_ACTIONS])],
  };
}

export function buildAntigravityHooks(): Record<string, unknown> {
  const command = (script: string, timeout?: number) => ({
    type: "command",
    command: `node ${HOOKS_DIR}/${script}`,
    ...(timeout ? { timeout } : {}),
  });
  const instanceStatus = (state: string, event: string) =>
    command(`instance-status.js ${state} --harness antigravity --event ${event}`);
  const matching = (matcher: string, state: string, event: string) => ({ matcher, hooks: [instanceStatus(state, event)] });

  return {
    [HOOK_GROUP]: {
      PreInvocation: [
        command("task-description.js --harness antigravity --event PreInvocation"),
        instanceStatus("working", "PreInvocation"),
      ],
      PreToolUse: [matching(QUESTION_TOOLS_MATCHER, "waiting", "PreToolUse")],
      PostToolUse: [matching(EVERY_TOOL_MATCHER, "working", "PostToolUse")],
      Stop: [command("git-hygiene.js --harness antigravity", GIT_HYGIENE_HOOK_TIMEOUT_SECONDS)],
    },
  };
}

export function buildAntigravitySettings(config: Record<string, unknown> | undefined): Record<string, unknown> {
  const baseConfig = isRecord(config) ? config : {};

  return {
    colorScheme: "dark",
    ...baseConfig,
    modelProvider: "gemini",
    toolPermission: "always-proceed",
    trustedWorkspaces: [...new Set([...stringEntries(baseConfig.trustedWorkspaces), WORKSPACE_DIR])],
    permissions: buildAntigravityPermissions(baseConfig.permissions),
  };
}

function buildAntigravityOnboarding(): Record<string, unknown> {
  return {
    consumerOnboardingComplete: true,
    enterpriseOnboardingComplete: false,
    onboardingComplete: true,
  };
}

export function buildAntigravitySetup(config: ResolvedAntigravityConfig): HarnessSetup {
  return {
    files: [
      jsonFile(SETTINGS_RELATIVE_PATH, buildAntigravitySettings(config.antigravity), 0o600),
      jsonFile(ONBOARDING_RELATIVE_PATH, buildAntigravityOnboarding(), 0o600),
      jsonFile(HOOKS_RELATIVE_PATH, buildAntigravityHooks(), 0o444),
    ],
    env: { GEMINI_API_KEY: config.gemini.api_key },
  };
}
