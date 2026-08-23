import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewRequestPrompt } from "@crc/shared/prompts";

const pullRequest = {
  kind: "pull_request",
  reference: "#12",
  url: "https://github.com/acme/widgets/pull/12",
} as const;

const mergeRequest = {
  kind: "merge_request",
  reference: "!34",
  url: "https://gitlab.com/acme/widgets/-/merge_requests/34",
} as const;

describe("buildReviewRequestPrompt", () => {
  test("names the pull request and its url", () => {
    const prompt = buildReviewRequestPrompt(pullRequest);
    assert.match(prompt, /^Review pull request #12 at https:\/\/github\.com\/acme\/widgets\/pull\/12\./);
  });

  test("names the merge request and its url", () => {
    const prompt = buildReviewRequestPrompt(mergeRequest);
    assert.match(
      prompt,
      /^Review merge request !34 at https:\/\/gitlab\.com\/acme\/widgets\/-\/merge_requests\/34\./,
    );
  });

  test("restricts resolvable threads to changes that must happen before merge", () => {
    const prompt = buildReviewRequestPrompt(pullRequest);
    assert.match(prompt, /Only open resolvable discussion threads/);
    assert.match(prompt, /genuinely must be made before merge/);
  });

  test("explains that an unresolved thread blocks the merge automation", () => {
    const prompt = buildReviewRequestPrompt(pullRequest);
    assert.match(prompt, /unresolved thread blocks the merge automation/);
  });

  test("keeps nits out of threads even when changes are required", () => {
    const prompt = buildReviewRequestPrompt(pullRequest);
    assert.match(prompt, /If changes are required, open threads for the must-fix items only/);
    assert.match(prompt, /minor non-blocking suggestions in a plain comment alongside them/);
  });

  test("routes a merge-ready verdict and its nits into a single plain comment", () => {
    const prompt = buildReviewRequestPrompt(mergeRequest);
    assert.match(prompt, /acceptable to merge as-is/);
    assert.match(prompt, /non-blocking suggestions as a single plain comment/);
    assert.match(prompt, /not a resolvable thread, and not a review that requires resolution/);
  });

  test("no longer asks unconditionally for comments", () => {
    const prompt = buildReviewRequestPrompt(pullRequest);
    assert.doesNotMatch(prompt, /leaving comments with suggestions and recommendations/);
  });

  test("uses the review request's own noun throughout", () => {
    assert.doesNotMatch(buildReviewRequestPrompt(mergeRequest), /pull request/);
    assert.doesNotMatch(buildReviewRequestPrompt(pullRequest), /merge request/);
  });
});
