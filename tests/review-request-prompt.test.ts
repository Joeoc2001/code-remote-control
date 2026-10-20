import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewRequestPrompt, type ReviewNitMode } from "@crc/shared/prompts";

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

const NIT_MODES: readonly ReviewNitMode[] = ["threads", "comment"];

for (const nits of NIT_MODES) {
  describe(`buildReviewRequestPrompt (${nits})`, () => {
    test("names the pull request and its url", () => {
      const prompt = buildReviewRequestPrompt(pullRequest, nits);
      assert.match(prompt, /^Review pull request #12 at https:\/\/github\.com\/acme\/widgets\/pull\/12\./);
    });

    test("names the merge request and its url", () => {
      const prompt = buildReviewRequestPrompt(mergeRequest, nits);
      assert.match(
        prompt,
        /^Review merge request !34 at https:\/\/gitlab\.com\/acme\/widgets\/-\/merge_requests\/34\./,
      );
    });

    test("explains that an unresolved thread blocks the merge automation", () => {
      const prompt = buildReviewRequestPrompt(pullRequest, nits);
      assert.match(prompt, /unresolved thread blocks the merge automation and spawns a follow-up agent/);
    });

    test("posts a merge-ready verdict as a single plain comment that needs no resolution", () => {
      const prompt = buildReviewRequestPrompt(mergeRequest, nits);
      assert.match(prompt, /acceptable to merge as-is/);
      assert.match(prompt, /single plain comment: not a resolvable thread, and not a review that requires resolution/);
    });

    test("no longer asks unconditionally for comments", () => {
      const prompt = buildReviewRequestPrompt(pullRequest, nits);
      assert.doesNotMatch(prompt, /leaving comments with suggestions and recommendations/);
    });

    test("uses the review request's own noun throughout", () => {
      assert.doesNotMatch(buildReviewRequestPrompt(mergeRequest, nits), /pull request/);
      assert.doesNotMatch(buildReviewRequestPrompt(pullRequest, nits), /merge request/);
    });

    test("keeps the forge body guidance", () => {
      assert.match(buildReviewRequestPrompt(pullRequest, nits), /gh pr comment --body-file body\.md/);
      assert.match(buildReviewRequestPrompt(mergeRequest, nits), /glab mr note -m "\$\(cat body\.md\)"/);
    });
  });
}

describe("buildReviewRequestPrompt (comment)", () => {
  test("restricts resolvable threads to changes that must happen before merge", () => {
    const prompt = buildReviewRequestPrompt(pullRequest, "comment");
    assert.match(prompt, /Only open resolvable discussion threads/);
    assert.match(prompt, /genuinely must be made before merge/);
  });

  test("keeps nits out of threads even when changes are required", () => {
    const prompt = buildReviewRequestPrompt(pullRequest, "comment");
    assert.match(prompt, /If changes are required, open threads for the must-fix items only/);
    assert.match(prompt, /minor non-blocking suggestions in a plain comment alongside them/);
  });

  test("routes a merge-ready verdict and its nits into a single plain comment", () => {
    const prompt = buildReviewRequestPrompt(mergeRequest, "comment");
    assert.match(prompt, /verdict together with any minor non-blocking suggestions as a single plain comment/);
  });

  test("does not ask for nits as threads", () => {
    assert.doesNotMatch(buildReviewRequestPrompt(pullRequest, "comment"), /thread for each .*nit/);
  });
});

describe("buildReviewRequestPrompt (threads)", () => {
  test("opens a resolvable thread for each must-fix item", () => {
    const prompt = buildReviewRequestPrompt(pullRequest, "threads");
    assert.match(prompt, /Open a resolvable discussion thread for each change that must be made before merge/);
  });

  test("opens a resolvable thread for each nit so it is addressed before merge", () => {
    const prompt = buildReviewRequestPrompt(pullRequest, "threads");
    assert.match(prompt, /and also for each nit or minor suggestion, so the follow-up agent addresses them before merge/);
  });

  test("asks only for nits the reviewer actually wants fixed", () => {
    const prompt = buildReviewRequestPrompt(mergeRequest, "threads");
    assert.match(prompt, /only raise nits you actually want fixed and leave out optional "consider maybe" remarks/);
  });

  test("posts the verdict as a plain comment only when there is nothing to raise", () => {
    const prompt = buildReviewRequestPrompt(mergeRequest, "threads");
    assert.match(prompt, /If you have nothing to raise and the merge request is acceptable to merge as-is, post your verdict as a single plain comment/);
  });

  test("does not tell the reviewer to keep nits in a plain comment", () => {
    const prompt = buildReviewRequestPrompt(pullRequest, "threads");
    assert.doesNotMatch(prompt, /must-fix items only/);
    assert.doesNotMatch(prompt, /suggestions in a plain comment/);
    assert.doesNotMatch(prompt, /verdict together with any minor non-blocking suggestions/);
  });
});
