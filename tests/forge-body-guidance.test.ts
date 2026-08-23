import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFixCiPrompt,
  buildIssuePrompt,
  buildRebasePrompt,
  buildReviewCommentsPrompt,
  buildReviewRequestPrompt,
  buildTaskImplementPrompt,
  forgeBodyGuidance,
} from "@crc/shared/prompts";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const containerMemory = readFileSync(path.join(repoRoot, "docker", "claude-memory.md"), "utf-8");

const workItem = {
  id: "7",
  reference: "#7",
  title: "Add widgets",
  url: "https://github.com/acme/widgets/issues/7",
  body: null,
  kind: "issue",
} as const;

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

describe("forgeBodyGuidance", () => {
  test("forbids the stdin placeholders outright on both forges", () => {
    for (const source of ["github", "gitlab"] as const) {
      assert.match(
        forgeBodyGuidance(source),
        /never pass `@-`, `@` or `-` as the body value/,
        `${source} guidance does not forbid the placeholders`,
      );
    }
  });

  test("explains which gh invocations do and do not read the body from stdin", () => {
    const guidance = forgeBodyGuidance("github");
    assert.match(guidance, /stdin only via `--body-file -`/);
    assert.match(guidance, /`--body @-` posts those two characters literally/);
  });

  test("explains that the glab porcelain never reads the body from stdin", () => {
    const guidance = forgeBodyGuidance("gitlab");
    assert.match(guidance, /glab mr create --description/);
    assert.match(guidance, /glab mr note -m/);
    assert.match(guidance, /do not read the body from stdin/);
    assert.match(guidance, /post those characters literally/);
  });

  test("names a working alternative for each CLI", () => {
    assert.match(forgeBodyGuidance("github"), /gh pr create --body-file body\.md/);
    assert.match(forgeBodyGuidance("github"), /gh pr comment --body-file body\.md/);
    assert.match(forgeBodyGuidance("gitlab"), /glab mr create --description "\$\(cat body\.md\)"/);
    assert.match(forgeBodyGuidance("gitlab"), /glab api \.\.\. -F 'description=@body\.md'/);
  });

  test("rules out an empty body too", () => {
    for (const source of ["github", "gitlab"] as const) {
      assert.match(forgeBodyGuidance(source), /Never leave a description or comment body empty/);
    }
  });

  test("keeps each forge's guidance free of the other forge's CLI", () => {
    assert.doesNotMatch(forgeBodyGuidance("github"), /glab/);
    assert.doesNotMatch(forgeBodyGuidance("gitlab"), /\bgh /);
  });
});

describe("task step prompts", () => {
  const githubPrompts = {
    implement: buildTaskImplementPrompt(workItem, "github"),
    review: buildReviewRequestPrompt(pullRequest),
    address_comments: buildReviewCommentsPrompt(pullRequest),
    rebase: buildRebasePrompt(pullRequest),
    fix_ci: buildFixCiPrompt(pullRequest),
  };

  const gitlabPrompts = {
    implement: buildTaskImplementPrompt(workItem, "gitlab"),
    review: buildReviewRequestPrompt(mergeRequest),
    address_comments: buildReviewCommentsPrompt(mergeRequest),
    rebase: buildRebasePrompt(mergeRequest),
    fix_ci: buildFixCiPrompt(mergeRequest),
  };

  for (const [step, prompt] of Object.entries(githubPrompts)) {
    test(`the ${step} prompt carries the gh body-passing guidance on GitHub`, () => {
      assert.ok(
        prompt.endsWith(forgeBodyGuidance("github")),
        `the ${step} prompt does not end with the github guidance`,
      );
    });
  }

  for (const [step, prompt] of Object.entries(gitlabPrompts)) {
    test(`the ${step} prompt carries the glab body-passing guidance on GitLab`, () => {
      assert.ok(
        prompt.endsWith(forgeBodyGuidance("gitlab")),
        `the ${step} prompt does not end with the gitlab guidance`,
      );
    });
  }

  test("the implement prompt keeps its existing instructions alongside the guidance", () => {
    assert.match(githubPrompts.implement, /the task is incomplete without one/);
    assert.match(githubPrompts.implement, /thoroughly tested/);
  });

  test("the review prompt keeps its thread instructions alongside the guidance", () => {
    assert.match(githubPrompts.review, /Only open resolvable discussion threads/);
  });
});

describe("container agent memory", () => {
  test("carries both forges' guidance word for word", () => {
    for (const source of ["github", "gitlab"] as const) {
      assert.ok(
        containerMemory.includes(forgeBodyGuidance(source)),
        `docker/claude-memory.md has drifted from the ${source} guidance`,
      );
    }
  });

  test("covers sessions started without a task prompt, such as a plain issue prompt", () => {
    assert.doesNotMatch(buildIssuePrompt(workItem), /body-file/);
    assert.match(containerMemory, /## Posting descriptions and comments to GitHub/);
    assert.match(containerMemory, /## Posting descriptions and comments to GitLab/);
  });
});
