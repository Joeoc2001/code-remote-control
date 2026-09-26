import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildRebasePrompt } from "@crc/shared/prompts";

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

describe("buildRebasePrompt", () => {
  test("names the pull request and its url", () => {
    const prompt = buildRebasePrompt(pullRequest);
    assert.match(prompt, /^Rebase pull request #12 at https:\/\/github\.com\/acme\/widgets\/pull\/12 onto the main branch/);
  });

  test("names the merge request and its url", () => {
    const prompt = buildRebasePrompt(mergeRequest);
    assert.match(
      prompt,
      /^Rebase merge request !34 at https:\/\/gitlab\.com\/acme\/widgets\/-\/merge_requests\/34 onto the main branch/,
    );
  });

  test("still asks to resolve conflicts and force-push the rebased branch", () => {
    const prompt = buildRebasePrompt(pullRequest);
    assert.match(prompt, /resolving any merge conflicts/);
    assert.match(prompt, /force-push the rebased branch/);
  });

  test("asks to address nits and minor non-blocking suggestions from previous review", () => {
    const prompt = buildRebasePrompt(pullRequest);
    assert.match(prompt, /if previous review left any nits or minor non-blocking suggestions on the pull request, address them too/);
  });

  test("keeps the nit fixes in separate commits on top of the rebase", () => {
    const prompt = buildRebasePrompt(pullRequest);
    assert.match(prompt, /in separate commits on top of the rebase and push those as well/);
  });

  test("makes the nit work conditional on suggestions having been given", () => {
    const prompt = buildRebasePrompt(pullRequest);
    assert.match(prompt, /if no such suggestions were given/);
    assert.match(prompt, /leave it alone rather than guessing/);
  });

  test("tells the agent to skip contentious or scope-expanding suggestions", () => {
    const prompt = buildRebasePrompt(mergeRequest);
    assert.match(prompt, /a suggestion is contentious or would expand the scope of the change/);
  });

  test("does not ask the rebase agent to resolve threads", () => {
    const prompt = buildRebasePrompt(pullRequest);
    assert.doesNotMatch(prompt, /thread/);
    assert.doesNotMatch(prompt, /resolv(e|ing) (the |all |open )?comments/);
  });

  test("uses the review request's own noun throughout", () => {
    assert.doesNotMatch(buildRebasePrompt(mergeRequest), /pull request/);
    assert.doesNotMatch(buildRebasePrompt(pullRequest), /merge request/);
  });
});
