import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentFromLabels, buildContainerEnv } from "../packages/server/src/docker.js";
import type { ResolvedAntigravityConfig, ResolvedClaudeConfig } from "../packages/server/src/types.js";
import { buildAntigravityHooks, buildAntigravitySettings } from "../packages/server/src/harness/antigravity.js";
import { buildClaudeHooks, buildClaudeSettings } from "../packages/server/src/harness/claude.js";
import { buildHarnessSetup, type HarnessSetup } from "../packages/server/src/harness/index.js";

const REPO_HOOKS_DIR = path.join(__dirname, "..", "agent-hooks", "hooks");

const CLAUDE_CONFIG: ResolvedClaudeConfig = {
  name: "claude-default",
  agent: "claude",
  oauth: { accessToken: "claude-token" },
  claude: { model: "opus", permissions: { allow: ["mcp__docs"], deny: ["WebSearch"] } },
};

const ANTIGRAVITY_CONFIG: ResolvedAntigravityConfig = {
  name: "gemini-default",
  agent: "antigravity",
  gemini: { api_key: "gemini-key" },
  antigravity: { model: "gemini-3.1-pro", permissions: { allow: ["command(git *)"], deny: ["command(rm -rf *)"] } },
};

function fileJson(setup: HarnessSetup, filePath: string): Record<string, unknown> {
  const file = setup.files.find((candidate) => candidate.path === filePath);
  assert.ok(file, `${filePath} is not injected; got ${setup.files.map((candidate) => candidate.path).join(", ")}`);
  return JSON.parse(file.content.toString("utf-8"));
}

function fileMode(setup: HarnessSetup, filePath: string): number {
  return setup.files.find((candidate) => candidate.path === filePath)!.mode;
}

interface AntigravityCommand {
  type: string;
  command: string;
  timeout?: number;
}

type AntigravityEvents = Record<string, Array<AntigravityCommand | { matcher: string; hooks: AntigravityCommand[] }>>;

function antigravityEvents(): AntigravityEvents {
  const hooks = buildAntigravityHooks() as Record<string, AntigravityEvents>;
  assert.deepEqual(Object.keys(hooks), ["crc"]);
  return hooks.crc;
}

function commandsOf(event: string): AntigravityCommand[] {
  return antigravityEvents()[event].flatMap((entry) => ("hooks" in entry ? entry.hooks : [entry]));
}

describe("claude harness setup", () => {
  const setup = buildHarnessSetup(CLAUDE_CONFIG);

  it("injects settings, credentials and the onboarding config", () => {
    assert.deepEqual(
      setup.files.map((file) => file.path),
      ["root/.claude/settings.json", "root/.claude/.credentials.json", "root/.claude.json"],
    );
    assert.deepEqual(fileJson(setup, "root/.claude/.credentials.json"), { claudeAiOauth: { accessToken: "claude-token" } });
    assert.equal(fileMode(setup, "root/.claude/.credentials.json"), 0o600);
  });

  it("merges the claude block into settings while forcing permissions and hooks", () => {
    const settings = fileJson(setup, "root/.claude/settings.json");
    const permissions = settings.permissions as Record<string, unknown>;

    assert.equal(settings.model, "opus");
    assert.equal(permissions.defaultMode, "bypassPermissions");
    assert.deepEqual(permissions.deny, ["WebSearch"]);
    assert.deepEqual(permissions.allow, ["mcp__docs", "Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"]);
    assert.deepEqual(settings.hooks, buildClaudeHooks());
    assert.deepEqual(buildClaudeSettings(undefined).hooks, buildClaudeHooks());
  });

  it("passes no extra environment and never mentions Antigravity", () => {
    assert.deepEqual(setup.env, {});
    assert.ok(!setup.files.some((file) => file.path.includes(".gemini")));
  });
});

describe("antigravity harness setup", () => {
  const setup = buildHarnessSetup(ANTIGRAVITY_CONFIG);

  it("injects settings, a completed onboarding record and the hooks file, and no Claude Code files", () => {
    assert.deepEqual(
      setup.files.map((file) => file.path),
      [
        "root/.gemini/antigravity-cli/settings.json",
        "root/.gemini/antigravity-cli/cache/onboarding.json",
        "root/.gemini/config/hooks.json",
      ],
    );
  });

  it("leaves settings writable because the CLI rewrites its own settings file", () => {
    assert.equal(fileMode(setup, "root/.gemini/antigravity-cli/settings.json"), 0o600);
  });

  it("authenticates with the Gemini API key through the environment, not a file", () => {
    assert.deepEqual(setup.env, { GEMINI_API_KEY: "gemini-key" });
    for (const file of setup.files) {
      assert.ok(!file.content.toString("utf-8").includes("gemini-key"), `${file.path} contains the API key`);
    }
  });

  it("forces the API-key provider, unattended permissions and workspace trust over the antigravity block", () => {
    const settings = buildAntigravitySettings({
      modelProvider: "google",
      toolPermission: "request-review",
      trustedWorkspaces: ["/data"],
      model: "gemini-3.1-pro",
    });

    assert.equal(settings.modelProvider, "gemini");
    assert.equal(settings.toolPermission, "always-proceed");
    assert.deepEqual(settings.trustedWorkspaces, ["/data", "/workspace"]);
    assert.equal(settings.model, "gemini-3.1-pro");
  });

  it("defaults the colour scheme to dark but lets the antigravity block choose another", () => {
    assert.equal(buildAntigravitySettings(undefined).colorScheme, "dark");
    assert.equal(buildAntigravitySettings({ colorScheme: "tokyo night" }).colorScheme, "tokyo night");
  });

  it("adds the forced allow rules to the configured permissions without dropping any", () => {
    const permissions = fileJson(setup, "root/.gemini/antigravity-cli/settings.json").permissions as Record<string, unknown>;

    assert.deepEqual(permissions.allow, ["command(git *)", "command(*)", "write_file(*)", "read_file(*)", "read_url(*)", "mcp(*)"]);
    assert.deepEqual(permissions.deny, ["command(rm -rf *)"]);
  });

  it("does not list /workspace twice when the block already trusts it", () => {
    assert.deepEqual(buildAntigravitySettings({ trustedWorkspaces: ["/workspace"] }).trustedWorkspaces, ["/workspace"]);
  });

  it("marks onboarding complete so the TUI does not stop on the first-run screens", () => {
    assert.deepEqual(fileJson(setup, "root/.gemini/antigravity-cli/cache/onboarding.json"), {
      consumerOnboardingComplete: true,
      enterpriseOnboardingComplete: false,
      onboardingComplete: true,
    });
  });

  it("writes the hooks to the global hooks file, not into settings", () => {
    assert.deepEqual(fileJson(setup, "root/.gemini/config/hooks.json"), buildAntigravityHooks());
    assert.equal(fileJson(setup, "root/.gemini/antigravity-cli/settings.json").hooks, undefined);
  });
});

describe("antigravity hook wiring", () => {
  it("only uses events Antigravity has", () => {
    assert.deepEqual(Object.keys(antigravityEvents()).sort(), ["PostToolUse", "PreInvocation", "PreToolUse", "Stop"]);
  });

  it("records the task description and marks working before each model invocation", () => {
    assert.deepEqual(
      commandsOf("PreInvocation").map((hook) => hook.command),
      [
        "node /opt/crc/hooks/task-description.js --harness antigravity --event PreInvocation",
        "node /opt/crc/hooks/instance-status.js working --harness antigravity --event PreInvocation",
      ],
    );
  });

  it("marks waiting when the agent asks the user a question or for a permission", () => {
    const [entry] = antigravityEvents().PreToolUse as Array<{ matcher: string; hooks: AntigravityCommand[] }>;

    assert.equal(antigravityEvents().PreToolUse.length, 1);
    assert.ok(new RegExp(entry.matcher).test("ask_question"));
    assert.ok(new RegExp(entry.matcher).test("ask_permission"));
    assert.ok(!new RegExp(entry.matcher).test("run_command"));
    assert.deepEqual(entry.hooks.map((hook) => hook.command), [
      "node /opt/crc/hooks/instance-status.js waiting --harness antigravity --event PreToolUse",
    ]);
  });

  it("marks working after every tool call, which is also the activity heartbeat", () => {
    const [entry] = antigravityEvents().PostToolUse as Array<{ matcher: string; hooks: AntigravityCommand[] }>;

    assert.equal(entry.matcher, "");
    assert.deepEqual(entry.hooks.map((hook) => hook.command), [
      "node /opt/crc/hooks/instance-status.js working --harness antigravity --event PostToolUse",
    ]);
  });

  it("leaves the end of a turn to the git hygiene hook with the same long timeout Claude Code gets", () => {
    const claudeStop = (buildClaudeHooks().Stop as Array<{ hooks: AntigravityCommand[] }>)[0].hooks[0];

    assert.deepEqual(antigravityEvents().Stop, [
      { type: "command", command: "node /opt/crc/hooks/git-hygiene.js --harness antigravity", timeout: 1230 },
    ]);
    assert.equal(claudeStop.timeout, 1230);
  });

  it("every hook command selects the antigravity adapter and names a script that exists", () => {
    const commands = Object.keys(antigravityEvents()).flatMap(commandsOf);

    assert.equal(commands.length, 5);
    for (const hook of commands) {
      assert.equal(hook.type, "command");
      assert.match(hook.command, /^node \/opt\/crc\/hooks\/[a-z-]+\.js .*--harness antigravity/);
      const script = hook.command.split(" ")[1].replace("/opt/crc/hooks", REPO_HOOKS_DIR);
      assert.ok(existsSync(script), `${script} does not exist`);
    }
  });

  it("no Claude Code hook command selects the antigravity adapter", () => {
    assert.ok(!JSON.stringify(buildClaudeHooks()).includes("--harness"));
  });

  it("every tool and invocation hook command, run for real, answers with the JSON Antigravity requires", () => {
    const runDir = mkdtempSync(path.join(os.tmpdir(), "crc-harness-wiring-"));
    try {
      const run = (hook: AntigravityCommand): unknown => {
        const [, script, ...args] = hook.command.split(" ");
        const stdout = execFileSync("node", [script.replace("/opt/crc/hooks", REPO_HOOKS_DIR), ...args], {
          input: JSON.stringify({ conversationId: "c1", lastUserInput: "the task" }),
          encoding: "utf-8",
          env: { PATH: process.env.PATH, CRC_RUN_DIR: runDir, CRC_INSTANCE_STATUS_PATH: path.join(runDir, "status.json") },
        });
        return JSON.parse(stdout);
      };
      const state = () => JSON.parse(readFileSync(path.join(runDir, "status.json"), "utf-8")).state;

      assert.deepEqual(commandsOf("PreInvocation").map(run), [{}, {}]);
      assert.equal(state(), "working");
      assert.equal(readFileSync(path.join(runDir, "crc-current-task-description"), "utf-8"), "the task\n");

      assert.deepEqual(commandsOf("PreToolUse").map(run), [{ decision: "allow" }]);
      assert.equal(state(), "waiting");

      assert.deepEqual(commandsOf("PostToolUse").map(run), [{}]);
      assert.equal(state(), "working");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe("container environment and labels per agent", () => {
  const base = {
    repoUrl: "https://github.com/acme/widgets.git",
    repoSource: "github" as const,
    gitlabUrl: "https://gitlab.com",
    gitUsername: "bot",
    gitEmail: "bot@example.com",
    initialPrompt: undefined,
  };

  it("tells the container which agent to launch", () => {
    const claudeEnv = buildContainerEnv({ ...base, agent: "claude", harnessEnv: {}, configEnv: undefined });
    const antigravityEnv = buildContainerEnv({
      ...base,
      agent: "antigravity",
      harnessEnv: buildHarnessSetup(ANTIGRAVITY_CONFIG).env,
      configEnv: { FOO: "bar" },
    });

    assert.ok(claudeEnv.includes("CRC_AGENT=claude"));
    assert.ok(!claudeEnv.some((entry) => entry.startsWith("GEMINI_API_KEY=")));
    assert.ok(antigravityEnv.includes("CRC_AGENT=antigravity"));
    assert.ok(antigravityEnv.includes("GEMINI_API_KEY=gemini-key"));
    assert.ok(antigravityEnv.includes("FOO=bar"));
  });

  it("lets the configuration's env block override a harness variable", () => {
    const env = buildContainerEnv({
      ...base,
      agent: "antigravity",
      harnessEnv: { GEMINI_API_KEY: "from-gemini-block" },
      configEnv: { GEMINI_API_KEY: "from-env-block" },
    });

    assert.deepEqual(env.filter((entry) => entry.startsWith("GEMINI_API_KEY=")), ["GEMINI_API_KEY=from-env-block"]);
  });

  it("reads the agent from the container label, treating unlabelled containers as claude", () => {
    assert.equal(agentFromLabels({ "crc.agent": "antigravity" }), "antigravity");
    assert.equal(agentFromLabels({ "crc.agent": "claude" }), "claude");
    assert.equal(agentFromLabels({ "crc.config-name": "default" }), "claude");
  });

  it("fails loudly on a label naming an agent it does not know", () => {
    assert.throws(() => agentFromLabels({ "crc.agent": "codex" }));
  });
});
