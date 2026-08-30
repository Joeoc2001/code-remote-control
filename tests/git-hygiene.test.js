const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { rmSync } = require("node:fs");
const { makeRoot, makeWorkspace, runHook, writeTranscript } = require("./helpers/git-hygiene-harness.js");

function backgroundAgentLaunch(agentId) {
  return {
    type: "user",
    message: { role: "user", content: [{ tool_use_id: `toolu_${agentId}`, type: "tool_result", content: "launched" }] },
    toolUseResult: { status: "async_launched", agentId, description: "Implement the fix", prompt: "..." },
  };
}

function completionNotification(agentId) {
  return {
    type: "queue-operation",
    operation: "enqueue",
    content: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n</task-notification>`,
  };
}

describe("git-hygiene stop hook", () => {
  let root;
  let bin;

  beforeEach(() => {
    ({ root, bin } = makeRoot());
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("reports awaiting-background while a background agent is still running", () => {
    const workspace = makeWorkspace(root, { repo: "pushed" });
    const transcriptPath = writeTranscript(root, [backgroundAgentLaunch("agent-a1b")]);

    const result = runHook({
      root,
      bin,
      workspace,
      payload: { session_id: "s1", transcript_path: transcriptPath },
    });

    assert.equal(result.instanceStatus.state, "awaiting-background");
    assert.ok(result.instanceStatus.updatedAt);
    assert.equal(result.decision, null);
  });

  test("keeps reporting awaiting-background rather than nagging about an untouched dirty worktree", () => {
    const workspace = makeWorkspace(root, { repo: "pushed", dirty: true });
    const transcriptPath = writeTranscript(root, [backgroundAgentLaunch("agent-a1b")]);

    const result = runHook({
      root,
      bin,
      workspace,
      payload: { session_id: "s1", transcript_path: transcriptPath },
    });

    assert.equal(result.instanceStatus.state, "awaiting-background");
    assert.equal(result.decision, null);
  });

  test("reports finished once every background agent has notified", () => {
    const workspace = makeWorkspace(root, { repo: "pushed" });
    const transcriptPath = writeTranscript(root, [
      backgroundAgentLaunch("agent-a1b"),
      completionNotification("agent-a1b"),
    ]);

    const result = runHook({
      root,
      bin,
      workspace,
      payload: { session_id: "s1", transcript_path: transcriptPath },
    });

    assert.equal(result.instanceStatus.state, "finished");
    assert.equal(result.decision, null);
  });

  test("reports finished for a clean pushed worktree with no background work at all", () => {
    const workspace = makeWorkspace(root, { repo: "pushed" });
    const transcriptPath = writeTranscript(root, [
      { type: "user", message: { role: "user", content: "do the thing" } },
    ]);

    const result = runHook({
      root,
      bin,
      workspace,
      payload: { session_id: "s1", transcript_path: transcriptPath },
    });

    assert.equal(result.instanceStatus.state, "finished");
  });

  test("reports finished when the payload carries no transcript at all", () => {
    const workspace = makeWorkspace(root, { repo: "pushed" });

    const result = runHook({ root, bin, workspace, payload: { session_id: "s1" } });

    assert.equal(result.instanceStatus.state, "finished");
  });

  test("still blocks the stop and reports working for a dirty worktree with no background work", () => {
    const workspace = makeWorkspace(root, { repo: "pushed", dirty: true });
    const transcriptPath = writeTranscript(root, [completionNotification("agent-a1b")]);

    const result = runHook({
      root,
      bin,
      workspace,
      payload: { session_id: "s1", transcript_path: transcriptPath },
    });

    assert.equal(result.instanceStatus.state, "working");
    assert.equal(result.decision.decision, "block");
    assert.match(result.decision.reason, /uncommitted/);
  });

  test("still blocks the stop and reports working for unpushed commits with no background work", () => {
    const workspace = makeWorkspace(root, { repo: "local" });

    const result = runHook({ root, bin, workspace, payload: { session_id: "s1" } });

    assert.equal(result.instanceStatus.state, "working");
    assert.equal(result.decision.decision, "block");
    assert.match(result.decision.reason, /unpushed/);
  });

  test("reports finished outside a git worktree", () => {
    const workspace = makeWorkspace(root);

    const result = runHook({ root, bin, workspace, payload: { session_id: "s1" } });

    assert.equal(result.instanceStatus.state, "finished");
  });
});
