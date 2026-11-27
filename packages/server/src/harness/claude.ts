import type { ClaudeOauth, ResolvedClaudeConfig } from "../types.js";
import {
  GIT_HYGIENE_HOOK_TIMEOUT_SECONDS,
  HOOKS_DIR,
  WORKSPACE_DIR,
  isRecord,
  jsonFile,
  stringEntries,
  type HarnessSetup,
} from "./types.js";

const SETTINGS_RELATIVE_PATH = "root/.claude/settings.json";
const CREDENTIALS_RELATIVE_PATH = "root/.claude/.credentials.json";
const CONFIG_RELATIVE_PATH = "root/.claude.json";
const FORCED_ALLOWED_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"];

function buildClaudePermissions(permissions: unknown): Record<string, unknown> {
  const permissionsRecord = isRecord(permissions) ? permissions : {};

  return {
    ...permissionsRecord,
    defaultMode: "bypassPermissions",
    allow: [...new Set([...stringEntries(permissionsRecord.allow), ...FORCED_ALLOWED_TOOLS])],
  };
}

export function buildClaudeHooks(): Record<string, unknown> {
  const command = (script: string, timeout?: number) => ({
    hooks: [{ type: "command", command: `node ${HOOKS_DIR}/${script}`, ...(timeout ? { timeout } : {}) }],
  });
  const matching = (matcher: string, script: string) => ({ matcher, ...command(script) });

  return {
    UserPromptSubmit: [command("task-description.js"), command("instance-status.js working")],
    PreToolUse: [matching("AskUserQuestion", "instance-status.js waiting")],
    Notification: [matching("permission_prompt", "instance-status.js waiting")],
    PostToolUse: [command("instance-status.js working")],
    Stop: [command("git-hygiene.js", GIT_HYGIENE_HOOK_TIMEOUT_SECONDS)],
    SessionEnd: [command("instance-status.js finished")],
  };
}

export function buildClaudeSettings(config: Record<string, unknown> | undefined): Record<string, unknown> {
  const baseConfig = isRecord(config) ? config : {};

  return {
    ...baseConfig,
    permissions: buildClaudePermissions(baseConfig.permissions),
    hooks: buildClaudeHooks(),
    skipDangerousModePermissionPrompt: true,
  };
}

function buildClaudeCredentials(oauth: ClaudeOauth): Record<string, unknown> {
  return { claudeAiOauth: oauth };
}

function buildClaudeConfig(): Record<string, unknown> {
  return {
    hasCompletedOnboarding: true,
    theme: "dark",
    projects: {
      [WORKSPACE_DIR]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    },
  };
}

export function buildClaudeSetup(config: ResolvedClaudeConfig): HarnessSetup {
  return {
    files: [
      jsonFile(SETTINGS_RELATIVE_PATH, buildClaudeSettings(config.claude), 0o444),
      jsonFile(CREDENTIALS_RELATIVE_PATH, buildClaudeCredentials(config.oauth), 0o600),
      jsonFile(CONFIG_RELATIVE_PATH, buildClaudeConfig(), 0o600),
    ],
    env: {},
  };
}
