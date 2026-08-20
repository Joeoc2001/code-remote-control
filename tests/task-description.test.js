const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { taskDescriptionFor } = require("../claude/hooks/task-description.js");
const { resumePromptFromScript } = require("./helpers/session-harness.js");

const RESUME_PROMPT = resumePromptFromScript();

describe("task-description hook", () => {
  let originalResumePrompt;

  beforeEach(() => {
    originalResumePrompt = process.env.CRC_RESUME_PROMPT;
    delete process.env.CRC_RESUME_PROMPT;
  });

  afterEach(() => {
    if (originalResumePrompt === undefined) delete process.env.CRC_RESUME_PROMPT;
    else process.env.CRC_RESUME_PROMPT = originalResumePrompt;
  });

  test("normalises whitespace", () => {
    assert.equal(taskDescriptionFor("  Fix   the\n\tbug  "), "Fix the bug");
  });

  test("truncates to 500 characters", () => {
    assert.equal(taskDescriptionFor("a".repeat(600)).length, 500);
  });

  test("ignores empty and non-string prompts", () => {
    assert.equal(taskDescriptionFor(""), null);
    assert.equal(taskDescriptionFor("   \n "), null);
    assert.equal(taskDescriptionFor(undefined), null);
    assert.equal(taskDescriptionFor(42), null);
  });

  test("ignores the resume prompt the entrypoint sends after a restart", () => {
    process.env.CRC_RESUME_PROMPT = RESUME_PROMPT;

    assert.equal(taskDescriptionFor(RESUME_PROMPT), null);
  });

  test("still records real prompts while a resume prompt is configured", () => {
    process.env.CRC_RESUME_PROMPT = RESUME_PROMPT;

    assert.equal(taskDescriptionFor("Address issue #84"), "Address issue #84");
  });

  test("records the resume prompt text when it is not the configured resume prompt", () => {
    process.env.CRC_RESUME_PROMPT = "something else";

    assert.equal(taskDescriptionFor(RESUME_PROMPT), RESUME_PROMPT);
  });
});
