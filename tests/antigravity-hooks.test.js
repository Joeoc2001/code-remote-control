const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { git, makeRoot, makeWorkspace, runHook, writeStub, writeTranscript } = require("./helpers/git-hygiene-harness.js");
const { harnessFromArgv, readPayload, reply } = require("../agent-hooks/hooks/harness.js");

const HOOKS_DIR = path.join(__dirname, "..", "agent-hooks", "hooks");
const ANTIGRAVITY = ["--harness", "antigravity"];
const CONVERSATION_ID = "79ae2b51-61f8-4f51-b847-989d572b72b5";

function stopPayload(overrides = {}) {
  return {
    artifactDirectoryPath: `/root/.gemini/antigravity-cli/brain/${CONVERSATION_ID}`,
    continuationActive: false,
    conversationId: CONVERSATION_ID,
    cwd: "/workspace",
    executionNum: 0,
    fullyIdle: true,
    hookEventName: "Stop",
    lastUserInput: "do the thing",
    modelName: "gemini-3.1-pro-low",
    terminationReason: "NO_TOOL_CALL",
    transcriptPath: `/root/.gemini/antigravity-cli/brain/${CONVERSATION_ID}/.system_generated/logs/transcript_full.jsonl`,
    workspacePaths: ["/workspace"],
    ...overrides,
  };
}

function claudeBackgroundAgentLaunch(agentId) {
  return {
    type: "user",
    message: { role: "user", content: [{ tool_use_id: `toolu_${agentId}`, type: "tool_result", content: "launched" }] },
    toolUseResult: { isAsync: true, status: "async_launched", agentId, description: "Review the diff" },
  };
}

describe("harness adapter", () => {
  test("defaults to claude so the Claude Code hook commands need no flag", () => {
    assert.equal(harnessFromArgv(["node", "git-hygiene.js"]), "claude");
    assert.equal(harnessFromArgv(["node", "instance-status.js", "working"]), "claude");
  });

  test("reads the harness from the flag wherever it appears", () => {
    assert.equal(harnessFromArgv(["node", "instance-status.js", "working", "--harness", "antigravity", "--event", "PostToolUse"]), "antigravity");
  });

  test("fails loudly on a harness it does not know", () => {
    assert.throws(() => harnessFromArgv(["node", "x.js", "--harness", "codex"]), /--harness expects one of claude, antigravity, got 'codex'/);
    assert.throws(() => harnessFromArgv(["node", "x.js", "--harness"]), /--harness expects one of/);
  });

  test("normalises a Claude Code payload", () => {
    assert.deepEqual(
      readPayload("claude", { session_id: "s1", transcript_path: "/t.jsonl", prompt: "hi", stop_hook_active: true }),
      { sessionId: "s1", transcriptPath: "/t.jsonl", prompt: "hi", continuedByStopHook: true, backgroundBusy: false, cancelledByUser: false },
    );
    assert.equal(readPayload("claude", { session_id: "s1" }).continuedByStopHook, false);
  });

  test("normalises an Antigravity payload", () => {
    const payload = stopPayload();
    assert.deepEqual(readPayload("antigravity", payload), {
      sessionId: CONVERSATION_ID,
      transcriptPath: payload.transcriptPath,
      prompt: "do the thing",
      continuedByStopHook: false,
      backgroundBusy: false,
      cancelledByUser: false,
    });
  });

  test("treats a stop that follows a forced continue as continued, as Antigravity counts executions per turn", () => {
    assert.equal(readPayload("antigravity", stopPayload({ executionNum: 1 })).continuedByStopHook, true);
    assert.equal(readPayload("antigravity", stopPayload({ executionNum: 10 })).continuedByStopHook, true);
    assert.equal(readPayload("antigravity", stopPayload({ continuationActive: true })).continuedByStopHook, true);
  });

  test("reads background work and user cancellation from an Antigravity stop", () => {
    assert.equal(readPayload("antigravity", stopPayload({ fullyIdle: false })).backgroundBusy, true);
    assert.equal(readPayload("antigravity", stopPayload({ terminationReason: "USER_CANCELED" })).cancelledByUser, true);
    assert.equal(readPayload("antigravity", stopPayload({ terminationReason: "ERROR" })).cancelledByUser, false);
  });

  test("an Antigravity pre-invocation payload without stop fields is neither continued nor busy", () => {
    const normalised = readPayload("antigravity", { conversationId: CONVERSATION_ID, lastUserInput: "hi", invocationNum: 3 });
    assert.equal(normalised.continuedByStopHook, false);
    assert.equal(normalised.backgroundBusy, false);
    assert.equal(normalised.prompt, "hi");
  });

  test("Claude Code hooks stay silent except to block a stop", () => {
    assert.equal(reply("claude").event("PreToolUse"), "");
    assert.equal(reply("claude").event(null), "");
    assert.equal(reply("claude").stopAllowed(), "");
    assert.deepEqual(JSON.parse(reply("claude").stopBlocked("why")), { decision: "block", reason: "why" });
  });

  test("Antigravity hooks always answer in JSON, allowing tools and continuing instead of blocking", () => {
    assert.deepEqual(JSON.parse(reply("antigravity").event("PreToolUse")), { decision: "allow" });
    assert.deepEqual(JSON.parse(reply("antigravity").event("PostToolUse")), {});
    assert.deepEqual(JSON.parse(reply("antigravity").event("PreInvocation")), {});
    assert.deepEqual(JSON.parse(reply("antigravity").stopAllowed()), {});
    assert.deepEqual(JSON.parse(reply("antigravity").stopBlocked("why")), { decision: "continue", reason: "why" });
  });
});

describe("git-hygiene stop hook under Antigravity", () => {
  let root;
  let bin;

  beforeEach(() => {
    ({ root, bin } = makeRoot());
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function stop(workspace, overrides = {}, env = {}) {
    return runHook({ root, bin, workspace, payload: stopPayload(overrides), args: ANTIGRAVITY, env });
  }

  test("lets the turn end with an empty JSON reply and reports finished for a clean pushed worktree", () => {
    const result = stop(makeWorkspace(root, { repo: "pushed" }));

    assert.equal(result.stdout, "{}");
    assert.equal(result.instanceStatus.state, "finished");
  });

  test("continues the turn instead of blocking it when the worktree is dirty", () => {
    const result = stop(makeWorkspace(root, { repo: "pushed", dirty: true }));

    assert.deepEqual(Object.keys(result.decision).sort(), ["decision", "reason"]);
    assert.equal(result.decision.decision, "continue");
    assert.match(result.decision.reason, /uncommitted local changes/);
    assert.equal(result.instanceStatus.state, "working");
  });

  test("continues the turn for unpushed commits", () => {
    const workspace = makeWorkspace(root, { repo: "pushed" });
    git(workspace, "commit", "--allow-empty", "-m", "local only");

    const result = stop(workspace);

    assert.equal(result.decision.decision, "continue");
    assert.match(result.decision.reason, /unpushed local commits/);
  });

  test("nags about the same dirty worktree only once per turn, then lets the agent stop", () => {
    const workspace = makeWorkspace(root, { repo: "pushed", dirty: true });

    const first = stop(workspace, { executionNum: 0 });
    const second = stop(workspace, { executionNum: 1 });

    assert.equal(first.decision.decision, "continue");
    assert.equal(second.stdout, "{}");
    assert.equal(second.instanceStatus.state, "finished");
  });

  test("nags again within the same turn when the dirty state changed after the first nag", () => {
    const workspace = makeWorkspace(root, { repo: "pushed", dirty: true });

    stop(workspace, { executionNum: 0 });
    git(workspace, "commit", "-am", "now committed but unpushed");
    const second = stop(workspace, { executionNum: 1 });

    assert.equal(second.decision.decision, "continue");
    assert.match(second.decision.reason, /unpushed local commits/);
  });

  test("nags again about the same dirty worktree at the end of a later turn", () => {
    const workspace = makeWorkspace(root, { repo: "pushed", dirty: true });

    stop(workspace, { executionNum: 0 });
    stop(workspace, { executionNum: 1 });
    const nextTurn = stop(workspace, { executionNum: 0, lastUserInput: "anything else?" });

    assert.equal(nextTurn.decision.decision, "continue");
  });

  test("keeps the nag fingerprint per conversation", () => {
    const workspace = makeWorkspace(root, { repo: "pushed", dirty: true });

    stop(workspace, { executionNum: 0 });
    const otherConversation = stop(workspace, { executionNum: 1, conversationId: "another-conversation" });

    assert.equal(otherConversation.decision.decision, "continue");
    assert.ok(existsSync(path.join(root, `crc-git-hygiene-${CONVERSATION_ID}.json`)));
    assert.ok(existsSync(path.join(root, "crc-git-hygiene-another-conversation.json")));
  });

  test("reports awaiting-background without a task list while Antigravity says it is not fully idle", () => {
    const result = stop(makeWorkspace(root, { repo: "pushed" }), { fullyIdle: false });

    assert.equal(result.stdout, "{}");
    assert.equal(result.instanceStatus.state, "awaiting-background");
    assert.deepEqual(result.instanceStatus.pendingTasks, []);
  });

  test("reports a dirty worktree while background work is running, then waits on the background work", () => {
    const workspace = makeWorkspace(root, { repo: "pushed", dirty: true });

    const first = stop(workspace, { fullyIdle: false, executionNum: 0 });
    const second = stop(workspace, { fullyIdle: false, executionNum: 1 });

    assert.equal(first.decision.decision, "continue");
    assert.match(first.decision.reason, /background tasks that are still running/);
    assert.equal(second.stdout, "{}");
    assert.equal(second.instanceStatus.state, "awaiting-background");
  });

  test("does not look for Claude Code background tasks in the transcript it is handed", () => {
    const workspace = makeWorkspace(root, { repo: "pushed" });
    const transcriptPath = writeTranscript(root, [claudeBackgroundAgentLaunch("agent-a1b")]);

    const asClaude = runHook({ root, bin, workspace, payload: { session_id: "s1", transcript_path: transcriptPath } });
    const asAntigravity = stop(workspace, { transcriptPath });

    assert.equal(asClaude.instanceStatus.state, "awaiting-background");
    assert.equal(asAntigravity.instanceStatus.state, "finished");
  });

  test("hands control back to the user without nagging when they cancelled the turn", () => {
    const result = stop(makeWorkspace(root, { repo: "pushed", dirty: true }), { terminationReason: "USER_CANCELED" });

    assert.equal(result.stdout, "{}");
    assert.equal(result.instanceStatus.state, "waiting");
  });

  test("still nags about a dirty worktree when the turn ended on a model error", () => {
    const result = stop(makeWorkspace(root, { repo: "pushed", dirty: true }), {
      terminationReason: "ERROR",
      error: "generating and executing: Error 400",
    });

    assert.equal(result.decision.decision, "continue");
  });

  test("continues the turn with the failure when the PR checks fail", () => {
    const workspace = makeWorkspace(root, { repo: "pushed" });
    writeStub(
      bin,
      "gh",
      `#!/bin/bash
if [ "$1 $2" = "pr view" ]; then echo '{"number":7,"url":"https://github.com/example/repo/pull/7","title":"Fix","state":"OPEN"}'; exit 0; fi
if [ "$1 $2" = "pr checks" ]; then echo '[{"bucket":"fail","name":"test","state":"FAILURE","link":""}]'; exit 0; fi
exit 0
`,
    );

    const first = stop(workspace);
    const second = stop(workspace, { executionNum: 1 });

    assert.equal(first.decision.decision, "continue");
    assert.match(first.decision.reason, /PR checks finished with failures for https:\/\/github.com\/example\/repo\/pull\/7/);
    assert.equal(first.instanceStatus.state, "working");
    assert.equal(second.stdout, "{}");
    assert.equal(second.instanceStatus.state, "finished");
  });

  test("reports finished outside a git worktree", () => {
    const result = stop(makeWorkspace(root, { repo: "none" }));

    assert.equal(result.stdout, "{}");
    assert.equal(result.instanceStatus.state, "finished");
  });

  test("a Claude Code stop is still blocked, not continued, and allowed silently", () => {
    const dirty = runHook({ root, bin, workspace: makeWorkspace(root, { repo: "pushed", dirty: true }), payload: { session_id: "s1" } });

    assert.equal(dirty.decision.decision, "block");

    const second = makeRoot();
    try {
      const clean = runHook({ ...second, workspace: makeWorkspace(second.root, { repo: "pushed" }), payload: { session_id: "s1" } });
      assert.equal(clean.stdout, "");
    } finally {
      rmSync(second.root, { recursive: true, force: true });
    }
  });

  test("fails loudly when started for an unknown harness", () => {
    const result = spawnSync("node", [path.join(HOOKS_DIR, "git-hygiene.js"), "--harness", "codex"], { input: "{}", encoding: "utf-8" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--harness expects one of claude, antigravity, got 'codex'/);
  });
});

describe("instance-status and task-description hooks under Antigravity", () => {
  let runDir;

  beforeEach(() => {
    runDir = mkdtempSync(path.join(os.tmpdir(), "crc-antigravity-hooks-"));
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  function run(script, args, payload, env = {}) {
    return execFileSync("node", [path.join(HOOKS_DIR, script), ...args], {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        PATH: process.env.PATH,
        CRC_RUN_DIR: runDir,
        CRC_INSTANCE_STATUS_PATH: path.join(runDir, "crc-instance-status.json"),
        ...env,
      },
    });
  }

  function status() {
    return JSON.parse(readFileSync(path.join(runDir, "crc-instance-status.json"), "utf-8"));
  }

  function description() {
    const file = path.join(runDir, "crc-current-task-description");
    return existsSync(file) ? readFileSync(file, "utf-8") : null;
  }

  test("a question tool is allowed to run and marks the agent as waiting", () => {
    const stdout = run("instance-status.js", ["waiting", ...ANTIGRAVITY, "--event", "PreToolUse"], {
      hookEventName: "PreToolUse",
      toolCall: { name: "ask_question", args: {} },
    });

    assert.deepEqual(JSON.parse(stdout), { decision: "allow" });
    assert.equal(status().state, "waiting");
  });

  test("a finished tool call answers with an empty object and marks the agent as working", () => {
    const stdout = run("instance-status.js", ["working", ...ANTIGRAVITY, "--event", "PostToolUse"], { hookEventName: "PostToolUse" });

    assert.deepEqual(JSON.parse(stdout), {});
    assert.equal(status().state, "working");
  });

  test("the Claude Code form of the status hook still prints nothing", () => {
    assert.equal(run("instance-status.js", ["working"], {}), "");
    assert.equal(status().state, "working");
  });

  test("an invalid state still fails loudly under Antigravity", () => {
    const result = spawnSync("node", [path.join(HOOKS_DIR, "instance-status.js"), "idle", ...ANTIGRAVITY], { encoding: "utf-8" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expects one of working, waiting, awaiting-background, finished, got 'idle'/);
  });

  test("records the task description from the last user input before a model invocation", () => {
    const stdout = run("task-description.js", [...ANTIGRAVITY, "--event", "PreInvocation"], {
      conversationId: CONVERSATION_ID,
      hookEventName: "PreInvocation",
      invocationNum: 0,
      lastUserInput: "say hello\non two lines",
    });

    assert.deepEqual(JSON.parse(stdout), {});
    assert.equal(description(), "say hello on two lines\n");
  });

  test("rewrites the same description on every invocation of a turn", () => {
    for (const invocationNum of [0, 1, 2]) {
      run("task-description.js", [...ANTIGRAVITY, "--event", "PreInvocation"], { invocationNum, lastUserInput: "the task" });
    }

    assert.equal(description(), "the task\n");
  });

  test("does not record the resume prompt as the task description", () => {
    const resumePrompt = "The container running this session was restarted";
    const stdout = run(
      "task-description.js",
      [...ANTIGRAVITY, "--event", "PreInvocation"],
      { lastUserInput: resumePrompt },
      { CRC_RESUME_PROMPT: resumePrompt },
    );

    assert.deepEqual(JSON.parse(stdout), {});
    assert.equal(description(), null);
  });

  test("ignores the Claude Code prompt field under Antigravity and the Antigravity field under Claude Code", () => {
    run("task-description.js", [...ANTIGRAVITY], { prompt: "claude shaped" });
    assert.equal(description(), null);

    assert.equal(run("task-description.js", [], { lastUserInput: "antigravity shaped" }), "");
    assert.equal(description(), null);

    assert.equal(run("task-description.js", [], { prompt: "claude shaped" }), "");
    assert.equal(description(), "claude shaped\n");
  });
});
