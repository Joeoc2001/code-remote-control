const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { closeSync, openSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { git, makeRoot, makeWorkspace, runHook, statusPathFor, writeStub, writeTranscript } = require("./helpers/git-hygiene-harness.js");
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

function bashToolUse(taskId, command, description) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${taskId}`, name: "Bash", input: { command, description, run_in_background: true } }],
    },
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

  test("reports a dirty worktree while a background agent is still running, then waits on the agent", () => {
    const workspace = makeWorkspace(root, { repo: "pushed", dirty: true });
    const transcriptPath = writeTranscript(root, [backgroundAgentLaunch("agent-a1b")]);

    const first = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });

    assert.equal(first.instanceStatus.state, "working");
    assert.equal(first.decision.decision, "block");
    assert.match(first.decision.reason, /uncommitted/);
    assert.match(first.decision.reason, /end your turn again to wait for them/);

    const repeat = runHook({
      root,
      bin,
      workspace,
      payload: { session_id: "s1", transcript_path: transcriptPath, stop_hook_active: true },
    });

    assert.equal(repeat.decision, null);
    assert.equal(repeat.instanceStatus.state, "awaiting-background");
    assert.deepEqual(repeat.instanceStatus.pendingTasks, [{ id: "agent-a1b", kind: "agent", label: "Implement the fix" }]);
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
    assert.equal(result.decision, null);
    assert.deepEqual(result.instanceStatus.pendingTasks, [
      { id: "agent-a1b", kind: "agent", label: "Implement the fix" },
      { id: "agent-c3d", kind: "agent", label: "Implement the fix" },
    ]);
  });

  describe("background bash commands", () => {
    let child = null;

    afterEach(async () => {
      if (child) await release(child);
      child = null;
    });

    async function liveShell(taskId, command, description) {
      const outputFile = path.join(root, `${taskId}.output`);
      const running = holdOpen(outputFile);
      await waitUntilHeld(outputFile);
      return { process: running, entries: [bashToolUse(taskId, command, description), backgroundBashLaunch(taskId, outputFile)] };
    }

    test("blocks the first stop while a background shell is still running and names it", async () => {
      const workspace = makeWorkspace(root, { repo: "pushed" });
      const shell = await liveShell("bq17zaptz", "until test -f /tmp/done; do sleep 5; done", "Wait for the CI run");
      child = shell.process;
      const transcriptPath = writeTranscript(root, shell.entries);

      const result = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });

      assert.equal(result.instanceStatus.state, "working");
      assert.equal(result.decision.decision, "block");
      assert.match(result.decision.reason, /background shells are still running/);
      assert.ok(result.decision.reason.includes("- bq17zaptz: until test -f /tmp/done; do sleep 5; done (Wait for the CI run)"));
      assert.match(result.decision.reason, /TaskStop/);
      assert.match(result.decision.reason, /end your turn again/);
    });

    test("accepts a repeated stop with the same shells and reports awaiting-background on them", async () => {
      const workspace = makeWorkspace(root, { repo: "pushed" });
      const shell = await liveShell("bq17zaptz", "npm run dev", "Serve the app");
      child = shell.process;
      const transcriptPath = writeTranscript(root, shell.entries);

      runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });
      const repeat = runHook({
        root,
        bin,
        workspace,
        payload: { session_id: "s1", transcript_path: transcriptPath, stop_hook_active: true },
      });

      assert.equal(repeat.decision, null);
      assert.equal(repeat.instanceStatus.state, "awaiting-background");
      assert.deepEqual(repeat.instanceStatus.pendingTasks, [{ id: "bq17zaptz", kind: "shell", label: "Serve the app" }]);
    });

    test("challenges again when another shell is left running after the first challenge", async () => {
      const workspace = makeWorkspace(root, { repo: "pushed" });
      const first = await liveShell("bq17zaptz", "npm run dev", "Serve the app");
      child = first.process;
      const outputFile = path.join(root, "bnew0000.output");
      const second = holdOpen(outputFile);
      try {
        await waitUntilHeld(outputFile);
        runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: writeTranscript(root, first.entries) } });

        const transcriptPath = writeTranscript(root, [
          ...first.entries,
          bashToolUse("bnew0000", "sleep infinity", "Wait forever"),
          backgroundBashLaunch("bnew0000", outputFile),
        ]);
        const repeat = runHook({
          root,
          bin,
          workspace,
          payload: { session_id: "s1", transcript_path: transcriptPath, stop_hook_active: true },
        });

        assert.equal(repeat.decision.decision, "block");
        assert.ok(repeat.decision.reason.includes("- bq17zaptz: npm run dev (Serve the app)"));
        assert.ok(repeat.decision.reason.includes("- bnew0000: sleep infinity (Wait forever)"));
      } finally {
        await release(second);
      }
    });

    test("challenges the same shells again at the end of a later turn", async () => {
      const workspace = makeWorkspace(root, { repo: "pushed" });
      const shell = await liveShell("bq17zaptz", "npm run dev", "Serve the app");
      child = shell.process;
      const transcriptPath = writeTranscript(root, shell.entries);
      runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });
      runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath, stop_hook_active: true } });

      const nextTurn = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });

      assert.equal(nextTurn.decision.decision, "block");
      assert.equal(nextTurn.instanceStatus.state, "working");
    });

    test("names a shell by its command alone when it was launched without a description", async () => {
      const workspace = makeWorkspace(root, { repo: "pushed" });
      const outputFile = path.join(root, "bq17zaptz.output");
      child = holdOpen(outputFile);
      await waitUntilHeld(outputFile);
      const transcriptPath = writeTranscript(root, [
        { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bq17zaptz", name: "Bash", input: { command: "npm run dev", run_in_background: true } }] } },
        backgroundBashLaunch("bq17zaptz", outputFile),
      ]);

      const result = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });

      assert.ok(result.decision.reason.includes("- bq17zaptz: npm run dev\n"));
    });

    test("does not challenge background agents that run alongside no shells", () => {
      const workspace = makeWorkspace(root, { repo: "pushed" });
      const transcriptPath = writeTranscript(root, [backgroundAgentLaunch("agent-a1b")]);

      const result = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });

      assert.equal(result.decision, null);
      assert.equal(result.instanceStatus.state, "awaiting-background");
    });

    test("challenges only the shells when shells and agents are both pending, then waits on both", async () => {
      const workspace = makeWorkspace(root, { repo: "pushed" });
      const shell = await liveShell("bq17zaptz", "npm run dev", "Serve the app");
      child = shell.process;
      const transcriptPath = writeTranscript(root, [...shell.entries, backgroundAgentLaunch("agent-a1b")]);

      const first = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });
      assert.equal(first.decision.decision, "block");
      assert.ok(first.decision.reason.includes("bq17zaptz"));
      assert.ok(!first.decision.reason.includes("agent-a1b"));

      const repeat = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath, stop_hook_active: true } });
      assert.equal(repeat.decision, null);
      assert.deepEqual(repeat.instanceStatus.pendingTasks, [
        { id: "bq17zaptz", kind: "shell", label: "Serve the app" },
        { id: "agent-a1b", kind: "agent", label: "Implement the fix" },
      ]);
    });

    test("reports a dirty worktree first, then challenges the shells, then waits on them", async () => {
      const workspace = makeWorkspace(root, { repo: "pushed", dirty: true });
      const shell = await liveShell("bq17zaptz", "npm run dev", "Serve the app");
      child = shell.process;
      const transcriptPath = writeTranscript(root, shell.entries);

      const first = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });
      assert.equal(first.decision.decision, "block");
      assert.match(first.decision.reason, /uncommitted/);

      const second = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath, stop_hook_active: true } });
      assert.equal(second.decision.decision, "block");
      assert.match(second.decision.reason, /background shells are still running/);

      const third = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath, stop_hook_active: true } });
      assert.equal(third.decision, null);
      assert.equal(third.instanceStatus.state, "awaiting-background");
    });

    test("remembers the CI-watched commit across a shell challenge", async () => {
      const workspace = makeWorkspace(root, { repo: "pushed" });
      const headSha = git(workspace, "rev-parse", "HEAD");
      const fingerprintFile = path.join(root, "crc-git-hygiene-s1.json");
      writeFileSync(fingerprintFile, JSON.stringify({ watchedHead: headSha }));
      const shell = await liveShell("bq17zaptz", "npm run dev", "Serve the app");
      child = shell.process;
      const transcriptPath = writeTranscript(root, shell.entries);

      runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });

      assert.equal(JSON.parse(readFileSync(fingerprintFile, "utf-8")).watchedHead, headSha);
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
      writeFileSync(statusPathFor(root), JSON.stringify({ state: "awaiting-background", pendingTasks: [{ id: "bq17zaptz", kind: "shell", label: "Wait" }], updatedAt: "2026-09-07T10:00:00.000Z" }));

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
