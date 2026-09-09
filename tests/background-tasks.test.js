const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const {
  isHeldOpenByAnyProcess,
  pendingBackgroundTasks,
  readPendingBackgroundTaskIds,
  readSessionStartedAt,
  sessionStartedAtPath,
} = require("../claude/hooks/background-tasks.js");

function transcript(...entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function pendingBackgroundTaskIds(text, options) {
  return pendingBackgroundTasks(text, options).map((task) => task.id);
}

function backgroundBashLaunch(taskId, { outputFile = null, timestamp } = {}) {
  const outputNote = outputFile
    ? ` Output is being written to: ${outputFile}. You will be notified when it completes. To check interim output, use Read on that file path.`
    : "";
  return {
    type: "user",
    ...(timestamp ? { timestamp } : {}),
    message: {
      role: "user",
      content: [
        {
          tool_use_id: `toolu_${taskId}`,
          type: "tool_result",
          content: `Command running in background with ID: ${taskId}.${outputNote}`,
          is_error: false,
        },
      ],
    },
    toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: taskId },
  };
}

function taskStop(input, timestamp) {
  return {
    type: "assistant",
    ...(timestamp ? { timestamp } : {}),
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_stop", name: "TaskStop", input }] },
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

async function waitFor(condition) {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) await delay(20);
  assert.ok(condition(), "timed out waiting for the condition");
}

function foregroundBashResult() {
  return {
    type: "user",
    message: { role: "user", content: [{ tool_use_id: "toolu_fg", type: "tool_result", content: "ok" }] },
    toolUseResult: { stdout: "ok", stderr: "", interrupted: false, isImage: false },
  };
}

function agentLaunch(agentId) {
  return {
    type: "user",
    message: { role: "user", content: [{ tool_use_id: `toolu_${agentId}`, type: "tool_result", content: "launched" }] },
    toolUseResult: {
      status: "async_launched",
      isAsync: true,
      agentId,
      description: "Investigate auth bug",
      prompt: "Investigate the auth module",
      outputFile: `/tmp/agents/${agentId}.output`,
    },
  };
}

function remoteAgentLaunch(taskId) {
  return {
    type: "user",
    message: { role: "user", content: [{ tool_use_id: `toolu_${taskId}`, type: "tool_result", content: "launched" }] },
    toolUseResult: {
      status: "remote_launched",
      taskId,
      sessionUrl: "https://claude.ai/code/session",
      description: "Remote work",
    },
  };
}

function notificationText(taskId, status = "completed") {
  return [
    "<task-notification>",
    `<task-id>${taskId}</task-id>`,
    `<status>${status}</status>`,
    `<summary>Background command completed</summary>`,
    "</task-notification>",
  ].join("\n");
}

function queuedNotification(taskId, status = "completed") {
  return {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-08-30T04:51:51.359Z",
    content: notificationText(taskId, status),
  };
}

function deliveredNotification(taskId, status = "completed") {
  return {
    type: "attachment",
    attachment: {
      type: "queued_command",
      prompt: notificationText(taskId, status),
      commandMode: "task-notification",
      timestamp: "2026-08-30T04:51:51.359Z",
    },
  };
}

function notificationAsUserText(taskId, status = "completed") {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: `<system-reminder>\n${notificationText(taskId, status)}\n</system-reminder>` }],
    },
  };
}

function toolResultQuoting(text) {
  return {
    type: "user",
    message: { role: "user", content: [{ tool_use_id: "toolu_read", type: "tool_result", content: text }] },
    toolUseResult: { stdout: text, stderr: "", interrupted: false, isImage: false },
  };
}

describe("pendingBackgroundTaskIds", () => {
  test("reports nothing for a transcript without background work", () => {
    assert.deepEqual(pendingBackgroundTaskIds(transcript(foregroundBashResult())), []);
  });

  test("reports a background bash command that has not notified yet", () => {
    assert.deepEqual(pendingBackgroundTaskIds(transcript(backgroundBashLaunch("bq17zaptz"))), ["bq17zaptz"]);
  });

  test("clears a background bash command once its queued notification lands", () => {
    const text = transcript(backgroundBashLaunch("bq17zaptz"), queuedNotification("bq17zaptz"));

    assert.deepEqual(pendingBackgroundTaskIds(text), []);
  });

  test("clears a background task from the notification delivered to the agent", () => {
    const text = transcript(backgroundBashLaunch("bq17zaptz"), deliveredNotification("bq17zaptz"));

    assert.deepEqual(pendingBackgroundTaskIds(text), []);
  });

  test("clears a background task from a notification delivered as user message text", () => {
    const text = transcript(backgroundBashLaunch("bq17zaptz"), notificationAsUserText("bq17zaptz"));

    assert.deepEqual(pendingBackgroundTaskIds(text), []);
  });

  test("reports a background subagent that has not notified yet", () => {
    assert.deepEqual(pendingBackgroundTaskIds(transcript(agentLaunch("agent-a1b"))), ["agent-a1b"]);
  });

  test("clears a background subagent on any terminal notification status", () => {
    for (const status of ["completed", "failed", "killed", "blocked"]) {
      const text = transcript(agentLaunch("agent-a1b"), queuedNotification("agent-a1b", status));

      assert.deepEqual(pendingBackgroundTaskIds(text), [], `status ${status} should clear the task`);
    }
  });

  test("reports a remotely launched agent that has not notified yet", () => {
    assert.deepEqual(pendingBackgroundTaskIds(transcript(remoteAgentLaunch("remote-7"))), ["remote-7"]);
  });

  test("tracks several background tasks independently", () => {
    const text = transcript(
      backgroundBashLaunch("bq17zaptz"),
      agentLaunch("agent-a1b"),
      agentLaunch("agent-c3d"),
      queuedNotification("agent-a1b"),
    );

    assert.deepEqual(pendingBackgroundTaskIds(text).sort(), ["agent-c3d", "bq17zaptz"]);
  });

  test("reports a task relaunched under the same id after its earlier notification", () => {
    const text = transcript(
      agentLaunch("agent-a1b"),
      queuedNotification("agent-a1b"),
      agentLaunch("agent-a1b"),
    );

    assert.deepEqual(pendingBackgroundTaskIds(text), ["agent-a1b"]);
  });

  test("ignores a notification for a task that was never launched", () => {
    assert.deepEqual(pendingBackgroundTaskIds(transcript(queuedNotification("agent-zzz"))), []);
  });

  test("skips blank and half-written lines instead of failing", () => {
    const text = `${JSON.stringify(backgroundBashLaunch("bq17zaptz"))}\n\n{"type":"user","message":{"rol`;

    assert.deepEqual(pendingBackgroundTaskIds(text), ["bq17zaptz"]);
  });

  test("is not fooled by a tool result quoting notification XML for a pending task", () => {
    const text = transcript(agentLaunch("agent-a1b"), toolResultQuoting(notificationText("agent-a1b")));

    assert.deepEqual(pendingBackgroundTaskIds(text), ["agent-a1b"]);
  });

  test("is not fooled by the agent writing notification XML into a file", () => {
    const write = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_write",
            name: "Write",
            input: { file_path: "/workspace/fixture.md", content: notificationText("agent-a1b") },
          },
        ],
      },
    };
    const text = transcript(agentLaunch("agent-a1b"), write);

    assert.deepEqual(pendingBackgroundTaskIds(text), ["agent-a1b"]);
  });

  test("is not fooled by transcript prose that merely mentions a task id", () => {
    const prose = {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Task bq17zaptz completed, I think." }] },
    };

    assert.deepEqual(pendingBackgroundTaskIds(transcript(backgroundBashLaunch("bq17zaptz"), prose)), ["bq17zaptz"]);
  });

  test("records the output file named in a background bash launch", () => {
    const text = transcript(backgroundBashLaunch("bq17zaptz", { outputFile: "/tmp/claude-0/-workspace/s1/tasks/bq17zaptz.output" }));

    assert.deepEqual(pendingBackgroundTasks(text), [
      { id: "bq17zaptz", outputFile: "/tmp/claude-0/-workspace/s1/tasks/bq17zaptz.output" },
    ]);
  });

  test("records no output file for launches that do not name one", () => {
    const text = transcript(backgroundBashLaunch("bq17zaptz"), agentLaunch("agent-a1b"), remoteAgentLaunch("remote-7"));

    assert.deepEqual(pendingBackgroundTasks(text).map((task) => task.outputFile), [null, null, null]);
  });

  test("treats a TaskStop call as terminal for a bash task that never notifies", () => {
    const text = transcript(backgroundBashLaunch("bq17zaptz"), taskStop({ task_id: "bq17zaptz" }));

    assert.deepEqual(pendingBackgroundTaskIds(text), []);
  });

  test("accepts the deprecated shell_id spelling of a TaskStop call", () => {
    const text = transcript(backgroundBashLaunch("bq17zaptz"), taskStop({ shell_id: "bq17zaptz" }));

    assert.deepEqual(pendingBackgroundTaskIds(text), []);
  });

  test("only clears the task the TaskStop call names", () => {
    const text = transcript(backgroundBashLaunch("bq17zaptz"), agentLaunch("agent-a1b"), taskStop({ task_id: "agent-a1b" }));

    assert.deepEqual(pendingBackgroundTaskIds(text), ["bq17zaptz"]);
  });

  test("reports a task relaunched under the same id after it was stopped", () => {
    const text = transcript(
      backgroundBashLaunch("bq17zaptz"),
      taskStop({ task_id: "bq17zaptz" }),
      backgroundBashLaunch("bq17zaptz"),
    );

    assert.deepEqual(pendingBackgroundTaskIds(text), ["bq17zaptz"]);
  });

  test("ignores a TaskStop that appears in a tool result rather than a tool call", () => {
    const quoted = toolResultQuoting(JSON.stringify({ name: "TaskStop", input: { task_id: "bq17zaptz" } }));

    assert.deepEqual(pendingBackgroundTaskIds(transcript(backgroundBashLaunch("bq17zaptz"), quoted)), ["bq17zaptz"]);
  });

  test("drops launches that predate the current session", () => {
    const text = transcript(
      backgroundBashLaunch("old-bash", { timestamp: "2026-09-07T10:00:00.000Z" }),
      { ...agentLaunch("old-agent"), timestamp: "2026-09-07T10:00:01.000Z" },
      backgroundBashLaunch("new-bash", { timestamp: "2026-09-07T10:05:00.500Z" }),
    );

    assert.deepEqual(pendingBackgroundTaskIds(text, { since: "2026-09-07T10:05:00Z" }), ["new-bash"]);
  });

  test("keeps every launch when no session start is known", () => {
    const text = transcript(backgroundBashLaunch("old-bash", { timestamp: "2026-09-07T10:00:00.000Z" }));

    assert.deepEqual(pendingBackgroundTaskIds(text), ["old-bash"]);
    assert.deepEqual(pendingBackgroundTaskIds(text, { since: null }), ["old-bash"]);
  });

  test("keeps launches whose entries carry no timestamp", () => {
    const text = transcript(backgroundBashLaunch("bq17zaptz"));

    assert.deepEqual(pendingBackgroundTaskIds(text, { since: "2026-09-07T10:05:00Z" }), ["bq17zaptz"]);
  });

  test("fails loudly on a session start that is not a timestamp", () => {
    assert.throws(() => pendingBackgroundTasks(transcript(), { since: "yesterday" }), /invalid session start 'yesterday'/);
  });
});

describe("isHeldOpenByAnyProcess", () => {
  let dir;
  let child = null;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "crc-task-output-"));
  });

  afterEach(async () => {
    if (child) await release(child);
    child = null;
    rmSync(dir, { recursive: true, force: true });
  });

  test("sees a file that a running process writes its output to", async () => {
    const file = path.join(dir, "task.output");
    child = holdOpen(file);

    await waitFor(() => isHeldOpenByAnyProcess(file));
  });

  test("stops seeing the file once that process is gone", async () => {
    const file = path.join(dir, "task.output");
    child = holdOpen(file);
    await waitFor(() => isHeldOpenByAnyProcess(file));

    await release(child);

    assert.equal(isHeldOpenByAnyProcess(file), false);
  });

  test("does not see a file nobody holds open, whether or not it exists", () => {
    const file = path.join(dir, "task.output");
    assert.equal(isHeldOpenByAnyProcess(file), false);

    writeFileSync(file, "done\n");
    assert.equal(isHeldOpenByAnyProcess(file), false);
  });
});

describe("readSessionStartedAt", () => {
  let dir;
  let originalRunDir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "crc-session-start-"));
    originalRunDir = process.env.CRC_RUN_DIR;
    process.env.CRC_RUN_DIR = dir;
  });

  afterEach(() => {
    if (originalRunDir === undefined) delete process.env.CRC_RUN_DIR;
    else process.env.CRC_RUN_DIR = originalRunDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads the marker the session script writes under the run directory", () => {
    assert.equal(sessionStartedAtPath(), path.join(dir, "crc-session-started-at"));
    writeFileSync(sessionStartedAtPath(), "2026-09-07T10:05:00Z\n");

    assert.equal(readSessionStartedAt(), "2026-09-07T10:05:00Z");
  });

  test("defaults to /run when no run directory is configured", () => {
    delete process.env.CRC_RUN_DIR;

    assert.equal(sessionStartedAtPath(), "/run/crc-session-started-at");
  });

  test("reports no session start when the marker is missing", () => {
    assert.equal(readSessionStartedAt(), null);
  });

  test("fails loudly when the marker is not a timestamp", () => {
    writeFileSync(sessionStartedAtPath(), "garbage");

    assert.throws(readSessionStartedAt, /does not hold a timestamp: 'garbage'/);
  });
});

describe("readPendingBackgroundTaskIds", () => {
  let dir;
  let child = null;
  let originalRunDir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "crc-transcript-"));
    originalRunDir = process.env.CRC_RUN_DIR;
    process.env.CRC_RUN_DIR = dir;
  });

  afterEach(async () => {
    if (originalRunDir === undefined) delete process.env.CRC_RUN_DIR;
    else process.env.CRC_RUN_DIR = originalRunDir;
    if (child) await release(child);
    child = null;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTranscript(...entries) {
    const file = path.join(dir, "session.jsonl");
    writeFileSync(file, transcript(...entries));
    return file;
  }

  test("reads pending tasks from a transcript file", () => {
    const file = writeTranscript(agentLaunch("agent-a1b"));

    assert.deepEqual(readPendingBackgroundTaskIds(file), ["agent-a1b"]);
  });

  test("reports a background bash command while its process still writes to the output file", async () => {
    const outputFile = path.join(dir, "bq17zaptz.output");
    child = holdOpen(outputFile);
    await waitFor(() => isHeldOpenByAnyProcess(outputFile));
    const file = writeTranscript(backgroundBashLaunch("bq17zaptz", { outputFile }));

    assert.deepEqual(readPendingBackgroundTaskIds(file), ["bq17zaptz"]);
  });

  test("drops a background bash command whose process is gone even though it never notified", async () => {
    const outputFile = path.join(dir, "bq17zaptz.output");
    child = holdOpen(outputFile);
    await waitFor(() => isHeldOpenByAnyProcess(outputFile));
    const file = writeTranscript(backgroundBashLaunch("bq17zaptz", { outputFile }), agentLaunch("agent-a1b"));

    await release(child);

    assert.deepEqual(readPendingBackgroundTaskIds(file), ["agent-a1b"]);
  });

  test("keeps trusting the transcript for a bash launch that names no output file", () => {
    const file = writeTranscript(backgroundBashLaunch("bq17zaptz"));

    assert.deepEqual(readPendingBackgroundTaskIds(file), ["bq17zaptz"]);
  });

  test("drops launches from before the session start marker", () => {
    writeFileSync(sessionStartedAtPath(), "2026-09-07T10:05:00Z\n");
    const file = writeTranscript(
      { ...agentLaunch("old-agent"), timestamp: "2026-09-07T10:00:01.000Z" },
      { ...agentLaunch("new-agent"), timestamp: "2026-09-07T10:05:01.000Z" },
    );

    assert.deepEqual(readPendingBackgroundTaskIds(file), ["new-agent"]);
  });

  test("reports nothing when the hook payload carries no transcript path", () => {
    assert.deepEqual(readPendingBackgroundTaskIds(undefined), []);
    assert.deepEqual(readPendingBackgroundTaskIds(""), []);
  });

  test("reports nothing when the transcript file does not exist", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crc-transcript-"));
    try {
      assert.deepEqual(readPendingBackgroundTaskIds(path.join(dir, "missing.jsonl")), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails loudly when the transcript path cannot be read", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crc-transcript-"));
    try {
      assert.throws(() => readPendingBackgroundTaskIds(dir), /EISDIR/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
