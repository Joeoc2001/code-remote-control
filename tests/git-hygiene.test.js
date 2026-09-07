const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { closeSync, openSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { makeRoot, makeWorkspace, runHook, statusPathFor, writeStub, writeTranscript } = require("./helpers/git-hygiene-harness.js");
const { isHeldOpenByAnyProcess } = require("../claude/hooks/background-tasks.js");

function backgroundBashLaunch(taskId, outputFile) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          tool_use_id: `toolu_${taskId}`,
          type: "tool_result",
          content: `Command running in background with ID: ${taskId}. Output is being written to: ${outputFile}. You will be notified when it completes.`,
        },
      ],
    },
    toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: taskId },
  };
}

function taskStop(taskId) {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_stop", name: "TaskStop", input: { task_id: taskId } }] },
  };
}

function holdOpen(file) {
  const fd = openSync(file, "a");
  const child = spawn("sleep", ["60"], { stdio: ["ignore", fd, fd] });
  closeSync(fd);
  return child;
}

async function release(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

async function waitUntilHeld(file) {
  const deadline = Date.now() + 5_000;
  while (!isHeldOpenByAnyProcess(file) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(isHeldOpenByAnyProcess(file), "the background process never opened its output file");
}

const OPEN_PR = JSON.stringify({ number: 7, url: "https://github.com/example/repo/pull/7", title: "Fix", state: "OPEN" });

function githubStub({ checks, snapshotTo }) {
  return `#!/bin/bash
if [ "$1 $2" = "pr view" ]; then echo '${OPEN_PR}'; exit 0; fi
if [ "$1 $2" = "pr checks" ]; then
  ${snapshotTo ? `cat "$CRC_INSTANCE_STATUS_PATH" > "${snapshotTo}"` : ":"}
  echo '${JSON.stringify(checks)}'
  exit 0
fi
exit 0
`;
}

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

  test("names the tasks it is waiting on in the status file", () => {
    const workspace = makeWorkspace(root, { repo: "pushed" });
    const transcriptPath = writeTranscript(root, [backgroundAgentLaunch("agent-a1b"), backgroundAgentLaunch("agent-c3d")]);

    const result = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });

    assert.equal(result.instanceStatus.state, "awaiting-background");
    assert.deepEqual(result.instanceStatus.pendingTaskIds, ["agent-a1b", "agent-c3d"]);
  });

  describe("background bash commands", () => {
    let child = null;

    afterEach(async () => {
      if (child) await release(child);
      child = null;
    });

    test("reports awaiting-background while the command's process is still running", async () => {
      const workspace = makeWorkspace(root, { repo: "pushed" });
      const outputFile = path.join(root, "bq17zaptz.output");
      child = holdOpen(outputFile);
      await waitUntilHeld(outputFile);
      const transcriptPath = writeTranscript(root, [backgroundBashLaunch("bq17zaptz", outputFile)]);

      const result = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });

      assert.equal(result.instanceStatus.state, "awaiting-background");
      assert.deepEqual(result.instanceStatus.pendingTaskIds, ["bq17zaptz"]);
    });

    test("reports finished once the command's process is gone, even without a notification", async () => {
      const workspace = makeWorkspace(root, { repo: "pushed" });
      const outputFile = path.join(root, "bq17zaptz.output");
      child = holdOpen(outputFile);
      await waitUntilHeld(outputFile);
      const transcriptPath = writeTranscript(root, [backgroundBashLaunch("bq17zaptz", outputFile)]);
      await release(child);

      const result = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });

      assert.equal(result.instanceStatus.state, "finished");
    });

    test("reports finished after the agent stopped the command with TaskStop", async () => {
      const workspace = makeWorkspace(root, { repo: "pushed" });
      const outputFile = path.join(root, "bq17zaptz.output");
      child = holdOpen(outputFile);
      await waitUntilHeld(outputFile);
      const transcriptPath = writeTranscript(root, [backgroundBashLaunch("bq17zaptz", outputFile), taskStop("bq17zaptz")]);

      const result = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });

      assert.equal(result.instanceStatus.state, "finished");
    });

    test("still nags about a dirty worktree once the stuck command no longer counts", async () => {
      const workspace = makeWorkspace(root, { repo: "pushed", dirty: true });
      const outputFile = path.join(root, "bq17zaptz.output");
      const transcriptPath = writeTranscript(root, [backgroundBashLaunch("bq17zaptz", outputFile)]);

      const result = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });

      assert.equal(result.instanceStatus.state, "working");
      assert.equal(result.decision.decision, "block");
      assert.match(result.decision.reason, /uncommitted/);
    });
  });

  test("ignores background work launched by a claude process that predates this session", () => {
    const workspace = makeWorkspace(root, { repo: "pushed" });
    writeFileSync(path.join(root, "crc-session-started-at"), "2026-09-07T10:05:00Z\n");
    const transcriptPath = writeTranscript(root, [
      { ...backgroundAgentLaunch("agent-a1b"), timestamp: "2026-09-07T10:00:00.000Z" },
    ]);

    const result = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });

    assert.equal(result.instanceStatus.state, "finished");
  });

  test("keeps waiting on background work launched after this session started", () => {
    const workspace = makeWorkspace(root, { repo: "pushed" });
    writeFileSync(path.join(root, "crc-session-started-at"), "2026-09-07T10:05:00Z\n");
    const transcriptPath = writeTranscript(root, [
      { ...backgroundAgentLaunch("agent-a1b"), timestamp: "2026-09-07T10:05:02.000Z" },
    ]);

    const result = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });

    assert.equal(result.instanceStatus.state, "awaiting-background");
  });

  describe("CI watch", () => {
    test("reports working before it starts polling, replacing a stale awaiting-background", () => {
      const workspace = makeWorkspace(root, { repo: "pushed" });
      const snapshot = path.join(root, "status-during-checks.json");
      writeStub(bin, "gh", githubStub({ checks: [{ bucket: "pass", name: "ci", state: "SUCCESS" }], snapshotTo: snapshot }));
      writeFileSync(statusPathFor(root), JSON.stringify({ state: "awaiting-background", pendingTaskIds: ["bq17zaptz"], updatedAt: "2026-09-07T10:00:00.000Z" }));

      const result = runHook({ root, bin, workspace, payload: { session_id: "s1" }, env: { CRC_CI_WATCH_TIMEOUT_MS: "5000" } });

      assert.equal(JSON.parse(readFileSync(snapshot, "utf-8")).state, "working");
      assert.equal(result.instanceStatus.state, "finished");
      assert.equal(result.decision, null);
    });

    test("gives up at the watch deadline rather than sleeping a whole poll interval past it", () => {
      const workspace = makeWorkspace(root, { repo: "pushed" });
      writeStub(bin, "gh", githubStub({ checks: [{ bucket: "pending", name: "ci", state: "IN_PROGRESS" }] }));

      const startedAt = Date.now();
      const result = runHook({ root, bin, workspace, payload: { session_id: "s1" }, env: { CRC_CI_WATCH_TIMEOUT_MS: "1500" } });

      assert.ok(Date.now() - startedAt < 15_000, "the hook overran its watch deadline");
      assert.equal(result.instanceStatus.state, "finished");
    });

    test("blocks the stop and reports working when the checks fail", () => {
      const workspace = makeWorkspace(root, { repo: "pushed" });
      writeStub(bin, "gh", githubStub({ checks: [{ bucket: "fail", name: "ci", state: "FAILURE" }] }));

      const result = runHook({ root, bin, workspace, payload: { session_id: "s1" }, env: { CRC_CI_WATCH_TIMEOUT_MS: "5000" } });

      assert.equal(result.instanceStatus.state, "working");
      assert.equal(result.decision.decision, "block");
      assert.match(result.decision.reason, /PR checks finished with failures/);
    });
  });
});
