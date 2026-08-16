const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { startSessionWithRealTmux, resumePromptFromScript } = require("./helpers/session-harness.js");

const RESUME_PROMPT = resumePromptFromScript();
const AWKWARD_PROMPT = 'Fix the "quoting" bug in $HOME; `echo hi` && rm -rf / -- now';

describe("start-claude-session.sh under real tmux", () => {
  test("hands the initial prompt to claude as a single unmangled argument", async () => {
    const result = await startSessionWithRealTmux({
      transcriptFiles: [],
      initialPrompt: AWKWARD_PROMPT,
    });

    assert.deepEqual(result.claudeArgv, [AWKWARD_PROMPT]);
  });

  test("hands the resume prompt to claude as a single unmangled argument", async () => {
    const result = await startSessionWithRealTmux({ transcriptFiles: ["session.jsonl"] });

    assert.deepEqual(result.claudeArgv, ["--continue", RESUME_PROMPT]);
  });

  test("makes the resume prompt visible to hooks running inside the session", async () => {
    const result = await startSessionWithRealTmux({ transcriptFiles: ["session.jsonl"] });

    assert.equal(result.claudeResumePromptEnv, RESUME_PROMPT);
  });

  test("starts claude with no arguments when there is nothing to resume or replay", async () => {
    const result = await startSessionWithRealTmux({ transcriptFiles: [] });

    assert.deepEqual(result.claudeArgv, []);
  });
});
