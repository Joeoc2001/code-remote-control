const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { startSession, startSessionWithRealTmux } = require("./helpers/session-harness.js");

const AWKWARD_PROMPT = 'Fix the "quoting" bug in $HOME; `echo hi` && rm -rf / -- now\nthen open a PR';
const WORKSPACE_CONVERSATION = { "/workspace": "c035e357-668a-4797-937a-a825c3348ad5" };
const FINISHED = { state: "finished", updatedAt: "2026-08-16T22:06:47.000Z" };

function startAntigravity(options = {}) {
  return startSession({ agent: "antigravity", ...options });
}

describe("start-agent-session.sh launching Antigravity", () => {
  test("starts a bare interactive session with permissions skipped when there is nothing to resume or replay", () => {
    const result = startAntigravity();

    assert.equal(result.error, null);
    assert.deepEqual(result.claudeArgv, ["--dangerously-skip-permissions"]);
    assert.match(result.stdout, /interactive Antigravity session/);
  });

  test("seeds a new interactive session with the initial prompt", () => {
    const result = startAntigravity({ initialPrompt: AWKWARD_PROMPT });

    assert.equal(result.error, null);
    assert.deepEqual(result.claudeArgv, ["--dangerously-skip-permissions", "--prompt-interactive", AWKWARD_PROMPT]);
  });

  test("resumes the workspace's conversation with the resume prompt instead of replaying the initial prompt", () => {
    const result = startAntigravity({ lastConversations: WORKSPACE_CONVERSATION, initialPrompt: AWKWARD_PROMPT });

    assert.equal(result.error, null);
    assert.deepEqual(result.claudeArgv.slice(0, 3), ["--dangerously-skip-permissions", "--continue", "--prompt-interactive"]);
    assert.equal(result.claudeArgv.length, 4);
    assert.match(result.claudeArgv[3], /restart/i);
    assert.equal(result.claudeArgv[3], result.claudeResumePromptEnv);
    assert.match(result.stdout, /resuming/i);
  });

  test("reopens a finished conversation without prompting the agent", () => {
    const result = startAntigravity({ lastConversations: WORKSPACE_CONVERSATION, instanceStatus: FINISHED, initialPrompt: "task" });

    assert.deepEqual(result.claudeArgv, ["--dangerously-skip-permissions", "--continue"]);
    assert.match(result.stdout, /already finished/i);
  });

  test("does not resume when the only recorded conversations belong to other workspaces", () => {
    const result = startAntigravity({
      lastConversations: { "/workspace/nested": "a", "/other/workspace": "b" },
      initialPrompt: "original task",
    });

    assert.deepEqual(result.claudeArgv, ["--dangerously-skip-permissions", "--prompt-interactive", "original task"]);
  });

  test("ignores Claude Code transcripts when deciding whether to resume", () => {
    const result = startAntigravity({ transcriptFiles: ["session.jsonl"], initialPrompt: "original task" });

    assert.deepEqual(result.claudeArgv, ["--dangerously-skip-permissions", "--prompt-interactive", "original task"]);
  });

  test("marks the instance finished once agy exits cleanly, standing in for a session-end hook", () => {
    const result = startAntigravity({ initialPrompt: "task", instanceStatus: { state: "working", updatedAt: "2026-08-16T22:06:47.000Z" } });

    assert.equal(result.error, null);
    assert.equal(result.instanceStatus.state, "finished");
  });

  test("holds the terminal open and leaves the status alone when agy fails to start", () => {
    const result = startAntigravity({
      initialPrompt: "task",
      claudeExitStatus: 7,
      instanceStatus: { state: "working", updatedAt: "2026-08-16T22:06:47.000Z" },
    });

    assert.match(result.stdout, /agy exited with status 7/);
    assert.equal(result.instanceStatus.state, "working");
  });

  test("hands a multi-line prompt to agy as a single unmangled argument under real tmux", async () => {
    const result = await startSessionWithRealTmux({ agent: "antigravity", initialPrompt: AWKWARD_PROMPT });

    assert.deepEqual(result.claudeArgv, ["--dangerously-skip-permissions", "--prompt-interactive", AWKWARD_PROMPT]);
  });
});

describe("start-agent-session.sh choosing the agent", () => {
  test("launches claude, not agy, for a claude container even when an Antigravity conversation exists", () => {
    const result = startSession({ agent: "claude", lastConversations: WORKSPACE_CONVERSATION, initialPrompt: "task" });

    assert.deepEqual(result.claudeArgv, ["task"]);
    assert.match(result.tmuxArgv[6], /^claude "\$CRC_INITIAL_PROMPT" \|\|/);
  });

  test("does not write the instance status itself for claude, whose SessionEnd hook does", () => {
    const result = startSession({ agent: "claude", initialPrompt: "task" });

    assert.equal(result.instanceStatus, null);
  });

  test("fails loudly when CRC_AGENT is not set", () => {
    const result = startSession({ agent: null });

    assert.notEqual(result.error, null);
    assert.match(String(result.error.stderr), /CRC_AGENT must name the agent harness/);
    assert.equal(result.tmuxArgv, null);
  });

  test("fails loudly for an agent it does not know", () => {
    const result = startSession({ agent: "codex" });

    assert.notEqual(result.error, null);
    assert.match(String(result.error.stderr), /unknown CRC_AGENT 'codex'/);
    assert.equal(result.tmuxArgv, null);
  });
});
