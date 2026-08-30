const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pendingBackgroundTaskIds, readPendingBackgroundTaskIds } = require("../claude/hooks/background-tasks.js");

function transcript(...entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function backgroundBashLaunch(taskId) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          tool_use_id: `toolu_${taskId}`,
          type: "tool_result",
          content: `Command running in background with ID: ${taskId}.`,
          is_error: false,
        },
      ],
    },
    toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: taskId },
  };
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
});

describe("readPendingBackgroundTaskIds", () => {
  test("reads pending tasks from a transcript file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crc-transcript-"));
    try {
      const file = path.join(dir, "session.jsonl");
      writeFileSync(file, transcript(agentLaunch("agent-a1b")));

      assert.deepEqual(readPendingBackgroundTaskIds(file), ["agent-a1b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
