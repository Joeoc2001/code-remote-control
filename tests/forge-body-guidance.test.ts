import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isMissingBody, isPlaceholderBody, PLACEHOLDER_BODY_MARKERS } from "@crc/shared/bodies";
import {
  FORGE_BODY_PROMPT_SUFFIX,
  buildFixCiPrompt,
  buildIssuePrompt,
  buildRebasePrompt,
  buildReviewCommentsPrompt,
  buildReviewRequestPrompt,
  buildTaskImplementPrompt,
} from "@crc/shared/prompts";
import type { RepoReviewRequest, RepoWorkItem } from "@crc/shared";
import harness from "./helpers/session-harness.js";

const repoRoot = path.join(import.meta.dirname, "..");

const workItem: RepoWorkItem = {
  id: "7",
  reference: "#7",
  title: "Add widgets",
  url: "https://github.com/acme/widgets/issues/7",
  body: null,
  kind: "issue",
};

const mergeRequest: Pick<RepoReviewRequest, "kind" | "reference" | "url"> = {
  kind: "merge_request",
  reference: "!34",
  url: "https://gitlab.com/acme/widgets/-/merge_requests/34",
};

describe("forge body guidance in the agent prompts", () => {
  test("every prompt that can reach a forge carries the guidance", () => {
    const prompts = {
      issue: buildIssuePrompt(workItem),
      implement: buildTaskImplementPrompt(workItem),
      review: buildReviewRequestPrompt(mergeRequest),
      address_comments: buildReviewCommentsPrompt(mergeRequest),
      rebase: buildRebasePrompt(mergeRequest),
      fix_ci: buildFixCiPrompt(mergeRequest),
    };

    for (const [name, prompt] of Object.entries(prompts)) {
      assert.ok(prompt.includes(FORGE_BODY_PROMPT_SUFFIX), `${name} prompt lacks the body guidance`);
    }
  });

  test("the guidance forbids the stdin markers and names a working alternative per CLI", () => {
    assert.match(FORGE_BODY_PROMPT_SUFFIX, /never pass `@-` or `-`/);
    assert.match(FORGE_BODY_PROMPT_SUFFIX, /--body-file body\.md/);
    assert.match(FORGE_BODY_PROMPT_SUFFIX, /--description "\$\(cat body\.md\)"/);
    assert.match(FORGE_BODY_PROMPT_SUFFIX, /-F 'description=@body\.md'/);
  });

  test("prompts keep their own instruction ahead of the guidance", () => {
    assert.match(buildReviewRequestPrompt(mergeRequest), /^Review merge request !34 /);
    assert.match(buildFixCiPrompt(mergeRequest), /^Investigate the failing CI /);
  });
});

describe("the env image installs the guidance as agent memory", () => {
  const dockerfile = readFileSync(path.join(repoRoot, "docker", "Dockerfile.env"), "utf-8");
  const memory = readFileSync(path.join(repoRoot, "claude", "agent-memory.md"), "utf-8");

  test("the memory file is copied to the path Claude Code reads as user memory", () => {
    assert.match(dockerfile, /^COPY claude\/agent-memory\.md \/root\/\.claude\/CLAUDE\.md$/m);
  });

  test("the memory tells interactive agents the same thing the prompts do", () => {
    assert.match(memory, /Never pass `@-` or `-` as a PR\/MR description or comment body/);
    assert.match(memory, /--body-file body\.md/);
    assert.match(memory, /--description "\$\(cat body\.md\)"/);
  });
});

describe("placeholder body detection", () => {
  test("recognises the stdin markers, with or without surrounding whitespace", () => {
    for (const marker of PLACEHOLDER_BODY_MARKERS) {
      assert.equal(isPlaceholderBody(marker), true, marker);
      assert.equal(isPlaceholderBody(` ${marker}\n`), true, marker);
    }
  });

  test("leaves real bodies alone", () => {
    assert.equal(isPlaceholderBody("Fixes #7"), false);
    assert.equal(isPlaceholderBody("- one\n- two"), false);
    assert.equal(isPlaceholderBody("@-@"), false);
    assert.equal(isPlaceholderBody("pass `@-` only to `gh api -F body=@-`"), false);
    assert.equal(isPlaceholderBody(null), false);
  });

  test("an absent or blank body counts as missing, a real one does not", () => {
    assert.equal(isMissingBody(null), true);
    assert.equal(isMissingBody(""), true);
    assert.equal(isMissingBody(" \n\t"), true);
    assert.equal(isMissingBody("Fixes #7"), false);
  });
});

describe("the guidance survives the trip into a container session", () => {
  test("tmux hands the implement prompt to claude verbatim, shell metacharacters and all", async () => {
    const prompt = buildTaskImplementPrompt(workItem);
    assert.match(prompt, /\$\(cat body\.md\)/);

    const result = await harness.startSessionWithRealTmux({
      transcriptFiles: [],
      initialPrompt: prompt,
    });

    assert.deepEqual(result.claudeArgv, [prompt]);
  });
});
