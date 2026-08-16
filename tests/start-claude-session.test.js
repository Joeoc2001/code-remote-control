const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { START_SESSION_SCRIPT, startSession } = require("./helpers/session-harness.js");

const AWKWARD_PROMPT = 'Fix the "quoting" bug in $HOME; `echo hi` && rm -rf / -- now';

describe("start-claude-session.sh", () => {
  test("is valid bash", () => {
    execFileSync("bash", ["-n", START_SESSION_SCRIPT]);
  });

  test("starts a bare interactive session when there is no transcript and no initial prompt", () => {
    const result = startSession({ transcriptFiles: [] });

    assert.equal(result.error, null);
    assert.deepEqual(result.tmuxArgv, ["new-session", "-d", "-s", "crc", "claude"]);
    assert.deepEqual(result.claudeArgv, []);
  });

  test("replays the initial prompt when there is no transcript", () => {
    const result = startSession({ transcriptFiles: [], initialPrompt: AWKWARD_PROMPT });

    assert.equal(result.error, null);
    assert.deepEqual(result.claudeArgv, [AWKWARD_PROMPT]);
  });

  test("resumes instead of replaying the initial prompt when a transcript exists", () => {
    const result = startSession({
      transcriptFiles: ["9f1c0f1e-0000-4000-8000-000000000000.jsonl"],
      initialPrompt: AWKWARD_PROMPT,
    });

    assert.equal(result.error, null);
    assert.equal(result.claudeArgv[0], "--continue");
    assert.equal(result.claudeArgv.length, 2);
    assert.ok(!result.claudeArgv.includes(AWKWARD_PROMPT));
  });

  test("resumes when a transcript exists and no initial prompt was ever set", () => {
    const result = startSession({ transcriptFiles: ["session.jsonl"] });

    assert.equal(result.error, null);
    assert.equal(result.claudeArgv[0], "--continue");
  });

  test("passes a non-empty resume prompt that tells the agent to continue the task", () => {
    const result = startSession({ transcriptFiles: ["session.jsonl"] });
    const resumePrompt = result.claudeArgv[1];

    assert.ok(resumePrompt.length > 0);
    assert.match(resumePrompt, /restart/i);
    assert.match(resumePrompt, /continue/i);
  });

  test("exports the resume prompt into the claude process so hooks can recognise it", () => {
    const result = startSession({ transcriptFiles: ["session.jsonl"] });

    assert.equal(result.claudeResumePromptEnv, result.claudeArgv[1]);
  });

  test("resumes when any of several transcripts exist", () => {
    const result = startSession({ transcriptFiles: ["a.jsonl", "b.jsonl", "c.jsonl"] });

    assert.equal(result.claudeArgv[0], "--continue");
  });

  test("does not treat the memory subdirectory or non-transcript files as a previous session", () => {
    const result = startSession({
      transcriptFiles: ["notes.md", "jsonl", ".jsonl.bak"],
      transcriptSubdirs: ["memory"],
      initialPrompt: "original task",
    });

    assert.equal(result.error, null);
    assert.deepEqual(result.claudeArgv, ["original task"]);
  });

  test("does not resume when the transcript directory is empty", () => {
    const result = startSession({ transcriptFiles: [], initialPrompt: "original task" });

    assert.deepEqual(result.claudeArgv, ["original task"]);
  });

  test("does not resume when the transcript directory does not exist", () => {
    const result = startSession({ createTranscriptDir: false, initialPrompt: "original task" });

    assert.equal(result.error, null);
    assert.deepEqual(result.claudeArgv, ["original task"]);
  });

  test("treats an empty initial prompt as no initial prompt", () => {
    const result = startSession({ transcriptFiles: [], initialPrompt: "" });

    assert.deepEqual(result.tmuxArgv, ["new-session", "-d", "-s", "crc", "claude"]);
    assert.deepEqual(result.claudeArgv, []);
  });

  test("creates the tmux session under the requested name", () => {
    const resumed = startSession({ transcriptFiles: ["session.jsonl"], sessionName: "custom" });
    const fresh = startSession({ transcriptFiles: [], sessionName: "custom" });

    assert.deepEqual(resumed.tmuxArgv.slice(0, 4), ["new-session", "-d", "-s", "custom"]);
    assert.deepEqual(fresh.tmuxArgv.slice(0, 4), ["new-session", "-d", "-s", "custom"]);
  });

  test("fails loudly when no session name is given", () => {
    const result = startSession({ args: [] });

    assert.notEqual(result.error, null);
    assert.notEqual(result.error.status, 0);
    assert.match(String(result.error.stderr), /usage: start-claude-session\.sh/);
  });

  test("reports which branch it took", () => {
    assert.match(startSession({ transcriptFiles: ["session.jsonl"] }).stdout, /resuming/i);
    assert.match(startSession({ initialPrompt: "task" }).stdout, /initial prompt/i);
    assert.match(startSession({}).stdout, /interactive/i);
  });
});
