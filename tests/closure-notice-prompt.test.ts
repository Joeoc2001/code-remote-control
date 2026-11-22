import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildClosureNoticePrompt, buildTaskImplementPrompt, forgeBodyGuidance } from "@crc/shared/prompts";

const workItem = {
  id: "123",
  reference: "#123",
  title: "Add widgets",
  url: "https://gitlab.com/acme/widgets/-/issues/123",
  body: null,
  kind: "issue",
} as const;

const mergeRequest = { id: "45", url: "https://gitlab.com/acme/widgets/-/merge_requests/45" };
const pullRequest = { id: "45", url: "https://github.com/acme/widgets/pull/45" };

const variants = [
  { source: "gitlab", reviewRequest: mergeRequest, named: "merge request !45", forge: "GitLab" },
  { source: "github", reviewRequest: pullRequest, named: "pull request #45", forge: "GitHub" },
] as const;

describe("buildClosureNoticePrompt", () => {
  for (const { source, reviewRequest, named, forge } of variants) {
    for (const closes of [true, false]) {
      test(`${source}, closes=${closes}: is a single line naming the PR/MR, the work item and the forge`, () => {
        const prompt = buildClosureNoticePrompt(source, reviewRequest, workItem, closes);
        assert.doesNotMatch(prompt, /[\r\n]/);
        assert.equal(prompt, prompt.trim());
        assert.ok(prompt.includes(named), prompt);
        assert.ok(prompt.includes(reviewRequest.url), prompt);
        assert.ok(prompt.includes("#123"), prompt);
        assert.ok(prompt.startsWith(`According to ${forge}, `), prompt);
      });

      test(`${source}, closes=${closes}: ends with the forge body guidance so a redraft cannot post a placeholder`, () => {
        const prompt = buildClosureNoticePrompt(source, reviewRequest, workItem, closes);
        assert.ok(prompt.endsWith(forgeBodyGuidance(source)), prompt);
      });
    }

    test(`${source}: the closing variant says the issue will close and how to keep it open`, () => {
      const prompt = buildClosureNoticePrompt(source, reviewRequest, workItem, true);
      assert.match(prompt, /is currently set to close #123 when merged/);
      assert.match(prompt, /closing keywords match even when negated, so "does not close #123" still closes it/);
      assert.match(prompt, /"Part of #123"/);
      assert.match(prompt, /Re-read the description after editing/);
      assert.doesNotMatch(prompt, /will not close/);
    });

    test(`${source}: the non-closing variant says the issue stays open and how to close it`, () => {
      const prompt = buildClosureNoticePrompt(source, reviewRequest, workItem, false);
      assert.match(prompt, /will not close #123 when merged/);
      assert.match(prompt, /add `Closes #123` on its own line in the description/);
      assert.doesNotMatch(prompt, /is currently set to close/);
    });
  }
});

describe("buildTaskImplementPrompt", () => {
  for (const source of ["github", "gitlab"] as const) {
    test(`${source}: warns that a negated closing phrase still closes the issue`, () => {
      const prompt = buildTaskImplementPrompt(workItem, source);
      assert.match(prompt, /they match even when negated, so "does not close #123" still closes the issue/);
      assert.match(prompt, /"Part of #123"/);
    });
  }
});
